"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Durable, dependency-free state on a persistent volume (DATA_DIR). Two jobs:
 *
 *  - DEDUP (SB-1): an atomic per-submission claim via an O_EXCL marker file, so a
 *    retried or replayed webhook never re-faxes the same submission (Jotform retries
 *    on any non-2xx; duplicate PHI documents would corrupt the clinical record —
 *    HIPAA §164.312(c) integrity).
 *
 *  - DISCLOSURE LOG (SB-2): an append-only JSONL record of every PHI fax disclosure
 *    (HIPAA §164.312(b) audit controls), in addition to stdout. Contains only IDs +
 *    outcome metadata — never PHI/answers/PDF bytes.
 */
function createStore(dataDir, logger) {
  const claimsDir = path.join(dataDir, "claims");
  const disclosureLog = path.join(dataDir, "disclosures.log");
  fs.mkdirSync(claimsDir, { recursive: true });

  // submissionId may come from an untrusted webhook — sanitise for use as a filename.
  const keyFile = (submissionId) =>
    path.join(claimsDir, String(submissionId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200));

  return {
    /**
     * Atomically claim a submission. Returns true if NEWLY claimed (caller should
     * proceed to fax), false if it was already claimed (caller must NOT re-fax).
     */
    claim(submissionId, meta = {}) {
      try {
        const fd = fs.openSync(keyFile(submissionId), "wx", 0o600); // wx = O_CREAT|O_EXCL
        try {
          fs.writeSync(fd, JSON.stringify({ submissionId, ...meta, claimedAt: new Date().toISOString() }));
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch (e) {
        if (e.code === "EEXIST") return false;
        throw e;
      }
    },

    /** Release a claim so a GENUINELY failed send can be retried later. */
    release(submissionId) {
      try {
        fs.unlinkSync(keyFile(submissionId));
      } catch (e) {
        if (e.code !== "ENOENT") logger.warn("claim release failed", { err: e.message });
      }
    },

    /** Append a PHI-disclosure audit record (IDs + outcome only — never PHI). */
    recordDisclosure(event) {
      const line = `${JSON.stringify({ t: new Date().toISOString(), event: "phi_fax_disclosure", ...event })}\n`;
      try {
        fs.appendFileSync(disclosureLog, line, { mode: 0o600 });
      } catch (e) {
        logger.error("disclosure append failed", { err: e.message });
      }
    },

    paths: { claimsDir, disclosureLog },
  };
}

module.exports = { createStore };
