"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { PDFDocument } = require("pdf-lib");

const { assertUnprotectedPdf } = require("../src/pdf");

async function makeValidPdf() {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]).drawText("hello");
  return Buffer.from(await doc.save());
}

test("accepts a valid, unencrypted PDF", async () => {
  const buf = await makeValidPdf();
  assert.equal(await assertUnprotectedPdf(buf), true);
});

test("rejects an empty buffer", async () => {
  await assert.rejects(() => assertUnprotectedPdf(Buffer.alloc(0)), /EMPTY_RESPONSE/);
});

test("rejects a non-PDF (e.g. an HTML login page)", async () => {
  const html = Buffer.from("<html><body>Please log in</body></html>", "utf8");
  await assert.rejects(() => assertUnprotectedPdf(html), /NOT_A_PDF/);
});

test("rejects a PDF that declares an /Encrypt dictionary", async () => {
  const encrypted = Buffer.from(
    "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<</Root 1 0 R/Encrypt 2 0 R>>\n%%EOF\n",
    "latin1",
  );
  await assert.rejects(() => assertUnprotectedPdf(encrypted), /PASSWORD_PROTECTED/);
});
