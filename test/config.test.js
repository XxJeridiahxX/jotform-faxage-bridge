"use strict";

const { test } = require("node:test");
const assert = require("node:assert");

const { buildConfig, destinationFor, parseFormFaxMap } = require("../src/config");

const SECRET = "x".repeat(40); // >= 32 chars, not the change-me default
const baseEnv = {
  SHARED_SECRET: SECRET,
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
  assert.equal(cfg.jotform.pdfMode, "generatePDF"); // new default
  assert.equal(cfg.faxDest, "18775400750"); // digits only
  assert.equal(cfg.tokenHeader, "x-webhook-token");
  assert.equal(cfg.rateLimitPerMin, 60);
});

test("buildConfig throws listing every missing required var", () => {
  assert.throws(() => buildConfig({}), /SHARED_SECRET/);
  assert.throws(() => buildConfig({}), /FAXAGE_PASSWORD/);
});

test("buildConfig rejects an invalid or removed JOTFORM_PDF_MODE", () => {
  assert.throws(() => buildConfig({ ...baseEnv, JOTFORM_PDF_MODE: "bogus" }), /JOTFORM_PDF_MODE/);
  assert.throws(() => buildConfig({ ...baseEnv, JOTFORM_PDF_MODE: "uploadFile" }), /JOTFORM_PDF_MODE/);
});

test("buildConfig rejects a weak or placeholder SHARED_SECRET", () => {
  assert.throws(() => buildConfig({ ...baseEnv, SHARED_SECRET: "short" }), /SHARED_SECRET/);
  assert.throws(() => buildConfig({ ...baseEnv, SHARED_SECRET: "change-me-to-a-long-random-string!!" }), /SHARED_SECRET/);
});

test("buildConfig requires https bases", () => {
  assert.throws(() => buildConfig({ ...baseEnv, JOTFORM_API_BASE: "http://api.jotform.com" }), /JOTFORM_API_BASE/);
  assert.throws(() => buildConfig({ ...baseEnv, FAXAGE_URL: "http://api.faxage.com/x" }), /FAXAGE_URL/);
});

test("buildConfig rejects an invalid FAX_DEST", () => {
  assert.throws(() => buildConfig({ ...baseEnv, FAX_DEST: "12345" }), /FAX_DEST/);
});

test("webhookPath is normalised to start with a slash", () => {
  assert.equal(buildConfig({ ...baseEnv, WEBHOOK_PATH: "hook" }).webhookPath, "/hook");
});

test("trailing slashes are stripped from the API base", () => {
  assert.equal(buildConfig({ ...baseEnv, JOTFORM_API_BASE: "https://api.jotform.com/" }).jotform.apiBase, "https://api.jotform.com");
});

test("parseFormFaxMap parses and normalises destinations", () => {
  assert.deepEqual(parseFormFaxMap('{"251":"1-918-555-1234"}'), { 251: "19185551234" });
});

test("parseFormFaxMap treats empty/blank as no mapping", () => {
  assert.equal(Object.keys(parseFormFaxMap("")).length, 0);
  assert.equal(Object.keys(parseFormFaxMap("{}")).length, 0);
});

test("parseFormFaxMap rejects invalid JSON, non-objects, and bad numbers", () => {
  assert.throws(() => parseFormFaxMap("{nope}"), /valid JSON/);
  assert.throws(() => parseFormFaxMap("[1,2]"), /JSON object/);
  assert.throws(() => parseFormFaxMap('{"251":"nope"}'), /valid 10\/11-digit/);
});

test("parseFormFaxMap rejects reserved keys (prototype pollution guard)", () => {
  assert.throws(() => parseFormFaxMap('{"__proto__":"19185551234"}'), /reserved key/);
});

test("destinationFor returns per-form override else default", () => {
  const cfg = buildConfig({ ...baseEnv, FORM_FAX_MAP: '{"999":"19185551234"}' });
  assert.equal(destinationFor("999", cfg), "19185551234");
  assert.equal(destinationFor("123", cfg), "18775400750");
});
