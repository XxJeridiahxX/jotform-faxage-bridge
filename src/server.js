"use strict";

const express = require("express");
const multer = require("multer");

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
 * unit-tested without real network calls.
 */
function createApp(deps) {
  const { config, fetchSubmissionPdf, assertUnprotectedPdf, sendFax, logger } = deps;
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  app.get("/health", (_req, res) =>
    res.status(200).json({ status: "ok", service: "mof-jotform-faxage-bridge" }),
  );

  // upload.any() parses the multipart webhook fields into req.body.
  app.post(config.webhookPath, upload.any(), async (req, res) => {
    const body = req.body || {};

    // 1. Authenticate — Jotform offers no signing, so a shared secret is the gate.
    const token = req.query.token || body.token;
    if (!token || token !== config.sharedSecret) {
      logger.warn("rejected: missing/invalid token", { ip: req.ip });
      return res.status(401).json({ error: "unauthorized" });
    }

    // 2. Identify the submission.
    const { submissionId, formId } = extractIds(body);
    if (!submissionId || !formId) {
      logger.warn("rejected: missing submissionID/formID", { submissionId, formId });
      return res.status(400).json({ error: "missing submissionID or formID" });
    }

    const faxTo = destinationFor(formId, config);

    try {
      // 3. Fetch the document as a PDF, 4. assert it is unprotected.
      const pdf = await fetchSubmissionPdf({ submissionId, formId }, config);
      await assertUnprotectedPdf(pdf);

      // 5. Hand it to Faxage.
      const result = await sendFax(
        { faxTo, pdfBase64: pdf.toString("base64"), fileName: `${submissionId}.pdf` },
        config,
      );

      if (!result.ok) {
        logger.error("faxage send failed", { submissionId, formId, faxTo, raw: truncate(result.raw) });
        return res.status(502).json({ error: "fax_send_failed", detail: truncate(result.raw) });
      }

      logger.info("faxed", { submissionId, formId, faxTo, jobId: result.jobId });
      return res.status(200).json({ status: "sent", jobId: result.jobId });
    } catch (e) {
      logger.error("bridge error", { submissionId, formId, faxTo, err: e.message });
      return res.status(500).json({ error: "bridge_error", detail: e.message });
    }
  });

  return app;
}

// ── Entry point ──────────────────────────────────────────────────────────────
if (require.main === module) {
  require("dotenv").config();
  const { buildConfig } = require("./config");
  const { createLogger } = require("./logger");
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
  const app = createApp({ config, fetchSubmissionPdf, assertUnprotectedPdf, sendFax, logger });
  app.listen(config.port, () =>
    logger.info("bridge listening", {
      port: config.port,
      path: config.webhookPath,
      dest: config.faxDest,
      pdfMode: config.jotform.pdfMode,
    }),
  );
}

module.exports = { createApp, extractIds };
