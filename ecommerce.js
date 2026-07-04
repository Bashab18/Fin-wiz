// ecommerce.js - v2: persistent cart, balance deduction, checkout confirmation

var cart = []; // in-memory copy, synced with IndexedDB

// ── Cart persistence ─────────────────────────────────────────────────────────
function loadCart() {
    DigifinwizDB.getCart().then(function(items) {
        cart = items;
        renderCart();
    }).catch(function(err) { console.error('loadCart:', err); });
}

function addToCart(productName, price, btnEl) {
    // Animate the button immediately for perceived responsiveness
    if (btnEl) {
        btnEl.textContent = '✓ Added!';
        btnEl.disabled = true;
        setTimeout(function() { btnEl.textContent = 'Add to Cart'; btnEl.disabled = false; }, 1500);
    }
    DigifinwizDB.addCartItem({ name: productName, price: price }).then(function() {
        return DigifinwizDB.getCart();
    }).then(function(items) {
        cart = items;
        renderCart();
        scrollToCart();
        showNotification(productName + ' added to cart!', 'success');
    }).catch(function(err) { console.error('addToCart:', err); });
}

function removeFromCart(dbId, productName) {
    DigifinwizDB.removeCartItem(dbId).then(function() {
        return DigifinwizDB.getCart();
    }).then(function(items) {
        cart = items;
        renderCart();
        showNotification(productName + ' removed from cart.', 'info');
    }).catch(function(err) { console.error('removeFromCart:', err); });
}

function clearCartAndReload() {
    DigifinwizDB.clearCart().then(function() {
        cart = [];
        renderCart();
    });
}

function decrementCartItem(productName, price) {
    var match = cart.filter(function(i) { return i.name === productName; });
    if (!match.length) return;
    DigifinwizDB.removeCartItem(match[0].id).then(function() {
        return DigifinwizDB.getCart();
    }).then(function(items) {
        cart = items;
        renderCart();
        if (match.length === 1) showNotification(productName + ' removed from cart.', 'info');
    }).catch(function(err) { console.error('decrementCartItem:', err); });
}

function removeAllOfItem(productName) {
    var rows = cart.filter(function(i) { return i.name === productName; });
    if (!rows.length) return;
    Promise.all(rows.map(function(i) { return DigifinwizDB.removeCartItem(i.id); }))
        .then(function() { return DigifinwizDB.getCart(); })
        .then(function(items) {
            cart = items;
            renderCart();
            showNotification(productName + ' removed from cart.', 'info');
        })
        .catch(function(err) { console.error('removeAllOfItem:', err); });
}

