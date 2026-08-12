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
        return fetch((window.API_BASE_URL || '') + '/api/health').then(() => {}).catch(() => {});
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

    // Canonical point-award routine — every earning flow in the app (banking
    // transfers/bill pay, ecommerce checkout, shop pages) should route XP
    // gains through this so points/pointsToNextLevel/level stay mutually
    // consistent. A caller that instead computes its own running "total XP"
    // and writes it straight to userData.points (as the shop pages used to)
    // silently diverges from this model — pointsToNextLevel never moves,
    // so the two fields disagree about how close the user is to leveling
    // up, and the absolute overwrite can clobber points earned elsewhere
    // (e.g. a checkout in another tab) between this call's read and write.
    // extraPatch (optional) is merged into the same read-modify-write, for
    // a caller that also needs to update an unrelated field (e.g. coins)
    // atomically alongside the XP award.
    function awardPoints(amount, extraPatch) {
        return getUserData().then(function(userData) {
            userData = Object.assign(
                { level: 1, points: 0, pointsToNextLevel: 1000, challenges: 0, completedTasks: 0, coins: 0 },
                userData || {}, extraPatch || {}
            );
            userData.points = (userData.points || 0) + amount;
            userData.pointsToNextLevel = (userData.pointsToNextLevel != null ? userData.pointsToNextLevel : 1000) - amount;
            var leveledUp = false;
            function finish() {
                return setUserData(userData).then(function() {
                    return { userData: userData, leveledUp: leveledUp, newLevel: userData.level };
                });
            }
            if (userData.pointsToNextLevel > 0) return finish();
            // Level 1 -> 2 is gated behind having done at least one activity
            // in each of banking/ecommerce/utilities — same rule the rest of
            // the app enforces, so a shop-only user can't skip it.
            if (userData.level === 1) {
                return getLevel1Requirements().then(function(req) {
                    if (req.allMet) {
                        userData.level++;
                        userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                        leveledUp = true;
                    } else {
                        userData.pointsToNextLevel = 0;
                    }
                    return finish();
                });
            }
            userData.level++;
            userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
            leveledUp = true;
            return finish();
        });
    }

    // ── Profile ───────────────────────────────────────────────────────────────
    function getProfileData() {
        return _api('GET', '/api/me/profile');
    }

    function setProfileData(data) {
        return _api('PUT', '/api/me/profile', data);
    }

    // Verifies currentPassword server-side and updates the hash — the client
    // never has (or needs) access to the password-hashing function itself.
    function changePassword(currentPassword, newPassword) {
        return _api('POST', '/api/me/password', { currentPassword, newPassword });
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
        // Server computes current->target atomically in one locked request —
        // computing the delta here from a separate GET left a window where
        // another write (a scheduled transfer executing, a second admin tab)
        // could land between the read and the write and get silently undone.
        return _api('POST', '/api/me/balances/' + account + '/set', { amount }).then(r => r.amount);
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

    // ── Utilities: bills (per-user monthly cycles) ──────────────────────────────
    function getMyBills() {
        return _api('GET', '/api/me/bills');
    }

    function payBillCycle(cycleId) {
        return _api('POST', '/api/me/bills/' + cycleId + '/pay');
    }

    function getCustomBills() {
        return _api('GET', '/api/me/bills/custom');
    }

    function createCustomBill(bill) {
        return _api('POST', '/api/me/bills/custom', bill);
    }

    function updateCustomBill(id, patch) {
        return _api('PUT', '/api/me/bills/custom/' + id, patch);
    }

    function deleteCustomBill(id) {
        return _api('DELETE', '/api/me/bills/custom/' + id);
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

    // Admin-scoped variant — deletes any participant's challenge regardless of owner
    function adminDeleteChallenge(id) {
        return _api('DELETE', '/api/admin/challenges/' + id);
    }

    // Admin-scoped variant — creates a new challenge and pushes a live
    // instance of it to every approved participant, rather than writing it
    // under the admin's own account like addChallenge()/POST /api/me/challenges would.
    function adminCreateChallenge(c) {
        return _api('POST', '/api/admin/challenges', c);
    }

    // Dispatches to the right self-scoped bulk-delete route per store name.
    // Previously every name except 'challenges' silently resolved without
    // deleting anything, so "Clear Transactions", "Clear Purchases" and the
    // import flow's overwrite step all reported success while leaving the
    // old records in place (or, for purchases, duplicating on re-import).
    function clearStore(storeName) {
        if (storeName === 'challenges')   return _api('DELETE', '/api/admin/challenges');
        if (storeName === 'transactions') return _api('DELETE', '/api/me/transactions');
        if (storeName === 'payments')     return _api('DELETE', '/api/me/payments');
        if (storeName === 'purchaseHistory' || storeName === 'purchases') return _api('DELETE', '/api/me/purchases');
        if (storeName === 'cart')         return _api('DELETE', '/api/me/cart');
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

    // Self-service reset — scoped to the caller, unlike clearStore('challenges')
    // which maps to the admin-only DELETE /api/admin/challenges (wipes everyone).
    function resetMyChallenges() {
        return _api('POST', '/api/me/challenges/reset');
    }

    // Clears the caller's own transactions/payments/purchases/cart, resets
    // their balances + userData to defaults, and re-seeds their challenges.
    function resetMyProgress() {
        return _api('POST', '/api/me/reset');
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
        return _api('POST', '/api/admin/messages/system', opts);
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

    // ── Alert preferences ───────────────────────────────────────────────────────
    function getAlertPrefs() {
        return _api('GET', '/api/me/alert-prefs');
    }

    function setAlertPrefs(prefs) {
        return _api('PUT', '/api/me/alert-prefs', prefs);
    }

    // ── Credit card ──────────────────────────────────────────────────────────────
    function getCreditCard() {
        return _api('GET', '/api/me/credit-card');
    }

    function openCreditCard(tier) {
        return _api('POST', '/api/me/credit-card/open', { tier });
    }

    function creditCardPurchase(amount, description) {
        return _api('POST', '/api/me/credit-card/purchase', { amount, description });
    }

    function creditCardPayment(amount) {
        return _api('POST', '/api/me/credit-card/payment', { amount });
    }

    function getCreditCardActivity() {
        return _api('GET', '/api/me/credit-card/activity');
    }

    // ── Loans ────────────────────────────────────────────────────────────────────
    function getLoan() {
        return _api('GET', '/api/me/loan');
    }

    function applyForLoan(amount, termMonths) {
        return _api('POST', '/api/me/loan/apply', { amount, termMonths });
    }

    function makeLoanPayment(amount) {
        return _api('POST', '/api/me/loan/payment', { amount });
    }

    function getLoanPayments() {
        return _api('GET', '/api/me/loan/payments');
    }

    // ── Savings goals ────────────────────────────────────────────────────────────
    function getSavingsGoals() {
        return _api('GET', '/api/me/savings-goals');
    }

    function createSavingsGoal(name, target) {
        return _api('POST', '/api/me/savings-goals', { name, target });
    }

    function contributeSavingsGoal(id, amount) {
        return _api('POST', '/api/me/savings-goals/' + id + '/contribute', { amount });
    }

    function withdrawSavingsGoal(id, amount) {
        return _api('POST', '/api/me/savings-goals/' + id + '/withdraw', { amount });
    }

    function deleteSavingsGoal(id) {
        return _api('DELETE', '/api/me/savings-goals/' + id);
    }

    // ── Statement ────────────────────────────────────────────────────────────────
    function getStatement(account, month) {
        return _api('GET', '/api/me/statement?account=' + encodeURIComponent(account) + '&month=' + encodeURIComponent(month));
    }

    // ── Scheduled transfers ─────────────────────────────────────────────────────
    function getScheduledTransfers() {
        return _api('GET', '/api/me/scheduled-transfers');
    }

    function createScheduledTransfer(data) {
        return _api('POST', '/api/me/scheduled-transfers', data);
    }

    function toggleScheduledTransfer(id, active) {
        return _api('PATCH', '/api/me/scheduled-transfers/' + id, { active });
    }

    function cancelScheduledTransfer(id) {
        return _api('DELETE', '/api/me/scheduled-transfers/' + id);
    }

    // ── E-Commerce: product catalog ─────────────────────────────────────────────
    function getProducts(filters) {
        var f = filters || {};
        var qs = [];
        if (f.category) qs.push('category=' + encodeURIComponent(f.category));
        if (f.onSale)   qs.push('onSale=true');
        if (f.q)        qs.push('q=' + encodeURIComponent(f.q));
        return _api('GET', '/api/products' + (qs.length ? '?' + qs.join('&') : ''));
    }

    // ── E-Commerce: shipping addresses ──────────────────────────────────────────
    function getAddresses() {
        return _api('GET', '/api/me/addresses');
    }

    function createAddress(address) {
        return _api('POST', '/api/me/addresses', address);
    }

    function updateAddress(id, patch) {
        return _api('PUT', '/api/me/addresses/' + id, patch);
    }

    function deleteAddress(id) {
        return _api('DELETE', '/api/me/addresses/' + id);
    }

    // ── E-Commerce: payment methods ─────────────────────────────────────────────
    function getPaymentMethods() {
        return _api('GET', '/api/me/payment-methods');
    }

    function addPaymentMethod(card) {
        return _api('POST', '/api/me/payment-methods', card);
    }

    function setDefaultPaymentMethod(id) {
        return _api('PATCH', '/api/me/payment-methods/' + id + '/default');
    }

    function deletePaymentMethod(id) {
        return _api('DELETE', '/api/me/payment-methods/' + id);
    }

    // ── E-Commerce: checkout ─────────────────────────────────────────────────────
    function checkout(details) {
        return _api('POST', '/api/me/checkout', details);
    }

    function getOrder(id) {
        return _api('GET', '/api/me/purchases/' + id);
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
        awardPoints,
        getProfileData,
        setProfileData,
        changePassword,

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

        // Utilities: bills
        getMyBills,
        payBillCycle,
        getCustomBills,
        createCustomBill,
        updateCustomBill,
        deleteCustomBill,

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
        adminDeleteChallenge,
        adminCreateChallenge,
        clearStore,
        seedDefaultChallenges,
        reseedMissingChallenges,
        checkAndCompleteChallenges,
        getLevel1Requirements,
        purgeDuplicateChallenges,
        seedChallengesForUser,
        resetMyChallenges,
        resetMyProgress,

        // Messages
        getMessagesForUser,
        markMessageRead,
        sendAdminMessage,
        sendSystemMessage,
        getAllSentMessages,
        deleteAdminMessage,

        // Stats & activity
        getStats,
        getRecentActivity,

        // Alert preferences
        getAlertPrefs,
        setAlertPrefs,

        // Credit card
        getCreditCard,
        openCreditCard,
        creditCardPurchase,
        creditCardPayment,
        getCreditCardActivity,

        // Loans
        getLoan,
        applyForLoan,
        makeLoanPayment,
        getLoanPayments,

        // Savings goals
        getSavingsGoals,
        createSavingsGoal,
        contributeSavingsGoal,
        withdrawSavingsGoal,
        deleteSavingsGoal,

        // Statement
        getStatement,

        // Scheduled transfers
        getScheduledTransfers,
        createScheduledTransfer,
        toggleScheduledTransfer,
        cancelScheduledTransfer,

        // E-Commerce: products
        getProducts,

        // E-Commerce: addresses
        getAddresses,
        createAddress,
        updateAddress,
        deleteAddress,

        // E-Commerce: payment methods
        getPaymentMethods,
        addPaymentMethod,
        setDefaultPaymentMethod,
        deletePaymentMethod,

        // E-Commerce: checkout
        checkout,
        getOrder
    };
})();
