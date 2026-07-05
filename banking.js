// banking.js - v2: confirmation modal, balance deduction, overdraft check

function selectRecipient(name, account) {
    document.getElementById('recipientName').value = name;
    document.getElementById('recipientAccount').value = account;
    showNotification(name + ' selected as recipient', 'info');
}

// ── Confirmation modal ──────────────────────────────────────────────────────
function showConfirmModal(details, onConfirm) {
    var existing = document.getElementById('transferModal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'transferModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;animation:fadeIn 0.2s';

    modal.innerHTML =
        '<div style="background:#fff;border-radius:16px;padding:2rem;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2)">' +
        '<h2 style="font-size:1.25rem;font-weight:700;margin-bottom:1rem;color:#1e293b">Confirm Transfer</h2>' +
        '<div style="background:#f1f5f9;border-radius:10px;padding:1rem;margin-bottom:1.25rem;font-size:0.9rem">' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.5rem"><span style="color:#64748b">To</span><strong>' + escHtml(details.recipient) + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.5rem"><span style="color:#64748b">Account</span><span style="font-family:monospace">' + escHtml(details.account) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.5rem"><span style="color:#64748b">From</span><span>' + escHtml(details.fromLabel) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;border-top:1px solid #e2e8f0;padding-top:0.5rem;margin-top:0.5rem"><span style="color:#64748b">Amount</span><strong style="color:#6366f1;font-size:1.1rem">ƒ' + Number(details.amount).toFixed(2) + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between;margin-top:0.25rem"><span style="color:#64748b">New balance</span><span style="color:' + (details.newBalance < 0 ? '#ef4444' : '#10b981') + '">ƒ' + Number(details.newBalance).toFixed(2) + '</span></div>' +
        '</div>' +
        '<div style="display:flex;gap:0.75rem">' +
            '<button id="modalCancel" class="btn" style="flex:1">Cancel</button>' +
            '<button id="modalConfirm" class="btn btn-primary" style="flex:1">Confirm Transfer</button>' +
        '</div></div>';

    document.body.appendChild(modal);

    document.getElementById('modalCancel').addEventListener('click', function() { modal.remove(); });
    document.getElementById('modalConfirm').addEventListener('click', function() {
        modal.remove();
        onConfirm();
    });
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
}

function escHtml(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Balance display helpers ────────────────────────────────────────────────
function updateBalanceDisplay() {
    DigifinwizDB.getAllBalances().then(function(bals) {
        var checking = bals.find(function(b){ return b.account === 'checking'; });
        var savings  = bals.find(function(b){ return b.account === 'savings';  });
        var sel = document.getElementById('fromAccount');
        if (sel && checking && savings) {
            sel.options[0].text = 'Checking Account — ƒ' + checking.amount.toLocaleString('en-US', {minimumFractionDigits:2});
            sel.options[1].text = 'Savings Account — ƒ' + savings.amount.toLocaleString('en-US', {minimumFractionDigits:2});
        }
        // Update account selector cards if present
        var chkBal = document.getElementById('acctBal-checking');
        var savBal = document.getElementById('acctBal-savings');
        if (chkBal && checking) chkBal.textContent = 'ƒ' + checking.amount.toLocaleString('en-US', {minimumFractionDigits:2});
        if (savBal && savings)  savBal.textContent = 'ƒ' + savings.amount.toLocaleString('en-US', {minimumFractionDigits:2});
    }).catch(function(){});
}

// ── Form submit ────────────────────────────────────────────────────────────
document.getElementById('transferForm').addEventListener('submit', function(e) {
    e.preventDefault();

    var fromAccount    = document.getElementById('fromAccount').value;
    var fromLabel      = document.getElementById('fromAccount').options[document.getElementById('fromAccount').selectedIndex].text;
    var recipientName  = document.getElementById('recipientName').value.trim();
    var recipientAcct  = document.getElementById('recipientAccount').value.trim();
    var amount         = parseFloat(document.getElementById('amount').value);
    var description    = document.getElementById('description').value.trim();

    if (!recipientName) { showNotification('Please enter a recipient name.', 'error'); return; }
    if (!recipientAcct) { showNotification('Please enter a recipient account number.', 'error'); return; }
    if (!amount || amount <= 0) { showNotification('Please enter a valid amount.', 'error'); return; }

    // Check balance first
    DigifinwizDB.getBalance(fromAccount).then(function(balance) {
        if (amount > balance) {
            showNotification('Insufficient funds. Available: ƒ' + balance.toFixed(2), 'error');
            return;
        }

        var newBalance = balance - amount;
        showConfirmModal({
            recipient: recipientName,
            account:   recipientAcct,
            fromLabel: fromLabel,
            amount:    amount,
            newBalance: newBalance
        }, function() {
            // Confirmed — process transfer
            var pointsEarned = 45;
            Promise.all([
                DigifinwizDB.getUserData(),
                DigifinwizDB.adjustBalance(fromAccount, -amount)
            ]).then(function(results) {
                var userData = results[0];
                if (!userData) return Promise.reject('No user data');

                userData.points            += pointsEarned;
                userData.pointsToNextLevel -= pointsEarned;
                userData.completedTasks    += 1;

                var saveTx = function() {
                    return Promise.all([
                        DigifinwizDB.setUserData(userData),
                        DigifinwizDB.addTransaction({
                            type: 'transfer',
                            recipient: recipientName,
                            account: recipientAcct,
                            fromAccount: fromAccount,
                            amount: amount,
                            description: description,
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
                            return saveTx();
                        });
                    }
                    userData.level++;
                    userData.pointsToNextLevel = 1000 + userData.pointsToNextLevel;
                    showNotification('Level up! You\'re now level ' + userData.level + '!', 'success');
                }
                return saveTx();
            }).then(function() {
                showNotification('Transfer of ƒ' + amount.toFixed(2) + ' to ' + recipientName + ' sent! +' + pointsEarned + ' pts', 'success');
                showTransferReceipt({ recipient: recipientName, account: recipientAcct, fromLabel: fromLabel, amount: amount, pointsEarned: pointsEarned });
                updateTransactionsList(typeof currentTxFilter !== 'undefined' ? currentTxFilter : 'all');
                updateBalanceDisplay();
                document.getElementById('transferForm').reset();
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
                        lastTxAmount:     amount,
                        lastItemCount:    0,
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
                        lastRecipient:        recipientName,
                        lastRecipientAccount: recipientAcct
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
                    if (typeof refreshBankingPage === 'function') {
                        setTimeout(refreshBankingPage, 1000);
                    }
                });
            }).catch(function(err) {
                console.error('Transfer error:', err);
                showNotification('Transfer failed. Please try again.', 'error');
            });
        });
    }).catch(function(err) {
        console.error('Balance check error:', err);
        showNotification('Could not check balance. Try again.', 'error');
    });
});

// ── Avatar palette ────────────────────────────────────────────────────────
var TX_AVATAR_PALETTE = [
    ['#667eea','#764ba2'], ['#f093fb','#f5576c'], ['#4facfe','#00f2fe'],
    ['#43e97b','#38f9d7'], ['#fa709a','#fee140'], ['#a18cd1','#fbc2eb'],
    ['#fccb90','#d57eeb'], ['#30cfd0','#330867']
];

function updateTransactionsList(filter) {
    DigifinwizDB.getTransactions(200).then(function(transactions) {
        var list = document.getElementById('transactionsList');
        if (!list) return;

        // Apply account filter
        var filtered = (filter && filter !== 'all')
            ? transactions.filter(function(t){ return t.fromAccount === filter; })
            : transactions;
        var display = filtered.slice(0, 20);

        if (display.length === 0) {
            list.innerHTML = '<p style="color:#64748b;padding:1rem;text-align:center;font-size:0.875rem">' +
                (filter && filter !== 'all'
                    ? 'No transfers from ' + filter + ' account yet.'
                    : 'No transfers yet. Make your first transfer to earn XP!') + '</p>';
            return;
        }

        list.innerHTML = display.map(function(t) {
            // Recipient initials + deterministic gradient
            var nameParts  = (t.recipient || '?').trim().split(/\s+/);
            var initials   = nameParts.slice(0,2).map(function(w){ return w[0]||''; }).join('').toUpperCase() || '?';
            var palIdx     = (t.recipient||'?').charCodeAt(0) % TX_AVATAR_PALETTE.length;
            var gradient   = 'linear-gradient(135deg,' + TX_AVATAR_PALETTE[palIdx][0] + ',' + TX_AVATAR_PALETTE[palIdx][1] + ')';

            // Account chip
            var isChecking = t.fromAccount === 'checking';
            var isSavings  = t.fromAccount === 'savings';
            var acctChip   = '';
            if (isChecking) {
                acctChip = '<span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:0.62rem;font-weight:700;background:#ede9fe;color:#7c3aed;margin-left:0.3rem;vertical-align:middle">Checking</span>';
            } else if (isSavings) {
                acctChip = '<span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:0.62rem;font-weight:700;background:#f0fdf4;color:#059669;margin-left:0.3rem;vertical-align:middle">Savings</span>';
            }

            return '<div class="transaction-item">' +
                '<div style="width:40px;height:40px;border-radius:50%;background:' + gradient + ';display:flex;align-items:center;justify-content:center;font-size:0.82rem;font-weight:700;color:white;flex-shrink:0;letter-spacing:0.02em">' + initials + '</div>' +
                '<div class="transaction-details" style="flex:1;min-width:0">' +
                    '<div style="font-weight:600;font-size:0.875rem">Transfer to ' + escHtml(t.recipient) + acctChip + '</div>' +
                    (t.description ? '<div style="font-size:0.75rem;color:#64748b;margin-top:0.1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(t.description) + '</div>' : '') +
                    '<div style="font-size:0.72rem;color:#94a3b8;margin-top:0.1rem">' + escHtml(t.date) + '</div>' +
                '</div>' +
                '<div style="text-align:right;flex-shrink:0">' +
                    '<div class="transaction-amount sent">-ƒ' + Number(t.amount).toFixed(2) + '</div>' +
                    '<div style="font-size:0.7rem;color:#10b981;margin-top:0.1rem">+' + (t.pointsEarned||0) + ' XP</div>' +
                '</div>' +
                '</div>';
        }).join('');
    }).catch(function(err) { console.error('updateTransactionsList:', err); });
}

// ── Transfer Receipt bottom-sheet ─────────────────────────────────────────
function showTransferReceipt(details) {
    var existing = document.getElementById('transferReceipt');
    if (existing) existing.remove();
    var existingBd = document.getElementById('receiptBackdrop');
    if (existingBd) existingBd.remove();
    var refNum = 'TXN-' + Date.now().toString(36).toUpperCase().slice(-8);
    var sheet = document.createElement('div');
    sheet.id = 'transferReceipt';
    sheet.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2000;animation:slideUpSheet 0.35s cubic-bezier(0.34,1.56,0.64,1)';
    sheet.innerHTML =
        '<div style="background:#fff;border-radius:24px 24px 0 0;padding:2rem;max-width:520px;margin:0 auto;box-shadow:0 -8px 40px rgba(0,0,0,0.18)">' +
        '<div style="text-align:center;margin-bottom:1.5rem">' +
            '<div style="width:64px;height:64px;background:linear-gradient(135deg,#10b981,#059669);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;margin:0 auto 0.75rem">✓</div>' +
            '<div style="font-size:1.3rem;font-weight:800;color:#1e293b">Transfer Sent!</div>' +
            '<div style="font-size:0.82rem;color:#94a3b8;margin-top:0.2rem">Ref: ' + refNum + '</div>' +
        '</div>' +
        '<div style="background:#f8fafc;border-radius:14px;padding:1rem;margin-bottom:1.25rem;font-size:0.875rem">' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.6rem"><span style="color:#64748b">To</span><strong>' + escHtml(details.recipient) + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.6rem"><span style="color:#64748b">Account</span><span style="font-family:monospace">' + escHtml(details.account) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.6rem"><span style="color:#64748b">From</span><span>' + escHtml(details.fromLabel) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.6rem;padding-top:0.6rem;border-top:1px solid #e2e8f0"><span style="color:#64748b">Amount</span><strong style="color:#6366f1;font-size:1.1rem">ƒ' + Number(details.amount).toFixed(2) + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between"><span style="color:#64748b">XP Earned</span><span style="color:#10b981;font-weight:600">+' + (details.pointsEarned || 45) + ' XP</span></div>' +
        '</div>' +
        '<div style="display:flex;gap:0.75rem">' +
            '<button id="receiptCopyBtn" class="btn" style="flex:1;font-size:0.85rem">📋 Copy Ref</button>' +
            '<button id="receiptDoneBtn" class="btn btn-primary" style="flex:1;font-size:0.85rem">Done</button>' +
        '</div></div>';
    var backdrop = document.createElement('div');
    backdrop.id = 'receiptBackdrop';
    backdrop.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:1999;animation:fadeIn 0.2s';
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    var closeReceipt = function() {
        var s = document.getElementById('transferReceipt');
        var b = document.getElementById('receiptBackdrop');
        if (s) s.remove();
        if (b) b.remove();
    };
    document.getElementById('receiptDoneBtn').addEventListener('click', closeReceipt);
    backdrop.addEventListener('click', closeReceipt);
    document.getElementById('receiptCopyBtn').addEventListener('click', function() {
        if (navigator.clipboard) { navigator.clipboard.writeText(refNum); }
        this.textContent = '✓ Copied!';
        var btn = this;
        setTimeout(function() { if (btn) btn.textContent = '📋 Copy Ref'; }, 1500);
    });
}

document.addEventListener('DOMContentLoaded', function() {
    updateBalanceDisplay();
});
