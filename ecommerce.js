// ecommerce.js - v2: persistent cart, balance deduction, checkout confirmation

var cart = []; // in-memory copy, synced with IndexedDB

// ── Cart persistence ─────────────────────────────────────────────────────────
function loadCart() {
    DigifinwizDB.getCart().then(function(items) {
        cart = items;
        renderCart();
    }).catch(function(err) { console.error('loadCart:', err); });
}

// Cart rows are one-per-distinct-product with a quantity field — the same
// shape shopping-script.js's InStyl cart uses, so the two stores share one
// consistent cart instead of one side treating rows as one-unit-each (which
// left shopping-script.js's quantity-summing code reading undefined and lost
// units whenever an InStyl-added row with quantity > 1 got treated as a
// single row here).
function findCartRow(productName) {
    return cart.find(function(i) { return i.name === productName; });
}

// Cart rows are updated via a non-atomic remove-then-add against the
// server (no single "set quantity" endpoint), so two rapid calls for the
// same product — e.g. double-clicking the cart's "+" — can both read the
// same pre-update quantity and each create their own new row, splitting
// one product across two rows with the wrong combined total. Serialize
// per-product-name so the second call always sees the first's result.
var cartOpQueue = {};
function withCartOpLock(productName, fn) {
    var prev = cartOpQueue[productName] || Promise.resolve();
    var next = prev.then(fn, fn);
    cartOpQueue[productName] = next;
    return next;
}

function addToCart(productName, price, btnEl) {
    // Amazon-style product cards offer a quantity stepper next to the
    // button; pull the chosen amount from it when present (quick-view's
    // add-to-cart button has no stepper nearby, so it stays a plain +1).
    var qty = 1;
    var qtyInput = btnEl && btnEl.parentElement && btnEl.parentElement.querySelector('.amz-qty-input');
    if (qtyInput) qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);

    // Animate the button immediately for perceived responsiveness
    if (btnEl) {
        btnEl.textContent = '✓ Added!';
        btnEl.disabled = true;
        setTimeout(function() { btnEl.textContent = 'Add to Cart'; btnEl.disabled = false; }, 1500);
    }
    withCartOpLock(productName, function() {
        var existing = findCartRow(productName);
        var upsert = existing
            ? DigifinwizDB.removeCartItem(existing.id).then(function() {
                  return DigifinwizDB.addCartItem({ name: productName, price: price, quantity: (existing.quantity || 1) + qty });
              })
            : DigifinwizDB.addCartItem({ name: productName, price: price, quantity: qty });
        return upsert.then(function() {
            return DigifinwizDB.getCart();
        }).then(function(items) {
            cart = items;
            renderCart();
            if (qtyInput) qtyInput.value = 1;
            showNotification((qty > 1 ? qty + '× ' : '') + productName + ' added to cart!', 'success');
        }).catch(function(err) { console.error('addToCart:', err); });
    });
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
    withCartOpLock(productName, function() {
        var existing = findCartRow(productName);
        if (!existing) return;
        var qty = existing.quantity || 1;
        var op = qty > 1
            ? DigifinwizDB.removeCartItem(existing.id).then(function() {
                  return DigifinwizDB.addCartItem({ name: productName, price: price, quantity: qty - 1 });
              })
            : DigifinwizDB.removeCartItem(existing.id);
        return op.then(function() {
            return DigifinwizDB.getCart();
        }).then(function(items) {
            cart = items;
            renderCart();
            if (qty <= 1) showNotification(productName + ' removed from cart.', 'info');
        }).catch(function(err) { console.error('decrementCartItem:', err); });
    });
}

function removeAllOfItem(productName) {
    withCartOpLock(productName, function() {
        var existing = findCartRow(productName);
        if (!existing) return;
        return DigifinwizDB.removeCartItem(existing.id)
            .then(function() { return DigifinwizDB.getCart(); })
            .then(function(items) {
                cart = items;
                renderCart();
                showNotification(productName + ' removed from cart.', 'info');
            })
            .catch(function(err) { console.error('removeAllOfItem:', err); });
    });
}

