"use strict";

/**
 * Configuration loader. Pure function of an env object (defaults to process.env)
 * so it is trivially testable. Validates required values and fails fast — the
 * service must never boot half-configured when it handles PHI.
 */

const VALID_PDF_MODES = ["getSubmissionPDF", "generatePDF"];
const FAX_RE = /^\d{10,11}$/; // NANP, optional leading country digit
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function parseFormFaxMap(raw) {
  const out = Object.create(null); // null-proto: no prototype-pollution surface
  if (raw === undefined || raw === null || String(raw).trim() === "") return out;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`FORM_FAX_MAP is not valid JSON: ${e.message}`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("FORM_FAX_MAP must be a JSON object of { formId: faxNumber }");
  }
  for (const [formId, fax] of Object.entries(obj)) {
    if (RESERVED_KEYS.has(formId)) throw new Error(`FORM_FAX_MAP has a reserved key: ${formId}`);
    const digits = String(fax).replace(/[^0-9]/g, "");
    if (!FAX_RE.test(digits)) {
      throw new Error(`FORM_FAX_MAP["${formId}"] is not a valid 10/11-digit fax number`);
    }
    out[String(formId)] = digits;
  }
  return out;
}

function normalisePath(p) {
  const path = String(p || "/jotform-fax").trim();
  return path.startsWith("/") ? path : `/${path}`;
}

function parseTrustProxy(raw) {
  if (raw === undefined || raw === "") return 1; // one proxy hop (Caddy) by default
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw; // a subnet/CIDR string
}

function buildConfig(env = process.env) {
  const missing = [];
  const req = (name) => {
    const v = env[name];
    if (v === undefined || String(v).trim() === "") missing.push(name);
    return v;
  };

  const apiBase = (env.JOTFORM_API_BASE || "https://hipaa-api.jotform.com").replace(/\/+$/, "");
  const faxageUrl = env.FAXAGE_URL || "https://api.faxage.com/httpsfax.php";

  const cfg = {
    port: parseInt(env.PORT || "3000", 10),
    publicDomain: env.PUBLIC_DOMAIN || "",
    webhookPath: normalisePath(env.WEBHOOK_PATH),
    sharedSecret: req("SHARED_SECRET"),
    tokenHeader: (env.WEBHOOK_TOKEN_HEADER || "x-webhook-token").toLowerCase(),
    logLevel: env.LOG_LEVEL || "info",
    dataDir: env.DATA_DIR || "./data",
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimitPerMin: parseInt(env.RATE_LIMIT_PER_MIN || "60", 10),
    maxPdfBytes: parseInt(env.MAX_PDF_MB || "30", 10) * 1024 * 1024,
    jotform: {
      apiKey: req("JOTFORM_API_KEY"),
      apiBase,
      pdfMode: env.JOTFORM_PDF_MODE || "generatePDF",
    },
    faxDest: String(req("FAX_DEST") || "").replace(/[^0-9]/g, ""),
    faxage: {
      username: req("FAXAGE_USERNAME"),
      company: req("FAXAGE_COMPANY"),
      password: req("FAXAGE_PASSWORD"),
      callerid: (env.FAXAGE_CALLERID || "").replace(/[^0-9]/g, ""),
      url: faxageUrl,
    },
    formFaxMap: parseFormFaxMap(env.FORM_FAX_MAP),
  };

  // ── validation (fail fast) ──────────────────────────────────────────────────
  if (Number.isNaN(cfg.port)) missing.push("PORT (must be a number)");
  if (missing.length) {
    throw new Error(`Invalid configuration — missing/empty required vars: ${missing.join(", ")}`);
  }
  if (!VALID_PDF_MODES.includes(cfg.jotform.pdfMode)) {
    throw new Error(`JOTFORM_PDF_MODE="${cfg.jotform.pdfMode}" is invalid; must be one of ${VALID_PDF_MODES.join(", ")}`);
  }
  if (cfg.sharedSecret.length < 32 || /^change-me/i.test(cfg.sharedSecret)) {
    throw new Error("SHARED_SECRET must be a high-entropy value of at least 32 characters (e.g. `openssl rand -hex 32`) and not the placeholder default");
  }
  if (!/^https:\/\//i.test(cfg.jotform.apiBase)) throw new Error("JOTFORM_API_BASE must be an https:// URL");
  if (!/^https:\/\//i.test(cfg.faxage.url)) throw new Error("FAXAGE_URL must be an https:// URL");
  if (!FAX_RE.test(cfg.faxDest)) throw new Error("FAX_DEST must be a 10- or 11-digit fax number");

  return cfg;
}

/** Resolve the destination fax for a given formId (per-form override or default). */
function destinationFor(formId, cfg) {
  const map = cfg.formFaxMap || {};
  return Object.prototype.hasOwnProperty.call(map, String(formId)) ? map[String(formId)] : cfg.faxDest;
}

module.exports = { buildConfig, destinationFor, parseFormFaxMap, VALID_PDF_MODES };
