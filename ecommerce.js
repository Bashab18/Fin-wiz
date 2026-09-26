// ecommerce.js — InStyl cart + checkout (used by ecommerce.html and shop-cart.html).
// The server owns the cart: adding a product is ONE POST that the server
// merges into the existing row for that product (quantity capped at 99),
// and checkout re-prices everything from the catalog.

var cart = []; // last cart snapshot from the server

var MAX_CART_QTY = 99;
var XP_PER_ITEM  = 45; // same rule as POST /api/me/checkout (itemCount * 45)

// ── Cart persistence ─────────────────────────────────────────────────────────
function loadCart() {
    return DigifinwizDB.getCart().then(function(items) {
        cart = items || [];
        renderCart();
        return cart;
    }).catch(function(err) {
        console.error('loadCart:', err);
        var cartItems = document.getElementById('cartItems');
        if (cartItems) cartItems.innerHTML = '<p style="color:#ef4444;padding:1rem">Could not load your cart. Please refresh the page.</p>';
    });
}

function findCartRow(productName, productId) {
    return cart.find(function(i) {
        if (productId != null && i.productId != null) return i.productId === productId;
        return i.name === productName;
    });
}

function rowQty(i) { return Number(i.quantity) || 1; }

// Serialize cart writes per product so a double-click on "−" can't read the
// same pre-update quantity twice.
var cartOpQueue = {};
function withCartOpLock(key, fn) {
    var prev = cartOpQueue[key] || Promise.resolve();
    var next = prev.then(fn, fn);
    cartOpQueue[key] = next;
    return next;
}

// Reads + validates the quantity stepper next to an Add to Cart button.
// Returns an integer 1..99, or null (after telling the user) when invalid.
function readQtyFor(btnEl) {
    var qtyInput = btnEl && btnEl.parentElement && btnEl.parentElement.querySelector('.amz-qty-input');
    if (!qtyInput) return { qty: 1, input: null };
    var raw = String(qtyInput.value).trim();
    var n = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    if (!(n >= 1 && n <= MAX_CART_QTY)) {
        showNotification('Quantity must be a whole number from 1 to ' + MAX_CART_QTY + '.', 'error');
        return { qty: null, input: qtyInput };
    }
    return { qty: n, input: qtyInput };
}

// productId is optional (older call sites / rows keyed by name only).
function addToCart(productName, price, btnEl, productId) {
    var q = readQtyFor(btnEl);
    if (q.qty == null) return;
    var qty = q.qty;
    var key = productId != null ? 'id:' + productId : 'name:' + productName;

    withCartOpLock(key, function() {
        var existing = findCartRow(productName, productId);
        if (existing && rowQty(existing) + qty > MAX_CART_QTY) {
            showNotification('You can have at most ' + MAX_CART_QTY + ' of "' + productName + '" in your cart' +
                (rowQty(existing) < MAX_CART_QTY ? ' (' + (MAX_CART_QTY - rowQty(existing)) + ' more allowed).' : '.'), 'error');
            return;
        }
        var label = btnEl ? btnEl.textContent : '';
        if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Adding…'; }
        var row = { name: productName, price: Number(price) || 0, quantity: qty };
        if (productId != null) row.productId = productId;
        return DigifinwizDB.addCartItem(row).then(function() {
            return loadCart();
        }).then(function() {
            if (q.input) q.input.value = 1;
            if (btnEl) {
                btnEl.textContent = '✓ Added!';
                setTimeout(function() { btnEl.textContent = label || 'Add to Cart'; btnEl.disabled = false; }, 1200);
            }
            showNotification((qty > 1 ? qty + '× ' : '') + productName + ' added to cart!', 'success');
        }).catch(function(err) {
            console.error('addToCart:', err);
            if (btnEl) { btnEl.textContent = label || 'Add to Cart'; btnEl.disabled = false; }
            showNotification((err && err.message) || 'Could not add to cart.', 'error');
        });
    });
}