// ── Cart UI ───────────────────────────────────────────────────────────────────
function renderCart() {
    var cartCount  = document.getElementById('cartCount');
    var cartItems  = document.getElementById('cartItems');
    var cartTotal  = document.getElementById('cartTotal');
    var checkoutBtn = document.getElementById('checkoutBtn');

    // Total units, not row count — a row can represent more than one unit
    // via its quantity field (shared cart model with shopping-script.js).
    var unitCount = cart.reduce(function(s, i) { return s + (i.quantity || 1); }, 0);

    if (cartCount)  cartCount.textContent = unitCount;

    var headerCartBadge = document.getElementById('headerCartBadge');
    if (headerCartBadge) {
        headerCartBadge.textContent = unitCount;
        headerCartBadge.style.display = unitCount > 0 ? '' : 'none';
    }

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
        cartItems.innerHTML = cart.map(function(item) {
            var qty = item.quantity || 1;
            var subtotal = (item.price * qty).toFixed(2);
            return '<div class="cart-item">' +
                '<div style="flex:1"><strong>' + escHtml(item.name) + '</strong>' +
                '<div class="cart-item-price">ƒ' + Number(item.price).toFixed(2) + ' each' +
                (qty > 1 ? ' · ƒ' + subtotal + ' total' : '') + '</div></div>' +
                '<div class="cart-qty-controls">' +
                "<button class=\"btn-qty\" onclick='decrementCartItem(" + jsAttr(item.name) + ',' + item.price + ")'>−</button>" +
                '<span class="cart-qty-display">' + qty + '</span>' +
                "<button class=\"btn-qty\" onclick='addToCart(" + jsAttr(item.name) + ',' + item.price + ")'>+</button>" +
                '</div>' +
                "<button class=\"btn-remove\" onclick='removeAllOfItem(" + jsAttr(item.name) + ")'>×</button>" +
                '</div>';
        }).join('');
    }

    // Estimated only — the real tax is charged-address-based and computed
    // authoritatively at checkout (server.js STATE_TAX_RATES), but the Total
    // row must at least agree with the Subtotal + Tax rows shown right above
    // it, so it includes this same 5% estimate.
    var total = cart.reduce(function(s, i) { return s + i.price * (i.quantity || 1); }, 0);
    var estTax = total * 0.05;
    if (cartTotal)   cartTotal.textContent = 'ƒ' + (total + estTax).toFixed(2);
    if (checkoutBtn) checkoutBtn.disabled = false;

    // Populate cart breakdown rows
    var subtotalEl = document.getElementById('cartSubtotal');
    var taxEl      = document.getElementById('cartTax');
    var itemCntEl  = document.getElementById('cartItemCount');
    var itemSufEl  = document.getElementById('cartItemCountSuffix');
    if (subtotalEl) subtotalEl.textContent = 'ƒ' + total.toFixed(2);
    if (taxEl)      taxEl.textContent      = 'ƒ' + estTax.toFixed(2);
    if (itemCntEl)  itemCntEl.textContent  = unitCount;
    if (itemSufEl)  itemSufEl.textContent  = unitCount === 1 ? '' : 's';

    // Apply promo discount if active
    if (typeof updateCartWithPromo === 'function') updateCartWithPromo();

    // Mark in-cart products with a badge
    var inCartNames = {};
    cart.forEach(function(i){ inCartNames[i.name] = i.quantity || 1; });
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
    if (floatCount) floatCount.textContent  = unitCount;
}

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Safe to splice into a single-quoted HTML attribute: JSON.stringify() a value for use as a JS
// argument literal, then neutralize characters that could break out of the attribute or get
// decoded as an HTML entity before the JS parser ever sees them.
function jsAttr(v) {
    return JSON.stringify(v)
        .replace(/&/g, '\\u0026').replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/'/g, '\\u0027');
}

// ── Checkout ─────────────────────────────────────────────────────────────────
// Guards against a second checkout starting while one is still in flight
// (double-click on Confirm Purchase, or a fast resubmit before the previous
// checkout's response has come back).
var checkoutInFlight = false;

var SHIPPING_METHOD_LABELS = {
    standard: 'Standard (5-7 business days) — ƒ5.99, free over ƒ75',
    express:  'Express (2 business days) — ƒ14.99'
};

function checkout() {
    if (cart.length === 0) return;
    if (checkoutInFlight) {
        showNotification('A checkout is already in progress. Please wait.', 'error');
        return;
    }
    Promise.all([
        DigifinwizDB.getAddresses(),
        DigifinwizDB.getPaymentMethods()
    ]).then(function(results) {
        var addresses      = results[0];
        var paymentMethods = results[1];
        if (addresses.length === 0) {
            showNotification('Add a shipping address before checking out.', 'error');
            // Give the toast a moment to actually paint before navigation
            // unloads the page — an immediate redirect destroys it unseen.
            setTimeout(function() { window.location.href = 'shop-address-book.html'; }, 1200);
            return;
        }
        if (paymentMethods.length === 0) {
            showNotification('Add a payment method before checking out.', 'error');
            setTimeout(function() { window.location.href = 'shop-wallet.html'; }, 1200);
            return;
        }
        openCheckoutModal(addresses, paymentMethods);
    }).catch(function(err) {
        console.error('checkout prep failed:', err);
        showNotification('Could not start checkout. Please try again.', 'error');
    });
}

