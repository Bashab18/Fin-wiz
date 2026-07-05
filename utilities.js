// utilities.js - v2: balance check, confirmation modal, account selector

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showPaymentConfirmModal(details, onConfirm) {
    var existing = document.getElementById('paymentModal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'paymentModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;animation:fadeIn 0.2s';

    modal.innerHTML =
        '<div style="background:#fff;border-radius:16px;padding:2rem;max-width:400px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2)">' +
        '<h2 style="font-size:1.2rem;font-weight:700;margin-bottom:1rem;color:#1e293b">Confirm Bill Payment</h2>' +
        '<div style="background:#f1f5f9;border-radius:10px;padding:1rem;margin-bottom:1.25rem;font-size:0.875rem">' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.5rem"><span style="color:#64748b">Bill Type</span><strong>' + escHtml(details.billType) + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.5rem"><span style="color:#64748b">Account No.</span><span style="font-family:monospace">' + escHtml(details.accountNumber) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.5rem"><span style="color:#64748b">Pay From</span><span>' + escHtml(details.fromLabel) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;border-top:1px solid #e2e8f0;padding-top:0.5rem;margin-top:0.5rem"><span style="color:#64748b">Amount</span><strong style="color:#6366f1;font-size:1.1rem">ƒ' + Number(details.amount).toFixed(2) + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between;margin-top:0.25rem"><span style="color:#64748b">New balance</span><span style="color:' + (details.newBalance<0?'#ef4444':'#10b981') + '">ƒ' + Number(details.newBalance).toFixed(2) + '</span></div>' +
        '</div>' +
        '<div style="display:flex;gap:0.75rem">' +
            '<button id="payModalCancel"  class="btn" style="flex:1">Cancel</button>' +
            '<button id="payModalConfirm" class="btn btn-primary" style="flex:1">Pay Bill</button>' +
        '</div></div>';

    document.body.appendChild(modal);
    document.getElementById('payModalCancel').addEventListener('click',  function(){ modal.remove(); });
    document.getElementById('payModalConfirm').addEventListener('click', function(){ modal.remove(); onConfirm(); });
    modal.addEventListener('click', function(e){ if(e.target===modal) modal.remove(); });
}

// ── Main pay function ──────────────────────────────────────────────────────
function payBill(billType, amount, accountNumber) {
    // Determine which account to pay from (checking by default)
    var fromAccount = 'checking';
    var fromLabel   = 'Checking Account';

    DigifinwizDB.getBalance(fromAccount).then(function(balance) {
        if (amount > balance) {
            // Try savings
            return DigifinwizDB.getBalance('savings').then(function(savBal) {
                if (amount > savBal) {
                    showNotification('Insufficient funds in both accounts. Need ƒ' + amount.toFixed(2), 'error');
                    return null;
                }
                return { account: 'savings', label: 'Savings Account', balance: savBal };
            });
        }
        return { account: fromAccount, label: fromLabel, balance: balance };
    }).then(function(chosen) {
        if (!chosen) return;

        showPaymentConfirmModal({
            billType: billType,
            accountNumber: accountNumber,
            amount: amount,
            fromLabel: chosen.label,
            newBalance: chosen.balance - amount
        }, function() {
            var pointsEarned = 45;

            Promise.all([
                DigifinwizDB.getUserData(),
                DigifinwizDB.adjustBalance(chosen.account, -amount)
            ]).then(function(results) {
                var userData = results[0];
                if (!userData) return Promise.reject('No user data');

                userData.points            += pointsEarned;
                userData.pointsToNextLevel -= pointsEarned;
                userData.completedTasks    += 1;

                var savePayment = function() {
                    return Promise.all([
                        DigifinwizDB.setUserData(userData),
                        DigifinwizDB.addPayment({
                            type: billType,
                            amount: amount,
                            accountNumber: accountNumber,
                            fromAccount: chosen.account,
                            date: new Date().toLocaleDateString(),
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
                            return savePayment();
                        });
                    }
                    userData.level++;
                    userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                    showNotification('Level up! You\'re now level ' + userData.level + '!', 'success');
                }
                return savePayment();
            }).then(function() {
                showNotification(billType + ' ƒ' + amount.toFixed(2) + ' paid! +' + pointsEarned + ' pts', 'success');
                updatePaymentHistory();
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
                        lastItemCount:    0,
                        lastPayAmount:    amount,
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
                    if (typeof refreshUtilPage === 'function') {
                        setTimeout(refreshUtilPage, 1000);
                    }
                });
            }).catch(function(err) {
                console.error('payBill error:', err);
                showNotification('Payment failed. Please try again.', 'error');
            });
        });
    }).catch(function(err) {
        console.error('Balance check error:', err);
        showNotification('Could not check balance.', 'error');
    });
}