function removeFromCart(dbId, productName) {
    DigifinwizDB.removeCartItem(dbId).then(loadCart).then(function() {
        showNotification(productName + ' removed from cart.', 'info');
    }).catch(function(err) {
        console.error('removeFromCart:', err);
        showNotification('Could not remove item. Please try again.', 'error');
    });
}

function clearCartAndReload() {
    if (!confirm('Remove every item from your cart?')) return;
    DigifinwizDB.clearCart().then(loadCart).catch(function() {
        showNotification('Could not clear the cart. Please try again.', 'error');
    });
}

// There's no "set quantity" endpoint, so a decrement is remove + re-add
// with one less. If the re-add fails, reload so the page shows the truth.
function decrementCartItem(rowId) {
    var existing = cart.find(function(i) { return i.id === rowId; });
    if (!existing) return;
    withCartOpLock('row:' + rowId, function() {
        var qty = rowQty(existing);
        var op = DigifinwizDB.removeCartItem(existing.id).then(function() {
            if (qty <= 1) return null;
            var row = { name: existing.name, price: existing.price, quantity: qty - 1 };
            if (existing.productId != null) row.productId = existing.productId;
            return DigifinwizDB.addCartItem(row);
        });
        return op.then(loadCart).then(function() {
            if (qty <= 1) showNotification(existing.name + ' removed from cart.', 'info');
        }).catch(function(err) {
            console.error('decrementCartItem:', err);
            showNotification('Could not update quantity. Please try again.', 'error');
            return loadCart();
        });
    });
}

function incrementCartItem(rowId) {
    var existing = cart.find(function(i) { return i.id === rowId; });
    if (!existing) return;
    if (rowQty(existing) >= MAX_CART_QTY) {
        showNotification('Maximum quantity is ' + MAX_CART_QTY + '.', 'error');
        return;
    }
    withCartOpLock('row:' + rowId, function() {
        var row = { name: existing.name, price: existing.price, quantity: 1 };
        if (existing.productId != null) row.productId = existing.productId;
        return DigifinwizDB.addCartItem(row).then(loadCart).catch(function(err) {
            showNotification((err && err.message) || 'Could not update quantity.', 'error');
        });
    });
}

function removeAllOfItem(rowId) {
    var existing = cart.find(function(i) { return i.id === rowId; });
    if (!existing) return;
    removeFromCart(existing.id, existing.name);
}

// ── Cart UI ───────────────────────────────────────────────────────────────────
function cartUnitCount() {
    return cart.reduce(function(s, i) { return s + rowQty(i); }, 0);
}

function cartSubtotal() {
    return cart.reduce(function(s, i) { return s + (Number(i.price) || 0) * rowQty(i); }, 0);
}

function setText(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; }

