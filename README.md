# Loyalty Card for Apple Wallet

A digital stamp card for a coffee shop. Customers add a card to Apple Wallet, baristas stamp it from a
phone or tablet browser, and after a set number of cups the next drink is free. The card on the
customer's phone updates by itself. There is no app to install and the shop's cashier system is not touched.

- Customers open `/join/`, enter a phone number and add the card to Wallet.
- Baristas open `/staff/`, sign in with their own 6-digit PIN, scan the card, and tap **+1 cup**.
- The owner opens `/admin/` to set the reward goal, manage baristas, send announcements, replace a lost card, and read the records.

## What you need

| Thing | Where it comes from |
|---|---|
| Node.js 22 or newer | nodejs.org |
| PostgreSQL 16 or newer, with a **UTF-8** database | the start-up check refuses any other encoding |
| An HTTPS address phones can reach | a Cloudflare tunnel while developing, a host in production |
| Apple Developer account, Pass Type ID, its certificate and key, the WWDR certificate | see below |

The Apple items are only needed for a **real iPhone**. All tests run without them.

### Getting the Apple items

1. Enroll at developer.apple.com/programs/enroll (US$99 a year). Use the shop's or the company's account, not a personal one.
2. In the portal: **Certificates, Identifiers & Profiles → Identifiers → +** and choose **Pass Type IDs**. Use an identifier like `pass.com.yourshop.loyalty`.
3. Make a private key and signing request, then upload the request on the Pass Type ID page and download the certificate:

   ```
   openssl req -new -newkey rsa:2048 -nodes -keyout pass.key -out pass.csr
   openssl x509 -inform DER -in pass.cer -out pass.pem
   ```

4. From apple.com/certificateauthority download the **Worldwide Developer Relations** intermediate certificate that matches your certificate (currently G4) and convert it:

   ```
   openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem
   ```

Keep `pass.key`, `pass.pem` and `wwdr.pem` out of git (the `.gitignore` already excludes key and certificate files). The certificate lasts about a year; the server logs a warning 30 days before it expires, and an error once it has, because expired passes stop updating.

## Set up

```
npm install
cp .env.example .env      # then fill it in
npm run db:migrate
```

Fill in `.env` (every variable is explained in `.env.example`). The ones that matter first:

- `DATABASE_URL`: a PostgreSQL database created with `ENCODING 'UTF8'`.
- `PUBLIC_BASE_URL`: the HTTPS address phones use. It is written into every pass, so a card keeps working only while this address does. A new tunnel address means new test cards.
- `PASS_TYPE_ID`, `APPLE_TEAM_ID`, `PASS_CERT_PATH`, `PASS_KEY_PATH`, `WWDR_CERT_PATH`: from the Apple steps above.
- `PIN_PEPPER`, `SESSION_SECRET`: long random strings. Changing `PIN_PEPPER` later invalidates every barista PIN.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`: creates the owner account the first time the server starts.
- `DEFAULT_PHONE_REGION=EG`: numbers typed without a country code are read as Egyptian.

## Run

```
npm run dev          # builds the staff page and starts the server with reload
npm start            # the same without reload
```

Then sign in to `/admin/` with the owner account, add a barista, and open `/join/` on an iPhone.

To try it on a real phone while developing:

```
cloudflared tunnel --url http://localhost:3000
```

Put the printed `https://….trycloudflare.com` address in `PUBLIC_BASE_URL` and restart.

To add a barista without the dashboard: `npm run barista:add -- "Sara" 123456`.

## Test

```
npm test             # all tests; starts its own throwaway PostgreSQL, no credentials needed
npm run typecheck
npm run lint
```

The tests build real signed passes with throwaway certificates (`npm run certs:test` makes them) and check the manifest hashes and signature. To use your own database instead of the built-in one, set `TEST_DATABASE_URL`.

A passing test run does not prove a card works on an iPhone. Before calling the feature done, add a card on a real iPhone with the real certificate, then check that a stamp and a redeemed drink both show up on the card.

## How a stamp reaches the phone

1. The barista scans the card; the server adds a cup in one transaction and writes a permanent record.
2. The server sends an empty push to Apple for each phone that has the card.
3. The phone asks the server which cards changed, downloads the new signed pass, and Wallet shows it.

The cup count lives only in the database. The QR code carries only a random card code, never the count.

## API

Staff and admin calls use an HTTP-only session cookie set by the matching login call. Apple's own pass web service lives under `/v1/` and uses the pass's token instead.

| Who | Call | What it does |
|---|---|---|
| Customer | `POST /api/join` with `{ "phone" }` | Creates the customer and card, returns `passUrl`. `409` if the number already has a card. |
| Customer | `GET /card/{serial}.pkpass` | Downloads the signed pass for Wallet. |
| Barista | `POST /api/staff/login` with `{ "pin" }` | Signs in with the barista's own 6-digit PIN. |
| Barista | `GET /api/staff/cards/{serial}` | Looks up a card by the scanned or typed code. |
| Barista | `POST /api/staff/cards/{serial}/stamp` | Adds one cup. Takes an `idempotencyKey` so a retry never double-counts, and `force` to confirm a stamp inside the 90-second cooldown. |
| Barista | `POST /api/staff/cards/{serial}/redeem` | Redeems an earned free drink and resets the card to 0. |
| Barista | `POST /api/staff/cards/{serial}/undo` | Undoes the most recent stamp. |
| Owner | `POST /api/admin/login` | Signs in with the owner's username and password. |
| Owner | `GET` / `PUT /api/admin/settings` | Reads or changes the reward goal (any whole number of 1 or more). |
| Owner | `GET` / `POST /api/admin/baristas`, `PATCH` / `DELETE /api/admin/baristas/{id}` | Manages baristas and their PINs. |
| Owner | `GET` / `POST /api/admin/announcements` | Reads or sends an announcement that appears on every card. |
| Owner | `GET /api/admin/customers?phone=` | Finds a customer by phone number. |
| Owner | `POST /api/admin/customers/{id}/reissue` | Issues a replacement card; the old QR code stops working. |
| Owner | `GET /api/admin/ledger` | Reads the permanent record of stamps, redemptions, undos and goal changes. |

A refused stamp or redeem returns `409` with a `reason` (`redeem_first`, `cooldown` or `not_earned`) and a plain-language `message`.

## Layout

```
src/domain/    the loyalty rules (cardRules.ts is pure) and the services that run them in transactions
src/wallet/    building and signing passes, the stamp-strip picture, the push to Apple, certificate expiry
src/routes/    customer sign-up, Apple's web service, staff, admin
src/auth/      PIN and password hashing, cookie sessions
src/db/        migrations and the migration runner
web/           the three pages: join, staff, admin
tests/         unit, contract and integration tests
```

## Known gaps

- Customers cannot be deleted on request, and sign-up has no separate consent box (signing up counts as agreeing to announcements). Check the privacy rules where the shop operates before launch.
- Phone numbers are checked for format but not verified with a code.
- The card pictures are placeholders (`assets/pass/`) until the shop's logo is supplied.
- Only Apple Wallet is supported.
