// admin.js - Digifinwiz Admin Panel Logic v2

document.addEventListener('DOMContentLoaded', function () {

    // ── Navigation ──────────────────────────────────────────────────────────
    const navItems  = document.querySelectorAll('.admin-nav-item[data-page]');
    const pages     = document.querySelectorAll('.admin-page');
    const pageTitle = document.getElementById('pageTitle');

    const PAGE_TITLES = {
        dashboard: 'Dashboard', user: 'User Profile',
        transactions: 'Transactions', payments: 'Bill Payments',
        purchases: 'Purchases', bills: 'Bill Management', challenges: 'Challenges',
        users: 'User Management', messaging: 'Messaging', settings: 'Settings'
    };

    function showPage(pageId) {
        pages.forEach(p => p.classList.remove('active'));
        navItems.forEach(n => n.classList.remove('active'));
        const page = document.getElementById('page-' + pageId);
        if (page) page.classList.add('active');
        const nav = document.querySelector('.admin-nav-item[data-page="' + pageId + '"]');
        if (nav) nav.classList.add('active');
        pageTitle.textContent = PAGE_TITLES[pageId] || pageId;
        loadPage(pageId);
    }

    navItems.forEach(item => {
        item.addEventListener('click', function () {
            showPage(this.dataset.page);
            document.getElementById('adminSidebar').classList.remove('open');
            document.getElementById('sidebarOverlay').classList.remove('active');
        });
    });

    document.getElementById('sidebarToggle').addEventListener('click', function () {
        document.getElementById('adminSidebar').classList.toggle('open');
        document.getElementById('sidebarOverlay').classList.toggle('active');
    });
    document.getElementById('sidebarOverlay').addEventListener('click', function () {
        document.getElementById('adminSidebar').classList.remove('open');
        this.classList.remove('active');
    });
    document.getElementById('refreshBtn').addEventListener('click', function () {
        const active = document.querySelector('.admin-nav-item.active');
        if (active) loadPage(active.dataset.page);
    });

    // ── Page loaders ────────────────────────────────────────────────────────
    function loadPage(pageId) {
        switch (pageId) {
            case 'dashboard':    loadDashboard(); break;
            case 'user':         loadUserPage(); break;
            case 'transactions': loadTransactionsPage(); break;
            case 'payments':     loadPaymentsPage(); break;
            case 'purchases':    loadPurchasesPage(); break;
            case 'challenges':   loadChallengesPage(); break;
            case 'bills':        loadBillsPage(); break;
            case 'users':        loadUsersPage(); break;
            case 'messaging':    loadMessagingPage(); break;
            case 'settings':     loadSettingsPage(); break;
        }
    }

    // ── DASHBOARD ───────────────────────────────────────────────────────────
    function loadDashboard() {
        Promise.all([
            DigifinwizDB.getStats(),
            DigifinwizDB.getTransactions(5),
            DigifinwizDB.getAllBalances(),
            DigifinwizDB.getRecentActivity(8),
            DigifinwizDB.getChallenges()
        ]).then(([stats, recentTx, balances, activity, challenges]) => {
            const user = stats.user;
            setText('dash-level',          user ? user.level : 0);
            setText('dash-points',         user ? user.points.toLocaleString() : 0);
            setText('dash-tx-count',       stats.txCount);
            setText('dash-purchase-count', stats.purchCount);

            // Balances
            const checking = balances.find(b => b.account === 'checking');
            const savings  = balances.find(b => b.account === 'savings');
            setText('dash-checking', checking ? 'ƒ' + checking.amount.toLocaleString('en-US', {minimumFractionDigits:2}) : '—');
            setText('dash-savings',  savings  ? 'ƒ' + savings.amount.toLocaleString('en-US', {minimumFractionDigits:2}) : '—');

            // Progress snapshot
            if (user) {
                const earned = 1000 - user.pointsToNextLevel;
                const pct    = Math.max(0, Math.min(100, Math.round((earned / 1000) * 100)));
                document.getElementById('dash-xp-bar').style.width = pct + '%';
                setText('dash-xp-label', earned + ' / 1000 XP (' + pct + '%)');
                setText('dash-tasks',    user.completedTasks);
            }
            const activeChallenges = challenges.filter(c => c.active !== false).length;
            setText('dash-challenges', activeChallenges);
            setText('dash-bills', stats.payCount);

            // Recent tx table
            const txBadge = document.getElementById('dash-tx-badge');
            if (txBadge) txBadge.textContent = stats.txCount;
            const txTable = document.getElementById('dash-tx-table');
            if (recentTx.length === 0) {
                txTable.innerHTML = '<tr class="empty-row"><td colspan="3">No transactions yet</td></tr>';
            } else {
                txTable.innerHTML = recentTx.map(t =>
                    '<tr><td>' + escHtml(t.recipient || '—') + '</td>' +
                    '<td>ƒ' + Number(t.amount).toFixed(2) + '</td>' +
                    '<td>' + escHtml(t.date || '—') + '</td></tr>'
                ).join('');
            }

            // Activity feed
            const feed = document.getElementById('activityFeed');
            if (activity.length === 0) {
                feed.innerHTML = '<div style="color:var(--color-text-muted);font-size:var(--text-sm)">No activity yet.</div>';
            } else {
                const dotMap = { transfer: 'dot-blue', payment: 'dot-amber', purchase: 'dot-green' };
                feed.innerHTML = activity.map(e =>
                    '<div class="activity-item">' +
                    '<div class="activity-dot ' + (dotMap[e.type] || 'dot-purple') + '"></div>' +
                    '<div><div class="activity-text">' + e.icon + ' ' + escHtml(e.label) + ' — ' + escHtml(e.detail) + '</div>' +
                    '<div class="activity-time">' + escHtml(e.date || '') + ' · +' + e.pointsEarned + ' pts</div></div>' +
                    '</div>'
                ).join('');
            }
        }).catch(err => console.error('loadDashboard:', err));
    }

    // ── USER PAGE ────────────────────────────────────────────────────────────
    var _userPageSelectedId = null;

    function _loadUserDataIntoForm(userData) {
        const ud = userData || {};
        setVal('edit-level',      ud.level);
        setVal('edit-points',     ud.points);
        setVal('edit-ptnl',       ud.pointsToNextLevel);
        setVal('edit-challenges', ud.challenges);
        setVal('edit-tasks',      ud.completedTasks);
        const display = Object.assign({}, ud); delete display.id;
        document.getElementById('userRawJson').textContent = JSON.stringify(display, null, 2);
    }

    function loadUserPage() {
        DigifinwizDB.getAllUsers().then(function(users) {
            var select = document.getElementById('user-profile-select');
            if (!select) return;
            var participants = users.filter(function(u) { return u.role === 'participant' && u.status === 'approved'; })
                .sort(function(a, b) { return (a.fullName || '').localeCompare(b.fullName || ''); });
            select.innerHTML = '<option value="">— Select a user —</option>';
            participants.forEach(function(u) {
                var opt = document.createElement('option');
                opt.value = u.id;
                opt.textContent = escHtml(u.fullName || u.username) + ' (@' + escHtml(u.username) + ')';
                select.appendChild(opt);
            });
            // Restore previously selected user or pick first
            if (_userPageSelectedId) {
                select.value = _userPageSelectedId;
            } else if (participants.length) {
                select.value = participants[0].id;
                _userPageSelectedId = participants[0].id;
            }
            _loadSelectedUserProfile();
        }).catch(err => console.error('loadUserPage:', err));
    }

    function _loadSelectedUserProfile() {
        var select = document.getElementById('user-profile-select');
        var id = select ? parseInt(select.value) : null;
        _userPageSelectedId = id || null;
        if (!id) {
            _loadUserDataIntoForm(null);
            document.getElementById('userRawJson').textContent = 'No user selected.';
            return;
        }
        DigifinwizDB.getAllUsers().then(function(users) {
            var u = users.find(function(x) { return x.id === id; });
            _loadUserDataIntoForm(u ? u.userData : null);
        }).catch(err => console.error('_loadSelectedUserProfile:', err));
    }

    document.getElementById('user-profile-select').addEventListener('change', _loadSelectedUserProfile);

    document.getElementById('userEditForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var id = _userPageSelectedId;
        if (!id) { showToast('Please select a user first.', 'error'); return; }
        DigifinwizDB.getAllUsers().then(function(users) {
            var u = users.find(function(x) { return x.id === id; });
            var ud = Object.assign({}, u ? u.userData || {} : {});
            ud.level             = parseInt(getVal('edit-level'))      || 1;
            ud.points            = parseInt(getVal('edit-points'))     || 0;
            ud.pointsToNextLevel = parseInt(getVal('edit-ptnl'))       || 1000;
            ud.challenges        = parseInt(getVal('edit-challenges')) || 0;
            ud.completedTasks    = parseInt(getVal('edit-tasks'))      || 0;
            return DigifinwizDB.updateUser(id, { userData: ud });
        }).then(() => { showToast('User data saved!', 'success'); _loadSelectedUserProfile(); })
          .catch(err => { console.error(err); showToast('Save failed.', 'error'); });
    });

    document.getElementById('resetUserBtn').addEventListener('click', function () {
        var id = _userPageSelectedId;
        if (!id) { showToast('Please select a user first.', 'error'); return; }
        if (!confirm('Reset this user\'s profile to default values?')) return;
        DigifinwizDB.updateUser(id, { userData: { level:1, points:0, pointsToNextLevel:1000, challenges:0, completedTasks:0 } })
            .then(() => { showToast('Reset to defaults.', 'info'); _loadSelectedUserProfile(); });
    });

    document.getElementById('copyUserJson').addEventListener('click', function () {
        const text = document.getElementById('userRawJson').textContent;
        navigator.clipboard.writeText(text)
            .then(() => showToast('Copied!', 'success'))
            .catch(() => showToast('Copy failed.', 'error'));
    });

    // ── SORTABLE TABLE HELPER ────────────────────────────────────────────────
    // state: { data:[], sortCol:null, sortDir:'asc', page:1, search:'' }
    function makeSortableTable(config) {
        let state = { data: [], filtered: [], sortCol: null, sortDir: 'asc', page: 1, search: '' };
        const PER_PAGE = 20;

        function applyFilter() {
            const q = state.search.toLowerCase();
            state.filtered = q ? state.data.filter(row =>
                config.searchFields.some(f => String(row[f] || '').toLowerCase().includes(q))
            ) : state.data.slice();
        }

        function applySort() {
            if (!state.sortCol) return;
            const col = state.sortCol;
            const dir = state.sortDir === 'asc' ? 1 : -1;
            state.filtered.sort((a, b) => {
                const av = a[col], bv = b[col];
                if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
                return String(av || '').localeCompare(String(bv || '')) * dir;
            });
        }

        function renderTable() {
            const tbody   = document.getElementById(config.tbodyId);
            const info    = document.getElementById(config.infoId);
            const prevBtn = document.getElementById(config.prevId);
            const nextBtn = document.getElementById(config.nextId);

            const total = state.filtered.length;
            const pages = Math.max(1, Math.ceil(total / PER_PAGE));
            state.page  = Math.min(state.page, pages);
            const start = (state.page - 1) * PER_PAGE;
            const slice = state.filtered.slice(start, start + PER_PAGE);

            if (total === 0) {
                tbody.innerHTML = '<tr class="empty-row"><td colspan="' + config.cols + '">' + (state.search ? 'No matches.' : 'No records.') + '</td></tr>';
            } else {
                tbody.innerHTML = slice.map((row, i) => config.rowFn(row, start + i)).join('');
            }

            if (info)    info.textContent = 'Showing ' + (total === 0 ? 0 : start + 1) + '–' + Math.min(start + PER_PAGE, total) + ' of ' + total;
            if (prevBtn) prevBtn.disabled = state.page <= 1;
            if (nextBtn) nextBtn.disabled = state.page >= pages;

            // Highlight sort column
            document.querySelectorAll('#' + config.tableId + ' th[data-sort]').forEach(th => {
                th.classList.toggle('sort-active', th.dataset.sort === state.sortCol);
                if (th.dataset.sort === state.sortCol) {
                    th.querySelector('.sort-arrow').textContent = state.sortDir === 'asc' ? ' ↑' : ' ↓';
                } else {
                    th.querySelector('.sort-arrow').textContent = ' ↕';
                }
            });
        }

        function load(data) {
            state.data     = data;
            state.page     = 1;
            applyFilter();
            applySort();
            renderTable();
        }

        // Wire up header sort clicks
        document.querySelectorAll('#' + config.tableId + ' th[data-sort]').forEach(th => {
            th.style.cursor = 'pointer';
            th.addEventListener('click', function () {
                const col = this.dataset.sort;
                if (state.sortCol === col) {
                    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                } else {
                    state.sortCol = col; state.sortDir = 'asc';
                }
                state.page = 1;
                applySort();
                renderTable();
            });
        });

        // Wire search
        const searchInput = document.getElementById(config.searchId);
        if (searchInput) {
            searchInput.addEventListener('input', function () {
                state.search = this.value;
                state.page   = 1;
                applyFilter();
                applySort();
                renderTable();
            });
        }

        // Wire pagination
        const prevBtn = document.getElementById(config.prevId);
        const nextBtn = document.getElementById(config.nextId);
        if (prevBtn) prevBtn.addEventListener('click', function () { state.page--; renderTable(); });
        if (nextBtn) nextBtn.addEventListener('click', function () { state.page++; renderTable(); });

        return { load };
    }

    // ── TRANSACTIONS PAGE ────────────────────────────────────────────────────
    let txTable;
    function loadTransactionsPage() {
        if (!txTable) {
            txTable = makeSortableTable({
                tableId: 'txMainTable', tbodyId: 'tx-table-body',
                searchId: 'tx-search', infoId: 'tx-page-info',
                prevId: 'tx-prev', nextId: 'tx-next',
                searchFields: ['recipient', 'account', 'description', 'date'],
                cols: 8,
                rowFn: (t, i) =>
                    '<tr>' +
                    '<td style="color:var(--color-text-muted)">' + (i + 1) + '</td>' +
                    '<td><span class="pill pill-blue">' + escHtml(t.type || 'transfer') + '</span></td>' +
                    '<td>' + escHtml(t.recipient || '—') + '</td>' +
                    '<td style="font-family:monospace;font-size:var(--text-xs)">' + escHtml(t.account || '—') + '</td>' +
                    '<td><strong>ƒ' + Number(t.amount || 0).toFixed(2) + '</strong></td>' +
                    '<td style="color:var(--color-text-muted)">' + escHtml(t.description || '—') + '</td>' +
                    '<td><span class="pill pill-green">+' + (t.pointsEarned || 0) + '</span></td>' +
                    '<td>' + escHtml(t.date || '—') + '</td>' +
                    '</tr>'
            });
        }
        DigifinwizDB.getTransactions(1000).then(list => {
            const badge = document.getElementById('tx-count-badge');
            if (badge) badge.textContent = list.length;
            txTable.load(list);
        }).catch(err => console.error('loadTransactionsPage:', err));
    }

    // ── PAYMENTS PAGE ────────────────────────────────────────────────────────
    let payTable;
    function loadPaymentsPage() {
        if (!payTable) {
            payTable = makeSortableTable({
                tableId: 'payMainTable', tbodyId: 'pay-table-body',
                searchId: 'pay-search', infoId: 'pay-page-info',
                prevId: 'pay-prev', nextId: 'pay-next',
                searchFields: ['type', 'accountNumber', 'date'],
                cols: 6,
                rowFn: (p, i) =>
                    '<tr>' +
                    '<td style="color:var(--color-text-muted)">' + (i + 1) + '</td>' +
                    '<td><span class="pill pill-amber">' + escHtml(p.type || '—') + '</span></td>' +
                    '<td style="font-family:monospace;font-size:var(--text-xs)">' + escHtml(p.accountNumber || '—') + '</td>' +
                    '<td><strong>ƒ' + Number(p.amount || 0).toFixed(2) + '</strong></td>' +
                    '<td><span class="pill pill-green">+' + (p.pointsEarned || 0) + '</span></td>' +
                    '<td>' + escHtml(p.date || '—') + '</td>' +
                    '</tr>'
            });
        }
        DigifinwizDB.getPayments(1000).then(list => {
            const badge = document.getElementById('pay-count-badge');
            if (badge) badge.textContent = list.length;
            payTable.load(list);
        }).catch(err => console.error('loadPaymentsPage:', err));
    }

    // ── PURCHASES PAGE ────────────────────────────────────────────────────────
    let purchTable;
    function loadPurchasesPage() {
        if (!purchTable) {
            purchTable = makeSortableTable({
                tableId: 'purchMainTable', tbodyId: 'purch-table-body',
                searchId: 'purch-search', infoId: 'purch-page-info',
                prevId: 'purch-prev', nextId: 'purch-next',
                searchFields: ['date'],
                cols: 5,
                rowFn: (p, i) => {
                    const itemNames = p.items ? p.items.map(it => escHtml(it.name)).join(', ') : '—';
                    return '<tr>' +
                        '<td style="color:var(--color-text-muted)">' + (i + 1) + '</td>' +
                        '<td>' + escHtml(p.date || '—') + '</td>' +
                        '<td style="font-size:var(--text-xs);color:var(--color-text-muted)">' + itemNames + '</td>' +
                        '<td><strong>ƒ' + Number(p.total || 0).toFixed(2) + '</strong></td>' +
                        '<td><span class="pill pill-green">+' + (p.pointsEarned || 0) + '</span></td>' +
                        '</tr>';
                }
            });
        }
        DigifinwizDB.getPurchases(1000).then(list => {
            const badge = document.getElementById('purch-count-badge');
            if (badge) badge.textContent = list.length;
            purchTable.load(list);
        }).catch(err => console.error('loadPurchasesPage:', err));
    }

    // ── CHALLENGES PAGE ──────────────────────────────────────────────────────
    const CAT_PILL   = { banking: 'pill-blue', ecommerce: 'pill-green', utilities: 'pill-amber', general: 'pill-purple' };
    const CAT_LABELS = { banking: 'Banking',   ecommerce: 'Ecommerce',  utilities: 'Utilities',  general: 'General'  };

    // Condition labels map for human-readable display
    const COND_LABELS = {
        manual:             'Manual',
        first_transfer:     'First transfer',
        first_purchase:     'First purchase',
        first_payment:      'First bill paid',
        transfer_amount:    'Transfer ≥ ƒ{v}',
        total_transferred:  'Total transfers ≥ ƒ{v}',
        purchase_items:     'Checkout ≥ {v} items',
        total_spent_ecom:   'Ecom spend ≥ ƒ{v}',
        payment_count:      'Bills paid ≥ {v}',
        transaction_count:  'Transfers ≥ {v}',
        reach_level:        'Reach level {v}',
        payment_amount:     'Bill payment ≥ ƒ{v}',
        purchase_count:     'Orders ≥ {v}',
        total_paid_bills:   'Total bills ≥ ƒ{v}',
        total_xp_earned:    'Total XP ≥ {v}',
        florin_balance:     'Florin balance ≥ ƒ{v}',
        checking_balance:       'Checking ≥ ƒ{v}',
        savings_balance:        'Savings ≥ ƒ{v}',
        unique_recipients:      'Recipients ≥ {v}',
        first_savings_transfer: 'First savings transfer',
        savings_transfer_count: 'Savings transfers ≥ {v}'
    };
    // Conditions that require a numeric threshold
    const COND_NEEDS_VALUE = new Set([
        'transfer_amount', 'total_transferred', 'purchase_items', 'total_spent_ecom', 'payment_count',
        'transaction_count', 'reach_level', 'payment_amount', 'purchase_count', 'total_paid_bills',
        'total_xp_earned', 'florin_balance', 'checking_balance', 'savings_balance', 'unique_recipients',
        'savings_transfer_count', 'custom'
    ]);
    const COND_VALUE_LABEL = {
        transfer_amount:   'Minimum florin amount (ƒ)',
        total_transferred: 'Cumulative florin amount (ƒ)',
        purchase_items:    'Minimum items per checkout',
        total_spent_ecom:  'Cumulative spend (ƒ)',
        payment_count:     'Number of bills',
        transaction_count: 'Number of transfers',
        reach_level:       'Level number',
        payment_amount:    'Minimum bill payment (ƒ)',
        purchase_count:    'Number of orders',
        total_paid_bills:  'Cumulative bills paid (ƒ)',
        total_xp_earned:   'Total XP',
        florin_balance:    'Minimum florin balance (ƒ)',
        checking_balance:       'Minimum checking balance (ƒ)',
        savings_balance:        'Minimum savings balance (ƒ)',
        unique_recipients:      'Number of unique recipients',
        savings_transfer_count: 'Number of transfers from Savings',
        custom:            'Comparison Value'
    };

    // Short clauses used to build combined multi-condition summaries/labels
    const COND_CLAUSE = {
        manual:             'admin marks it complete',
        first_transfer:     'the user makes their first bank transfer',
        first_purchase:     'the user makes their first ecommerce purchase',
        first_payment:      'the user pays their first utility bill',
        transfer_amount:    'a single transfer is ≥ ƒ{v}',
        total_transferred:  'total transfers reach ƒ{v}',
        purchase_items:     'a checkout has ≥ {v} item(s)',
        total_spent_ecom:   'total ecommerce spend reaches ƒ{v}',
        payment_count:      'total bills paid reaches {v}',
        transaction_count:  'total transfers reaches {v}',
        reach_level:        'the user reaches level {v}',
        payment_amount:     'a single bill payment is ≥ ƒ{v}',
        purchase_count:     'total orders placed reaches {v}',
        total_paid_bills:   'total bills paid reaches ƒ{v}',
        total_xp_earned:    'total XP earned reaches {v}',
        florin_balance:     'florin wallet balance reaches ≥ ƒ{v}',
        checking_balance:       'checking account balance is ≥ ƒ{v}',
        savings_balance:        'savings account balance is ≥ ƒ{v}',
        unique_recipients:      'the user has transferred to ≥ {v} unique recipients',
        first_savings_transfer: 'the user makes their first transfer from a Savings account',
        savings_transfer_count: 'total transfers from Savings reaches {v}'
    };

    // Fields a "custom" condition can compare — mirrors the server-side
    // whitelist so the picker only ever offers valid, safe field names.
    const CUSTOM_FIELDS = [
        { value: 'txCount',          label: 'Bank Transfers Made',      currency: false },
        { value: 'payCount',         label: 'Bills Paid',               currency: false },
        { value: 'purchCount',       label: 'Ecommerce Orders Placed',  currency: false },
        { value: 'lastTxAmount',     label: 'Last Transfer Amount',     currency: true  },
        { value: 'lastItemCount',    label: 'Last Checkout Item Count', currency: false },
        { value: 'lastPayAmount',    label: 'Last Bill Payment',        currency: true  },
        { value: 'totalTransferred', label: 'Total Transferred',        currency: true  },
        { value: 'totalSpentEcom',   label: 'Total Ecommerce Spend',    currency: true  },
        { value: 'totalSpentBills',  label: 'Total Bills Paid',         currency: true  },
        { value: 'userLevel',        label: 'Current Level',            currency: false },
        { value: 'totalXpEarned',    label: 'Total XP Earned',          currency: false },
        { value: 'florinBalance',    label: 'Florin Wallet Balance',    currency: true  },
        { value: 'checkingBalance',      label: 'Checking Account Balance',        currency: true  },
        { value: 'savingsBalance',       label: 'Savings Account Balance',         currency: true  },
        { value: 'uniqueRecipients',     label: 'Unique Recipients Transferred To', currency: false },
        { value: 'savingsTransferCount', label: 'Transfers From Savings',          currency: false }
    ];
    const CUSTOM_FIELD_MAP = {};
    CUSTOM_FIELDS.forEach(f => { CUSTOM_FIELD_MAP[f.value] = f; });

    const CUSTOM_OPERATORS  = [
        { value: 'gte', label: '≥ at least' },
        { value: 'gt',  label: '> more than' },
        { value: 'eq',  label: '= exactly'   },
        { value: 'lt',  label: '< less than' },
        { value: 'lte', label: '≤ at most'   }
    ];
    const CUSTOM_OP_SYMBOL = { gte: '≥', gt: '>', eq: '=', lt: '<', lte: '≤' };

    function customFieldOptionsHtml() {
        return CUSTOM_FIELDS.map(f => '<option value="' + f.value + '">' + escHtml(f.label) + '</option>').join('');
    }
    function customOperatorOptionsHtml() {
        return CUSTOM_OPERATORS.map(o => '<option value="' + o.value + '">' + escHtml(o.label) + '</option>').join('');
    }

    // Short "<field> <op> <value>" clause for a custom condition
    function customClauseShort(cc) {
        const fieldMeta = CUSTOM_FIELD_MAP[cc.customField] || { label: cc.customField || '(field)', currency: false };
        const opSymbol  = CUSTOM_OP_SYMBOL[cc.customOperator] || '≥';
        const valStr    = fieldMeta.currency ? ('ƒ' + (cc.conditionValue || 0)) : String(cc.conditionValue || 0);
        return fieldMeta.label + ' ' + opSymbol + ' ' + valStr;
    }

    function condLabel(c) {
        let label;
        if (c.condition === 'custom') {
            label = 'Custom: ' + customClauseShort(c);
        } else {
            const tmpl = COND_LABELS[c.condition] || c.condition;
            label = tmpl.replace('{v}', c.conditionValue || 0);
        }
        const extra = Array.isArray(c.extraConditions) ? c.extraConditions : [];
        if (extra.length > 0) {
            label += ' ' + (c.conditionLogic === 'any' ? 'OR' : 'AND') + ' +' + extra.length + ' more';
        }
        return label;
    }

    // Full multi-condition sentence — used for table tooltips + live preview/summary
    function condFullSummary(c) {
        const primary = { condition: c.condition, conditionValue: c.conditionValue, customField: c.customField, customOperator: c.customOperator };
        if (primary.condition === 'manual') {
            return '✋ Completion is manual — you mark it complete from the table.';
        }
        const all     = [primary].concat(Array.isArray(c.extraConditions) ? c.extraConditions : []);
        const clauses = all.map(cc => cc.condition === 'custom'
            ? customClauseShort(cc)
            : (COND_CLAUSE[cc.condition] || cc.condition).replace('{v}', cc.conditionValue || 0));
        if (clauses.length === 1) return '🤖 Auto-completes when ' + clauses[0] + '.';
        const joiner = c.conditionLogic === 'any' ? ' OR ' : ' AND ';
        return '🤖 Auto-completes when ' + clauses.join(joiner) + '.';
    }

    // Metadata driving the smart threshold input + category auto-suggest
    const COND_META = {
        manual:             { category: null,        prefix: null, suffix: null,        step: null, min: null, max: null },
        first_transfer:     { category: 'banking',    prefix: null, suffix: null,        step: null, min: null, max: null },
        first_purchase:     { category: 'ecommerce',  prefix: null, suffix: null,        step: null, min: null, max: null },
        first_payment:      { category: 'utilities',  prefix: null, suffix: null,        step: null, min: null, max: null },
        transfer_amount:    { category: 'banking',    prefix: 'ƒ',  suffix: null,        step: 0.01, min: 0.01, max: null },
        total_transferred:  { category: 'banking',    prefix: 'ƒ',  suffix: null,        step: 0.01, min: 0.01, max: null },
        purchase_items:     { category: 'ecommerce',  prefix: null, suffix: 'items',     step: 1,    min: 1,    max: 50   },
        total_spent_ecom:   { category: 'ecommerce',  prefix: 'ƒ',  suffix: null,        step: 0.01, min: 0.01, max: null },
        payment_count:      { category: 'utilities',  prefix: null, suffix: 'bills',     step: 1,    min: 1,    max: 999  },
        transaction_count:  { category: 'banking',    prefix: null, suffix: 'transfers', step: 1,    min: 1,    max: 999  },
        reach_level:        { category: 'general',    prefix: null, suffix: 'level',     step: 1,    min: 1,    max: 50   },
        payment_amount:     { category: 'utilities',  prefix: 'ƒ',  suffix: null,        step: 0.01, min: 0.01, max: null },
        purchase_count:     { category: 'ecommerce',  prefix: null, suffix: 'orders',    step: 1,    min: 1,    max: 999  },
        total_paid_bills:   { category: 'utilities',  prefix: 'ƒ',  suffix: null,        step: 0.01, min: 0.01, max: null },
        total_xp_earned:    { category: 'general',    prefix: null, suffix: 'XP',        step: 1,    min: 1,    max: null },
        florin_balance:     { category: 'general',    prefix: 'ƒ',  suffix: null,        step: 0.01, min: 0.01, max: null },
        checking_balance:       { category: 'banking', prefix: 'ƒ',  suffix: null,          step: 0.01, min: 0.01, max: null },
        savings_balance:        { category: 'banking', prefix: 'ƒ',  suffix: null,          step: 0.01, min: 0.01, max: null },
        unique_recipients:      { category: 'banking', prefix: null, suffix: 'recipients', step: 1,    min: 1,    max: 999  },
        first_savings_transfer: { category: 'banking', prefix: null, suffix: null,          step: null, min: null, max: null },
        savings_transfer_count: { category: 'banking', prefix: null, suffix: 'transfers',  step: 1,    min: 1,    max: 999  },
        custom:             { category: null,         prefix: null, suffix: null,        step: 'any', min: 0,   max: null }
    };

    // Applies label/ƒ-prefix/unit-suffix/step/min/max for a condition onto an
    // arbitrary set of fields — shared by the primary condition and every
    // dynamically-added extra-condition row.
    function applyCondMetaToFields(condition, fields) {
        const meta     = COND_META[condition] || COND_META.manual;
        const needsVal = COND_NEEDS_VALUE.has(condition);
        if (fields.groupEl) fields.groupEl.style.display = needsVal ? '' : 'none';
        if (needsVal) {
            if (fields.labelEl) fields.labelEl.textContent = COND_VALUE_LABEL[condition] || 'Threshold Value';
            if (fields.prefixEl) { fields.prefixEl.style.display = meta.prefix ? '' : 'none'; fields.prefixEl.textContent = meta.prefix || ''; }
            if (fields.suffixEl) { fields.suffixEl.style.display = meta.suffix ? '' : 'none'; fields.suffixEl.textContent = meta.suffix || ''; }
            if (fields.input) {
                fields.input.step = meta.step != null ? String(meta.step) : 'any';
                fields.input.min  = meta.min  != null ? String(meta.min)  : '0';
                if (meta.max != null) fields.input.max = String(meta.max); else fields.input.removeAttribute('max');
            }
        }
        return meta;
    }

    // Keeps the primary threshold input in sync with the chosen Completion
    // Condition, optionally auto-suggests Category, and manages the
    // "Add Another Condition" affordance (manual challenges can't combine
    // with automatic extra conditions, so switching to Manual clears them).
    function syncConditionUI(condition, opts) {
        opts = opts || {};
        const meta = applyCondMetaToFields(condition, {
            groupEl:  document.getElementById('chal-condval-group'),
            labelEl:  document.getElementById('chal-condval-label'),
            prefixEl: document.getElementById('chal-condval-prefix'),
            suffixEl: document.getElementById('chal-condval-suffix'),
            input:    document.getElementById('chal-condval')
        });

        const customGroup = document.getElementById('chal-custom-fields-group');
        if (customGroup) {
            customGroup.style.display = (condition === 'custom') ? '' : 'none';
            if (condition === 'custom') updateCustomFieldAffix();
        }

        if (opts.suggestCategory && meta.category) {
            const catSelect = document.getElementById('chal-category');
            if (catSelect && catSelect.value !== meta.category) {
                catSelect.value = meta.category;
                if (opts.userTriggered) showToast('Category auto-set to ' + (CAT_LABELS[meta.category] || meta.category) + '.', 'info');
            }
        }

        const addBtn = document.getElementById('chal-add-cond-btn');
        if (!addBtn) return;
        if (condition === 'manual') {
            if (opts.userTriggered && getExtraConditionRows().length > 0) {
                showToast('Extra conditions cleared — manual challenges can\'t use automatic conditions.', 'info');
            }
            clearExtraConditions();
            addBtn.hidden = true;
        } else {
            addBtn.hidden = false;
            updateAddCondButtonState();
        }
    }

    // Keeps the primary threshold input's ƒ-prefix in sync with whichever
    // context field the admin picked in the Custom condition builder.
    function updateCustomFieldAffix() {
        const fieldSel = document.getElementById('chal-custom-field');
        const prefixEl = document.getElementById('chal-condval-prefix');
        if (!fieldSel || !prefixEl) return;
        const meta = CUSTOM_FIELD_MAP[fieldSel.value];
        const isCurrency = meta ? meta.currency : false;
        prefixEl.style.display = isCurrency ? '' : 'none';
        prefixEl.textContent   = isCurrency ? 'ƒ' : '';
    }

    // Populate the primary Custom condition's Field/Comparison selects once
    (function initCustomConditionPickers() {
        const fieldSel = document.getElementById('chal-custom-field');
        const opSel    = document.getElementById('chal-custom-operator');
        if (fieldSel) fieldSel.innerHTML = customFieldOptionsHtml();
        if (opSel)    opSel.innerHTML    = customOperatorOptionsHtml();
        if (fieldSel) fieldSel.addEventListener('change', () => {
            updateCustomFieldAffix();
            if (typeof updateChalPreview === 'function') updateChalPreview();
        });
        if (opSel) opSel.addEventListener('change', () => {
            if (typeof updateChalPreview === 'function') updateChalPreview();
        });
    })();

    // ── Extra (multi-)conditions on a single challenge ──────────────────────
    const MAX_EXTRA_CONDITIONS = 3; // + 1 primary = 4 conditions total
    let chalExtraCondSeq = 0;

    function extraConditionOptionsHtml() {
        return '' +
            '<optgroup label="🏦 Banking">' +
                '<option value="first_transfer">First bank transfer</option>' +
                '<option value="transfer_amount">Single transfer ≥ ƒ amount</option>' +
                '<option value="total_transferred">Total transferred ≥ ƒ amount</option>' +
                '<option value="transaction_count">Total transfers ≥ N</option>' +
                '<option value="checking_balance">Checking balance ≥ ƒ amount</option>' +
                '<option value="savings_balance">Savings balance ≥ ƒ amount</option>' +
                '<option value="unique_recipients">Transferred to ≥ N unique recipients</option>' +
                '<option value="first_savings_transfer">First transfer from Savings</option>' +
                '<option value="savings_transfer_count">Transfers from Savings ≥ N</option>' +
            '</optgroup>' +
            '<optgroup label="🛒 Ecommerce">' +
                '<option value="first_purchase">First ecommerce purchase</option>' +
                '<option value="purchase_items">Single checkout ≥ N items</option>' +
                '<option value="total_spent_ecom">Total ecommerce spend ≥ ƒ amount</option>' +
                '<option value="purchase_count">Total orders placed ≥ N</option>' +
            '</optgroup>' +
            '<optgroup label="⚡ Utilities">' +
                '<option value="first_payment">First utility bill payment</option>' +
                '<option value="payment_count">Total bills paid ≥ N</option>' +
                '<option value="payment_amount">Single bill payment ≥ ƒ amount</option>' +
                '<option value="total_paid_bills">Total bills paid ≥ ƒ amount</option>' +
            '</optgroup>' +
            '<optgroup label="⭐ Cross-Category">' +
                '<option value="reach_level">Reach level ≥ N</option>' +
                '<option value="total_xp_earned">Total XP earned ≥ N</option>' +
                '<option value="florin_balance">Florin wallet balance ≥ ƒ amount</option>' +
            '</optgroup>' +
            '<optgroup label="🛠 Custom">' +
                '<option value="custom">Custom condition…</option>' +
            '</optgroup>';
    }

    function getExtraConditionRows() {
        const list = document.getElementById('chal-extra-conditions-list');
        return list ? Array.from(list.querySelectorAll('.chal-extra-cond-row')) : [];
    }

    function renumberExtraConditionRows() {
        getExtraConditionRows().forEach((row, i) => {
            const numEl = row.querySelector('.chal-extra-cond-num');
            if (numEl) numEl.textContent = 'Condition #' + (i + 2); // primary condition is #1
        });
    }

    function updateAddCondButtonState() {
        const btn = document.getElementById('chal-add-cond-btn');
        const logicRow = document.getElementById('chal-cond-logic-row');
        if (!btn) return;
        const count = getExtraConditionRows().length;
        const atMax = count >= MAX_EXTRA_CONDITIONS;
        btn.disabled   = atMax;
        btn.textContent = atMax
            ? '➕ Add Another Condition (max ' + (MAX_EXTRA_CONDITIONS + 1) + ' reached)'
            : '➕ Add Another Condition';
        if (logicRow) logicRow.style.display = count > 0 ? '' : 'none';
    }

    window.addExtraConditionRow = function (initial) {
        const list = document.getElementById('chal-extra-conditions-list');
        if (!list || getExtraConditionRows().length >= MAX_EXTRA_CONDITIONS) return;

        const row = document.createElement('div');
        row.className = 'chal-extra-cond-row';
        row.dataset.key = 'ec' + (chalExtraCondSeq++);
        row.innerHTML =
            '<div class="chal-extra-cond-header">' +
                '<span class="chal-extra-cond-num">Condition</span>' +
                '<button type="button" class="chal-extra-remove" title="Remove condition" onclick="removeExtraConditionRow(this)">✕</button>' +
            '</div>' +
            '<select class="chal-extra-cond-select">' + extraConditionOptionsHtml() + '</select>' +
            '<div class="chal-extra-custom-wrap" style="display:none;margin-bottom:var(--space-2)">' +
                '<div class="admin-form-grid" style="grid-template-columns:1fr 1fr;gap:var(--space-2)">' +
                    '<select class="chal-extra-custom-field">' + customFieldOptionsHtml() + '</select>' +
                    '<select class="chal-extra-custom-operator">' + customOperatorOptionsHtml() + '</select>' +
                '</div>' +
            '</div>' +
            '<div class="chal-extra-cond-val-wrap admin-form-group" style="display:none;margin-bottom:0">' +
                '<label class="chal-extra-cond-val-label" style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:4px;display:block">Threshold Value</label>' +
                '<div class="chal-input-group">' +
                    '<span class="chal-input-affix chal-extra-prefix" style="display:none">ƒ</span>' +
                    '<input type="number" class="chal-extra-cond-input" min="0" step="any" placeholder="0">' +
                    '<span class="chal-input-affix chal-extra-suffix" style="display:none">items</span>' +
                '</div>' +
            '</div>';
        list.appendChild(row);

        const select     = row.querySelector('.chal-extra-cond-select');
        const customWrap = row.querySelector('.chal-extra-custom-wrap');
        const customField = row.querySelector('.chal-extra-custom-field');
        const customOp     = row.querySelector('.chal-extra-custom-operator');
        const valWrap  = row.querySelector('.chal-extra-cond-val-wrap');
        const labelEl  = row.querySelector('.chal-extra-cond-val-label');
        const prefixEl = row.querySelector('.chal-extra-prefix');
        const suffixEl = row.querySelector('.chal-extra-suffix');
        const input    = row.querySelector('.chal-extra-cond-input');

        const applyRow = () => {
            applyCondMetaToFields(select.value, { groupEl: valWrap, labelEl, prefixEl, suffixEl, input });
            const isCustom = select.value === 'custom';
            customWrap.style.display = isCustom ? '' : 'none';
            if (isCustom) {
                const fMeta = CUSTOM_FIELD_MAP[customField.value];
                prefixEl.style.display = fMeta && fMeta.currency ? '' : 'none';
                prefixEl.textContent   = fMeta && fMeta.currency ? 'ƒ' : '';
            }
            if (typeof updateChalPreview === 'function') updateChalPreview();
        };
        select.addEventListener('change', applyRow);
        customField.addEventListener('change', applyRow);
        customOp.addEventListener('change', () => { if (typeof updateChalPreview === 'function') updateChalPreview(); });
        input.addEventListener('input', () => { if (typeof updateChalPreview === 'function') updateChalPreview(); });

        if (initial && initial.condition) select.value = initial.condition;
        if (initial && initial.condition === 'custom') {
            if (initial.customField)    customField.value = initial.customField;
            if (initial.customOperator) customOp.value    = initial.customOperator;
        }
        applyRow();
        if (initial && initial.conditionValue != null) input.value = initial.conditionValue;

        renumberExtraConditionRows();
        updateAddCondButtonState();
        if (typeof updateChalPreview === 'function') updateChalPreview();
    };

    window.removeExtraConditionRow = function (btn) {
        const row = btn.closest('.chal-extra-cond-row');
        if (row) row.remove();
        renumberExtraConditionRows();
        updateAddCondButtonState();
        if (typeof updateChalPreview === 'function') updateChalPreview();
    };

    function clearExtraConditions() {
        const list = document.getElementById('chal-extra-conditions-list');
        if (list) list.innerHTML = '';
        setChalCondLogicValue('all');
        updateAddCondButtonState();
    }

    window.setChalCondLogic = function (btn) {
        document.querySelectorAll('.chal-logic-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        if (typeof updateChalPreview === 'function') updateChalPreview();
    };

    function setChalCondLogicValue(logic) {
        document.querySelectorAll('.chal-logic-pill').forEach(p => p.classList.toggle('active', p.dataset.logic === logic));
    }

    function getChalCondLogic() {
        const active = document.querySelector('.chal-logic-pill.active');
        return active ? active.dataset.logic : 'all';
    }

    function getExtraConditionsData() {
        return getExtraConditionRows().map(row => {
            const select = row.querySelector('.chal-extra-cond-select');
            const input  = row.querySelector('.chal-extra-cond-input');
            const data = {
                condition:      select.value,
                conditionValue: COND_NEEDS_VALUE.has(select.value) ? (parseFloat(input.value) || 0) : null
            };
            if (select.value === 'custom') {
                data.customField    = row.querySelector('.chal-extra-custom-field').value;
                data.customOperator = row.querySelector('.chal-extra-custom-operator').value;
            }
            return data;
        });
    }

    let chalTable;
    let chalEditingId = null;  // null = create mode, number = edit mode
    var mgmtUserId = null;     // currently open user in the management drawer

    function loadChallengesPage() {
        if (!chalTable) {
            chalTable = makeSortableTable({
                tableId: 'chalMainTable', tbodyId: 'chal-table-body',
                searchId: 'chal-search',  infoId: 'chal-page-info',
                prevId: 'chal-prev',      nextId: 'chal-next',
                searchFields: ['title', 'description', 'category'],
                cols: 8,
                rowFn: (c, i) => {
                    const catPill    = CAT_PILL[c.category]   || 'pill-purple';
                    const catLabel   = CAT_LABELS[c.category] || c.category;
                    const active     = c.active !== false;
                    const done       = c.completed === true;
                    const completedDate = done && c.completedAt
                        ? new Date(c.completedAt).toLocaleDateString()
                        : null;
                    const progressCell = done
                        ? '<span class="pill pill-green">✅ Completed' + (completedDate ? '<br><span style="font-size:0.7em;font-weight:400">' + completedDate + '</span>' : '') + '</span>'
                        : (c.condition === 'manual'
                            ? '<span class="pill" style="background:#f1f5f9;color:#64748b">Manual</span>'
                            : '<span class="pill pill-amber">⏳ Pending</span>');
                    const markBtn = done
                        ? '<button class="btn" style="padding:3px 8px;font-size:var(--text-xs);margin-right:2px" onclick="adminResetChallenge(' + c.id + ')" title="Reset completion">↺</button>'
                        : (c.condition === 'manual'
                            ? '<button class="btn" style="padding:3px 8px;font-size:var(--text-xs);margin-right:2px;color:#10b981" onclick="adminMarkComplete(' + c.id + ')" title="Mark complete">✓</button>'
                            : '');
                    return '<tr' + (done ? ' style="opacity:0.7"' : '') + '>' +
                        '<td style="color:var(--color-text-muted)">' + (i + 1) + '</td>' +
                        '<td style="max-width:180px"><strong>' + escHtml(c.title) + '</strong>' +
                            '<div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px">' + escHtml(c.description) + '</div></td>' +
                        '<td><span class="pill ' + catPill + '">' + catLabel + '</span></td>' +
                        '<td><span class="pill pill-green">+' + (c.points || 0) + ' XP</span></td>' +
                        '<td>' + (c.florins ? 'ƒ' + Number(c.florins).toFixed(2) : '<span style="color:var(--color-text-muted)">Free</span>') + '</td>' +
                        '<td style="font-size:var(--text-xs);color:var(--color-text-muted);cursor:help" title="' + escHtml(condFullSummary(c)) + '">' + escHtml(condLabel(c)) + '</td>' +
                        '<td>' + progressCell + '</td>' +
                        '<td style="white-space:nowrap">' +
                            markBtn +
                            '<button class="btn" style="padding:3px 8px;font-size:var(--text-xs);margin-right:2px" ' +
                                'onclick="adminEditChallenge(' + c.id + ')">✏️</button>' +
                            '<button class="btn" style="padding:3px 8px;font-size:var(--text-xs);margin-right:2px" ' +
                                'onclick="adminDuplicateChallenge(' + c.id + ')" title="Duplicate">⧉</button>' +
                            '<button class="btn btn-danger" style="padding:3px 8px;font-size:var(--text-xs)" ' +
                                'onclick="adminDeleteChallenge(' + c.id + ')">🗑</button>' +
                        '</td>' +
                        '</tr>';
                }
            });

            // Category filter
            document.getElementById('chal-filter-cat').addEventListener('change', function () {
                chalCategoryFilter = this.value;
                reloadChallengesTable();
            });
            // Status filter
            document.getElementById('chal-filter-status').addEventListener('change', function () {
                chalStatusFilter = this.value;
                reloadChallengesTable();
            });
            // Completed filter
            document.getElementById('chal-filter-completed').addEventListener('change', function () {
                chalCompletedFilter = this.value;
                reloadChallengesTable();
            });

            // Condition selector — sync threshold field + auto-suggest category.
            // Runs after the generic preview listener (registered earlier at
            // script load), so it re-runs updateChalPreview once more here to
            // pick up any category the auto-suggest just changed.
            document.getElementById('chal-condition').addEventListener('change', function () {
                syncConditionUI(this.value, { suggestCategory: true, userTriggered: true });
                if (typeof updateChalPreview === 'function') updateChalPreview();
            });
        }
        reloadChallengesTable();
    }

    let chalCategoryFilter  = '';
    let chalStatusFilter    = '';
    let chalCompletedFilter = '';

    function reloadChallengesTable() {
        DigifinwizDB.getChallenges().then(list => {
            let filtered = list;
            if (chalCategoryFilter) filtered = filtered.filter(c => c.category === chalCategoryFilter);
            if (chalStatusFilter !== '') {
                const wantActive = chalStatusFilter === 'true';
                filtered = filtered.filter(c => (c.active !== false) === wantActive);
            }
            if (chalCompletedFilter !== '') {
                const wantDone = chalCompletedFilter === 'true';
                filtered = filtered.filter(c => (c.completed === true) === wantDone);
            }

            // Stats
            const completedCount = list.filter(c => c.completed === true).length;
            const active         = list.filter(c => c.active !== false && !c.completed).length;
            const inactive       = list.filter(c => c.active === false).length;
            const totalPts       = list.filter(c => !c.completed).reduce((s, c) => s + (c.points || 0), 0);
            setText('chal-total',      list.length);
            setText('chal-active',     active);
            setText('chal-inactive',   inactive + ' / ' + completedCount + ' completed');
            setText('chal-total-pts',  totalPts + ' remaining');
            setText('chal-count-badge', filtered.length);

            chalTable.load(filtered);
        }).catch(err => console.error('loadChallengesPage:', err));
    }

    // Expose actions globally so inline onclick works
    window.adminEditChallenge = function (id) {
        DigifinwizDB.getChallenges().then(list => {
            const c = list.find(ch => ch.id === id);
            if (!c) return;
            chalEditingId = id;
            setText('chal-form-title', 'Edit Challenge');
            setVal('chal-edit-id',    id);
            setVal('chal-title',      c.title);
            document.getElementById('chal-desc').value = c.description || '';
            setVal('chal-category',   c.category || 'general');
            setVal('chal-active',     c.active !== false ? 'true' : 'false');
            setVal('chal-points',     c.points || 0);
            setVal('chal-florins',    c.florins || 0);
            setVal('chal-condition',  c.condition || 'manual');
            clearExtraConditions();
            syncConditionUI(c.condition || 'manual');
            if (COND_NEEDS_VALUE.has(c.condition)) setVal('chal-condval', c.conditionValue || 0);
            if (c.condition === 'custom') {
                setVal('chal-custom-field',    c.customField    || 'txCount');
                setVal('chal-custom-operator', c.customOperator || 'gte');
                updateCustomFieldAffix();
            }
            if (c.condition !== 'manual') {
                (Array.isArray(c.extraConditions) ? c.extraConditions : []).forEach(ec => addExtraConditionRow(ec));
                setChalCondLogicValue(c.conditionLogic || 'all');
            }
            document.getElementById('chal-submit-btn').textContent = '💾 Save Changes';
            document.getElementById('chal-cancel-edit').style.display = '';
            if (typeof updateChalPreview === 'function') updateChalPreview();
            document.getElementById('chal-form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    };

    window.adminDuplicateChallenge = function (id) {
        DigifinwizDB.getChallenges().then(list => {
            const c = list.find(ch => ch.id === id);
            if (!c) return;
            const copy = {
                title:           c.title + ' (Copy)',
                description:     c.description || '',
                category:        c.category || 'general',
                active:          c.active !== false,
                points:          c.points || 0,
                florins:         c.florins || 0,
                condition:       c.condition || 'manual',
                conditionValue:  c.conditionValue !== undefined ? c.conditionValue : null,
                customField:     c.customField    || null,
                customOperator:  c.customOperator || null,
                extraConditions: Array.isArray(c.extraConditions) ? c.extraConditions.slice() : [],
                conditionLogic:  c.conditionLogic || 'all'
            };
            DigifinwizDB.addChallenge(copy)
                .then(() => { showToast('Challenge duplicated!', 'success'); reloadChallengesTable(); })
                .catch(() => showToast('Duplicate failed.', 'error'));
        });
    };

    window.adminDeleteChallenge = function (id) {
        if (!confirm('Delete this challenge? This cannot be undone.')) return;
        DigifinwizDB.deleteChallenge(id).then(() => {
            showToast('Challenge deleted.', 'info');
            if (chalEditingId === id) resetChallengeForm();
            reloadChallengesTable();
        }).catch(() => showToast('Delete failed.', 'error'));
    };

    window.adminMarkComplete = function (id) {
        DigifinwizDB.adminUpdateChallenge(id, { completed: true, completedAt: Date.now() })
            .then(() => { showToast('Challenge marked complete!', 'success'); reloadChallengesTable(); })
            .catch(() => showToast('Update failed.', 'error'));
    };

    window.adminResetChallenge = function (id) {
        if (!confirm('Reset this challenge back to incomplete?')) return;
        DigifinwizDB.adminUpdateChallenge(id, { completed: false, completedAt: null })
            .then(() => { showToast('Challenge reset.', 'info'); reloadChallengesTable(); })
            .catch(() => showToast('Reset failed.', 'error'));
    };

    window.adminReseedChallenges = function () {
        const btn = document.getElementById('reseedBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
        DigifinwizDB.reseedMissingChallenges().then(added => {
            if (added.length === 0) {
                showToast('All default challenges already exist — nothing to add.', 'info');
            } else {
                showToast('Added ' + added.length + ' missing challenge(s)!', 'success');
                reloadChallengesTable();
            }
            if (btn) { btn.disabled = false; btn.textContent = '➕ Add Missing Default Challenges'; }
        }).catch(() => {
            showToast('Re-seed failed. Try again.', 'error');
            if (btn) { btn.disabled = false; btn.textContent = '➕ Add Missing Default Challenges'; }
        });
    };

    window.adminResetAllChallenges = function () {
        if (!confirm('This will DELETE all challenges and re-seed the 24 default ones from scratch.\n\nAll completed state will be lost. Continue?')) return;
        DigifinwizDB.clearStore('challenges').then(() => {
            return DigifinwizDB.seedDefaultChallenges();
        }).then(() => {
            showToast('All challenges reset and re-seeded successfully!', 'success');
            reloadChallengesTable();
        }).catch(() => showToast('Reset failed. Try again.', 'error'));
    };

    function resetChallengeForm() {
        chalEditingId = null;
        setText('chal-form-title', 'Create Challenge');
        document.getElementById('challengeForm').reset();
        setVal('chal-edit-id', '');
        syncConditionUI('manual');
        document.getElementById('chal-submit-btn').textContent = '➕ Create Challenge';
        document.getElementById('chal-cancel-edit').style.display = 'none';
        if (typeof updateChalPreview === 'function') updateChalPreview();
    }

    document.getElementById('chal-cancel-edit').addEventListener('click', resetChallengeForm);

    // ── Create Challenge upgrades: templates, preview, counters ─────────────
    const CHAL_TEMPLATES = [
        { icon: '🏦', name: 'Transfer Pro',  title: 'Transfer Pro',       description: 'Send a single transfer of ƒ250 or more to any recipient.',              category: 'banking',   points: 75,  florins: 0, condition: 'transfer_amount',   conditionValue: 250 },
        { icon: '💸', name: 'Big Mover',     title: 'Big Mover',          description: 'Transfer a cumulative total of ƒ1,000 across all your transfers.',      category: 'banking',   points: 150, florins: 0, condition: 'total_transferred', conditionValue: 1000 },
        { icon: '🛒', name: 'Cart Filler',   title: 'Cart Filler',        description: 'Check out with 3 or more items in a single ecommerce order.',           category: 'ecommerce', points: 75,  florins: 0, condition: 'purchase_items',    conditionValue: 3 },
        { icon: '🛍️', name: 'Super Shopper', title: 'Super Shopper',      description: 'Spend a total of ƒ500 in the ecommerce store.',                         category: 'ecommerce', points: 150, florins: 0, condition: 'total_spent_ecom',  conditionValue: 500 },
        { icon: '⚡', name: 'Bill Streak',   title: 'Bill Streak',        description: 'Pay 5 utility bills to build a reliable payment habit.',                category: 'utilities', points: 100, florins: 0, condition: 'payment_count',     conditionValue: 5 },
        { icon: '⭐', name: 'Level Up',      title: 'Reach Level 3',      description: 'Keep earning XP across the platform until you reach level 3.',          category: 'general',   points: 150, florins: 0, condition: 'reach_level',       conditionValue: 3 }
    ];

    // Render template chips
    (function renderChalTemplates() {
        const row = document.getElementById('chal-template-row');
        if (!row) return;
        row.innerHTML = CHAL_TEMPLATES.map((t, i) =>
            '<button type="button" class="chal-template-chip" onclick="applyChalTemplate(' + i + ')">' + t.icon + ' ' + escHtml(t.name) + '</button>'
        ).join('');
    })();

    window.applyChalTemplate = function (i) {
        const t = CHAL_TEMPLATES[i];
        if (!t) return;
        setVal('chal-title',     t.title);
        document.getElementById('chal-desc').value = t.description;
        setVal('chal-category',  t.category);
        setVal('chal-active',    'true');
        setVal('chal-points',    t.points);
        setVal('chal-florins',   t.florins);
        setVal('chal-condition', t.condition);
        clearExtraConditions();
        syncConditionUI(t.condition);
        if (COND_NEEDS_VALUE.has(t.condition)) setVal('chal-condval', t.conditionValue);
        updateChalPreview();
        document.getElementById('chal-title').focus();
    };

    window.setChalDifficulty = function (btn) {
        setVal('chal-points', btn.dataset.xp);
        document.querySelectorAll('.chal-diff-pill').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        updateChalPreview();
    };

    function updateChalCounters() {
        const wire = (inputId, countId, max) => {
            const input = document.getElementById(inputId);
            const count = document.getElementById(countId);
            if (!input || !count) return;
            const len = input.value.length;
            count.textContent = len + ' / ' + max;
            count.classList.toggle('near-limit', len >= max * 0.85 && len < max);
            count.classList.toggle('at-limit',   len >= max);
        };
        wire('chal-title', 'chal-title-count', 80);
        wire('chal-desc',  'chal-desc-count',  300);
    }

    function updateChalPreview() {
        const title    = getVal('chal-title').trim();
        const desc     = document.getElementById('chal-desc').value.trim();
        const category = getVal('chal-category') || 'general';
        const active   = getVal('chal-active') !== 'false';
        const points   = parseInt(getVal('chal-points'))    || 0;
        const florins  = parseFloat(getVal('chal-florins')) || 0;
        const cond     = getVal('chal-condition') || 'manual';
        const condVal  = parseFloat(getVal('chal-condval')) || 0;

        const catEl = document.getElementById('chal-preview-cat');
        catEl.textContent = CAT_LABELS[category] || category;
        catEl.className = 'pill ' + (CAT_PILL[category] || 'pill-purple');

        const statusEl = document.getElementById('chal-preview-status');
        statusEl.textContent = active ? 'Active' : 'Inactive';
        statusEl.style.background = active ? '#f0fdf4' : '#f1f5f9';
        statusEl.style.color      = active ? '#059669' : '#64748b';

        setText('chal-preview-title', title || 'Challenge title…');
        setText('chal-preview-desc',  desc  || 'Challenge description will appear here as you type.');
        setText('chal-preview-xp',    '+' + points + ' XP');

        const florEl = document.getElementById('chal-preview-florins');
        florEl.style.display = florins > 0 ? '' : 'none';
        if (florins > 0) florEl.textContent = '-ƒ' + florins.toFixed(2);

        const chalForSummary = {
            condition:       cond,
            conditionValue:  condVal,
            customField:     cond === 'custom' ? getVal('chal-custom-field')    : null,
            customOperator:  cond === 'custom' ? getVal('chal-custom-operator') : null,
            extraConditions: getExtraConditionsData(),
            conditionLogic:  getChalCondLogic()
        };
        setText('chal-preview-cond', condLabel(chalForSummary));
        setText('chal-cond-summary', condFullSummary(chalForSummary));

        // Sync difficulty pill highlight with current XP value
        document.querySelectorAll('.chal-diff-pill').forEach(p =>
            p.classList.toggle('active', parseInt(p.dataset.xp) === points));

        updateChalCounters();
    }

    // Wire live preview to every form field
    ['chal-title', 'chal-desc', 'chal-points', 'chal-florins', 'chal-condval'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', updateChalPreview);
    });
    ['chal-category', 'chal-active', 'chal-condition'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', updateChalPreview);
    });
    syncConditionUI(getVal('chal-condition') || 'manual');
    updateChalPreview();

    document.getElementById('challengeForm').addEventListener('submit', function (e) {
        e.preventDefault();
        const title          = getVal('chal-title').trim();
        const desc           = document.getElementById('chal-desc').value.trim();
        const category       = getVal('chal-category') || 'general';
        const active         = getVal('chal-active') !== 'false';
        const points         = parseInt(getVal('chal-points'))    || 0;
        const florins        = parseFloat(getVal('chal-florins')) || 0;
        const condition      = getVal('chal-condition') || 'manual';
        const conditionValue = COND_NEEDS_VALUE.has(condition) ? (parseFloat(getVal('chal-condval')) || 0) : null;
        const customField    = condition === 'custom' ? getVal('chal-custom-field')    : null;
        const customOperator = condition === 'custom' ? getVal('chal-custom-operator') : null;
        // Manual challenges can't combine with automatic extra conditions.
        const extraConditions = condition !== 'manual' ? getExtraConditionsData() : [];
        const conditionLogic  = condition !== 'manual' ? getChalCondLogic()       : 'all';

        if (!title) { showToast('Title is required.', 'error'); return; }
        if (!desc)  { showToast('Description is required.', 'error'); return; }

        const payload = { title, description: desc, category, active, points, florins, condition, conditionValue, customField, customOperator, extraConditions, conditionLogic };

        if (chalEditingId !== null) {
            DigifinwizDB.adminUpdateChallenge(chalEditingId, payload)
                .then(() => { showToast('Challenge updated!', 'success'); resetChallengeForm(); reloadChallengesTable(); })
                .catch(() => showToast('Update failed.', 'error'));
        } else {
            DigifinwizDB.addChallenge(payload)
                .then(() => { showToast('Challenge created!', 'success'); resetChallengeForm(); reloadChallengesTable(); })
                .catch(() => showToast('Create failed.', 'error'));
        }
    });

    // ── USERS PAGE ───────────────────────────────────────────────────────────
    const STATUS_PILL = { pending: 'pill-amber', approved: 'pill-green', rejected: 'pill-red' };
    const ROLE_PILL   = { admin: 'pill-purple', participant: 'pill-blue' };

    function fmtDate(ts) {
        if (!ts) return '—';
        return new Date(ts).toLocaleDateString();
    }

    function loadUsersPage() {
        DigifinwizDB.getAllUsers().then(function(users) {
            const session   = DigifinwizAuth.getSession();
            const total     = users.length;
            const pending   = users.filter(function(u){ return u.status === 'pending'; });
            const approved  = users.filter(function(u){ return u.status === 'approved'; }).length;
            const rejected  = users.filter(function(u){ return u.status === 'rejected'; }).length;

            setText('users-total',    total);
            setText('users-pending',  pending.length);
            setText('users-approved', approved);
            setText('users-rejected', rejected);
            setText('users-count-badge',   total);
            setText('pending-count-badge', pending.length);

            // Update sidebar pending badge
            var pendingBadge = document.getElementById('pendingBadge');
            if (pendingBadge) {
                pendingBadge.textContent = pending.length;
                pendingBadge.style.display = pending.length > 0 ? '' : 'none';
            }

            renderPendingTable(pending, session);
            renderUsersTable(users, session);

            // Wire search + filter
            var searchInput = document.getElementById('users-search');
            var filterStatus = document.getElementById('users-filter-status');
            var filterRole   = document.getElementById('users-filter-role');

            function applyFilters() {
                var q      = (searchInput ? searchInput.value.toLowerCase() : '');
                var status = filterStatus ? filterStatus.value : '';
                var role   = filterRole   ? filterRole.value   : '';
                var filtered = users.filter(function(u) {
                    var matchQ = !q ||
                        (u.fullName  || '').toLowerCase().includes(q) ||
                        (u.username  || '').toLowerCase().includes(q) ||
                        (u.email     || '').toLowerCase().includes(q);
                    var matchStatus = !status || u.status === status;
                    var matchRole   = !role   || u.role   === role;
                    return matchQ && matchStatus && matchRole;
                });
                renderUsersTable(filtered, session);
            }

            if (searchInput)  searchInput .addEventListener('input',  applyFilters);
            if (filterStatus) filterStatus.addEventListener('change', applyFilters);
            if (filterRole)   filterRole  .addEventListener('change', applyFilters);

        }).catch(function(err){ console.error('loadUsersPage:', err); });
    }

    function renderPendingTable(pending, session) {
        var tbody = document.getElementById('pending-table-body');
        if (!tbody) return;
        if (pending.length === 0) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No pending registrations. 🎉</td></tr>';
            return;
        }
        tbody.innerHTML = pending.map(function(u) {
            return '<tr>' +
                '<td><strong>' + escHtml(u.fullName || '—') + '</strong></td>' +
                '<td><span style="font-family:monospace">@' + escHtml(u.username) + '</span></td>' +
                '<td>' + escHtml(u.email || '—') + '</td>' +
                '<td>' + fmtDate(u.createdAt) + '</td>' +
                '<td style="white-space:nowrap">' +
                    '<button class="btn" style="padding:3px 10px;font-size:var(--text-xs);color:#10b981;border-color:#10b981;margin-right:4px" ' +
                        'onclick="adminApproveUser(' + u.id + ')">✓ Approve</button>' +
                    '<button class="btn btn-danger" style="padding:3px 10px;font-size:var(--text-xs)" ' +
                        'onclick="adminRejectUser(' + u.id + ', ' + JSON.stringify(u.username) + ')">✕ Reject</button>' +
                '</td>' +
                '</tr>';
        }).join('');
    }

    function renderUsersTable(users, session) {
        var tbody = document.getElementById('users-table-body');
        if (!tbody) return;
        if (users.length === 0) {
            tbody.innerHTML = '<tr class="empty-row"><td colspan="10">No users found.</td></tr>';
            return;
        }
        tbody.innerHTML = users.map(function(u, i) {
            var isMe   = session && session.userId === u.id;
            var ud     = u.userData || {};
            var lvl    = ud.level || 1;
            var pts    = ud.points || 0;
            var statusPill = STATUS_PILL[u.status] || 'pill-amber';
            var rolePill   = ROLE_PILL[u.role]     || 'pill-blue';

            var actions = '';
            if (u.status === 'pending') {
                actions += '<button class="btn" style="padding:2px 8px;font-size:var(--text-xs);color:#10b981;border-color:#10b981;margin-right:2px" ' +
                    'onclick="adminApproveUser(' + u.id + ')">✓</button>';
                actions += '<button class="btn btn-danger" style="padding:2px 8px;font-size:var(--text-xs);margin-right:2px" ' +
                    'onclick="adminRejectUser(' + u.id + ', ' + JSON.stringify(u.username) + ')">✕</button>';
            } else if (u.status === 'rejected') {
                actions += '<button class="btn" style="padding:2px 8px;font-size:var(--text-xs);color:#10b981;border-color:#10b981;margin-right:2px" ' +
                    'onclick="adminApproveUser(' + u.id + ')">↺ Approve</button>';
            }
            actions += '<button class="btn" style="padding:2px 8px;font-size:var(--text-xs);margin-right:2px;color:var(--color-primary-600);border-color:var(--color-primary-400)" ' +
                'onclick="adminManageUser(' + u.id + ')">⚙ Manage</button>';
            if (u.role === 'participant' && u.status === 'approved') {
                actions += '<button class="btn" style="padding:2px 8px;font-size:var(--text-xs);margin-right:2px;color:#0891b2;border-color:#67e8f9" ' +
                    'onclick="adminMessageUser(' + u.id + ')">✉️ Message</button>';
            }
            if (!isMe) {
                actions += '<button class="btn btn-danger" style="padding:2px 8px;font-size:var(--text-xs)" ' +
                    'onclick="adminDeleteUser(' + u.id + ', ' + JSON.stringify(u.username) + ')">🗑</button>';
            } else {
                actions += '<span style="font-size:var(--text-xs);color:var(--color-text-muted)">(you)</span>';
            }

            return '<tr>' +
                '<td style="color:var(--color-text-muted)">' + (i + 1) + '</td>' +
                '<td><strong>' + escHtml(u.fullName || '—') + '</strong></td>' +
                '<td><span style="font-family:monospace;font-size:var(--text-xs)">@' + escHtml(u.username) + '</span></td>' +
                '<td style="font-size:var(--text-xs);color:var(--color-text-muted)">' + escHtml(u.email || '—') + '</td>' +
                '<td><span class="pill ' + rolePill + '">' + escHtml(u.role) + '</span></td>' +
                '<td><span class="pill ' + statusPill + '">' + escHtml(u.status) + '</span></td>' +
                '<td>' + fmtDate(u.createdAt)  + '</td>' +
                '<td>' + fmtDate(u.lastLogin)  + '</td>' +
                '<td style="font-size:var(--text-xs)">Lv.' + lvl + ' / ' + pts.toLocaleString() + ' XP</td>' +
                '<td style="white-space:nowrap">' + actions + '</td>' +
                '</tr>';
        }).join('');
    }

    window.adminApproveUser = function(id) {
        DigifinwizDB.approveUser(id).then(function() {
            showToast('User approved! Challenges seeded.', 'success');
            // Notify the user their account has been approved
            DigifinwizDB.getUserById(id).then(function(user) {
                if (!user) return;
                DigifinwizDB.sendSystemMessage({
                    recipientId: id,
                    subject:     'Your account has been approved!',
                    body:        'Welcome to Digifinwiz, ' + (user.fullName || user.username) + '! Your account has been approved. You can now log in and start your financial literacy journey.',
                    type:        'announcement'
                }).catch(function(){});
            }).catch(function(){});
            loadUsersPage();
        }).catch(function(err){ console.error(err); showToast('Approve failed.', 'error'); });
    };

    window.adminRejectUser = function(id, username) {
        if (!confirm('Reject registration for @' + username + '?')) return;
        DigifinwizDB.rejectUser(id).then(function() {
            showToast('User rejected.', 'info');
            // Notify the user their registration was not approved
            DigifinwizDB.sendSystemMessage({
                recipientId: id,
                subject:     'Registration not approved',
                body:        'Unfortunately, your registration for @' + username + ' has not been approved. Please contact your administrator for more information.',
                type:        'warning'
            }).catch(function(){});
            loadUsersPage();
        }).catch(function(err){ console.error(err); showToast('Reject failed.', 'error'); });
    };

    window.adminDeleteUser = function(id, username) {
        if (!confirm('Permanently delete user @' + username + ' and all their data?\n\nThis cannot be undone.')) return;
        DigifinwizDB.deleteUser(id).then(function() {
            showToast('User deleted.', 'info');
            loadUsersPage();
        }).catch(function(err){ console.error(err); showToast('Delete failed.', 'error'); });
    };

    window.adminMessageUser = function(id) {
        // Switch to the messaging section
        var msgBtn = document.querySelector('[data-page="messaging"]');
        if (msgBtn) msgBtn.click();
        // Pre-select the user in the recipient dropdown (after the page renders)
        setTimeout(function() {
            var select = document.getElementById('msg-recipient');
            if (select) {
                select.value = id;
                select.dispatchEvent(new Event('change'));
            }
            var composeForm = document.getElementById('msg-recipient');
            if (composeForm) composeForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 150);
    };

    // ── MESSAGING ────────────────────────────────────────────────────────────
    function loadMessagingPage() {
        DigifinwizDB.getAllUsers().then(function(users) {
            var select = document.getElementById('msg-recipient');
            if (!select) return;
            select.innerHTML = '<option value="all">📢 All Users (Broadcast)</option>';
            users.filter(function(u) { return u.role === 'participant' && u.status === 'approved'; })
                 .sort(function(a, b) { return (a.fullName || '').localeCompare(b.fullName || ''); })
                 .forEach(function(u) {
                     var opt = document.createElement('option');
                     opt.value = u.id;
                     opt.textContent = escHtml(u.fullName || u.username) + ' (@' + escHtml(u.username) + ')';
                     select.appendChild(opt);
                 });
        });
        reloadMsgTable();
    }

    function reloadMsgTable() {
        DigifinwizDB.getAllSentMessages().then(function(msgs) {
            var badge = document.getElementById('msg-count-badge');
            if (badge) badge.textContent = msgs.length;
            var tbody = document.getElementById('msg-table-body');
            if (!tbody) return;
            if (msgs.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--color-text-muted);padding:var(--space-6)">No messages sent yet.</td></tr>';
                return;
            }
            var TYPE_PILL  = { announcement: 'pill-purple', warning: 'pill-red', info: 'pill-blue' };
            var TYPE_LABEL = { announcement: '📣 Announcement', warning: '⚠️ Warning', info: 'ℹ️ Info' };
            tbody.innerHTML = msgs.map(function(m) {
                var pill      = TYPE_PILL[m.type]  || 'pill-blue';
                var label     = TYPE_LABEL[m.type] || m.type;
                var date      = new Date(m.sentAt).toLocaleString();
                var recipient = m.recipientId === 'all'
                    ? '<span class="pill pill-amber">All Users</span>'
                    : '<span class="pill pill-blue">User #' + escHtml(String(m.recipientId)) + '</span>';
                var readCount = (m.readBy || []).length;
                return '<tr>' +
                    '<td><span class="pill ' + pill + '">' + label + '</span></td>' +
                    '<td style="max-width:200px"><strong>' + escHtml(m.subject) + '</strong>' +
                        '<div style="font-size:var(--text-xs);color:var(--color-text-muted);overflow:hidden;' +
                        'text-overflow:ellipsis;white-space:nowrap;margin-top:2px;max-width:190px">' + escHtml(m.body) + '</div></td>' +
                    '<td>' + recipient + '</td>' +
                    '<td style="font-size:var(--text-xs);white-space:nowrap">' + escHtml(date) + '</td>' +
                    '<td style="text-align:center"><span class="pill ' + (readCount > 0 ? 'pill-green' : 'pill-amber') + '">' + readCount + ' read</span></td>' +
                    '<td><button class="btn btn-danger" style="padding:3px 8px;font-size:var(--text-xs)" ' +
                        'onclick="adminDeleteMessage(' + m.id + ')">Delete</button></td>' +
                    '</tr>';
            }).join('');
        }).catch(function(err) { console.error('reloadMsgTable:', err); });
    }

    // ── BILLS PAGE ───────────────────────────────────────────────────────────
    function loadBillsPage() {
        fetch((window.API_BASE_URL || '') + '/api/bills')
            .then(r => r.json())
            .then(bills => renderBillsAdmin(bills))
            .catch(() => renderBillsAdmin([]));
    }

    function renderBillsAdmin(bills) {
        const list  = document.getElementById('billsAdminList');
        const badge = document.getElementById('billCountBadge');
        if (badge) badge.textContent = bills.length;
        if (!list) return;
        if (bills.length === 0) {
            list.innerHTML = '<p style="color:var(--color-text-muted);font-size:var(--text-sm)">No bills yet. Add one above.</p>';
            return;
        }
        list.innerHTML = bills.map(b => `
            <div style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-4);border-bottom:1px solid var(--color-border)">
                <div style="width:40px;height:40px;border-radius:10px;background:${escHtml(b.gradient)};display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0">${escHtml(b.icon || '🧾')}</div>
                <div style="flex:1;min-width:0">
                    <div style="font-weight:600;font-size:var(--text-sm)">${escHtml(b.name)}</div>
                    <div style="font-size:var(--text-xs);color:var(--color-text-muted)">Acct: ${escHtml(b.accountNumber || '—')} &nbsp;·&nbsp; Due: ${escHtml(b.dueDate || '—')}</div>
                </div>
                <div style="font-weight:700;color:var(--color-primary-600);margin-right:var(--space-3)">ƒ${Number(b.amount).toFixed(2)}</div>
                <button class="btn" style="padding:4px 10px;font-size:var(--text-xs)" onclick="editBill(${b.id})">Edit</button>
                <button class="btn" style="padding:4px 10px;font-size:var(--text-xs);color:#ef4444;border-color:#ef4444" onclick="deleteBill(${b.id})">Delete</button>
            </div>`).join('');
    }

    // Expose to inline onclick handlers
    window.editBill = function(id) {
        fetch((window.API_BASE_URL || '') + '/api/bills')
            .then(r => r.json())
            .then(bills => {
                const b = bills.find(x => x.id === id);
                if (!b) return;
                document.getElementById('billEditId').value       = b.id;
                document.getElementById('billName').value         = b.name;
                document.getElementById('billIcon').value         = b.icon || '';
                document.getElementById('billAmount').value       = b.amount;
                document.getElementById('billAccountNumber').value = b.accountNumber || '';
                document.getElementById('billGradient').value     = b.gradient || '';
                document.getElementById('billDueDate').value      = b.dueDate || '';
                document.getElementById('billFormTitle').textContent = 'Edit Bill';
                document.getElementById('billSubmitBtn').textContent = 'Save Changes';
                document.getElementById('billCancelBtn').style.display = '';
                document.getElementById('billForm').scrollIntoView({ behavior: 'smooth' });
            });
    };

    window.deleteBill = function(id) {
        if (!confirm('Delete this bill?')) return;
        const s = DigifinwizAuth.getSession();
        fetch((window.API_BASE_URL || '') + '/api/bills/' + id, {
            method: 'DELETE',
            headers: { 'X-User-Id': String(s.userId), 'X-User-Role': s.role }
        }).then(() => { showToast('Bill deleted.', 'info'); loadBillsPage(); })
          .catch(() => showToast('Delete failed.', 'error'));
    };

    window.cancelBillEdit = function() {
        document.getElementById('billEditId').value = '';
        document.getElementById('billForm').reset();
        document.getElementById('billFormTitle').textContent   = 'Add New Bill';
        document.getElementById('billSubmitBtn').textContent   = 'Add Bill';
        document.getElementById('billCancelBtn').style.display = 'none';
    };

    document.getElementById('billForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const s      = DigifinwizAuth.getSession();
        const editId = document.getElementById('billEditId').value;
        const payload = {
            name:          document.getElementById('billName').value.trim(),
            icon:          document.getElementById('billIcon').value.trim() || '🧾',
            amount:        parseFloat(document.getElementById('billAmount').value) || 0,
            accountNumber: document.getElementById('billAccountNumber').value.trim(),
            gradient:      document.getElementById('billGradient').value,
            dueDate:       document.getElementById('billDueDate').value.trim(),
            active:        true
        };
        const url    = (window.API_BASE_URL || '') + (editId ? '/api/bills/' + editId : '/api/bills');
        const method = editId ? 'PUT' : 'POST';
        fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json', 'X-User-Id': String(s.userId), 'X-User-Role': s.role },
            body: JSON.stringify(payload)
        }).then(r => r.json()).then(() => {
            showToast(editId ? 'Bill updated!' : 'Bill added!', 'success');
            cancelBillEdit();
            loadBillsPage();
        }).catch(() => showToast('Save failed.', 'error'));
    });

    // ── SETTINGS PAGE ────────────────────────────────────────────────────────
    function loadSettingsPage() {
        Promise.all([
            DigifinwizDB.getUserData(),
            DigifinwizDB.getTransactions(1000),
            DigifinwizDB.getPayments(1000),
            DigifinwizDB.getPurchases(1000),
            DigifinwizDB.getAllBalances(),
            DigifinwizDB.getChallenges()
        ]).then(([user, txs, pays, purchs, bals, challenges]) => {
            const total = (user ? 1 : 0) + txs.length + pays.length + purchs.length + challenges.length;
            setText('settings-record-count',         total);
            setText('store-count-userData',          user ? 1 : 0);
            setText('store-count-transactions',      txs.length);
            setText('store-count-payments',          pays.length);
            setText('store-count-purchaseHistory',   purchs.length);
            setText('store-count-challenges',        challenges.length);
            const checking = bals.find(b => b.account === 'checking');
            const savings  = bals.find(b => b.account === 'savings');
            setText('settings-checking', checking ? 'ƒ' + checking.amount.toLocaleString('en-US', {minimumFractionDigits:2}) : '—');
            setText('settings-savings',  savings  ? 'ƒ' + savings.amount.toLocaleString('en-US', {minimumFractionDigits:2}) : '—');
        }).catch(err => console.error('loadSettingsPage:', err));
    }

    // Balance editor
    document.getElementById('balanceEditForm') && document.getElementById('balanceEditForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const checking = parseFloat(getVal('edit-checking')) || 0;
        const savings  = parseFloat(getVal('edit-savings'))  || 0;
        Promise.all([
            DigifinwizDB.setBalance('checking', checking),
            DigifinwizDB.setBalance('savings', savings)
        ]).then(() => { showToast('Balances updated!', 'success'); loadSettingsPage(); })
          .catch(() => showToast('Update failed.', 'error'));
    });

    // ── Export ───────────────────────────────────────────────────────────────
    document.getElementById('exportBtn').addEventListener('click', function () {
        Promise.all([
            DigifinwizDB.getUserData(),
            DigifinwizDB.getTransactions(1000),
            DigifinwizDB.getPayments(1000),
            DigifinwizDB.getPurchases(1000),
            DigifinwizDB.getAllBalances(),
            DigifinwizDB.getChallenges()
        ]).then(([user, txs, pays, purchs, bals, challenges]) => {
            const exportData = {
                exportedAt: new Date().toISOString(),
                userData: user,
                balances: bals,
                transactions: txs,
                payments: pays,
                purchaseHistory: purchs,
                challenges: challenges
            };
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href = url;
            a.download = 'digifinwiz-export-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showToast('Export downloaded!', 'success');
        }).catch(() => showToast('Export failed.', 'error'));
    });

    // ── Import ───────────────────────────────────────────────────────────────
    document.getElementById('importFile') && document.getElementById('importFile').addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (ev) {
            let data;
            try { data = JSON.parse(ev.target.result); } catch (err) {
                showToast('Invalid JSON file.', 'error'); return;
            }
            if (!confirm('Import data? This will OVERWRITE all current data.')) { e.target.value = ''; return; }

            const promises = [];
            if (data.userData) promises.push(DigifinwizDB.setUserData(data.userData));
            if (Array.isArray(data.balances)) {
                data.balances.forEach(b => promises.push(DigifinwizDB.setBalance(b.account, b.amount)));
            }
            if (Array.isArray(data.transactions)) {
                promises.push(DigifinwizDB.clearStore('transactions').then(() =>
                    Promise.all(data.transactions.map(t => DigifinwizDB.addTransaction(t)))
                ));
            }
            if (Array.isArray(data.payments)) {
                promises.push(DigifinwizDB.clearStore('payments').then(() =>
                    Promise.all(data.payments.map(p => DigifinwizDB.addPayment(p)))
                ));
            }
            if (Array.isArray(data.purchaseHistory)) {
                promises.push(DigifinwizDB.clearStore('purchaseHistory').then(() =>
                    Promise.all(data.purchaseHistory.map(p => DigifinwizDB.addPurchase(p)))
                ));
            }
            if (Array.isArray(data.challenges)) {
                promises.push(DigifinwizDB.clearStore('challenges').then(() =>
                    Promise.all(data.challenges.map(c => { delete c.id; return DigifinwizDB.addChallenge(c); }))
                ));
            }
            Promise.all(promises)
                .then(() => { showToast('Import successful!', 'success'); loadSettingsPage(); })
                .catch(() => showToast('Import failed.', 'error'));
            e.target.value = '';
        };
        reader.readAsText(file);
    });

    // ── Danger Zone ──────────────────────────────────────────────────────────
    document.getElementById('clearTransactionsBtn').addEventListener('click', function () {
        if (!confirm('Delete ALL transactions?')) return;
        DigifinwizDB.clearStore('transactions').then(() => { showToast('Cleared.', 'info'); txTable = null; loadSettingsPage(); });
    });
    document.getElementById('clearPaymentsBtn').addEventListener('click', function () {
        if (!confirm('Delete ALL bill payments?')) return;
        DigifinwizDB.clearStore('payments').then(() => { showToast('Cleared.', 'info'); payTable = null; loadSettingsPage(); });
    });
    document.getElementById('clearPurchasesBtn').addEventListener('click', function () {
        if (!confirm('Delete ALL purchases?')) return;
        DigifinwizDB.clearStore('purchaseHistory').then(() => { showToast('Cleared.', 'info'); purchTable = null; loadSettingsPage(); });
    });
    document.getElementById('resetAllBtn').addEventListener('click', function () {
        if (!confirm('RESET EVERYTHING? All data will be deleted.')) return;
        Promise.all([
            DigifinwizDB.clearStore('transactions'),
            DigifinwizDB.clearStore('payments'),
            DigifinwizDB.clearStore('purchaseHistory'),
            DigifinwizDB.clearStore('cart'),
            DigifinwizDB.clearStore('challenges').then(() => DigifinwizDB.seedDefaultChallenges()),
            DigifinwizDB.setBalance('checking', DigifinwizDB.DEFAULT_BALANCES.checking),
            DigifinwizDB.setBalance('savings',  DigifinwizDB.DEFAULT_BALANCES.savings),
            DigifinwizDB.setUserData({ level:13, points:1390, pointsToNextLevel:345, challenges:5, completedTasks:8 })
        ]).then(() => {
            txTable = null; payTable = null; purchTable = null; chalTable = null;
            showToast('Everything reset.', 'info');
            loadSettingsPage();
        });
    });

    // ── Helpers ───────────────────────────────────────────────────────────────
    function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
    function setVal(id, val)  { const el = document.getElementById(id); if (el) el.value = (val != null ? val : ''); }
    function getVal(id)       { const el = document.getElementById(id); return el ? el.value : ''; }
    function escHtml(str) {
        if (str == null) return '';
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function showToast(message, type) {
        const colors = { success:'#10b981', error:'#ef4444', info:'#3b82f6' };
        const toast = document.createElement('div');
        toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:' + (colors[type]||colors.info) +
            ';color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;z-index:9999;' +
            'box-shadow:0 4px 12px rgba(0,0,0,0.2);animation:fadeInUp 0.3s ease';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s';
            setTimeout(() => toast.remove(), 300);
        }, 2800);
    }

    // ── Messaging form ────────────────────────────────────────────────────────
    var msgForm = document.getElementById('msgComposeForm');
    if (msgForm) {
        msgForm.addEventListener('submit', function(e) {
            e.preventDefault();
            var raw         = document.getElementById('msg-recipient').value;
            var recipId     = raw === 'all' ? 'all' : parseInt(raw, 10);
            var type        = document.getElementById('msg-type').value;
            var senderEmail = (document.getElementById('msg-sender-email').value || '').trim();
            var subject     = document.getElementById('msg-subject').value.trim();
            var body        = document.getElementById('msg-body').value.trim();
            if (!subject) { showToast('Subject is required.', 'error'); return; }
            if (!body)    { showToast('Message body is required.', 'error'); return; }
            var btn = document.getElementById('msg-send-btn');
            if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
            DigifinwizDB.sendAdminMessage({ recipientId: recipId, type: type, senderEmail: senderEmail, subject: subject, body: body })
                .then(function() {
                    showToast('Message sent!', 'success');
                    msgForm.reset();
                    reloadMsgTable();
                })
                .catch(function(err) { showToast('Send failed: ' + err.message, 'error'); })
                .finally(function() {
                    if (btn) { btn.disabled = false; btn.textContent = '✉️ Send Message'; }
                });
        });
    }

    window.adminDeleteMessage = function(id) {
        if (!confirm('Delete this message? Recipients will no longer see it.')) return;
        DigifinwizDB.deleteAdminMessage(id)
            .then(function() { showToast('Message deleted.', 'info'); reloadMsgTable(); })
            .catch(function() { showToast('Delete failed.', 'error'); });
    };

    // ── Per-user Management Drawer ────────────────────────────────────────────
    window.adminManageUser = function(id) {
        mgmtUserId = id;
        DigifinwizDB.getUserById(id).then(function(user) {
            if (!user) { showToast('User not found.', 'error'); return; }
            var titleEl    = document.getElementById('mgmtDrawerTitle');
            var subtitleEl = document.getElementById('mgmtDrawerSubtitle');
            if (titleEl)    titleEl.textContent    = user.fullName || user.username;
            if (subtitleEl) subtitleEl.textContent = '@' + user.username + ' · ' + user.role;

            var ud = user.userData || {};
            setMgmtVal('mgmt-level',   ud.level   !== undefined ? ud.level   : 1);
            setMgmtVal('mgmt-points',  ud.points  !== undefined ? ud.points  : 0);
            setMgmtVal('mgmt-ptsnext', ud.pointsToNextLevel !== undefined ? ud.pointsToNextLevel : 1000);
            setMgmtVal('mgmt-tasks',   ud.completedTasks !== undefined ? ud.completedTasks : 0);

            var bal = user.balances || {};
            setMgmtVal('mgmt-checking', (bal.checking !== undefined ? bal.checking : 0).toFixed(2));
            setMgmtVal('mgmt-savings',  (bal.savings  !== undefined ? bal.savings  : 0).toFixed(2));

            switchMgmtTab('xp');
            document.getElementById('userMgmtDrawer').classList.add('open');
            loadMgmtChallenges(id);
        }).catch(function(err) { console.error(err); showToast('Could not load user.', 'error'); });
    };

    window.closeUserMgmt = function() {
        document.getElementById('userMgmtDrawer').classList.remove('open');
        mgmtUserId = null;
    };

    window.switchMgmtTab = function(tab) {
        document.querySelectorAll('.mgmt-tab').forEach(function(btn) {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        document.querySelectorAll('.mgmt-tab-panel').forEach(function(panel) {
            panel.classList.toggle('active', panel.id === 'mgmt-panel-' + tab);
        });
    };

    function setMgmtVal(id, val) {
        var el = document.getElementById(id);
        if (el) el.value = val;
    }

    function loadMgmtChallenges(userId) {
        var container = document.getElementById('mgmt-challenges-list');
        if (!container) return;
        container.innerHTML = '<p style="color:var(--color-text-muted)">Loading…</p>';
        DigifinwizDB.getChallengesForUser(userId).then(function(challenges) {
            if (challenges.length === 0) {
                container.innerHTML = '<p style="color:var(--color-text-muted)">No challenges for this user.</p>';
                return;
            }
            var CAT_ICON = { banking: '🏦', ecommerce: '🛒', utilities: '⚡', general: '🎯' };
            container.innerHTML = challenges.map(function(c) {
                var icon      = CAT_ICON[c.category] || '🎯';
                var completed = c.completed;
                return '<div class="mgmt-challenge-row' + (completed ? ' mgmt-chal-done' : '') + '">' +
                    '<div class="mgmt-chal-info">' +
                        '<span class="mgmt-chal-icon">' + icon + '</span>' +
                        '<div style="min-width:0">' +
                            '<div class="mgmt-chal-title">' + escHtml(c.title) + '</div>' +
                            '<div class="mgmt-chal-meta">' +
                                '<span class="pill ' + (completed ? 'pill-green' : 'pill-amber') +
                                '" style="font-size:0.65rem">' + (completed ? '✓ Done' : 'Incomplete') + '</span> ' +
                                '<span style="font-size:var(--text-xs);color:var(--color-text-muted)">+' + (c.points || 0) + ' XP</span>' +
                            '</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="mgmt-chal-actions">' +
                        (!completed
                            ? '<button class="btn" style="padding:2px 8px;font-size:var(--text-xs);color:#10b981;border-color:#10b981" ' +
                              'onclick="mgmtMarkChalComplete(' + c.id + ')">✓ Complete</button>'
                            : '<button class="btn" style="padding:2px 8px;font-size:var(--text-xs)" ' +
                              'onclick="mgmtMarkChalIncomplete(' + c.id + ')">↺ Reset</button>') +
                    '</div>' +
                    '</div>';
            }).join('');
        }).catch(function(err) {
            console.error(err);
            container.innerHTML = '<p style="color:var(--color-error)">Failed to load challenges.</p>';
        });
    }

    window.saveUserXP = function() {
        if (!mgmtUserId) return;
        var level   = parseInt(document.getElementById('mgmt-level').value)   || 1;
        var points  = parseInt(document.getElementById('mgmt-points').value)  || 0;
        var ptsnext = parseInt(document.getElementById('mgmt-ptsnext').value) || 0;
        var tasks   = parseInt(document.getElementById('mgmt-tasks').value)   || 0;
        DigifinwizDB.getUserById(mgmtUserId).then(function(user) {
            if (!user) throw new Error('User not found');
            var newUD = Object.assign({}, user.userData || {}, {
                level: level, points: points, pointsToNextLevel: ptsnext, completedTasks: tasks
            });
            return DigifinwizDB.updateUser(mgmtUserId, { userData: newUD });
        }).then(function() {
            showToast('XP & Level saved!', 'success');
            loadUsersPage();
        }).catch(function(err) { console.error(err); showToast('Save failed.', 'error'); });
    };

    window.saveUserBalances = function() {
        if (!mgmtUserId) return;
        var checking = parseFloat(document.getElementById('mgmt-checking').value) || 0;
        var savings  = parseFloat(document.getElementById('mgmt-savings').value)  || 0;
        DigifinwizDB.getUserById(mgmtUserId).then(function(user) {
            if (!user) throw new Error('User not found');
            var newBal = Object.assign({}, user.balances || {}, {
                checking: Math.max(0, checking),
                savings:  Math.max(0, savings)
            });
            return DigifinwizDB.updateUser(mgmtUserId, { balances: newBal });
        }).then(function() {
            showToast('Balances saved!', 'success');
        }).catch(function(err) { console.error(err); showToast('Save failed.', 'error'); });
    };

    window.mgmtMarkChalComplete = function(chalId) {
        DigifinwizDB.updateChallenge(chalId, { completed: true, completedAt: Date.now() })
            .then(function() {
                showToast('Challenge marked complete!', 'success');
                if (mgmtUserId) loadMgmtChallenges(mgmtUserId);
            }).catch(function() { showToast('Update failed.', 'error'); });
    };

    window.mgmtMarkChalIncomplete = function(chalId) {
        DigifinwizDB.updateChallenge(chalId, { completed: false, completedAt: null })
            .then(function() {
                showToast('Challenge reset.', 'info');
                if (mgmtUserId) loadMgmtChallenges(mgmtUserId);
            }).catch(function() { showToast('Update failed.', 'error'); });
    };

    // ── Init ──────────────────────────────────────────────────────────────────
    DigifinwizDB.init().then(() => loadPage('dashboard'))
        .catch(err => { console.error('DigifinwizDB init:', err); showToast('Database error.', 'error'); });
});