function renderCart() {
    var cartItems   = document.getElementById('cartItems');
    var checkoutBtn = document.getElementById('checkoutBtn');
    var unitCount   = cartUnitCount();

    setText('cartCount', unitCount);
    if (typeof ShopBridge !== 'undefined') ShopBridge.renderCartBadge(cart);

    var clearBtn = document.getElementById('clearCartBtn');
    if (clearBtn) clearBtn.style.display = cart.length ? '' : 'none';
    var floatBtn = document.getElementById('floatCartBtn');
    if (floatBtn) floatBtn.style.display = cart.length ? '' : 'none';
    setText('floatCartCount', unitCount);
    if (checkoutBtn) checkoutBtn.disabled = cart.length === 0;

    setText('cartItemCount', unitCount);
    setText('cartItemCountSuffix', unitCount === 1 ? '' : 's');
    setText('cartSubtotal', 'ƒ' + cartSubtotal().toFixed(2));
    setText('cartXpPreview', '+' + (unitCount * XP_PER_ITEM) + ' XP');

    if (cartItems) {
        if (cart.length === 0) {
            cartItems.innerHTML = '<p style="color:#64748b;padding:1rem">Your cart is empty. <a href="ecommerce.html" style="color:var(--color-primary-500)">Browse the store</a></p>';
        } else {
            cartItems.innerHTML = cart.map(function(item) {
                var qty = rowQty(item);
                var lineTotal = ((Number(item.price) || 0) * qty).toFixed(2);
                return '<div class="cart-item">' +
                    '<div style="flex:1"><strong>' + escHtml(item.name) + '</strong>' +
                    '<div class="cart-item-price">ƒ' + Number(item.price).toFixed(2) + ' each' +
                    (qty > 1 ? ' · ƒ' + lineTotal + ' total' : '') + '</div></div>' +
                    '<div class="cart-qty-controls">' +
                    '<button class="btn-qty" aria-label="Decrease quantity" onclick="decrementCartItem(' + Number(item.id) + ')">−</button>' +
                    '<span class="cart-qty-display">' + qty + '</span>' +
                    '<button class="btn-qty" aria-label="Increase quantity" onclick="incrementCartItem(' + Number(item.id) + ')"' + (qty >= MAX_CART_QTY ? ' disabled' : '') + '>+</button>' +
                    '</div>' +
                    '<button class="btn-remove" aria-label="Remove item" onclick="removeAllOfItem(' + Number(item.id) + ')">×</button>' +
                    '</div>';
            }).join('');
        }
    }

    // Mark in-cart products on the store grid
    var inCart = {};
    cart.forEach(function(i) { inCart[i.productId != null ? 'id:' + i.productId : 'name:' + i.name] = rowQty(i); });
    document.querySelectorAll('.product-card').forEach(function(c) {
        var old = c.querySelector('.in-cart-badge');
        if (old) old.remove();
        var qty = inCart['id:' + c.dataset.id] || inCart['name:' + (c.dataset.name || '')] || 0;
        if (qty > 0) {
            var imgDiv = c.querySelector('.product-image');
            if (imgDiv) {
                imgDiv.style.position = 'relative';
                var b = document.createElement('span');
                b.className = 'in-cart-badge';
                b.style.cssText = 'position:absolute;bottom:0.4rem;left:0.4rem;background:#6366f1;color:#fff;font-size:0.6rem;font-weight:800;padding:0.2rem 0.45rem;border-radius:6px;pointer-events:none;z-index:5';
                b.textContent = qty > 1 ? '🛒 ×' + qty + ' in cart' : '🛒 In Cart';
                imgDiv.appendChild(b);
            }
        }
    });

    refreshCartEstimate();
}

function escHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Safe to splice into a single-quoted HTML attribute: JSON.stringify() a value for use as a JS
// argument literal, then neutralize characters that could break out of the attribute or get
// decoded as an HTML entity before the JS parser ever sees them. (ecommerce.html's product
// cards build their onclick handlers with this.)
function jsAttr(v) {
    return JSON.stringify(v)
        .replace(/&/g, '\\u0026').replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/'/g, '\\u0027');
}

// ── Promo codes (shop-cart.html) ─────────────────────────────────────────────
// Codes are validated by the server's checkout dry-run whenever the user has
// an address + card on file. Each code works once per account. The table is
// only a fallback so a user with no address yet still sees the estimate.
var PROMO_ESTIMATES = {
    SAVE10:  { type: 'pct',  value: 10, label: '10% off' },
    SAVE20:  { type: 'pct',  value: 20, label: '20% off' },
    WELCOME: { type: 'flat', value: 15, label: 'ƒ15 off' },
    STUDENT: { type: 'pct',  value: 5,  label: '5% student discount' }
};
var activePromo = null; // { code, label }

function togglePromoInput() {
    var wrap = document.getElementById('promoInputWrap');
    if (!wrap) return;
    var showing = wrap.style.display !== 'none';
    wrap.style.display = showing ? 'none' : '';
    var btn = document.getElementById('promoToggleBtn');
    if (btn) btn.textContent = showing ? '🏷️ Have a promo code?' : '🏷️ Hide promo code';
}

function setPromoMsg(text, ok) {
    var msgEl = document.getElementById('promoMsg');
    if (!msgEl) return;
    msgEl.style.display = text ? '' : 'none';
    msgEl.style.color = ok ? '#10b981' : '#ef4444';
    msgEl.textContent = text || '';
}

