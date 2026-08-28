'use strict';

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const { Pool } = require('pg');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// Origin of the static frontend when it's hosted separately (e.g. on Netlify)
// from this API (e.g. on Render). '*' is fine here since auth uses custom
// headers rather than cookies, so no credentials are ever sent cross-origin.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── Storage backend ────────────────────────────────────────────────────────────
// If DATABASE_URL is set (e.g. a Render Postgres instance), every named
// "store" (users, transactions, ...) is persisted as one row of JSONB in a
// real database — durable across redeploys/restarts. Otherwise this falls
// back to the original flat JSON files under data/, so local development
// needs no database setup at all. Both paths expose the exact same
// readJSON(name) / writeJSON(name, data) contract the rest of this file uses.
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL
    ? new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        // Without this, an unreachable database (expired free-tier instance,
        // network partition, etc.) hangs the connection attempt forever —
        // and since initStorage() awaits it before app.listen(), the whole
        // server never comes up. Fail fast instead so boot can fall back.
        connectionTimeoutMillis: 8000
    })
    : null;
// True once Postgres is confirmed reachable; flipped false (permanently
// falling back to local JSON files) if it never connects or later errors out.
let dbUsable = !!pool;

if (pool) {
    pool.on('error', err => {
        console.error('DigifinwizDB: unexpected Postgres pool error, falling back to local JSON files:', err.message);
        dbUsable = false;
    });
}

function ensureLocalDataFiles() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    STORE_NAMES.forEach(name => {
        const fp = path.join(DATA_DIR, name + '.json');
        if (!fs.existsSync(fp)) fs.writeFileSync(fp, '[]', 'utf8');
    });
}

const STORE_NAMES = [
    'users', 'transactions', 'payments', 'purchases', 'challenges', 'messages', 'cart', 'bills',
    'creditCards', 'creditActivity', 'loans', 'loanPayments', 'savingsGoals', 'savingsGoalActivity',
    'scheduledTransfers', 'products', 'addresses', 'paymentMethods', 'billCycles', 'customBills',
    // Standalone per-module accounts (Banking/E-Commerce/Utilities each fully separate from the
    // shared 'users'/'challenges'/'messages' stores above — see the X-App middleware below).
    'bankingUsers', 'ecommerceUsers', 'utilitiesUsers',
    'bankingChallenges', 'ecommerceChallenges', 'utilitiesChallenges',
    'bankingMessages', 'ecommerceMessages', 'utilitiesMessages'
];

