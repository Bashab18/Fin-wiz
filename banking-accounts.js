// banking-accounts.js — Credit Card, Loans, Savings Goals, Statements, and
// Alert Preferences tabs for the Banking page (banking.html). Loaded after
// banking.js; each loadXTab() function is called by banking.html's
// switchPageTab() the first time that tab opens, and every time it's
// revisited, so the data shown is always fresh.

function escBA(s) { return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }
function fmtBA(n) { return 'ƒ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Awards XP using the same rules every other earning flow on this site
// already implements (banking transfers, bill payments, ecommerce checkout):
// add points, level up once XP crosses 1000, with the level-1→2 transition
// gated behind the three core banking/ecommerce/utilities activities.
// Centralized here since several new account-type actions each award XP.
function awardXP(points) {
    return DigifinwizDB.getUserData().then(function(userData) {
        if (!userData) return null;
        userData.points            = (userData.points || 0) + points;
        userData.pointsToNextLevel = (userData.pointsToNextLevel != null ? userData.pointsToNextLevel : 1000) - points;
        var save = function() { return DigifinwizDB.setUserData(userData).then(function() { return userData; }); };
        if (userData.pointsToNextLevel <= 0) {
            if (userData.level === 1) {
                return DigifinwizDB.getLevel1Requirements().then(function(req) {
                    if (req.allMet) {
                        userData.level++;
                        userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                        showNotification('🎉 Level Up! You\'re now level ' + userData.level + '!', 'success');
                    } else {
                        userData.pointsToNextLevel = 0;
                    }
                    return save();
                });
            }
            userData.level++;
            userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
            showNotification('🎉 Level Up! You\'re now level ' + userData.level + '!', 'success');
        }
        return save();
    }).catch(function(err) { console.error('awardXP error:', err); return null; });
}

/* ══════════════════════════════════════════════════════════════════════════
   CREDIT CARD
   ══════════════════════════════════════════════════════════════════════════ */
var CC_TIERS = [
    { key: 'starter',  name: 'Starter',  limit: 1000, apr: 24.99, color: 'linear-gradient(135deg,#94a3b8,#64748b)' },
    { key: 'standard', name: 'Standard', limit: 2500, apr: 21.99, color: 'linear-gradient(135deg,#6366f1,#4f46e5)' },
    { key: 'premium',  name: 'Premium',  limit: 5000, apr: 18.99, color: 'linear-gradient(135deg,#f59e0b,#b45309)' }
];

function loadCreditCardTab() {
    if (typeof DigifinwizDB === 'undefined') return;
    DigifinwizDB.getCreditCard().then(function(card) {
        var noCardSection = document.getElementById('ccNoCardSection');
        var activeSection = document.getElementById('ccActiveSection');
        if (!card || !card.active) {
            if (noCardSection) noCardSection.style.display = '';
            if (activeSection) activeSection.style.display = 'none';
            renderCCTierGrid();
            return;
        }
        if (noCardSection) noCardSection.style.display = 'none';
        if (activeSection) activeSection.style.display = '';
        renderCCVisual(card);
        var hintEl = document.getElementById('ccPaymentHint');
        if (hintEl) hintEl.textContent = 'Current balance owed: ' + fmtBA(card.balance);
        loadCCActivity();
    }).catch(function(err) { console.error('loadCreditCardTab:', err); });
}

function renderCCTierGrid() {
    var grid = document.getElementById('ccTierGrid');
    if (!grid) return;
    // Tier keys are fixed constants (never user input), so no escaping is
    // needed to embed them directly in the onclick attribute.
    grid.innerHTML = CC_TIERS.map(function(t) {
        return '<div class="cc-tier-card">' +
            '<div class="cc-tier-swatch" style="background:' + t.color + '"></div>' +
            '<h3>' + t.name + '</h3>' +
            '<div class="cc-tier-limit">' + fmtBA(t.limit) + ' limit</div>' +
            '<div class="cc-tier-apr">' + t.apr + '% APR</div>' +
            '<button type="button" class="btn btn-primary btn-block" onclick="openCreditCard(\'' + t.key + '\')">Open ' + t.name + ' Card</button>' +
            '</div>';
    }).join('');
}

function openCreditCard(tier) {
    DigifinwizDB.openCreditCard(tier).then(function() {
        return awardXP(30);
    }).then(function() {
        showNotification('Credit card opened! +30 XP', 'success');
        loadCreditCardTab();
    }).catch(function(err) {
        showNotification(err && err.message ? err.message : 'Could not open card. Please try again.', 'error');
    });
}

function renderCCVisual(card) {
    var el = document.getElementById('ccVisual');
    if (!el) return;
    var tier = CC_TIERS.filter(function(t) { return t.key === card.tier; })[0] || CC_TIERS[0];
    var pct  = card.limit > 0 ? Math.min(100, Math.round((card.balance / card.limit) * 100)) : 0;
    var barColor = pct < 30 ? '#10b981' : pct < 70 ? '#f59e0b' : '#ef4444';
    el.innerHTML =
        '<div class="cc-visual-card" style="background:' + tier.color + '">' +
            '<div class="cc-visual-top"><span>DigiFinWiz</span><span>' + escBA(tier.name) + '</span></div>' +
            '<div class="cc-visual-number">•••• •••• •••• ' + String(1000 + card.id).slice(-4) + '</div>' +
            '<div class="cc-visual-bottom">' +
                '<div><div class="cc-visual-label">Balance Owed</div><div class="cc-visual-value">' + fmtBA(card.balance) + '</div></div>' +
                '<div style="text-align:right"><div class="cc-visual-label">Available Credit</div><div class="cc-visual-value">' + fmtBA(card.limit - card.balance) + '</div></div>' +
            '</div>' +
        '</div>' +
        '<div style="margin-top:0.75rem">' +
            '<div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--color-gray-500);margin-bottom:0.3rem">' +
                '<span>Credit Utilization</span><span>' + pct + '% of ' + fmtBA(card.limit) + ' · ' + card.apr + '% APR</span>' +
            '</div>' +
            '<div style="height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden">' +
                '<div style="height:100%;width:' + pct + '%;background:' + barColor + ';transition:width 0.5s"></div>' +
            '</div>' +
            (pct >= 70 ? '<div style="font-size:0.75rem;color:#dc2626;margin-top:0.4rem">⚠ High utilization can hurt your credit score — try to keep it under 30%.</div>' : '') +
        '</div>';
}

function loadCCActivity() {
    DigifinwizDB.getCreditCardActivity().then(function(activity) {
        var list = document.getElementById('ccActivityList');
        if (!list) return;
        if (activity.length === 0) {
            list.innerHTML = '<p style="color:var(--color-gray-500);padding:1rem;text-align:center">No activity yet.</p>';
            return;
        }
        list.innerHTML = activity.slice(0, 30).map(function(a) {
            var isPurchase = a.type === 'purchase';
            return '<div class="transaction-item">' +
                '<div style="width:40px;height:40px;border-radius:50%;background:' + (isPurchase ? '#fee2e2' : '#dcfce7') + ';display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0">' + (isPurchase ? '🛍️' : '💵') + '</div>' +
                '<div class="transaction-details" style="flex:1;min-width:0">' +
                    '<div style="font-weight:600;font-size:0.875rem">' + escBA(isPurchase ? a.description : 'Card payment') + '</div>' +
                    '<div style="font-size:0.72rem;color:#94a3b8;margin-top:0.1rem">' + escBA(a.date) + '</div>' +
                '</div>' +
                '<div class="transaction-amount" style="color:' + (isPurchase ? '#dc2626' : '#059669') + '">' + (isPurchase ? '+' : '−') + fmtBA(a.amount) + '</div>' +
                '</div>';
        }).join('');
    }).catch(function(err) { console.error('loadCCActivity:', err); });
}

document.addEventListener('DOMContentLoaded', function() {
    var ccPurchaseForm = document.getElementById('ccPurchaseForm');
    if (ccPurchaseForm) ccPurchaseForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var amt  = parseFloat(document.getElementById('ccPurchaseAmount').value);
        var desc = document.getElementById('ccPurchaseDesc').value.trim();
        if (!amt || amt <= 0) { showNotification('Enter a valid amount.', 'error'); return; }
        DigifinwizDB.creditCardPurchase(amt, desc).then(function() {
            return awardXP(10);
        }).then(function() {
            showNotification('Charged ' + fmtBA(amt) + ' to your card. +10 XP', 'success');
            ccPurchaseForm.reset();
            loadCreditCardTab();
        }).catch(function(err) {
            showNotification(err && err.message ? err.message : 'Purchase failed.', 'error');
        });
    });

    var ccPaymentForm = document.getElementById('ccPaymentForm');
    if (ccPaymentForm) ccPaymentForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var amt = parseFloat(document.getElementById('ccPaymentAmount').value);
        if (!amt || amt <= 0) { showNotification('Enter a valid amount.', 'error'); return; }
        DigifinwizDB.creditCardPayment(amt).then(function() {
            return awardXP(25);
        }).then(function() {
            showNotification('Payment of ' + fmtBA(amt) + ' applied. +25 XP', 'success');
            ccPaymentForm.reset();
            loadCreditCardTab();
            if (typeof loadBalanceCards === 'function') loadBalanceCards();
        }).catch(function(err) {
            showNotification(err && err.message ? err.message : 'Payment failed.', 'error');
        });
    });
});