function isPromoUsedError(err) {
    return !!(err && err.message && /promo code .* already been used/i.test(err.message));
}

function clearActivePromo() {
    activePromo = null;
    var inp = document.getElementById('promoCodeInput');
    if (inp) inp.value = '';
}

function applyPromoCode() {
    var code = ((document.getElementById('promoCodeInput') || {}).value || '').trim().toUpperCase();
    if (!code) { setPromoMsg('Enter a promo code.', false); return; }
    if (cart.length === 0) { setPromoMsg('Add something to your cart first.', false); return; }

    var ctx = estimateCtx;
    if (ctx && ctx.address && ctx.payment) {
        DigifinwizDB.checkout({
            dryRun: true, addressId: ctx.address.id, paymentMethodId: ctx.payment.id,
            shippingMethod: 'standard', promoCode: code
        }).then(function(preview) {
            if (!preview.promoCode) {
                activePromo = null;
                setPromoMsg('❌ That promo code isn\'t valid.', false);
            } else {
                activePromo = { code: preview.promoCode, label: preview.promoLabel };
                setPromoMsg('✓ Code "' + preview.promoCode + '" applied — ' + preview.promoLabel + ' (one use per account).', true);
            }
            refreshCartEstimate();
        }).catch(function(err) {
            activePromo = null;
            setPromoMsg('❌ ' + ((err && err.message) || 'Could not check that code.'), false);
            refreshCartEstimate();
        });
        return;
    }
    // No address/card yet: estimate only — checkout re-validates the code.
    var promo = PROMO_ESTIMATES[code];
    if (!promo) { activePromo = null; setPromoMsg('❌ That promo code isn\'t valid.', false); refreshCartEstimate(); return; }
    activePromo = { code: code, label: promo.label };
    setPromoMsg('✓ Code "' + code + '" will be applied at checkout — ' + promo.label + ' (one use per account).', true);
    refreshCartEstimate();
}

// ── Cart estimate (shop-cart.html) ──────────────────────────────────────────
// With a default address + card on file, the estimate IS the checkout
// dry-run (real state tax, shipping, discount). Otherwise it's subtotal −
// discount + standard shipping, with tax shown as "at checkout".
var estimateCtx = null;  // { address, payment } defaults, or null
var estimateSeq = 0;

function loadEstimateContext() {
    if (!document.getElementById('cartTotal')) return Promise.resolve(null);
    return Promise.all([DigifinwizDB.getAddresses(), DigifinwizDB.getPaymentMethods()]).then(function(r) {
        var address = r[0].find(function(a) { return a.isDefault; }) || r[0][0] || null;
        var payment = r[1].find(function(p) { return p.isDefault; }) || r[1][0] || null;
        estimateCtx = { address: address, payment: payment };
        refreshCartEstimate();
        return estimateCtx;
    }).catch(function() { estimateCtx = { address: null, payment: null }; refreshCartEstimate(); });
}

function showDiscountRow(code, amount) {
    var discRow = document.getElementById('promoDiscountRow');
    if (!discRow) return;
    if (code && amount > 0) {
        discRow.style.display = 'flex';
        setText('promoDiscountLabel', 'Promo: ' + code);
        setText('promoDiscountAmt', '−ƒ' + amount.toFixed(2));
    } else {
        discRow.style.display = 'none';
    }
}

function setEstimateNote(html, isError) {
    var el = document.getElementById('cartEstimateNote');
    if (!el) return;
    el.style.color = isError ? '#dc2626' : '#64748b';
    el.innerHTML = html;
}

