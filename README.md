# jotform-faxage-bridge

Automatically fax **Jotform** submissions through the **Faxage** API. When a form is submitted,
a webhook fetches the submission as a PDF from the Jotform API and sends it to a configured fax
number — **form-agnostic**, **configuration-driven**, and built with **HIPAA-grade safeguards**
for workflows that handle PHI.

```
Jotform submission ──webhook (HTTPS)──▶ bridge ──fetch PDF (Jotform API)──▶
                                          │  dedup        (fax each submission once)
                                          │  verify PDF   (openable & unencrypted, or refuse)
                                          └── base64 PDF ──▶ Faxage (operation=sendfax) ──▶ FAX_DEST
                                                              + append a PHI-disclosure audit record
```

## Features

- **Drop-in & reusable** — point it at any Jotform + Faxage account through a single `.env`; nothing is hardcoded.
- **Form-agnostic** — one webhook URL serves every form. Add or remove forms entirely in Jotform — no code change or redeploy.
- **Exactly-once** — a durable per-submission claim makes Jotform's retries safe, so a submission is faxed once, never duplicated.
- **PHI-safe** — the PDF stays in memory (never written to disk in the request path); logs never contain PHI; every fax is recorded in an append-only disclosure audit log.
- **Fails closed** — verifies the fetched document is an openable, unencrypted PDF before sending; it will never fax a junk or locked file.
- **Hardened** — constant-time shared-secret webhook auth, per-IP rate limiting, request-size caps, a non-root read-only container, and a dependency-audit build gate.
- **Per-form routing (optional)** — send specific forms to different fax numbers via `FORM_FAX_MAP`.
- **Dashboard ingestion (optional)** — point `FAX_DEST` at your fax provider's *inbound* number to drop each submission straight into your existing inbound-fax queue.

## How it works

1. A form is submitted → Jotform calls the bridge's webhook over HTTPS.
2. The bridge authenticates the request (shared-secret token), then fetches the submission rendered as a PDF from the Jotform API.
3. It verifies the PDF is openable and unencrypted, then sends it to Faxage (`operation=sendfax`) addressed to the configured number.
4. On success it records a non-PHI disclosure audit entry and returns the Faxage job id.

---

## Repo layout

```
src/
  server.js     Express app: token gate → dedup → fetch → verify → fax → disclosure log; /health
  config.js     loads & validates .env (fails fast); FORM_FAX_MAP; secret-entropy & https checks
  jotform.js    fetch submission PDF (modes: generatePDF | getSubmissionPDF), size-capped
  faxage.js     Faxage sender (operation=sendfax); ok / ambiguous / failed result
  pdf.js        verifies the bytes are an openable, unencrypted PDF with ≥1 page
  store.js      durable dedup claims (O_EXCL) + append-only disclosure audit log
  logger.js     structured JSON logging (never logs PHI)
scripts/probe.js     setup check — confirm the Jotform PDF retrieval works for your account
examples/Caddyfile   reverse-proxy + TLS + access-log token redaction
test/                node:test unit + integration tests
docs/STAFF-HOWTO.md  guide for Jotform admins (add/remove forms)
docs/SECURITY-REVIEW.md  security + HIPAA review and remediation status
Dockerfile, docker-compose.yml, .github/dependabot.yml
```

---

## Configuration

Copy `.env.example` to `.env` and fill it in. Required values are validated at startup; the
service refuses to boot if any are missing or weak.

| Variable | Required | Purpose |
|---|---|---|
| `SHARED_SECRET` | **yes** | webhook auth token — **≥32 chars, high-entropy** (`openssl rand -hex 32`) |
| `JOTFORM_API_KEY` | **yes** | Full-Access Jotform API key |
| `FAX_DEST` | **yes** | destination fax number (10/11 digits) |
| `FAXAGE_USERNAME`/`FAXAGE_COMPANY`/`FAXAGE_PASSWORD` | **yes** | Faxage credentials |
| `PORT` | no (3000) | local/container port (behind the reverse proxy) |
| `PUBLIC_DOMAIN` | no | the public hostname Jotform posts to (informational) |
| `WEBHOOK_PATH` | no (`/jotform-fax`) | route Jotform's webhook targets |
| `WEBHOOK_TOKEN_HEADER` | no (`x-webhook-token`) | header the token may arrive in |
| `JOTFORM_API_BASE` | no | `https://hipaa-api.jotform.com` (HIPAA) / `https://api.jotform.com` — **https only** |
| `JOTFORM_PDF_MODE` | no (`generatePDF`) | `generatePDF` \| `getSubmissionPDF` |
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
- a **`?token=` query param** (what the Jotform Webhooks UI supports).

