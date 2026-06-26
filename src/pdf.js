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
  // Encryption is declared via an /Encrypt entry in the trailer dictionary,
  // which lives near the end of the file. Scan the tail to avoid matching
  // the literal text inside content streams.
  return /\/Encrypt\b/.test(buf.slice(-4096).toString("latin1"));
}

/**
 * Throws a descriptive Error if `buf` is not an openable, unencrypted PDF.
 * Resolves to true otherwise.
 */
async function assertUnprotectedPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new Error("EMPTY_RESPONSE: no bytes were returned for the document");
  }
  if (!isPdfMagic(buf)) {
    const preview = buf.slice(0, 80).toString("latin1").replace(/\s+/g, " ").trim();
    throw new Error(`NOT_A_PDF: response is not a PDF (starts with: "${preview}")`);
  }
  if (referencesEncryptDict(buf)) {
    throw new Error("PASSWORD_PROTECTED: the fetched PDF declares an /Encrypt dictionary");
  }
  // Authoritative check: pdf-lib throws on encrypted documents unless told to ignore.
  try {
    await PDFDocument.load(buf);
  } catch (e) {
    if (/encrypt/i.test(e.message)) {
      throw new Error("PASSWORD_PROTECTED: the fetched PDF is encrypted");
    }
    throw new Error(`INVALID_PDF: ${e.message}`);
  }
  return true;
}

module.exports = { assertUnprotectedPdf, isPdfMagic, referencesEncryptDict };
