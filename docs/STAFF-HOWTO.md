# How to send a Jotform form to fax (staff guide)

This explains how to make a Jotform form **automatically fax itself** when it's submitted,
and how to stop it. You do everything inside Jotform — no developer needed.

When a form is connected, every submission is sent as a fax automatically (for MOF, it lands
in the inbound-fax dashboard). Connecting or disconnecting a form is just adding or removing
one **webhook** on that form.

---

## What you need

- Admin access to the Jotform account.
- The **webhook URL** (ask your administrator; keep it private — treat it like a password):

  ```
  https://<PUBLIC_DOMAIN>/jotform-fax?token=<SHARED_SECRET>
  ```

---

## Before you connect a form — quick checklist

For each form you want to fax, confirm:

1. ☐ The form is on the **HIPAA-enabled** account (required for PHI).
2. ☐ **Encrypted Forms / "Encrypted Forms 2.0" is OFF** on the form.
   *(Settings → Form Settings → look for Encryption. If it's on, the fax cannot be generated —
   leave it off, or check with your administrator first.)*
3. ☐ Webhooks are allowed on the account (complete any one-time HIPAA consent Jotform asks for).

---

## Add a form to faxing

1. Open the form in the **Jotform Form Builder**.
2. Go to **Settings** (top menu) → **Integrations**.
3. Search for and open **Webhooks**.
4. Paste the **webhook URL** (above) into the field.
5. Click **Complete Integration** / **Add**.
6. Done — the next submission to this form will be faxed automatically.

Repeat for each form you want to fax. The **same URL** is used for every form.

---

## Test that it worked

1. Open the form's public link and submit one **test entry** (use non-real data).
2. Within a minute, the document should appear in the **MOF inbound-fax dashboard**.
3. If it shows up and opens normally (no password prompt), the form is connected correctly.

---

## Remove a form from faxing

1. Open the form → **Settings → Integrations → Webhooks**.
2. **Delete** the webhook entry (trash/remove icon).
3. That form will no longer fax on submission. Other forms are unaffected.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Nothing arrives in the dashboard | Webhook not saved, or wrong URL | Re-open Webhooks and confirm the exact URL (including `?token=…`) is present |
| Nothing arrives, URL looks right | Form has **Encryption** turned on | Turn off Encrypted Forms on the form, or escalate to your administrator |
| Worked before, stopped working | Token changed / webhook removed | Get the current webhook URL from your administrator and re-add it |
| Document arrives but is blank/locked | Document/source issue | Escalate to your administrator — do **not** keep resubmitting |

**Escalation:** if a form won't fax after the checklist above, contact your administrator with
the **form name** and **form ID** (the number in the form's URL). Do not share the webhook URL
in tickets or email.