/* ══════════════════════════════════════════════════════════════════════════
   LOANS
   ══════════════════════════════════════════════════════════════════════════ */
var LOAN_TERMS_CLIENT = {
    6:  { apr: 5.99  },
    12: { apr: 6.99  },
    24: { apr: 8.99  },
    36: { apr: 10.99 },
    60: { apr: 12.99 }
};

function computeLoanPreview(amount, term) {
    var info = LOAN_TERMS_CLIENT[term];
    if (!info || !amount || amount <= 0) return null;
    var totalInterest  = Math.round(amount * (info.apr / 100) * (term / 12) * 100) / 100;
    var totalOwed      = Math.round((amount + totalInterest) * 100) / 100;
    var monthlyPayment = Math.round((totalOwed / term) * 100) / 100;
    return { apr: info.apr, totalInterest: totalInterest, totalOwed: totalOwed, monthlyPayment: monthlyPayment };
}

function updateLoanPreview() {
    var amtEl  = document.getElementById('loanAmount');
    var termEl = document.getElementById('loanTerm');
    var out    = document.getElementById('loanPreview');
    if (!amtEl || !termEl || !out) return;
    var amt  = parseFloat(amtEl.value);
    var term = parseInt(termEl.value, 10);
    var preview = computeLoanPreview(amt, term);
    if (!preview) { out.innerHTML = ''; return; }
    out.innerHTML =
        '<div style="display:flex;justify-content:space-between;margin-bottom:0.3rem"><span>APR</span><strong>' + preview.apr + '%</strong></div>' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:0.3rem"><span>Total Interest</span><strong>' + fmtBA(preview.totalInterest) + '</strong></div>' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:0.3rem"><span>Total to Repay</span><strong>' + fmtBA(preview.totalOwed) + '</strong></div>' +
        '<div style="display:flex;justify-content:space-between;border-top:1px solid var(--color-border);padding-top:0.4rem;margin-top:0.2rem"><span>Monthly Payment</span><strong style="color:#6366f1">' + fmtBA(preview.monthlyPayment) + '</strong></div>';
}

