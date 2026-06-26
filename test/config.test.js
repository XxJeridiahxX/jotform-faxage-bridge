"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { buildConfig, destinationFor, parseFormFaxMap } = require("../src/config");

const baseEnv = {
  SHARED_SECRET: "s3cr3t",
  JOTFORM_API_KEY: "key123",
  FAX_DEST: "1-877-540-0750",
  FAXAGE_USERNAME: "user",
  FAXAGE_COMPANY: "70641",
  FAXAGE_PASSWORD: "pass",
};

test("buildConfig succeeds with required vars and applies defaults", () => {
  const cfg = buildConfig(baseEnv);
  assert.equal(cfg.port, 3000);
  assert.equal(cfg.webhookPath, "/jotform-fax");
  assert.equal(cfg.jotform.apiBase, "https://hipaa-api.jotform.com");
  assert.equal(cfg.jotform.pdfMode, "getSubmissionPDF");
  assert.equal(cfg.faxDest, "18775400750"); // digits only
});

test("buildConfig throws listing every missing required var", () => {
  assert.throws(() => buildConfig({}), /SHARED_SECRET/);
  assert.throws(() => buildConfig({}), /FAXAGE_PASSWORD/);
});

test("buildConfig rejects an invalid JOTFORM_PDF_MODE", () => {
  assert.throws(
    () => buildConfig({ ...baseEnv, JOTFORM_PDF_MODE: "bogus" }),
    /JOTFORM_PDF_MODE/,
  );
});

test("webhookPath is normalised to start with a slash", () => {
  const cfg = buildConfig({ ...baseEnv, WEBHOOK_PATH: "hook" });
  assert.equal(cfg.webhookPath, "/hook");
});

test("trailing slashes are stripped from the API base", () => {
  const cfg = buildConfig({ ...baseEnv, JOTFORM_API_BASE: "https://api.jotform.com/" });
  assert.equal(cfg.jotform.apiBase, "https://api.jotform.com");
});

test("parseFormFaxMap parses and normalises destinations", () => {
  const map = parseFormFaxMap('{"251":"1-918-555-1234"}');
  assert.deepEqual(map, { 251: "19185551234" });
});

test("parseFormFaxMap treats empty/blank as no mapping", () => {
  assert.deepEqual(parseFormFaxMap(""), {});
  assert.deepEqual(parseFormFaxMap("{}"), {});
});

test("parseFormFaxMap rejects invalid JSON and non-objects", () => {
  assert.throws(() => parseFormFaxMap("{nope}"), /valid JSON/);
  assert.throws(() => parseFormFaxMap("[1,2]"), /JSON object/);
});

test("destinationFor returns per-form override else default", () => {
  const cfg = buildConfig({ ...baseEnv, FORM_FAX_MAP: '{"999":"19185551234"}' });
  assert.equal(destinationFor("999", cfg), "19185551234");
  assert.equal(destinationFor("123", cfg), "18775400750");
});