function refreshCartEstimate() {
    if (!document.getElementById('cartTotal')) return;
    var seq = ++estimateSeq;
    var subtotal = cartSubtotal();

    if (cart.length === 0) {
        setText('cartShipping', 'ƒ0.00');
        setText('cartTaxLabel', 'Tax');
        setText('cartTax', 'ƒ0.00');
        setText('cartTotal', 'ƒ0.00');
        showDiscountRow(null, 0);
        setEstimateNote('');
        return;
    }

    var ctx = estimateCtx;
    if (ctx && ctx.address && ctx.payment) {
        setEstimateNote('Calculating…');
        DigifinwizDB.checkout({
            dryRun: true, addressId: ctx.address.id, paymentMethodId: ctx.payment.id,
            shippingMethod: 'standard', promoCode: activePromo ? activePromo.code : undefined
        }).then(function(p) {
            if (seq !== estimateSeq) return;
            showDiscountRow(p.promoCode, p.discount);
            setText('cartSubtotal', 'ƒ' + p.subtotal.toFixed(2));
            setText('cartShipping', p.shippingCost > 0 ? 'ƒ' + p.shippingCost.toFixed(2) : 'FREE');
            setText('cartTaxLabel', 'Tax (' + escHtml(ctx.address.state) + ' ' + (p.taxRate * 100).toFixed(2) + '%)');
            setText('cartTax', 'ƒ' + p.tax.toFixed(2));
            setText('cartTotal', 'ƒ' + p.total.toFixed(2));
            setText('cartXpPreview', '+' + p.pointsEarned + ' XP · +' + p.coinsEarned + ' coins');
            setEstimateNote('Estimated with standard shipping to your default address (' + escHtml(ctx.address.city) + ', ' + escHtml(ctx.address.state) +
                '). Final tax &amp; shipping are calculated at checkout from the address and shipping speed you choose.' +
                (p.sufficientFunds ? '' : '<br><strong style="color:#dc2626">Insufficient funds — available: ƒ' + p.checking.toFixed(2) + '</strong>'));
        }).catch(function(err) {
            if (seq !== estimateSeq) return;
            if (isPromoUsedError(err)) {
                setPromoMsg('❌ ' + err.message, false);
                clearActivePromo();
                refreshCartEstimate();
                return;
            }
            renderFallbackEstimate(subtotal);
            setEstimateNote(escHtml((err && err.message) || 'Could not calculate the estimate.'), true);
        });
        return;
    }
    renderFallbackEstimate(subtotal);
    setEstimateNote('Tax depends on your shipping address. <a href="shop-address-book.html" style="color:var(--color-primary-500)">Add an address</a>' +
        (ctx && !ctx.payment ? ' and a <a href="shop-wallet.html" style="color:var(--color-primary-500)">card</a>' : '') +
        ' to see the exact total. Final tax &amp; shipping are calculated at checkout.');
}

function renderFallbackEstimate(subtotal) {
    var discount = 0;
    var promo = activePromo ? PROMO_ESTIMATES[activePromo.code] : null;
    if (promo) discount = promo.type === 'pct' ? subtotal * promo.value / 100 : Math.min(promo.value, subtotal);
    discount = Math.round(discount * 100) / 100;
    var afterDiscount = subtotal - discount;
    var shipping = afterDiscount >= 75 ? 0 : 5.99; // standard shipping rule
    showDiscountRow(activePromo ? activePromo.code : null, discount);
    setText('cartShipping', shipping > 0 ? 'ƒ' + shipping.toFixed(2) : 'FREE');
    setText('cartTaxLabel', 'Tax');
    setText('cartTax', 'At checkout');
    setText('cartTotal', 'ƒ' + (afterDiscount + shipping).toFixed(2) + ' + tax');
}

