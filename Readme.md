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

- a failed query is retried a few times (dropped connections are routine), then the request fails with `503 Storage is temporarily unavailable`. A request's writes are saved together in one transaction, so a `503` (or any error part-way through a request) saves nothing and the client can simply try again;
- if the database hangs instead of refusing, requests answer `503` straight away for a few seconds rather than each waiting out its own timeout;
- the app recovers on its own when the database returns — no restart needed;
- at boot the server retries the connection `DB_BOOT_ATTEMPTS` times and then exits, so a bad deploy shows up as a failed deploy instead of serving an empty app;
- a hosted deploy (`RENDER` or `NODE_ENV=production`) with no `DATABASE_URL` refuses to start; set `ALLOW_LOCAL_DATA=1` to run on local files there anyway;
- if the `app_store` table disappears while the app is running, the server exits so the next boot recreates and seeds it, instead of carrying on as an empty app.

Writes rewrite a whole store, so every mutating route runs inside one application-wide lock (`withUserLock`, re-entrant) to stop two simultaneous requests from overwriting each other. Each locked section commits all of its writes in a single transaction, or none of them if it fails.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Port to listen on | `3000` |
| `DATABASE_URL` | PostgreSQL connection string; turns on database storage | unset (JSON files) |
| `ADMIN_PASSWORD` | Password for the seeded `admin` accounts (only when first created) | `Admin1234` |
| `ALLOWED_ORIGIN` | CORS origin of a separately hosted frontend | `*` |
| `DB_BOOT_ATTEMPTS` | Connection attempts at boot before the server exits | `5` |
| `DB_BOOT_DELAY_MS` | Base wait between those attempts (grows with each attempt) | `2000` |
| `ALLOW_LOCAL_DATA` | Set to `1` to let a hosted deploy run on local files when `DATABASE_URL` is missing | unset |

### Stores

Main site: `users`, `transactions`, `payments`, `purchases`, `challenges`, `messages`, `cart`, `bills` (seeded with 6 defaults), `products`, plus one store per feature (credit cards, loans, savings goals, scheduled transfers, addresses, payment methods, bill cycles, custom bills, autopay preferences).

Banking, E-Commerce and Utilities are standalone apps with their own accounts: each keeps its own copy of the per-user stores under a prefix (`bankingUsers`, `ecommerceCart`, `utilitiesPayments`, …), chosen by the `X-App` request header. Only `banking`, `ecommerce` and `utilities` are accepted; any other value is a `400`.

The full list with record counts is under **Admin → Settings → Database Info**.

### Main Site and the three sub-sites

Banking, E-Commerce and Utilities keep their own accounts, so what someone does there never touches their main-site account. A main-site account is **linked** to a sub-site account when the two share an email or a username (case-insensitive; an email match outranks a username match). Nothing is copied between them: the Main Site reads the linked accounts' own records, read-only, through `GET /api/me/hub` (main-site accounts only).

- **Profile** — Information (DigiBank cards, Utilities bills, Ecommerce purchases, activity from every site), Account Balances (the total across all sites plus a per-site breakdown) and Progress (skills, badges, health score) follow the linked accounts. The main account's own older records are kept in the counts, lists and spend totals; only its own starting wallet is left out of the balance total. If the sub-site data cannot be loaded the page says so and offers to retry.
- **Home** — Recent Activity merges every site's events, each tagged with its site, next to the combined progress.
- **Challenges** — the main-site copy of a sub-site challenge shows as done when the linked sub-site account has completed the same-titled one (display only; the XP stays on the sub-site account). The Level 1 requirements, progress bars and badges follow the sub-sites.
- **Messages** — the linked accounts' messages and alerts appear in the main inbox, named by site, and can be marked read there.
- **Admin** — the Users page lists every sub-site account and the main-site account it belongs to, and a message can be delivered to the main site and the sub-sites together (**Deliver To**). *Add Missing Default Challenges* also covers the sub-sites.

With no linked sub-site account these pages show the main account's own records, as before.

A one-time migration at boot (recorded in `app_store` under `_migrations`) brought existing accounts in line with the default challenge list. It adds "Video Learner" only to accounts created before that challenge existed (before 2026-09-17), and refreshes the "Bank Explorer" description only where it still has the exact old text. A missing "Video Learner" on a later account means someone deleted it, so it stays deleted, and an admin's own edits are never touched.

## Admin Panel Features

- **Users** — approve/reject registrations, view balances and XP
- **Transactions** — view all transfer activity
- **Purchases** — view store purchase history
- **Payments** — view bill payment history
- **Challenges** — create, edit and delete challenges, and view completion status per user. A new challenge goes to every approved participant who doesn't already have it, or to one person chosen under **Assign to**. A user's **Challenges** tab (Users → Manage) can also give them any challenge someone still has that they don't, or take one away from them alone. A challenge exists only as its holders' copies, so removing the last copy deletes it. A participant's own *Reset Challenges* (Profile) restores the default set and drops any that were assigned.
- **Messages** — broadcast messages to participants
- **Bills** — create, edit, and delete bill types shown on the Utilities page, for every DigiPay account or for one chosen account (**Assign to**)

## Bills Management

Bills are stored server-side in the `bills` store and seeded with 6 defaults on first boot (Electricity, Water, Internet, Property Tax, Phone, Gas).

Admins can manage bills via the **Bills** tab in the admin panel:
- Add a new bill (name, icon, amount, account number, gradient colour, due date)
- Edit any existing bill
- Delete a bill
- Assign a bill to one DigiPay account: only that account is issued it each month (the default, **Everyone**, issues it to every account). Changing the assignment never touches bills already issued, and nobody is issued a bill for months before the change (putting a bill back to **Everyone** bills the others from that month on, not for the months it was one account's). Deleting a DigiPay account deletes the bills assigned to it.

Each DigiPay account is issued its bills from this list when it opens its bills (`GET /api/me/bills`); the admin **Bills** tab is the only page that reads `/api/bills` itself.

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
| GET | `/api/bills` | — | List active bills (a bill assigned to one account is listed to admins only) |
| POST | `/api/bills` | admin | Create a bill |
| PUT | `/api/bills/:id` | admin | Update a bill |
| DELETE | `/api/bills/:id` | admin | Delete a bill |
| GET | `/api/admin/users` | admin | List all users |
| PUT | `/api/admin/users/:id/approve` | admin | Approve registration |

## GitHub

[https://github.com/Bashab18/digifinwiz](https://github.com/Bashab18/digifinwiz)
