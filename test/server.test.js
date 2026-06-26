"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { buildConfig } = require("../src/config");
const { createApp } = require("../src/server");

const BASE_ENV = {
  SHARED_SECRET: "s3cr3t",
  JOTFORM_API_KEY: "k",
  FAX_DEST: "18775400750",
  FAXAGE_USERNAME: "u",
  FAXAGE_COMPANY: "c",
  FAXAGE_PASSWORD: "p",
};

function startApp(overrides = {}) {
  const config = buildConfig({ ...BASE_ENV, ...(overrides.env || {}) });
  const calls = { fax: [], fetch: [] };
  const deps = {
    config,
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
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  };
  const app = createApp(deps);
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, calls, config, base: `http://127.0.0.1:${port}` });
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
  }
}

function postForm(url, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return fetch(url, { method: "POST", body: form });
}

test("GET /health returns ok", async () => {
  await withApp({}, async ({ base }) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  });
});

test("missing token is rejected with 401", async () => {
  await withApp({}, async ({ base, config }) => {
    const res = await postForm(`${base}${config.webhookPath}`, { submissionID: "1", formID: "2" });
    assert.equal(res.status, 401);
  });
});

test("wrong token is rejected with 401", async () => {
  await withApp({}, async ({ base, config }) => {
    const res = await postForm(`${base}${config.webhookPath}?token=nope`, { submissionID: "1", formID: "2" });
    assert.equal(res.status, 401);
  });
});

test("missing submissionID/formID is rejected with 400", async () => {
  await withApp({}, async ({ base, config }) => {
    const res = await postForm(`${base}${config.webhookPath}?token=s3cr3t`, {});
    assert.equal(res.status, 400);
  });
});

test("happy path faxes to FAX_DEST and returns the JOBID", async () => {
  await withApp({}, async ({ base, config, calls }) => {
    const res = await postForm(`${base}${config.webhookPath}?token=s3cr3t`, {
      submissionID: "55",
      formID: "77",
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).jobId, "12345");
    assert.deepEqual(calls.fax, ["18775400750"]);
  });
});

test("token may be supplied as a body field", async () => {
  await withApp({}, async ({ base, config }) => {
    const res = await postForm(`${base}${config.webhookPath}`, {
      token: "s3cr3t",
      submissionID: "1",
      formID: "2",
    });
    assert.equal(res.status, 200);
  });
});

test("FORM_FAX_MAP overrides the destination per form", async () => {
  await withApp({ env: { FORM_FAX_MAP: '{"77":"1-918-555-1234"}' } }, async ({ base, config, calls }) => {
    const res = await postForm(`${base}${config.webhookPath}?token=s3cr3t`, {
      submissionID: "55",
      formID: "77",
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls.fax, ["19185551234"]);
  });
});

test("a Faxage failure surfaces as 502", async () => {
  await withApp(
    { sendFax: async () => ({ ok: false, jobId: null, raw: "ERROR: bad number" }) },
    async ({ base, config }) => {
      const res = await postForm(`${base}${config.webhookPath}?token=s3cr3t`, {
        submissionID: "1",
        formID: "2",
      });
      assert.equal(res.status, 502);
    },
  );
});

test("a protected-PDF guard failure surfaces as 500 (never faxes)", async () => {
  await withApp(
    {
      assertUnprotectedPdf: async () => {
        throw new Error("PASSWORD_PROTECTED: encrypted");
      },
    },
    async ({ base, config, calls }) => {
      const res = await postForm(`${base}${config.webhookPath}?token=s3cr3t`, {
        submissionID: "1",
        formID: "2",
      });
      assert.equal(res.status, 500);
      assert.deepEqual(calls.fax, []); // crucially, nothing was faxed
    },
  );
});