// ── Checkout ─────────────────────────────────────────────────────────────────
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
        var label = String(p.brand || '').toUpperCase() + ' •••• ' + p.last4 + ' — ' + p.cardholderName;
        return '<option value="' + p.id + '"' + (p.id === defaultPayment.id ? ' selected' : '') + '>' + escHtml(label) + '</option>';
    }).join('');
    var shippingOptions = Object.keys(SHIPPING_METHOD_LABELS).map(function(key) {
        return '<option value="' + key + '">' + escHtml(SHIPPING_METHOD_LABELS[key]) + '</option>';
    }).join('');

    var modal = document.createElement('div');
    modal.id = 'checkoutModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';
    modal.innerHTML =
        '<div role="dialog" aria-modal="true" aria-labelledby="checkoutTitle" style="background:#fff;border-radius:16px;padding:2rem;max-width:460px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2);max-height:85vh;overflow-y:auto">' +
        '<h2 id="checkoutTitle" style="font-size:1.25rem;font-weight:700;margin-bottom:1rem;color:#1e293b">Checkout</h2>' +
        '<div class="checkout-field"><label for="checkoutAddressSelect">Shipping Address</label><select id="checkoutAddressSelect" class="form-input">' + addressOptions + '</select></div>' +
        '<div class="checkout-field"><label for="checkoutPaymentSelect">Payment Method</label><select id="checkoutPaymentSelect" class="form-input">' + paymentOptions + '</select></div>' +
        '<div class="checkout-field"><label for="checkoutShippingSelect">Shipping Speed</label><select id="checkoutShippingSelect" class="form-input">' + shippingOptions + '</select></div>' +
        '<div id="checkoutSummary" style="background:#f1f5f9;border-radius:10px;padding:1rem;margin:1rem 0;font-size:0.875rem">Calculating…</div>' +
        '<div style="display:flex;gap:0.75rem">' +
        '<button id="checkoutCancel" class="btn" style="flex:1">Cancel</button>' +
        '<button id="checkoutConfirm" class="btn btn-primary" style="flex:1" disabled>Confirm Purchase</button>' +
        '</div></div>';

    document.body.appendChild(modal);
    document.getElementById('checkoutCancel').addEventListener('click', function(){ modal.remove(); });
    document.getElementById('checkoutConfirm').addEventListener('click', confirmCheckout);
    modal.addEventListener('click', function(e){ if (e.target === modal) modal.remove(); });

    ['checkoutAddressSelect', 'checkoutPaymentSelect', 'checkoutShippingSelect'].forEach(function(id) {
        document.getElementById(id).addEventListener('change', refreshCheckoutPreview);
    });
    refreshCheckoutPreview();
}

function currentCheckoutSelection() {
    // Only the code the user actually applied (not stray input text).
    return {
        addressId:       parseInt(document.getElementById('checkoutAddressSelect').value, 10),
        paymentMethodId: parseInt(document.getElementById('checkoutPaymentSelect').value, 10),
        shippingMethod:  document.getElementById('checkoutShippingSelect').value,
        promoCode:       activePromo ? activePromo.code : undefined
    };
}

// A promo code that was already used on this account: drop it (the server
// won't honor it) and tell the user, then carry on without it.
function handlePromoUsed(err) {
    showNotification(err.message + ' — it was removed from your order.', 'error');
    setPromoMsg('❌ ' + err.message, false);
    clearActivePromo();
    refreshCartEstimate();
}

