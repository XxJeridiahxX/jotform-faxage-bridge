"use strict";

const axios = require("axios");
const FormData = require("form-data");

const MAX_FAX_BYTES = 40 * 1024 * 1024;

/**
 * Send a fax via the Faxage HTTPS API. Ported from the proven MOF backend sender
 * (mof-emr-backend/src/utils/common.js sendFax): multipart POST with operation=sendfax
 * and a base64-encoded PDF in faxfiledata[0]; success is signalled by a "JOBID: <n>"
 * token in the response body.
 *
 * Returns one of:
 *   { ok: true,  jobId, raw }                 — confirmed queued
 *   { ok: false, ambiguous: true,  raw }      — HTTP 200 but no JOBID: may or may not have queued;
 *                                               caller must NOT blindly retry (avoid duplicate PHI fax)
 *   { ok: false, ambiguous: false, raw }      — clear HTTP error: safe to retry
 */
async function sendFax({ faxTo, pdfBase64, fileName, recipName, tagName, tagNumber }, cfg) {
  const form = new FormData();
  form.append("username", cfg.faxage.username);
  form.append("company", cfg.faxage.company);
  form.append("password", cfg.faxage.password);
  if (cfg.faxage.callerid) form.append("callerid", cfg.faxage.callerid);
  form.append("faxno", String(faxTo).replace(/[^0-9]/g, ""));
  form.append("recipname", recipName || "MOF");
  form.append("operation", "sendfax");
  form.append("tagname", tagName || "JotformBridge");
  form.append("tagnumber", tagNumber || "");
  form.append("faxfilenames[0]", fileName || "submission.pdf");
  form.append("faxfiledata[0]", pdfBase64);

  const res = await axios.post(cfg.faxage.url, form, {
    headers: { ...form.getHeaders() },
    timeout: 60000,
    maxBodyLength: MAX_FAX_BYTES,
    maxContentLength: MAX_FAX_BYTES,
    validateStatus: (s) => s >= 200 && s < 600,
  });

  const raw = (typeof res.data === "string" ? res.data : String(res.data)).trim();
  if (res.status !== 200) {
    return { ok: false, ambiguous: false, jobId: null, raw: `HTTP_${res.status}: ${raw.slice(0, 300)}` };
  }
  const match = raw.match(/JOBID:\s*(\d+)/i);
  if (match) return { ok: true, jobId: match[1], raw };
  // HTTP 200 but no JOBID — the job may have been accepted. Treat as ambiguous, not a clean failure.
  return { ok: false, ambiguous: true, jobId: null, raw: raw.slice(0, 300) };
}

module.exports = { sendFax };
