"use strict";

const axios = require("axios");

/**
 * Retrieve a submission's document as raw PDF bytes from the Jotform API.
 *
 * Three modes (chosen via JOTFORM_PDF_MODE, decided by the Phase 0 probe):
 *   getSubmissionPDF — HIPAA host endpoint that renders the submission to PDF
 *   generatePDF      — documented endpoint that renders the submission to PDF
 *   uploadFile       — fetch the first file the submitter uploaded to the form
 *
 * All requests use the API key; nothing here writes PHI to disk.
 */

const HTTP = { timeout: 30000, validateStatus: (s) => s >= 200 && s < 600 };

function bodyText(data) {
  if (Buffer.isBuffer(data)) return data.slice(0, 300).toString("latin1");
  if (typeof data === "string") return data.slice(0, 300);
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return String(data).slice(0, 300);
  }
}

async function getViaSubmissionPdf({ submissionId, formId }, cfg) {
  const res = await axios.get(`${cfg.jotform.apiBase}/server.php`, {
    ...HTTP,
    params: { action: "getSubmissionPDF", sid: submissionId, formID: formId },
    headers: { APIKEY: cfg.jotform.apiKey },
    responseType: "arraybuffer",
  });
  if (res.status !== 200) {
    throw new Error(`JOTFORM_HTTP_${res.status}: ${bodyText(res.data)}`);
  }
  return Buffer.from(res.data);
}

async function getViaGeneratePdf({ submissionId, formId }, cfg) {
  const res = await axios.get(`${cfg.jotform.apiBase}/generatePDF`, {
    ...HTTP,
    params: { formID: formId, submissionID: submissionId, download: 1, apiKey: cfg.jotform.apiKey },
    responseType: "arraybuffer",
  });
  if (res.status !== 200) {
    throw new Error(`JOTFORM_HTTP_${res.status}: ${bodyText(res.data)}`);
  }
  return Buffer.from(res.data);
}

async function getViaUploadedFile({ submissionId }, cfg) {
  const meta = await axios.get(`${cfg.jotform.apiBase}/submission/${submissionId}`, {
    ...HTTP,
    params: { apiKey: cfg.jotform.apiKey },
    responseType: "json",
  });
  if (meta.status !== 200) {
    throw new Error(`JOTFORM_HTTP_${meta.status}: ${bodyText(meta.data)}`);
  }
  const answers = (meta.data && meta.data.content && meta.data.content.answers) || {};
  const urls = [];
  for (const key of Object.keys(answers)) {
    const val = answers[key] && answers[key].answer;
    if (Array.isArray(val)) {
      val.forEach((v) => typeof v === "string" && /^https?:\/\//.test(v) && urls.push(v));
    } else if (typeof val === "string" && /^https?:\/\//.test(val)) {
      urls.push(val);
    }
  }
  const fileUrl = urls.find((u) => /\.pdf(\?|$)/i.test(u)) || urls[0];
  if (!fileUrl) throw new Error("NO_UPLOADED_FILE: submission contained no uploaded file URL");

  const file = await axios.get(fileUrl, {
    ...HTTP,
    headers: { APIKEY: cfg.jotform.apiKey },
    responseType: "arraybuffer",
  });
  if (file.status !== 200) {
    throw new Error(`JOTFORM_FILE_HTTP_${file.status}: ${bodyText(file.data)}`);
  }
  return Buffer.from(file.data);
}

async function fetchSubmissionPdf({ submissionId, formId }, cfg) {
  switch (cfg.jotform.pdfMode) {
    case "generatePDF":
      return getViaGeneratePdf({ submissionId, formId }, cfg);
    case "uploadFile":
      return getViaUploadedFile({ submissionId, formId }, cfg);
    case "getSubmissionPDF":
    default:
      return getViaSubmissionPdf({ submissionId, formId }, cfg);
  }
}

module.exports = { fetchSubmissionPdf };
