"use strict";

/**
 * Configuration loader. Pure function of an env object (defaults to process.env)
 * so it is trivially testable. Validates required values and fails fast — the
 * service must never boot half-configured when it handles PHI.
 */

const VALID_PDF_MODES = ["getSubmissionPDF", "generatePDF", "uploadFile"];

function parseFormFaxMap(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return {};
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`FORM_FAX_MAP is not valid JSON: ${e.message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("FORM_FAX_MAP must be a JSON object of { formId: faxNumber }");
  }
  // normalise every destination to a digits-only string
  const out = {};
  for (const [formId, fax] of Object.entries(obj)) {
    out[String(formId)] = String(fax).replace(/[^0-9]/g, "");
  }
  return out;
}

function normalisePath(p) {
  const path = String(p || "/jotform-fax").trim();
  return path.startsWith("/") ? path : `/${path}`;
}

function buildConfig(env = process.env) {
  const missing = [];
  const req = (name) => {
    const v = env[name];
    if (v === undefined || String(v).trim() === "") missing.push(name);
    return v;
  };

  const cfg = {
    port: parseInt(env.PORT || "3000", 10),
    publicDomain: env.PUBLIC_DOMAIN || "",
    webhookPath: normalisePath(env.WEBHOOK_PATH),
    sharedSecret: req("SHARED_SECRET"),
    logLevel: env.LOG_LEVEL || "info",
    jotform: {
      apiKey: req("JOTFORM_API_KEY"),
      apiBase: (env.JOTFORM_API_BASE || "https://hipaa-api.jotform.com").replace(/\/+$/, ""),
      pdfMode: env.JOTFORM_PDF_MODE || "getSubmissionPDF",
    },
    faxDest: String(req("FAX_DEST") || "").replace(/[^0-9]/g, ""),
    faxage: {
      username: req("FAXAGE_USERNAME"),
      company: req("FAXAGE_COMPANY"),
      password: req("FAXAGE_PASSWORD"),
      callerid: (env.FAXAGE_CALLERID || "").replace(/[^0-9]/g, ""),
      url: env.FAXAGE_URL || "https://api.faxage.com/httpsfax.php",
    },
    formFaxMap: parseFormFaxMap(env.FORM_FAX_MAP),
  };

  if (Number.isNaN(cfg.port)) missing.push("PORT (must be a number)");
  if (!VALID_PDF_MODES.includes(cfg.jotform.pdfMode)) {
    throw new Error(
      `JOTFORM_PDF_MODE="${cfg.jotform.pdfMode}" is invalid; must be one of ${VALID_PDF_MODES.join(", ")}`,
    );
  }
  if (missing.length) {
    throw new Error(`Invalid configuration — missing/empty required vars: ${missing.join(", ")}`);
  }
  return cfg;
}

/** Resolve the destination fax for a given formId (per-form override or default). */
function destinationFor(formId, cfg) {
  return (cfg.formFaxMap && cfg.formFaxMap[String(formId)]) || cfg.faxDest;
}

module.exports = { buildConfig, destinationFor, parseFormFaxMap, VALID_PDF_MODES };
