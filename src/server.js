"use strict";

const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");

const { destinationFor } = require("./config");

function truncate(s, n = 300) {
  const str = String(s || "");
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

/**
 * Pull submissionID / formID out of a Jotform webhook body. Jotform posts these
 * as top-level multipart fields; we also fall back to the JSON in rawRequest.
 */
function extractIds(body) {
  let submissionId = body.submissionID || body.submissionId || body.submission_id;
  let formId = body.formID || body.formId || body.form_id;
  if ((!submissionId || !formId) && body.rawRequest) {
    try {
      const raw = JSON.parse(body.rawRequest);
      submissionId = submissionId || raw.submissionID || raw.submission_id;
      formId = formId || raw.formID || raw.formId;
    } catch {
      /* rawRequest not JSON — ignore */
    }
  }
  return { submissionId, formId };
}

/**
 * Build the Express app. All collaborators are injected so the handler can be
 * unit-tested without real network calls or disk state.
 */
function createApp(deps) {
  const { config, fetchSubmissionPdf, assertUnprotectedPdf, sendFax, logger, store } = deps;

  const app = express();
  app.set("trust proxy", config.trustProxy); // real client IP behind Caddy

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.rateLimitPerMin,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Token gate runs BEFORE the body is parsed (no PHI buffered for an unauth request).
  function tokenOk(provided) {
    const a = Buffer.from(String(provided || ""));
    const b = Buffer.from(config.sharedSecret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function requireToken(req, res, next) {
    const provided = req.get(config.tokenHeader) || req.query.token;
    if (!tokenOk(provided)) {
      logger.warn("rejected: missing/invalid token", { ip: req.ip });
      return res.status(401).json({ error: "unauthorized" });
    }
    return next();
  }

  // Parse only text fields; never buffer uploaded files (PHI + DoS surface).
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fieldSize: 1 * 1024 * 1024, fields: 200 },
    fileFilter: (_req, _file, cb) => cb(null, false),
  });

  app.get("/health", (_req, res) =>
    res.status(200).json({ status: "ok", service: "mof-jotform-faxage-bridge" }),
  );

  app.post(config.webhookPath, limiter, requireToken, upload.any(), async (req, res) => {
    const body = req.body || {};
    const { submissionId, formId } = extractIds(body);
    if (!submissionId || !formId) {
      logger.warn("rejected: missing submissionID/formID", { ip: req.ip });
      return res.status(400).json({ error: "missing submissionID or formID" });
    }

    const faxTo = destinationFor(formId, config);
    const ref = crypto.randomUUID();

    // SB-1 — atomic dedup claim BEFORE any fax. A retried/replayed delivery is a no-op.
    let claimed;
    try {
      claimed = store.claim(submissionId, { formId, faxTo });
    } catch (e) {
      logger.error("dedup claim failed", { ref, submissionId, err: e.message });
      return res.status(500).json({ error: "bridge_error", ref });
    }
    if (!claimed) {
      logger.info("duplicate suppressed", { submissionId, formId });
      store.recordDisclosure({ outcome: "duplicate_suppressed", submissionId, formId, faxTo, ip: req.ip });
      return res.status(200).json({ status: "duplicate_ignored", submissionId });
    }

    try {
      const pdf = await fetchSubmissionPdf({ submissionId, formId }, config);
      await assertUnprotectedPdf(pdf);
      const result = await sendFax(
        { faxTo, pdfBase64: pdf.toString("base64"), fileName: `${submissionId}.pdf` },
        config,
      );

      if (result.ok) {
        logger.info("faxed", { submissionId, formId, faxTo, jobId: result.jobId, ip: req.ip });
        store.recordDisclosure({ outcome: "sent", submissionId, formId, faxTo, jobId: result.jobId, ip: req.ip });
        return res.status(200).json({ status: "sent", jobId: result.jobId });
      }

      if (result.ambiguous) {
        // HTTP 200 w/o JOBID — may have queued. KEEP the claim so a Jotform retry can't
        // double-send; surface for an operator via the disclosure log.
        logger.error("faxage ambiguous (200 without JOBID) — claim retained", { ref, submissionId, formId, faxTo, raw: truncate(result.raw) });
        store.recordDisclosure({ outcome: "ambiguous", submissionId, formId, faxTo, ref, ip: req.ip });
        return res.status(502).json({ error: "fax_send_ambiguous", ref });
      }

      // Clear failure — release the claim so a retry can re-attempt cleanly.
      store.release(submissionId);
      logger.error("faxage send failed — claim released", { ref, submissionId, formId, faxTo, raw: truncate(result.raw) });
      store.recordDisclosure({ outcome: "failed", submissionId, formId, faxTo, ref, ip: req.ip });
      return res.status(502).json({ error: "fax_send_failed", ref });
    } catch (e) {
      // Fetch / guard / transport error — release the claim (retryable).
      store.release(submissionId);
      logger.error("bridge error — claim released", { ref, submissionId, formId, faxTo, err: e.message });
      store.recordDisclosure({ outcome: "error", submissionId, formId, faxTo, ref, ip: req.ip });
      return res.status(500).json({ error: "bridge_error", ref });
    }
  });

  return app;
}

// ── Entry point ──────────────────────────────────────────────────────────────
if (require.main === module) {
  require("dotenv").config();
  const { buildConfig } = require("./config");
  const { createLogger } = require("./logger");
  const { createStore } = require("./store");
  const { fetchSubmissionPdf } = require("./jotform");
  const { assertUnprotectedPdf } = require("./pdf");
  const { sendFax } = require("./faxage");

  let config;
  try {
    config = buildConfig(process.env);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[config] ${e.message}`);
    process.exit(1);
  }

  const logger = createLogger(config.logLevel);
  const store = createStore(config.dataDir, logger);
  const app = createApp({ config, fetchSubmissionPdf, assertUnprotectedPdf, sendFax, logger, store });
  app.listen(config.port, () =>
    logger.info("bridge listening", {
      port: config.port,
      path: config.webhookPath,
      dest: config.faxDest,
      pdfMode: config.jotform.pdfMode,
      dataDir: config.dataDir,
    }),
  );
}

module.exports = { createApp, extractIds };
