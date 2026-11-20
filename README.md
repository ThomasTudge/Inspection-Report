# Parker Plant inspection app

Phone web app for engineers inspecting asphalt plants on site: sign in, fill in the inspection checklist, take photos, get the customer's signature and submit. The server stores the report, builds a PDF and emails it to the engineer (and the office, and optionally the customer) through Resend.

- Works with poor signal: drafts are saved on the phone as you type, and submitted reports wait in an outbox on the phone until there is signal.
- Individual logins. Admins add engineers, reset passwords and see every report.
- The checklist is in `public/checklist.json` (currently a sample to be replaced with Parker's own).

## Running on Railway

Needs a Postgres database. Environment variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (`${{Postgres.DATABASE_URL}}`) |
| `SESSION_SECRET` | Long random string used to sign login cookies |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Creates the first admin on first start only. They must change the password at first sign-in. |
| `RESEND_API_KEY` | Turns on emailing. Without it reports are saved but not emailed. |
| `MAIL_FROM` | Sender, e.g. `Parker Plant Inspections <inspections@parkerplant.com>` (domain must be verified in Resend). Defaults to Resend's test sender. |
| `OFFICE_EMAIL` | Comma-separated addresses copied on every report |
| `REPLY_TO` | Optional reply-to address |

| `SET_USERS` | One-off: JSON list of `{email, password, name, role}` to create accounts or reset passwords on start. Clear it afterwards. |

`npm start` runs the server. Tables are created automatically on start.
