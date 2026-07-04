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

## How It Works

1. Open `login.html` → log in as admin → lands on `admin.html`
2. Go to **Users** tab in admin sidebar to approve registrations
3. Participants register via `register.html` → admin approves → they log in → land on `index.html`
4. Each participant has isolated balances, XP, transactions, and challenges
5. Logout button appears in the navbar on every protected page

## Architecture

### Backend — Express server (`server.js`)
- Serves all static files from the project root
- All data persisted to `data/*.json` files (users, transactions, payments, purchases, challenges, messages, cart, bills)
- Auth via request headers: `X-User-Id` and `X-User-Role` (set by client from session)
- 44+ REST endpoints under `/api/`

### Client DB layer (`db.js`)
- Fetch-based API client with the same public interface as the previous IndexedDB version
- Reads session from `bkr_session` in sessionStorage/localStorage
- Attaches user headers to every request automatically

### Data files (`data/`)
| File | Contents |
|---|---|
| `users.json` | All registered users |
| `transactions.json` | Transfer history |
| `payments.json` | Bill payment history |
| `purchases.json` | Store purchase history |
| `challenges.json` | Per-user challenge progress |
| `messages.json` | Admin broadcast messages |
| `cart.json` | Shopping cart state |
| `bills.json` | Bill types (seeded with 6 defaults) |

## Admin Panel Features

- **Users** — approve/reject registrations, view balances and XP
- **Transactions** — view all transfer activity
- **Purchases** — view store purchase history
- **Payments** — view bill payment history
- **Challenges** — view challenge completion status per user
- **Messages** — broadcast messages to participants
- **Bills** — create, edit, and delete bill types shown on the Utilities page

## Bills Management

Bills are stored server-side in `data/bills.json` and seeded with 6 defaults on first boot (Electricity, Water, Internet, Property Tax, Phone, Gas).

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
