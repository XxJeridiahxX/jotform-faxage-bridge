"use strict";

/**
 * Phase 0 linchpin probe — run BEFORE go-live.
 *
 * Answers the one question the whole approach depends on:
 *   "Does the Jotform API hand back an UNPROTECTED PDF for this account?"
 *
 * It checks for Encrypted Forms 2.0 (ciphertext) and tries each PDF endpoint,
 * reporting whether the returned bytes are an openable, unencrypted PDF.
 *
 * Usage:
 *   JOTFORM_API_KEY=xxx node scripts/probe.js --form <FORM_ID> --sid <SUBMISSION_ID> \
 *       [--base https://hipaa-api.jotform.com]
 *
 * No infrastructure required. Nothing is written to disk except an optional
 * ./tmp/probe-*.pdf for your own inspection.
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { assertUnprotectedPdf } = require("../src/pdf");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const API_KEY = process.env.JOTFORM_API_KEY || arg("key");
const BASE = (arg("base", process.env.JOTFORM_API_BASE) || "https://hipaa-api.jotform.com").replace(/\/+$/, "");
const FORM_ID = arg("form");
const SID = arg("sid");

if (!API_KEY || !FORM_ID || !SID) {
  console.error("Missing input. Need JOTFORM_API_KEY (env or --key), --form <id>, --sid <id>.");
  process.exit(2);
}

const HTTP = { timeout: 30000, validateStatus: (s) => s >= 200 && s < 600 };

function looksEncryptedJson(obj) {
  // Encrypted Forms 2.0 returns answers as base64 ciphertext blobs instead of plaintext.
  const answers = (obj && obj.content && obj.content.answers) || {};
  const values = Object.values(answers)
    .map((a) => a && a.answer)
    .filter((v) => typeof v === "string");
  if (!values.length) return false;
  // Heuristic: long, padded, base64-only strings with no spaces across the board.
  const b64ish = values.filter((v) => v.length > 40 && /^[A-Za-z0-9+/=]+$/.test(v) && !/\s/.test(v));
  return b64ish.length >= Math.max(1, Math.ceil(values.length / 2));
}

async function savePdf(label, buf) {
  try {
    const dir = path.resolve(__dirname, "..", "tmp");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `probe-${label}.pdf`);
    fs.writeFileSync(file, buf);
    return file;
  } catch {
    return null;
  }
}

async function tryPdf(label, requestFn) {
  process.stdout.write(`\n[${label}] `);
  try {
    const res = await requestFn();
    if (res.status !== 200) {
      console.log(`✗ HTTP ${res.status}`);
      return false;
    }
    const buf = Buffer.from(res.data);
    const file = await savePdf(label, buf);
    await assertUnprotectedPdf(buf);
    console.log(`✓ UNPROTECTED PDF (${buf.length} bytes)${file ? ` → ${file}` : ""}`);
    return true;
  } catch (e) {
    console.log(`✗ ${e.message}`);
    return false;
  }
}

(async () => {
  console.log(`Probing Jotform account via ${BASE}`);
  console.log(`form=${FORM_ID} submission=${SID}`);

  // 1. Encrypted Forms 2.0 detection.
  let encrypted = "unknown";
  try {
    const meta = await axios.get(`${BASE}/submission/${SID}`, {
      ...HTTP,
      params: { apiKey: API_KEY },
      responseType: "json",
    });
    if (meta.status === 200) {
      encrypted = looksEncryptedJson(meta.data) ? "LIKELY ENCRYPTED (ciphertext)" : "plaintext";
      console.log(`\n[submission JSON] HTTP 200 — answers look: ${encrypted}`);
    } else {
      console.log(`\n[submission JSON] ✗ HTTP ${meta.status}`);
    }
  } catch (e) {
    console.log(`\n[submission JSON] ✗ ${e.message}`);
  }

  // 2. PDF endpoints.
  const okSubmissionPdf = await tryPdf("getSubmissionPDF", () =>
    axios.get(`${BASE}/server.php`, {
      ...HTTP,
      params: { action: "getSubmissionPDF", sid: SID, formID: FORM_ID },
      headers: { APIKEY: API_KEY },
      responseType: "arraybuffer",
    }),
  );

  const okGeneratePdf = await tryPdf("generatePDF", () =>
    axios.get(`${BASE}/generatePDF`, {
      ...HTTP,
      params: { formID: FORM_ID, submissionID: SID, download: 1, apiKey: API_KEY },
      responseType: "arraybuffer",
    }),
  );

  // 3. Verdict.
  console.log("\n──────── VERDICT ────────");
  if (String(encrypted).startsWith("LIKELY ENCRYPTED")) {
    console.log("BLOCKED: form appears to use Encrypted Forms 2.0 — no API path yields an unprotected PDF.");
    console.log("Action: disable end-to-end encryption on this form, or choose a different document source.");
    process.exit(1);
  }
  if (okSubmissionPdf || okGeneratePdf) {
    const mode = okSubmissionPdf ? "getSubmissionPDF" : "generatePDF";
    console.log(`PASS: set JOTFORM_PDF_MODE=${mode} and JOTFORM_API_BASE=${BASE}. Safe to proceed.`);
    process.exit(0);
  }
  console.log("FAIL: no endpoint returned an unprotected PDF. Inspect ./tmp output and try uploadFile mode.");
  process.exit(1);
})();
