// InStyl Shopping System - JavaScript (unified with DigifinwizDB via ShopBridge)

// ── Game Progress ─────────────────────────────────────────────────────────────

class GameProgress {
    constructor(data) {
        data         = data || {};
        this.level    = data.level  || 1;
        this.maxLevel = 50;
        this.xp       = data.xp    || 0;
        this.coins    = data.coins || 0;
        this.progress = this.calcProgress();
    }

    static async create() {
        const data = (typeof ShopBridge !== 'undefined') ? await ShopBridge.getXPData() : {};
        return new GameProgress(data);
    }

    calcProgress() {
        const xpPerLevel = 1000;
        return ((this.xp % xpPerLevel) / xpPerLevel) * 100;
    }

    async addXP(amount) {
        this.xp      += amount;
        this.progress = this.calcProgress();
        this.checkLevelUp();
        await this.save();
        this.updateDisplay();
    }

    async addCoins(amount) {
        this.coins += amount;
        await this.save();
        this.updateDisplay();
    }

    spendCoins(amount) {
        if (this.coins >= amount) {
            this.coins -= amount;
            this.save();
            this.updateDisplay();
            return true;
        }
        return false;
    }

    async save() {
        if (typeof ShopBridge !== 'undefined') {
            await ShopBridge.saveXPData(this.level, this.xp, this.coins);
        } else {
            localStorage.setItem('shop_level',  this.level);
            localStorage.setItem('shop_xp',     this.xp);
            localStorage.setItem('shop_coins',  this.coins);
        }
    }

    checkLevelUp() {
        const xpPerLevel = 1000;
        const newLevel   = Math.min(Math.floor(this.xp / xpPerLevel) + 1, this.maxLevel);
        if (newLevel > this.level) {
            this.level = newLevel;
            this.showLevelUpNotification();
        }
    }

    updateDisplay() {
        document.querySelectorAll('.progress-bar, .card-progress-fill').forEach(bar => {
            bar.style.width = this.progress + '%';
        });
        document.querySelectorAll('.level-info strong, .level-number').forEach(d => {
            d.textContent = this.level + '/' + this.maxLevel;
        });
        document.querySelectorAll('.stat span').forEach(d => {
            if (d.previousElementSibling && d.previousElementSibling.tagName === 'svg') {
                d.textContent = this.xp.toLocaleString() + ' XP';
            }
        });
        document.querySelectorAll('.xp-amount, .xp-balance .balance-amount').forEach(d => {
            d.textContent = this.xp.toLocaleString();
        });
        document.querySelectorAll('.coins-amount, .coins-balance .balance-amount, .stat.coins span').forEach(d => {
            d.textContent = this.coins.toLocaleString();
        });
        document.querySelectorAll('.progress-text').forEach(d => {
            d.textContent = Math.round(this.progress) + '% completed';
        });
        document.querySelectorAll('.xp-balance .balance-note').forEach(d => {
            d.textContent = 'Level ' + this.level + '/' + this.maxLevel;
        });
        // Named wallet elements
        const coinsEl  = document.getElementById('shopCoinsAmount');
        const xpEl     = document.getElementById('shopXpAmount');
        const xpNoteEl = document.getElementById('shopXpNote');
        if (coinsEl)  coinsEl.textContent  = this.coins.toLocaleString();
        if (xpEl)     xpEl.textContent     = this.xp.toLocaleString();
        if (xpNoteEl) xpNoteEl.textContent = 'Level ' + this.level + '/50';
    }

    showLevelUpNotification() {
        const n = document.createElement('div');
        n.className  = 'level-up-notification';
        n.innerHTML  = '<h3>Level Up!</h3><p>You\'ve reached Level ' + this.level + '!</p><p>+500 Bonus Coins</p>';
        document.body.appendChild(n);
        this.addCoins(500);
        setTimeout(() => { n.classList.add('show'); }, 100);
        setTimeout(() => { n.classList.remove('show'); setTimeout(() => n.remove(), 300); }, 3000);
    }
}

// ── Shopping Cart ─────────────────────────────────────────────────────────────

class ShoppingCart {
    constructor(items) {
        this.items = items || [];
        this.updateCartCount();
    }

    static async create() {
        const items = (typeof ShopBridge !== 'undefined')
            ? await ShopBridge.getCart()
            : JSON.parse(localStorage.getItem('instyl_cart') || '[]');
        return new ShoppingCart(items);
    }

    addItem(product) {
        const existing = this.items.find(i => i.id === product.id);
        if (existing) {
            existing.quantity += 1;
        } else {
            this.items.push(Object.assign({}, product, { quantity: 1 }));
        }
        this.save();
        this.updateCartCount();
        this.showNotification('Item added to cart!');
        if (window.gameProgress) window.gameProgress.addXP(10);
    }

