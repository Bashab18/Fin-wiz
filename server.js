'use strict';

const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');

const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// Origin of the static frontend when it's hosted separately (e.g. on Netlify)
// from this API (e.g. on Render). '*' is fine here since auth uses custom
// headers rather than cookies, so no credentials are ever sent cross-origin.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// ── Ensure data directory + JSON files exist ─────────────────────────────────
const DATA_FILES = ['users', 'transactions', 'payments', 'purchases', 'challenges', 'messages', 'cart', 'bills'];
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
DATA_FILES.forEach(name => {
    const fp = path.join(DATA_DIR, name + '.json');
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, '[]', 'utf8');
});

// ── JSON file helpers ─────────────────────────────────────────────────────────
function readJSON(name) {
    try {
        const raw = fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        return [];
    }
}

function writeJSON(name, data) {
    fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(data, null, 2), 'utf8');
}

function nextId(arr) {
    if (!arr || arr.length === 0) return 1;
    return Math.max(...arr.map(r => r.id || 0)) + 1;
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
const DEFAULT_BALANCES  = { checking: 88674.00, savings: 18074.00 };
const DEFAULT_USER_DATA = { level: 1, points: 0, pointsToNextLevel: 1000, challenges: 0, completedTasks: 0, coins: 0 };

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
function seedDefaultAdmin() {
    const users    = readJSON('users');
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
    writeJSON('users', users);
    console.log('DigifinwizDB: default admin created (admin / Admin1234)');
}

// ── Challenge helpers ─────────────────────────────────────────────────────────
function getChallengesForUser(userId, role) {
    const all      = readJSON('challenges');
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

function seedChallengesForUser(userId) {
    const challenges = readJSON('challenges');
    const existing   = challenges.filter(c => c.userId === userId);
    if (existing.length > 0) return;
    const now = Date.now();
    let id    = nextId(challenges);
    ALL_DEFAULT_CHALLENGES.forEach(c => {
        challenges.push(Object.assign({}, c, {
            id:        id++,
            userId:    userId,
            createdAt: now,
            active:    true,
            completed: false
        }));
    });
    writeJSON('challenges', challenges);
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
        case 'custom':
            if (!CUSTOM_FIELD_WHITELIST.has(cc.customField)) return false;
            return compareOp(Number(context[cc.customField]) || 0, cc.customOperator, val);
        default: return false;
    }
}

function checkAndCompleteChallengesForUser(userId, context) {
    const challenges = readJSON('challenges');
    const users      = readJSON('users');
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
    writeJSON('challenges', updatedChallenges);

    // Award XP + update userData
    const bonusXP  = completed.reduce((s, c) => s + (c.points || 0), 0);
    let leveledUp  = false;
    let newLevel   = 0;

    const userData             = Object.assign({}, DEFAULT_USER_DATA, user.userData || {});
    userData.challenges        = (userData.challenges || 0) + completed.length;
    userData.points            = (userData.points || 0) + bonusXP;
    userData.pointsToNextLevel = (userData.pointsToNextLevel !== undefined ? userData.pointsToNextLevel : 1000) - bonusXP;

    if (userData.pointsToNextLevel <= 0) {
        if (userData.level === 1) {
            // Gate: must have completed all 3 core Level-1 activities
            const allNow = updatedChallenges.filter(c => c.userId === userId);
            const reqMet = LEVEL_1_REQUIRED_CONDITIONS.every(cond =>
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
    writeJSON('users', updatedUsers);

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

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
    const { usernameOrEmail, password } = req.body || {};
    if (!usernameOrEmail || !password) {
        return res.status(400).json({ success: false, reason: 'missing_fields' });
    }
    const val   = usernameOrEmail.toLowerCase();
    const users = readJSON('users');
    const user  = users.find(u => u.username === val || u.email === val);
    if (!user) return res.json({ success: false, reason: 'not_found' });
    if (user.passwordHash !== simpleHash(password)) return res.json({ success: false, reason: 'wrong_password' });
    if (user.status === 'pending')  return res.json({ success: false, reason: 'pending' });
    if (user.status === 'rejected') return res.json({ success: false, reason: 'rejected' });

    // Update lastLogin
    const now     = Date.now();
    const updated = users.map(u => u.id === user.id ? Object.assign({}, u, { lastLogin: now }) : u);
    writeJSON('users', updated);
    res.json({ success: true, user: Object.assign({}, user, { lastLogin: now }) });
});

app.post('/api/auth/register', (req, res) => {
    const { fullName, username, email, password } = req.body || {};
    if (!fullName || !username || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    const users  = readJSON('users');
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
    writeJSON('users', users);
    res.status(201).json({ id });
});

app.post('/api/auth/notify-admins', (req, res) => {
    const { username, fullName } = req.body || {};
    const users    = readJSON('users');
    const messages = readJSON('messages');
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
    writeJSON('messages', messages);
    res.json({ ok: true });
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', (_req, res) => {
    const users = readJSON('users');
    res.json(users.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
});

app.get('/api/users/:id', (req, res) => {
    const id    = Number(req.params.id);
    const users = readJSON('users');
    const user  = users.find(u => u.id === id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (req.userRole !== 'admin' && req.userId !== id) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    res.json(user);
});

app.put('/api/users/:id', (req, res) => {
    const id    = Number(req.params.id);
    const users = readJSON('users');
    const idx   = users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = Object.assign({}, users[idx], req.body, { id });
    writeJSON('users', users);
    res.json(users[idx]);
});

app.delete('/api/users/:id', (req, res) => {
    const id = Number(req.params.id);

    // Remove from all per-user stores
    ['transactions', 'payments', 'purchases', 'challenges'].forEach(store => {
        writeJSON(store, readJSON(store).filter(r => r.userId !== id));
    });

    // Messages: delete direct, scrub readBy from broadcasts
    const messages = readJSON('messages');
    writeJSON('messages', messages
        .filter(m => m.recipientId !== id)
        .map(m => {
            if (m.recipientId === 'all') {
                return Object.assign({}, m, { readBy: (m.readBy || []).filter(uid => uid !== id) });
            }
            return m;
        })
    );

    writeJSON('users', readJSON('users').filter(u => u.id !== id));
    res.json({ ok: true });
});

app.post('/api/users/:id/approve', (req, res) => {
    const id    = Number(req.params.id);
    const users = readJSON('users');
    const idx   = users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = Object.assign({}, users[idx], { status: 'approved', approvedAt: Date.now() });
    writeJSON('users', users);
    seedChallengesForUser(id);
    res.json(users[idx]);
});

app.post('/api/users/:id/reject', (req, res) => {
    const id    = Number(req.params.id);
    const users = readJSON('users');
    const idx   = users.findIndex(u => u.id === id);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = Object.assign({}, users[idx], { status: 'rejected' });
    writeJSON('users', users);
    res.json(users[idx]);
});

app.get('/api/users/:id/challenges', (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id = Number(req.params.id);
    res.json(getChallengesForUser(id, 'participant'));
});

app.post('/api/users/:id/seed-challenges', (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id = Number(req.params.id);
    seedChallengesForUser(id);
    res.json({ ok: true });
});

// ── Me: user data ─────────────────────────────────────────────────────────────
app.get('/api/me/data', (req, res) => {
    const users = readJSON('users');
    const user  = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user.userData || Object.assign({}, DEFAULT_USER_DATA));
});

app.put('/api/me/data', (req, res) => {
    const users = readJSON('users');
    const idx   = users.findIndex(u => u.id === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = Object.assign({}, users[idx], { userData: req.body });
    writeJSON('users', users);
    res.json(users[idx].userData);
});

// ── Me: profile ───────────────────────────────────────────────────────────────
app.get('/api/me/profile', (req, res) => {
    const users = readJSON('users');
    const user  = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ fullName: user.fullName, username: user.username, email: user.email });
});

app.put('/api/me/profile', (req, res) => {
    const users = readJSON('users');
    const idx   = users.findIndex(u => u.id === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    const { fullName, username, email } = req.body || {};
    const patch = {};
    if (fullName !== undefined) patch.fullName = fullName;
    if (username  !== undefined) patch.username = username;
    if (email     !== undefined) patch.email    = email;
    users[idx] = Object.assign({}, users[idx], patch);
    writeJSON('users', users);
    res.json({ fullName: users[idx].fullName, username: users[idx].username, email: users[idx].email });
});

// ── Me: balances ──────────────────────────────────────────────────────────────
app.get('/api/me/balances', (req, res) => {
    const users = readJSON('users');
    const user  = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const balances = Object.assign({}, DEFAULT_BALANCES, user.balances || {});
    res.json(['checking', 'savings'].map(acc => ({ account: acc, amount: balances[acc] })));
});

app.get('/api/me/balances/:account', (req, res) => {
    const users   = readJSON('users');
    const user    = users.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const account  = req.params.account;
    const balances = Object.assign({}, DEFAULT_BALANCES, user.balances || {});
    res.json({ account, amount: balances[account] !== undefined ? balances[account] : 0 });
});

app.post('/api/me/balances/adjust', (req, res) => {
    const { account, delta } = req.body || {};
    if (!account || delta === undefined) return res.status(400).json({ error: 'account and delta required' });
    const users = readJSON('users');
    const idx   = users.findIndex(u => u.id === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    const balances    = Object.assign({}, DEFAULT_BALANCES, users[idx].balances || {});
    const current     = balances[account] !== undefined ? balances[account] : 0;
    balances[account] = parseFloat((current + Number(delta)).toFixed(2));
    users[idx]        = Object.assign({}, users[idx], { balances });
    writeJSON('users', users);
    res.json({ account, amount: balances[account] });
});

// ── Me: transactions ──────────────────────────────────────────────────────────
app.get('/api/me/transactions', (req, res) => {
    const limit    = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const since    = req.query.since ? Number(req.query.since)       : null;
    let filtered   = readJSON('transactions').filter(t => t.userId === req.userId);
    if (since)     filtered = filtered.filter(t => (t.timestamp || 0) >= since);
    filtered.sort((a, b) => (b.id || 0) - (a.id || 0));
    res.json(limit ? filtered.slice(0, limit) : filtered);
});

app.post('/api/me/transactions', (req, res) => {
    const all    = readJSON('transactions');
    const record = Object.assign({}, req.body, {
        id:        nextId(all),
        userId:    req.userId,
        timestamp: req.body.timestamp || Date.now()
    });
    all.push(record);
    writeJSON('transactions', all);
    res.status(201).json(record);
});

// ── Me: payments ──────────────────────────────────────────────────────────────
app.get('/api/me/payments', (req, res) => {
    const limit    = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const since    = req.query.since ? Number(req.query.since)       : null;
    let filtered   = readJSON('payments').filter(p => p.userId === req.userId);
    if (since)     filtered = filtered.filter(p => (p.timestamp || 0) >= since);
    filtered.sort((a, b) => (b.id || 0) - (a.id || 0));
    res.json(limit ? filtered.slice(0, limit) : filtered);
});

app.post('/api/me/payments', (req, res) => {
    const all    = readJSON('payments');
    const record = Object.assign({}, req.body, {
        id:        nextId(all),
        userId:    req.userId,
        timestamp: req.body.timestamp || Date.now()
    });
    all.push(record);
    writeJSON('payments', all);
    res.status(201).json(record);
});

// ── Me: purchases ─────────────────────────────────────────────────────────────
app.get('/api/me/purchases', (req, res) => {
    const limit    = req.query.limit ? parseInt(req.query.limit, 10) : null;
    let filtered   = readJSON('purchases').filter(p => p.userId === req.userId);
    filtered.sort((a, b) => (b.id || 0) - (a.id || 0));
    res.json(limit ? filtered.slice(0, limit) : filtered);
});

app.post('/api/me/purchases', (req, res) => {
    const all    = readJSON('purchases');
    const record = Object.assign({}, req.body, {
        id:        nextId(all),
        userId:    req.userId,
        timestamp: req.body.timestamp || Date.now()
    });
    all.push(record);
    writeJSON('purchases', all);
    res.status(201).json(record);
});

// ── Me: cart ──────────────────────────────────────────────────────────────────
app.get('/api/me/cart', (req, res) => {
    const mine = readJSON('cart')
        .filter(i => i.userId === req.userId)
        .sort((a, b) => (a.id || 0) - (b.id || 0));
    res.json(mine);
});

app.post('/api/me/cart', (req, res) => {
    const all    = readJSON('cart');
    const record = Object.assign({}, req.body, { id: nextId(all), userId: req.userId });
    all.push(record);
    writeJSON('cart', all);
    res.status(201).json(record);
});

app.delete('/api/me/cart/:id', (req, res) => {
    const id = Number(req.params.id);
    writeJSON('cart', readJSON('cart').filter(i => !(i.id === id && i.userId === req.userId)));
    res.json({ ok: true });
});

app.delete('/api/me/cart', (req, res) => {
    writeJSON('cart', readJSON('cart').filter(i => i.userId !== req.userId));
    res.json({ ok: true });
});

// ── Me: challenges  (specific sub-routes MUST be defined before the generic ones)
app.get('/api/me/challenges/level1', (req, res) => {
    const challenges = getChallengesForUser(req.userId, 'participant');
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

app.post('/api/me/challenges/check', (req, res) => {
    const result = checkAndCompleteChallengesForUser(req.userId, req.body || {});
    res.json(result);
});

app.post('/api/me/challenges/purge', (req, res) => {
    const all    = readJSON('challenges');
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
    writeJSON('challenges', [...others, ...mine.filter(c => keepIds.has(c.id))]);
    res.json({ purged });
});

app.get('/api/me/challenges', (req, res) => {
    res.json(getChallengesForUser(req.userId, req.userRole || 'participant'));
});

app.post('/api/me/challenges', (req, res) => {
    const all    = readJSON('challenges');
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
    writeJSON('challenges', all);
    res.status(201).json(record);
});

app.patch('/api/me/challenges/:id', (req, res) => {
    const id  = Number(req.params.id);
    const all = readJSON('challenges');
    const idx = all.findIndex(c => c.id === id && c.userId === req.userId);
    if (idx === -1) return res.status(404).json({ error: 'Challenge not found' });
    all[idx] = Object.assign({}, all[idx], req.body, { id, userId: req.userId });
    writeJSON('challenges', all);
    res.json(all[idx]);
});

app.delete('/api/me/challenges/:id', (req, res) => {
    const id = Number(req.params.id);
    writeJSON('challenges', readJSON('challenges').filter(c => !(c.id === id && c.userId === req.userId)));
    res.json({ ok: true });
});

// ── Me: messages ──────────────────────────────────────────────────────────────
app.get('/api/me/messages', (req, res) => {
    const all = readJSON('messages');
    res.json(all.filter(m => m.recipientId === 'all' || m.recipientId === req.userId));
});

app.patch('/api/me/messages/:id', (req, res) => {
    const id  = Number(req.params.id);
    const all = readJSON('messages');
    const idx = all.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Message not found' });
    const readBy = Array.from(all[idx].readBy || []);
    if (!readBy.includes(req.userId)) readBy.push(req.userId);
    all[idx] = Object.assign({}, all[idx], { readBy });
    writeJSON('messages', all);
    res.json(all[idx]);
});

// ── Me: stats ─────────────────────────────────────────────────────────────────
app.get('/api/me/stats', (req, res) => {
    const users    = readJSON('users');
    const user     = users.find(u => u.id === req.userId);
    const userData = user ? (user.userData || Object.assign({}, DEFAULT_USER_DATA)) : Object.assign({}, DEFAULT_USER_DATA);

    const txs    = readJSON('transactions').filter(t => t.userId === req.userId);
    const pays   = readJSON('payments').filter(p => p.userId === req.userId);
    const purchs = readJSON('purchases').filter(p => p.userId === req.userId);

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
app.get('/api/me/activity', (req, res) => {
    const limit  = req.query.limit ? parseInt(req.query.limit, 10) : null;
    const txs    = readJSON('transactions').filter(t => t.userId === req.userId);
    const pays   = readJSON('payments').filter(p => p.userId === req.userId);
    const purchs = readJSON('purchases').filter(p => p.userId === req.userId);

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
    events.sort((a, b) => b.timestamp - a.timestamp);
    res.json(limit ? events.slice(0, limit) : events);
});

// ── Admin messages — system (no auth required, must be before auth-gated routes)
app.post('/api/admin/messages/system', (req, res) => {
    const { subject, body, recipientId, type } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
    const messages = readJSON('messages');
    const record   = {
        id:          nextId(messages),
        senderId:    0,
        senderName:  'System',
        senderEmail: null,
        recipientId: recipientId,
        subject:     subject.trim(),
        body:        body.trim(),
        type:        type || 'info',
        sentAt:      Date.now(),
        readBy:      []
    };
    messages.push(record);
    writeJSON('messages', messages);
    res.status(201).json(record);
});

// ── Admin messages ────────────────────────────────────────────────────────────
app.get('/api/admin/messages', (req, res) => {
    res.json(readJSON('messages'));
});

app.post('/api/admin/messages', (req, res) => {
    const { subject, body, recipientId, type, senderEmail } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
    const messages = readJSON('messages');
    const users    = readJSON('users');
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
        sentAt:      Date.now(),
        readBy:      []
    };
    messages.push(record);
    writeJSON('messages', messages);
    res.status(201).json(record);
});

app.delete('/api/admin/messages/:id', (req, res) => {
    const id = Number(req.params.id);
    writeJSON('messages', readJSON('messages').filter(m => m.id !== id));
    res.json({ ok: true });
});

// ── Admin: challenge management ───────────────────────────────────────────────

// PATCH /api/admin/challenges/:id — update any challenge regardless of owner
app.patch('/api/admin/challenges/:id', (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const id  = Number(req.params.id);
    const all = readJSON('challenges');
    const idx = all.findIndex(c => c.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Challenge not found' });
    all[idx] = Object.assign({}, all[idx], req.body, { id });
    writeJSON('challenges', all);
    res.json(all[idx]);
});

// DELETE /api/admin/challenges — wipe ALL challenges (admin only)
app.delete('/api/admin/challenges', (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    writeJSON('challenges', []);
    res.json({ ok: true });
});

// POST /api/admin/challenges/seed — seed default challenges for every approved participant
app.post('/api/admin/challenges/seed', (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const participants = readJSON('users').filter(u => u.role === 'participant' && u.status === 'approved');
    participants.forEach(u => seedChallengesForUser(u.id));
    res.json({ ok: true, seeded: participants.length });
});

// POST /api/admin/challenges/reseed — add any missing default challenges for every approved participant
app.post('/api/admin/challenges/reseed', (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const challenges   = readJSON('challenges');
    const participants = readJSON('users').filter(u => u.role === 'participant' && u.status === 'approved');
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

    writeJSON('challenges', challenges);
    res.json(added);
});

// ── Bills API ─────────────────────────────────────────────────────────────────
const DEFAULT_BILLS = [
    { id: 1, name: 'Electricity',  icon: '⚡', amount: 89.50,   accountNumber: '1234560', gradient: 'linear-gradient(135deg,#fbbf24,#f59e0b)', dueDate: 'Jan 25, 2026', active: true },
    { id: 2, name: 'Water',        icon: '💧', amount: 45.00,   accountNumber: '1234560', gradient: 'linear-gradient(135deg,#3b82f6,#2563eb)', dueDate: 'Jan 28, 2026', active: true },
    { id: 3, name: 'Internet',     icon: '🌐', amount: 79.99,   accountNumber: '9876543', gradient: 'linear-gradient(135deg,#10b981,#059669)', dueDate: 'Feb 1, 2026',  active: true },
    { id: 4, name: 'Property Tax', icon: '🏠', amount: 1250.00, accountNumber: '1234560', gradient: 'linear-gradient(135deg,#8b5cf6,#7c3aed)', dueDate: 'Feb 15, 2026', active: true },
    { id: 5, name: 'Phone',        icon: '📱', amount: 55.00,   accountNumber: '2175550123', gradient: 'linear-gradient(135deg,#ec4899,#db2777)', dueDate: 'Jan 30, 2026', active: true },
    { id: 6, name: 'Gas',          icon: '🔥', amount: 65.75,   accountNumber: '5551234', gradient: 'linear-gradient(135deg,#f97316,#ea580c)', dueDate: 'Feb 5, 2026',  active: true }
];

function seedDefaultBills() {
    const bills = readJSON('bills');
    if (!bills || bills.length === 0) {
        writeJSON('bills', DEFAULT_BILLS);
    }
}

// GET /api/bills — public
app.get('/api/bills', (_req, res) => {
    res.json(readJSON('bills').filter(b => b.active !== false));
});

// POST /api/bills — admin only
app.post('/api/bills', (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const bills = readJSON('bills');
    const bill  = Object.assign({ active: true }, req.body, { id: nextId(bills) });
    bills.push(bill);
    writeJSON('bills', bills);
    res.status(201).json(bill);
});

// PUT /api/bills/:id — admin only
app.put('/api/bills/:id', (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const bills = readJSON('bills');
    const idx   = bills.findIndex(b => String(b.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    bills[idx] = Object.assign({}, bills[idx], req.body, { id: bills[idx].id });
    writeJSON('bills', bills);
    res.json(bills[idx]);
});

// DELETE /api/bills/:id — admin only
app.delete('/api/bills/:id', (req, res) => {
    if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const bills = readJSON('bills').filter(b => String(b.id) !== String(req.params.id));
    writeJSON('bills', bills);
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

// ── Boot ──────────────────────────────────────────────────────────────────────
seedDefaultAdmin();
seedDefaultBills();
app.listen(PORT, () => {
    console.log('DigiFinWiz server running on http://localhost:' + PORT);
});

module.exports = app;
