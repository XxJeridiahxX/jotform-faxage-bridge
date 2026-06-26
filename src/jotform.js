"use strict";

const axios = require("axios");

/**
 * Retrieve a submission's document as raw PDF bytes from the Jotform API.
 *
 * Two modes (chosen via JOTFORM_PDF_MODE, decided by the Phase 0 probe):
 *   generatePDF      — renders the submission to PDF (CONFIRMED working on the HIPAA host)
 *   getSubmissionPDF — alternate server.php renderer
 *
 * The key is sent in the APIKEY header (query-param auth is NOT honored on the HIPAA
 * host). All requests cap the response size to avoid memory-exhaustion DoS. Nothing
 * here writes PHI to disk. (The old `uploadFile` mode — which fetched submitter-
 * controlled URLs — was removed as an SSRF / API-key-exfiltration risk.)
 */

function httpOpts(cfg) {
  return {
    timeout: 30000,
    validateStatus: (s) => s >= 200 && s < 600,
    maxContentLength: cfg.maxPdfBytes,
    maxBodyLength: cfg.maxPdfBytes,
  };
}

function bodyText(data) {
  if (Buffer.isBuffer(data)) return data.slice(0, 200).toString("latin1");
  if (typeof data === "string") return data.slice(0, 200);
  try {
    return JSON.stringify(data).slice(0, 200);
  } catch {
    return String(data).slice(0, 200);
  }
}

// CONFIRMED working call (Phase 0): APIKEY header + lowercase formid/submissionid.
async function getViaGeneratePdf({ submissionId, formId }, cfg) {
  const res = await axios.get(`${cfg.jotform.apiBase}/generatePDF`, {
    ...httpOpts(cfg),
    params: { formid: formId, submissionid: submissionId, download: 1 },
    headers: { APIKEY: cfg.jotform.apiKey },
    responseType: "arraybuffer",
  });
  if (res.status !== 200) throw new Error(`JOTFORM_HTTP_${res.status}: ${bodyText(res.data)}`);
  return Buffer.from(res.data);
}

async function getViaSubmissionPdf({ submissionId, formId }, cfg) {
  const res = await axios.get(`${cfg.jotform.apiBase}/server.php`, {
    ...httpOpts(cfg),
    params: { action: "getSubmissionPDF", sid: submissionId, formID: formId },
    headers: { APIKEY: cfg.jotform.apiKey },
    responseType: "arraybuffer",
  });
  if (res.status !== 200) throw new Error(`JOTFORM_HTTP_${res.status}: ${bodyText(res.data)}`);
  return Buffer.from(res.data);
}

async function fetchSubmissionPdf({ submissionId, formId }, cfg) {
  switch (cfg.jotform.pdfMode) {
    case "getSubmissionPDF":
      return getViaSubmissionPdf({ submissionId, formId }, cfg);
    case "generatePDF":
    default:
      return getViaGeneratePdf({ submissionId, formId }, cfg);
  }
}

module.exports = { fetchSubmissionPdf };