function loadLoansTab() {
    if (typeof DigifinwizDB === 'undefined') return;
    updateLoanPreview();
    DigifinwizDB.getLoan().then(function(loan) {
        var applySection   = document.getElementById('loanApplySection');
        var activeSection  = document.getElementById('loanActiveSection');
        var paidOffSection = document.getElementById('loanPaidOffSection');
        [applySection, activeSection, paidOffSection].forEach(function(s) { if (s) s.style.display = 'none'; });

        if (!loan || (!loan.active && !loan.paidOff)) {
            if (applySection) applySection.style.display = '';
            return;
        }
        if (loan.paidOff) {
            if (paidOffSection) paidOffSection.style.display = '';
            var card = document.getElementById('loanPaidOffCard');
            if (card) card.innerHTML =
                '<div style="font-size:3rem;margin-bottom:0.5rem">🎉</div>' +
                '<h2 style="margin-bottom:0.5rem">Loan Paid Off!</h2>' +
                '<p style="color:var(--color-gray-500);margin-bottom:1.25rem">You borrowed ' + fmtBA(loan.principal) + ' and paid it back in full' + (loan.paidOffAt ? ' on ' + new Date(loan.paidOffAt).toLocaleDateString() : '') + '.</p>' +
                '<button type="button" class="btn btn-primary" onclick="resetLoanApplyForm()">Apply for a New Loan</button>';
            return;
        }
        if (activeSection) activeSection.style.display = '';
        renderLoanSummary(loan);
        loadLoanPayments();
    }).catch(function(err) { console.error('loadLoansTab:', err); });
}

