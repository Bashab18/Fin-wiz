# DigiFinWiz — Financial Literacy App

A simulated banking app for financial literacy education. Participants manage virtual accounts, make transfers/purchases/bill payments, complete challenges, and level up.

## Quick Start

```bash
npm install
node server.js
# Open http://localhost:3000
```

## Default Admin Login

- **Username:** admin  
- **Password:** Admin1234

That default is public (it is in this file), so change it on anything shared or deployed. Set the `ADMIN_PASSWORD` environment variable before the first start to seed the admin accounts with a different password. It only applies when an admin account is *created*; an account that already exists keeps its password, so change that one from the Profile page after signing in. While any admin account still uses the default, the server logs a `SECURITY:` warning at every start.

## How It Works

1. Open `login.html` → log in as admin → lands on `admin.html`
2. Go to **Users** tab in admin sidebar to approve registrations
3. Participants register via `register.html` → admin approves → they log in → land on `index.html`
4. Each participant has isolated balances, XP, transactions, and challenges
5. Logout button appears in the navbar on every protected page

## Architecture

### Backend — Express server (`server.js`)
- Serves all static files from the project root
- Persists every store (users, transactions, payments, purchases, challenges, messages, cart, bills, …) through `readJSON(name)` / `writeJSON(name, data)`; see **Storage** below
- Auth via request headers: `X-User-Id` and `X-User-Role` (set by client from session)
- 100+ REST endpoints under `/api/`; an unknown `/api/...` path answers a JSON `404`
- `GET /api/health` reports `{ ok, backend }`, and `503` while the database cannot be reached

### Client DB layer (`db.js`)
- Fetch-based API client with the same public interface as the previous IndexedDB version
- Reads session from `bkr_session` in sessionStorage/localStorage
- Attaches user headers to every request automatically

### Storage

| Mode | When | Where the data lives |
|---|---|---|
| **PostgreSQL** | `DATABASE_URL` is set (production) | One JSONB row per store in the `app_store` table (`name`, `data`), created on boot |
| **JSON files** | `DATABASE_URL` is not set (local development) | `data/<store>.json`, created on first start |

With `DATABASE_URL` set, PostgreSQL is the **only** store. The server never falls back to the local files (a hosted disk is wiped on every restart, so accounts would seem to vanish and new writes would be thrown away):

- a failed query is retried a few times (dropped connections are routine), then the request fails with `503 Storage is temporarily unavailable` and nothing is half-saved;
- the app recovers on its own when the database returns — no restart needed;
- at boot the server retries the connection `DB_BOOT_ATTEMPTS` times and then exits, so a bad deploy shows up as a failed deploy instead of serving an empty app.

Writes rewrite a whole store, so every mutating route runs inside one application-wide lock (`withUserLock`, re-entrant) to stop two simultaneous requests from overwriting each other.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port to listen on | `3000` |
| `DATABASE_URL` | PostgreSQL connection string; turns on database storage | unset (JSON files) |
| `ADMIN_PASSWORD` | Password for the seeded `admin` accounts (only when first created) | `Admin1234` |
| `ALLOWED_ORIGIN` | CORS origin of a separately hosted frontend | `*` |
| `DB_BOOT_ATTEMPTS` | Connection attempts at boot before the server exits | `5` |
| `DB_BOOT_DELAY_MS` | Base wait between those attempts (grows with each attempt) | `2000` |

### Stores

Main site: `users`, `transactions`, `payments`, `purchases`, `challenges`, `messages`, `cart`, `bills` (seeded with 6 defaults), `products`, plus one store per feature (credit cards, loans, savings goals, scheduled transfers, addresses, payment methods, bill cycles, custom bills, autopay preferences).

Banking, E-Commerce and Utilities are standalone apps with their own accounts: each keeps its own copy of the per-user stores under a prefix (`bankingUsers`, `ecommerceCart`, `utilitiesPayments`, …), chosen by the `X-App` request header. Only `banking`, `ecommerce` and `utilities` are accepted; any other value is a `400`.

The full list with record counts is under **Admin → Settings → Database Info**.

## Admin Panel Features

- **Users** — approve/reject registrations, view balances and XP
- **Transactions** — view all transfer activity
- **Purchases** — view store purchase history
- **Payments** — view bill payment history
- **Challenges** — view challenge completion status per user
- **Messages** — broadcast messages to participants
- **Bills** — create, edit, and delete bill types shown on the Utilities page

## Bills Management

Bills are stored server-side in the `bills` store and seeded with 6 defaults on first boot (Electricity, Water, Internet, Property Tax, Phone, Gas).

Admins can manage bills via the **Bills** tab in the admin panel:
- Add a new bill (name, icon, amount, account number, gradient colour, due date)
- Edit any existing bill
- Delete a bill

The Utilities page fetches `/api/bills` on load and renders bill cards dynamically.

## API Reference (key endpoints)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Login |
| POST | `/api/auth/register` | — | Register |
| GET | `/api/me` | user | Current user profile |
| GET | `/api/me/transactions` | user | Transaction history |
| POST | `/api/transfer` | user | Make a transfer |
| POST | `/api/purchase` | user | Buy from store |
| POST | `/api/pay-bill` | user | Pay a bill |
| GET | `/api/bills` | — | List active bills |
| POST | `/api/bills` | admin | Create a bill |
| PUT | `/api/bills/:id` | admin | Update a bill |
| DELETE | `/api/bills/:id` | admin | Delete a bill |
| GET | `/api/admin/users` | admin | List all users |
| PUT | `/api/admin/users/:id/approve` | admin | Approve registration |

## GitHub

[https://github.com/Bashab18/digifinwiz](https://github.com/Bashab18/digifinwiz)