    removeItem(productId) {
        this.items = this.items.filter(i => i.id !== productId);
        this.save();
        this.updateCartCount();
    }

    save() {
        if (typeof ShopBridge !== 'undefined') {
            ShopBridge.saveCart(this.items);
        } else {
            localStorage.setItem('instyl_cart', JSON.stringify(this.items));
        }
    }

    updateCartCount() {
        const count = this.items.reduce((t, i) => t + i.quantity, 0);
        document.querySelectorAll('.shop-icon-btn.cart').forEach(btn => {
            let badge = btn.querySelector('.cart-badge');
            if (!badge && count > 0) {
                badge = document.createElement('span');
                badge.className = 'cart-badge';
                btn.appendChild(badge);
            }
            if (badge) {
                badge.textContent   = count;
                badge.style.display = count > 0 ? 'flex' : 'none';
            }
        });
    }

    getTotal() {
        return this.items.reduce((t, i) => t + (i.price * i.quantity), 0);
    }

    showNotification(message) {
        const n = document.createElement('div');
        n.className   = 'cart-notification';
        n.textContent = message;
        document.body.appendChild(n);
        setTimeout(() => { n.classList.add('show'); }, 100);
        setTimeout(() => { n.classList.remove('show'); setTimeout(() => n.remove(), 300); }, 2000);
    }
}

// ── Saved Items ───────────────────────────────────────────────────────────────

class SavedItems {
    constructor() {
        this.items = (typeof ShopBridge !== 'undefined')
            ? ShopBridge.getSavedItems()
            : JSON.parse(localStorage.getItem('instyl_saved') || '[]');
    }

    toggleItem(productId) {
        const idx = this.items.indexOf(productId);
        if (idx > -1) {
            this.items.splice(idx, 1);
            this.showNotification('Item removed from saved items');
        } else {
            this.items.push(productId);
            this.showNotification('Item saved!');
            if (window.gameProgress) window.gameProgress.addXP(5);
        }
        this.save();
        return this.items.includes(productId);
    }

    isItemSaved(productId) { return this.items.includes(productId); }

    save() {
        if (typeof ShopBridge !== 'undefined') {
            ShopBridge.saveSavedItems(this.items);
        } else {
            localStorage.setItem('instyl_saved', JSON.stringify(this.items));
        }
    }

    showNotification(message) {
        const n = document.createElement('div');
        n.className   = 'saved-notification';
        n.textContent = message;
        document.body.appendChild(n);
        setTimeout(() => { n.classList.add('show'); }, 100);
        setTimeout(() => { n.classList.remove('show'); setTimeout(() => n.remove(), 300); }, 2000);
    }
}

// ── Dynamic renderers ─────────────────────────────────────────────────────────

