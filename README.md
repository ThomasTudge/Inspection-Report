# Parker Plant inspection app

Phone web app for engineers inspecting asphalt plants on site: sign in, fill in the inspection checklist, take photos, get the customer's signature and submit. The server stores the report, builds a PDF and emails it to the engineer (and the office, and optionally the customer) through Resend.

- Works with poor signal: drafts are saved on the phone as you type, and submitted reports wait in an outbox on the phone until there is signal.
- Individual logins. Admins add engineers, reset passwords and see every report.
- The form follows Parker's *Asphalt Plant Inspection Report* (sections 1–9). The checklist areas and lines are in `public/checklist.json`; the PDF layout is in `src/pdf.js`.
- Photos can be taken against any checklist line or area (plus a cover photo). They get refs like `5.2-1` and appear under their area in the PDF; line photos are also listed in the Issues table.
- Every Monitor, Action or Urgent line goes into Section 6 (Issues) automatically. Parts in Section 7 can be linked to an issue.
- Engineers can edit or delete their own reports (admins any). An edit keeps the report number, becomes the next revision and is emailed again. Any report can be emailed to chosen addresses from the list.
- **Parts manuals** (menu → Parts manuals): upload a Parker parts manual PDF and the app reads its contents list, drawings and parts lists (`src/manual.js`), filing each unit under the checklist areas. In a report, pick the plant's manual in Section 1 (found automatically from the serial/machine number), then use "Pick replacement part" on any Monitor/Action/Urgent line, "Parts for this area", or "Pick from parts manual" in Section 7. Drawings can be saved on the phone for use with no signal.
- Reports made on the earlier sample checklist still open with the old PDF layout (`src/pdf-v1.js`).

## Running on Railway

Needs a Postgres database. Environment variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (`${{Postgres.DATABASE_URL}}`) |
| `SESSION_SECRET` | Long random string used to sign login cookies |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Creates the first admin on first start only. They must change the password at first sign-in. |
| `RESEND_API_KEY` | Turns on emailing through Resend. Without it (or the SMTP settings) reports are saved but not emailed. |
| `MAIL_FROM` (or `RESEND_FROM`) | Sender, e.g. `Parker Plant Inspections <inspections@parkerplant.com>` (domain must be verified in Resend). Defaults to Resend's test sender. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Alternative to Resend: send through a mailbox, e.g. Microsoft 365 (`smtp.office365.com`, port 587). |
| `MANUAL_PDF_PASSWORD` | Optional: password for opening protected parts manual PDFs. |
| `OFFICE_EMAIL` | Comma-separated addresses copied on every report |
| `REPLY_TO` | Optional reply-to address |

| `SET_USERS` | One-off: JSON list of `{email, password, name, role}` to create accounts or reset passwords on start. Clear it afterwards. |

`npm start` runs the server. Tables are created automatically on start.
