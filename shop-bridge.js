// shop-bridge.js — shared helpers for the InStyl (E-Commerce module) pages.
// Loaded by ecommerce.html and every shop-*.html page after db.js. The
// session comes from DigifinwizModuleAuth (module-auth.js); all data lives
// on the server (DigifinwizDB), except the per-user saved-items and
// viewed-categories lists, which are browser-local conveniences.

const ShopBridge = (() => {

    // ── Session ─────────────────────────────────────────────────────────────
    function getSession() {
        if (typeof DigifinwizModuleAuth !== 'undefined') return DigifinwizModuleAuth.getSession();
        return null;
    }

    function isAvailable() {
        return typeof DigifinwizDB !== 'undefined' && !!getSession();
    }

    function _userId() {
        var s = getSession();
        return s && s.userId != null ? s.userId : null;
    }

    // localStorage wrapper — never throws (private mode / blocked storage).
    function _lsGet(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            return raw == null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
    }
    function _lsSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }

    function _escH(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // ── Game progress (level / XP / coins) ─────────────────────────────────
    // Mirrors the server's XP model: each level is 1000 XP and
    // userData.pointsToNextLevel counts down to the next one.
    function progressFromUserData(ud) {
        ud = ud || {};
        var level = ud.level || 1;
        var toNext = ud.pointsToNextLevel != null ? ud.pointsToNextLevel : 1000;
        var pct = Math.max(0, Math.min(100, Math.round(((1000 - toNext) / 1000) * 100)));
        return { level: level, xp: ud.points || 0, coins: ud.coins || 0, pointsToNextLevel: toNext, pct: pct };
    }

    function renderProgress(ud) {
        var p = progressFromUserData(ud);
        function set(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }
        set('shopProgressLevel', p.level + '/50');
        set('shopProgressText', p.pct + '% completed');
        set('shopProgressXP', p.xp.toLocaleString() + ' XP');
        set('shopProgressCoins', p.coins.toLocaleString());
        var fill = document.getElementById('shopProgressFill');
        if (fill) fill.style.width = p.pct + '%';
        // Account summary card + wallet balance cards
        document.querySelectorAll('.card-progress-fill').forEach(function(el) { el.style.width = p.pct + '%'; });
        set('shopCoinsAmount', p.coins.toLocaleString());
        set('shopXpAmount', p.xp.toLocaleString());
        set('shopXpNote', 'Level ' + p.level + '/50 · ' + p.pointsToNextLevel.toLocaleString() + ' XP to next level');
        var compact = document.querySelector('.amz-progress-compact');
        if (compact) compact.title = 'Level ' + p.level + ' — ' + p.pointsToNextLevel.toLocaleString() + ' XP to the next level';
        return p;
    }

    function refreshProgress() {
        if (!isAvailable()) return Promise.resolve(null);
        return DigifinwizDB.getUserData().then(function(ud) {
            renderProgress(ud);
            return ud;
        }).catch(function() { return null; });
    }

    // ── Cart ────────────────────────────────────────────────────────────────
    var MAX_QTY = 99;

    function isValidQty(q) {
        return typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= MAX_QTY;
    }

    function getCart() {
        return DigifinwizDB.getCart().then(function(items) { return items || []; });
    }

    // One POST for the one product being added — the server merges it into
    // an existing row for the same product (capped at 99).
    function addToCart(product, quantity) {
        var qty = quantity === undefined ? 1 : quantity;
        if (!isValidQty(qty)) return Promise.reject(new Error('Quantity must be a whole number from 1 to ' + MAX_QTY));
        if (!product || !product.name) return Promise.reject(new Error('Unknown product'));
        var row = { name: product.name, price: Number(product.price) || 0, quantity: qty };
        if (product.id != null) row.productId = product.id;
        return DigifinwizDB.addCartItem(row).then(function(id) {
            refreshCartBadge();
            return id;
        });
    }

    function renderCartBadge(items) {
        var count = (items || []).reduce(function(t, i) { return t + (Number(i.quantity) || 1); }, 0);
        var badge = document.getElementById('headerCartBadge');
        if (badge) {
            badge.textContent = count;
            badge.style.display = count > 0 ? '' : 'none';
        }
        return count;
    }

    function refreshCartBadge() {
        if (!isAvailable()) return Promise.resolve(0);
        return getCart().then(renderCartBadge).catch(function() { return 0; });
    }

    // ── Saved items (per user, keyed by catalog product id) ─────────────────
    function _savedKey() {
        var uid = _userId();
        return uid == null ? null : 'instyl_saved_products_u' + uid;
    }

    function getSavedIds() {
        var key = _savedKey();
        if (!key) return [];
        var ids = _lsGet(key, []);
        return Array.isArray(ids) ? ids.filter(function(x) { return typeof x === 'number'; }) : [];
    }

    function _setSavedIds(ids) {
        var key = _savedKey();
        if (!key) return;
        _lsSet(key, ids);
        renderSavedBadge();
    }

    function isSaved(productId) {
        return getSavedIds().indexOf(Number(productId)) !== -1;
    }

    // Returns true when the product is saved after the toggle.
    function toggleSaved(productId) {
        var id = Number(productId);
        var ids = getSavedIds();
        var idx = ids.indexOf(id);
        if (idx === -1) ids.push(id); else ids.splice(idx, 1);
        _setSavedIds(ids);
        return idx === -1;
    }

    function removeSaved(productId) {
        _setSavedIds(getSavedIds().filter(function(x) { return x !== Number(productId); }));
    }

    function renderSavedBadge() {
        var count = getSavedIds().length;
        var badge = document.getElementById('headerWishlistBadge');
        if (badge) {
            badge.textContent = count;
            badge.style.display = count > 0 ? '' : 'none';
        }
        return count;
    }

    // ── Messages ────────────────────────────────────────────────────────────
    function isMessageRead(m) {
        var uid = _userId();
        return (m.readBy || []).some(function(r) { return String(r) === String(uid); });
    }

    function getMessages() {
        return DigifinwizDB.getMessagesForUser().then(function(list) {
            return (list || []).slice().sort(function(a, b) {
                return (b.sentAt || 0) - (a.sentAt || 0) || (b.id || 0) - (a.id || 0);
            });
        });
    }

    function renderUnreadBadge(count) {
        document.querySelectorAll('.shop-msg-badge').forEach(function(b) {
            b.textContent = count;
            b.style.display = count > 0 ? '' : 'none';
        });
    }

    function refreshUnreadBadge() {
        if (!isAvailable()) return Promise.resolve(0);
        return getMessages().then(function(list) {
            var unread = list.filter(function(m) { return !isMessageRead(m); }).length;
            renderUnreadBadge(unread);
            return unread;
        }).catch(function() { return 0; });
    }

    // ── Profile ─────────────────────────────────────────────────────────────
    // Core fields (fullName, username, email) come from the account record;
    // phone/birthdate/gender live in userData.shopProfile.
    function getFullProfile() {
        return Promise.all([DigifinwizDB.getProfileData(), DigifinwizDB.getUserData()]).then(function(r) {
            var extras = (r[1] && r[1].shopProfile) ? r[1].shopProfile : {};
            return Object.assign({}, extras, r[0] || {});
        });
    }

    // data: { fullName?, email?, phone?, birthdate?, gender? }. Rejects with
    // the server's error (e.g. "Email already registered") — callers must
    // surface it rather than reporting success.
    function saveProfile(data) {
        var core = {};
        if (data.fullName !== undefined) core.fullName = data.fullName;
        if (data.email    !== undefined) core.email    = data.email;
        var extras = {};
        ['phone', 'birthdate', 'gender'].forEach(function(k) { if (data[k] !== undefined) extras[k] = data[k]; });

        var p = Object.keys(core).length ? DigifinwizDB.setProfileData(core) : Promise.resolve(null);
        return p.then(function(saved) {
            if (saved && saved.fullName && typeof DigifinwizModuleAuth !== 'undefined') {
                DigifinwizModuleAuth.updateSession({ fullName: saved.fullName });
            }
            if (!Object.keys(extras).length) return saved;
            return DigifinwizDB.getUserData().then(function(ud) {
                var updated = Object.assign({}, ud || {}, {
                    shopProfile: Object.assign({}, (ud || {}).shopProfile || {}, extras)
                });
                return DigifinwizDB.setUserData(updated);
            }).then(function() { return saved; });
        });
    }

    // ── Manual challenges ──────────────────────────────────────────────────
    // Completes one of the caller's own 'manual' challenges (by title) and
    // awards its points the same way challenges.html does. The server only
    // lets a manual challenge be completed once, so this can't be repeated.
    // Resolves null when there is nothing to complete.
    function completeManualChallenge(title) {
        if (!isAvailable()) return Promise.resolve(null);
        return DigifinwizDB.getChallenges().then(function(list) {
            var c = (list || []).find(function(x) { return x.title === title && x.condition === 'manual'; });
            if (!c || c.completed || c.active === false) return null;
            return DigifinwizDB.updateChallenge(c.id, { completed: true }).then(function() {
                return DigifinwizDB.getUserData();
            }).then(function(ud) {
                ud = ud || {};
                return DigifinwizDB.awardPoints(c.points || 0, {
                    coins: (ud.coins || 0) + (c.florins || 0),
                    challenges: (ud.challenges || 0) + 1
                });
            }).then(function(res) {
                renderProgress(res.userData);
                return { challenge: c, leveledUp: res.leveledUp, newLevel: res.newLevel };
            });
        });
    }

    // ── "Product Expert": categories viewed (per user) ──────────────────────
    function _viewedKey() {
        var uid = _userId();
        return uid == null ? null : 'instyl_viewed_categories_u' + uid;
    }

    function getViewedCategories() {
        var key = _viewedKey();
        var v = key ? _lsGet(key, []) : [];
        return Array.isArray(v) ? v : [];
    }

    // allCategories: every category in the live catalog. Resolves the
    // completion result once every category has been viewed, else null.
    function recordCategoryView(category, allCategories) {
        var key = _viewedKey();
        if (!key || !category || !allCategories || allCategories.indexOf(category) === -1) return Promise.resolve(null);
        var viewed = getViewedCategories();
        if (viewed.indexOf(category) === -1) {
            viewed.push(category);
            _lsSet(key, viewed);
        }
        var all = allCategories.every(function(c) { return viewed.indexOf(c) !== -1; });
        if (!all) return Promise.resolve(null);
        return completeManualChallenge('Product Expert').catch(function() { return null; });
    }

    // ── Page chrome: header progress, badges, header icons ─────────────────
    function initChrome() {
        var userBtn = document.querySelector('.shop-icon-btn.user');
        if (userBtn && !userBtn.getAttribute('onclick')) {
            userBtn.title = 'My Account';
            userBtn.addEventListener('click', function() { window.location.href = 'shop-account.html'; });
        }
        if (!isAvailable()) return;
        renderSavedBadge();
        refreshProgress();
        refreshCartBadge();
        refreshUnreadBadge();
        // Keep the saved-items badge in sync with other tabs.
        window.addEventListener('storage', function(e) {
            if (e.key && e.key === _savedKey()) renderSavedBadge();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initChrome);
    } else {
        initChrome();
    }

    return {
        getSession, escapeHtml: _escH,
        // progress
        renderProgress, refreshProgress,
        // cart
        addToCart, refreshCartBadge, renderCartBadge,
        // saved items
        getSavedIds, isSaved, toggleSaved, removeSaved, renderSavedBadge,
        // messages
        getMessages, isMessageRead, refreshUnreadBadge, renderUnreadBadge,
        // profile
        getFullProfile, saveProfile,
        // challenges
        completeManualChallenge, getViewedCategories, recordCategoryView
    };
})();