function resetLoanApplyForm() {
    var applySection   = document.getElementById('loanApplySection');
    var paidOffSection = document.getElementById('loanPaidOffSection');
    if (paidOffSection) paidOffSection.style.display = 'none';
    if (applySection)   applySection.style.display = '';
}

function renderLoanSummary(loan) {
    var el = document.getElementById('loanSummaryCard');
    if (!el) return;
    var totalOwed  = loan.principal + loan.totalInterest;
    var paidSoFar  = Math.max(0, parseFloat((totalOwed - loan.balance).toFixed(2)));
    var pct = totalOwed > 0 ? Math.min(100, Math.round((paidSoFar / totalOwed) * 100)) : 0;
    el.innerHTML =
        '<h2>🏠 Your Loan</h2>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.75rem;margin:1rem 0">' +
            '<div style="text-align:center;background:#eff6ff;border-radius:10px;padding:0.875rem;border:1px solid #bfdbfe"><div style="font-size:1.25rem;font-weight:700;color:#2563eb">' + fmtBA(loan.principal) + '</div><div style="font-size:0.75rem;color:var(--color-gray-500)">Original Loan</div></div>' +
            '<div style="text-align:center;background:#fef2f2;border-radius:10px;padding:0.875rem;border:1px solid #fecaca"><div style="font-size:1.25rem;font-weight:700;color:#dc2626">' + fmtBA(loan.balance) + '</div><div style="font-size:0.75rem;color:var(--color-gray-500)">Remaining Balance</div></div>' +
            '<div style="text-align:center;background:#f0fdf4;border-radius:10px;padding:0.875rem;border:1px solid #bbf7d0"><div style="font-size:1.25rem;font-weight:700;color:#059669">' + fmtBA(loan.monthlyPayment) + '</div><div style="font-size:0.75rem;color:var(--color-gray-500)">Monthly Payment</div></div>' +
            '<div style="text-align:center;background:#fffbeb;border-radius:10px;padding:0.875rem;border:1px solid #fde68a"><div style="font-size:1.25rem;font-weight:700;color:#d97706">' + loan.apr + '%</div><div style="font-size:0.75rem;color:var(--color-gray-500)">APR</div></div>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--color-gray-500);margin-bottom:0.3rem"><span>Payoff Progress</span><span>' + pct + '%</span></div>' +
        '<div style="height:10px;background:#e2e8f0;border-radius:99px;overflow:hidden"><div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#6366f1,#10b981);transition:width 0.6s"></div></div>' +
        '<div style="font-size:0.75rem;color:var(--color-gray-400);margin-top:0.5rem">' + loan.termMonths + '-month term · opened ' + (loan.openedAt ? new Date(loan.openedAt).toLocaleDateString() : '') + '</div>';
}