async function initStorage() {
    if (pool) {
        try {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS app_store (
                    name TEXT PRIMARY KEY,
                    data JSONB NOT NULL DEFAULT '[]'::jsonb
                )
            `);
            dbUsable = true;
            console.log('DigifinwizDB: connected to Postgres.');
            return;
        } catch (err) {
            dbUsable = false;
            console.error('DigifinwizDB: Postgres unreachable at boot, falling back to local JSON files:', err.message);
        }
    }
    // Local JSON-file fallback — ensure data directory + files exist.
    ensureLocalDataFiles();
    if (!pool) console.log('DigifinwizDB: no DATABASE_URL set — using local JSON files in data/.');
}

async function readJSON(name) {
    if (pool && dbUsable) {
        try {
            const { rows } = await pool.query('SELECT data FROM app_store WHERE name = $1', [name]);
            return rows.length ? rows[0].data : [];
        } catch (err) {
            dbUsable = false;
            ensureLocalDataFiles();
            console.error('DigifinwizDB: Postgres read failed, falling back to local JSON files:', err.message);
        }
    }
    try {
        const raw = fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return [];
    }
}

async function writeJSON(name, data) {
    if (pool && dbUsable) {
        try {
            await pool.query(
                `INSERT INTO app_store (name, data) VALUES ($1, $2::jsonb)
                 ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data`,
                [name, JSON.stringify(data)]
            );
            return;
        } catch (err) {
            dbUsable = false;
            ensureLocalDataFiles();
            console.error('DigifinwizDB: Postgres write failed, falling back to local JSON files:', err.message);
        }
    }
    fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2), 'utf8');
}

function nextId(arr) {
    if (!arr || arr.length === 0) return 1;
    return Math.max(...arr.map(r => r.id || 0)) + 1;
}

// Serializes all money-mutating work application-wide (not just per user).
// The JSON-file stores (users, products, purchases, ...) are shared arrays
// that get fully read, mutated, and rewritten on every request — a per-user
// lock alone still lets two DIFFERENT users' requests interleave on the same
// shared array (e.g. both read stock 1, both pass the check, both decrement
// it) and lose one write. A single global chain makes every withUserLock
// call run one at a time, which is the only way to guarantee no lost writes
// against a full-array-rewrite store without a real database transaction.
let globalLock = Promise.resolve();
function withUserLock(userId, fn) {
    const next = globalLock.then(fn, fn);
    globalLock = next;
    return next;
}

// ── Password hashing (prototype-level djb2 XOR, not cryptographic) ────────────
function simpleHash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

// ── Default data shapes ───────────────────────────────────────────────────────
const DEFAULT_BALANCES     = { checking: 88674.00, savings: 18074.00 };
const DEFAULT_USER_DATA    = { level: 1, points: 0, pointsToNextLevel: 1000, challenges: 0, completedTasks: 0, coins: 0 };
const DEFAULT_ALERT_PREFS  = { lowBalanceEnabled: true, lowBalanceThreshold: 100, largeTxEnabled: true, largeTxThreshold: 1000 };

// ── E-Commerce: US sales tax, shipping, and promo tables ───────────────────
// Approximate combined state+average-local sales tax rates. Sales tax in the
// US is charged based on the delivery address, not the seller's location, so
// checkout looks this up by the shipping address's state. States with no
// sales tax (e.g. OR, NH, MT, DE, AK) are 0. Not official rates — good enough
// for a financial-literacy simulation, not a tax filing.
const STATE_TAX_RATES = {
    AL: 0.0922, AK: 0.0176, AZ: 0.0840, AR: 0.0946, CA: 0.0872, CO: 0.0777, CT: 0.0635,
    DE: 0,      FL: 0.0705, GA: 0.0732, HI: 0.0444, ID: 0.0603, IL: 0.0886, IN: 0.0700,
    IA: 0.0694, KS: 0.0869, KY: 0.0600, LA: 0.0955, ME: 0.0550, MD: 0.0600, MA: 0.0625,
    MI: 0.0600, MN: 0.0778, MS: 0.0707, MO: 0.0839, MT: 0,      NE: 0.0694, NV: 0.0823,
    NH: 0,      NJ: 0.0663, NM: 0.0768, NY: 0.0852, NC: 0.0699, ND: 0.0696, OH: 0.0723,
    OK: 0.0895, OR: 0,      PA: 0.0634, RI: 0.0700, SC: 0.0746, SD: 0.0640, TN: 0.0955,
    TX: 0.0820, UT: 0.0719, VT: 0.0622, VA: 0.0575, WA: 0.0923, WV: 0.0655, WI: 0.0543,
    WY: 0.0533, DC: 0.0600
};

const SHIPPING_RATES = {
    standard: { label: 'Standard (5-7 business days)', cost: 5.99, days: 6, freeThreshold: 75 },
    express:  { label: 'Express (2 business days)',    cost: 14.99, days: 2, freeThreshold: null }
};

const PROMO_CODES = {
    SAVE10:  { type: 'pct',  value: 10, label: '10% off' },
    SAVE20:  { type: 'pct',  value: 20, label: '20% off' },
    WELCOME: { type: 'flat', value: 15, label: 'ƒ15 off' },
    STUDENT: { type: 'pct',  value: 5,  label: '5% student discount' }
};

function computePromoDiscount(code, subtotal) {
    const promo = PROMO_CODES[String(code || '').toUpperCase()];
    if (!promo) return { code: null, label: null, discount: 0 };
    const discount = promo.type === 'pct' ? subtotal * (promo.value / 100) : Math.min(promo.value, subtotal);
    return { code: String(code).toUpperCase(), label: promo.label, discount: parseFloat(discount.toFixed(2)) };
}

// Orders have no real fulfillment backend, so status is derived purely from
// elapsed time since the order was placed (computed fresh on every read,
// same idea the old client-side-only tracking page used, just centralized
// here so every page — order history, tracking, dashboard — agrees).
function computeOrderStatus(order) {
    const shipInfo   = SHIPPING_RATES[order.shippingMethod] || SHIPPING_RATES.standard;
    const totalMs     = shipInfo.days * 24 * 60 * 60 * 1000;
    const elapsed       = Date.now() - (order.timestamp || 0);
    const processingMs   = 60 * 60 * 1000; // 1 hour
    const outForDeliveryMs = Math.max(processingMs, totalMs - 12 * 60 * 60 * 1000);

    let status, statusLabel;
    if (elapsed < processingMs) { status = 'processing'; statusLabel = 'Processing'; }
    else if (elapsed < outForDeliveryMs) { status = 'shipped'; statusLabel = 'Shipped'; }
    else if (elapsed < totalMs) { status = 'out_for_delivery'; statusLabel = 'Out for Delivery'; }
    else { status = 'delivered'; statusLabel = 'Delivered'; }

    return {
        status, statusLabel,
        estimatedDelivery: (order.timestamp || 0) + totalMs,
        // "done" means this stage has been passed, not that it's the current
        // one — e.g. the Processing step reads done once the order has moved
        // on to Shipped. The always-true "Order Placed" step is added by the
        // client in front of this list, since placing the order is instant.
        trackingSteps: [
            { key: 'processing',       label: 'Processing',       done: elapsed >= processingMs },
            { key: 'shipped',          label: 'Shipped',          done: elapsed >= outForDeliveryMs },
            { key: 'out_for_delivery', label: 'Out for Delivery', done: elapsed >= totalMs },
            { key: 'delivered',        label: 'Delivered',        done: elapsed >= totalMs }
        ]
    };
}

// Shared entry point for every system-generated Messages-inbox notification
// (balance alerts, scheduled-transfer results, credit/loan/goal milestones,
// bill overdue notices, order status changes, security notices). `category`
// drives the per-module unread badges in the sidebar nav.
async function pushSystemMessage(userId, { subject, body, type, category }, messageStore = 'messages') {
    const messages = await readJSON(messageStore);
    const msg = {
        id: nextId(messages), senderId: 0, senderName: 'System', senderEmail: null,
        recipientId: userId, subject, body, type: type || 'info', category: category || 'system',
        sentAt: Date.now(), readBy: []
    };
    messages.push(msg);
    await writeJSON(messageStore, messages);
    return msg;
}

// Pushes a system message into the user's own Messages inbox when a balance
// change crosses one of their configured alert thresholds. Called from
// every balance-changing route (transfers, bill pay, checkout, and the
// credit card / loan / savings-goal features), so alerts fire consistently
// no matter which feature moved the money. `category` tags which module
// the triggering action belongs to, for the sidebar unread badges.
async function maybeFireBalanceAlerts(user, account, current, next, delta, category, messageStore = 'messages') {
    const prefs  = Object.assign({}, DEFAULT_ALERT_PREFS, (user.userData || {}).alertPrefs || {});
    const alerts = [];

    // Edge-triggered (current was above the threshold, next isn't) so a
    // balance that's already low doesn't re-alert on every subsequent debit.
    if (prefs.lowBalanceEnabled && delta < 0 && current > prefs.lowBalanceThreshold && next <= prefs.lowBalanceThreshold) {
        alerts.push({
            subject: 'Low balance alert',
            body: 'Your ' + account + ' account dropped to ƒ' + next.toFixed(2) + ', at or below your ' +
                  'ƒ' + Number(prefs.lowBalanceThreshold).toFixed(2) + ' low-balance alert threshold.',
            type: 'warning'
        });
    }
    if (prefs.largeTxEnabled && Math.abs(delta) >= prefs.largeTxThreshold) {
        alerts.push({
            subject: 'Large transaction alert',
            body: 'A ' + (delta < 0 ? 'debit' : 'credit') + ' of ƒ' + Math.abs(delta).toFixed(2) +
                  ' hit your ' + account + ' account (alert threshold: ƒ' + Number(prefs.largeTxThreshold).toFixed(2) + ').',
            type: 'warning'
        });
    }
    if (alerts.length === 0) return;

    const messages = await readJSON(messageStore);
    const now = Date.now();
    let id = nextId(messages);
    alerts.forEach(a => {
        messages.push({
            id: id++,
            senderId: 0,
            senderName: 'System',
            senderEmail: null,
            recipientId: user.id,
            subject: a.subject,
            body: a.body,
            type: a.type,
            category: category || 'system',
            sentAt: now,
            readBy: []
        });
    });
    await writeJSON(messageStore, messages);
}

// ── Scheduled / recurring transfers ─────────────────────────────────────────
function advanceScheduleDate(current, frequency) {
    const d = new Date(current);
    if (frequency === 'weekly')        d.setDate(d.getDate() + 7);
    else if (frequency === 'biweekly') d.setDate(d.getDate() + 14);
    else if (frequency === 'monthly')  d.setMonth(d.getMonth() + 1);
    return d.getTime();
}

// Executes a single due occurrence of one scheduled transfer, inside the same
// per-user lock every other money-moving route uses. Re-reads fresh state
// under the lock (rather than trusting the caller's snapshot) since another
// occurrence of the same or a different schedule may have just run.
async function executeOneScheduledTransfer(userId, scheduleId, userStore = 'users', messageStore = 'messages') {
    await withUserLock(userId, async () => {
        const schedules = await readJSON('scheduledTransfers');
        const idx = schedules.findIndex(x => x.id === scheduleId);
        if (idx === -1 || !schedules[idx].active) return;
        const sched = schedules[idx];
        if ((sched.nextRunDate || 0) > Date.now()) return;

        const users = await readJSON(userStore);
        const uidx  = users.findIndex(u => u.id === userId);
        if (uidx === -1) return;
        const balances = Object.assign({}, DEFAULT_BALANCES, users[uidx].balances || {});
        const current   = balances[sched.fromAccount] !== undefined ? balances[sched.fromAccount] : 0;
        const next       = parseFloat((current - sched.amount).toFixed(2));
        const isOneTime  = sched.frequency === 'once';

        if (next < 0) {
            // Insufficient funds: skip this occurrence, notify, and try again
            // next period (a one-time transfer just deactivates instead).
            await pushSystemMessage(userId, {
                subject: 'Scheduled transfer skipped',
                body: 'Your scheduled transfer of ƒ' + sched.amount.toFixed(2) + ' to ' + sched.recipient +
                      ' could not be completed — insufficient funds in ' + sched.fromAccount + '.',
                type: 'warning', category: 'banking'
            }, messageStore);

            schedules[idx] = Object.assign({}, sched, {
                active:       !isOneTime,
                nextRunDate:  isOneTime ? sched.nextRunDate : advanceScheduleDate(sched.nextRunDate, sched.frequency),
                lastRunAt:    Date.now(),
                lastRunStatus:'skipped'
            });
            await writeJSON('scheduledTransfers', schedules);
            return;
        }

        balances[sched.fromAccount] = next;
        const updatedUser = Object.assign({}, users[uidx], { balances });
        users[uidx] = updatedUser;
        await writeJSON(userStore, users);
        await maybeFireBalanceAlerts(updatedUser, sched.fromAccount, current, next, -sched.amount, 'banking', messageStore);
        await pushSystemMessage(userId, {
            subject: 'Scheduled transfer completed',
            body: 'Your scheduled transfer of ƒ' + sched.amount.toFixed(2) + ' to ' + sched.recipient +
                  ' was completed from your ' + sched.fromAccount + ' account.',
            type: 'success', category: 'banking'
        }, messageStore);

        const txs = await readJSON('transactions');
        txs.push({
            id: nextId(txs), userId, type: 'transfer', recipient: sched.recipient, account: sched.account,
            fromAccount: sched.fromAccount, amount: sched.amount,
            description: (sched.description ? sched.description + ' ' : '') + '(scheduled)',
            date: new Date().toLocaleDateString(), timestamp: Date.now(), pointsEarned: 0
        });
        await writeJSON('transactions', txs);

        schedules[idx] = Object.assign({}, sched, {
            active:        !isOneTime,
            nextRunDate:   isOneTime ? sched.nextRunDate : advanceScheduleDate(sched.nextRunDate, sched.frequency),
            lastRunAt:     Date.now(),
            lastRunStatus: 'completed'
        });
        await writeJSON('scheduledTransfers', schedules);
    });
}

// Catches a user's scheduled transfers up to "now", running as many overdue
// occurrences as needed (e.g. if the app wasn't opened for a while). Called
// from every route that reads the user's balance or schedule list — so a
// schedule executes the moment the user is looking at their account, whether
// or not the server process happened to be running at the exact scheduled
// moment — plus from a periodic sweep (below) while the server is up.
async function runDueScheduledTransfers(userId, userStore = 'users', messageStore = 'messages') {
    const schedules = await readJSON('scheduledTransfers');
    const mine = schedules.filter(s => s.userId === userId && s.active);
    for (const s of mine) {
        let guard = 0; // hard cap so a bad schedule can't loop forever
        while (guard++ < 24) {
            const fresh = (await readJSON('scheduledTransfers')).find(x => x.id === s.id);
            if (!fresh || !fresh.active || (fresh.nextRunDate || 0) > Date.now()) break;
            await executeOneScheduledTransfer(userId, s.id, userStore, messageStore);
        }
    }
}

// ── Challenge definitions ─────────────────────────────────────────────────────
const ALL_DEFAULT_CHALLENGES = [
    { title: 'First Transfer',      description: 'Make your first bank transfer to any recipient.',                   category: 'banking',   points: 50,  florins: 0,    condition: 'first_transfer',    conditionValue: 1,     active: true },
    { title: 'Big Spender',         description: 'Transfer \u0192500 or more in a single transaction.',               category: 'banking',   points: 100, florins: 500,  condition: 'transfer_amount',   conditionValue: 500,   active: true },
    { title: 'Transfer Trio',       description: 'Complete 3 bank transfers in total.',                               category: 'banking',   points: 60,  florins: 0,    condition: 'transaction_count', conditionValue: 3,     active: true },
    { title: 'Transfer Veteran',    description: 'Complete 10 bank transfers total.',                                 category: 'banking',   points: 120, florins: 0,    condition: 'transaction_count', conditionValue: 10,    active: true },
    { title: 'Money Mover',         description: 'Transfer a cumulative total of \u01921,000 or more.',               category: 'banking',   points: 90,  florins: 0,    condition: 'total_transferred', conditionValue: 1000,  active: true },
    { title: 'Generous Sender',     description: 'Transfer a single amount of \u01921,000 or more.',                  category: 'banking',   points: 150, florins: 1000, condition: 'transfer_amount',   conditionValue: 1000,  active: true },
    { title: 'Bank Explorer',       description: 'Learn how banking works by reading the Information tab on your Profile page.',  category: 'banking',   points: 20,  florins: 0,    condition: 'manual',            conditionValue: 0,     active: true },
    { title: 'Shop Till You Drop',  description: 'Complete your first purchase in the ecommerce store.',              category: 'ecommerce', points: 50,  florins: 0,    condition: 'first_purchase',    conditionValue: 1,     active: true },
    { title: 'Savvy Shopper',       description: 'Buy 3 or more items in a single checkout.',                         category: 'ecommerce', points: 75,  florins: 0,    condition: 'purchase_items',    conditionValue: 3,     active: true },
    { title: 'Shopping Spree',      description: 'Buy 5 or more items in a single checkout.',                         category: 'ecommerce', points: 110, florins: 0,    condition: 'purchase_items',    conditionValue: 5,     active: true },
    { title: 'High Roller',         description: 'Spend over \u01925,000 in the ecommerce store.',                    category: 'ecommerce', points: 150, florins: 0,    condition: 'total_spent_ecom',  conditionValue: 5000,  active: true },
    { title: 'Retail Addict',       description: 'Spend over \u01921,000 in the ecommerce store.',                    category: 'ecommerce', points: 80,  florins: 0,    condition: 'total_spent_ecom',  conditionValue: 1000,  active: true },
    { title: 'Product Expert',      description: 'Browse all product categories in the ecommerce store.',             category: 'ecommerce', points: 25,  florins: 0,    condition: 'manual',            conditionValue: 0,     active: true },
    { title: 'Bill Payer',          description: 'Pay your first utility bill.',                                      category: 'utilities', points: 30,  florins: 0,    condition: 'first_payment',     conditionValue: 1,     active: true },
    { title: 'Power Saver',         description: 'Pay 2 utility bills in total.',                                     category: 'utilities', points: 45,  florins: 0,    condition: 'payment_count',     conditionValue: 2,     active: true },
    { title: 'Bill Marathon',       description: 'Pay 3 utility bills in total.',                                     category: 'utilities', points: 60,  florins: 0,    condition: 'payment_count',     conditionValue: 3,     active: true },
    { title: 'Utility Master',      description: 'Pay 5 utility bills in total.',                                     category: 'utilities', points: 80,  florins: 0,    condition: 'payment_count',     conditionValue: 5,     active: true },
    { title: 'Bill Expert',         description: 'Pay 10 utility bills in total.',                                    category: 'utilities', points: 130, florins: 0,    condition: 'payment_count',     conditionValue: 10,    active: true },
    { title: 'Organised Payer',     description: 'Read about all your bill types on the Utilities page.',             category: 'utilities', points: 20,  florins: 0,    condition: 'manual',            conditionValue: 0,     active: true },
    { title: 'Level Up!',           description: 'Reach level 2 by earning points through activities.',               category: 'general',   points: 40,  florins: 0,    condition: 'reach_level',       conditionValue: 2,     active: true },
    { title: 'Rising Star',         description: 'Reach level 5.',                                                    category: 'general',   points: 75,  florins: 0,    condition: 'reach_level',       conditionValue: 5,     active: true },
    { title: 'Financial Explorer',  description: 'Read the Information tab on your Profile page to learn about financial concepts.', category: 'general',   points: 30,  florins: 0,    condition: 'manual',            conditionValue: 0,     active: true },
    { title: 'Profile Complete',    description: 'Fill in your profile name and username in the Profile page.',       category: 'general',   points: 25,  florins: 0,    condition: 'manual',            conditionValue: 0,     active: true }
];
const LEVEL_1_REQUIRED_CONDITIONS = ['first_transfer', 'first_purchase', 'first_payment'];

// ── Startup: seed default admin ───────────────────────────────────────────────
async function seedDefaultAdmin() {
    const users    = await readJSON('users');
    const hasAdmin = users.some(u => u.role === 'admin');
    if (hasAdmin) return;
    const id = nextId(users);
    users.push({
        id,
        fullName:     'Administrator',
        username:     'admin',
        email:        'admin@digifinwiz.local',
        passwordHash: simpleHash('Admin1234'),
        role:         'admin',
        status:       'approved',
        createdAt:    Date.now(),
        approvedAt:   Date.now(),
        lastLogin:    null,
        userData:     Object.assign({}, DEFAULT_USER_DATA),
        balances:     Object.assign({}, DEFAULT_BALANCES)
    });
    await writeJSON('users', users);
    console.log('DigifinwizDB: default admin created (admin / Admin1234)');
}

// Seeds a default 'admin' login (admin / Admin1234) into one of the
// standalone module user stores. Unlike seedDefaultAdmin() above, this is
// just an ordinary account with that username/password — module accounts
// have no role/status/approval concept at all, so there's nothing
// privileged about it beyond being a memorable, pre-existing credential
// for each app.
async function seedDefaultModuleAdmin(userStore, challengeStore, category) {
    const users = await readJSON(userStore);
    if (users.some(u => u.username === 'admin')) return;
    const user = {
        id:           nextId(users),
        fullName:     'Administrator',
        username:     'admin',
        email:        'admin@digifinwiz.local',
        passwordHash: simpleHash('Admin1234'),
        createdAt:    Date.now(),
        lastLogin:    null,
        userData:     Object.assign({}, DEFAULT_USER_DATA),
        balances:     Object.assign({}, DEFAULT_BALANCES)
    };
    users.push(user);
    await writeJSON(userStore, users);
    await seedChallengesForUser(user.id, challengeStore, category);
    console.log('DigifinwizDB: default admin created for ' + userStore + ' (admin / Admin1234)');
}

// ── Challenge helpers ─────────────────────────────────────────────────────────
async function getChallengesForUser(userId, role, challengeStore = 'challenges') {
    const all      = await readJSON(challengeStore);
    let filtered   = role === 'participant' ? all.filter(c => c.userId === userId) : all;

    // Deduplicate by title
    const seen = new Map();
    filtered.forEach(c => {
        const key  = c.title || String(c.id);
        const prev = seen.get(key);
        if (!prev) {
            seen.set(key, c);
        } else if (c.completed && !prev.completed) {
            seen.set(key, c);
        } else if (!c.completed && prev.completed) {
            // keep prev (completed)
        } else {
            if ((c.id || 0) > (prev.id || 0)) seen.set(key, c);
        }
    });
    return Array.from(seen.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// category (optional): for a standalone module account, only that module's
// own challenges make sense — a Banking-only account has no way to ever
// browse the E-Commerce catalog or pay a utility bill, so seeding it the
// full cross-module set would leave 2/3 of its challenges permanently
// unreachable. 'general' (level-up, profile-complete) challenges are
// self-contained and included regardless of category, since they don't
// depend on activity in another module.
async function seedChallengesForUser(userId, challengeStore = 'challenges', category = null) {
    const challenges = await readJSON(challengeStore);
    const existing   = challenges.filter(c => c.userId === userId);
    if (existing.length > 0) return;
    const now = Date.now();
    let id    = nextId(challenges);
    const defs = category
        ? ALL_DEFAULT_CHALLENGES.filter(c => c.category === category || c.category === 'general')
        : ALL_DEFAULT_CHALLENGES;
    defs.forEach(c => {
        challenges.push(Object.assign({}, c, {
            id:        id++,
            userId:    userId,
            createdAt: now,
            active:    true,
            completed: false
        }));
    });
    await writeJSON(challengeStore, challenges);
}

// Context fields a "custom" condition is allowed to read — never eval
// arbitrary admin input, only compare a whitelisted field by name.
const CUSTOM_FIELD_WHITELIST = new Set([
    'txCount', 'payCount', 'purchCount', 'lastTxAmount', 'lastItemCount', 'lastPayAmount',
    'totalTransferred', 'totalSpentEcom', 'totalSpentBills', 'userLevel', 'totalXpEarned', 'florinBalance',
    'checkingBalance', 'savingsBalance', 'uniqueRecipients', 'savingsTransferCount'
]);

function compareOp(actual, operator, expected) {
    switch (operator) {
        case 'gt':  return actual >  expected;
        case 'eq':  return actual === expected;
        case 'lt':  return actual <  expected;
        case 'lte': return actual <= expected;
        case 'gte':
        default:    return actual >= expected;
    }
}

function evaluateCondition(cc, context) {
    const val = Number(cc.conditionValue) || 0;
    switch (cc.condition) {
        case 'first_transfer':    return context.txCount    >= 1;
        case 'first_purchase':    return context.purchCount >= 1;
        case 'first_payment':     return context.payCount   >= 1;
        case 'transfer_amount':   return context.lastTxAmount     >= val;
        case 'total_transferred': return context.totalTransferred >= val;
        case 'purchase_items':    return context.lastItemCount    >= val;
        case 'total_spent_ecom':  return context.totalSpentEcom   >= val;
        case 'payment_count':     return context.payCount   >= val;
        case 'transaction_count': return context.txCount    >= val;
        case 'reach_level':       return context.userLevel  >= val;
        case 'payment_amount':    return context.lastPayAmount   >= val;
        case 'purchase_count':    return context.purchCount      >= val;
        case 'total_paid_bills':  return context.totalSpentBills >= val;
        case 'total_xp_earned':   return context.totalXpEarned   >= val;
        case 'florin_balance':    return context.florinBalance   >= val;
        case 'checking_balance':        return context.checkingBalance      >= val;
        case 'savings_balance':         return context.savingsBalance       >= val;
        case 'unique_recipients':       return context.uniqueRecipients     >= val;
        case 'first_savings_transfer':  return context.savingsTransferCount >= 1;
        case 'savings_transfer_count':  return context.savingsTransferCount >= val;
        case 'transfer_to_beneficiary': {
            const target = String(cc.conditionValue || '').toLowerCase().trim();
            if (!target) return false;
            const recipient = String(context.lastRecipient        || '').toLowerCase().trim();
            const account   = String(context.lastRecipientAccount || '').toLowerCase().trim();
            return recipient === target || account === target;
        }
        case 'custom':
            if (!CUSTOM_FIELD_WHITELIST.has(cc.customField)) return false;
            return compareOp(Number(context[cc.customField]) || 0, cc.customOperator, val);
        default: return false;
    }
}

async function checkAndCompleteChallengesForUser(userId, context, challengeStore = 'challenges', userStore = 'users', appModule = null) {
    const challenges = await readJSON(challengeStore);
    const users      = await readJSON(userStore);
    const user       = users.find(u => u.id === userId);
    if (!user) return { completed: [], leveledUp: false, newLevel: 0 };

    const userChallenges = challenges.filter(c => c.userId === userId);
    const pending        = userChallenges.filter(c => c.active && !c.completed && c.condition !== 'manual');
    if (pending.length === 0) return { completed: [], leveledUp: false, newLevel: 0 };

    const now       = Date.now();
    const completed = [];

    pending.forEach(c => {
        // Primary condition plus any additional conditions the admin attached.
        const conditions = [{
            condition:      c.condition,
            conditionValue: c.conditionValue,
            customField:    c.customField,
            customOperator: c.customOperator
        }].concat(Array.isArray(c.extraConditions) ? c.extraConditions : []);
        const results = conditions.map(cc => evaluateCondition(cc, context));
        const met = (c.conditionLogic === 'any') ? results.some(Boolean) : results.every(Boolean);
        if (met) completed.push(c);
    });

    if (completed.length === 0) return { completed: [], leveledUp: false, newLevel: 0 };

    // Mark completed challenges in the master array
    const completedIds     = new Set(completed.map(c => c.id));
    const updatedChallenges = challenges.map(c =>
        completedIds.has(c.id) ? Object.assign({}, c, { completed: true, completedAt: now }) : c
    );
    await writeJSON(challengeStore, updatedChallenges);

    // Award XP + florins + update userData
    const bonusXP      = completed.reduce((s, c) => s + (c.points || 0), 0);
    const bonusFlorins = completed.reduce((s, c) => s + (c.florins || 0), 0);
    let leveledUp  = false;
    let newLevel   = 0;

    const userData             = Object.assign({}, DEFAULT_USER_DATA, user.userData || {});
    userData.challenges        = (userData.challenges || 0) + completed.length;
    userData.points            = (userData.points || 0) + bonusXP;
    userData.coins              = (userData.coins || 0) + bonusFlorins;
    userData.pointsToNextLevel = (userData.pointsToNextLevel !== undefined ? userData.pointsToNextLevel : 1000) - bonusXP;

    if (userData.pointsToNextLevel <= 0) {
        if (userData.level === 1) {
            // Gate: must have completed all 3 core Level-1 activities — one
            // per module. Meaningless for a standalone single-module account
            // (it has no way to ever do the other two), so bypass it there.
            const allNow = updatedChallenges.filter(c => c.userId === userId);
            const reqMet = appModule ? true : LEVEL_1_REQUIRED_CONDITIONS.every(cond =>
                allNow.some(c => c.condition === cond && c.completed)
            );
            if (reqMet) {
                userData.level++;
                userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                leveledUp = true;
                newLevel  = userData.level;
            } else {
                userData.pointsToNextLevel = 0;
            }
        } else {
            userData.level++;
            userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
            leveledUp = true;
            newLevel  = userData.level;
        }
    }

    const updatedUsers = users.map(u => u.id === userId ? Object.assign({}, u, { userData }) : u);
    await writeJSON(userStore, updatedUsers);

    return { completed, leveledUp, newLevel };
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
    origin:      ALLOWED_ORIGIN,
    methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-User-Id', 'X-User-Role']
}));
app.use(express.json());
app.use(express.static(__dirname));

// Auth middleware — reads X-User-Id and X-User-Role headers (prototype, no token validation)
app.use((req, res, next) => {
    const uid  = req.headers['x-user-id'];
    const role = req.headers['x-user-role'];
    req.userId   = uid  ? Number(uid) : null;
    req.userRole = role ? role        : null;
    next();
});

// Module middleware — Banking, E-Commerce, and Utilities are each fully
// standalone apps with their own separate accounts, decoupled from the
// original shared 'users'/'challenges'/'messages' stores every other page
// still uses. A page belonging to one of them sends X-App so every
// /api/me/* route below transparently resolves req.userId against the
// right store instead of the shared one — pages that never send X-App
// (every pre-existing page) see req.userStore/challengeStore/messageStore
// resolve to the original literal names, i.e. no behavior change at all.
const MODULE_STORES = {
    banking:   { users: 'bankingUsers',   challenges: 'bankingChallenges',   messages: 'bankingMessages' },
    ecommerce: { users: 'ecommerceUsers', challenges: 'ecommerceChallenges', messages: 'ecommerceMessages' },
    utilities: { users: 'utilitiesUsers', challenges: 'utilitiesChallenges', messages: 'utilitiesMessages' }
};
app.use((req, res, next) => {
    const mod = MODULE_STORES[req.headers['x-app']];
    req.appModule      = mod ? req.headers['x-app'] : null;
    req.userStore      = mod ? mod.users      : 'users';
    req.challengeStore = mod ? mod.challenges : 'challenges';
    req.messageStore   = mod ? mod.messages   : 'messages';
    next();
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    const { usernameOrEmail, password } = req.body || {};
    if (!usernameOrEmail || !password) {
        return res.status(400).json({ success: false, reason: 'missing_fields' });
    }
    const val   = usernameOrEmail.toLowerCase();
    const users = await readJSON('users');
    const user  = users.find(u => u.username === val || u.email === val);
    if (!user) return res.json({ success: false, reason: 'not_found' });
    if (user.passwordHash !== simpleHash(password)) return res.json({ success: false, reason: 'wrong_password' });
    if (user.status === 'pending')  return res.json({ success: false, reason: 'pending' });
    if (user.status === 'rejected') return res.json({ success: false, reason: 'rejected' });

    // Update lastLogin
    const now     = Date.now();
    const updated = users.map(u => u.id === user.id ? Object.assign({}, u, { lastLogin: now }) : u);
    await writeJSON('users', updated);
    res.json({ success: true, user: Object.assign({}, user, { lastLogin: now }) });
});

app.post('/api/auth/register', async (req, res) => {
    const { fullName, username, email, password } = req.body || {};
    if (!fullName || !username || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const users  = await readJSON('users');
    const uLower = username.toLowerCase();
    const eLower = email.toLowerCase();
    if (users.some(u => u.username === uLower)) {
        return res.status(409).json({ error: 'Username already taken' });
    }
    if (users.some(u => u.email === eLower)) {
        return res.status(409).json({ error: 'Email already registered' });
    }
    const id = nextId(users);
    users.push({
        id,
        fullName,
        username:     uLower,
        email:        eLower,
        passwordHash: simpleHash(password),
        role:         'participant',
        status:       'pending',
        createdAt:    Date.now(),
        approvedAt:   null,
        lastLogin:    null,
        userData:     Object.assign({}, DEFAULT_USER_DATA),
        balances:     Object.assign({}, DEFAULT_BALANCES)
    });
    await writeJSON('users', users);
    res.status(201).json({ id });
});

app.post('/api/auth/notify-admins', async (req, res) => {
    const { username, fullName } = req.body || {};
    const users    = await readJSON(req.userStore);
    const messages = await readJSON(req.messageStore);
    const admins   = users.filter(u => u.role === 'admin');
    const now      = Date.now();
    admins.forEach(admin => {
        messages.push({
            id:          nextId(messages),
            senderId:    0,
            senderName:  'System',
            senderEmail: null,
            recipientId: admin.id,
            subject:     'New Registration: @' + username,
            body:        (fullName || username) + ' (@' + username + ') has registered and is awaiting approval. Go to Admin \u2192 Users to approve or reject.',
            type:        'info',
            sentAt:      now,
            readBy:      []
        });
    });
    await writeJSON(req.messageStore, messages);
    res.json({ ok: true });
});

// ── Module auth (Banking / E-Commerce / Utilities standalone accounts) ─────────
// Each module has its own separate account space, decoupled from the shared
// 'users' store above — no role/status/approval gate, accounts are usable
// immediately after registration.
app.post('/api/banking/auth/register', async (req, res) => {
    const { fullName, username, email, password } = req.body || {};
    if (!fullName || !username || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const users  = await readJSON('bankingUsers');
    const uLower = username.toLowerCase();
    const eLower = email.toLowerCase();
    if (users.some(u => u.username === uLower)) {
        return res.status(409).json({ error: 'Username already taken' });
    }
    if (users.some(u => u.email === eLower)) {
        return res.status(409).json({ error: 'Email already registered' });
    }
    const user = {
        id:           nextId(users),
        fullName,
        username:     uLower,
        email:        eLower,
        passwordHash: simpleHash(password),
        createdAt:    Date.now(),
        lastLogin:    Date.now(),
        userData:     Object.assign({}, DEFAULT_USER_DATA),
        balances:     Object.assign({}, DEFAULT_BALANCES)
    };
    users.push(user);
    await writeJSON('bankingUsers', users);
    await seedChallengesForUser(user.id, 'bankingChallenges', 'banking');
    const { passwordHash, ...safeUser } = user;
    res.status(201).json({ user: safeUser });
});

app.post('/api/banking/auth/login', async (req, res) => {
    const { usernameOrEmail, password } = req.body || {};
    if (!usernameOrEmail || !password) {
        return res.status(400).json({ success: false, reason: 'missing_fields' });
    }
    const val   = usernameOrEmail.toLowerCase();
    const users = await readJSON('bankingUsers');
    const user  = users.find(u => u.username === val || u.email === val);
    if (!user) return res.json({ success: false, reason: 'not_found' });
    if (user.passwordHash !== simpleHash(password)) return res.json({ success: false, reason: 'wrong_password' });
    const now = Date.now();
    await writeJSON('bankingUsers', users.map(u => u.id === user.id ? Object.assign({}, u, { lastLogin: now }) : u));
    const { passwordHash, ...safeUser } = user;
    res.json({ success: true, user: Object.assign({}, safeUser, { lastLogin: now }) });
});

app.post('/api/ecommerce/auth/register', async (req, res) => {
    const { fullName, username, email, password } = req.body || {};
    if (!fullName || !username || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const users  = await readJSON('ecommerceUsers');
    const uLower = username.toLowerCase();
    const eLower = email.toLowerCase();
    if (users.some(u => u.username === uLower)) {
        return res.status(409).json({ error: 'Username already taken' });
    }
    if (users.some(u => u.email === eLower)) {
        return res.status(409).json({ error: 'Email already registered' });
    }
    const user = {
        id:           nextId(users),
        fullName,
        username:     uLower,
        email:        eLower,
        passwordHash: simpleHash(password),
        createdAt:    Date.now(),
        lastLogin:    Date.now(),
        userData:     Object.assign({}, DEFAULT_USER_DATA),
        balances:     Object.assign({}, DEFAULT_BALANCES)
    };
    users.push(user);
    await writeJSON('ecommerceUsers', users);
    await seedChallengesForUser(user.id, 'ecommerceChallenges', 'ecommerce');
    const { passwordHash, ...safeUser } = user;
    res.status(201).json({ user: safeUser });
});

app.post('/api/ecommerce/auth/login', async (req, res) => {
    const { usernameOrEmail, password } = req.body || {};
    if (!usernameOrEmail || !password) {
        return res.status(400).json({ success: false, reason: 'missing_fields' });
    }
    const val   = usernameOrEmail.toLowerCase();
    const users = await readJSON('ecommerceUsers');
    const user  = users.find(u => u.username === val || u.email === val);
    if (!user) return res.json({ success: false, reason: 'not_found' });
    if (user.passwordHash !== simpleHash(password)) return res.json({ success: false, reason: 'wrong_password' });
    const now = Date.now();
    await writeJSON('ecommerceUsers', users.map(u => u.id === user.id ? Object.assign({}, u, { lastLogin: now }) : u));
    const { passwordHash, ...safeUser } = user;
    res.json({ success: true, user: Object.assign({}, safeUser, { lastLogin: now }) });
});

app.post('/api/utilities/auth/register', async (req, res) => {
    const { fullName, username, email, password } = req.body || {};
    if (!fullName || !username || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const users  = await readJSON('utilitiesUsers');
    const uLower = username.toLowerCase();
    const eLower = email.toLowerCase();
    if (users.some(u => u.username === uLower)) {
        return res.status(409).json({ error: 'Username already taken' });
    }
    if (users.some(u => u.email === eLower)) {
        return res.status(409).json({ error: 'Email already registered' });
    }
    const user = {
        id:           nextId(users),
        fullName,
        username:     uLower,
        email:        eLower,
        passwordHash: simpleHash(password),
        createdAt:    Date.now(),
        lastLogin:    Date.now(),
        userData:     Object.assign({}, DEFAULT_USER_DATA),
        balances:     Object.assign({}, DEFAULT_BALANCES)
    };
    users.push(user);
    await writeJSON('utilitiesUsers', users);
    await seedChallengesForUser(user.id, 'utilitiesChallenges', 'utilities');
    const { passwordHash, ...safeUser } = user;
    res.status(201).json({ user: safeUser });
});

app.post('/api/utilities/auth/login', async (req, res) => {
    const { usernameOrEmail, password } = req.body || {};
    if (!usernameOrEmail || !password) {
        return res.status(400).json({ success: false, reason: 'missing_fields' });
    }
    const val   = usernameOrEmail.toLowerCase();
    const users = await readJSON('utilitiesUsers');
    const user  = users.find(u => u.username === val || u.email === val);
    if (!user) return res.json({ success: false, reason: 'not_found' });
    if (user.passwordHash !== simpleHash(password)) return res.json({ success: false, reason: 'wrong_password' });
    const now = Date.now();
    await writeJSON('utilitiesUsers', users.map(u => u.id === user.id ? Object.assign({}, u, { lastLogin: now }) : u));
    const { passwordHash, ...safeUser } = user;
    res.json({ success: true, user: Object.assign({}, safeUser, { lastLogin: now }) });
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', async (req, res) => {
    const users = await readJSON(req.userStore);
    res.json(users.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
});

app.get('/api/users/:id', async (req, res) => {
    const id    = Number(req.params.id);
    const users = await readJSON(req.userStore);
    const user  = users.find(u => u.id === id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (req.userRole !== 'admin' && req.userId !== id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(user);
});

// Non-admin callers may only touch their own record, and only the
// profile-level fields listed here — never role, status, balances, or
// passwordHash. Admins may patch any field on any user (this is how the
// admin panel edits userData/balances).
const SELF_EDITABLE_USER_FIELDS = ['fullName', 'email', 'username', 'prefs', 'avatarDataUri'];
app.put('/api/users/:id', async (req, res) => {
    const id      = Number(req.params.id);
    const isAdmin = req.userRole === 'admin';
    if (!isAdmin && req.userId !== id) return res.status(403).json({ error: 'Forbidden' });
    try {
        const result = await withUserLock(req.userId, async () => {
            const users = await readJSON(req.userStore);
            const idx   = users.findIndex(u => u.id === id);
            if (idx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const body  = req.body || {};
            const patch = {};
            if (isAdmin) {
                Object.assign(patch, body);
            } else {
                SELF_EDITABLE_USER_FIELDS.forEach(f => { if (body[f] !== undefined) patch[f] = body[f]; });
            }
            // Lowercased to match login's lowercase comparison — otherwise saving
            // "Jane@Email.com" here would make email/username login stop matching.
            if (patch.email    !== undefined) patch.email    = String(patch.email).toLowerCase();
            if (patch.username !== undefined) patch.username = String(patch.username).toLowerCase();
            users[idx] = Object.assign({}, users[idx], patch, { id });
            await writeJSON(req.userStore, users);
            return users[idx];
        });
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id = Number(req.params.id);

    // Remove from all per-user stores
    for (const store of [
        'transactions', 'payments', 'purchases', 'challenges',
        'creditCards', 'creditActivity', 'loans', 'loanPayments', 'savingsGoals', 'savingsGoalActivity',
        'scheduledTransfers', 'addresses', 'paymentMethods', 'billCycles', 'customBills'
    ]) {
        const rows = await readJSON(store);
        await writeJSON(store, rows.filter(r => r.userId !== id));
    }

    // Messages: delete direct, scrub readBy from broadcasts
    const messages = await readJSON(req.messageStore);
    await writeJSON(req.messageStore, messages
        .filter(m => m.recipientId !== id)
        .map(m => {
            if (m.recipientId === 'all') {
                return Object.assign({}, m, { readBy: (m.readBy || []).filter(uid => uid !== id) });
            }
            return m;
        })
    );

    const users = await readJSON(req.userStore);
    await writeJSON(req.userStore, users.filter(u => u.id !== id));
    res.json({ ok: true });
});

app.post('/api/users/:id/approve', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id    = Number(req.params.id);
    const users = await readJSON(req.userStore);
    const idx   = users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = Object.assign({}, users[idx], { status: 'approved', approvedAt: Date.now() });
    await writeJSON(req.userStore, users);
    await seedChallengesForUser(id);
    res.json(users[idx]);
});

app.post('/api/users/:id/reject', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id    = Number(req.params.id);
    const users = await readJSON(req.userStore);
    const idx   = users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = Object.assign({}, users[idx], { status: 'rejected' });
    await writeJSON(req.userStore, users);
    res.json(users[idx]);
});

app.get('/api/users/:id/challenges', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id = Number(req.params.id);
    res.json(await getChallengesForUser(id, 'participant'));
});

app.post('/api/users/:id/seed-challenges', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id = Number(req.params.id);
    await seedChallengesForUser(id);
    res.json({ ok: true });
});

// ── Me: user data ─────────────────────────────────────────────────────────────
app.get('/api/me/data', async (req, res) => {
    const users = await readJSON(req.userStore);
    const user  = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user.userData || Object.assign({}, DEFAULT_USER_DATA));
});

app.put('/api/me/data', async (req, res) => {
    const users = await readJSON(req.userStore);
    const idx   = users.findIndex(u => u.id === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = Object.assign({}, users[idx], { userData: req.body });
    await writeJSON(req.userStore, users);
    res.json(users[idx].userData);
});

// ── Me: profile ───────────────────────────────────────────────────────────────
app.get('/api/me/profile', async (req, res) => {
    const users = await readJSON(req.userStore);
    const user  = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ fullName: user.fullName, username: user.username, email: user.email, avatarDataUri: user.avatarDataUri || null });
});

app.put('/api/me/profile', async (req, res) => {
    const users = await readJSON(req.userStore);
    const idx   = users.findIndex(u => u.id === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    const { fullName, username, email, avatarDataUri } = req.body || {};
    const patch = {};
    if (fullName !== undefined) patch.fullName = fullName;
    // Lowercased to match login's lowercase comparison (server.js login handler) —
    // otherwise saving "Jane@Email.com" here would make email login stop matching.
    if (username  !== undefined) patch.username = username.toLowerCase();
    if (email     !== undefined) patch.email    = email.toLowerCase();
    if (avatarDataUri !== undefined) {
        if (avatarDataUri !== null && (typeof avatarDataUri !== 'string' || !avatarDataUri.startsWith('data:image/') || avatarDataUri.length > 400000)) {
            return res.status(400).json({ error: 'Invalid avatar image' });
        }
        patch.avatarDataUri = avatarDataUri;
    }
    users[idx] = Object.assign({}, users[idx], patch);
    await writeJSON(req.userStore, users);
    res.json({ fullName: users[idx].fullName, username: users[idx].username, email: users[idx].email, avatarDataUri: users[idx].avatarDataUri || null });
});

// Verifies the current password server-side and updates the hash — the client
// never has (or needs) access to the password-hashing function.
app.post('/api/me/password', async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'currentPassword and newPassword required' });
    }
    const users = await readJSON(req.userStore);
    const idx   = users.findIndex(u => u.id === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    if (users[idx].passwordHash !== simpleHash(currentPassword)) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }
    users[idx] = Object.assign({}, users[idx], { passwordHash: simpleHash(newPassword) });
    await writeJSON(req.userStore, users);
    await pushSystemMessage(req.userId, {
        subject: 'Your password was changed',
        body: 'Your account password was changed. If you didn\'t make this change, contact support immediately.',
        type: 'warning', category: 'system'
    }, req.messageStore);
    res.json({ ok: true });
});

// ── Me: balances ──────────────────────────────────────────────────────────────
app.get('/api/me/balances', async (req, res) => {
    // Catches up any scheduled transfers that came due since this user's
    // balance was last checked — this endpoint is loaded on every banking
    // page visit, so it's the most reliable point to self-correct regardless
    // of whether the server process was actually running at the scheduled
    // moment.
    await runDueScheduledTransfers(req.userId, req.userStore, req.messageStore);
    const users = await readJSON(req.userStore);
    const user  = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const balances = Object.assign({}, DEFAULT_BALANCES, user.balances || {});
    res.json(['checking', 'savings'].map(acc => ({ account: acc, amount: balances[acc] })));
});

app.get('/api/me/balances/:account', async (req, res) => {
    const users   = await readJSON(req.userStore);
    const user    = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const account  = req.params.account;
    const balances = Object.assign({}, DEFAULT_BALANCES, user.balances || {});
    res.json({ account, amount: balances[account] !== undefined ? balances[account] : 0 });
});

app.post('/api/me/balances/adjust', async (req, res) => {
    const { account, delta } = req.body || {};
    if (!account || delta === undefined) return res.status(400).json({ error: 'account and delta required' });
    const signedDelta = Number(delta);
    if (!Number.isFinite(signedDelta)) return res.status(400).json({ error: 'delta must be a finite number' });
    try {
        // Locked so two concurrent adjustments for the same user (e.g. a
        // double-submitted transfer, or two tabs) are applied one at a time
        // against the up-to-date balance instead of both reading the same
        // stale value and driving it past zero.
        const result = await withUserLock(req.userId, async () => {
            const users = await readJSON(req.userStore);
            const idx   = users.findIndex(u => u.id === req.userId);
            if (idx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const balances = Object.assign({}, DEFAULT_BALANCES, users[idx].balances || {});
            const current  = balances[account] !== undefined ? balances[account] : 0;
            const next     = parseFloat((current + signedDelta).toFixed(2));
            if (next < 0) { const e = new Error('Insufficient funds'); e.status = 409; throw e; }
            balances[account] = next;
            const updatedUser = Object.assign({}, users[idx], { balances });
            users[idx]        = updatedUser;
            await writeJSON(req.userStore, users);
            // Every balance-changing action in the app (transfers, bill pay,
            // checkout, credit card/loan/goal activity) routes through this
            // one endpoint, so it's the single choke point for alert checks.
            await maybeFireBalanceAlerts(updatedUser, account, current, next, signedDelta, 'banking', req.messageStore);
            return { account, amount: balances[account] };
        });
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

// Sets a balance to an exact target amount atomically — unlike computing a
// delta client-side (GET current, subtract, POST /adjust), the read and
// write here happen inside the same locked critical section, so nothing can
// change the balance between "read current" and "apply" (e.g. a scheduled
// transfer executing, or a second admin tab saving at the same moment).
app.post('/api/me/balances/:account/set', async (req, res) => {
    const account = req.params.account;
    const amount  = Number(req.body && req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative finite number' });
    try {
        const result = await withUserLock(req.userId, async () => {
            const users = await readJSON(req.userStore);
            const idx   = users.findIndex(u => u.id === req.userId);
            if (idx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const balances = Object.assign({}, DEFAULT_BALANCES, users[idx].balances || {});
            const current  = balances[account] !== undefined ? balances[account] : 0;
            const next     = parseFloat(amount.toFixed(2));
            balances[account] = next;
            const updatedUser = Object.assign({}, users[idx], { balances });
            users[idx] = updatedUser;
            await writeJSON(req.userStore, users);
            await maybeFireBalanceAlerts(updatedUser, account, current, next, next - current, 'banking', req.messageStore);
            return { account, amount: next };
        });
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

// ── Me: transactions ──────────────────────────────────────────────────────────
app.get('/api/me/transactions', async (req, res) => {
    const limit    = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const since    = req.query.since ? Number(req.query.since)       : null;
    const all      = await readJSON('transactions');
    let filtered   = all.filter(t => t.userId === req.userId);
    if (since)     filtered = filtered.filter(t => (t.timestamp || 0) >= since);
    filtered.sort((a, b) => (b.id || 0) - (a.id || 0));
    res.json(limit ? filtered.slice(0, limit) : filtered);
});

app.post('/api/me/transactions', async (req, res) => {
    const all    = await readJSON('transactions');
    const record = Object.assign({}, req.body, {
        id:        nextId(all),
        userId:    req.userId,
        timestamp: req.body.timestamp || Date.now()
    });
    all.push(record);
    await writeJSON('transactions', all);
    res.status(201).json(record);
});

app.delete('/api/me/transactions', async (req, res) => {
    const all = await readJSON('transactions');
    await writeJSON('transactions', all.filter(t => t.userId !== req.userId));
    res.json({ ok: true });
});

// ── Me: payments ──────────────────────────────────────────────────────────────
app.get('/api/me/payments', async (req, res) => {
    const limit    = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const since    = req.query.since ? Number(req.query.since)       : null;
    const all      = await readJSON('payments');
    let filtered   = all.filter(p => p.userId === req.userId);
    if (since)     filtered = filtered.filter(p => (p.timestamp || 0) >= since);
    filtered.sort((a, b) => (b.id || 0) - (a.id || 0));
    res.json(limit ? filtered.slice(0, limit) : filtered);
});

app.post('/api/me/payments', async (req, res) => {
    const all    = await readJSON('payments');
    const record = Object.assign({}, req.body, {
        id:        nextId(all),
        userId:    req.userId,
        timestamp: req.body.timestamp || Date.now()
    });
    all.push(record);
    await writeJSON('payments', all);
    res.status(201).json(record);
});

app.delete('/api/me/payments', async (req, res) => {
    const all = await readJSON('payments');
    await writeJSON('payments', all.filter(p => p.userId !== req.userId));
    res.json({ ok: true });
});

// ── Me: purchases ─────────────────────────────────────────────────────────────
// Notify-on-first-observe: fires a message the first time an order is seen
// having reached "shipped" or "delivered", then flags it so it never
// repeats for that order — same lazy-execution-on-read pattern used for
// overdue bills and scheduled transfers.
async function notifyOrderStatusForUser(userId, orders, messageStore = 'messages') {
    const toNotify = [];
    orders.forEach(o => {
        const status = computeOrderStatus(o).status;
        if (status === 'shipped' && !o.shippedNotified) toNotify.push({ order: o, stage: 'shipped' });
        if (status === 'delivered' && !o.deliveredNotified) toNotify.push({ order: o, stage: 'delivered' });
    });
    if (toNotify.length === 0) return orders;
    const all = await readJSON('purchases');
    toNotify.forEach(({ order, stage }) => {
        const idx = all.findIndex(x => x.id === order.id);
        if (idx !== -1) all[idx] = Object.assign({}, all[idx], stage === 'shipped' ? { shippedNotified: true } : { deliveredNotified: true });
    });
    await writeJSON('purchases', all);
    for (const { order, stage } of toNotify) {
        await pushSystemMessage(userId, {
            subject: stage === 'shipped' ? 'Your order has shipped' : 'Your order was delivered',
            body: stage === 'shipped'
                ? 'Your order ' + (order.orderId || '#' + order.id) + ' (ƒ' + (order.total || 0).toFixed(2) + ') has shipped and is on its way.'
                : 'Your order ' + (order.orderId || '#' + order.id) + ' (ƒ' + (order.total || 0).toFixed(2) + ') was delivered. We hope you enjoy it!',
            type: 'info', category: 'ecommerce'
        }, messageStore);
    }
    return orders.map(o => {
        const hit = toNotify.filter(t => t.order.id === o.id);
        if (hit.length === 0) return o;
        const patch = {};
        hit.forEach(({ stage }) => { patch[stage === 'shipped' ? 'shippedNotified' : 'deliveredNotified'] = true; });
        return Object.assign({}, o, patch);
    });
}

app.get('/api/me/purchases', async (req, res) => {
    const limit    = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const all      = await readJSON('purchases');
    let filtered   = all.filter(p => p.userId === req.userId);
    filtered.sort((a, b) => (b.id || 0) - (a.id || 0));
    // Locked so two concurrent GETs (two open tabs) can't both observe the
    // dedup flag as unset and each push a duplicate shipped/delivered message.
    filtered = await withUserLock(req.userId, () => notifyOrderStatusForUser(req.userId, filtered, req.messageStore));
    filtered = filtered.map(p => Object.assign({}, p, computeOrderStatus(p)));
    res.json(limit ? filtered.slice(0, limit) : filtered);
});

app.get('/api/me/purchases/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON('purchases');
    const order = all.find(p => p.id === id && p.userId === req.userId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json(Object.assign({}, order, computeOrderStatus(order)));
});

app.post('/api/me/purchases', async (req, res) => {
    const all    = await readJSON('purchases');
    const record = Object.assign({}, req.body, {
        id:        nextId(all),
        userId:    req.userId,
        timestamp: req.body.timestamp || Date.now()
    });
    all.push(record);
    await writeJSON('purchases', all);
    res.status(201).json(record);
});

app.delete('/api/me/purchases', async (req, res) => {
    const all = await readJSON('purchases');
    await writeJSON('purchases', all.filter(p => p.userId !== req.userId));
    res.json({ ok: true });
});

// ── Me: cart ──────────────────────────────────────────────────────────────────
app.get('/api/me/cart', async (req, res) => {
    const all  = await readJSON('cart');
    const mine = all
        .filter(i => i.userId === req.userId)
        .sort((a, b) => (a.id || 0) - (b.id || 0));
    res.json(mine);
});

app.post('/api/me/cart', async (req, res) => {
    const all    = await readJSON('cart');
    const record = Object.assign({}, req.body, { id: nextId(all), userId: req.userId });
    all.push(record);
    await writeJSON('cart', all);
    res.status(201).json(record);
});

app.delete('/api/me/cart/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON('cart');
    await writeJSON('cart', all.filter(i => !(i.id === id && i.userId === req.userId)));
    res.json({ ok: true });
});

app.delete('/api/me/cart', async (req, res) => {
    const all = await readJSON('cart');
    await writeJSON('cart', all.filter(i => i.userId !== req.userId));
    res.json({ ok: true });
});

// ── Me: checkout ─────────────────────────────────────────────────────────────
// Single atomic endpoint (replaces the old client-orchestrated multi-call
// checkout) — reads the server's own cart and product catalog rather than
// trusting client-supplied items/prices, requires a real address + payment
// method, computes tax from the shipping address's state and shipping cost
// from the chosen speed, then does the balance debit + stock decrement +
// order write + cart clear inside one withUserLock so a mid-checkout failure
// can't leave money deducted with no order recorded.
app.post('/api/me/checkout', async (req, res) => {
    const body = req.body || {};
    const addressId       = Number(body.addressId);
    const paymentMethodId = Number(body.paymentMethodId);
    const shippingMethod  = SHIPPING_RATES.hasOwnProperty(body.shippingMethod) ? body.shippingMethod : 'standard';
    const promoCodeInput  = body.promoCode;

    try {
        const result = await withUserLock(req.userId, async () => {
            const [cartRows, products, addresses, paymentMethods, users] = await Promise.all([
                readJSON('cart'), readJSON('products'), readJSON('addresses'), readJSON('paymentMethods'), readJSON(req.userStore)
            ]);
            const myCart = cartRows.filter(c => c.userId === req.userId);
            if (myCart.length === 0) { const e = new Error('Cart is empty'); e.status = 400; throw e; }

            const address = addresses.find(a => a.id === addressId && a.userId === req.userId);
            if (!address) { const e = new Error('Select a shipping address'); e.status = 400; throw e; }
            const paymentMethod = paymentMethods.find(p => p.id === paymentMethodId && p.userId === req.userId);
            if (!paymentMethod) { const e = new Error('Select a payment method'); e.status = 400; throw e; }

            // Resolve authoritative prices/stock from the catalog — never
            // trust client-supplied cart prices.
            const items = [];
            for (const row of myCart) {
                const product = products.find(p => p.name === row.name);
                if (!product) { const e = new Error('"' + row.name + '" is no longer available'); e.status = 409; throw e; }
                const qty = row.quantity || 1;
                if (qty > product.stock) { const e = new Error('Only ' + product.stock + ' left of "' + product.name + '"'); e.status = 409; throw e; }
                items.push({ productId: product.id, name: product.name, price: product.price, quantity: qty });
            }

            const subtotal       = parseFloat(items.reduce((s, i) => s + i.price * i.quantity, 0).toFixed(2));
            const promo          = computePromoDiscount(promoCodeInput, subtotal);
            const afterDiscount  = parseFloat((subtotal - promo.discount).toFixed(2));

            const shipInfo      = SHIPPING_RATES[shippingMethod];
            const shippingCost  = (shipInfo.freeThreshold != null && afterDiscount >= shipInfo.freeThreshold) ? 0 : shipInfo.cost;

            // US sales tax is charged based on the delivery address, not the
            // seller's location.
            const taxRate = STATE_TAX_RATES.hasOwnProperty(address.state) ? STATE_TAX_RATES[address.state] : 0;
            const tax     = parseFloat((afterDiscount * taxRate).toFixed(2));

            const total = parseFloat((afterDiscount + tax + shippingCost).toFixed(2));

            const uidx = users.findIndex(u => u.id === req.userId);
            if (uidx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const balances = Object.assign({}, DEFAULT_BALANCES, users[uidx].balances || {});
            const current  = balances.checking;

            const itemCount    = items.reduce((s, i) => s + i.quantity, 0);
            const pointsEarned = itemCount * 45;
            const coinsEarned  = Math.floor(total / 10);

            // Preview mode — compute the same authoritative totals the real
            // checkout would charge, without touching balances, stock, or
            // writing an order. Lets the client show an accurate confirm
            // screen without duplicating the tax/shipping/promo tables.
            if (body.dryRun) {
                return {
                    items, subtotal, promoCode: promo.code, promoLabel: promo.label, discount: promo.discount,
                    taxRate, tax, shippingMethod, shippingCost, total, itemCount, pointsEarned, coinsEarned,
                    checking: current, sufficientFunds: total <= current
                };
            }

            if (total > current) { const e = new Error('Insufficient funds. Available: ƒ' + current.toFixed(2)); e.status = 409; throw e; }
            const next = parseFloat((current - total).toFixed(2));
            balances.checking = next;

            const userData = Object.assign({}, DEFAULT_USER_DATA, users[uidx].userData || {});
            userData.points            = (userData.points || 0) + pointsEarned;
            userData.pointsToNextLevel = (userData.pointsToNextLevel != null ? userData.pointsToNextLevel : 1000) - pointsEarned;
            userData.completedTasks    = (userData.completedTasks || 0) + 1;
            userData.coins              = (userData.coins || 0) + coinsEarned;
            let leveledUp = false, newLevel = 0;
            if (userData.pointsToNextLevel <= 0) {
                if (userData.level === 1) {
                    const challenges = await readJSON(req.challengeStore);
                    const reqMet = LEVEL_1_REQUIRED_CONDITIONS.every(cond =>
                        challenges.some(c => c.userId === req.userId && c.condition === cond && c.completed)
                    );
                    if (reqMet) {
                        userData.level++;
                        userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                        leveledUp = true; newLevel = userData.level;
                    } else {
                        userData.pointsToNextLevel = 0;
                    }
                } else {
                    userData.level++;
                    userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                    leveledUp = true; newLevel = userData.level;
                }
            }

            const updatedUser = Object.assign({}, users[uidx], { balances, userData });
            users[uidx] = updatedUser;
            await writeJSON(req.userStore, users);
            await maybeFireBalanceAlerts(updatedUser, 'checking', current, next, -total, 'ecommerce', req.messageStore);

            const updatedProducts = products.map(p => {
                const line = items.find(i => i.productId === p.id);
                return line ? Object.assign({}, p, { stock: Math.max(0, p.stock - line.quantity) }) : p;
            });
            await writeJSON('products', updatedProducts);

            const purchases      = await readJSON('purchases');
            const orderNumericId = nextId(purchases);
            const order = {
                id:        orderNumericId,
                orderId:   'ORD-' + String(100000 + orderNumericId),
                userId:    req.userId,
                items,
                subtotal, promoCode: promo.code, discount: promo.discount,
                taxRate, tax, shippingMethod, shippingCost, total,
                pointsEarned, coinsEarned,
                address: {
                    fullName: address.fullName, street: address.street, street2: address.street2,
                    city: address.city, state: address.state, zip: address.zip, country: address.country
                },
                paymentMethod: { brand: paymentMethod.brand, last4: paymentMethod.last4 },
                timestamp: Date.now(),
                date: new Date().toLocaleDateString()
            };
            purchases.push(order);
            await writeJSON('purchases', purchases);
            await writeJSON('cart', cartRows.filter(c => c.userId !== req.userId));

            return { order: Object.assign({}, order, computeOrderStatus(order)), leveledUp, newLevel, checking: next };
        });
        res.status(body.dryRun ? 200 : 201).json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

// ── Me: challenges  (specific sub-routes MUST be defined before the generic ones)
app.get('/api/me/challenges/level1', async (req, res) => {
    // The 3-way gate (one activity per module) is meaningless for a
    // standalone single-module account — it has no way to ever satisfy the
    // other two, so treat it as already met.
    if (req.appModule) return res.json({ allMet: true, items: [] });
    const challenges = await getChallengesForUser(req.userId, 'participant', req.challengeStore);
    const defs = [
        { condition: 'first_transfer', title: 'Make your first bank transfer',          link: 'banking.html'   },
        { condition: 'first_purchase', title: 'Complete your first ecommerce purchase', link: 'ecommerce.html' },
        { condition: 'first_payment',  title: 'Pay your first utility bill',             link: 'utilities.html' }
    ];
    const items = defs.map(d => ({
        condition: d.condition,
        title:     d.title,
        link:      d.link,
        met:       challenges.some(c => c.condition === d.condition && c.completed)
    }));
    res.json({ allMet: items.every(i => i.met), items });
});

app.post('/api/me/challenges/check', async (req, res) => {
    const result = await checkAndCompleteChallengesForUser(req.userId, req.body || {}, req.challengeStore, req.userStore, req.appModule);
    res.json(result);
});

app.post('/api/me/challenges/purge', async (req, res) => {
    const all    = await readJSON(req.challengeStore);
    const mine   = all.filter(c => c.userId === req.userId);
    const others = all.filter(c => c.userId !== req.userId);

    const best = new Map();
    mine.forEach(c => {
        const key  = c.title || String(c.id);
        const prev = best.get(key);
        if (!prev) {
            best.set(key, c);
        } else if (c.completed && !prev.completed) {
            best.set(key, c);
        } else if (!c.completed && prev.completed) {
            // keep prev
        } else if ((c.id || 0) > (prev.id || 0)) {
            best.set(key, c);
        }
    });

    const keepIds = new Set(Array.from(best.values()).map(c => c.id));
    const purged  = mine.filter(c => !keepIds.has(c.id)).length;
    await writeJSON(req.challengeStore, [...others, ...mine.filter(c => keepIds.has(c.id))]);
    res.json({ purged });
});

// Wipes and re-seeds only the caller's own challenges. Scoped to req.userId
// (like every other /api/me/* route) so a participant can self-service reset
// their challenges without needing the admin-only DELETE /api/admin/challenges,
// which would otherwise wipe every user's challenges.
app.post('/api/me/challenges/reset', async (req, res) => {
    const all    = await readJSON(req.challengeStore);
    const others = all.filter(c => c.userId !== req.userId);
    await writeJSON(req.challengeStore, others);
    await seedChallengesForUser(req.userId, req.challengeStore, req.appModule);
    res.json({ ok: true });
});

// Resets the caller's own progress in one request: clears their transactions,
// payments, purchases and cart, resets their balances and userData to
// defaults, and re-seeds their challenges. Scoped to req.userId so this can't
// affect any other user.
app.post('/api/me/reset', async (req, res) => {
    for (const store of [
        'transactions', 'payments', 'purchases', 'cart',
        'creditCards', 'creditActivity', 'loans', 'loanPayments', 'savingsGoals', 'savingsGoalActivity',
        'scheduledTransfers', 'addresses', 'paymentMethods', 'billCycles', 'customBills'
    ]) {
        const rows = await readJSON(store);
        await writeJSON(store, rows.filter(r => r.userId !== req.userId));
    }

    const users = await readJSON(req.userStore);
    const idx   = users.findIndex(u => u.id === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = Object.assign({}, users[idx], {
        userData: Object.assign({}, DEFAULT_USER_DATA),
        balances: Object.assign({}, DEFAULT_BALANCES)
    });
    await writeJSON(req.userStore, users);

    const challenges = await readJSON(req.challengeStore);
    await writeJSON(req.challengeStore, challenges.filter(c => c.userId !== req.userId));
    await seedChallengesForUser(req.userId, req.challengeStore, req.appModule);

    res.json({ ok: true });
});

app.get('/api/me/challenges', async (req, res) => {
    res.json(await getChallengesForUser(req.userId, req.userRole || 'participant', req.challengeStore));
});

app.post('/api/me/challenges', async (req, res) => {
    const all    = await readJSON(req.challengeStore);
    const record = Object.assign({
        active:    true,
        completed: false,
        condition: 'manual',
        createdAt: Date.now()
    }, req.body, {
        id:     nextId(all),
        userId: req.userId
    });
    all.push(record);
    await writeJSON(req.challengeStore, all);
    res.status(201).json(record);
});

app.patch('/api/me/challenges/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON(req.challengeStore);
    const idx = all.findIndex(c => c.id === id && c.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'Challenge not found' });
    all[idx] = Object.assign({}, all[idx], req.body, { id, userId: req.userId });
    await writeJSON(req.challengeStore, all);
    res.json(all[idx]);
});

app.delete('/api/me/challenges/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON(req.challengeStore);
    await writeJSON(req.challengeStore, all.filter(c => !(c.id === id && c.userId === req.userId)));
    res.json({ ok: true });
});

// ── Me: messages ──────────────────────────────────────────────────────────────
app.get('/api/me/messages', async (req, res) => {
    const all = await readJSON(req.messageStore);
    res.json(all.filter(m => m.recipientId === 'all' || m.recipientId === req.userId));
});

app.patch('/api/me/messages/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON(req.messageStore);
    const idx = all.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Message not found' });
    const readBy = Array.from(all[idx].readBy || []);
    if (!readBy.includes(req.userId)) readBy.push(req.userId);
    all[idx] = Object.assign({}, all[idx], { readBy });
    await writeJSON(req.messageStore, all);
    res.json(all[idx]);
});

// ── Me: alert preferences ───────────────────────────────────────────────────
app.get('/api/me/alert-prefs', async (req, res) => {
    const users = await readJSON(req.userStore);
    const user  = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(Object.assign({}, DEFAULT_ALERT_PREFS, (user.userData || {}).alertPrefs || {}));
});

app.put('/api/me/alert-prefs', async (req, res) => {
    const users = await readJSON(req.userStore);
    const idx   = users.findIndex(u => u.id === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    const body  = req.body || {};
    const prefs = {
        lowBalanceEnabled:   body.lowBalanceEnabled   !== undefined ? !!body.lowBalanceEnabled  : DEFAULT_ALERT_PREFS.lowBalanceEnabled,
        lowBalanceThreshold: body.lowBalanceThreshold !== undefined ? Math.max(0, Number(body.lowBalanceThreshold) || 0) : DEFAULT_ALERT_PREFS.lowBalanceThreshold,
        largeTxEnabled:      body.largeTxEnabled      !== undefined ? !!body.largeTxEnabled     : DEFAULT_ALERT_PREFS.largeTxEnabled,
        largeTxThreshold:    body.largeTxThreshold    !== undefined ? Math.max(0, Number(body.largeTxThreshold) || 0) : DEFAULT_ALERT_PREFS.largeTxThreshold
    };
    const userData = Object.assign({}, DEFAULT_USER_DATA, users[idx].userData || {}, { alertPrefs: prefs });
    users[idx] = Object.assign({}, users[idx], { userData });
    await writeJSON(req.userStore, users);
    res.json(prefs);
});

// ── Me: credit card ──────────────────────────────────────────────────────────
const CREDIT_CARD_TIERS = {
    starter:  { limit: 1000,  apr: 24.99 },
    standard: { limit: 2500,  apr: 21.99 },
    premium:  { limit: 5000,  apr: 18.99 }
};

app.get('/api/me/credit-card', async (req, res) => {
    const cards = await readJSON('creditCards');
    const card  = cards.find(c => c.userId === req.userId && c.active);
    res.json(card || { active: false });
});

app.post('/api/me/credit-card/open', async (req, res) => {
    const tier   = req.body && req.body.tier;
    const chosen = CREDIT_CARD_TIERS[tier];
    if (!chosen) return res.status(400).json({ error: 'Invalid card tier' });
    try {
        const card = await withUserLock(req.userId, async () => {
            const cards = await readJSON('creditCards');
            if (cards.some(c => c.userId === req.userId && c.active)) {
                const e = new Error('You already have an active credit card'); e.status = 409; throw e;
            }
            const rec = {
                id: nextId(cards), userId: req.userId, tier,
                limit: chosen.limit, apr: chosen.apr, balance: 0,
                active: true, openedAt: Date.now()
            };
            cards.push(rec);
            await writeJSON('creditCards', cards);
            return rec;
        });
        res.status(201).json(card);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

app.post('/api/me/credit-card/purchase', async (req, res) => {
    const amt = Number(req.body && req.body.amount);
    const description = ((req.body && req.body.description) || '').trim() || 'Card purchase';
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Valid amount required' });
    try {
        const result = await withUserLock(req.userId, async () => {
            const cards = await readJSON('creditCards');
            const idx   = cards.findIndex(c => c.userId === req.userId && c.active);
            if (idx === -1) { const e = new Error('No active credit card'); e.status = 404; throw e; }
            const card = cards[idx];
            const available = parseFloat((card.limit - card.balance).toFixed(2));
            if (amt > available) { const e = new Error('Exceeds available credit'); e.status = 409; throw e; }
            const newBalance = parseFloat((card.balance + amt).toFixed(2));
            cards[idx] = Object.assign({}, card, { balance: newBalance });
            await writeJSON('creditCards', cards);

            // Edge-triggered so a card that's already over the threshold
            // doesn't re-alert on every subsequent purchase.
            const pctBefore = card.limit > 0 ? card.balance / card.limit : 0;
            const pctAfter  = card.limit > 0 ? newBalance   / card.limit : 0;
            if (pctBefore < 0.7 && pctAfter >= 0.7) {
                await pushSystemMessage(req.userId, {
                    subject: 'High credit card utilization',
                    body: 'Your credit card balance has reached ' + Math.round(pctAfter * 100) + '% of your ƒ' +
                          card.limit.toFixed(2) + ' limit. Consider paying down your balance to protect your credit health.',
                    type: 'warning', category: 'banking'
                });
            }

            const activity = await readJSON('creditActivity');
            const record = {
                id: nextId(activity), userId: req.userId, type: 'purchase',
                amount: amt, description, date: new Date().toLocaleDateString(), timestamp: Date.now()
            };
            activity.push(record);
            await writeJSON('creditActivity', activity);
            return { card: cards[idx], activity: record };
        });
        res.status(201).json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

app.post('/api/me/credit-card/payment', async (req, res) => {
    const amt = Number(req.body && req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Valid amount required' });
    try {
        const result = await withUserLock(req.userId, async () => {
            const cards = await readJSON('creditCards');
            const idx   = cards.findIndex(c => c.userId === req.userId && c.active);
            if (idx === -1) { const e = new Error('No active credit card'); e.status = 404; throw e; }
            const card = cards[idx];
            const payAmt = Math.min(amt, card.balance);
            if (payAmt <= 0) { const e = new Error('Card balance is already zero'); e.status = 409; throw e; }

            const users = await readJSON(req.userStore);
            const uidx  = users.findIndex(u => u.id === req.userId);
            if (uidx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const balances = Object.assign({}, DEFAULT_BALANCES, users[uidx].balances || {});
            const current  = balances.checking;
            const next     = parseFloat((current - payAmt).toFixed(2));
            if (next < 0) { const e = new Error('Insufficient funds'); e.status = 409; throw e; }
            balances.checking = next;
            const updatedUser = Object.assign({}, users[uidx], { balances });
            users[uidx] = updatedUser;
            await writeJSON(req.userStore, users);
            await maybeFireBalanceAlerts(updatedUser, 'checking', current, next, -payAmt, 'banking', req.messageStore);

            cards[idx] = Object.assign({}, card, { balance: parseFloat((card.balance - payAmt).toFixed(2)) });
            await writeJSON('creditCards', cards);

            const activity = await readJSON('creditActivity');
            const record = {
                id: nextId(activity), userId: req.userId, type: 'payment',
                amount: payAmt, description: 'Card payment', date: new Date().toLocaleDateString(), timestamp: Date.now()
            };
            activity.push(record);
            await writeJSON('creditActivity', activity);
            return { card: cards[idx], checking: next, activity: record };
        });
        res.status(201).json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

app.get('/api/me/credit-card/activity', async (req, res) => {
    const activity = await readJSON('creditActivity');
    const mine = activity.filter(a => a.userId === req.userId).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json(mine);
});

// ── Me: loans ─────────────────────────────────────────────────────────────────
const LOAN_TERMS = {
    6:  { apr: 5.99  },
    12: { apr: 6.99  },
    24: { apr: 8.99  },
    36: { apr: 10.99 },
    60: { apr: 12.99 }
};

app.get('/api/me/loan', async (req, res) => {
    const loans = await readJSON('loans');
    // Most recent loan regardless of status, so the client can distinguish
    // "never applied" from "actively repaying" from "paid off" (a strict
    // active-only filter would make a paid-off loan look identical to never
    // having had one, losing the payoff-celebration state).
    const mine = loans.filter(l => l.userId === req.userId).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
    res.json(mine[0] || { active: false, paidOff: false });
});

app.post('/api/me/loan/apply', async (req, res) => {
    const amt  = Number(req.body && req.body.amount);
    const term = Number(req.body && req.body.termMonths);
    const termInfo = LOAN_TERMS[term];
    if (!amt || amt < 500 || amt > 20000) return res.status(400).json({ error: 'Loan amount must be between ƒ500 and ƒ20,000' });
    if (!termInfo) return res.status(400).json({ error: 'Invalid loan term' });
    try {
        const result = await withUserLock(req.userId, async () => {
            const loans = await readJSON('loans');
            if (loans.some(l => l.userId === req.userId && l.active)) {
                const e = new Error('You already have an active loan'); e.status = 409; throw e;
            }
            // Simple (non-amortizing) interest — total interest = principal ×
            // rate × (term in years). Easier to reason about than a real
            // amortization schedule and still teaches the core idea that a
            // longer term costs more in total interest.
            const totalInterest  = parseFloat((amt * (termInfo.apr / 100) * (term / 12)).toFixed(2));
            const totalOwed      = parseFloat((amt + totalInterest).toFixed(2));
            const monthlyPayment = parseFloat((totalOwed / term).toFixed(2));
            const loan = {
                id: nextId(loans), userId: req.userId, principal: amt, apr: termInfo.apr,
                termMonths: term, totalInterest, balance: totalOwed, monthlyPayment,
                active: true, paidOff: false, openedAt: Date.now(), paidOffAt: null
            };
            loans.push(loan);
            await writeJSON('loans', loans);

            const users = await readJSON(req.userStore);
            const uidx  = users.findIndex(u => u.id === req.userId);
            if (uidx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const balances = Object.assign({}, DEFAULT_BALANCES, users[uidx].balances || {});
            const current   = balances.checking;
            const next      = parseFloat((current + amt).toFixed(2));
            balances.checking = next;
            const updatedUser = Object.assign({}, users[uidx], { balances });
            users[uidx] = updatedUser;
            await writeJSON(req.userStore, users);
            await maybeFireBalanceAlerts(updatedUser, 'checking', current, next, amt, 'banking', req.messageStore);

            return { loan, checking: next };
        });
        res.status(201).json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

app.post('/api/me/loan/payment', async (req, res) => {
    const amt = Number(req.body && req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Valid amount required' });
    try {
        const result = await withUserLock(req.userId, async () => {
            const loans = await readJSON('loans');
            const idx   = loans.findIndex(l => l.userId === req.userId && l.active);
            if (idx === -1) { const e = new Error('No active loan'); e.status = 404; throw e; }
            const loan = loans[idx];
            const payAmt = Math.min(amt, loan.balance);
            if (payAmt <= 0) { const e = new Error('Loan balance is already zero'); e.status = 409; throw e; }

            const users = await readJSON(req.userStore);
            const uidx  = users.findIndex(u => u.id === req.userId);
            if (uidx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const balances = Object.assign({}, DEFAULT_BALANCES, users[uidx].balances || {});
            const current  = balances.checking;
            const next     = parseFloat((current - payAmt).toFixed(2));
            if (next < 0) { const e = new Error('Insufficient funds'); e.status = 409; throw e; }
            balances.checking = next;
            const updatedUser = Object.assign({}, users[uidx], { balances });
            users[uidx] = updatedUser;
            await writeJSON(req.userStore, users);
            await maybeFireBalanceAlerts(updatedUser, 'checking', current, next, -payAmt, 'banking', req.messageStore);

            const newBalance = parseFloat((loan.balance - payAmt).toFixed(2));
            const paidOff = newBalance <= 0;
            loans[idx] = Object.assign({}, loan, {
                balance: Math.max(0, newBalance),
                active: !paidOff,
                paidOff: paidOff,
                paidOffAt: paidOff ? Date.now() : null
            });
            await writeJSON('loans', loans);
            if (paidOff) {
                await pushSystemMessage(req.userId, {
                    subject: 'Loan paid off!',
                    body: 'Congratulations! You\'ve paid off your loan of ƒ' + loan.principal.toFixed(2) + ' in full.',
                    type: 'success', category: 'banking'
                });
            }

            const loanPayments = await readJSON('loanPayments');
            const record = {
                id: nextId(loanPayments), userId: req.userId, loanId: loan.id,
                amount: payAmt, date: new Date().toLocaleDateString(), timestamp: Date.now()
            };
            loanPayments.push(record);
            await writeJSON('loanPayments', loanPayments);

            return { loan: loans[idx], checking: next, payment: record };
        });
        res.status(201).json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

app.get('/api/me/loan/payments', async (req, res) => {
    const payments = await readJSON('loanPayments');
    const mine = payments.filter(p => p.userId === req.userId).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json(mine);
});

// ── Me: savings goals ────────────────────────────────────────────────────────
app.get('/api/me/savings-goals', async (req, res) => {
    const goals = await readJSON('savingsGoals');
    const mine  = goals.filter(g => g.userId === req.userId).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json(mine);
});

app.post('/api/me/savings-goals', async (req, res) => {
    const name   = ((req.body && req.body.name) || '').trim();
    const target = Number(req.body && req.body.target);
    if (!name) return res.status(400).json({ error: 'Goal name required' });
    if (!target || target < 10 || target > 1000000) return res.status(400).json({ error: 'Target must be between ƒ10 and ƒ1,000,000' });
    const goals = await readJSON('savingsGoals');
    const goal = {
        id: nextId(goals), userId: req.userId, name, target,
        current: 0, createdAt: Date.now(), completedAt: null
    };
    goals.push(goal);
    await writeJSON('savingsGoals', goals);
    res.status(201).json(goal);
});

app.post('/api/me/savings-goals/:id/contribute', async (req, res) => {
    const id  = Number(req.params.id);
    const amt = Number(req.body && req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Valid amount required' });
    try {
        const result = await withUserLock(req.userId, async () => {
            const goals = await readJSON('savingsGoals');
            const idx   = goals.findIndex(g => g.id === id && g.userId === req.userId);
            if (idx === -1) { const e = new Error('Goal not found'); e.status = 404; throw e; }
            const goal = goals[idx];

            const users = await readJSON(req.userStore);
            const uidx  = users.findIndex(u => u.id === req.userId);
            if (uidx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const balances = Object.assign({}, DEFAULT_BALANCES, users[uidx].balances || {});
            const current  = balances.checking;
            const next     = parseFloat((current - amt).toFixed(2));
            if (next < 0) { const e = new Error('Insufficient funds'); e.status = 409; throw e; }
            balances.checking = next;
            const updatedUser = Object.assign({}, users[uidx], { balances });
            users[uidx] = updatedUser;
            await writeJSON(req.userStore, users);
            await maybeFireBalanceAlerts(updatedUser, 'checking', current, next, -amt, 'banking', req.messageStore);

            const wasComplete = goal.current >= goal.target;
            const newCurrent  = parseFloat((goal.current + amt).toFixed(2));
            const nowComplete = newCurrent >= goal.target;
            goals[idx] = Object.assign({}, goal, {
                current: newCurrent,
                completedAt: (!wasComplete && nowComplete) ? Date.now() : goal.completedAt
            });
            await writeJSON('savingsGoals', goals);
            if (!wasComplete && nowComplete) {
                await pushSystemMessage(req.userId, {
                    subject: 'Savings goal reached!',
                    body: 'You\'ve reached your savings goal "' + goal.name + '" of ƒ' + goal.target.toFixed(2) + '. Great work!',
                    type: 'success', category: 'banking'
                });
            }

            const activity = await readJSON('savingsGoalActivity');
            activity.push({
                id: nextId(activity), userId: req.userId, goalId: id, type: 'contribute',
                amount: amt, date: new Date().toLocaleDateString(), timestamp: Date.now()
            });
            await writeJSON('savingsGoalActivity', activity);

            return { goal: goals[idx], checking: next, justCompleted: !wasComplete && nowComplete };
        });
        res.status(201).json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

app.post('/api/me/savings-goals/:id/withdraw', async (req, res) => {
    const id  = Number(req.params.id);
    const amt = Number(req.body && req.body.amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'Valid amount required' });
    try {
        const result = await withUserLock(req.userId, async () => {
            const goals = await readJSON('savingsGoals');
            const idx   = goals.findIndex(g => g.id === id && g.userId === req.userId);
            if (idx === -1) { const e = new Error('Goal not found'); e.status = 404; throw e; }
            const goal = goals[idx];
            const wAmt = Math.min(amt, goal.current);
            if (wAmt <= 0) { const e = new Error('Goal balance is already zero'); e.status = 409; throw e; }

            const users = await readJSON(req.userStore);
            const uidx  = users.findIndex(u => u.id === req.userId);
            if (uidx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const balances = Object.assign({}, DEFAULT_BALANCES, users[uidx].balances || {});
            const current  = balances.checking;
            const next     = parseFloat((current + wAmt).toFixed(2));
            balances.checking = next;
            const updatedUser = Object.assign({}, users[uidx], { balances });
            users[uidx] = updatedUser;
            await writeJSON(req.userStore, users);
            await maybeFireBalanceAlerts(updatedUser, 'checking', current, next, wAmt, 'banking', req.messageStore);

            goals[idx] = Object.assign({}, goal, { current: parseFloat((goal.current - wAmt).toFixed(2)) });
            await writeJSON('savingsGoals', goals);

            const activity = await readJSON('savingsGoalActivity');
            activity.push({
                id: nextId(activity), userId: req.userId, goalId: id, type: 'withdraw',
                amount: wAmt, date: new Date().toLocaleDateString(), timestamp: Date.now()
            });
            await writeJSON('savingsGoalActivity', activity);

            return { goal: goals[idx], checking: next, withdrawn: wAmt };
        });
        res.status(201).json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

app.delete('/api/me/savings-goals/:id', async (req, res) => {
    const id = Number(req.params.id);
    try {
        const result = await withUserLock(req.userId, async () => {
            const goals = await readJSON('savingsGoals');
            const idx   = goals.findIndex(g => g.id === id && g.userId === req.userId);
            if (idx === -1) { const e = new Error('Goal not found'); e.status = 404; throw e; }
            const remaining = goals[idx].current;

            if (remaining > 0) {
                const users = await readJSON(req.userStore);
                const uidx  = users.findIndex(u => u.id === req.userId);
                if (uidx !== -1) {
                    const balances = Object.assign({}, DEFAULT_BALANCES, users[uidx].balances || {});
                    balances.checking = parseFloat((balances.checking + remaining).toFixed(2));
                    users[uidx] = Object.assign({}, users[uidx], { balances });
                    await writeJSON(req.userStore, users);
                }
                const activity = await readJSON('savingsGoalActivity');
                activity.push({
                    id: nextId(activity), userId: req.userId, goalId: id, type: 'withdraw',
                    amount: remaining, date: new Date().toLocaleDateString(), timestamp: Date.now()
                });
                await writeJSON('savingsGoalActivity', activity);
            }

            await writeJSON('savingsGoals', goals.filter(g => g.id !== id));
            return { ok: true, returnedToChecking: remaining };
        });
        res.json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

// ── Me: scheduled / recurring transfers ─────────────────────────────────────
const SCHEDULE_FREQUENCIES = new Set(['once', 'weekly', 'biweekly', 'monthly']);

app.get('/api/me/scheduled-transfers', async (req, res) => {
    await runDueScheduledTransfers(req.userId, req.userStore, req.messageStore);
    const schedules = await readJSON('scheduledTransfers');
    const mine = schedules.filter(s => s.userId === req.userId).sort((a, b) => (a.nextRunDate || 0) - (b.nextRunDate || 0));
    res.json(mine);
});

app.post('/api/me/scheduled-transfers', async (req, res) => {
    const body = req.body || {};
    const fromAccount = body.fromAccount === 'savings' ? 'savings' : 'checking';
    const recipient    = String(body.recipient || '').trim();
    const account       = String(body.account || '').trim();
    const amount         = Number(body.amount);
    const frequency       = body.frequency;
    const startDate         = Number(body.startDate);

    if (!recipient) return res.status(400).json({ error: 'Recipient name required' });
    if (!account)   return res.status(400).json({ error: 'Recipient account number required' });
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
    if (!SCHEDULE_FREQUENCIES.has(frequency)) return res.status(400).json({ error: 'Invalid frequency' });
    if (!startDate || isNaN(startDate)) return res.status(400).json({ error: 'Valid start date required' });

    const schedules = await readJSON('scheduledTransfers');
    const record = {
        id: nextId(schedules), userId: req.userId, fromAccount, recipient, account, amount,
        description: String(body.description || '').trim(), frequency,
        nextRunDate: startDate, active: true, createdAt: Date.now(), lastRunAt: null, lastRunStatus: null
    };
    schedules.push(record);
    await writeJSON('scheduledTransfers', schedules);

    // A transfer scheduled for right now (or the past) should execute
    // immediately rather than waiting for the next time this user's balance
    // or schedule list happens to be read.
    await runDueScheduledTransfers(req.userId, req.userStore, req.messageStore);
    const fresh = (await readJSON('scheduledTransfers')).find(s => s.id === record.id);
    res.status(201).json(fresh || record);
});

app.patch('/api/me/scheduled-transfers/:id', async (req, res) => {
    const id = Number(req.params.id);
    const schedules = await readJSON('scheduledTransfers');
    const idx = schedules.findIndex(s => s.id === id && s.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'Scheduled transfer not found' });
    const patch = {};
    if (req.body && req.body.active !== undefined) patch.active = !!req.body.active;
    schedules[idx] = Object.assign({}, schedules[idx], patch);
    await writeJSON('scheduledTransfers', schedules);
    res.json(schedules[idx]);
});

app.delete('/api/me/scheduled-transfers/:id', async (req, res) => {
    const id = Number(req.params.id);
    const schedules = await readJSON('scheduledTransfers');
    await writeJSON('scheduledTransfers', schedules.filter(s => !(s.id === id && s.userId === req.userId)));
    res.json({ ok: true });
});

// ── Me: account statement ────────────────────────────────────────────────────
// Reconstructs a month's activity + opening/closing balance purely from
// existing timestamped records plus the current balance — there's no stored
// historical snapshot, so: closingBalance(month) = currentBalance - (every
// signed delta that happened AFTER the month ended); openingBalance(month) =
// closingBalance(month) - (every signed delta that happened DURING the
// month). Both are exact as long as every balance-affecting event for the
// account is accounted for below. An admin-forced balance edit (which
// bypasses /api/me/balances/adjust and every route in this file) has no
// discrete event to reconstruct from and will not appear as a line item.
app.get('/api/me/statement', async (req, res) => {
    const account = req.query.account === 'savings' ? 'savings' : 'checking';
    const monthParam = String(req.query.month || '');
    const m = /^(\d{4})-(\d{2})$/.exec(monthParam);
    if (!m) return res.status(400).json({ error: 'month must be in YYYY-MM format' });
    const year = Number(m[1]);
    const mon0 = Number(m[2]) - 1;
    const monthStart = new Date(year, mon0, 1).getTime();
    const monthEnd   = new Date(year, mon0 + 1, 1).getTime();
    const now = Date.now();

    const users = await readJSON(req.userStore);
    const user  = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const balances = Object.assign({}, DEFAULT_BALANCES, user.balances || {});
    const currentBalance = balances[account] !== undefined ? balances[account] : 0;

    const [txs, pays, purchs, creditActivity, loans, loanPayments, goalActivity] = await Promise.all([
        readJSON('transactions'), readJSON('payments'), readJSON('purchases'),
        readJSON('creditActivity'), readJSON('loans'), readJSON('loanPayments'), readJSON('savingsGoalActivity')
    ]);

    const events = [];
    txs.filter(t => t.userId === req.userId && t.fromAccount === account).forEach(t => {
        events.push({ timestamp: t.timestamp || 0, amount: -(t.amount || 0), label: 'Transfer to ' + (t.recipient || 'recipient') });
    });
    pays.filter(p => p.userId === req.userId && p.fromAccount === account).forEach(p => {
        events.push({ timestamp: p.timestamp || 0, amount: -(p.amount || 0), label: (p.type || 'Bill') + ' bill payment' });
    });
    if (account === 'checking') {
        purchs.filter(p => p.userId === req.userId).forEach(p => {
            const n = p.items ? p.items.length : 0;
            events.push({ timestamp: p.timestamp || 0, amount: -(p.total || 0), label: 'Store purchase (' + n + ' item' + (n !== 1 ? 's' : '') + ')' });
        });
        creditActivity.filter(a => a.userId === req.userId && a.type === 'payment').forEach(a => {
            events.push({ timestamp: a.timestamp || 0, amount: -(a.amount || 0), label: 'Credit card payment' });
        });
        loanPayments.filter(lp => lp.userId === req.userId).forEach(lp => {
            events.push({ timestamp: lp.timestamp || 0, amount: -(lp.amount || 0), label: 'Loan payment' });
        });
        loans.filter(l => l.userId === req.userId).forEach(l => {
            events.push({ timestamp: l.openedAt || 0, amount: (l.principal || 0), label: 'Loan proceeds deposited' });
        });
        goalActivity.filter(a => a.userId === req.userId).forEach(a => {
            events.push({
                timestamp: a.timestamp || 0,
                amount: a.type === 'withdraw' ? (a.amount || 0) : -(a.amount || 0),
                label: (a.type === 'withdraw' ? 'Savings goal withdrawal' : 'Savings goal contribution')
            });
        });
    }

    events.forEach(e => { e.date = new Date(e.timestamp).toLocaleDateString(); });
    events.sort((a, b) => a.timestamp - b.timestamp);

    const afterMonth = events.filter(e => e.timestamp >= monthEnd);
    const closingBalance = parseFloat((currentBalance - afterMonth.reduce((s, e) => s + e.amount, 0)).toFixed(2));

    const inMonth = events.filter(e => e.timestamp >= monthStart && e.timestamp < monthEnd);
    const openingBalance = parseFloat((closingBalance - inMonth.reduce((s, e) => s + e.amount, 0)).toFixed(2));
    const totalDebits  = parseFloat(inMonth.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0).toFixed(2));
    const totalCredits = parseFloat(inMonth.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0).toFixed(2));

    res.json({
        account, month: monthParam,
        openingBalance, closingBalance, totalDebits, totalCredits,
        events: inMonth,
        isCurrentMonth: monthStart <= now && now < monthEnd,
        generatedAt: now
    });
});

// ── Me: stats ─────────────────────────────────────────────────────────────────
app.get('/api/me/stats', async (req, res) => {
    const users    = await readJSON(req.userStore);
    const user     = users.find(u => u.id === req.userId);
    const userData = user ? (user.userData || Object.assign({}, DEFAULT_USER_DATA)) : Object.assign({}, DEFAULT_USER_DATA);

    const [allTxs, allPays, allPurchs] = await Promise.all([
        readJSON('transactions'), readJSON('payments'), readJSON('purchases')
    ]);
    const txs    = allTxs.filter(t => t.userId === req.userId);
    const pays   = allPays.filter(p => p.userId === req.userId);
    const purchs = allPurchs.filter(p => p.userId === req.userId);

    const totalSpentEcommerce = purchs.reduce((s, p) => s + (p.total   || 0), 0);
    const totalSpentBills     = pays.reduce((s, p)   => s + (p.amount  || 0), 0);
    const totalTransferred    = txs.reduce((s, t)    => s + (t.amount  || 0), 0);

    const txPts    = txs.reduce((s, t)    => s + (t.pointsEarned || 0), 0);
    const payPts   = pays.reduce((s, p)   => s + (p.pointsEarned || 0), 0);
    const purchPts = purchs.reduce((s, p) => s + (p.pointsEarned || 0), 0);
    const totalPts = txPts + payPts + purchPts;

    const bankingSkill   = Math.min(100, Math.round((txs.length    / 10) * 100));
    const ecommerceSkill = Math.min(100, Math.round((purchs.length / 10) * 100));
    const billSkill      = Math.min(100, Math.round((pays.length   / 10) * 100));
    const planningSkill  = Math.min(100, Math.round(((txs.length + pays.length + purchs.length) / 30) * 100));
    const mgmtSkill      = userData ? Math.min(100, Math.round((userData.level / 20) * 100)) : 0;

    res.json({
        user: userData,
        txCount: txs.length, payCount: pays.length, purchCount: purchs.length,
        totalSpentEcommerce, totalSpentBills, totalTransferred,
        txPts, payPts, purchPts, totalPts,
        bankingSkill, ecommerceSkill, billSkill, planningSkill, mgmtSkill
    });
});

// ── Me: recent activity ───────────────────────────────────────────────────────
app.get('/api/me/activity', async (req, res) => {
    const limit  = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const [allTxs, allPays, allPurchs, allCreditActivity, allLoanPayments, allGoalActivity, allGoals] = await Promise.all([
        readJSON('transactions'), readJSON('payments'), readJSON('purchases'),
        readJSON('creditActivity'), readJSON('loanPayments'), readJSON('savingsGoalActivity'), readJSON('savingsGoals')
    ]);
    const txs    = allTxs.filter(t => t.userId === req.userId);
    const pays   = allPays.filter(p => p.userId === req.userId);
    const purchs = allPurchs.filter(p => p.userId === req.userId);
    const cardActivity = allCreditActivity.filter(a => a.userId === req.userId);
    const loanPays      = allLoanPayments.filter(p => p.userId === req.userId);
    const goalActivity  = allGoalActivity.filter(a => a.userId === req.userId);
    const goalNames     = {};
    allGoals.forEach(g => { goalNames[g.id] = g.name; });

    const events = [];
    txs.forEach(t => events.push({
        type:         'transfer',
        icon:         '\uD83D\uDCB8',
        label:        'Transfer to ' + (t.recipient || '?'),
        detail:       '\u0192' + Number(t.amount).toFixed(2),
        timestamp:    t.timestamp || 0,
        date:         t.date,
        pointsEarned: t.pointsEarned || 0
    }));
    pays.forEach(p => events.push({
        type:         'payment',
        icon:         '\uD83E\uDDFE',
        label:        (p.type || 'Bill') + ' bill paid',
        detail:       '\u0192' + Number(p.amount).toFixed(2),
        timestamp:    p.timestamp || 0,
        date:         p.date,
        pointsEarned: p.pointsEarned || 0
    }));
    purchs.forEach(p => events.push({
        type:         'purchase',
        icon:         '\uD83D\uDED2',
        label:        'Purchase (' + (p.items ? p.items.length : 0) + ' item' + (p.items && p.items.length !== 1 ? 's' : '') + ')',
        detail:       '\u0192' + Number(p.total).toFixed(2),
        timestamp:    p.timestamp || 0,
        date:         p.date,
        pointsEarned: p.pointsEarned || 0
    }));
    cardActivity.forEach(a => events.push({
        type:         'creditcard',
        icon:         '💳',
        label:        a.type === 'payment' ? 'Credit card payment' : 'Credit card purchase (' + (a.description || 'purchase') + ')',
        detail:       'ƒ' + Number(a.amount).toFixed(2),
        timestamp:    a.timestamp || 0,
        date:         a.date,
        pointsEarned: 0
    }));
    loanPays.forEach(lp => events.push({
        type:         'loan',
        icon:         '🏠',
        label:        'Loan payment',
        detail:       'ƒ' + Number(lp.amount).toFixed(2),
        timestamp:    lp.timestamp || 0,
        date:         lp.date,
        pointsEarned: 0
    }));
    goalActivity.forEach(a => {
        const goalName = goalNames[a.goalId] || 'goal';
        events.push({
            type:         'savingsgoal',
            icon:         '🎯',
            label:        (a.type === 'withdraw' ? 'Withdrew from ' : 'Contributed to ') + goalName,
            detail:       'ƒ' + Number(a.amount).toFixed(2),
            timestamp:    a.timestamp || 0,
            date:         a.date,
            pointsEarned: 0
        });
    });
    events.sort((a, b) => b.timestamp - a.timestamp);
    res.json(limit ? events.slice(0, limit) : events);
});

// ── Admin messages — system (no auth required, must be before auth-gated routes)
app.post('/api/admin/messages/system', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { subject, body, recipientId, type, category } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
    const messages = await readJSON(req.messageStore);
    const record   = {
        id:          nextId(messages),
        senderId:    0,
        senderName:  'System',
        senderEmail: null,
        recipientId: recipientId,
        subject:     subject.trim(),
        body:        body.trim(),
        type:        type || 'info',
        category:    category || 'system',
        sentAt:      Date.now(),
        readBy:      []
    };
    messages.push(record);
    await writeJSON(req.messageStore, messages);
    res.status(201).json(record);
});

// ── Admin messages ────────────────────────────────────────────────────────────
// senderId 0 = auto-generated system alerts (private per-user notifications
// like "Bill overdue" or "Low balance alert") — these are NOT things an
// admin "sent" and must not appear in the admin-authored Sent Messages log,
// which would otherwise leak every participant's private inbox contents.
// Pass ?includeSystem=1 to audit everything.
app.get('/api/admin/messages', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const all = await readJSON(req.messageStore);
    res.json(req.query.includeSystem ? all : all.filter(m => m.senderId !== 0));
});

app.post('/api/admin/messages', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { subject, body, recipientId, type, senderEmail, category } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
    const messages = await readJSON(req.messageStore);
    const users    = await readJSON(req.userStore);
    const sender   = users.find(u => u.id === req.userId);
    const record   = {
        id:          nextId(messages),
        senderId:    req.userId,
        senderName:  sender ? (sender.fullName || sender.username) : 'Unknown',
        senderEmail: (senderEmail || '').trim() || null,
        recipientId: recipientId,
        subject:     subject.trim(),
        body:        body.trim(),
        type:        type || 'info',
        category:    category || 'system',
        sentAt:      Date.now(),
        readBy:      []
    };
    messages.push(record);
    await writeJSON(req.messageStore, messages);
    res.status(201).json(record);
});

app.delete('/api/admin/messages/:id', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id  = Number(req.params.id);
    const all = await readJSON(req.messageStore);
    await writeJSON(req.messageStore, all.filter(m => m.id !== id));
    res.json({ ok: true });
});

// ── Admin: challenge management ───────────────────────────────────────────────

// PATCH /api/admin/challenges/:id — update any challenge regardless of owner
// The admin "All Challenges" table is a cross-user view deduped by title
// (getChallengesForUser, one row per title), so :id there is just one
// arbitrary participant's copy — patching only that row would silently
// change the challenge for one random user while everyone else's copy of
// the "same" challenge stayed on the old title/points/condition. Template
// fields (everything except completed/completedAt, which are per-user
// progress, not part of the definition) are fanned out to every row that
// shares the target's title, matching how POST (create) already pushes a
// new challenge to every participant.
app.patch('/api/admin/challenges/:id', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id  = Number(req.params.id);
    const all = await readJSON(req.challengeStore);
    const target = all.find(c => c.id === id);
    if (!target) return res.status(404).json({ error: 'Challenge not found' });
    const { completed, completedAt, id: _ignoredId, userId: _ignoredUserId, ...templatePatch } = req.body || {};
    const updated = all.map(c => c.title === target.title ? Object.assign({}, c, templatePatch) : c);
    await writeJSON(req.challengeStore, updated);
    res.json(updated.find(c => c.id === id));
});

// DELETE /api/admin/challenges/:id — delete this challenge definition for
// every participant who has it (matched by title — see PATCH above).
app.delete('/api/admin/challenges/:id', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id  = Number(req.params.id);
    const all = await readJSON(req.challengeStore);
    const target = all.find(c => c.id === id);
    if (!target) return res.status(404).json({ error: 'Challenge not found' });
    await writeJSON(req.challengeStore, all.filter(c => c.title !== target.title));
    res.json({ ok: true });
});

// DELETE /api/admin/challenges — wipe ALL challenges (admin only)
app.delete('/api/admin/challenges', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    await writeJSON(req.challengeStore, []);
    res.json({ ok: true });
});

// POST /api/admin/challenges — create a new challenge definition and push a
// live instance of it to every approved participant. Challenges are stored
// per-user (not as shared templates), so a challenge the admin "creates"
// here must be seeded out the same way ALL_DEFAULT_CHALLENGES are —
// otherwise it would only ever exist under the admin's own account.
app.post('/api/admin/challenges', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const {
        title, description, category, active, points, florins,
        condition, conditionValue, customField, customOperator,
        extraConditions, conditionLogic
    } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title required' });

    const users        = await readJSON(req.userStore);
    const participants = users.filter(u => u.role === 'participant' && u.status === 'approved');
    const challenges   = await readJSON(req.challengeStore);
    let id      = nextId(challenges);
    const now   = Date.now();
    const created = participants.map(u => ({
        id:              id++,
        userId:          u.id,
        title,
        description:     description || '',
        category:        category || 'general',
        active:          active !== false,
        completed:       false,
        createdAt:       now,
        points:          points || 0,
        florins:         florins || 0,
        condition:       condition || 'manual',
        conditionValue:  conditionValue !== undefined ? conditionValue : null,
        customField:     customField || null,
        customOperator:  customOperator || null,
        extraConditions: Array.isArray(extraConditions) ? extraConditions : [],
        conditionLogic:  conditionLogic || 'all'
    }));
    await writeJSON(req.challengeStore, challenges.concat(created));
    res.status(201).json(created);
});

// POST /api/admin/challenges/seed — seed default challenges for every approved participant
app.post('/api/admin/challenges/seed', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const users = await readJSON(req.userStore);
    const participants = users.filter(u => u.role === 'participant' && u.status === 'approved');
    for (const u of participants) await seedChallengesForUser(u.id);
    res.json({ ok: true, seeded: participants.length });
});

// POST /api/admin/challenges/reseed — add any missing default challenges for every approved participant
app.post('/api/admin/challenges/reseed', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const challenges   = await readJSON(req.challengeStore);
    const users        = await readJSON(req.userStore);
    const participants = users.filter(u => u.role === 'participant' && u.status === 'approved');
    const added        = [];
    let   nextChalId   = nextId(challenges);
    const now          = Date.now();

    participants.forEach(u => {
        const existing      = challenges.filter(c => c.userId === u.id);
        const existingTitles = new Set(existing.map(c => c.title));
        ALL_DEFAULT_CHALLENGES.forEach(c => {
            if (!existingTitles.has(c.title)) {
                const rec = Object.assign({}, c, { id: nextChalId++, userId: u.id, createdAt: now, active: true, completed: false });
                challenges.push(rec);
                added.push(rec);
            }
        });
    });

    await writeJSON(req.challengeStore, challenges);
    res.json(added);
});

// ── Bills API ─────────────────────────────────────────────────────────────────
// Bill templates are shared/admin-managed (like DEFAULT_PRODUCTS). Each
// user's actual bill for "this month" is a separate per-user 'billCycles'
// record generated lazily from a template — see ensureCurrentBillCycles().
// billingType 'usage' bills compute their amount from a generated meter
// reading (baseFee + usage*ratePerUnit) instead of a fixed amount, the way
// real electric/water/gas bills fluctuate month to month; 'flat' bills
// (internet, phone, property tax) charge the same `amount` every cycle,
// matching how those are typically billed as flat subscriptions/assessments
// in the US.
const DEFAULT_BILLS = [
    { id: 1, name: 'Electricity',  icon: '⚡', category: 'electricity', billingType: 'usage', amount: 89.50,   unit: 'kWh',    ratePerUnit: 0.15,  baseFee: 8.00,  usageMin: 400,  usageMax: 900,  accountNumber: '1234560',    gradient: 'linear-gradient(135deg,#fbbf24,#f59e0b)', dueDateDay: 25, lateFeeRate: 0.05, graceDays: 5, active: true },
    { id: 2, name: 'Water',        icon: '💧', category: 'water',       billingType: 'usage', amount: 45.00,   unit: 'gallons', ratePerUnit: 0.006, baseFee: 15.00, usageMin: 3000, usageMax: 8000, accountNumber: '1234560',    gradient: 'linear-gradient(135deg,#3b82f6,#2563eb)', dueDateDay: 28, lateFeeRate: 0.05, graceDays: 5, active: true },
    { id: 3, name: 'Internet',     icon: '🌐', category: 'internet',    billingType: 'flat',  amount: 79.99,   unit: null,     ratePerUnit: null,  baseFee: null,  usageMin: null, usageMax: null, accountNumber: '9876543',    gradient: 'linear-gradient(135deg,#10b981,#059669)', dueDateDay: 1,  lateFeeRate: 0.05, graceDays: 5, active: true },
    { id: 4, name: 'Property Tax', icon: '🏠', category: 'tax',         billingType: 'flat',  amount: 1250.00, unit: null,     ratePerUnit: null,  baseFee: null,  usageMin: null, usageMax: null, accountNumber: '1234560',    gradient: 'linear-gradient(135deg,#8b5cf6,#7c3aed)', dueDateDay: 15, lateFeeRate: 0.05, graceDays: 10, active: true },
    { id: 5, name: 'Phone',        icon: '📱', category: 'phone',       billingType: 'flat',  amount: 55.00,   unit: null,     ratePerUnit: null,  baseFee: null,  usageMin: null, usageMax: null, accountNumber: '2175550123', gradient: 'linear-gradient(135deg,#ec4899,#db2777)', dueDateDay: 30, lateFeeRate: 0.05, graceDays: 5, active: true },
    { id: 6, name: 'Gas',          icon: '🔥', category: 'gas',         billingType: 'usage', amount: 65.75,   unit: 'therms', ratePerUnit: 1.10,  baseFee: 10.00, usageMin: 30,   usageMax: 70,   accountNumber: '5551234',    gradient: 'linear-gradient(135deg,#f97316,#ea580c)', dueDateDay: 5,  lateFeeRate: 0.05, graceDays: 5, active: true }
];

async function seedDefaultBills() {
    const bills = await readJSON('bills');
    if (!bills || bills.length === 0) {
        await writeJSON('bills', DEFAULT_BILLS);
    }
}

// GET /api/bills — public
app.get('/api/bills', async (_req, res) => {
    const bills = await readJSON('bills');
    res.json(bills.filter(b => b.active !== false));
});

// POST /api/bills — admin only
app.post('/api/bills', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const bills = await readJSON('bills');
    const bill  = Object.assign({ active: true }, req.body, { id: nextId(bills) });
    bills.push(bill);
    await writeJSON('bills', bills);
    res.status(201).json(bill);
});

// PUT /api/bills/:id — admin only
app.put('/api/bills/:id', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const bills = await readJSON('bills');
    const idx   = bills.findIndex(b => String(b.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    bills[idx] = Object.assign({}, bills[idx], req.body, { id: bills[idx].id });
    await writeJSON('bills', bills);
    res.json(bills[idx]);
});

// DELETE /api/bills/:id — admin only
app.delete('/api/bills/:id', async (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const all   = await readJSON('bills');
    const bills = all.filter(b => String(b.id) !== String(req.params.id));
    await writeJSON('bills', bills);
    res.json({ ok: true });
});

// ── Me: bills (per-user monthly bill cycles) ────────────────────────────────
// Bill templates (the 'bills' store, admin-managed, plus each user's own
// 'customBills') describe a recurring bill; a 'billCycles' record is the
// actual per-user, per-month instance of one — generated lazily on read the
// same way scheduled transfers execute lazily, so no background job is
// needed. An unpaid cycle carries forward (accruing late fee, never
// silently replaced) until the user pays it; only then does the next
// month's cycle get generated, with a freshly generated usage reading for
// usage-based bills.
function currentCycleMonth() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function randomUsage(min, max) {
    return Math.round(min + Math.random() * (max - min));
}

function computeBillAmount(def) {
    if (def.billingType === 'usage') {
        const usage  = randomUsage(def.usageMin, def.usageMax);
        const amount = parseFloat(((def.baseFee || 0) + usage * def.ratePerUnit).toFixed(2));
        return { usage, amount };
    }
    return { usage: null, amount: def.amount };
}

function billCycleDueDate(def, cycleMonth) {
    const [y, m] = cycleMonth.split('-').map(Number);
    const day = Math.min(Math.max(def.dueDateDay || 25, 1), 28);
    return new Date(y, m - 1, day).getTime();
}

async function ensureCurrentBillCycles(userId) {
    const [templates, customBills, cycles] = await Promise.all([
        readJSON('bills'), readJSON('customBills'), readJSON('billCycles')
    ]);
    const defs = templates.filter(b => b.active !== false).map(b => Object.assign({ defKey: 'catalog:' + b.id }, b))
        .concat(customBills.filter(b => b.userId === userId && b.active !== false).map(b => Object.assign({ defKey: 'custom:' + b.id }, b)));

    const month = currentCycleMonth();
    let all = cycles;
    let changed = false;

    for (const def of defs) {
        const mine   = all.filter(c => c.userId === userId && c.billDefKey === def.defKey);
        const latest = mine.reduce((a, b) => (!a || b.id > a.id) ? b : a, null);
        const needsNew = !latest || (latest.status === 'paid' && latest.cycleMonth !== month);
        if (!needsNew) continue;
        const { usage, amount } = computeBillAmount(def);
        const record = {
            id: nextId(all), userId, billDefKey: def.defKey,
            name: def.name, icon: def.icon, category: def.category, billingType: def.billingType,
            unit: def.unit, ratePerUnit: def.ratePerUnit, baseFee: def.baseFee,
            accountNumber: def.accountNumber, gradient: def.gradient,
            usage, amount, cycleMonth: month, dueDate: billCycleDueDate(def, month),
            lateFeeRate: def.lateFeeRate != null ? def.lateFeeRate : 0.05,
            graceDays:   def.graceDays   != null ? def.graceDays   : 5,
            status: 'open', createdAt: Date.now(), paidAt: null
        };
        all = all.concat([record]);
        changed = true;
    }
    if (changed) await writeJSON('billCycles', all);
    return all.filter(c => c.userId === userId);
}

// Overdue/late-fee status is derived purely from elapsed time since the due
// date, recomputed fresh on every read — the same "compute on read" pattern
// used for e-commerce order status, so nothing needs a background sweep.
function computeBillCycleStatus(cycle) {
    if (cycle.status === 'paid') return { overdue: false, lateFee: 0, totalDue: 0, daysUntilDue: null, daysOverdue: 0 };
    const now      = Date.now();
    const graceMs  = (cycle.graceDays || 0) * 24 * 60 * 60 * 1000;
    const overdue  = now > cycle.dueDate + graceMs;
    const dayMs    = 24 * 60 * 60 * 1000;
    const lateFee  = overdue ? parseFloat((cycle.amount * (cycle.lateFeeRate || 0)).toFixed(2)) : 0;
    const totalDue = parseFloat((cycle.amount + lateFee).toFixed(2));
    return {
        overdue, lateFee, totalDue,
        daysUntilDue: overdue ? null : Math.max(0, Math.ceil((cycle.dueDate - now) / dayMs)),
        daysOverdue:  overdue ? Math.floor((now - cycle.dueDate) / dayMs) : 0
    };
}

// Notify-on-first-observe: fires an overdue/late-fee message the first time
// a cycle is seen past its grace period, then flags it so it never repeats
// for that cycle — mirrors the lazy-execution-on-read pattern already used
// for scheduled transfers, just for a read-only status instead of a payment.
async function notifyOverdueBillsForUser(userId, cycles, messageStore = 'messages') {
    const overdueNow = cycles.filter(c => c.status !== 'paid' && !c.overdueNotified && computeBillCycleStatus(c).overdue);
    if (overdueNow.length === 0) return cycles;
    const all = await readJSON('billCycles');
    overdueNow.forEach(c => {
        const idx = all.findIndex(x => x.id === c.id);
        if (idx !== -1) all[idx] = Object.assign({}, all[idx], { overdueNotified: true });
    });
    await writeJSON('billCycles', all);
    for (const c of overdueNow) {
        const info = computeBillCycleStatus(c);
        await pushSystemMessage(userId, {
            subject: 'Bill overdue: ' + c.name,
            body: 'Your ' + c.name + ' bill of ƒ' + c.amount.toFixed(2) + ' is now overdue. A late fee of ƒ' +
                  info.lateFee.toFixed(2) + ' has been added — total due is ƒ' + info.totalDue.toFixed(2) + '.',
            type: 'warning', category: 'utilities'
        }, messageStore);
    }
    return cycles.map(c => overdueNow.some(o => o.id === c.id) ? Object.assign({}, c, { overdueNotified: true }) : c);
}

app.get('/api/me/bills', async (req, res) => {
    let cycles = await ensureCurrentBillCycles(req.userId);
    // Locked so two concurrent GETs can't both observe the dedup flag as
    // unset and each push a duplicate overdue message.
    cycles = await withUserLock(req.userId, () => notifyOverdueBillsForUser(req.userId, cycles, req.messageStore));
    const enriched = cycles.map(c => Object.assign({}, c, computeBillCycleStatus(c)));
    enriched.sort((a, b) => (a.dueDate || 0) - (b.dueDate || 0));
    res.json(enriched);
});

app.post('/api/me/bills/:cycleId/pay', async (req, res) => {
    const cycleId = Number(req.params.cycleId);
    try {
        const result = await withUserLock(req.userId, async () => {
            const cycles = await readJSON('billCycles');
            const idx    = cycles.findIndex(c => c.id === cycleId && c.userId === req.userId);
            if (idx === -1) { const e = new Error('Bill not found'); e.status = 404; throw e; }
            const cycle = cycles[idx];
            if (cycle.status === 'paid') { const e = new Error('Bill is already paid'); e.status = 409; throw e; }

            const statusInfo = computeBillCycleStatus(cycle);
            const totalDue    = statusInfo.totalDue;

            const users = await readJSON(req.userStore);
            const uidx  = users.findIndex(u => u.id === req.userId);
            if (uidx === -1) { const e = new Error('User not found'); e.status = 404; throw e; }
            const balances = Object.assign({}, DEFAULT_BALANCES, users[uidx].balances || {});

            let account = 'checking';
            if (totalDue > balances[account]) {
                if (totalDue <= balances.savings) account = 'savings';
                else { const e = new Error('Insufficient funds in both accounts. Need ƒ' + totalDue.toFixed(2)); e.status = 409; throw e; }
            }
            const current = balances[account];
            const next    = parseFloat((current - totalDue).toFixed(2));
            balances[account] = next;

            const onTime       = !statusInfo.overdue;
            const pointsEarned = 45 + (onTime ? 15 : 0);
            const coinsEarned  = Math.floor(totalDue / 10);

            const userData = Object.assign({}, DEFAULT_USER_DATA, users[uidx].userData || {});
            userData.points            = (userData.points || 0) + pointsEarned;
            userData.pointsToNextLevel = (userData.pointsToNextLevel != null ? userData.pointsToNextLevel : 1000) - pointsEarned;
            userData.completedTasks    = (userData.completedTasks || 0) + 1;
            userData.coins              = (userData.coins || 0) + coinsEarned;
            let leveledUp = false, newLevel = 0;
            if (userData.pointsToNextLevel <= 0) {
                if (userData.level === 1) {
                    const challenges = await readJSON(req.challengeStore);
                    const reqMet = LEVEL_1_REQUIRED_CONDITIONS.every(cond =>
                        challenges.some(c => c.userId === req.userId && c.condition === cond && c.completed)
                    );
                    if (reqMet) {
                        userData.level++;
                        userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                        leveledUp = true; newLevel = userData.level;
                    } else {
                        userData.pointsToNextLevel = 0;
                    }
                } else {
                    userData.level++;
                    userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                    leveledUp = true; newLevel = userData.level;
                }
            }

            const updatedUser = Object.assign({}, users[uidx], { balances, userData });
            users[uidx] = updatedUser;
            await writeJSON(req.userStore, users);
            await maybeFireBalanceAlerts(updatedUser, account, current, next, -totalDue, 'utilities', req.messageStore);

            cycles[idx] = Object.assign({}, cycle, { status: 'paid', paidAt: Date.now(), paidAmount: totalDue, lateFeePaid: statusInfo.lateFee });
            await writeJSON('billCycles', cycles);

            const payments = await readJSON('payments');
            const paymentRecord = {
                id: nextId(payments), userId: req.userId,
                type: cycle.name, amount: totalDue, accountNumber: cycle.accountNumber,
                fromAccount: account, date: new Date().toLocaleDateString(), timestamp: Date.now(),
                pointsEarned, lateFee: statusInfo.lateFee, usage: cycle.usage, unit: cycle.unit
            };
            payments.push(paymentRecord);
            await writeJSON('payments', payments);

            return {
                cycle: Object.assign({}, cycles[idx], computeBillCycleStatus(cycles[idx])),
                payment: paymentRecord, leveledUp, newLevel, account, balance: next, onTimeBonus: onTime, pointsEarned
            };
        });
        res.status(201).json(result);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message || 'Server error' });
    }
});

// ── Me: custom bills ─────────────────────────────────────────────────────────
const CUSTOM_BILL_CATEGORIES = new Set(['electricity', 'water', 'gas', 'internet', 'phone', 'tax', 'other']);
const CUSTOM_BILL_ICONS = { electricity: '⚡', water: '💧', gas: '🔥', internet: '🌐', phone: '📱', tax: '🏠', other: '🧾' };

app.get('/api/me/bills/custom', async (req, res) => {
    const all = await readJSON('customBills');
    res.json(all.filter(b => b.userId === req.userId));
});

app.post('/api/me/bills/custom', async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Bill name required' });
    const category    = CUSTOM_BILL_CATEGORIES.has(body.category) ? body.category : 'other';
    const billingType = body.billingType === 'usage' ? 'usage' : 'flat';
    const dueDateDay  = Math.min(28, Math.max(1, parseInt(body.dueDateDay, 10) || 25));
    const base = {
        id: 0, userId: req.userId, name, category, icon: CUSTOM_BILL_ICONS[category],
        billingType, accountNumber: String(body.accountNumber || '').trim(),
        gradient: 'linear-gradient(135deg,#64748b,#475569)',
        dueDateDay, lateFeeRate: 0.05, graceDays: 5, active: true, createdAt: Date.now()
    };

    const all = await readJSON('customBills');
    let record;
    if (billingType === 'usage') {
        const unit        = String(body.unit || '').trim();
        const ratePerUnit = Number(body.ratePerUnit);
        const usageMin     = Number(body.usageMin);
        const usageMax     = Number(body.usageMax);
        if (!unit) return res.status(400).json({ error: 'Usage unit required' });
        if (!ratePerUnit || ratePerUnit <= 0) return res.status(400).json({ error: 'Valid rate per unit required' });
        if (!usageMin || !usageMax || usageMax <= usageMin) return res.status(400).json({ error: 'Valid usage range required (max must exceed min)' });
        record = Object.assign({}, base, {
            unit, ratePerUnit, baseFee: Math.max(0, Number(body.baseFee) || 0), usageMin, usageMax, amount: null
        });
    } else {
        const amount = Number(body.amount);
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
        record = Object.assign({}, base, {
            unit: null, ratePerUnit: null, baseFee: null, usageMin: null, usageMax: null, amount
        });
    }
    record.id = nextId(all);
    all.push(record);
    await writeJSON('customBills', all);
    res.status(201).json(record);
});

app.put('/api/me/bills/custom/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON('customBills');
    const idx = all.findIndex(b => b.id === id && b.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'Custom bill not found' });
    const body  = req.body || {};
    const patch = {};
    if (body.name !== undefined)          patch.name          = String(body.name).trim();
    if (body.accountNumber !== undefined) patch.accountNumber = String(body.accountNumber).trim();
    if (body.active !== undefined)        patch.active        = !!body.active;
    if (all[idx].billingType === 'flat' && body.amount !== undefined) {
        const amount = Number(body.amount);
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
        patch.amount = amount;
    }
    if (all[idx].billingType === 'usage' && body.ratePerUnit !== undefined) {
        const ratePerUnit = Number(body.ratePerUnit);
        if (!ratePerUnit || ratePerUnit <= 0) return res.status(400).json({ error: 'Valid rate per unit required' });
        patch.ratePerUnit = ratePerUnit;
    }
    all[idx] = Object.assign({}, all[idx], patch);
    await writeJSON('customBills', all);
    res.json(all[idx]);
});

app.delete('/api/me/bills/custom/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON('customBills');
    await writeJSON('customBills', all.filter(b => !(b.id === id && b.userId === req.userId)));
    // Drop any bill cycles this custom bill generated so it stops appearing.
    const cycles = await readJSON('billCycles');
    await writeJSON('billCycles', cycles.filter(c => !(c.userId === req.userId && c.billDefKey === 'custom:' + id)));
    res.json({ ok: true });
});

// ── E-Commerce: product catalog ─────────────────────────────────────────────
// A shared (not per-user) catalog, seeded once at boot the same way
// DEFAULT_BILLS is — read-only from the client's perspective; there's no
// admin catalog-management UI yet, so no write routes are exposed.
const DEFAULT_PRODUCTS = [
    // ── Women ──
    { id: 1,  name: 'Pink Dress Shirt',          brand: 'BRANDY',            category: 'women',       price: 45.99,  originalPrice: null,   rating: 4.0, reviewCount: 118, badge: 'New',         icon: '👚', stock: 42,  description: 'Elegant dress shirt for formal occasions.' },
    { id: 2,  name: 'Floral Wrap Dress',          brand: 'Meridian',          category: 'women',       price: 68.00,  originalPrice: null,   rating: 4.4, reviewCount: 212, badge: null,          icon: '👗', stock: 36,  description: 'Lightweight wrap dress with a floral print, perfect for warm-weather days.' },
    { id: 3,  name: 'Cropped Denim Jacket',       brand: 'Meridian',          category: 'women',       price: 74.50,  originalPrice: null,   rating: 4.3, reviewCount: 89,  badge: 'New',         icon: '🧥', stock: 27,  description: 'Cropped denim jacket that layers over almost anything.' },
    { id: 4,  name: 'High-Rise Yoga Leggings',    brand: 'Aurora Active',     category: 'women',       price: 42.00,  originalPrice: null,   rating: 4.7, reviewCount: 530, badge: 'Best Seller', icon: '🧘‍♀️', stock: 95, description: 'Squat-proof high-rise leggings with a four-way stretch fabric.' },
    { id: 5,  name: 'Cashmere Blend Scarf',       brand: 'Wintermere',        category: 'women',       price: 39.99,  originalPrice: null,   rating: 4.5, reviewCount: 76,  badge: null,          icon: '🧣', stock: 58,  description: 'Soft cashmere-blend scarf for cold-weather commutes.' },
    { id: 6,  name: 'Ankle Strap Heels',          brand: 'Meridian',          category: 'women',       price: 89.00,  originalPrice: 120.00, rating: 4.1, reviewCount: 143, badge: 'Sale',        icon: '👠', stock: 19,  description: 'Ankle-strap block heels comfortable enough for all-day wear.' },
    // ── Men ──
    { id: 7,  name: 'Green Cotton Sweatshirt',    brand: 'EMJOL',             category: 'men',         price: 35.99,  originalPrice: null,   rating: 4.2, reviewCount: 97,  badge: null,          icon: '👕', stock: 63,  description: 'Comfortable cotton sweatshirt perfect for winter weather.' },
    { id: 8,  name: 'Denim Jeans',                brand: "LEVI'S",            category: 'men',         price: 65.99,  originalPrice: null,   rating: 4.1, reviewCount: 305, badge: null,          icon: '👖', stock: 71,  description: 'Classic fit denim jeans built to last.' },
    { id: 9,  name: 'Slim Fit Chino Pants',       brand: 'Foundry',           category: 'men',         price: 54.99,  originalPrice: null,   rating: 4.2, reviewCount: 198, badge: null,          icon: '👖', stock: 48,  description: 'Slim fit chinos that go from the office to the weekend.' },
    { id: 10, name: 'Flannel Button-Down Shirt',  brand: 'Foundry',           category: 'men',         price: 47.50,  originalPrice: null,   rating: 4.4, reviewCount: 65,  badge: 'New',         icon: '👕', stock: 34,  description: 'Brushed flannel shirt with a soft, warm feel.' },
    { id: 11, name: 'Merino Wool Sweater',        brand: 'Northline',         category: 'men',         price: 79.99,  originalPrice: null,   rating: 4.6, reviewCount: 220, badge: null,          icon: '🧶', stock: 29,  description: 'Breathable merino wool crewneck sweater.' },
    { id: 12, name: 'Classic Leather Belt',       brand: 'Foundry',           category: 'men',         price: 29.99,  originalPrice: null,   rating: 4.0, reviewCount: 54,  badge: null,          icon: '🎽', stock: 82,  description: 'Full-grain leather belt with a brushed metal buckle.' },
    { id: 13, name: 'Performance Golf Polo',      brand: 'Foundry',           category: 'men',         price: 44.00,  originalPrice: 58.00,  rating: 4.3, reviewCount: 112, badge: 'Sale',        icon: '⛳', stock: 40,  description: 'Moisture-wicking polo for the course or everyday wear.' },
    // ── Outdoors ──
    { id: 14, name: 'Winter Jacket',              brand: 'NORTH FACE',        category: 'outdoors',    price: 179.99, originalPrice: 219.99, rating: 4.3, reviewCount: 88,  badge: 'Sale',        icon: '🧥', stock: 22,  description: 'Insulated jacket for cold weather adventures.' },
    { id: 15, name: '2-Person Camping Tent',      brand: 'TrailPeak',         category: 'outdoors',    price: 149.99, originalPrice: null,   rating: 4.5, reviewCount: 301, badge: 'Best Seller', icon: '⛺', stock: 17,  description: 'Weatherproof 2-person tent that sets up in under 5 minutes.' },
    { id: 16, name: 'Insulated Steel Water Bottle', brand: 'TrailPeak',       category: 'outdoors',    price: 24.99,  originalPrice: null,   rating: 4.8, reviewCount: 890, badge: null,          icon: '🧴', stock: 140, description: 'Double-wall insulated bottle that keeps drinks cold for 24 hours.' },
    { id: 17, name: 'Trekking Poles (Pair)',      brand: 'TrailPeak',         category: 'outdoors',    price: 39.99,  originalPrice: null,   rating: 4.4, reviewCount: 76,  badge: null,          icon: '🥾', stock: 45,  description: 'Adjustable aluminum trekking poles with padded grips.' },
    { id: 18, name: 'Compact Camp Stove',         brand: 'TrailPeak',         category: 'outdoors',    price: 54.99,  originalPrice: null,   rating: 4.3, reviewCount: 41,  badge: 'New',         icon: '🔥', stock: 24,  description: 'Foldable backpacking stove that boils water in under 3 minutes.' },
    { id: 19, name: 'All-Weather Hiking Boots',   brand: 'TrailPeak',         category: 'outdoors',    price: 129.00, originalPrice: 159.00, rating: 4.6, reviewCount: 245, badge: 'Sale',        icon: '🥾', stock: 31,  description: 'Waterproof hiking boots with reinforced ankle support.' },
    // ── Cooking ──
    { id: 20, name: '10-Piece Stainless Cookware Set', brand: 'Homestead Kitchen', category: 'cooking', price: 189.99, originalPrice: null,   rating: 4.7, reviewCount: 410, badge: 'Best Seller', icon: '🍳', stock: 14,  description: 'Full stainless steel cookware set for everyday cooking.' },
    { id: 21, name: 'Cast Iron Skillet 12"',      brand: 'Homestead Kitchen', category: 'cooking',     price: 34.99,  originalPrice: null,   rating: 4.9, reviewCount: 670, badge: null,          icon: '🥘', stock: 66,  description: 'Pre-seasoned cast iron skillet built to last generations.' },
    { id: 22, name: "8-Inch Chef's Knife",        brand: 'Homestead Kitchen', category: 'cooking',     price: 59.99,  originalPrice: null,   rating: 4.5, reviewCount: 198, badge: null,          icon: '🔪', stock: 53,  description: 'High-carbon stainless steel chef\'s knife with a full tang.' },
    { id: 23, name: 'Stand Mixer',                brand: 'Homestead Kitchen', category: 'cooking',     price: 249.99, originalPrice: 299.00, rating: 4.6, reviewCount: 155, badge: 'Sale',        icon: '🥣', stock: 12,  description: '5-quart stand mixer with 10 speeds and dough hook attachment.' },
    { id: 24, name: 'Bamboo Cutting Board Set',   brand: 'Homestead Kitchen', category: 'cooking',     price: 27.99,  originalPrice: null,   rating: 4.2, reviewCount: 38,  badge: 'New',         icon: '🪵', stock: 74,  description: 'Set of 3 sustainably sourced bamboo cutting boards.' },
    // ── Electronics ──
    { id: 25, name: 'Wireless Headphones',        brand: 'SONY',              category: 'electronics', price: 299.99, originalPrice: 349.00, rating: 4.5, reviewCount: 512, badge: 'Sale',        icon: '🎧', stock: 26,  description: 'Premium noise-cancelling headphones.' },
    { id: 26, name: 'Smartphone Case',            brand: 'TECH',              category: 'electronics', price: 25.99,  originalPrice: null,   rating: 3.8, reviewCount: 44,  badge: null,          icon: '📱', stock: 120, description: 'Protective case with a sleek design.' },
    { id: 27, name: 'Smart Watch',                brand: 'APPLE',             category: 'electronics', price: 399.00, originalPrice: null,   rating: 4.9, reviewCount: 900, badge: 'Best Seller', icon: '⌚', stock: 33,  description: 'Track fitness, notifications, and health data.' },
    { id: 28, name: 'Gaming Controller',          brand: 'XBOX',              category: 'electronics', price: 69.99,  originalPrice: null,   rating: 4.4, reviewCount: 120, badge: 'New',         icon: '🎮', stock: 57,  description: 'Wireless controller with haptic feedback.' },
    { id: 29, name: 'Portable Bluetooth Speaker', brand: 'Voltaic',           category: 'electronics', price: 59.99,  originalPrice: null,   rating: 4.3, reviewCount: 233, badge: null,          icon: '🔊', stock: 68,  description: 'Waterproof speaker with 12-hour battery life.' },
    // ── Accessories ──
    { id: 30, name: 'Sport Backpack',             brand: 'NIKE',              category: 'accessories', price: 89.99,  originalPrice: null,   rating: 4.7, reviewCount: 380, badge: 'Best Seller', icon: '🎒', stock: 39,  description: 'Durable backpack with multiple compartments.' },
    { id: 31, name: 'Running Shoes',              brand: 'ADIDAS',            category: 'accessories', price: 120.00, originalPrice: null,   rating: 4.8, reviewCount: 640, badge: 'Best Seller', icon: '👟', stock: 44,  description: 'Lightweight running shoes for maximum comfort.' },
    { id: 32, name: 'Leather Handbag',            brand: 'COACH',             category: 'accessories', price: 185.00, originalPrice: null,   rating: 4.6, reviewCount: 96,  badge: 'New',         icon: '👜', stock: 18,  description: 'Elegant leather handbag for everyday use.' },
    { id: 33, name: 'Sunglasses',                 brand: 'RAY-BAN',           category: 'accessories', price: 149.99, originalPrice: null,   rating: 4.0, reviewCount: 210, badge: null,          icon: '🕶️', stock: 52,  description: 'UV-protected polarised sunglasses.' }
];

async function seedDefaultProducts() {
    const products = await readJSON('products');
    if (!products || products.length === 0) {
        await writeJSON('products', DEFAULT_PRODUCTS);
    }
}

// GET /api/products — public catalog, optionally filtered
app.get('/api/products', async (req, res) => {
    let products = await readJSON('products');
    const category = String(req.query.category || '').toLowerCase();
    const onSale    = req.query.onSale === 'true';
    const q         = String(req.query.q || '').toLowerCase().trim();
    if (category && category !== 'all') products = products.filter(p => p.category === category);
    if (onSale) products = products.filter(p => p.badge === 'Sale');
    if (q) products = products.filter(p =>
        p.name.toLowerCase().includes(q) || p.brand.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    );
    res.json(products);
});

// ── E-Commerce: shipping addresses ──────────────────────────────────────────
app.get('/api/me/addresses', async (req, res) => {
    const all  = await readJSON('addresses');
    const mine = all.filter(a => a.userId === req.userId).sort((a, b) => (a.id || 0) - (b.id || 0));
    res.json(mine);
});

app.post('/api/me/addresses', async (req, res) => {
    const body = req.body || {};
    const fullName = String(body.fullName || '').trim();
    const street    = String(body.street || '').trim();
    const city       = String(body.city || '').trim();
    const state       = String(body.state || '').trim().toUpperCase();
    const zip          = String(body.zip || '').trim();
    if (!fullName) return res.status(400).json({ error: 'Full name required' });
    if (!street)   return res.status(400).json({ error: 'Street address required' });
    if (!city)     return res.status(400).json({ error: 'City required' });
    if (!STATE_TAX_RATES.hasOwnProperty(state)) return res.status(400).json({ error: 'Valid US state required' });
    if (!zip)      return res.status(400).json({ error: 'ZIP code required' });

    const all = await readJSON('addresses');
    const makeDefault = body.isDefault || !all.some(a => a.userId === req.userId);
    const record = {
        id: nextId(all), userId: req.userId, fullName, phone: String(body.phone || '').trim(),
        street, street2: String(body.street2 || '').trim(), city, state, zip,
        country: 'United States', isDefault: makeDefault, createdAt: Date.now()
    };
    let updated = all.concat([record]);
    if (makeDefault) updated = updated.map(a => a.id === record.id ? a : (a.userId === req.userId ? Object.assign({}, a, { isDefault: false }) : a));
    await writeJSON('addresses', updated);
    res.status(201).json(record);
});

app.put('/api/me/addresses/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON('addresses');
    const idx = all.findIndex(a => a.id === id && a.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'Address not found' });
    const body = req.body || {};
    const patch = {};
    ['fullName', 'phone', 'street', 'street2', 'city', 'zip'].forEach(f => {
        if (body[f] !== undefined) patch[f] = String(body[f]).trim();
    });
    if (body.state !== undefined) {
        const state = String(body.state).trim().toUpperCase();
        if (!STATE_TAX_RATES.hasOwnProperty(state)) return res.status(400).json({ error: 'Valid US state required' });
        patch.state = state;
    }
    let updated = all.map(a => a.id === id ? Object.assign({}, a, patch) : a);
    if (body.isDefault) {
        updated = updated.map(a => a.id === id ? Object.assign({}, a, { isDefault: true }) : (a.userId === req.userId ? Object.assign({}, a, { isDefault: false }) : a));
    }
    await writeJSON('addresses', updated);
    res.json(updated.find(a => a.id === id));
});

app.delete('/api/me/addresses/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON('addresses');
    const target = all.find(a => a.id === id && a.userId === req.userId);
    if (!target) return res.status(404).json({ error: 'Address not found' });
    let remaining = all.filter(a => !(a.id === id && a.userId === req.userId));
    // Promote another address to default if the deleted one was it, so
    // checkout always has a usable default when at least one address remains.
    if (target.isDefault) {
        const mineIdx = remaining.findIndex(a => a.userId === req.userId);
        if (mineIdx !== -1) remaining[mineIdx] = Object.assign({}, remaining[mineIdx], { isDefault: true });
    }
    await writeJSON('addresses', remaining);
    res.json({ ok: true });
});

// ── E-Commerce: payment methods ─────────────────────────────────────────────
// Simulated only — no real card network integration. Charges still debit
// the user's checking balance; the "card" selected here is stored on the
// order for a realistic receipt/statement, matching how the rest of the app
// keeps a single real ledger (the bank balance) under every feature.
function detectCardBrand(number) {
    const n = String(number || '').replace(/\D/g, '');
    if (/^4/.test(n))  return 'visa';
    if (/^5[1-5]/.test(n)) return 'mastercard';
    if (/^3[47]/.test(n)) return 'amex';
    if (/^6(?:011|5)/.test(n)) return 'discover';
    return 'card';
}

app.get('/api/me/payment-methods', async (req, res) => {
    const all  = await readJSON('paymentMethods');
    const mine = all.filter(p => p.userId === req.userId).sort((a, b) => (a.id || 0) - (b.id || 0));
    res.json(mine);
});

app.post('/api/me/payment-methods', async (req, res) => {
    const body = req.body || {};
    const number = String(body.cardNumber || '').replace(/\D/g, '');
    const cardholderName = String(body.cardholderName || '').trim();
    const expMonth = Number(body.expMonth);
    const expYear  = Number(body.expYear);
    if (number.length < 12 || number.length > 19) return res.status(400).json({ error: 'Enter a valid card number' });
    if (!cardholderName) return res.status(400).json({ error: 'Cardholder name required' });
    if (!expMonth || expMonth < 1 || expMonth > 12) return res.status(400).json({ error: 'Valid expiration month required' });
    if (!expYear || expYear < new Date().getFullYear()) return res.status(400).json({ error: 'Card is expired' });

    const all = await readJSON('paymentMethods');
    const makeDefault = body.isDefault || !all.some(p => p.userId === req.userId);
    const record = {
        id: nextId(all), userId: req.userId, brand: detectCardBrand(number), last4: number.slice(-4),
        cardholderName, expMonth, expYear, isDefault: makeDefault, createdAt: Date.now()
    };
    let updated = all.concat([record]);
    if (makeDefault) updated = updated.map(p => p.id === record.id ? p : (p.userId === req.userId ? Object.assign({}, p, { isDefault: false }) : p));
    await writeJSON('paymentMethods', updated);
    res.status(201).json(record);
});

app.patch('/api/me/payment-methods/:id/default', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON('paymentMethods');
    if (!all.some(p => p.id === id && p.userId === req.userId)) return res.status(404).json({ error: 'Payment method not found' });
    const updated = all.map(p => p.userId === req.userId ? Object.assign({}, p, { isDefault: p.id === id }) : p);
    await writeJSON('paymentMethods', updated);
    res.json(updated.find(p => p.id === id));
});

app.delete('/api/me/payment-methods/:id', async (req, res) => {
    const id  = Number(req.params.id);
    const all = await readJSON('paymentMethods');
    const target = all.find(p => p.id === id && p.userId === req.userId);
    if (!target) return res.status(404).json({ error: 'Payment method not found' });
    let remaining = all.filter(p => !(p.id === id && p.userId === req.userId));
    if (target.isDefault) {
        const mineIdx = remaining.findIndex(p => p.userId === req.userId);
        if (mineIdx !== -1) remaining[mineIdx] = Object.assign({}, remaining[mineIdx], { isDefault: true });
    }
    await writeJSON('paymentMethods', remaining);
    res.json({ ok: true });
});

// ── Catch-all: SPA fallback ───────────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
    if (!path.extname(req.path)) {
        res.sendFile(path.join(__dirname, 'index.html'));
    } else {
        res.status(404).send('Not found');
    }
});

// ── Global error handler — keep API responses JSON even on unexpected failures
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Server error' });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
// Best-effort periodic sweep so scheduled transfers execute close to on time
// while the server process is actually running — the authoritative
// correctness mechanism is still runDueScheduledTransfers() being called
// from GET /api/me/balances and the scheduled-transfers routes themselves,
// which self-corrects regardless of server uptime (e.g. after a Render
// free-tier dyno wakes back up from idle).
function startScheduledTransferSweep() {
    setInterval(() => {
        // Only 'users' (shared/legacy) and 'bankingUsers' (standalone Banking
        // app) ever have scheduled transfers — E-Commerce/Utilities accounts
        // never create scheduledTransfers rows, so sweeping them would be
        // harmless but pointless.
        [['users', 'messages'], ['bankingUsers', 'bankingMessages']].forEach(([userStore, messageStore]) => {
            readJSON(userStore)
                .then(users => Promise.all(users.map(u => runDueScheduledTransfers(u.id, userStore, messageStore).catch(() => {}))))
                .catch(() => {});
        });
    }, 5 * 60 * 1000);
}

async function start() {
    await initStorage();
    await seedDefaultAdmin();
    await seedDefaultModuleAdmin('bankingUsers', 'bankingChallenges', 'banking');
    await seedDefaultModuleAdmin('ecommerceUsers', 'ecommerceChallenges', 'ecommerce');
    await seedDefaultModuleAdmin('utilitiesUsers', 'utilitiesChallenges', 'utilities');
    await seedDefaultBills();
    await seedDefaultProducts();
    startScheduledTransferSweep();
    app.listen(PORT, () => {
        console.log('DigiFinWiz server running on http://localhost:' + PORT);
    });
}

start().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});

module.exports = app;
