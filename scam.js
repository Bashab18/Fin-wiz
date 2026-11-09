// scam.js — the learner's side of scam simulations, shared by the main site,
// DigiBank, InStyl and DigiPay. An admin can send a practice scam (a message, a
// DigiPay bill, a DigiBank payment request); every message and bill has a
// "Report as scam" control, and this file asks the server what the reported
// item really was and shows the answer.
const DigifinwizScam = (() => {
    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function flagsHtml(flags) {
        if (!flags || !flags.length) return '';
        return '<p style="margin:14px 0 6px;font-weight:600;color:#0f172a">Warning signs</p>' +
            '<ul style="margin:0;padding-left:20px;color:#334155;line-height:1.55">' +
            flags.map(function(f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>';
    }

    // Shows what a report (or a payment) turned out to be. Resolves when closed.
    function show(result) {
        return new Promise(function(resolve) {
            var isScam = !!(result && result.scam);
            var paid   = isScam && result.paid;
            var tone   = !isScam ? '#2563eb' : paid ? '#dc2626' : '#16a34a';
            var title  = !isScam ? 'Not a scam' : paid ? 'That was a scam' : 'Scam reported';
            var lines  = '<p style="margin:0;color:#334155;line-height:1.55">' + esc(result && result.message) + '</p>';
            if (isScam && !paid && result.xp > 0) {
                lines += '<p style="margin:10px 0 0;font-weight:700;color:#16a34a">+' + Number(result.xp) + ' XP' +
                    (result.leveledUp ? ' · Level ' + Number(result.newLevel) + ' reached' : '') + '</p>';
            }
            if (paid && result.amount) {
                lines += '<p style="margin:10px 0 0;font-weight:700;color:#dc2626">ƒ' + Number(result.amount).toFixed(2) + ' lost</p>';
            }
            if (isScam) lines += flagsHtml(result.redFlags);

            var overlay = document.createElement('div');
            overlay.setAttribute('role', 'dialog');
            overlay.setAttribute('aria-modal', 'true');
            overlay.setAttribute('aria-labelledby', 'dfwScamTitle');
            overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;padding:16px';
            overlay.innerHTML =
                '<div style="background:#fff;border-radius:14px;max-width:440px;width:100%;max-height:90vh;overflow:auto;box-shadow:0 20px 50px rgba(0,0,0,0.3);font-family:inherit;text-align:left">' +
                    '<div style="padding:18px 22px;border-top:5px solid ' + tone + ';border-radius:14px 14px 0 0">' +
                        '<h3 id="dfwScamTitle" style="margin:0 0 4px;font-size:1.15rem;color:' + tone + '">' + title + '</h3>' +
                        (isScam && result.title ? '<div style="font-size:0.85rem;color:#64748b;margin-bottom:10px">' + esc(result.title) + '</div>' : '<div style="height:8px"></div>') +
                        lines +
                    '</div>' +
                    '<div style="padding:0 22px 18px;text-align:right">' +
                        '<button type="button" id="dfwScamClose" style="background:' + tone + ';color:#fff;border:0;border-radius:8px;padding:9px 20px;font-weight:600;font-size:0.9rem;cursor:pointer">OK</button>' +
                    '</div>' +
                '</div>';
            function close() {
                document.removeEventListener('keydown', onKey);
                overlay.remove();
                resolve(result);
            }
            function onKey(e) { if (e.key === 'Escape') close(); }
            overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
            document.addEventListener('keydown', onKey);
            document.body.appendChild(overlay);
            var btn = document.getElementById('dfwScamClose');
            btn.addEventListener('click', close);
            btn.focus();
        });
    }

    function failed(err) {
        return show({ scam: false, message: (err && err.message) || 'Could not send the report. Please try again.' }).then(function() { throw err; });
    }

    // Each resolves with the server's answer after the learner has closed the result.
    function reportMessage(id)        { return DigifinwizDB.reportMessage(id).then(show, failed); }
    function reportBill(cycleId)      { return DigifinwizDB.reportBill(cycleId).then(show, failed); }
    function reportPaymentRequest(id) { return DigifinwizDB.reportPaymentRequest(id).then(show, failed); }

    // The note under a message the learner has already reported as a scam.
    function revealHtml(m) {
        if (!m || !m.scamRevealed) return '';
        return '<div style="margin-top:12px;padding:10px 14px;border-radius:8px;background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;font-size:0.85rem;white-space:normal">' +
            '<strong>You reported this as a scam.</strong>' + flagsHtml(m.scamRevealed.redFlags).replace(/color:#0f172a/, 'color:#166534').replace(/color:#334155/, 'color:#166534') +
            '</div>';
    }

    return { show, reportMessage, reportBill, reportPaymentRequest, revealHtml };
})();
