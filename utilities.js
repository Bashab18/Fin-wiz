// utilities.js — DigiPay bill-payment flow (confirm modal, expected-total
// pay, Pay All coordination) and payment history rendering.

function escHtml(s) {
    if (s === null || s === undefined || s === '') return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtFlorin(n) {
    return 'ƒ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Billing-month helpers ─────────────────────────────────────────────────
// The server bills every month whether or not earlier months were paid, so
// several cycles of the same bill can be open at once. Each cycle carries a
// 'YYYY-MM' cycleMonth; anything before the current month is a backlog bill.
function utilCurrentCycleMonth() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function utilCycleMonthLabel(cycleMonth) {
    if (!cycleMonth) return '';
    var parts = String(cycleMonth).split('-');
    var d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    if (isNaN(d.getTime())) return String(cycleMonth);
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function utilIsPastMonthCycle(cycle) {
    return !!(cycle && cycle.cycleMonth && cycle.cycleMonth < utilCurrentCycleMonth());
}

// Unpaid first (oldest billing month first, then by due date), paid last.
function utilSortBillsForDisplay(bills) {
    return (bills || []).slice().sort(function(a, b) {
        var ap = a.status === 'paid' ? 1 : 0, bp = b.status === 'paid' ? 1 : 0;
        if (ap !== bp) return ap - bp;
        var am = a.cycleMonth || '', bm = b.cycleMonth || '';
        if (am !== bm) return am < bm ? -1 : 1;
        return (a.dueDate || 0) - (b.dueDate || 0);
    });
}

function utilFindLoadedCycle(cycleId) {
    var list = (typeof LOADED_BILLS !== 'undefined' ? LOADED_BILLS : []);
    for (var i = 0; i < list.length; i++) if (list[i].id === cycleId) return list[i];
    return null;
}

function utilReplaceLoadedCycle(cycle) {
    if (typeof LOADED_BILLS === 'undefined') return;
    for (var i = 0; i < LOADED_BILLS.length; i++) {
        if (LOADED_BILLS[i].id === cycle.id) { LOADED_BILLS[i] = cycle; return; }
    }
}

// ── Confirm modal ─────────────────────────────────────────────────────────
// Resolves true (confirm), false (cancel/skip/dismissed/replaced) or 'stop'
// (Pay All only). Opening a new modal while one is showing settles the old
// one as cancelled, so whoever awaited it (e.g. Pay All) never hangs.
var activePaymentModal = null;
// Last card typed this session (never persisted, CVV excluded) so Pay All
// doesn't make the user retype the number for every bill.
var lastPayCard = null;

function utilLuhnOk(num) {
    var sum = 0, dbl = false;
    for (var i = num.length - 1; i >= 0; i--) {
        var d = parseInt(num.charAt(i), 10);
        if (dbl) { d *= 2; if (d > 9) d -= 9; }
        sum += d; dbl = !dbl;
    }
    return sum % 10 === 0;
}

// Returns an error string, or '' when the card details look valid.
function utilValidateCard(c) {
    if (!/^\d{13,19}$/.test(c.number) || !utilLuhnOk(c.number)) return 'Enter a valid card number.';
    if (!c.name) return 'Enter the name on the card.';
    var m = /^(\d{2})\/(\d{2})$/.exec(c.exp);
    if (!m || +m[1] < 1 || +m[1] > 12) return 'Enter the expiry as MM/YY.';
    var now = new Date();
    var expEnd = new Date(2000 + (+m[2]), +m[1], 1); // first day of the month after expiry
    if (expEnd <= now) return 'That card has expired.';
    var amex = /^3[47]/.test(c.number);
    if (!(amex ? /^\d{4}$/ : /^\d{3}$/).test(c.cvv)) return 'Enter the ' + (amex ? '4' : '3') + '-digit security code (CVV).';
    return '';
}

function showPaymentConfirmModal(details) {
    return new Promise(function(resolve) {
        if (activePaymentModal) activePaymentModal.settle(false);
        var stale = document.getElementById('paymentModal');
        if (stale) stale.remove();

        var modal = document.createElement('div');
        modal.id = 'paymentModal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;justify-content:center;z-index:1000;animation:fadeIn 0.2s;overflow-y:auto;padding:1rem';

        var row = function(label, valueHtml, extra) {
            return '<div style="display:flex;justify-content:space-between;gap:1rem;margin-bottom:0.5rem' + (extra || '') + '"><span style="color:#64748b">' + label + '</span>' + valueHtml + '</div>';
        };
        var noticeHtml = details.notice
            ? '<div id="payModalNotice" style="background:#fff7ed;border:1px solid #fdba74;color:#9a3412;border-radius:8px;padding:0.6rem 0.75rem;font-size:0.8rem;margin-bottom:1rem;font-weight:600">' + escHtml(details.notice) + '</div>'
            : '';
        var progressHtml = details.progress
            ? '<div style="font-size:0.72rem;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.35rem">Pay All · ' + escHtml(details.progress) + '</div>'
            : '';
        var lateFeeRow = details.lateFee > 0
            ? row('Late fee', '<span style="color:#b91c1c;font-weight:600">' + fmtFlorin(details.lateFee) + '</span>')
            : '';

        modal.innerHTML =
            '<div style="background:#fff;border-radius:16px;padding:1.75rem;max-width:440px;width:100%;margin:auto;box-shadow:0 20px 60px rgba(0,0,0,0.2)">' +
            progressHtml +
            '<h2 style="font-size:1.2rem;font-weight:700;margin-bottom:1rem;color:#1e293b">Confirm Bill Payment</h2>' +
            noticeHtml +
            '<div style="background:#f1f5f9;border-radius:10px;padding:1rem;margin-bottom:1.25rem;font-size:0.875rem">' +
                row('Bill', '<strong style="text-align:right">' + escHtml(details.billType) + '</strong>') +
                (details.billMonth ? row('Billing month', '<span>' + escHtml(details.billMonth) + '</span>') : '') +
                row('Account No.', '<span style="font-family:monospace">' + escHtml(details.accountNumber || '—') + '</span>') +
                lateFeeRow +
                row('Amount', '<strong id="payModalAmount" style="color:var(--color-primary-600);font-size:1.1rem">' + fmtFlorin(details.amount) + '</strong>', ';border-top:1px solid #e2e8f0;padding-top:0.5rem;margin-top:0.5rem;margin-bottom:0') +
            '</div>' +
            '<div style="font-size:0.78rem;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem">Pay with</div>' +
            '<div id="payMethodWrap" style="display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1.25rem">' +
                '<label style="display:flex;gap:0.6rem;align-items:flex-start;border:1px solid #cbd5e1;border-radius:10px;padding:0.65rem 0.8rem;cursor:pointer' + (details.balanceOption ? '' : ';opacity:0.55;cursor:not-allowed') + '">' +
                    '<input type="radio" name="payMethod" value="balance" style="margin-top:0.2rem"' + (details.balanceOption ? ' checked' : ' disabled') + '>' +
                    '<span style="font-size:0.85rem"><strong>DigiPay balance</strong><br>' +
                    (details.balanceOption
                        ? '<span style="color:#64748b">' + escHtml(details.balanceOption.label) + ' · new balance <span style="color:' + (details.balanceOption.balance - details.amount < 0 ? '#ef4444' : '#10b981') + '">' + fmtFlorin(details.balanceOption.balance - details.amount) + '</span></span>'
                        : '<span style="color:#b91c1c">Not enough funds in checking or savings</span>') +
                    '</span></label>' +
                '<label style="display:flex;gap:0.6rem;align-items:flex-start;border:1px solid #cbd5e1;border-radius:10px;padding:0.65rem 0.8rem;cursor:pointer">' +
                    '<input type="radio" name="payMethod" value="card" style="margin-top:0.2rem"' + (details.balanceOption ? '' : ' checked') + '>' +
                    '<span style="font-size:0.85rem"><strong>Credit / debit card</strong><br><span style="color:#64748b">Visa, Mastercard, Amex or Discover</span></span></label>' +
                '<div id="payCardFields" style="display:none;border:1px solid #e2e8f0;background:#f8fafc;border-radius:10px;padding:0.8rem">' +
                    '<div style="margin-bottom:0.6rem"><label style="font-size:0.75rem;font-weight:600;color:#475569">Card number</label>' +
                        '<input id="payCardNumber" type="text" inputmode="numeric" autocomplete="cc-number" placeholder="4242 4242 4242 4242" maxlength="23" class="form-input" style="width:100%;margin-top:0.2rem"></div>' +
                    '<div style="margin-bottom:0.6rem"><label style="font-size:0.75rem;font-weight:600;color:#475569">Name on card</label>' +
                        '<input id="payCardName" type="text" autocomplete="cc-name" placeholder="Full name" maxlength="60" class="form-input" style="width:100%;margin-top:0.2rem"></div>' +
                    '<div style="display:flex;gap:0.6rem">' +
                        '<div style="flex:1"><label style="font-size:0.75rem;font-weight:600;color:#475569">Expiry (MM/YY)</label>' +
                            '<input id="payCardExp" type="text" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/YY" maxlength="5" class="form-input" style="width:100%;margin-top:0.2rem"></div>' +
                        '<div style="flex:1"><label style="font-size:0.75rem;font-weight:600;color:#475569">CVV</label>' +
                            '<input id="payCardCvv" type="password" inputmode="numeric" autocomplete="cc-csc" placeholder="123" maxlength="4" class="form-input" style="width:100%;margin-top:0.2rem"></div>' +
                    '</div>' +
                    '<div id="payCardError" style="display:none;color:#b91c1c;font-size:0.78rem;margin-top:0.55rem;font-weight:600"></div>' +
                    '<div style="font-size:0.7rem;color:#94a3b8;margin-top:0.5rem">Simulation only — use any test number that passes the check digit (e.g. 4242 4242 4242 4242). Nothing is stored except the last 4 digits.</div>' +
                '</div>' +
            '</div>' +
            '<div style="display:flex;gap:0.75rem">' +
                '<button id="payModalCancel"  class="btn" style="flex:1">' + (details.progress ? 'Skip' : 'Cancel') + '</button>' +
                '<button id="payModalConfirm" class="btn btn-primary" style="flex:1">Pay ' + fmtFlorin(details.amount) + '</button>' +
            '</div>' +
            (details.progress ? '<button id="payModalStop" class="btn" style="width:100%;margin-top:0.6rem;font-size:0.8rem;color:#b91c1c">Stop paying the remaining bills</button>' : '') +
            '</div>';

        document.body.appendChild(modal);
        var settled = false;
        var onKey = function(e) { if (e.key === 'Escape') settle(false); };
        var settle = function(value) {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey);
            modal.remove();
            if (activePaymentModal && activePaymentModal.el === modal) activePaymentModal = null;
            resolve(value);
        };
        activePaymentModal = { el: modal, settle: settle };
        document.addEventListener('keydown', onKey);
        document.getElementById('payModalCancel').addEventListener('click',  function(){ settle(false); });
        var cardFields = document.getElementById('payCardFields');
        var syncMethod = function() {
            var m = modal.querySelector('input[name="payMethod"]:checked');
            cardFields.style.display = (m && m.value === 'card') ? 'block' : 'none';
        };
        modal.querySelectorAll('input[name="payMethod"]').forEach(function(r) { r.addEventListener('change', syncMethod); });
        var numEl = document.getElementById('payCardNumber'), expEl = document.getElementById('payCardExp');
        numEl.addEventListener('input', function() {
            var d = this.value.replace(/\D/g, '').slice(0, 19);
            this.value = d.replace(/(.{4})/g, '$1 ').trim();
        });
        expEl.addEventListener('input', function() {
            var d = this.value.replace(/\D/g, '').slice(0, 4);
            this.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d;
        });
        if (lastPayCard) {
            numEl.value = lastPayCard.number; expEl.value = lastPayCard.exp;
            document.getElementById('payCardName').value = lastPayCard.name;
        }
        syncMethod();
        document.getElementById('payModalConfirm').addEventListener('click', function() {
            var m = modal.querySelector('input[name="payMethod"]:checked');
            if (!m || m.value !== 'card') { settle(true); return; }
            var card = {
                number: numEl.value.replace(/\s/g, ''),
                name:   document.getElementById('payCardName').value.trim(),
                exp:    expEl.value.trim(),
                cvv:    document.getElementById('payCardCvv').value.trim()
            };
            var problem = utilValidateCard(card);
            var errEl = document.getElementById('payCardError');
            if (problem) { errEl.textContent = problem; errEl.style.display = 'block'; return; }
            lastPayCard = { number: numEl.value, name: card.name, exp: card.exp };
            settle({ card: card });
        });
        var stopBtn = document.getElementById('payModalStop');
        if (stopBtn) stopBtn.addEventListener('click', function(){ settle('stop'); });
        modal.addEventListener('click', function(e){ if (e.target === modal) settle(false); });
        document.getElementById('payModalConfirm').focus();
    });
}

// Guards against a second payment starting while one is still in flight
// (double-click on Pay, or a fast resubmit).
var paymentInFlight = false;
// True while "Pay All Unpaid Bills" is walking the list; individual card
// Pay buttons are disabled and refused for the duration.
var payAllRunning = false;
// Cycle ids this page paid itself — lets loadBills tell a manual payment
// apart from one the server's auto-pay sweep made.
var UTIL_PAID_BY_PAGE = {};

function utilSetCardPayButtonsDisabled(disabled) {
    document.querySelectorAll('.bill-pay-btn').forEach(function(btn) {
        if (btn.dataset.paid === '1') return;
        btn.disabled = !!disabled;
        btn.style.opacity = disabled ? '0.6' : '';
    });
}

// Previews which account the server will charge (checking first, then
// savings — the same rule attemptPayBillCycle applies). Resolves null when
// neither account can cover it.
function utilPreviewPayAccount(amount) {
    return DigifinwizDB.getAllBalances().then(function(bals) {
        var chk = (bals.find(function(b){ return b.account === 'checking'; }) || {}).amount || 0;
        var sav = (bals.find(function(b){ return b.account === 'savings';  }) || {}).amount || 0;
        if (amount <= chk) return { account: 'checking', label: 'Checking Account', balance: chk };
        if (amount <= sav) return { account: 'savings',  label: 'Savings Account',  balance: sav };
        return null;
    });
}

// ── Main pay function ──────────────────────────────────────────────────────
// Resolves { paid, amount?, stopped? } so Pay All can tell what happened.
// The charge itself (balance, late fee, XP/coins, level-up) happens
// atomically in POST /api/me/bills/:id/pay; we always send the total the
// confirm modal showed so the server refuses if it changed underneath us.
function payBill(cycleId, opts) {
    opts = opts || {};
    if (payAllRunning && !opts.fromPayAll) {
        showNotification('Pay All is in progress — finish or stop it first.', 'info');
        return Promise.resolve({ paid: false });
    }
    if (paymentInFlight) {
        showNotification('A payment is already in progress. Please wait.', 'error');
        return Promise.resolve({ paid: false });
    }
    var cycle = utilFindLoadedCycle(cycleId);
    if (!cycle) { showNotification('Bill not found. Please refresh.', 'error'); return Promise.resolve({ paid: false }); }
    if (cycle.status === 'paid') {
        if (!opts.fromPayAll) showNotification(cycle.name + ' is already paid.', 'info');
        return Promise.resolve({ paid: false, alreadyPaid: true });
    }
    return utilConfirmAndPay(cycle, cycle.totalDue, opts, null);
}

function utilConfirmAndPay(cycle, expectedTotal, opts, notice) {
    var isPast = utilIsPastMonthCycle(cycle);
    var monthLabel = utilCycleMonthLabel(cycle.cycleMonth);
    return utilPreviewPayAccount(expectedTotal).then(function(chosen) {
        // `chosen` is null when neither account can cover it — a card can still pay.
        return showPaymentConfirmModal({
            billType: cycle.name + ' Bill',
            billMonth: monthLabel + (isPast ? ' (past due)' : ''),
            accountNumber: cycle.accountNumber,
            amount: expectedTotal,
            lateFee: Math.max(0, Math.round((expectedTotal - (cycle.amount || 0)) * 100) / 100),
            balanceOption: chosen ? { label: chosen.label, balance: chosen.balance } : null,
            notice: notice,
            progress: opts.progress || null
        }).then(function(choice) {
            if (choice === 'stop') return { paid: false, stopped: true };
            if (!choice) return { paid: false };

            paymentInFlight = true;
            var btn = document.getElementById('payBtn-' + cycle.id);
            if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
            var card = (choice && choice.card) || null;
            return DigifinwizDB.payBillCycle(cycle.id, expectedTotal, card).then(function(result) {
                paymentInFlight = false;
                UTIL_PAID_BY_PAGE[cycle.id] = true;
                var charged = (result && result.payment && typeof result.payment.amount === 'number') ? result.payment.amount : expectedTotal;
                utilAnnouncePayment(cycle, result, charged);
                utilRunChallengeCheck();
                return utilReloadAfterPayment().then(function() { return { paid: true, amount: charged }; });
            }, function(err) {
                paymentInFlight = false;
                if (btn) { btn.disabled = payAllRunning; btn.textContent = 'Pay Now'; }
                var data = err && err.data;
                if (err && err.status === 409 && data && typeof data.currentTotal === 'number') {
                    var newTotal = data.currentTotal;
                    var newLateFee = Math.max(0, Math.round((newTotal - (cycle.amount || 0)) * 100) / 100);
                    var updated = Object.assign({}, cycle, { totalDue: newTotal, lateFee: newLateFee, overdue: newLateFee > 0 || cycle.overdue });
                    utilReplaceLoadedCycle(updated);
                    var why = newTotal > expectedTotal
                        ? (newLateFee > 0 ? ' — a ' + fmtFlorin(newLateFee) + ' late fee was applied' : '')
                        : '';
                    var msg = 'The amount due for ' + cycle.name + ' changed from ' + fmtFlorin(expectedTotal) + ' to ' + fmtFlorin(newTotal) + why + '. Nothing was charged — please confirm the new amount.';
                    showNotification('Amount changed to ' + fmtFlorin(newTotal) + why + '. Please confirm again.', 'info');
                    if (typeof loadBills === 'function') loadBills();
                    return utilConfirmAndPay(updated, newTotal, opts, msg);
                }
                if (err && err.status === 409 && /insufficient funds/i.test(err.message || '')) {
                    showNotification(err.message + ' — nothing was charged. Add funds or pay a smaller bill first.', 'error');
                    return { paid: false, insufficient: true };
                }
                if (err && err.status === 409 && /already paid/i.test(err.message || '')) {
                    showNotification(cycle.name + ' was already paid (possibly by auto-pay).', 'info');
                    if (typeof loadBills === 'function') loadBills();
                    return { paid: false, alreadyPaid: true };
                }
                console.error('payBill error:', err);
                showNotification(err && err.message ? err.message : 'Payment failed. Please try again.', 'error');
                return { paid: false };
            });
        });
    }).catch(function(err) {
        paymentInFlight = false;
        console.error('payBill flow error:', err);
        showNotification('Could not check your balance. Please try again.', 'error');
        return { paid: false };
    });
}

function utilAnnouncePayment(cycle, result, charged) {
    var acct = result && result.payment && result.payment.paidWith === 'card'
        ? ('card ending ' + result.payment.cardLast4)
        : (result && result.account ? (result.account.charAt(0).toUpperCase() + result.account.slice(1)) : '');
    var label = cycle.name + (utilIsPastMonthCycle(cycle) ? ' (' + utilCycleMonthLabel(cycle.cycleMonth) + ')' : '');
    var bits = [];
    bits.push('+' + (result.pointsEarned || 0) + ' XP' + (result.onTimeBonus ? ' incl. on-time bonus' : ''));
    if (result.coinsEarned) bits.push('+' + result.coinsEarned + ' coins');
    var lateFee = result.payment && result.payment.lateFee;
    showNotification(label + ': ' + fmtFlorin(charged) + ' charged' + (acct ? ' from ' + acct : '') +
        (lateFee > 0 ? ' (incl. ' + fmtFlorin(lateFee) + ' late fee)' : '') + ' · ' + bits.join(' · '), 'success');
    if (result.leveledUp) {
        setTimeout(function() {
            showNotification('Level up! You\'re now level ' + result.newLevel + '!', 'success');
        }, 400);
    }
}

// After any payment: bills (and everything derived from them), history,
// stats/challenges, header level/XP/coins, messages badge.
function utilReloadAfterPayment() {
    if (typeof refreshUtilPage === 'function') refreshUtilPage();
    updatePaymentHistory();
    var p = (typeof loadBills === 'function') ? loadBills() : Promise.resolve();
    return Promise.resolve(p).catch(function() {});
}

// The server computes challenge progress from this module's own records;
// no client context needed.
function utilRunChallengeCheck() {
    return DigifinwizDB.checkAndCompleteChallenges().then(function(res) {
        res = res || {};
        var completed = res.completed || [];
        completed.forEach(function(c, i) {
            setTimeout(function() {
                showNotification('Challenge complete: "' + c.title + '" +' + (c.points || 0) + ' bonus XP!', 'success');
            }, 800 + i * 500);
        });
        if (res.leveledUp) {
            setTimeout(function() {
                showNotification('Level up! You\'re now level ' + res.newLevel + '!', 'success');
            }, 800 + completed.length * 500);
        }
        if (completed.length || res.leveledUp) {
            if (typeof loadUtilityChallenges === 'function') loadUtilityChallenges();
            if (typeof refreshHeaderProgress === 'function') refreshHeaderProgress();
        }
        return res;
    }).catch(function(err) {
        console.error('Challenge check failed:', err);
    });
}

var BILL_ICONS = { Electricity:'⚡', Water:'💧', Internet:'🌐', 'Property Tax':'🏠', Phone:'📱', Gas:'🔥' };

function utilBillIcon(type) {
    if (typeof BILL_ICONS_PAGE !== 'undefined' && BILL_ICONS_PAGE[type]) return BILL_ICONS_PAGE[type];
    return BILL_ICONS[type] || '🧾';
}

// Payment records as the server writes them (attemptPayBillCycle):
// { id, type, amount, accountNumber, fromAccount, date, timestamp,
//   pointsEarned, lateFee, usage, unit, autoPaid, cycleId, cycleMonth,
//   billAmount, onTimeBonus, coinsEarned }. Newer records store onTimeBonus
// directly; older ones predate it, so fall back to the XP heuristic (the
// on-time bonus is +15 on top of the base 45 XP).
function utilPaymentWasOnTime(p) {
    if (typeof p.onTimeBonus === 'boolean') return p.onTimeBonus;
    if (p.lateFee > 0) return false;
    return (p.pointsEarned || 0) >= 60;
}

function utilPaymentChips(p) {
    var chips = [];
    // Which month's bill this settled (newer records only) — worth calling
    // out mainly when it was a past-month bill paid later.
    if (p.cycleMonth && p.cycleMonth < utilCurrentCycleMonth()) {
        chips.push('<span class="util-chip" style="background:#f1f5f9;color:#475569">' + escHtml(utilCycleMonthLabel(p.cycleMonth)) + ' bill</span>');
    }
    if (p.autoPaid) chips.push('<span class="util-chip util-chip-auto">Auto-pay</span>');
    if (p.lateFee > 0) chips.push('<span class="util-chip util-chip-late">Late fee ' + fmtFlorin(p.lateFee) + '</span>');
    else if (utilPaymentWasOnTime(p)) chips.push('<span class="util-chip util-chip-ontime">On time</span>');
    return chips.join('');
}

// Full payment records, keyed by id, for the detail modal.
var UTIL_PAYMENT_BY_ID = {};

function updatePaymentHistory() {
    return DigifinwizDB.getPayments(200).then(function(payments) {
        var paymentHistory = document.getElementById('paymentHistory');
        if (!paymentHistory) return;

        UTIL_PAYMENT_BY_ID = {};
        payments.forEach(function(p) { UTIL_PAYMENT_BY_ID[p.id] = p; });

        if (payments.length === 0) {
            paymentHistory.innerHTML = '<p style="color:#64748b;padding:1rem;text-align:center;font-size:0.875rem">No payments yet. Pay your first bill to earn XP!</p>';
            if (typeof buildPayHistTypePills === 'function') buildPayHistTypePills(payments);
            return;
        }

        // Group by calendar month of the payment (timestamp is the reliable
        // epoch value; p.date is a server-locale display string).
        var groups = {};
        var groupOrder = [];
        payments.forEach(function(p) {
            var d = p.timestamp ? new Date(p.timestamp) : new Date(p.date);
            var monthKey = isNaN(d.getTime())
                ? 'Recent'
                : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            if (!groups[monthKey]) { groups[monthKey] = []; groupOrder.push(monthKey); }
            groups[monthKey].push(p);
        });

        if (typeof buildPayHistTypePills === 'function') buildPayHistTypePills(payments);

        paymentHistory.innerHTML = groupOrder.map(function(month) {
            var monthPays  = groups[month];
            var monthTotal = monthPays.reduce(function(s, p){ return s + (p.amount||0); }, 0);
            var monthXp    = monthPays.reduce(function(s, p){ return s + (p.pointsEarned||0); }, 0);
            var monthFees  = monthPays.reduce(function(s, p){ return s + (p.lateFee||0); }, 0);

            var header = '<div class="pay-month-header">' +
                '<span>' + month + ' · ' + monthPays.length + ' payment' + (monthPays.length !== 1 ? 's' : '') + '</span>' +
                '<span>' + fmtFlorin(monthTotal) + ' · +' + monthXp + ' XP' + (monthFees > 0 ? ' · ' + fmtFlorin(monthFees) + ' in late fees' : '') + '</span>' +
            '</div>';

            var items = monthPays.map(function(p) {
                var icon    = utilBillIcon(p.type);
                var d       = p.timestamp ? new Date(p.timestamp) : null;
                var dateStr = (d && !isNaN(d.getTime())) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : (p.date || '');
                var fromLbl = p.paidWith === 'card'
                    ? ((p.cardBrand || 'Card') + ' ' + p.cardLast4)
                    : p.fromAccount
                    ? (p.fromAccount.charAt(0).toUpperCase() + p.fromAccount.slice(1))
                    : '';
                var detailBits = [];
                if (p.usage != null && p.unit) detailBits.push(Number(p.usage).toLocaleString() + ' ' + p.unit);
                var detailLine = detailBits.length ? (' · ' + escHtml(detailBits.join(' · '))) : '';
                return '<div class="pay-hist-item" data-type="' + escHtml(p.type||'') + '" onclick="showPaymentDetailModal(UTIL_PAYMENT_BY_ID[' + Number(p.id) + '])" style="cursor:pointer;display:flex;align-items:center;gap:0.75rem;padding:0.75rem 0;border-bottom:1px solid #f1f5f9">' +
                    '<div style="width:40px;height:40px;background:#fff7ed;border:2px solid #fed7aa;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0">' + icon + '</div>' +
                    '<div style="flex:1;min-width:0">' +
                        '<strong style="font-size:0.875rem">' + escHtml(p.type) + ' Bill Paid</strong> ' + utilPaymentChips(p) +
                        '<div style="font-size:0.72rem;color:#94a3b8;margin-top:0.1rem">' + escHtml(dateStr) + (fromLbl ? ' · from ' + escHtml(fromLbl) : '') + detailLine + '</div>' +
                    '</div>' +
                    '<div style="text-align:right;flex-shrink:0">' +
                        '<div style="font-weight:700;color:#1e293b">' + fmtFlorin(p.amount) + '</div>' +
                        '<div style="font-size:0.72rem;color:#10b981">+' + (p.pointsEarned||0) + ' XP</div>' +
                    '</div></div>';
            }).join('');

            return '<div style="margin-bottom:1.25rem">' + header + items + '</div>';
        }).join('');

        if (typeof filterPayHistory === 'function') filterPayHistory();
    }).catch(function(err) { console.error('updatePaymentHistory:', err); });
}