function openCheckoutModal(addresses, paymentMethods) {
    var existing = document.getElementById('checkoutModal');
    if (existing) existing.remove();

    var defaultAddress = addresses.find(function(a){ return a.isDefault; }) || addresses[0];
    var defaultPayment = paymentMethods.find(function(p){ return p.isDefault; }) || paymentMethods[0];

    var addressOptions = addresses.map(function(a) {
        var label = a.fullName + ' — ' + a.street + ', ' + a.city + ', ' + a.state + ' ' + a.zip;
        return '<option value="' + a.id + '"' + (a.id === defaultAddress.id ? ' selected' : '') + '>' + escHtml(label) + '</option>';
    }).join('');
    var paymentOptions = paymentMethods.map(function(p) {
        var label = p.brand.toUpperCase() + ' •••• ' + p.last4 + ' — ' + p.cardholderName;
        return '<option value="' + p.id + '"' + (p.id === defaultPayment.id ? ' selected' : '') + '>' + escHtml(label) + '</option>';
    }).join('');
    var shippingOptions = Object.keys(SHIPPING_METHOD_LABELS).map(function(key) {
        return '<option value="' + key + '">' + escHtml(SHIPPING_METHOD_LABELS[key]) + '</option>';
    }).join('');

    var modal = document.createElement('div');
    modal.id = 'checkoutModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';
    modal.innerHTML =
        '<div style="background:#fff;border-radius:16px;padding:2rem;max-width:460px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2);max-height:85vh;overflow-y:auto">' +
        '<h2 style="font-size:1.25rem;font-weight:700;margin-bottom:1rem;color:#1e293b">Checkout</h2>' +
        '<div class="checkout-field"><label>Shipping Address</label><select id="checkoutAddressSelect" class="form-input">' + addressOptions + '</select></div>' +
        '<div class="checkout-field"><label>Payment Method</label><select id="checkoutPaymentSelect" class="form-input">' + paymentOptions + '</select></div>' +
        '<div class="checkout-field"><label>Shipping Speed</label><select id="checkoutShippingSelect" class="form-input">' + shippingOptions + '</select></div>' +
        '<div id="checkoutSummary" style="background:#f1f5f9;border-radius:10px;padding:1rem;margin:1rem 0;font-size:0.875rem">Calculating…</div>' +
        '<div style="display:flex;gap:0.75rem">' +
        '<button id="checkoutCancel" class="btn" style="flex:1">Cancel</button>' +
        '<button id="checkoutConfirm" class="btn btn-primary" style="flex:1" disabled>Confirm Purchase</button>' +
        '</div></div>';

    document.body.appendChild(modal);
    document.getElementById('checkoutCancel').addEventListener('click', function(){ modal.remove(); });
    document.getElementById('checkoutConfirm').addEventListener('click', confirmCheckout);
    modal.addEventListener('click', function(e){ if(e.target===modal) modal.remove(); });

    ['checkoutAddressSelect', 'checkoutPaymentSelect', 'checkoutShippingSelect'].forEach(function(id) {
        document.getElementById(id).addEventListener('change', refreshCheckoutPreview);
    });
    refreshCheckoutPreview();
}

function currentCheckoutSelection() {
    // Send the promo the user actually clicked "Apply" on (window.activePromo,
    // set by ecommerce.html's applyPromoCode), not whatever text happens to
    // still be sitting in the input — otherwise a typed-but-never-applied
    // code gets silently honored, and clearing the input after applying a
    // code leaves the displayed discount in place while charging full price.
    var appliedCode = (typeof activePromo !== 'undefined' && activePromo) ? activePromo.code : undefined;
    return {
        addressId:       parseInt(document.getElementById('checkoutAddressSelect').value, 10),
        paymentMethodId: parseInt(document.getElementById('checkoutPaymentSelect').value, 10),
        shippingMethod:  document.getElementById('checkoutShippingSelect').value,
        promoCode:       appliedCode
    };
}

function refreshCheckoutPreview() {
    var summaryEl = document.getElementById('checkoutSummary');
    var confirmBtn = document.getElementById('checkoutConfirm');
    if (!summaryEl) return;
    var selection = currentCheckoutSelection();
    selection.dryRun = true;
    if (confirmBtn) confirmBtn.disabled = true;
    DigifinwizDB.checkout(selection).then(function(preview) {
        renderCheckoutSummary(preview);
        if (confirmBtn) confirmBtn.disabled = !preview.sufficientFunds;
    }).catch(function(err) {
        summaryEl.innerHTML = '<span style="color:#dc2626">' + escHtml(err && err.message ? err.message : 'Could not calculate order total.') + '</span>';
    });
}