function loadLoanPayments() {
    DigifinwizDB.getLoanPayments().then(function(payments) {
        var list = document.getElementById('loanPaymentsList');
        if (!list) return;
        if (payments.length === 0) {
            list.innerHTML = '<p style="color:var(--color-gray-500);padding:1rem;text-align:center">No payments yet.</p>';
            return;
        }
        list.innerHTML = payments.slice(0, 30).map(function(p) {
            return '<div class="transaction-item">' +
                '<div style="width:40px;height:40px;border-radius:50%;background:#f0fdf4;display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0">💵</div>' +
                '<div class="transaction-details" style="flex:1;min-width:0">' +
                    '<div style="font-weight:600;font-size:0.875rem">Loan payment</div>' +
                    '<div style="font-size:0.72rem;color:#94a3b8;margin-top:0.1rem">' + escBA(p.date) + '</div>' +
                '</div>' +
                '<div class="transaction-amount" style="color:#059669">−' + fmtBA(p.amount) + '</div>' +
                '</div>';
        }).join('');
    }).catch(function(err) { console.error('loadLoanPayments:', err); });
}

document.addEventListener('DOMContentLoaded', function() {
    var loanAmountEl = document.getElementById('loanAmount');
    var loanTermEl   = document.getElementById('loanTerm');
    if (loanAmountEl) loanAmountEl.addEventListener('input', updateLoanPreview);
    if (loanTermEl)   loanTermEl.addEventListener('change', updateLoanPreview);

    var loanApplyForm = document.getElementById('loanApplyForm');
    if (loanApplyForm) loanApplyForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var amt  = parseFloat(document.getElementById('loanAmount').value);
        var term = parseInt(document.getElementById('loanTerm').value, 10);
        if (!amt || amt < 500 || amt > 20000) { showNotification('Loan amount must be between ƒ500 and ƒ20,000.', 'error'); return; }
        DigifinwizDB.applyForLoan(amt, term).then(function() {
            return awardXP(30);
        }).then(function() {
            showNotification('Loan approved! ' + fmtBA(amt) + ' deposited to checking. +30 XP', 'success');
            loadLoansTab();
            if (typeof loadBalanceCards === 'function') loadBalanceCards();
        }).catch(function(err) {
            showNotification(err && err.message ? err.message : 'Loan application failed.', 'error');
        });
    });

    var loanPaymentForm = document.getElementById('loanPaymentForm');
    if (loanPaymentForm) loanPaymentForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var amt = parseFloat(document.getElementById('loanPaymentAmount').value);
        if (!amt || amt <= 0) { showNotification('Enter a valid amount.', 'error'); return; }
        DigifinwizDB.makeLoanPayment(amt).then(function(result) {
            return awardXP(25).then(function() { return result; });
        }).then(function(result) {
            var msg = 'Payment of ' + fmtBA(amt) + ' applied. +25 XP';
            if (result && result.loan && result.loan.paidOff) msg = '🎉 Loan paid off! ' + msg;
            showNotification(msg, 'success');
            loanPaymentForm.reset();
            loadLoansTab();
            if (typeof loadBalanceCards === 'function') loadBalanceCards();
        }).catch(function(err) {
            showNotification(err && err.message ? err.message : 'Payment failed.', 'error');
        });
    });
});

/* ══════════════════════════════════════════════════════════════════════════
   SAVINGS GOALS
   ══════════════════════════════════════════════════════════════════════════ */