async function renderOrderHistory() {
    const container = document.getElementById('ordersList');
    if (!container) return;
    try {
        const purchases = (typeof ShopBridge !== 'undefined') ? await ShopBridge.getPurchases() : [];
        if (purchases.length === 0) {
            container.innerHTML = '<p style="color:#64748b;padding:30px 0;">No orders found. Start shopping to see your orders here!</p>';
            return;
        }
        container.innerHTML = purchases.map(p => {
            const date  = p.timestamp
                ? new Date(p.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
                : 'Unknown date';
            const total = typeof p.amount === 'number'
                ? '$' + p.amount.toFixed(2)
                : (p.total ? '$' + Number(p.total).toFixed(2) : 'N/A');
            return `<div class="order-item">
                <div class="order-header">
                    <div class="order-info">
                        <span class="order-number">Order #${p.id || 'N/A'}</span>
                        <span class="order-date">Placed on ${date}</span>
                    </div>
                    <div class="order-total">
                        <span class="total-label">Total:</span>
                        <span class="total-amount">${total}</span>
                    </div>
                </div>
                <div class="order-body">
                    <div class="order-products">
                        <div class="product-item">
                            <div class="product-details">
                                <h4>${p.name || p.description || 'Order items'}</h4>
                                <p>${p.category || ''}</p>
                            </div>
                        </div>
                    </div>
                    <div class="order-status-badge delivered">Completed</div>
                </div>
                <div class="order-actions">
                    <button class="btn btn-secondary">View Details</button>
                    <button class="btn btn-secondary">Buy Again</button>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        container.innerHTML = '<p style="color:#64748b;padding:30px 0;">Unable to load orders.</p>';
    }
}

async function renderWalletData() {
    try {
        const xpData  = (typeof ShopBridge !== 'undefined') ? await ShopBridge.getXPData() : { level: 2, xp: 1400, coins: 3400 };
        const coinsEl = document.getElementById('shopCoinsAmount');
        const xpEl    = document.getElementById('shopXpAmount');
        const noteEl  = document.getElementById('shopXpNote');
        if (coinsEl) coinsEl.textContent = xpData.coins.toLocaleString();
        if (xpEl)    xpEl.textContent    = xpData.xp.toLocaleString();
        if (noteEl)  noteEl.textContent  = 'Level ' + xpData.level + '/50';

        const txEl = document.getElementById('shopTransactionsList');
        if (txEl && typeof ShopBridge !== 'undefined') {
            const purchases = await ShopBridge.getPurchases();
            if (purchases.length > 0) {
                txEl.innerHTML = purchases.slice(0, 8).map(p => {
                    const date   = p.timestamp ? new Date(p.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
                    const amount = typeof p.amount === 'number' ? p.amount : Number(p.total || 0);
                    const coins  = Math.floor(amount / 10);
                    return `<div class="transaction-item earned">
                        <div class="transaction-icon">+</div>
                        <div class="transaction-details">
                            <h4>Purchase Reward</h4>
                            <p>${p.name || p.description || 'Order #' + (p.id || '')}</p>
                            <span class="transaction-date">${date}</span>
                        </div>
                        <div class="transaction-amount positive">+${coins} coins</div>
                    </div>`;
                }).join('');
            }
        }
    } catch (e) { /* silent */ }
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async function() {
    // Init DB first so ShopBridge reads real user data instead of falling back to localStorage
    if (typeof DigifinwizDB !== 'undefined') {
        await DigifinwizDB.init().catch(function(){});
    }

    window.gameProgress = await GameProgress.create();
    window.cart         = await ShoppingCart.create();
    window.savedItems   = new SavedItems();

    // Update saved items count badge
    const savedCountEl = document.getElementById('savedItemsCount');
    if (savedCountEl) savedCountEl.textContent = savedItems.items.length;

    gameProgress.updateDisplay();

    if (document.getElementById('ordersList'))           renderOrderHistory();
    if (document.getElementById('shopCoinsAmount') ||
        document.getElementById('shopTransactionsList')) renderWalletData();

    // Add to Cart
    document.querySelectorAll('.btn-primary').forEach(function(button, index) {
        if (button.textContent.trim() === 'Add to Cart') {
            button.addEventListener('click', function(e) {
                e.preventDefault();
                const card = this.closest('.product-card');
                cart.addItem({
                    id:       'product-' + index,
                    name:     (card.querySelector('.product-title')    || {}).textContent || 'Product',
                    price:    parseFloat(((card.querySelector('.product-price') || {}).textContent || '0').replace(/[^0-9.]/g, '')),
                    category: (card.querySelector('.product-category') || {}).textContent || 'General'
                });
            });
        }
    });

    // Bookmarks
    document.querySelectorAll('.bookmark-btn').forEach(function(button, index) {
        const productId = 'product-' + index;
        if (savedItems.isItemSaved(productId)) button.classList.add('active');
        button.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            this.classList.toggle('active', savedItems.toggleItem(productId));
        });
    });

    // Forms (skip pages that have their own submit handler)
    document.querySelectorAll('form:not([data-custom-submit])').forEach(function(form) {
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            gameProgress.addXP(50);
            gameProgress.addCoins(25);
            showShopToast('Changes saved! +50 XP, +25 Coins');
        });
    });

    // Search
    document.querySelectorAll('.shop-search-box input, .search-input').forEach(function(input) {
        input.addEventListener('input', function() {
            const term = this.value.toLowerCase();
            document.querySelectorAll('.product-card, .order-item').forEach(function(el) {
                el.style.display = (term.length > 2 && !el.textContent.toLowerCase().includes(term)) ? 'none' : '';
            });
        });
    });
});

// ── Global helpers ────────────────────────────────────────────────────────────

function navigateTo(page) { window.location.href = page; }

window.simulatePurchase = async function(amount) {
    const xpReward   = Math.floor(amount * 2);
    const coinReward = Math.floor(amount / 10);
    if (window.gameProgress) {
        await window.gameProgress.addXP(xpReward);
        await window.gameProgress.addCoins(coinReward);
    }
    if (typeof ShopBridge !== 'undefined') {
        await ShopBridge.recordPurchase({ amount, name: 'InStyl Purchase', timestamp: Date.now() });
    }
    alert('Purchase complete! Earned ' + xpReward + ' XP and ' + coinReward + ' coins!');
};

window.redeemCoins = function(amount) {
    if (window.gameProgress && window.gameProgress.spendCoins(amount)) {
        showShopToast('Successfully redeemed ' + amount + ' coins!');
    } else {
        showShopToast('Not enough coins!', true);
    }
};

function showShopToast(msg, isError) {
    var n = document.createElement('div');
    n.style.cssText = 'position:fixed;bottom:20px;right:20px;background:' + (isError ? '#ef4444' : '#10b981') +
        ';color:#fff;padding:12px 20px;border-radius:8px;font-size:0.875rem;z-index:9999;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.2);animation:fadeIn 0.2s ease';
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(function() { n.remove(); }, 2500);
}