function renderCheckoutSummary(p) {
    var summaryEl = document.getElementById('checkoutSummary');
    if (!summaryEl) return;
    var row = function(label, amount, opts) {
        opts = opts || {};
        return '<div style="display:flex;justify-content:space-between;margin-bottom:0.25rem' + (opts.strong ? ';border-top:1px solid #e2e8f0;padding-top:0.4rem;margin-top:0.4rem' : '') + '">' +
            '<span' + (opts.strong ? '' : ' style="color:#64748b"') + '>' + label + '</span>' +
            '<span' + (opts.color ? ' style="color:' + opts.color + '"' : '') + '>' + amount + '</span></div>';
    };
    summaryEl.innerHTML =
        row('Subtotal (' + p.itemCount + ' item' + (p.itemCount !== 1 ? 's' : '') + ')', 'ƒ' + p.subtotal.toFixed(2)) +
        (p.discount > 0 ? row('Discount' + (p.promoCode ? ' (' + escHtml(p.promoCode) + ')' : ''), '−ƒ' + p.discount.toFixed(2), { color: '#10b981' }) : '') +
        row('Shipping', p.shippingCost > 0 ? 'ƒ' + p.shippingCost.toFixed(2) : 'FREE', { color: p.shippingCost > 0 ? '' : '#10b981' }) +
        row('Tax (' + (p.taxRate * 100).toFixed(2) + '%)', 'ƒ' + p.tax.toFixed(2)) +
        row('<strong>Total</strong>', '<strong style="color:#6366f1">ƒ' + p.total.toFixed(2) + '</strong>', { strong: true }) +
        row('Points you\'ll earn', '+' + p.pointsEarned + ' XP', { color: '#10b981' }) +
        (p.sufficientFunds ? '' : '<div style="color:#dc2626;font-size:0.8rem;margin-top:0.5rem">Insufficient funds — available: ƒ' + p.checking.toFixed(2) + '</div>');
}

function confirmCheckout() {
    if (checkoutInFlight) return;
    var selection = currentCheckoutSelection();
    checkoutInFlight = true;
    var confirmBtn = document.getElementById('checkoutConfirm');
    if (confirmBtn) confirmBtn.disabled = true;

    DigifinwizDB.checkout(selection).then(function(result) {
        checkoutInFlight = false;
        var modal = document.getElementById('checkoutModal');
        if (modal) modal.remove();
        var order = result.order;

        loadCart();
        updateBalanceLabel();
        if (result.leveledUp) {
            setTimeout(function() {
                showNotification('🎉 Level Up! You\'re now level ' + result.newLevel + '!', 'success');
            }, 400);
        }
        showNotification(
            'Order ' + order.orderId + ' placed! ' + order.items.length + ' item(s) for ƒ' + order.total.toFixed(2) +
            ' — +' + order.pointsEarned + ' pts!', 'success'
        );

        // ── Challenge completion check (full context via getStats) ──
        // Its own chain: a failure here must not surface as "Checkout
        // failed", since the purchase itself already succeeded.
        Promise.all([
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
                lastItemCount:    order.items.reduce(function(s, i){ return s + i.quantity; }, 0),
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
                savingsTransferCount: savingsTxCount,
                lastRecipient:        null,
                lastRecipientAccount: null
            });
        }).then(function(result2) {
            var completed = result2.completed || [];
            completed.forEach(function(c) {
                var catIcon = { banking:'🏦', ecommerce:'🛒', utilities:'⚡' }[c.category] || '🎯';
                setTimeout(function() {
                    showNotification(catIcon + ' Challenge complete: "' + c.title + '" +' + (c.points || 0) + ' bonus XP!', 'success');
                }, 800);
            });
            if (typeof refreshEcoPage === 'function') setTimeout(refreshEcoPage, 1000);
        }).catch(function(err) {
            console.error('Post-checkout challenge check failed:', err);
        });
    }).catch(function(err) {
        checkoutInFlight = false;
        if (confirmBtn) confirmBtn.disabled = false;
        console.error('Checkout error:', err);
        showNotification(err && err.message ? err.message : 'Checkout failed. Please try again.', 'error');
    });
}

function updateBalanceLabel() {
    DigifinwizDB.getBalance('checking').then(function(bal) {
        var el = document.getElementById('ecoBalance') || document.querySelector('.balance-amount');
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