function loadGoalsTab() {
    if (typeof DigifinwizDB === 'undefined') return;
    DigifinwizDB.getSavingsGoals().then(function(goals) {
        var list = document.getElementById('goalsList');
        if (!list) return;
        if (goals.length === 0) {
            list.innerHTML = '<p style="color:var(--color-gray-500);padding:1rem;text-align:center">No goals yet — create one above!</p>';
            return;
        }
        list.innerHTML = goals.map(function(g) {
            var pct    = g.target > 0 ? Math.min(100, Math.round((g.current / g.target) * 100)) : 0;
            var isDone = !!g.completedAt;
            return '<div class="goal-card' + (isDone ? ' goal-done' : '') + '">' +
                '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem">' +
                    '<div><strong>' + (isDone ? '🏆 ' : '🎯 ') + escBA(g.name) + '</strong>' +
                    (isDone ? '<div style="font-size:0.72rem;color:#16a34a;margin-top:0.15rem">Goal reached' + (g.completedAt ? ' ' + new Date(g.completedAt).toLocaleDateString() : '') + '!</div>' : '') +
                    '</div>' +
                    '<button type="button" class="btn-remove" onclick="deleteGoal(' + g.id + ')" title="Delete goal">×</button>' +
                '</div>' +
                '<div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:0.3rem"><span>' + fmtBA(g.current) + ' of ' + fmtBA(g.target) + '</span><span>' + pct + '%</span></div>' +
                '<div style="height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin-bottom:0.75rem">' +
                    '<div style="height:100%;width:' + pct + '%;background:' + (isDone ? '#10b981' : 'linear-gradient(90deg,#6366f1,#8b5cf6)') + ';transition:width 0.5s"></div>' +
                '</div>' +
                '<div style="display:flex;gap:0.5rem">' +
                    '<input type="number" class="form-input" id="goalAmt-' + g.id + '" placeholder="Amount" min="0.01" step="0.01" style="flex:1;min-width:0;padding:0.4rem 0.6rem;font-size:0.82rem">' +
                    '<button type="button" class="btn btn-primary" style="padding:0.4rem 0.75rem;font-size:0.8rem;flex-shrink:0;white-space:nowrap" onclick="contributeGoal(' + g.id + ')">Add</button>' +
                    '<button type="button" class="btn" style="padding:0.4rem 0.75rem;font-size:0.8rem;flex-shrink:0;white-space:nowrap" onclick="withdrawGoal(' + g.id + ')">Withdraw</button>' +
                '</div>' +
                '</div>';
        }).join('');
    }).catch(function(err) { console.error('loadGoalsTab:', err); });
}

function contributeGoal(id) {
    var input = document.getElementById('goalAmt-' + id);
    var amt   = input ? parseFloat(input.value) : NaN;
    if (!amt || amt <= 0) { showNotification('Enter a valid amount.', 'error'); return; }
    DigifinwizDB.contributeSavingsGoal(id, amt).then(function(result) {
        if (result && result.justCompleted) {
            return awardXP(20).then(function() { return awardXP(75); }).then(function() {
                showNotification('🏆 Goal reached! ' + fmtBA(amt) + ' added. +20 XP, +75 bonus XP!', 'success');
            });
        }
        return awardXP(20).then(function() {
            showNotification(fmtBA(amt) + ' added to your goal. +20 XP', 'success');
        });
    }).then(function() {
        loadGoalsTab();
        if (typeof loadBalanceCards === 'function') loadBalanceCards();
    }).catch(function(err) {
        showNotification(err && err.message ? err.message : 'Contribution failed.', 'error');
    });
}

function withdrawGoal(id) {
    var input = document.getElementById('goalAmt-' + id);
    var amt   = input ? parseFloat(input.value) : NaN;
    if (!amt || amt <= 0) { showNotification('Enter a valid amount.', 'error'); return; }
    DigifinwizDB.withdrawSavingsGoal(id, amt).then(function() {
        showNotification(fmtBA(amt) + ' moved back to checking.', 'info');
        loadGoalsTab();
        if (typeof loadBalanceCards === 'function') loadBalanceCards();
    }).catch(function(err) {
        showNotification(err && err.message ? err.message : 'Withdrawal failed.', 'error');
    });
}

