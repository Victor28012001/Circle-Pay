# CirclePay

CirclePay helps a group organize a rotating savings circle (also known as ajo
or esusu). A circle owner sets the contribution amount and schedule, invites
members, tracks each round, and records the payout order and history. Members
can sign in to see their circles, pay through Roqqu when it is configured, and
attach evidence to their own contributions.

CirclePay can run in **practice mode** without a payment-provider key. Practice
payments are simulated and do not move real money.

## What the app does

### Circles and rounds

- Create and manage multiple circles.
- Set a circle name, a contribution amount in Nigerian naira, and a weekly or
  monthly schedule.
- Add 3–30 members. Each member needs a name; add an email in `Name | email`
  format to invite that person to create an account.
- Choose a payout order or draw the order randomly when creating a circle.
- See the current round, the member due to collect, the contribution amount,
  the amount in the pot, payment progress, and overdue status.
- Track the payout order and payout history. After all contributions in a round
  are confirmed, the owner can record that round's payout and continue through
  the cycle. A completed circle can be started as a new cycle.
- Contributions must be at least ₦100.

CirclePay records payouts for tracking only. It does **not** transfer or
disburse funds to members.

### Accounts and invitations

- The owner signs in with the configured admin username and password.
- Member accounts are invite-only. The owner creates an invitation for a
  member with an email address on the circle.
- Invitation links are single-use and expire after seven days. The invited
  person must sign up using the invited email address and choose a password
  that is at least 10 characters long.
- Signed-in members can only access circles they own or belong to. Members
  cannot edit circles they do not own, and other members' private payment
  details are hidden from them.
- Sessions last up to seven days.

### Contributions and evidence

- A member or owner can create a payment link for an unpaid contribution in the
  current round.
- In practice mode, the payment link opens a simulation page. Submitting that
  page marks the contribution as a practice payment; no payment is made.
- With Roqqu configured, CirclePay creates an NGN payment link and waits for a
  verified provider webhook before marking the contribution confirmed.
- Members can attach JPG, PNG, or PDF evidence to their own unpaid
  contribution. Files can be up to 3 MiB. Evidence is private to people who
  have access to that circle.
- An evidence upload is **not** payment confirmation. In live mode, a
  contribution counts as paid only after Roqqu confirms the exact amount in
  NGN.

### Roqqu balance

When Roqqu is configured, the app owner can request the merchant balance for a
token (BTC, USDT, ETH, or SOL in the interface), optionally filtered by
merchant email. This is separate from the circle contribution and payout
tracking.

## Requirements

- Node.js 18 or newer
- npm

## Run locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env`. For example:

   ```sh
   cp .env.example .env
   ```

   In PowerShell, use:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Edit `.env` and set `ADMIN_USER` and a strong, private `ADMIN_PASSWORD`.
   The example sets the username to `admin` but deliberately leaves the
   password blank: there is no shared default admin password.

4. For local practice use, leave `ROQQU_API_KEY` blank. Keep
   `ROQQU_MODE=staging` (the setting in `.env.example`) and leave
   `ROQQU_STAGING_API_KEY` blank too.

5. Start the server and open [http://localhost:3000](http://localhost:3000):

   ```sh
   npm start
   ```

6. Sign in with the `ADMIN_USER` and `ADMIN_PASSWORD` values from your local
   `.env` file. Create a circle and add members. To invite a member, include
   their email in the member list using `Name | email`, then use the invite
   action for that member and share the generated link with them.

The `.env` file is local configuration and must not be committed or shared.
Use a unique password for this app; do not copy the automated test password
below into a real or shared environment.

### Automated test admin credentials

The app's integration test launches a separate server with a temporary data
file and explicitly supplies these **test-only** credentials:

| Setting | Test value |
| --- | --- |
| Admin username | `circle-admin` |
| Admin password | `test-admin-password-123` |

These are not a preconfigured account for your local app, are not read from
your `.env` file, and should never be used for a deployed or shared instance.
They exist so the automated login and member invitation flow can be tested
repeatably. Run the tests with:

```sh
npm test
```

The tests use temporary storage and clean it up when they finish.

## Roqqu configuration

Roqqu API requests are made by the server; API keys are not sent to the
browser. Keep all real or test keys in `.env`, never in source control or
`.env.example`.

### Practice mode

Leave `ROQQU_API_KEY` and `ROQQU_STAGING_API_KEY` blank. CirclePay uses its
local payment simulator, does not call Roqqu, and labels simulated payments as
practice rather than live confirmations.

### Roqqu test/staging mode

Set a Roqqu test key in `ROQQU_API_KEY` and use:

```dotenv
ROQQU_MODE=staging
```

The default base URL is `https://service.roqqu.com/v1`. The app sends staging
requests with the staging API-key header. Use provider-issued test
credentials only.

### Live mode

Live mode can create real payment links. Before enabling it:

- Set `ROQQU_API_KEY` to the appropriate live key and `ROQQU_MODE=live`.
- Set `PUBLIC_URL` to the app's public HTTPS origin. It is used in payment
  links and return URLs.
- Set a strong `ADMIN_PASSWORD`. The server refuses to start in live mode
  without it.
- Configure the provider's webhook URL as
  `https://<your-public-host>/api/webhook/roqqu`.
- Confirm your Roqqu account, API settings, and webhook requirements with
  Roqqu before accepting real payments.

The webhook only marks a contribution paid when the event is a successful
payment-link completion and the confirmed amount and currency match the
contribution. Failed or mismatched events are not counted as paid.

Never commit API keys, live passwords, or other credentials. If a key or
password has been exposed, revoke or rotate it.

## Configuration reference

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port for the app | `3000` |
| `ADMIN_USER` | Owner/admin sign-in username | `admin` |
| `ADMIN_PASSWORD` | Owner/admin sign-in password | Blank; set it for account-based access and always before live mode |
| `PUBLIC_URL` | Public origin used to build invite and payment URLs | `http://localhost:<PORT>` |
| `ROQQU_API_KEY` | Roqqu API key | Blank (practice mode) |
| `ROQQU_STAGING_API_KEY` | Optional staging key; takes precedence over `ROQQU_API_KEY` | Unset |
| `ROQQU_MODE` | Roqqu mode: `staging` or `live` | `staging` |
| `ROQQU_BASE_URL` | Roqqu API base URL | `https://service.roqqu.com/v1` |
| `DATA_FILE` | Path to the JSON data file | `./data.json` |
| `UPLOAD_DIR` | Directory for uploaded evidence | `./uploads` |

For a local app with `ADMIN_PASSWORD` left blank, the app starts in
unauthenticated local practice mode while there are no member accounts. Set an
admin username and password before using member invitations, and always set
them for any shared or deployed instance.

## Data and backups

CirclePay stores its records in a JSON file (`data.json` by default). This
includes circles, member accounts, sessions, invitations, payment references,
and payout records. Uploaded evidence is stored separately in `uploads/` by
default. Set `DATA_FILE` and `UPLOAD_DIR` to use different paths.

Back up both the configured data file and upload directory together. Treat
them as private application data: they may contain member information,
payment details, or evidence files. Do not put production data in source
control.

## Development and tests

Start the app:

```sh
npm start
```

Run the automated test suite:

```sh
npm test
```

The tests cover the admin-to-member invitation and signup flow, circle access
boundaries, contribution simulation, evidence upload and retrieval, and Roqqu
request formatting and webhook decryption. Roqqu API calls in unit tests are
mocked; the test suite does not require a real API key.
