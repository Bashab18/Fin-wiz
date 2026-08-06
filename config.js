// config.js — single place to point the frontend at the backend API.
//
// Detects environment instead of hardcoding a specific frontend hostname,
// so this keeps working no matter what the Netlify site is named/renamed to:
//   - localhost / 127.0.0.1 (local dev)      -> same-origin (relative URLs)
//   - *.onrender.com (same-origin Render deploy) -> same-origin (relative URLs)
//   - anything else (Netlify, custom domain, ...) -> the deployed Render API
var RENDER_API_URL = 'https://fin-wiz.onrender.com';
window.API_BASE_URL = (function () {
    var host = window.location.hostname;
    var isLocal  = host === 'localhost' || host === '127.0.0.1';
    var isRender = host.endsWith('.onrender.com');
    return (isLocal || isRender) ? '' : RENDER_API_URL;
})();