function deleteGoal(id) {
    if (!confirm('Delete this goal? Any saved balance will be returned to your checking account.')) return;
    DigifinwizDB.deleteSavingsGoal(id).then(function() {
        showNotification('Goal deleted.', 'info');
        loadGoalsTab();
        if (typeof loadBalanceCards === 'function') loadBalanceCards();
    }).catch(function(err) {
        showNotification(err && err.message ? err.message : 'Could not delete goal.', 'error');
    });
}

document.addEventListener('DOMContentLoaded', function() {
    var goalCreateForm = document.getElementById('goalCreateForm');
    if (goalCreateForm) goalCreateForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var name   = document.getElementById('goalName').value.trim();
        var target = parseFloat(document.getElementById('goalTarget').value);
        if (!name) { showNotification('Enter a goal name.', 'error'); return; }
        if (!target || target < 10) { showNotification('Target must be at least ƒ10.', 'error'); return; }
        DigifinwizDB.createSavingsGoal(name, target).then(function() {
            return awardXP(20);
        }).then(function() {
            showNotification('Goal created! +20 XP', 'success');
            goalCreateForm.reset();
            loadGoalsTab();
        }).catch(function(err) {
            showNotification(err && err.message ? err.message : 'Could not create goal.', 'error');
        });
    });
});

/* ══════════════════════════════════════════════════════════════════════════
   STATEMENTS
   ══════════════════════════════════════════════════════════════════════════ */
function loadStatementsTab() {
    var monthInput = document.getElementById('stmtMonth');
    if (monthInput && !monthInput.value) {
        var now = new Date();
        var mm  = String(now.getMonth() + 1).padStart(2, '0');
        monthInput.value = now.getFullYear() + '-' + mm;
        monthInput.max   = monthInput.value;
    }
}

function generateStatement() {
    var account  = (document.getElementById('stmtAccount') || {}).value || 'checking';
    var month    = (document.getElementById('stmtMonth')   || {}).value;
    var out      = document.getElementById('stmtOutput');
    var printBtn = document.getElementById('stmtPrintBtn');
    if (!month) { showNotification('Choose a month first.', 'error'); return; }
    if (!out) return;
    out.innerHTML = '<p style="color:var(--color-gray-500);padding:1rem;text-align:center">Generating statement…</p>';
    if (printBtn) printBtn.style.display = 'none';
    DigifinwizDB.getStatement(account, month).then(function(stmt) {
        renderStatement(stmt);
        if (printBtn) printBtn.style.display = '';
    }).catch(function(err) {
        out.innerHTML = '<p style="color:#dc2626;padding:1rem;text-align:center">' + escBA(err && err.message ? err.message : 'Could not generate statement.') + '</p>';
    });
}

