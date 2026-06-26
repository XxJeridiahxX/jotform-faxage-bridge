"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildConfig } = require("../src/config");
const { createApp } = require("../src/server");
const { createStore } = require("../src/store");

const SECRET = "t".repeat(40);
const BASE_ENV = {
  SHARED_SECRET: SECRET,
  JOTFORM_API_KEY: "k",
  FAX_DEST: "15555550123",
  FAXAGE_USERNAME: "u",
  FAXAGE_COMPANY: "c",
  FAXAGE_PASSWORD: "p",
  RATE_LIMIT_PER_MIN: "100000", // don't throttle the test run
  TRUST_PROXY: "0",
};

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
let counter = 0;

function startApp(overrides = {}) {
  counter += 1;
  const dataDir = path.join(os.tmpdir(), `jf-bridge-test-${process.pid}-${counter}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
  const config = buildConfig({ ...BASE_ENV, DATA_DIR: dataDir, ...(overrides.env || {}) });
  const store = createStore(config.dataDir, noopLogger);
  const calls = { fax: [], fetch: [] };
  const deps = {
    config,
    store,
    fetchSubmissionPdf:
      overrides.fetchSubmissionPdf ||
      (async (args) => {
        calls.fetch.push(args);
        return Buffer.from("%PDF-1.4 stub");
      }),
    assertUnprotectedPdf: overrides.assertUnprotectedPdf || (async () => true),
    sendFax:
      overrides.sendFax ||
      (async ({ faxTo }) => {
        calls.fax.push(faxTo);
        return { ok: true, jobId: "12345" };
      }),
    logger: noopLogger,
  };
  const app = createApp(deps);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, calls, config, store, dataDir, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function withApp(overrides, fn) {
  const ctx = await startApp(overrides);
  try {
    await fn(ctx);
  } finally {
    if (typeof ctx.server.closeAllConnections === "function") ctx.server.closeAllConnections();
    await new Promise((r) => ctx.server.close(r));
    fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  }
}

function post(base, p, { fields = {}, token, tokenIn = "header" } = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  let url = base + p;
  const headers = {};
  if (token && tokenIn === "header") headers["x-webhook-token"] = token;
  if (token && tokenIn === "query") url += `${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  return fetch(url, { method: "POST", body: form, headers });
}

const ids = (submissionID, formID) => ({ submissionID, formID });

test("GET /health returns ok", async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });
});

test("missing token is rejected with 401", async () => {
  await withApp({}, async ({ base, config }) => {
    const res = await post(base, config.webhookPath, { fields: ids("1", "2") });
    assert.equal(res.status, 401);
  });
});

test("wrong token is rejected with 401", async () => {
  await withApp({}, async ({ base, config }) => {
    const res = await post(base, config.webhookPath, { fields: ids("1", "2"), token: "nope" });
    assert.equal(res.status, 401);
  });
});

test("missing submissionID/formID is rejected with 400", async () => {
  await withApp({}, async ({ base, config }) => {
    const res = await post(base, config.webhookPath, { token: SECRET });
    assert.equal(res.status, 400);
  });
});

test("happy path faxes to FAX_DEST, returns JOBID, and records a disclosure", async () => {
  await withApp({}, async ({ base, config, calls, store }) => {
    const res = await post(base, config.webhookPath, { fields: ids("55", "77"), token: SECRET });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).jobId, "12345");
    assert.deepEqual(calls.fax, ["15555550123"]);
    const log = fs.readFileSync(store.paths.disclosureLog, "utf8");
    assert.match(log, /"outcome":"sent"/);
    assert.match(log, /"jobId":"12345"/);
  });
});

test("token also accepted via query string (transition fallback)", async () => {
  await withApp({}, async ({ base, config }) => {
    const res = await post(base, config.webhookPath, { fields: ids("1", "2"), token: SECRET, tokenIn: "query" });
    assert.equal(res.status, 200);
  });
});

test("FORM_FAX_MAP overrides the destination per form", async () => {
  await withApp({ env: { FORM_FAX_MAP: '{"77":"1-918-555-1234"}' } }, async ({ base, config, calls }) => {
    const res = await post(base, config.webhookPath, { fields: ids("55", "77"), token: SECRET });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.fax, ["19185551234"]);
  });
});

test("SB-1: a duplicate submission is suppressed (faxed exactly once)", async () => {
  await withApp({}, async ({ base, config, calls }) => {
    const r1 = await post(base, config.webhookPath, { fields: ids("dup1", "77"), token: SECRET });
    const r2 = await post(base, config.webhookPath, { fields: ids("dup1", "77"), token: SECRET });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).status, "duplicate_ignored");
    assert.deepEqual(calls.fax, ["15555550123"]); // only one fax
  });
});

test("a clear Faxage failure → 502 and the claim is released (retryable)", async () => {
  let n = 0;
  await withApp(
    {
      sendFax: async () => {
        n += 1;
        return { ok: false, ambiguous: false, jobId: null, raw: "ERROR: bad number" };
      },
    },
    async ({ base, config }) => {
      const r1 = await post(base, config.webhookPath, { fields: ids("f1", "77"), token: SECRET });
      assert.equal(r1.status, 502);
      // claim released → a retry re-attempts (sendFax called again)
      const r2 = await post(base, config.webhookPath, { fields: ids("f1", "77"), token: SECRET });
      assert.equal(r2.status, 502);
      assert.equal(n, 2);
    },
  );
});

test("an ambiguous Faxage 200 (no JOBID) → 502 and the claim is RETAINED (no re-fax)", async () => {
  let n = 0;
  await withApp(
    {
      sendFax: async () => {
        n += 1;
        return { ok: false, ambiguous: true, jobId: null, raw: "OK" };
      },
    },
    async ({ base, config }) => {
      const r1 = await post(base, config.webhookPath, { fields: ids("a1", "77"), token: SECRET });
      assert.equal(r1.status, 502);
      assert.equal((await r1.json()).error, "fax_send_ambiguous");
      // claim retained → a retry is suppressed as a duplicate, sendFax NOT called again
      const r2 = await post(base, config.webhookPath, { fields: ids("a1", "77"), token: SECRET });
      assert.equal(r2.status, 200);
      assert.equal((await r2.json()).status, "duplicate_ignored");
      assert.equal(n, 1);
    },
  );
});

test("a protected-PDF guard failure → 500, never faxes, claim released", async () => {
  await withApp(
    {
      assertUnprotectedPdf: async () => {
        throw new Error("PASSWORD_PROTECTED: encrypted");
      },
    },
    async ({ base, config, calls }) => {
      const res = await post(base, config.webhookPath, { fields: ids("1", "2"), token: SECRET });
      assert.equal(res.status, 500);
      assert.deepEqual(calls.fax, []);
      assert.match((await res.json()).error, /bridge_error/);
    },
  );
});
