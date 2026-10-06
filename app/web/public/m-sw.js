/*
 * The phone view's service worker (6 Oct 2026): what lets /m be installed as an app, and nothing more.
 *
 * It caches nothing. A position, a P&L or a health light shown from a cache reads exactly like a live one, and
 * on a trading screen an old number taken for a new one is worse than no number. With no network, the page
 * says so plainly instead of showing the last figures it saw.
 */
const OFFLINE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>BTC Desk</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0d10;color:#e9edf2;font:15px/1.5 system-ui,sans-serif;text-align:center;padding:24px">
<div><h1 style="font-size:18px;margin:0 0 8px">No connection</h1>
<p style="margin:0;color:#98a3b3">The desk cannot be reached, so no figures are shown.<br>Pull down or reopen the app when you are back online.</p></div>
</body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  // Only the page itself; every API call and asset goes to the network untouched.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(
    fetch(event.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })),
  );
});