function renderStatement(stmt) {
    var out = document.getElementById('stmtOutput');
    if (!out) return;
    var session    = (typeof DigifinwizAuth !== 'undefined' && DigifinwizAuth.getSession) ? DigifinwizAuth.getSession() : null;
    var monthLabel = new Date(stmt.month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    var rows = stmt.events.map(function(e) {
        return '<tr>' +
            '<td>' + escBA(e.date) + '</td>' +
            '<td>' + escBA(e.label) + '</td>' +
            '<td style="text-align:right;color:' + (e.amount < 0 ? '#dc2626' : '#059669') + '">' + (e.amount < 0 ? '−' : '+') + fmtBA(Math.abs(e.amount)) + '</td>' +
            '</tr>';
    }).join('');
    out.innerHTML =
        '<div class="banking-section full-width statement-paper" id="statementPaper">' +
            '<div class="statement-header">' +
                '<div><h2 style="margin:0">DigiFinWiz</h2><p style="margin:0.2rem 0 0;color:var(--color-gray-500);font-size:0.85rem">Account Statement</p></div>' +
                '<div style="text-align:right"><strong>' + escBA(monthLabel) + '</strong><div style="font-size:0.8rem;color:var(--color-gray-500)">' + (stmt.account === 'savings' ? 'Savings Account' : 'Checking Account') + '</div></div>' +
            '</div>' +
            (session ? '<p style="font-size:0.85rem;color:var(--color-gray-500);margin:0.5rem 0 1rem">Account holder: ' + escBA(session.fullName || session.username) + '</p>' : '') +
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.75rem;margin-bottom:1.25rem">' +
                '<div style="text-align:center;background:var(--color-gray-50);border-radius:10px;padding:0.75rem"><div style="font-weight:700">' + fmtBA(stmt.openingBalance) + '</div><div style="font-size:0.72rem;color:var(--color-gray-500)">Opening Balance</div></div>' +
                '<div style="text-align:center;background:var(--color-gray-50);border-radius:10px;padding:0.75rem"><div style="font-weight:700;color:#059669">' + fmtBA(stmt.totalCredits) + '</div><div style="font-size:0.72rem;color:var(--color-gray-500)">Total Credits</div></div>' +
                '<div style="text-align:center;background:var(--color-gray-50);border-radius:10px;padding:0.75rem"><div style="font-weight:700;color:#dc2626">' + fmtBA(Math.abs(stmt.totalDebits)) + '</div><div style="font-size:0.72rem;color:var(--color-gray-500)">Total Debits</div></div>' +
                '<div style="text-align:center;background:var(--color-gray-50);border-radius:10px;padding:0.75rem"><div style="font-weight:700">' + fmtBA(stmt.closingBalance) + '</div><div style="font-size:0.72rem;color:var(--color-gray-500)">Closing Balance' + (stmt.isCurrentMonth ? ' (as of today)' : '') + '</div></div>' +
            '</div>' +
            (rows ? '<table class="statement-table"><thead><tr><th>Date</th><th>Description</th><th style="text-align:right">Amount</th></tr></thead><tbody>' + rows + '</tbody></table>'
                  : '<p style="color:var(--color-gray-500);text-align:center;padding:1rem">No activity this month.</p>') +
            '<p style="font-size:0.7rem;color:var(--color-gray-400);margin-top:1.25rem">Generated ' + escBA(new Date(stmt.generatedAt).toLocaleString()) + ' · DigiFinWiz is a financial-literacy learning tool; this statement is a simulation, not a real bank record.</p>' +
        '</div>';
}

/* ══════════════════════════════════════════════════════════════════════════
   ALERT PREFERENCES
   ══════════════════════════════════════════════════════════════════════════ */
function loadAlertsTab() {
    if (typeof DigifinwizDB === 'undefined') return;
    DigifinwizDB.getAlertPrefs().then(function(prefs) {
        var lowEnabled   = document.getElementById('alertLowBalEnabled');
        var lowThresh    = document.getElementById('alertLowBalThreshold');
        var largeEnabled = document.getElementById('alertLargeTxEnabled');
        var largeThresh  = document.getElementById('alertLargeTxThreshold');
        if (lowEnabled)   lowEnabled.checked   = !!prefs.lowBalanceEnabled;
        if (lowThresh)    lowThresh.value      = prefs.lowBalanceThreshold;
        if (largeEnabled) largeEnabled.checked = !!prefs.largeTxEnabled;
        if (largeThresh)  largeThresh.value    = prefs.largeTxThreshold;
    }).catch(function(err) { console.error('loadAlertsTab:', err); });
}

document.addEventListener('DOMContentLoaded', function() {
    var alertForm = document.getElementById('alertPrefsForm');
    if (alertForm) alertForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var prefs = {
            lowBalanceEnabled:   document.getElementById('alertLowBalEnabled').checked,
            lowBalanceThreshold: parseFloat(document.getElementById('alertLowBalThreshold').value) || 0,
            largeTxEnabled:      document.getElementById('alertLargeTxEnabled').checked,
            largeTxThreshold:    parseFloat(document.getElementById('alertLargeTxThreshold').value) || 0
        };
        DigifinwizDB.setAlertPrefs(prefs).then(function() {
            showNotification('Alert preferences saved!', 'success');
        }).catch(function(err) {
            showNotification(err && err.message ? err.message : 'Could not save preferences.', 'error');
        });
    });
});
