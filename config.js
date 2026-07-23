// config.js — single place to point the frontend at the backend API.
//
// Same-origin deploy (everything on one host, e.g. Render, or local dev):
// requests go to the current origin.
// Split deploy (static frontend on Netlify, API on Render): only the
// deployed Netlify frontend routes to the separate Render backend — local
// dev and same-origin deploys must never be forced through it.
window.API_BASE_URL = (window.location.hostname === 'loquacious-pie-f7ae65.netlify.app')
    ? 'https://fin-wiz.onrender.com'
    : '';
