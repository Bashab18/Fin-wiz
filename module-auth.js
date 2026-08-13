// module-auth.js — Authentication guard and session management for the
// standalone Banking / E-Commerce / Utilities module apps.
// Parallel to auth.js (which is untouched and still runs the original
// shared login.html/register.html/index.html system). This file is only
// ever loaded by pages that set window.APP_MODULE beforehand, and it
// manages an entirely separate session keyed off that module — it never
// reads or writes the shared 'bkr_session' key auth.js uses.
// Runs immediately on script load (before DOMContentLoaded) to block
// unauthorised access.

const DigifinwizModuleAuth = (() => {
    const MODULE = window.APP_MODULE;
    const SESSION_KEY = 'bkr_session' + (MODULE ? '_' + MODULE : '');

    // ── Session helpers ──────────────────────────────────────────────────
    // Tab-scoped only (sessionStorage) — no "remember me" for these
    // lighter-weight standalone module accounts.
    function getSession() {
        try {
            return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
        } catch (e) { return null; }
    }

    function setSession(user) {
        const session = {
            userId:   user.id,
            username: user.username,
            fullName: user.fullName || user.username,
            loggedIn: true
        };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }

    function updateSession(patch) {
        var s = getSession();
        if (!s) return;
        var updated = Object.assign({}, s, patch);
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(updated));
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
    }

    function isLoggedIn() {
        return !!getSession();
    }

    function logout() {
        clearSession();
        window.location.replace(MODULE + '-login.html');
    }

    // ── Auth guard ───────────────────────────────────────────────────────
    // Runs synchronously on script load.
    function runGuard() {
        const segments = window.location.pathname.split('/').filter(Boolean);
        const lastSegment = (segments[segments.length - 1] || (MODULE + '.html')).toLowerCase();
        const page = lastSegment.replace(/\.html$/, '');
        const publicPages = [MODULE + '-login', MODULE + '-register'];
        const isPublicPage = publicPages.indexOf(page) !== -1;

        if (isPublicPage) {
            // Redirect already-authenticated users away from login/register
            const s = getSession();
            if (s) {
                window.location.replace(MODULE + '.html');
            }
            return; // Nothing more to do for public pages
        }

        // Protected page — require a module session
        const s = getSession();
        if (!s) {
            window.location.replace(MODULE + '-login.html');
            return;
        }

        // Session is valid — inject UI after DOM is ready
        document.addEventListener('DOMContentLoaded', function() {
            _injectSessionUI(s);
        });
    }

    // ── UI injection ─────────────────────────────────────────────────────
    function _injectSessionUI(session) {
        // Update sidebar name / username
        var nameEl = document.querySelector('.user-profile h3');
        var unEl   = document.querySelector('.user-profile .username');
        if (nameEl) nameEl.textContent = session.fullName || session.username;
        if (unEl)   unEl.textContent   = '@' + session.username;

        // Update avatar initials if img element exists
        var avatar = document.querySelector('.user-profile .avatar img');
        if (avatar && session.fullName) {
            var parts    = (session.fullName || '').trim().split(' ');
            var initials = (parts[0] ? parts[0][0] : '?') + (parts[1] ? parts[1][0] : '');
            avatar.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='80' height='80'%3E%3Crect fill='%23667eea' width='80' height='80'/%3E%3Ctext x='50%25' y='50%25' font-size='32' fill='white' text-anchor='middle' dy='.3em'%3E" + encodeURIComponent(initials) + "%3C/text%3E%3C/svg%3E";
            avatar.alt = session.fullName;
        }

        // Add logout link to nav-menu (avoid duplicates)
        var navMenu = document.querySelector('.nav-menu');
        if (navMenu && !navMenu.querySelector('.logout-link')) {
            var li = document.createElement('li');
            li.innerHTML = '<a href="#" class="logout-link" style="color:#ef4444;font-weight:600">Logout</a>';
            li.querySelector('a').addEventListener('click', function(e) {
                e.preventDefault();
                if (confirm('Are you sure you want to log out?')) {
                    logout();
                }
            });
            navMenu.appendChild(li);
        }

        // Also wire up any existing logout buttons / links with data-logout attr
        document.querySelectorAll('[data-logout]').forEach(function(el) {
            el.addEventListener('click', function(e) {
                e.preventDefault();
                if (confirm('Are you sure you want to log out?')) {
                    logout();
                }
            });
        });
    }

    // Run the guard immediately
    runGuard();

    // ── Public API ───────────────────────────────────────────────────────
    return {
        getSession,
        setSession,
        updateSession,
        clearSession,
        isLoggedIn,
        logout
    };
})();
