"use strict";

const { PDFDocument } = require("pdf-lib");

/**
 * Guard against the original failure mode: faxing a password-protected /
 * non-PDF document. This is the safety net that ensures the bridge never
 * silently reproduces the email-to-fax problem it exists to solve.
 */

function isPdfMagic(buf) {
  // A valid PDF begins with "%PDF-" within the first bytes.
  return buf.slice(0, 1024).toString("latin1").includes("%PDF-");
}

function referencesEncryptDict(buf) {
  // Encryption is declared via an /Encrypt entry in the trailer dictionary. Scan the
  // whole buffer (belt-and-suspenders) — a false positive only causes a fail-closed
  // rejection, which is the safe direction for a PHI fax.
  return /\/Encrypt[\s/<\[]/.test(buf.toString("latin1"));
}

/**
 * Throws a descriptive Error if `buf` is not an openable, unencrypted PDF with at
 * least one page. Resolves to true otherwise.
 */
async function assertUnprotectedPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error("EMPTY_RESPONSE: no bytes were returned for the document");
  }
  if (!isPdfMagic(buf)) {
    throw new Error("NOT_A_PDF: response is not a PDF (no %PDF- header)");
  }
  if (referencesEncryptDict(buf)) {
    throw new Error("PASSWORD_PROTECTED: the fetched PDF declares an /Encrypt dictionary");
  }
  let doc;
  try {
    doc = await PDFDocument.load(buf);
  } catch (e) {
    if (/encrypt/i.test(e.message)) {
      throw new Error("PASSWORD_PROTECTED: the fetched PDF is encrypted");
    }
    throw new Error(`INVALID_PDF: ${e.message}`);
  }
  if (typeof doc.isEncrypted === "boolean" && doc.isEncrypted) {
    throw new Error("PASSWORD_PROTECTED: the fetched PDF is encrypted");
  }
  if (doc.getPageCount() < 1) {
    throw new Error("INVALID_PDF: document has no pages");
  }
  return true;
}

module.exports = { assertUnprotectedPdf, isPdfMagic, referencesEncryptDict };
