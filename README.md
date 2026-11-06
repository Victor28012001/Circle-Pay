# Ajo

Ajo helps a circle creator track rotating savings contributions, invite members,
and share payment evidence. Member accounts are invite-only; invite links are
single-use and expire after seven days.

## Run locally

1. Copy `.env.example` to `.env`.
2. Set `ADMIN_USER` and a long `ADMIN_PASSWORD`.
3. Leave `ROQQU_API_KEY` blank for practice mode, or configure a Roqqu test key
   and `ROQQU_MODE=staging`.
4. Run `npm start` and open `http://localhost:3000`.

The admin account can create circles and invite members by sharing the generated
link. Members sign up with the invited email address and a password. Add each
member's email in the circle using the `Name | email` format.

## Roqqu

The app's server calls Roqqu; API keys are never sent to the browser. The
adapter supports:

- `POST /balances` for the owner-only balance check.
- `POST /payment-links` for NGN contribution links.
- Encrypted payment-link webhooks for confirmation. Configure the app's public
  HTTPS `/api/webhook/roqqu` URL in the Roqqu console.

Set `ROQQU_BASE_URL` to the Roqqu API base URL. `ROQQU_MODE` defaults to
`staging` when a key is present and must be set to `live` before production
transactions. `PUBLIC_URL` must be the public HTTPS address for payment links.
Use a staging key with `ROQQU_MODE=staging`; never commit keys or place them in
`.env.example`. If a key has been shared or committed, revoke and replace it.

Contributions count only after Roqqu confirms the exact amount. Contributors
may attach JPG, PNG, or PDF evidence (up to 3 MB), but an upload does not mark a
contribution paid. Payouts are recorded for tracking only; the app does not
send funds.

## Storage

The app stores users, circles, invites, and payment records in `data.json`.
Uploaded evidence is kept in `uploads/`. Back up both locations and protect
them as application data. Set `DATA_FILE` and `UPLOAD_DIR` to change the paths.
