# Security & HIPAA Posture — `jotform-faxage-bridge`

This bridge is designed for workflows that handle PHI and ships with defense-in-depth controls across the
application, container, and (recommended) deployment layers. It was reviewed adversarially across application
security, the HIPAA Security Rule, cloud/container hardening, privacy/reliability, and software supply chain.
This document summarizes the controls the current version implements and the deployment posture recommended
for HIPAA environments.

## Application security — controls in place

- **Exactly-once delivery (integrity).** A durable, atomic per-`submissionId` claim (O_EXCL on a persistent
  volume) makes a webhook sender's retries safe — each submission is faxed once, never duplicated. An ambiguous
  fax-provider response retains the claim rather than risk a duplicate. (`src/store.js`, `src/server.js`, `src/faxage.js`)
- **PHI-disclosure audit log.** Every fax appends a non-PHI `phi_fax_disclosure` record (submission/form ids,
  destination, outcome, job id, source ip) to an append-only log — supporting an accounting of disclosures.
  (`src/store.js`, `src/server.js`)
- **Authenticated before parsing.** A shared-secret token is required and validated with a constant-time
  comparison **before** the request body is read, so nothing is buffered for an unauthenticated caller. Token
  accepted via `X-Webhook-Token` header (preferred) or `?token=`. (`src/server.js`)
- **No PHI at rest in the request path.** The PDF is held in memory and base64-encoded inline — never written
  to disk or object storage by the bridge. Logs never contain PHI. (`src/server.js`, `src/logger.js`)
- **Fail-closed document verification.** Each fetched document is verified to be an openable, unencrypted PDF
  with at least one page before it is sent; anything else is refused. (`src/pdf.js`)
- **No SSRF surface.** The bridge fetches only fixed, configured Jotform endpoints — it never follows
  submitter-supplied URLs. (`src/jotform.js`)
- **Abuse resistance.** Per-IP rate limiting, request field/size caps, dropped file uploads, and finite
  response-size limits on upstream calls. (`src/server.js`, `src/jotform.js`, `src/faxage.js`)
- **Safe error handling.** Responses return a generic error + correlation id; upstream/internal detail is kept
  in server-side logs, not returned to callers. (`src/server.js`)
- **Strict input validation, fail-fast config.** Enforces a high-entropy `SHARED_SECRET`, `https://`-only
  Jotform/Faxage endpoints, 10/11-digit fax numbers, and a prototype-pollution-safe `FORM_FAX_MAP`; the service
  refuses to boot if misconfigured. (`src/config.js`)

## Container & supply chain — controls in place

- Non-root user, **read-only root filesystem**, all Linux capabilities dropped, `no-new-privileges`, and
  memory/PID/CPU limits. (`docker-compose.yml`, `Dockerfile`)
- Current **LTS runtime**, an `npm audit --audit-level=high` build gate, a committed lockfile with `npm ci`,
  and weekly Dependabot updates (npm + Docker). (`Dockerfile`, `.github/dependabot.yml`)
- Secrets and generated PDFs are excluded from both the repository and the image; loopback-only port bind
  behind a TLS-terminating reverse proxy. (`.gitignore`, `.dockerignore`, `docker-compose.yml`)
- Fax destinations are normalized to digits to prevent number injection from config. (`src/config.js`, `src/faxage.js`)

## HIPAA Security Rule — how the bridge maps

| Safeguard | How it's addressed |
|---|---|
| §164.312(a) Access control | shared-secret token auth (constant-time), least-exposure (no PHI persisted) |
| §164.312(b) Audit controls | append-only PHI-disclosure log + structured event logging |
| §164.312(c) Integrity | exactly-once delivery; fail-closed PDF verification |
| §164.312(e) Transmission security | HTTPS on both network legs with certificate validation |

## Recommended deployment hardening (operator)

The application controls above are complete; the items below are the operator's responsibility for a
HIPAA-grade deployment and are documented so they aren't missed:

1. EBS (or volume) encryption at rest (KMS).
2. Source the secrets from a secrets manager (e.g. AWS Secrets Manager/SSM) + a scoped instance role, rather
   than a plaintext `.env`.
3. Ship container logs to a durable, access-controlled, long-retention sink (e.g. CloudWatch, ≥6-yr retention,
   KMS) — `docker-compose.yml` includes a ready-to-use `awslogs` block.
4. Restrict egress to the required endpoints (Jotform API, Faxage, ACME, DNS); enforce IMDSv2 on cloud hosts.
5. Patch management + backups for the host; confirm executed BAAs with Jotform and your fax provider; add the
   host to your PHI system inventory.

---

*Reviewed adversarially prior to release; this reflects the current `main` version.*