Because the query form puts the secret in the URL, the reverse proxy should **redact it from access logs**
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

**Docker:**
```bash
cp .env.example .env      # then edit .env
docker compose up -d --build
docker compose logs -f
```
The container runs non-root with a read-only root filesystem, all capabilities dropped, and a persistent
`bridge-data` volume for the dedup claims + disclosure log.

---

## Setup check

Before going live, confirm the Jotform API returns a usable PDF for your account and form:

```bash
JOTFORM_API_KEY=<key> node scripts/probe.js \
  --form <FORM_ID> --sid <SUBMISSION_ID> --base https://hipaa-api.jotform.com
```
**PASS** → set `JOTFORM_PDF_MODE` to the endpoint it recommends (HIPAA accounts use the `hipaa-api.jotform.com`
host with the key in an `APIKEY` header and lowercase `formid`/`submissionid`). If a form uses Jotform's
end-to-end **Encrypted Forms**, the API can't return a usable PDF — disable it for forms you want to fax.
(Add `--save` to keep the fetched PDF for inspection; it is written `0600` and deleted on exit.)

---

## Deploy behind TLS

1. Run the container (above) on your host; it listens on `127.0.0.1:$PORT`.
2. Put **Caddy** in front for automatic Let's Encrypt TLS using `examples/Caddyfile`
   (`<PUBLIC_DOMAIN> → 127.0.0.1:$PORT`, with the token redacted from logs).
3. Point a DNS **A record** for `<PUBLIC_DOMAIN>` at the host's public IP.
4. Open inbound **443** (and **80** for ACME) to the internet; the shared-secret token is the gate
   (Jotform's webhook IPs are dynamic and can't be allowlisted).

For HIPAA deployments, see **[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md)** for the recommended
posture (encryption at rest, secrets management, durable log retention, etc.).

---

## Adding / removing forms

The bridge faxes any form that has the webhook configured — so a Jotform admin adds (or removes) the webhook
URL on a form to start (or stop) faxing it. **No code change or redeploy.** See
[docs/STAFF-HOWTO.md](docs/STAFF-HOWTO.md). The webhook URL is the same for every form:

```
https://<PUBLIC_DOMAIN><WEBHOOK_PATH>?token=<SHARED_SECRET>
```

To send a specific form to a different fax number, add it to `FORM_FAX_MAP` (a config edit + restart).

---

## Security & HIPAA

Reviewed adversarially before release — see **[docs/SECURITY-REVIEW.md](docs/SECURITY-REVIEW.md)** for the full
security & HIPAA posture. Highlights:

- **Exactly-once delivery** via a durable, atomic `submissionId` claim; an ambiguous fax-provider response retains
  the claim rather than risk a duplicate.
- **Disclosure audit log** — every fax appends a non-PHI `phi_fax_disclosure` record; ship container logs to a
  durable, access-controlled sink (e.g. CloudWatch) for retention.
- **Auth before parsing**, constant-time token compare, per-IP rate limiting, dropped file uploads, size caps.
- **No PHI at rest** in the request path; the PDF verification **fails closed**.
- Hardened container (non-root, read-only FS, dropped capabilities, resource limits), current LTS runtime,
  `npm audit` build gate, and Dependabot.

---

## Tests

`npm test` runs the `node:test` suite (28 cases): config validation (secret entropy, https bases, fax-number
and `FORM_FAX_MAP` checks), the PDF verification, and the webhook handler — token gate (header + query),
id extraction, happy path + disclosure record, per-form routing, **dedup/idempotency**, ambiguous-vs-clear
fax-provider failure handling, and the fail-closed path.

## License

[MIT](LICENSE)
