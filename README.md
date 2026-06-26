# mof-jotform-faxage-bridge

A small, **reusable, configuration-driven** service that automatically faxes Jotform
submissions through the **Faxage** API.

When a form is submitted, Jotform calls this bridge's webhook. The bridge pulls the
submission's document as an **unprotected PDF** straight from the Jotform API, verifies
it is genuinely unencrypted, and hands it to Faxage for transmission. This bypasses the
broken *email-to-fax* path (HIPAA Jotform accounts password-protect emailed PDFs, which
Faxage cannot open).

Everything deployment-specific lives in a **`.env` file** — destination fax number, public
domain, webhook path/token, Jotform key, Faxage credentials. Nothing is hardcoded, so the
same image can power any Jotform→Faxage bridge by changing config only.

```
Jotform submission ──webhook(HTTPS)──▶ bridge ──fetch unprotected PDF──▶ Jotform API
                                          │
                                          └── base64 PDF ──▶ Faxage (operation=sendfax) ──▶ FAX_DEST
```

> **MOF deployment note:** the default `FAX_DEST` is `1-877-540-0750`, MOF's own Faxage
> *inbound* number. Faxing there auto-ingests each document into the existing MOF inbound-fax
> dashboard pipeline.

---

## Repo layout

```
src/
  server.js     Express app: webhook route (token gate → fetch → guard → fax) + /health
  config.js     loads & validates .env, parses FORM_FAX_MAP
  jotform.js    fetch submission PDF (modes: getSubmissionPDF | generatePDF | uploadFile)
  faxage.js     Faxage sender (operation=sendfax; parses JOBID)
  pdf.js        asserts the fetched bytes are an openable, UNENCRYPTED PDF
  logger.js     structured JSON logging (never logs PHI)
scripts/probe.js  Phase 0 linchpin probe (run before go-live)
test/           node:test unit + integration tests
Dockerfile, docker-compose.yml
docs/STAFF-HOWTO.md   handoff guide for Jotform admins (add/remove forms)
```

---

## Configuration

Copy `.env.example` to `.env` and fill it in. Required values are validated at startup;
the service refuses to boot if any are missing.

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (3000) | local/container port (kept behind the reverse proxy) |
| `PUBLIC_DOMAIN` | no | the public hostname Jotform posts to (informational) |
| `WEBHOOK_PATH` | no (`/jotform-fax`) | route Jotform's webhook targets |
| `SHARED_SECRET` | **yes** | gate for inbound webhooks (`?token=…`) |
| `LOG_LEVEL` | no (`info`) | `error\|warn\|info\|debug` — PHI is never logged |
| `JOTFORM_API_KEY` | **yes** | Jotform account API key |
| `JOTFORM_API_BASE` | no | `https://hipaa-api.jotform.com` (HIPAA) or `https://api.jotform.com` (dev) |
| `JOTFORM_PDF_MODE` | no | `getSubmissionPDF` \| `generatePDF` \| `uploadFile` (set by the probe) |
| `FAX_DEST` | **yes** | default destination fax (digits only) |
| `FAXAGE_USERNAME` / `FAXAGE_COMPANY` / `FAXAGE_PASSWORD` | **yes** | Faxage credentials |
| `FAXAGE_CALLERID` | no | caller id on the outbound fax |
| `FAXAGE_URL` | no | Faxage endpoint |
| `FORM_FAX_MAP` | no (`{}`) | JSON `{ formId: faxNumber }` per-form override; empty → all to `FAX_DEST` |

---

## Run it

**Local (Node 18+):**
```bash
cp .env.example .env      # then edit .env
npm install
npm start                 # bridge listens on $PORT
curl localhost:3000/health
npm test                  # run the test suite
```

**Docker / container (how it goes onto the EC2):**
```bash
cp .env.example .env      # then edit .env
docker compose up -d --build
docker compose logs -f
```
or a plain container:
```bash
docker build -t mof-jotform-faxage-bridge .
docker run -d --name jotform-faxage-bridge --env-file .env \
  -p 127.0.0.1:3000:3000 --restart unless-stopped mof-jotform-faxage-bridge
```

---

## Phase 0 — prove the linchpin BEFORE go-live

The whole approach depends on the Jotform API returning an **unprotected** PDF on the
HIPAA account. Two things can break that: **Encrypted Forms 2.0** (returns ciphertext) and
the undocumented PDF endpoints behaving differently than expected. Prove it first — no
infrastructure, ~15 minutes:

```bash
JOTFORM_API_KEY=<hipaa-key> node scripts/probe.js \
  --form <FORM_ID> --sid <SUBMISSION_ID> --base https://hipaa-api.jotform.com
```
The probe reports whether the submission JSON is plaintext (not Encrypted Forms 2.0) and
which PDF endpoint returns an openable, unencrypted PDF. Set `JOTFORM_PDF_MODE` to the
endpoint it recommends. If it says **BLOCKED/FAIL**, do not deploy until the document source
is sorted (disable form encryption, or switch artifact).

---

## Deploy to the EC2 (later)

1. **Pull it:** `git clone` (or `docker pull`) on the dedicated EC2; create `.env` from
   `.env.example`; `docker compose up -d --build`.
2. **TLS + reverse proxy:** put **Caddy** in front (auto Let's Encrypt cert + renewal),
   proxying `https://<PUBLIC_DOMAIN>` → `127.0.0.1:$PORT`. Example `Caddyfile`:
   ```
   fax-bridge.example.com {
     reverse_proxy 127.0.0.1:3000
   }
   ```
3. **DNS:** point `<PUBLIC_DOMAIN>` (A record) at the box's Elastic IP.
4. **Security group:** inbound **443 → 0.0.0.0/0** (Jotform's webhook IPs are dynamic — the
   shared-secret token is the gate, not an IP allowlist); **22 → your IP only**.
5. **Disk:** enable **EBS encryption** on the volume (PHI transits the box).
6. **Verify:** `curl https://<PUBLIC_DOMAIN>/health` → 200, then submit a real test form.

---

## Adding / removing forms

The bridge is **form-agnostic** — it faxes any form that has the webhook configured. To
start (or stop) faxing a form, a Jotform admin adds (or removes) the webhook URL on that
form. **No code change or redeploy.** See [docs/STAFF-HOWTO.md](docs/STAFF-HOWTO.md).

Webhook URL to give staff:
```
https://<PUBLIC_DOMAIN><WEBHOOK_PATH>?token=<SHARED_SECRET>
```

To route a specific form to a *different* fax number, add it to `FORM_FAX_MAP` (a config
edit + restart). Empty map → every form goes to `FAX_DEST`.

---

## Security & HIPAA notes

- **Auth:** Jotform provides no webhook signing, so every request must carry the
  `SHARED_SECRET` token; requests without it are rejected (401).
- **No PHI at rest:** the PDF is held in memory and never written to disk or S3 by the bridge.
- **No PHI in logs:** logs contain only submissionID, formID, destination fax, JOBID, status.
- **Guardrail:** every fetched PDF is checked to be a real, **unencrypted** PDF before sending;
  a protected/non-PDF document fails loudly (500) and is never faxed — so the original
  password-locked-PDF failure can never silently recur.
- **TLS end-to-end:** Jotform→bridge and bridge→Faxage are both HTTPS.
- Keep the webhook URL (with token) private; rotate `SHARED_SECRET` if it leaks.

---

## Tests

`npm test` runs the `node:test` suite: config validation, the unprotected-PDF guard
(valid / empty / non-PDF / encrypted), and the webhook handler (token gate, id extraction,
happy path, per-form routing, Faxage-failure and protected-PDF paths).
