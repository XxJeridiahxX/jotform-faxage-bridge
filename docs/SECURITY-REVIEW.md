# Security & HIPAA Review — `mof-jotform-faxage-bridge`

Pre-production adversarial review of this PHI webhook (Jotform → Faxage) for a BAA-covered HIPAA EC2
(Docker behind Caddy/TLS). Conducted 2026-06-26 by a multi-agent panel (AppSec, HIPAA Security Rule,
Cloud/Container, Privacy/Reliability, Supply-chain); every finding was source-verified at file:line and
adversarially re-checked. This document records the findings **and their remediation status in this repo.**

Legend: ✅ fixed in code · ⏳ deploy-time (operator action, documented) · 📝 documented/accepted

## Verdict

Core design is sound — **no auth-bypass, RCE, or unauthenticated PHI exposure.** Two ship-blockers had to be
closed before real PHI; both are now fixed in code. The remaining items are hardening; the code-side ones are
implemented and the AWS/host ones are documented as go-live prerequisites.

## Ship-blockers

| ID | Issue | Status |
|----|-------|--------|
| **SB-1** | No idempotency → Jotform retries duplicate PHI faxes into the EMR (§164.312(c)) | ✅ `src/store.js` atomic O_EXCL `submissionId` claim before send; duplicates return 200; claim released on genuine failure, **retained** on ambiguous Faxage-200-without-JOBID. (`src/server.js`, `src/faxage.js`) |
| **SB-2** | No durable, tamper-resistant PHI-disclosure audit log (§164.312(b)) | ✅ append-only JSONL `disclosures.log` on the persistent volume + explicit `phi_fax_disclosure` events (sent/failed/ambiguous/error/duplicate, incl. `ip`). ⏳ ship container stdout to a BAA-covered CloudWatch group (≥6-yr retention, KMS) — `docker-compose.yml` has the `awslogs` block ready to uncomment. |

## High / Medium

| ID | Theme | Status |
|----|-------|--------|
| M-A1 | Shared secret in URL query string (proxy-log exposure) | ✅ token now accepted via `X-Webhook-Token` header (preferred) with query fallback (Jotform's webhook UI only supports URL). ⏳ `examples/Caddyfile` redacts `?token=` from access logs. |
| M-A2 | Non-constant-time token compare; token from body | ✅ `crypto.timingSafeEqual`; body-token removed; `SHARED_SECRET` min-entropy enforced in `config.js`. |
| M-B1 | SSRF + API-key exfiltration via `uploadFile` mode | ✅ **`uploadFile` mode deleted** (removed from `jotform.js` + `VALID_PDF_MODES`). |
| M-B2 | `JOTFORM_API_BASE`/`FAXAGE_URL` unvalidated | ✅ both asserted `https://` at config load. |
| M-B3 | Unrestricted egress | ⏳ documented: SG egress allowlist (Jotform/Faxage/ACME/DNS) in README deploy section. |
| M-C1 | No durable retry / dead-letter | 📝 interim: ambiguous-vs-clear failure handling + dedup makes Jotform's own retry safe (no duplicates); full SQS+DLQ deferred. |
| M-C2 | No rate-limit; multer parses pre-auth; uncapped files | ✅ `express-rate-limit` + auth-before-parse middleware + multer `fileFilter` drops files + field caps. |
| M-C3 | Upstream fetch had no size cap | ✅ `maxContentLength/maxBodyLength` on jotform + faxage (`MAX_PDF_MB`). |
| M-D1 | Error responses echo upstream/exception detail | ✅ responses now `{ error, ref }` (correlation id); detail logged server-side; PDF byte-preview removed. |
| M-D2 | Wrong client IP (no trust proxy) | ✅ `app.set('trust proxy', TRUST_PROXY)`. |
| M-E1 | Plaintext `.env` secrets | ⏳ documented: source the 3 secrets from Secrets Manager/SSM + IAM role; `.env` is git/docker-ignored interim. |
| M-E2 | EOL Node 18 | ✅ `Dockerfile` → `node:22-alpine`; `engines` → `>=20 <25`. |
| M-E3 | Floating base tag, no scan | ✅ `npm audit --audit-level=high` build gate; 📝 digest-pin command documented in `Dockerfile`. |
| M-E4 | Container hardening gaps | ✅ `docker-compose.yml`: `read_only`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`, `mem_limit`/`pids_limit`/`cpus`. |
| M-E5 | EBS encryption/patching/backup advisory only | ⏳ documented as go-live prerequisites (README). |
| M-E6 | No SCA gate | ✅ `npm audit` build gate + `.github/dependabot.yml` (npm + docker, weekly) + `npm run audit`. |

## Low / hardening

- ✅ `FORM_FAX_MAP`/`FAX_DEST` validated to 10/11 digits, null-proto map, reserved-key rejection.
- ✅ PDF guard hardened: whole-buffer `/Encrypt` scan + `isEncrypted` + `pageCount ≥ 1`.
- ✅ `probe.js` writes PHI only behind `--save`, **after** the guard, to a `0600` temp file deleted on exit.
- 📝 `/health` unauthenticated (loopback-bound static string) — optionally hide it at Caddy.

## Deploy-time prerequisites (operator — verify before first PHI)

1. EBS default encryption (KMS) on the volume.
2. IMDSv2 required (`--http-tokens required --http-put-response-hop-limit 1`).
3. Security-group **egress** allowlist (Jotform API, Faxage, ACME, DNS); inbound 443→0.0.0.0/0, 22→your IP.
4. Secrets in Secrets Manager/SSM + scoped IAM instance role; CloudTrail on secret reads.
5. CloudWatch Logs group (≥6-yr retention, KMS); uncomment the `awslogs` block in `docker-compose.yml`.
6. SSM Patch Manager + AWS Backup (AMI/snapshot); confirm BAA covers EC2, CloudWatch, Secrets Manager.
7. Confirm executed BAAs with **Jotform** and **Faxage**; add this host to the PHI system inventory.

## Already solid (kept)

PHI in-memory only (never disk in the request path); guard fails closed; fail-fast config; non-root,
loopback-bound container; HTTPS both legs with cert validation; committed lockfile + `npm ci`; secrets &
PDFs excluded from repo and image; digit-normalized fax destinations.
