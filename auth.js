// auth.js - Authentication guard and session management for Digifinwiz app
// Runs immediately on script load (before DOMContentLoaded) to block unauthorised access.

const DigifinwizAuth = (() => {
    const SESSION_KEY = 'bkr_session';

    // ── Session helpers ──────────────────────────────────────────────────
    // Multi-session: each browser tab has its own sessionStorage session.
    // localStorage is only used when "Remember me" is checked, so that
    // new tabs can optionally auto-restore the last remembered session.
    function getSession() {
        try {
            // Per-tab session first
            var s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
            if (s) return s;
            // Backward-compat / Remember-me: migrate from localStorage into this tab
            s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
            if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
            return s;
        } catch(e) { return null; }
    }

    // remember=true  → persist in localStorage so new tabs auto-restore
    // remember=false → tab-only session; new tabs must log in independently
    function setSession(user, remember) {
        const session = {
            userId:   user.id,
            username: user.username,
            fullName: user.fullName || user.username,
            role:     user.role,
            loggedIn: true
        };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        if (remember) {
            localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        } else {
            localStorage.removeItem(SESSION_KEY);
        }
        // Clear legacy keys
        localStorage.removeItem('loggedIn');
        localStorage.removeItem('username');
    }

    function clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem('loggedIn');
        localStorage.removeItem('username');
    }

    function isAdmin() {
        const s = getSession();
        return !!(s && s.role === 'admin');
    }

    function isLoggedIn() {
        return !!getSession();
    }

    function logout() {
        clearSession();
        window.location.replace('login.html');
    }

    // ── Auth guard ───────────────────────────────────────────────────────
    // Runs synchronously on script load.
    function runGuard() {
        // Netlify's Pretty URLs (and hand-typed URLs) can serve these pages
        // without their .html extension, so match on the name alone.
        const rawPage = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
        const page    = rawPage.replace(/\.html$/, '');
        const publicPages = ['login', 'register'];
        const isPublicPage = publicPages.indexOf(page) !== -1;

        if (isPublicPage) {
            // Redirect already-authenticated users away from login/register
            const s = getSession();
            if (s) {
                window.location.replace(s.role === 'admin' ? 'admin.html' : 'index.html');
            }
            return; // Nothing more to do for public pages
        }

        // Protected page — require session
        const s = getSession();
        if (!s) {
            window.location.replace('login.html');
            return;
        }

        // Admin-only pages
        if (page === 'admin' && s.role !== 'admin') {
            window.location.replace('index.html');
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

        // Hide admin-only links from participants
        if (session.role === 'participant') {
            var adminLinks = document.querySelectorAll('a[href="admin.html"], a[href="./admin.html"]');
            adminLinks.forEach(function(link) {
                var li = link.closest('li') || link.parentElement;
                if (li) li.style.display = 'none';
            });
        }

        // Add logout button to nav-menu (avoid duplicates)
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
        clearSession,
        isAdmin,
        isLoggedIn,
        logout
    };
})();
