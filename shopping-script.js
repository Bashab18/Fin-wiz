// InStyl account pages (shop-*.html) — shared page behavior.
// Header progress, badges and the saved-items store live in shop-bridge.js.
// XP is only ever earned server-side (checkout, auto challenges) or through
// one-time manual challenges — never by submitting a form or toggling a
// bookmark, which the old generic handlers here let users repeat forever.

function _escOrderText(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Wallet: coin/XP balances + rewards earned per order ─────────────────────
async function renderWalletData() {
    const txEl = document.getElementById('shopTransactionsList');
    if (!txEl || typeof DigifinwizDB === 'undefined') return;
    try {
        const purchases = (await DigifinwizDB.getPurchases()) || [];
        if (purchases.length === 0) {
            txEl.innerHTML = '<div style="text-align:center;padding:32px 0;color:#64748b">' +
                '<p style="font-size:1rem;margin:0 0 6px;font-weight:600">No rewards yet</p>' +
                '<p style="font-size:0.85rem;margin:0">Every order earns XP and coins. ' +
                '<a href="ecommerce.html" style="color:var(--color-primary-500)">Start shopping</a> to see them here.</p></div>';
            return;
        }
        txEl.innerHTML = purchases.slice(0, 10).map(p => {
            const date  = p.timestamp ? new Date(p.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : (p.date || '');
            const coins = typeof p.coinsEarned === 'number' ? p.coinsEarned : Math.floor(Number(p.total || 0) / 10);
            const xp    = p.pointsEarned || 0;
            const items = Array.isArray(p.items) ? p.items : [];
            const desc  = items.length ? items.map(it => _escOrderText(it.name)).filter(Boolean).join(', ') : 'Order items';
            const label = p.orderId || ('#' + p.id);
            return `<a class="transaction-item earned" href="shop-order-detail.html?id=${encodeURIComponent(p.id)}" style="text-decoration:none;color:inherit">
                <div class="transaction-icon">+</div>
                <div class="transaction-details">
                    <h4>Order ${_escOrderText(label)} &middot; ƒ${Number(p.total || 0).toFixed(2)}</h4>
                    <p>${desc}</p>
                    <span class="transaction-date">${_escOrderText(date)}</span>
                </div>
                <div class="transaction-amount positive">+${coins} coins<br><span style="font-size:0.78rem;color:#10b981">+${xp} XP</span></div>
            </a>`;
        }).join('');
    } catch (e) {
        txEl.innerHTML = '<p style="color:#ef4444;padding:20px 0;">Could not load rewards history.</p>';
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
    if (document.getElementById('shopTransactionsList')) renderWalletData();

    // Forms without their own handler must not navigate away. They don't
    // save anything, so they don't claim to either (and never award XP).
    document.querySelectorAll('form:not([data-custom-submit])').forEach(function(form) {
        form.addEventListener('submit', function(e) { e.preventDefault(); });
    });

    // Header search: jump to the store with the term applied.
    document.querySelectorAll('.shop-search-box input').forEach(function(input) {
        input.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            var term = this.value.trim();
            window.location.href = 'ecommerce.html' + (term ? '?q=' + encodeURIComponent(term) : '');
        });
    });
});

// ── Global helpers ────────────────────────────────────────────────────────────

function showShopToast(msg, isError) {
    var n = document.createElement('div');
    n.setAttribute('role', isError ? 'alert' : 'status');
    n.style.cssText = 'position:fixed;bottom:20px;right:20px;background:' + (isError ? '#ef4444' : '#10b981') +
        ';color:#fff;padding:12px 20px;border-radius:8px;font-size:0.875rem;z-index:9999;max-width:360px;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.2);animation:fadeIn 0.2s ease';
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(function() { n.remove(); }, isError ? 4000 : 2500);
}
