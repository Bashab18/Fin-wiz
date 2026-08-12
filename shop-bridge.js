// shop-bridge.js — adapter between InStyl shopping system and DigifinwizDB
// Falls back gracefully to localStorage when DigifinwizDB is unavailable.

const ShopBridge = (() => {

    function isAvailable() {
        return typeof DigifinwizDB !== 'undefined' &&
               typeof DigifinwizAuth !== 'undefined' &&
               DigifinwizAuth.isLoggedIn();
    }

    // User-scoped localStorage key to isolate per-user data
    function _scopedKey(key) {
        try {
            var s = JSON.parse(sessionStorage.getItem('bkr_session') || 'null') ||
                    JSON.parse(localStorage.getItem('bkr_session') || 'null');
            return s && s.userId ? key + '_u' + s.userId : key;
        } catch(e) { return key; }
    }

    async function getXPData() {
        if (isAvailable()) {
            try {
                const userData = await DigifinwizDB.getUserData();
                if (userData) {
                    return {
                        level:  userData.level  || 1,
                        xp:     userData.points || 0,
                        coins:  userData.coins  !== undefined ? userData.coins : 0
                    };
                }
            } catch (e) { /* fall through to localStorage */ }
        }
        return {
            level:  parseInt(localStorage.getItem(_scopedKey('shop_level'))  || '1',  10),
            xp:     parseInt(localStorage.getItem(_scopedKey('shop_xp'))     || '0',  10),
            coins:  parseInt(localStorage.getItem(_scopedKey('shop_coins'))  || '0',  10)
        };
    }

    async function saveXPData(level, xp, coins, xpDelta) {
        // Scoped per-user like every other fallback key here — otherwise on a
        // shared browser these numbers leak across accounts (or, once one
        // API call fails, get written back into the wrong user's DB record
        // the next time saveXPData succeeds). level/xp are this page's own
        // local display cache only (see GameProgress) — the server write
        // below never sets them as an absolute overwrite.
        localStorage.setItem(_scopedKey('shop_level'),  String(level));
        localStorage.setItem(_scopedKey('shop_xp'),     String(xp));
        localStorage.setItem(_scopedKey('shop_coins'),  String(coins));
        if (!isAvailable()) return;
        try {
            if (xpDelta) {
                // Canonical delta-based increment (DigifinwizDB.awardPoints)
                // keeps userData.points/pointsToNextLevel/level mutually
                // consistent with every other earning flow in the app, and
                // reads the current server value right before writing —
                // unlike setting points to this page's own absolute xp
                // counter, it can't clobber points earned elsewhere (e.g. a
                // checkout completed in another tab) in between.
                await DigifinwizDB.awardPoints(xpDelta, { coins });
            } else {
                const userData = await DigifinwizDB.getUserData();
                const updated  = Object.assign({}, userData || {}, { coins });
                await DigifinwizDB.setUserData(updated);
            }
        } catch (e) { /* silent — localStorage already updated */ }
    }

    async function getCart() {
        if (isAvailable()) {
            try {
                // A successful fetch that returns [] means the cart really is
                // empty (e.g. right after checkout) — falling through to
                // localStorage in that case resurrected whatever stale cart was
                // sitting there before the last checkout. Only fall back when
                // the DB itself is unreachable.
                const items = await DigifinwizDB.getCart();
                return items || [];
            } catch (e) { /* fall through to localStorage */ }
        }
        return JSON.parse(localStorage.getItem(_scopedKey('instyl_cart')) || '[]');
    }

    async function saveCart(items) {
        localStorage.setItem(_scopedKey('instyl_cart'), JSON.stringify(items));
        if (!isAvailable()) return;
        try {
            await DigifinwizDB.clearCart();
            for (const item of items) {
                await DigifinwizDB.addCartItem(item);
            }
        } catch (e) { /* silent */ }
    }

    function getSavedItems() {
        return JSON.parse(localStorage.getItem(_scopedKey('instyl_saved')) || '[]');
    }

    function saveSavedItems(ids) {
        localStorage.setItem(_scopedKey('instyl_saved'), JSON.stringify(ids));
    }

    async function recordPurchase(record) {
        if (!isAvailable()) return;
        try {
            await DigifinwizDB.addPurchase(Object.assign({ timestamp: Date.now() }, record));
        } catch (e) { /* silent */ }
    }

    async function getPurchases() {
        if (!isAvailable()) return [];
        try {
            return (await DigifinwizDB.getPurchases()) || [];
        } catch (e) { return []; }
    }

    async function getTransactions() {
        if (!isAvailable()) return [];
        try {
            return (await DigifinwizDB.getTransactions(20)) || [];
        } catch (e) { return []; }
    }

    function getSession() {
        if (typeof DigifinwizAuth !== 'undefined') return DigifinwizAuth.getSession();
        return null;
    }

    // ── Profile helpers ──────────────────────────────────────────────────────
    // Returns merged profile: DB fields (fullName, username, email) + extras
    // (phone, birthdate, gender) stored in userData.shopProfile
    async function getFullProfile() {
        if (isAvailable()) {
            try {
                const [dbProfile, userData] = await Promise.all([
                    DigifinwizDB.getProfileData(),
                    DigifinwizDB.getUserData()
                ]);
                const extras = (userData && userData.shopProfile) ? userData.shopProfile : {};
                return Object.assign({}, extras, dbProfile || {});
            } catch(e) {}
        }
        return JSON.parse(localStorage.getItem(_scopedKey('shop_profile')) || '{}');
    }

    // data: { fullName?, email?, phone?, birthdate?, gender? }
    async function saveProfile(data) {
        const lsKey = _scopedKey('shop_profile');
        const existing = JSON.parse(localStorage.getItem(lsKey) || '{}');
        localStorage.setItem(lsKey, JSON.stringify(Object.assign({}, existing, data)));
        if (!isAvailable()) return;
        try {
            const ops = [];
            const coreUpdate = {};
            if (data.fullName !== undefined) coreUpdate.fullName = data.fullName;
            if (data.email    !== undefined) coreUpdate.email    = data.email;
            if (Object.keys(coreUpdate).length > 0) {
                ops.push(DigifinwizDB.setProfileData(coreUpdate));
            }
            const extraKeys = ['phone', 'birthdate', 'gender'];
            const extras = {};
            extraKeys.forEach(k => { if (data[k] !== undefined) extras[k] = data[k]; });
            if (Object.keys(extras).length > 0) {
                ops.push(
                    DigifinwizDB.getUserData().then(ud => {
                        const updated = Object.assign({}, ud || {}, {
                            shopProfile: Object.assign({}, (ud || {}).shopProfile || {}, extras)
                        });
                        return DigifinwizDB.setUserData(updated);
                    })
                );
            }
            await Promise.all(ops);
        } catch(e) { /* silent */ }
    }

    // ── Address helpers ──────────────────────────────────────────────────────
    // Addresses stored in userData.addresses (array) in DigifinwizDB,
    // with localStorage as fallback.
    async function getAddresses() {
        if (isAvailable()) {
            try {
                const userData = await DigifinwizDB.getUserData();
                if (userData && Array.isArray(userData.addresses)) return userData.addresses;
            } catch(e) {}
        }
        return JSON.parse(localStorage.getItem(_scopedKey('shop_addresses')) || '[]');
    }

    async function saveAddresses(addresses) {
        localStorage.setItem(_scopedKey('shop_addresses'), JSON.stringify(addresses));
        if (!isAvailable()) return;
        try {
            const userData = await DigifinwizDB.getUserData();
            const updated = Object.assign({}, userData || {}, { addresses });
            await DigifinwizDB.setUserData(updated);
        } catch(e) {}
    }

    return {
        isAvailable,
        getXPData, saveXPData,
        getCart, saveCart,
        getSavedItems, saveSavedItems,
        recordPurchase, getPurchases, getTransactions,
        getSession,
        getFullProfile, saveProfile,
        getAddresses, saveAddresses
    };
})();
