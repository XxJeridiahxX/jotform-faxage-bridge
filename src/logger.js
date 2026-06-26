"use strict";

/**
 * Minimal structured logger. Emits one JSON line per event.
 *
 * IMPORTANT (HIPAA): callers must pass ONLY non-PHI metadata — submissionID,
 * formID, destination fax number, Faxage JOBID, status, error message. Never
 * pass form answers, file bytes, or the PDF itself.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(level = "info") {
  const threshold = LEVELS[level] !== undefined ? LEVELS[level] : LEVELS.info;
  const emit = (lvl, msg, meta) => {
    if (LEVELS[lvl] > threshold) return;
    const line = { t: new Date().toISOString(), level: lvl, msg };
    if (meta && typeof meta === "object") Object.assign(line, meta);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(line));
  };
  return {
    error: (msg, meta) => emit("error", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    debug: (msg, meta) => emit("debug", msg, meta),
  };
}

module.exports = { createLogger };