function refreshCheckoutPreview() {
    var summaryEl  = document.getElementById('checkoutSummary');
    var confirmBtn = document.getElementById('checkoutConfirm');
    if (!summaryEl) return;
    var selection = currentCheckoutSelection();
    selection.dryRun = true;
    if (confirmBtn) confirmBtn.disabled = true;
    DigifinwizDB.checkout(selection).then(function(preview) {
        renderCheckoutSummary(preview);
        if (confirmBtn) confirmBtn.disabled = !preview.sufficientFunds;
    }).catch(function(err) {
        if (isPromoUsedError(err)) { handlePromoUsed(err); refreshCheckoutPreview(); return; }
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
        row('Points you\'ll earn', '+' + p.pointsEarned + ' XP · +' + p.coinsEarned + ' coins', { color: '#10b981' }) +
        (p.sufficientFunds ? '' : '<div style="color:#dc2626;font-size:0.8rem;margin-top:0.5rem">Insufficient funds — available: ƒ' + p.checking.toFixed(2) + '</div>');
}

function showOrderPlacedModal(order) {
    var existing = document.getElementById('orderPlacedModal');
    if (existing) existing.remove();
    var units = (order.items || []).reduce(function(s, i) { return s + (Number(i.quantity) || 1); }, 0);
    var modal = document.createElement('div');
    modal.id = 'orderPlacedModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000';
    modal.innerHTML =
        '<div role="dialog" aria-modal="true" aria-labelledby="orderPlacedTitle" style="background:#fff;border-radius:16px;padding:2rem;max-width:420px;width:90%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.2)">' +
        '<div style="font-size:2.5rem;margin-bottom:0.5rem">✅</div>' +
        '<h2 id="orderPlacedTitle" style="font-size:1.25rem;font-weight:700;margin:0 0 0.35rem;color:#1e293b">Order ' + escHtml(order.orderId) + ' placed!</h2>' +
        '<p style="color:#64748b;font-size:0.9rem;margin:0 0 0.75rem">' + units + ' item' + (units !== 1 ? 's' : '') + ' for <strong>ƒ' + Number(order.total).toFixed(2) + '</strong></p>' +
        '<p style="color:#10b981;font-weight:600;margin:0 0 1.25rem">+' + (order.pointsEarned || 0) + ' XP · +' + (order.coinsEarned || 0) + ' coins</p>' +
        '<div style="display:flex;gap:0.75rem">' +
        '<button type="button" id="orderPlacedClose" class="btn" style="flex:1">Keep Shopping</button>' +
        '<a href="shop-order-detail.html?id=' + encodeURIComponent(order.id) + '" class="btn btn-primary" style="flex:1;text-decoration:none;display:inline-flex;align-items:center;justify-content:center">View Order Details</a>' +
        '</div></div>';
    document.body.appendChild(modal);
    document.getElementById('orderPlacedClose').addEventListener('click', function() { modal.remove(); });
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
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

        // The applied code is now spent on this account.
        if (activePromo) { clearActivePromo(); setPromoMsg('', true); }
        loadCart();
        updateBalanceLabel();
        showOrderPlacedModal(order);
        if (result.leveledUp) {
            setTimeout(function() { showNotification('🎉 Level Up! You\'re now level ' + result.newLevel + '!', 'success'); }, 400);
        }
        if (typeof ShopBridge !== 'undefined') ShopBridge.refreshProgress();

        // Server computes challenge progress from this account's own orders.
        // Its own chain: a failure here must not look like a failed checkout.
        DigifinwizDB.checkAndCompleteChallenges().then(function(res) {
            res = res || {};
            (res.completed || []).forEach(function(c, i) {
                setTimeout(function() {
                    showNotification('🛒 Challenge complete: "' + c.title + '" +' + (c.points || 0) + ' bonus XP!', 'success');
                }, 900 + i * 700);
            });
            if (res.leveledUp) {
                setTimeout(function() { showNotification('🎉 Level Up! You\'re now level ' + res.newLevel + '!', 'success'); }, 1200);
            }
            if (typeof ShopBridge !== 'undefined') { ShopBridge.refreshProgress(); ShopBridge.refreshUnreadBadge(); }
            if (typeof refreshEcoPage === 'function') refreshEcoPage();
        }).catch(function(err) {
            console.error('Post-checkout challenge check failed:', err);
        });
    }).catch(function(err) {
        checkoutInFlight = false;
        if (isPromoUsedError(err)) {
            handlePromoUsed(err);
            refreshCheckoutPreview();
            return;
        }
        if (confirmBtn) confirmBtn.disabled = false;
        console.error('Checkout error:', err);
        showNotification(err && err.message ? err.message : 'Checkout failed. Please try again.', 'error');
    });
}

function updateBalanceLabel() {
    DigifinwizDB.getBalance('checking').then(function(bal) {
        var text = 'ƒ' + Number(bal).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        ['ecoBalance', 'cartBalance'].forEach(function(id) { setText(id, text); });
    }).catch(function(){});
}

document.addEventListener('DOMContentLoaded', function() {
    loadCart();
    updateBalanceLabel();
    loadEstimateContext();
    if (typeof refreshEcoPage === 'function') refreshEcoPage();
});