// ── Scroll to cart ────────────────────────────────────────────────────────────
function scrollToCart() {
    var cartEl = document.getElementById('cartItems');
    if (cartEl) {
        cartEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// ── Cart UI ───────────────────────────────────────────────────────────────────
function renderCart() {
    var cartCount  = document.getElementById('cartCount');
    var cartItems  = document.getElementById('cartItems');
    var cartTotal  = document.getElementById('cartTotal');
    var checkoutBtn = document.getElementById('checkoutBtn');

    if (cartCount)  cartCount.textContent = cart.length;

    if (cart.length === 0) {
        if (cartItems) cartItems.innerHTML = '<p style="color:#64748b;padding:1rem">Your cart is empty</p>';
        if (cartTotal) cartTotal.textContent = 'ƒ0.00';
        var subEl0 = document.getElementById('cartSubtotal'); if (subEl0) subEl0.textContent = 'ƒ0.00';
        var taxEl0 = document.getElementById('cartTax');      if (taxEl0) taxEl0.textContent = 'ƒ0.00';
        var cntEl0 = document.getElementById('cartItemCount'); if (cntEl0) cntEl0.textContent = '0';
        if (checkoutBtn) checkoutBtn.disabled = true;
        var floatBtnEmpty = document.getElementById('floatCartBtn');
        if (floatBtnEmpty) floatBtnEmpty.style.display = 'none';
        var clearBtnEmpty = document.getElementById('clearCartBtn');
        if (clearBtnEmpty) clearBtnEmpty.style.display = 'none';
        return;
    }

    if (cartItems) {
        // Group items by name for quantity display
        var groups = {};
        cart.forEach(function(item) {
            if (!groups[item.name]) groups[item.name] = { name: item.name, price: item.price, rows: [] };
            groups[item.name].rows.push(item);
        });
        cartItems.innerHTML = Object.keys(groups).map(function(k) {
            var g = groups[k];
            var qty = g.rows.length;
            var subtotal = (g.price * qty).toFixed(2);
            return '<div class="cart-item">' +
                '<div style="flex:1"><strong>' + escHtml(g.name) + '</strong>' +
                '<div class="cart-item-price">ƒ' + Number(g.price).toFixed(2) + ' each' +
                (qty > 1 ? ' · ƒ' + subtotal + ' total' : '') + '</div></div>' +
                '<div class="cart-qty-controls">' +
                '<button class="btn-qty" onclick="decrementCartItem(' + JSON.stringify(g.name) + ',' + g.price + ')">−</button>' +
                '<span class="cart-qty-display">' + qty + '</span>' +
                '<button class="btn-qty" onclick="addToCart(' + JSON.stringify(g.name) + ',' + g.price + ')">+</button>' +
                '</div>' +
                '<button class="btn-remove" onclick="removeAllOfItem(' + JSON.stringify(g.name) + ')">×</button>' +
                '</div>';
        }).join('');
    }

    var total = cart.reduce(function(s, i) { return s + i.price; }, 0);
    if (cartTotal)   cartTotal.textContent = 'ƒ' + total.toFixed(2);
    if (checkoutBtn) checkoutBtn.disabled = false;

    // Populate cart breakdown rows
    var subtotalEl = document.getElementById('cartSubtotal');
    var taxEl      = document.getElementById('cartTax');
    var itemCntEl  = document.getElementById('cartItemCount');
    var itemSufEl  = document.getElementById('cartItemCountSuffix');
    var uniqueItems = Object.keys((function(){ var g={}; cart.forEach(function(i){ g[i.name]=1; }); return g; })()).length;
    if (subtotalEl) subtotalEl.textContent = 'ƒ' + total.toFixed(2);
    if (taxEl)      taxEl.textContent      = 'ƒ' + (total * 0.05).toFixed(2);
    if (itemCntEl)  itemCntEl.textContent  = cart.length;
    if (itemSufEl)  itemSufEl.textContent  = cart.length === 1 ? '' : 's';

    // Apply promo discount if active
    if (typeof updateCartWithPromo === 'function') updateCartWithPromo();

    // Mark in-cart products with a badge
    var inCartNames = {};
    cart.forEach(function(i){ inCartNames[i.name] = (inCartNames[i.name]||0)+1; });
    document.querySelectorAll('.product-card').forEach(function(c) {
        var old = c.querySelector('.in-cart-badge');
        if (old) old.remove();
        var qty = inCartNames[c.dataset.name || ''] || 0;
        if (qty > 0) {
            var imgDiv = c.querySelector('.product-image');
            if (imgDiv) {
                imgDiv.style.position = 'relative';
                var b = document.createElement('span');
                b.className = 'in-cart-badge';
                b.style.cssText = 'position:absolute;bottom:0.4rem;left:0.4rem;background:#6366f1;color:#fff;font-size:0.6rem;font-weight:800;padding:0.2rem 0.45rem;border-radius:6px;pointer-events:none;z-index:5';
                b.textContent = qty > 1 ? '🛒 ×'+qty+' in cart' : '🛒 In Cart';
                imgDiv.appendChild(b);
            }
        }
    });

    // Sync Clear Cart button
    var clearBtn = document.getElementById('clearCartBtn');
    if (clearBtn) clearBtn.style.display = '';

    // Sync floating View Cart button
    var floatBtn   = document.getElementById('floatCartBtn');
    var floatCount = document.getElementById('floatCartCount');
    if (floatBtn)   floatBtn.style.display = cart.length > 0 ? '' : 'none';
    if (floatCount) floatCount.textContent  = cart.length;
}

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Checkout ─────────────────────────────────────────────────────────────────
function checkout() {
    if (cart.length === 0) return;

    var total        = cart.reduce(function(s, i) { return s + i.price; }, 0);
    var itemCount    = cart.length;
    var cartCopy     = cart.slice();
    var pointsEarned = itemCount * 45;
    var coinsEarned  = Math.floor(total / 10);

    DigifinwizDB.getBalance('checking').then(function(balance) {
        if (total > balance) {
            showNotification('Insufficient funds. Available: ƒ' + balance.toFixed(2), 'error');
            return;
        }

        // Show confirmation
        showCheckoutModal({
            items: cartCopy,
            total: total,
            pointsEarned: pointsEarned,
            balance: balance,
            newBalance: balance - total
        }, function() {
            Promise.all([
                DigifinwizDB.getUserData(),
                DigifinwizDB.adjustBalance('checking', -total)
            ]).then(function(results) {
                var userData = results[0];
                if (!userData) return;
                userData.points            += pointsEarned;
                userData.pointsToNextLevel -= pointsEarned;
                userData.completedTasks    += 1;
                userData.coins              = (userData.coins || 0) + coinsEarned;
                var savePurchase = function() {
                    return Promise.all([
                        DigifinwizDB.setUserData(userData),
                        DigifinwizDB.addPurchase({
                            date: new Date().toLocaleDateString(),
                            items: cartCopy.map(function(i){ return { name:i.name, price:i.price }; }),
                            total: total,
                            pointsEarned: pointsEarned
                        })
                    ]);
                };
                if (userData.pointsToNextLevel <= 0) {
                    if (userData.level === 1) {
                        return DigifinwizDB.getLevel1Requirements().then(function(req) {
                            if (req.allMet) {
                                userData.level++;
                                userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                                showNotification('Level up! You\'re now level ' + userData.level + '!', 'success');
                            } else {
                                userData.pointsToNextLevel = 0;
                            }
                            return savePurchase();
                        });
                    }
                    userData.level++;
                    userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                    showNotification('Level up! You\'re now level ' + userData.level + '!', 'success');
                }
                return savePurchase();
            }).then(function() {
                return DigifinwizDB.clearCart();
            }).then(function() {
                cart = [];
                renderCart();
                updateBalanceLabel();
                showNotification('Purchase complete! ' + itemCount + ' item(s) for ƒ' + total.toFixed(2) + ' — +' + pointsEarned + ' pts!', 'success');
                // ── Challenge completion check (full context via getStats) ──
                return Promise.all([
                    DigifinwizDB.getStats(),
                    DigifinwizDB.getAllBalances(),
                    DigifinwizDB.getTransactions(1000)
                ]).then(function(results) {
                    var stats = results[0];
                    var bals  = results[1];
                    var allTx = results[2];
                    var chkBal = (bals.find(function(b){ return b.account === 'checking'; }) || {}).amount || 0;
                    var savBal = (bals.find(function(b){ return b.account === 'savings';  }) || {}).amount || 0;
                    var recipientSet = {};
                    var savingsTxCount = 0;
                    allTx.forEach(function(t) {
                        recipientSet[(t.recipient || '') + '|' + (t.account || '')] = true;
                        if (t.fromAccount === 'savings') savingsTxCount++;
                    });
                    return DigifinwizDB.checkAndCompleteChallenges({
                        txCount:          stats.txCount,
                        payCount:         stats.payCount,
                        purchCount:       stats.purchCount,
                        lastTxAmount:     0,
                        lastItemCount:    itemCount,
                        lastPayAmount:    0,
                        totalTransferred: stats.totalTransferred,
                        totalSpentEcom:   stats.totalSpentEcommerce,
                        userLevel:        stats.user ? stats.user.level : 0,
                        totalSpentBills:  stats.totalSpentBills,
                        totalXpEarned:    stats.user ? stats.user.points : 0,
                        florinBalance:    stats.user ? stats.user.coins  : 0,
                        checkingBalance:      chkBal,
                        savingsBalance:       savBal,
                        uniqueRecipients:     Object.keys(recipientSet).length,
                        savingsTransferCount: savingsTxCount
                    });
                }).then(function(result) {
                    var completed = result.completed || [];
                    if (result.leveledUp) {
                        setTimeout(function() {
                            showNotification('🎉 Level Up! You\'re now level ' + result.newLevel + '!', 'success');
                        }, 400);
                    }
                    completed.forEach(function(c) {
                        var catIcon = { banking:'🏦', ecommerce:'🛒', utilities:'⚡' }[c.category] || '🎯';
                        setTimeout(function() {
                            showNotification(catIcon + ' Challenge complete: "' + c.title + '" +' + (c.points || 0) + ' bonus XP!', 'success');
                        }, 800);
                    });
                    // Always refresh challenge tracker to show updated progress bars
                    if (typeof refreshEcoPage === 'function') {
                        setTimeout(refreshEcoPage, 1000);
                    }
                });
            }).catch(function(err) {
                console.error('Checkout error:', err);
                showNotification('Checkout failed. Please try again.', 'error');
            });
        });
    }).catch(function(err) {
        console.error('Balance check:', err);
        showNotification('Could not check balance.', 'error');
    });
}

function showCheckoutModal(details, onConfirm) {
    var existing = document.getElementById('checkoutModal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'checkoutModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';

    var itemRows = details.items.map(function(i) {
        return '<div style="display:flex;justify-content:space-between;margin-bottom:0.25rem"><span>' + escHtml(i.name) + '</span><span>ƒ' + Number(i.price).toFixed(2) + '</span></div>';
    }).join('');

    modal.innerHTML =
        '<div style="background:#fff;border-radius:16px;padding:2rem;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2);max-height:80vh;overflow-y:auto">' +
        '<h2 style="font-size:1.25rem;font-weight:700;margin-bottom:1rem;color:#1e293b">Confirm Purchase</h2>' +
        '<div style="background:#f1f5f9;border-radius:10px;padding:1rem;margin-bottom:1rem;font-size:0.875rem">' + itemRows +
        '<div style="display:flex;justify-content:space-between;border-top:1px solid #e2e8f0;padding-top:0.5rem;margin-top:0.5rem"><strong>Total</strong><strong style="color:#6366f1">ƒ' + details.total.toFixed(2) + '</strong></div>' +
        '<div style="display:flex;justify-content:space-between;margin-top:0.25rem"><span style="color:#64748b">New balance</span><span style="color:' + (details.newBalance<0?'#ef4444':'#10b981') + '">ƒ' + details.newBalance.toFixed(2) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;margin-top:0.25rem"><span style="color:#64748b">Points earned</span><span style="color:#10b981">+' + details.pointsEarned + '</span></div>' +
        '</div>' +
        '<div style="display:flex;gap:0.75rem">' +
        '<button id="checkoutCancel" class="btn" style="flex:1">Cancel</button>' +
        '<button id="checkoutConfirm" class="btn btn-primary" style="flex:1">Confirm Purchase</button>' +
        '</div></div>';

    document.body.appendChild(modal);
    document.getElementById('checkoutCancel').addEventListener('click', function(){ modal.remove(); });
    document.getElementById('checkoutConfirm').addEventListener('click', function(){ modal.remove(); onConfirm(); });
    modal.addEventListener('click', function(e){ if(e.target===modal) modal.remove(); });
}

function updateBalanceLabel() {
    DigifinwizDB.getBalance('checking').then(function(bal) {
        var el = document.querySelector('.balance-amount');
        if (el) el.textContent = 'ƒ' + bal.toLocaleString('en-US', {minimumFractionDigits:2});
    }).catch(function(){});
}

function filterProducts(category) {
    var products = document.querySelectorAll('.product-card');
    var buttons  = document.querySelectorAll('.filter-btn');
    buttons.forEach(function(btn){ btn.classList.remove('active'); });
    event.target.classList.add('active');
    products.forEach(function(product) {
        product.style.display = (category === 'all' || product.dataset.category === category) ? 'block' : 'none';
    });
}

document.addEventListener('DOMContentLoaded', function() {
    DigifinwizDB.init().then(function() {
        loadCart();
        updateBalanceLabel();
        if (typeof refreshEcoPage === 'function') refreshEcoPage();
    });
});
