// config.js — single place to point the frontend at the backend API.
//
// Detects environment instead of hardcoding a specific frontend hostname,
// so this keeps working no matter what the Netlify site is named/renamed to:
//   - localhost / 127.0.0.1 / private LAN IPs / file:// (local dev) -> same-origin
//   - *.onrender.com (same-origin Render deploy)                   -> same-origin
//   - anything else (Netlify, custom domain, ...)                  -> the deployed Render API
//
// Deliberately whitelists "looks local" rather than blacklisting a fixed
// list of local hostnames — the previous version fell through to the LIVE
// production API for anything it didn't recognize, which included a LAN IP
// (e.g. serving this on 192.168.x.x for a phone to test against) or
// file://, silently sending real requests (including registrations and
// balance writes) to production instead of the local dev server.
var RENDER_API_URL = 'https://fin-wiz.onrender.com';
window.API_BASE_URL = (function () {
    var host = window.location.hostname;
    var isLocal = !host                                    // file:// has no hostname
        || host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || /^10\./.test(host)
        || /^192\.168\./.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
        || host.indexOf('.') === -1;                        // bare machine/container name
    var isRender = host.endsWith('.onrender.com');
    return (isLocal || isRender) ? '' : RENDER_API_URL;
})();
