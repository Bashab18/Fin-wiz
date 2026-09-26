// banking.js - v3: server-side atomic transfers (DigifinwizDB.transfer),
// own-account moves (DigifinwizDB.moveMoney), and internal-move-aware lists.

function selectRecipient(name, account) {
    document.getElementById('recipientName').value = name;
    document.getElementById('recipientAccount').value = account;
    showNotification(name + ' selected as recipient', 'info');
}

function escHtml(s) {
    if (s === null || s === undefined || s === '') return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtMoneyB(n) {
    return 'ƒ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function acctLabelB(a) {
    return a === 'savings' ? 'Savings' : a === 'checking' ? 'Checking' : String(a || '?');
}

// A record is an own-account move (checking <-> savings) rather than money
// sent to someone else. Legacy records with no type are transfers.
function isInternalMove(t) {
    return !!t && t.type === 'internal';
}
function isExternalTransfer(t) {
    return !!t && (t.type || 'transfer') === 'transfer';
}
function internalMoveLabel(t) {
    return 'Moved ' + fmtMoneyB(t.amount) + ' from ' + (t.fromAccount || '?') + ' to ' + (t.toAccount || '?');
}

// ── Generic confirmation modal ─────────────────────────────────────────────
// rows: [[label, valueHtml], ...] — values are inserted as HTML, so callers
// must escape any user-provided text.
function showBankConfirmModal(opts, onConfirm) {
    var existing = document.getElementById('transferModal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'transferModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;animation:fadeIn 0.2s';

    var rowsHtml = (opts.rows || []).map(function(r, i) {
        var sep = r[2] === 'sep' ? 'border-top:1px solid #e2e8f0;padding-top:0.5rem;margin-top:0.5rem;' : '';
        return '<div style="display:flex;justify-content:space-between;gap:1rem;' + sep + (i < opts.rows.length - 1 ? 'margin-bottom:0.5rem' : '') + '"><span style="color:#64748b">' + r[0] + '</span>' + r[1] + '</div>';
    }).join('');

    modal.innerHTML =
        '<div style="background:#fff;border-radius:16px;padding:2rem;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2)">' +
        '<h2 style="font-size:1.25rem;font-weight:700;margin-bottom:1rem;color:#1e293b">' + escHtml(opts.title || 'Confirm') + '</h2>' +
        (opts.note ? '<p style="font-size:0.82rem;color:#64748b;margin:-0.4rem 0 0.9rem">' + opts.note + '</p>' : '') +
        '<div style="background:#f1f5f9;border-radius:10px;padding:1rem;margin-bottom:1.25rem;font-size:0.9rem">' + rowsHtml + '</div>' +
        '<div style="display:flex;gap:0.75rem">' +
            '<button id="modalCancel" class="btn" style="flex:1">Cancel</button>' +
            '<button id="modalConfirm" class="btn btn-primary" style="flex:1">' + escHtml(opts.confirmLabel || 'Confirm') + '</button>' +
        '</div></div>';

    document.body.appendChild(modal);

    document.getElementById('modalCancel').addEventListener('click', function() { modal.remove(); });
    document.getElementById('modalConfirm').addEventListener('click', function() {
        modal.remove();
        onConfirm();
    });
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
}

function showConfirmModal(details, onConfirm) {
    showBankConfirmModal({
        title: 'Confirm Transfer',
        confirmLabel: 'Confirm Transfer',
        rows: [
            ['To', '<strong>' + escHtml(details.recipient) + '</strong>'],
            ['Account', '<span style="font-family:monospace">' + escHtml(details.account) + '</span>'],
            ['From', '<span>' + escHtml(details.fromLabel) + '</span>'],
            ['Amount', '<strong style="color:#6366f1;font-size:1.1rem">' + fmtMoneyB(details.amount) + '</strong>', 'sep'],
            ['New balance', '<span style="color:' + (details.newBalance < 0 ? '#ef4444' : '#10b981') + '">' + fmtMoneyB(details.newBalance) + '</span>']
        ]
    }, onConfirm);
}

// ── Transaction detail modal ────────────────────────────────────────────────
var TX_TYPE_ICONS = { transfer: '💸', internal: '🔄' };

function showTransactionDetailModal(transaction) {
    var existing = document.getElementById('txDetailModal');
    if (existing) existing.remove();

    var t = transaction || {};
    var internal  = isInternalMove(t);
    var icon      = TX_TYPE_ICONS[t.type] || '💸';
    var typeLabel = internal ? 'Account Move' : 'Transfer';
    // t.date is just a pre-formatted display string with no time-of-day —
    // t.timestamp is the real millisecond epoch, so format that instead.
    var fullDateTime = t.timestamp ? new Date(t.timestamp).toLocaleString() : (t.date || '');

    var row = function(label, valueHtml, extra) {
        return '<div style="display:flex;justify-content:space-between;gap:1rem;margin-bottom:0.5rem;' + (extra || '') + '"><span style="color:#64748b">' + label + '</span>' + valueHtml + '</div>';
    };

    var body;
    if (internal) {
        body =
            row('From', '<span>' + escHtml(acctLabelB(t.fromAccount)) + ' Account</span>') +
            row('To', '<span>' + escHtml(acctLabelB(t.toAccount)) + ' Account</span>') +
            row('Amount', '<strong style="color:#6366f1;font-size:1.1rem">' + fmtMoneyB(t.amount) + '</strong>', 'border-top:1px solid #e2e8f0;padding-top:0.5rem;margin-top:0.5rem') +
            row('Date &amp; Time', '<span style="text-align:right">' + escHtml(fullDateTime) + '</span>') +
            '<div style="font-size:0.78rem;color:#64748b;margin-top:0.5rem">A move between your own accounts. Your total balance is unchanged, and it isn\'t counted as a transfer (no XP).</div>';
    } else {
        body =
            row('To', '<strong>' + escHtml(t.recipient) + '</strong>') +
            row('Account', '<span style="font-family:monospace">' + escHtml(t.account) + '</span>') +
            row('From', '<span>' + escHtml(acctLabelB(t.fromAccount)) + ' Account</span>') +
            row('Amount', '<strong style="color:#6366f1;font-size:1.1rem">' + fmtMoneyB(t.amount) + '</strong>', 'border-top:1px solid #e2e8f0;padding-top:0.5rem;margin-top:0.5rem') +
            row('Date &amp; Time', '<span style="text-align:right">' + escHtml(fullDateTime) + '</span>') +
            (t.description ? row('Description', '<span style="text-align:right;max-width:230px;word-break:break-word">' + escHtml(t.description) + '</span>') : '') +
            '<div style="display:flex;justify-content:space-between"><span style="color:#64748b">XP Earned</span><span style="color:' + ((t.pointsEarned || 0) > 0 ? '#10b981' : '#94a3b8') + ';font-weight:600">+' + (t.pointsEarned || 0) + ' XP</span></div>';
    }

    var modal = document.createElement('div');
    modal.id = 'txDetailModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:1000;animation:fadeIn 0.2s';
    modal.innerHTML =
        '<div style="background:#fff;border-radius:16px;padding:2rem;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.2)">' +
        '<h2 style="font-size:1.25rem;font-weight:700;margin-bottom:1rem;color:#1e293b">' + icon + ' ' + escHtml(typeLabel) + ' Details</h2>' +
        '<div style="background:#f1f5f9;border-radius:10px;padding:1rem;margin-bottom:1.25rem;font-size:0.9rem">' + body + '</div>' +
        '<div style="display:flex;gap:0.75rem">' +
            '<button id="txDetailClose" class="btn btn-primary" style="flex:1">Close</button>' +
        '</div></div>';

    document.body.appendChild(modal);
    document.getElementById('txDetailClose').addEventListener('click', function() { modal.remove(); });
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
}

// ── Balance display helpers ────────────────────────────────────────────────
function updateBalanceDisplay() {
    return DigifinwizDB.getAllBalances().then(function(bals) {
        var checking = bals.find(function(b){ return b.account === 'checking'; });
        var savings  = bals.find(function(b){ return b.account === 'savings';  });
        var sel = document.getElementById('fromAccount');
        if (sel && checking && savings) {
            sel.options[0].text = 'Checking Account — ' + fmtMoneyB(checking.amount);
            sel.options[1].text = 'Savings Account — ' + fmtMoneyB(savings.amount);
        }
        var chkBal = document.getElementById('acctBal-checking');
        var savBal = document.getElementById('acctBal-savings');
        if (chkBal && checking) chkBal.textContent = fmtMoneyB(checking.amount);
        if (savBal && savings)  savBal.textContent = fmtMoneyB(savings.amount);
        var mvChk = document.getElementById('moveBal-checking');
        var mvSav = document.getElementById('moveBal-savings');
        if (mvChk && checking) mvChk.textContent = fmtMoneyB(checking.amount);
        if (mvSav && savings)  mvSav.textContent = fmtMoneyB(savings.amount);
    }).catch(function(){});
}

// Everything that shows balances, transfer lists or stats — called after
// any money action on the Transfer tab.
function refreshAfterMoneyAction() {
    if (typeof refreshBankingPage === 'function') refreshBankingPage();
    else {
        updateTransactionsList(typeof currentTxFilter !== 'undefined' ? currentTxFilter : 'all');
        updateBalanceDisplay();
    }
    if (typeof loadDashboardTab === 'function') loadDashboardTab();
}

// Server computes challenge progress from the caller's own records; the
// client only reports what it says was completed.
function runChallengeCheck() {
    return DigifinwizDB.checkAndCompleteChallenges().then(function(result) {
        result = result || {};
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
        if (typeof refreshHeaderProgress === 'function') refreshHeaderProgress();
        if (typeof loadBankingChallenges === 'function') loadBankingChallenges();
        return result;
    }).catch(function(err) {
        console.error('Challenge check failed:', err);
    });
}

// ── Transfer form submit ────────────────────────────────────────────────────
// Guards against submitting a second transfer while the first is in flight.
var transferInFlight = false;

document.getElementById('transferForm').addEventListener('submit', function(e) {
    e.preventDefault();

    if (transferInFlight) {
        showNotification('A transfer is already in progress. Please wait.', 'error');
        return;
    }

    var fromAccount    = document.getElementById('fromAccount').value;
    var fromLabel      = fromAccount === 'savings' ? 'Savings Account' : 'Checking Account';
    var recipientName  = document.getElementById('recipientName').value.trim();
    var recipientAcct  = document.getElementById('recipientAccount').value.trim();
    var amount         = parseFloat(document.getElementById('amount').value);
    var description    = document.getElementById('description').value.trim();

    if (!recipientName) { showNotification('Please enter a recipient name.', 'error'); return; }
    if (!recipientAcct) { showNotification('Please enter a recipient account number.', 'error'); return; }
    if (!amount || amount <= 0) { showNotification('Please enter a valid amount.', 'error'); return; }
    amount = Math.round(amount * 100) / 100;

    // Balance is fetched only to preview the new balance in the confirm
    // modal — the server re-validates (and is the only thing that decides).
    DigifinwizDB.getBalance(fromAccount).then(function(balance) {
        showConfirmModal({
            recipient: recipientName,
            account:   recipientAcct,
            fromLabel: fromLabel + ' — ' + fmtMoneyB(balance),
            amount:    amount,
            newBalance: balance - amount
        }, function() {
            transferInFlight = true;
            DigifinwizDB.transfer({
                recipient:   recipientName,
                account:     recipientAcct,
                fromAccount: fromAccount,
                amount:      amount,
                description: description
            }).then(function(result) {
                var tx  = (result && result.transaction) || {};
                var pts = Number(tx.pointsEarned) || 0;
                // XP is exactly what the server says this transfer earned —
                // nothing for transfers under ƒ1.
                var award = pts > 0 && typeof awardXP === 'function'
                    ? awardXP(pts, { completedTasks: 1 })
                    : Promise.resolve();
                return award.then(function() { return { tx: tx, pts: pts }; });
            }).then(function(r) {
                transferInFlight = false;
                var sentAmt = r.tx.amount != null ? r.tx.amount : amount;
                showNotification('Transfer of ' + fmtMoneyB(sentAmt) + ' to ' + recipientName + ' sent!' +
                    (r.pts > 0 ? ' +' + r.pts + ' XP' : ' (no XP for transfers under ƒ1)'), 'success');
                showTransferReceipt({ recipient: recipientName, account: recipientAcct, fromLabel: fromLabel, amount: sentAmt, pointsEarned: r.pts });
                document.getElementById('transferForm').reset();
                var fb = document.getElementById('amountFeedback');
                if (fb) fb.style.display = 'none';
                refreshAfterMoneyAction();
                runChallengeCheck();
            }).catch(function(err) {
                transferInFlight = false;
                // 4xx = the server rejected it (e.g. insufficient funds) and
                // the message is shown to the user; only log unexpected ones.
                if (!(err && err.status >= 400 && err.status < 500)) console.error('Transfer error:', err);
                showNotification(err && err.message ? err.message : 'Transfer failed. Please try again.', 'error');
                updateBalanceDisplay();
            });
        });
    }).catch(function(err) {
        console.error('Balance check error:', err);
        showNotification('Could not check balance. Try again.', 'error');
    });
});

// ── Move money between own accounts ─────────────────────────────────────────
var moveInFlight = false;

function setMoveDirection(from) {
    var to = from === 'checking' ? 'savings' : 'checking';
    var fromEl = document.getElementById('moveFrom');
    if (fromEl) fromEl.value = from;
    var dirEl = document.getElementById('moveDirectionLabel');
    if (dirEl) dirEl.textContent = acctLabelB(from) + ' → ' + acctLabelB(to);
    ['checking', 'savings'].forEach(function(a) {
        var btn = document.getElementById('moveDir-' + a);
        if (btn) {
            btn.classList.toggle('active', a === from);
            btn.setAttribute('aria-checked', a === from ? 'true' : 'false');
        }
    });
}

function submitMoveMoney(e) {
    if (e) e.preventDefault();
    if (moveInFlight) { showNotification('A move is already in progress. Please wait.', 'error'); return; }
    var from   = (document.getElementById('moveFrom') || {}).value === 'savings' ? 'savings' : 'checking';
    var to     = from === 'checking' ? 'savings' : 'checking';
    var amount = parseFloat((document.getElementById('moveAmount') || {}).value);
    if (!amount || amount <= 0) { showNotification('Enter a valid amount to move.', 'error'); return; }
    amount = Math.round(amount * 100) / 100;

    DigifinwizDB.getAllBalances().then(function(bals) {
        var get = function(a) { return ((bals.find(function(b){ return b.account === a; }) || {}).amount) || 0; };
        var fromBal = get(from), toBal = get(to);
        showBankConfirmModal({
            title: 'Move Money',
            confirmLabel: 'Move ' + fmtMoneyB(amount),
            note: 'Between your own accounts — no fee, no XP, and it doesn\'t count as a transfer.',
            rows: [
                ['From', '<strong>' + acctLabelB(from) + '</strong>'],
                ['To', '<strong>' + acctLabelB(to) + '</strong>'],
                ['Amount', '<strong style="color:#6366f1;font-size:1.1rem">' + fmtMoneyB(amount) + '</strong>', 'sep'],
                [acctLabelB(from) + ' after', '<span style="color:' + (fromBal - amount < 0 ? '#ef4444' : '#1e293b') + '">' + fmtMoneyB(fromBal - amount) + '</span>'],
                [acctLabelB(to) + ' after', '<span style="color:#10b981">' + fmtMoneyB(toBal + amount) + '</span>']
            ]
        }, function() {
            moveInFlight = true;
            DigifinwizDB.moveMoney(from, to, amount).then(function(result) {
                moveInFlight = false;
                var b = (result && result.balances) || {};
                showNotification('Moved ' + fmtMoneyB(amount) + ' from ' + from + ' to ' + to + '.' +
                    (b.checking != null ? ' Checking: ' + fmtMoneyB(b.checking) + ' · Savings: ' + fmtMoneyB(b.savings) : ''), 'success');
                var amtEl = document.getElementById('moveAmount');
                if (amtEl) amtEl.value = '';
                refreshAfterMoneyAction();
                if (typeof refreshMessageBadge === 'function') refreshMessageBadge();
            }).catch(function(err) {
                moveInFlight = false;
                showNotification(err && err.message ? err.message : 'Could not move money. Please try again.', 'error');
            });
        });
    }).catch(function() {
        showNotification('Could not load balances. Try again.', 'error');
    });
}

// ── Avatar palette ────────────────────────────────────────────────────────
var TX_AVATAR_PALETTE = [
    ['#667eea','#764ba2'], ['#f093fb','#f5576c'], ['#4facfe','#00f2fe'],
    ['#43e97b','#38f9d7'], ['#fa709a','#fee140'], ['#a18cd1','#fbc2eb'],
    ['#fccb90','#d57eeb'], ['#30cfd0','#330867']
];

function avatarGradientFor(name) {
    var idx = (String(name || '?').charCodeAt(0) || 0) % TX_AVATAR_PALETTE.length;
    return 'linear-gradient(135deg,' + TX_AVATAR_PALETTE[idx][0] + ',' + TX_AVATAR_PALETTE[idx][1] + ')';
}
function initialsFor(name) {
    return String(name || '?').trim().split(/\s+/).slice(0,2).map(function(w){ return w[0]||''; }).join('').toUpperCase() || '?';
}

var ACCT_CHIP_STYLES = {
    checking: 'background:#ede9fe;color:#7c3aed',
    savings:  'background:#f0fdf4;color:#059669'
};
function acctChipB(account) {
    if (!ACCT_CHIP_STYLES[account]) return '';
    return '<span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:0.62rem;font-weight:700;' + ACCT_CHIP_STYLES[account] + ';margin-left:0.3rem;vertical-align:middle">' + acctLabelB(account) + '</span>';
}

function updateTransactionsList(filter) {
    return DigifinwizDB.getTransactions(200).then(function(transactions) {
        var list = document.getElementById('transactionsList');
        if (!list) return;

        // Account filter: a transfer belongs to the account it was sent
        // from; an own-account move belongs to both sides.
        var filtered = (filter && filter !== 'all')
            ? transactions.filter(function(t) {
                return t.fromAccount === filter || (isInternalMove(t) && t.toAccount === filter);
            })
            : transactions;
        var display = filtered.slice(0, 20);

        if (display.length === 0) {
            list.innerHTML = '<p style="color:#64748b;padding:1rem;text-align:center;font-size:0.875rem">' +
                (filter && filter !== 'all'
                    ? 'No activity on your ' + filter + ' account yet.'
                    : 'No transfers yet. Make your first transfer to earn XP!') + '</p>';
            return;
        }

        list.innerHTML = display.map(function(t) {
            var txAttr = (typeof jsAttrB === 'function') ? jsAttrB(t) : JSON.stringify(t).replace(/'/g, '&#39;');

            if (isInternalMove(t)) {
                return '<div class="transaction-item db-tx-internal" style="cursor:pointer" onclick=\'showTransactionDetailModal(' + txAttr + ')\'>' +
                    '<div style="width:40px;height:40px;border-radius:50%;background:#e0e7ef;border:1px dashed #94a3b8;display:flex;align-items:center;justify-content:center;font-size:1.05rem;flex-shrink:0">🔄</div>' +
                    '<div class="transaction-details" style="flex:1;min-width:0">' +
                        '<div style="font-weight:600;font-size:0.875rem">' + escHtml(internalMoveLabel(t)) + '</div>' +
                        '<div style="font-size:0.75rem;color:#64748b;margin-top:0.1rem">Between your own accounts · not a transfer</div>' +
                        '<div style="font-size:0.72rem;color:#94a3b8;margin-top:0.1rem">' + escHtml(t.date) + '</div>' +
                    '</div>' +
                    '<div style="text-align:right;flex-shrink:0">' +
                        '<div class="transaction-amount" style="color:#475569">⇄ ' + fmtMoneyB(t.amount) + '</div>' +
                        '<div style="font-size:0.7rem;color:#94a3b8;margin-top:0.1rem">No XP</div>' +
                    '</div>' +
                    '</div>';
            }

            var pts = t.pointsEarned || 0;
            return '<div class="transaction-item" style="cursor:pointer" onclick=\'showTransactionDetailModal(' + txAttr + ')\'>' +
                '<div style="width:40px;height:40px;border-radius:50%;background:' + avatarGradientFor(t.recipient) + ';display:flex;align-items:center;justify-content:center;font-size:0.82rem;font-weight:700;color:white;flex-shrink:0;letter-spacing:0.02em">' + escHtml(initialsFor(t.recipient)) + '</div>' +
                '<div class="transaction-details" style="flex:1;min-width:0">' +
                    '<div style="font-weight:600;font-size:0.875rem">Transfer to ' + escHtml(t.recipient) + acctChipB(t.fromAccount) + '</div>' +
                    (t.description ? '<div style="font-size:0.75rem;color:#64748b;margin-top:0.1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(t.description) + '</div>' : '') +
                    '<div style="font-size:0.72rem;color:#94a3b8;margin-top:0.1rem">' + escHtml(t.date) + '</div>' +
                '</div>' +
                '<div style="text-align:right;flex-shrink:0">' +
                    '<div class="transaction-amount sent">-' + fmtMoneyB(t.amount) + '</div>' +
                    '<div style="font-size:0.7rem;color:' + (pts > 0 ? '#10b981' : '#94a3b8') + ';margin-top:0.1rem">+' + pts + ' XP</div>' +
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
    var pts = Number(details.pointsEarned) || 0;
    var sheet = document.createElement('div');
    sheet.id = 'transferReceipt';
    sheet.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:2000;animation:slideUpSheet 0.35s cubic-bezier(0.34,1.56,0.64,1)';
    sheet.innerHTML =
        '<div style="background:#fff;border-radius:24px 24px 0 0;padding:2rem;max-width:520px;margin:0 auto;box-shadow:0 -8px 40px rgba(0,0,0,0.18)">' +
        '<div style="text-align:center;margin-bottom:1.5rem">' +
            '<div style="width:64px;height:64px;background:linear-gradient(135deg,#10b981,#059669);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;margin:0 auto 0.75rem;color:#fff">✓</div>' +
            '<div style="font-size:1.3rem;font-weight:800;color:#1e293b">Transfer Sent!</div>' +
            '<div style="font-size:0.82rem;color:#94a3b8;margin-top:0.2rem">Ref: ' + refNum + '</div>' +
        '</div>' +
        '<div style="background:#f8fafc;border-radius:14px;padding:1rem;margin-bottom:1.25rem;font-size:0.875rem">' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.6rem"><span style="color:#64748b">To</span><strong>' + escHtml(details.recipient) + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.6rem"><span style="color:#64748b">Account</span><span style="font-family:monospace">' + escHtml(details.account) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.6rem"><span style="color:#64748b">From</span><span>' + escHtml(details.fromLabel) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;margin-bottom:0.6rem;padding-top:0.6rem;border-top:1px solid #e2e8f0"><span style="color:#64748b">Amount</span><strong style="color:#6366f1;font-size:1.1rem">' + fmtMoneyB(details.amount) + '</strong></div>' +
            '<div style="display:flex;justify-content:space-between"><span style="color:#64748b">XP Earned</span><span style="color:' + (pts > 0 ? '#10b981' : '#94a3b8') + ';font-weight:600">+' + pts + ' XP' + (pts > 0 ? '' : ' (under ƒ1)') + '</span></div>' +
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
        if (navigator.clipboard) { navigator.clipboard.writeText(refNum).catch(function(){}); }
        this.textContent = '✓ Copied!';
        var btn = this;
        setTimeout(function() { if (btn) btn.textContent = '📋 Copy Ref'; }, 1500);
    });
}

document.addEventListener('DOMContentLoaded', function() {
    updateBalanceDisplay();
    var moveForm = document.getElementById('moveMoneyForm');
    if (moveForm) moveForm.addEventListener('submit', submitMoveMoney);
    setMoveDirection('checking');
});
