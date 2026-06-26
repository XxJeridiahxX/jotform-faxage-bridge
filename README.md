# mof-jotform-faxage-bridge

A small, **reusable, configuration-driven** service that automatically faxes Jotform
submissions through the **Faxage** API — built for a HIPAA/PHI workflow.

When a form is submitted, Jotform calls this bridge's webhook. The bridge pulls the
submission's document as an **unprotected PDF** straight from the Jotform API, verifies
it is genuinely unencrypted, and hands it to Faxage for transmission. This bypasses the
broken *email-to-fax* path (HIPAA Jotform accounts password-protect emailed PDFs, which
Faxage cannot open).

Everything deployment-specific lives in a **`.env` file** — destination fax number, public
domain, webhook path/token, Jotform key, Faxage credentials. Nothing is hardcoded, so the
same image can power any Jotform→Faxage bridge by changing config only.

```
Jotform submission ──webhook(HTTPS)──▶ bridge ──fetch unprotected PDF (APIKEY header)──▶ Jotform API
                                          │  dedup claim (no duplicate faxes)
                                          │  assert PDF is unencrypted (fail closed)
                                          └── base64 PDF ──▶ Faxage (operation=sendfax) ──▶ FAX_DEST
                                                              + append PHI-disclosure audit record
```

> **MOF deployment note:** the default `FAX_DEST` is `1-877-540-0750`, MOF's own Faxage
> *inbound* number. Faxing there auto-ingests each document into the existing MOF inbound-fax
> dashboard pipeline.

---

## Repo layout

```
src/
  server.js     Express app: token gate → dedup → fetch → guard → fax → disclosure log; /health
  config.js     loads & validates .env (fails fast); FORM_FAX_MAP; secret-entropy & https checks
  jotform.js    fetch submission PDF (modes: generatePDF [confirmed] | getSubmissionPDF), size-capped
  faxage.js     Faxage sender (operation=sendfax); ok / ambiguous / failed result
  pdf.js        asserts the bytes are an openable, UNENCRYPTED PDF with ≥1 page
  store.js      durable dedup claims (O_EXCL) + append-only PHI-disclosure audit log
  logger.js     structured JSON logging (never logs PHI)
scripts/probe.js     Phase 0 linchpin probe (run before go-live; no PHI to disk unless --save)
examples/Caddyfile   reverse-proxy + TLS + access-log token redaction
test/                node:test unit + integration tests
docs/STAFF-HOWTO.md  handoff guide for Jotform admins (add/remove forms)
docs/SECURITY-REVIEW.md  security + HIPAA review and remediation status
Dockerfile, docker-compose.yml, .github/dependabot.yml
```

---

## Configuration

Copy `.env.example` to `.env` and fill it in. Required values are validated at startup;
the service refuses to boot if any are missing or weak.

| Variable | Required | Purpose |
|---|---|---|
| `SHARED_SECRET` | **yes** | webhook auth token — **≥32 chars, high-entropy** (`openssl rand -hex 32`) |
| `JOTFORM_API_KEY` | **yes** | Full-Access Jotform API key |
| `FAX_DEST` | **yes** | default destination fax (10/11 digits) |
| `FAXAGE_USERNAME`/`FAXAGE_COMPANY`/`FAXAGE_PASSWORD` | **yes** | Faxage credentials |
| `PORT` | no (3000) | local/container port (behind the reverse proxy) |
| `PUBLIC_DOMAIN` | no | the public hostname Jotform posts to (informational) |
| `WEBHOOK_PATH` | no (`/jotform-fax`) | route Jotform's webhook targets |
| `WEBHOOK_TOKEN_HEADER` | no (`x-webhook-token`) | header the token may arrive in |
| `JOTFORM_API_BASE` | no | `https://hipaa-api.jotform.com` (HIPAA) / `https://api.jotform.com` (dev) — **https only** |
| `JOTFORM_PDF_MODE` | no (`generatePDF`) | `generatePDF` (confirmed) \| `getSubmissionPDF` |
| `FAXAGE_CALLERID` | no | caller id on the outbound fax |
| `FAXAGE_URL` | no | Faxage endpoint (**https only**) |
| `DATA_DIR` | no (`./data`) | persistent dir for dedup claims + disclosure log (mount a volume; `/data` in container) |
| `TRUST_PROXY` | no (`1`) | proxy hops in front (Caddy = 1) |
| `RATE_LIMIT_PER_MIN` | no (`60`) | max webhook requests per IP per minute |
| `MAX_PDF_MB` | no (`30`) | cap on a fetched PDF (memory-exhaustion guard) |
| `LOG_LEVEL` | no (`info`) | `error\|warn\|info\|debug` — PHI is never logged |
| `FORM_FAX_MAP` | no (`{}`) | JSON `{ formId: faxNumber }` per-form override; empty → all to `FAX_DEST` |

---

## Authentication

Jotform provides no webhook signing, so a shared-secret token gates the endpoint. The token is accepted via:

- the **`X-Webhook-Token` header** (preferred — for programmatic callers), or
- a **`?token=` query param** (what the Jotform Webhooks UI supports for staff).

Because the query form puts the secret in the URL, the reverse proxy **must redact it from access logs**
(see `examples/Caddyfile`). The comparison is constant-time; requests without a valid token get 401 before
any body is parsed.

---

## Run it

**Local (Node 20+):**
```bash
cp .env.example .env      # then edit .env (SHARED_SECRET must be ≥32 chars)
npm install
npm start                 # bridge listens on $PORT
curl localhost:3000/health
npm test                  # run the test suite
npm run audit             # dependency vuln gate
```

**Docker / container (how it goes onto the EC2):**
```bash
cp .env.example .env      # then edit .env
docker compose up -d --build
docker compose logs -f
```
The container runs non-root, read-only root FS, all caps dropped, with a persistent `bridge-data` volume for
dedup claims + the disclosure log.

---

## Phase 0 — prove the linchpin BEFORE go-live

The whole approach depends on the Jotform API returning an **unprotected** PDF on the HIPAA account. Prove it
first — no infrastructure, ~15 minutes:

```bash
JOTFORM_API_KEY=<hipaa-key> node scripts/probe.js \
  --form <FORM_ID> --sid <SUBMISSION_ID> --base https://hipaa-api.jotform.com
```
PASS → set `JOTFORM_PDF_MODE` to the endpoint it recommends (`generatePDF` is confirmed working on the HIPAA
host: APIKEY header + lowercase `formid`/`submissionid`). BLOCKED → the form has Encrypted Forms 2.0 on; turn
it off or change the document source before deploying. (Add `--save` only on a BAA host to keep the PDF for
inspection — it is written `0600` and deleted on exit.)

---

## Deploy to the EC2 (later)

1. **Pull it:** `git clone` (or `docker pull`) on the dedicated EC2; create `.env`; `docker compose up -d --build`.
2. **TLS + reverse proxy:** put **Caddy** in front (auto Let's Encrypt) using `examples/Caddyfile`
   (redacts the token from logs); proxy `https://<PUBLIC_DOMAIN>` → `127.0.0.1:$PORT`.
3. **DNS:** point `<PUBLIC_DOMAIN>` (A record) at the box's Elastic IP.
4. **Security group:** inbound **443 → 0.0.0.0/0** (Jotform IPs are dynamic — the token is the gate),
   **22 → your IP only**, and an **egress allowlist** (Jotform API, Faxage, ACME, DNS).
5. **Verify:** `curl https://<PUBLIC_DOMAIN>/health` → 200, then submit a real test form.

**HIPAA go-live prerequisites (see [docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md)):** EBS default
encryption (KMS); IMDSv2 required; secrets in Secrets Manager/SSM + IAM role; CloudWatch Logs group
(≥6-yr retention, KMS) — uncomment the `awslogs` block in `docker-compose.yml`; SSM Patch Manager + AWS Backup;
executed BAAs with Jotform and Faxage; add the host to the PHI system inventory.

---

## Adding / removing forms

The bridge is **form-agnostic** — it faxes any form that has the webhook configured. To start (or stop) faxing
a form, a Jotform admin adds (or removes) the webhook URL on that form. **No code change or redeploy.** See
[docs/STAFF-HOWTO.md](docs/STAFF-HOWTO.md).

Webhook URL to give staff:
```
https://<PUBLIC_DOMAIN><WEBHOOK_PATH>?token=<SHARED_SECRET>
```
To route a specific form to a *different* fax number, add it to `FORM_FAX_MAP` (config edit + restart).

---

## Security & HIPAA

Reviewed adversarially before production — see **[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md)** for the
full findings and remediation status. Highlights:

- **Idempotency (SB-1):** a durable, atomic `submissionId` claim makes Jotform's retries safe — a submission is
  faxed **exactly once**; an ambiguous Faxage response retains the claim (never double-sends).
- **Disclosure audit log (SB-2):** every fax appends a non-PHI `phi_fax_disclosure` record (§164.312(b));
  ship container logs to a BAA-covered CloudWatch group for durability.
- **Auth before parsing**, constant-time token compare, per-IP rate limiting, dropped file uploads.
- **No PHI at rest** in the request path; the unencrypted-PDF guard **fails closed**.
- **No SSRF:** the submitter-controlled `uploadFile` fetch was removed.
- Hardened container (non-root, read-only FS, cap-drop, resource limits), Node 22, `npm audit` build gate,
  Dependabot.

---

## Tests

`npm test` runs the `node:test` suite (28 cases): config validation (secret entropy, https bases, fax-number
and `FORM_FAX_MAP` checks), the unencrypted-PDF guard, and the webhook handler — token gate (header + query),
id extraction, happy path + disclosure record, per-form routing, **dedup/idempotency**, ambiguous-vs-clear
Faxage failure handling, and the protected-PDF fail-closed path.
