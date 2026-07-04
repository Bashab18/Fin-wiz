// db.js — fetch()-based API client for DigiFinWiz
// Drop-in replacement for the IndexedDB version.
// All public API names are identical so no other file needs changes.

const DigifinwizDB = (() => {

    // ── Session helpers ───────────────────────────────────────────────────────
    function _session() {
        try {
            var s = JSON.parse(sessionStorage.getItem('bkr_session') || 'null');
            if (s) return s;
            return JSON.parse(localStorage.getItem('bkr_session') || 'null');
        } catch (e) { return null; }
    }

    function _headers() {
        const s = _session();
        const userId = s ? String(s.userId) : '';
        const role   = s ? (s.role || '')   : '';
        return {
            'Content-Type': 'application/json',
            'X-User-Id':    userId,
            'X-User-Role':  role
        };
    }

    // ── Core fetch wrapper ────────────────────────────────────────────────────
    async function _api(method, url, body) {
        const opts = {
            method:  method.toUpperCase(),
            headers: _headers()
        };
        if (body !== undefined) {
            opts.body = JSON.stringify(body);
        }
        const res = await fetch((window.API_BASE_URL || '') + url, opts);
        if (!res.ok) {
            let msg = res.statusText;
            try {
                const errJson = await res.json();
                msg = errJson.error || errJson.reason || msg;
            } catch (_) { /* ignore */ }
            throw new Error(msg);
        }
        // 204 No Content — return null
        if (res.status === 204) return null;
        return res.json();
    }

    // ── Init / health ─────────────────────────────────────────────────────────
    function init() {
        return fetch('/api/health').then(() => {}).catch(() => {});
    }

    // Backward-compat alias
    function open() {
        return init();
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    function authenticateUser(usernameOrEmail, password) {
        return _api('POST', '/api/auth/login', { usernameOrEmail, password });
    }

    function createUser(opts) {
        return _api('POST', '/api/auth/register', opts).then(r => r.id);
    }

    // Server handles lastLogin update inside login; nothing to do client-side
    function recordLastLogin(_userId) {
        return Promise.resolve();
    }

    function notifyAdminsOfRegistration(username, fullName) {
        return _api('POST', '/api/auth/notify-admins', { username, fullName });
    }

    // ── User lookup helpers (client-side filter over GET /api/users) ──────────
    function getAllUsers() {
        return _api('GET', '/api/users');
    }

    function findUserByLogin(val) {
        return getAllUsers().then(users => {
            const v = (val || '').toLowerCase();
            return users.find(u => u.username === v || u.email === v) || null;
        });
    }

    function findUserByUsername(username) {
        return getAllUsers().then(users =>
            users.find(u => u.username === (username || '').toLowerCase()) || null
        );
    }

    function findUserByEmail(email) {
        return getAllUsers().then(users =>
            users.find(u => u.email === (email || '').toLowerCase()) || null
        );
    }

    function getUserById(id) {
        return _api('GET', '/api/users/' + id);
    }

    function updateUser(id, updates) {
        return _api('PUT', '/api/users/' + id, updates);
    }

    function approveUser(id) {
        return _api('POST', '/api/users/' + id + '/approve');
    }

    function rejectUser(id) {
        return _api('POST', '/api/users/' + id + '/reject');
    }

    function deleteUser(id) {
        return _api('DELETE', '/api/users/' + id);
    }

    // ── Session-scoped user data ───────────────────────────────────────────────
    function getUserData() {
        return _api('GET', '/api/me/data');
    }

    function setUserData(data) {
        return _api('PUT', '/api/me/data', data);
    }

    // ── Profile ───────────────────────────────────────────────────────────────
    function getProfileData() {
        return _api('GET', '/api/me/profile');
    }

    function setProfileData(data) {
        return _api('PUT', '/api/me/profile', data);
    }

    // ── Balances ──────────────────────────────────────────────────────────────
    function getBalance(account) {
        return _api('GET', '/api/me/balances/' + account).then(r => r.amount);
    }

    function getAllBalances() {
        return _api('GET', '/api/me/balances');
    }

    function adjustBalance(account, delta) {
        return _api('POST', '/api/me/balances/adjust', { account, delta }).then(r => r.amount);
    }

    function setBalance(account, amount) {
        // Compute delta = desired – current, then apply atomically
        return getBalance(account).then(current => {
            const delta = parseFloat((amount - current).toFixed(10));
            return adjustBalance(account, delta);
        });
    }

    // ── Transactions ──────────────────────────────────────────────────────────
    function addTransaction(tx) {
        return _api('POST', '/api/me/transactions', tx);
    }

    function getTransactions(limit) {
        const qs = limit ? '?limit=' + limit : '';
        return _api('GET', '/api/me/transactions' + qs);
    }

    function getTransactionsSince(ts) {
        return _api('GET', '/api/me/transactions?since=' + ts);
    }

    // ── Payments ──────────────────────────────────────────────────────────────
    function addPayment(pay) {
        return _api('POST', '/api/me/payments', pay);
    }

    function getPayments(limit) {
        const qs = limit ? '?limit=' + limit : '';
        return _api('GET', '/api/me/payments' + qs);
    }

    function getPaymentsSince(ts) {
        return _api('GET', '/api/me/payments?since=' + ts);
    }

    // ── Purchases ─────────────────────────────────────────────────────────────
    function addPurchase(p) {
        return _api('POST', '/api/me/purchases', p);
    }

    function getPurchases(limit) {
        const qs = limit ? '?limit=' + limit : '';
        return _api('GET', '/api/me/purchases' + qs);
    }

    function getPurchasesSince(_ts) {
        // No since-filter on purchases endpoint; return all
        return _api('GET', '/api/me/purchases');
    }

    // ── Cart ──────────────────────────────────────────────────────────────────
    function getCart() {
        return _api('GET', '/api/me/cart');
    }

    function addCartItem(item) {
        return _api('POST', '/api/me/cart', item).then(r => r.id);
    }

    function removeCartItem(id) {
        return _api('DELETE', '/api/me/cart/' + id);
    }

    function clearCart() {
        return _api('DELETE', '/api/me/cart');
    }

    // ── Challenges ────────────────────────────────────────────────────────────
    function getChallenges() {
        return _api('GET', '/api/me/challenges');
    }

    function getChallengesForUser(userId) {
        return _api('GET', '/api/users/' + userId + '/challenges');
    }

    function addChallenge(c) {
        return _api('POST', '/api/me/challenges', c);
    }

    function updateChallenge(id, updates) {
        return _api('PATCH', '/api/me/challenges/' + id, updates);
    }

    // Admin-scoped variant — updates any participant's challenge regardless of owner
    function adminUpdateChallenge(id, updates) {
        return _api('PATCH', '/api/admin/challenges/' + id, updates);
    }

    function deleteChallenge(id) {
        return _api('DELETE', '/api/me/challenges/' + id);
    }

    // Wipe all challenges (admin)
    function clearStore(storeName) {
        if (storeName === 'challenges') return _api('DELETE', '/api/admin/challenges');
        return Promise.resolve();
    }

    // Re-seed defaults for every approved participant (admin)
    function seedDefaultChallenges() {
        return _api('POST', '/api/admin/challenges/seed');
    }

    // Add any missing default challenges for every approved participant (admin)
    function reseedMissingChallenges() {
        return _api('POST', '/api/admin/challenges/reseed');
    }

    function checkAndCompleteChallenges(ctx) {
        return _api('POST', '/api/me/challenges/check', ctx);
    }

    function getLevel1Requirements() {
        return _api('GET', '/api/me/challenges/level1');
    }

    function purgeDuplicateChallenges() {
        return _api('POST', '/api/me/challenges/purge');
    }

    function seedChallengesForUser(userId) {
        return _api('POST', '/api/users/' + userId + '/seed-challenges');
    }

    // ── Messages ──────────────────────────────────────────────────────────────
    function getMessagesForUser(_userId) {
        // Server scopes by session; userId param is ignored but kept for API compat
        return _api('GET', '/api/me/messages');
    }

    function markMessageRead(messageId, _userId) {
        return _api('PATCH', '/api/me/messages/' + messageId);
    }

    function sendAdminMessage(opts) {
        return _api('POST', '/api/admin/messages', opts);
    }

    function sendSystemMessage(opts) {
        // No auth headers needed — plain fetch
        return fetch('/api/admin/messages/system', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(opts)
        }).then(res => {
            if (!res.ok) throw new Error(res.statusText);
            return res.json();
        });
    }

    function getAllSentMessages() {
        return _api('GET', '/api/admin/messages');
    }

    function deleteAdminMessage(id) {
        return _api('DELETE', '/api/admin/messages/' + id);
    }

    // ── Stats & activity ──────────────────────────────────────────────────────
    function getStats() {
        return _api('GET', '/api/me/stats');
    }

    function getRecentActivity(limit) {
        const qs = limit ? '?limit=' + limit : '';
        return _api('GET', '/api/me/activity' + qs);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        // Init
        init,
        open,   // backward-compat alias for init

        // Auth
        authenticateUser,
        createUser,
        recordLastLogin,
        notifyAdminsOfRegistration,

        // User management
        getAllUsers,
        findUserByLogin,
        findUserByUsername,
        findUserByEmail,
        getUserById,
        updateUser,
        approveUser,
        rejectUser,
        deleteUser,

        // Session data
        getUserData,
        setUserData,
        getProfileData,
        setProfileData,

        // Balances
        getBalance,
        getAllBalances,
        adjustBalance,
        setBalance,

        // Transactions
        addTransaction,
        getTransactions,
        getTransactionsSince,

        // Payments
        addPayment,
        getPayments,
        getPaymentsSince,

        // Purchases
        addPurchase,
        getPurchases,
        getPurchasesSince,

        // Cart
        getCart,
        addCartItem,
        removeCartItem,
        clearCart,

        // Challenges
        getChallenges,
        getChallengesForUser,
        addChallenge,
        updateChallenge,
        adminUpdateChallenge,
        deleteChallenge,
        clearStore,
        seedDefaultChallenges,
        reseedMissingChallenges,
        checkAndCompleteChallenges,
        getLevel1Requirements,
        purgeDuplicateChallenges,
        seedChallengesForUser,

        // Messages
        getMessagesForUser,
        markMessageRead,
        sendAdminMessage,
        sendSystemMessage,
        getAllSentMessages,
        deleteAdminMessage,

        // Stats & activity
        getStats,
        getRecentActivity
    };
})();