var BILL_ICONS = { Electricity:'⚡', Water:'💧', Internet:'🌐', 'Property Tax':'🏠', Phone:'📱', Gas:'🔥' };

function updatePaymentHistory() {
    DigifinwizDB.getPayments(200).then(function(payments) {
        var paymentHistory = document.getElementById('paymentHistory');
        if (!paymentHistory) return;

        if (payments.length === 0) {
            paymentHistory.innerHTML = '<p style="color:#64748b;padding:1rem;text-align:center;font-size:0.875rem">No payments yet. Pay your first bill to earn XP!</p>';
            return;
        }

        // Group by calendar month
        var groups = {};
        var groupOrder = [];
        payments.forEach(function(p) {
            var d = new Date(p.date);
            var monthKey = isNaN(d.getTime())
                ? 'Recent'
                : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
            if (!groups[monthKey]) { groups[monthKey] = []; groupOrder.push(monthKey); }
            groups[monthKey].push(p);
        });

        // Rebuild filter pills
        if (typeof buildPayHistTypePills === 'function') buildPayHistTypePills(payments);

        paymentHistory.innerHTML = groupOrder.map(function(month) {
            var monthPays  = groups[month];
            var monthTotal = monthPays.reduce(function(s, p){ return s + (p.amount||0); }, 0);
            var monthXp    = monthPays.reduce(function(s, p){ return s + (p.pointsEarned||0); }, 0);

            var header = '<div class="pay-month-header">' +
                '<span>' + month + ' · ' + monthPays.length + ' payment' + (monthPays.length !== 1 ? 's' : '') + '</span>' +
                '<span>ƒ' + monthTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' · +' + monthXp + ' XP</span>' +
            '</div>';

            var items = monthPays.map(function(p) {
                var icon    = BILL_ICONS[p.type] || '🧾';
                var fromLbl = p.fromAccount
                    ? (p.fromAccount.charAt(0).toUpperCase() + p.fromAccount.slice(1)) + ' Account'
                    : '';
                return '<div class="pay-hist-item" data-type="' + escHtml(p.type||'') + '" style="display:flex;align-items:center;gap:0.75rem;padding:0.75rem 0;border-bottom:1px solid #f1f5f9">' +
                    '<div style="width:40px;height:40px;background:#f0fdf4;border:2px solid #bbf7d0;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.2rem;flex-shrink:0">' + icon + '</div>' +
                    '<div style="flex:1;min-width:0">' +
                        '<strong style="font-size:0.875rem">' + escHtml(p.type) + ' Bill Paid</strong>' +
                        '<div style="font-size:0.72rem;color:#94a3b8;margin-top:0.1rem">' + escHtml(p.date||'') + (fromLbl ? ' · from ' + fromLbl : '') + '</div>' +
                    '</div>' +
                    '<div style="text-align:right;flex-shrink:0">' +
                        '<div style="font-weight:700;color:#1e293b">ƒ' + Number(p.amount).toFixed(2) + '</div>' +
                        '<div style="font-size:0.72rem;color:#10b981">+' + (p.pointsEarned||0) + ' XP</div>' +
                    '</div></div>';
            }).join('');

            return '<div style="margin-bottom:1.25rem">' + header + items + '</div>';
        }).join('');

        // Apply any active filter
        if (typeof filterPayHistory === 'function') filterPayHistory();
    }).catch(function(err) { console.error('updatePaymentHistory:', err); });
}

document.addEventListener('DOMContentLoaded', function() {
    updatePaymentHistory();
});
