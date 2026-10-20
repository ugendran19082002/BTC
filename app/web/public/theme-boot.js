// The theme before the first paint (20 Oct 2026): read the choice kept by lib/theme.ts and set it on the root, so a
// light page never flashes dark while the app loads. A file of its own: the CSP allows no inline script.
(function () {
  var theme = 'dark';
  try {
    var raw = localStorage.getItem('btc-desk:theme');
    var mode = raw === null ? 'dark' : JSON.parse(raw);
    var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    theme = mode === 'light' || (mode === 'system' && light) ? 'light' : 'dark';
  } catch (e) { theme = 'dark'; }
  document.documentElement.setAttribute('data-theme', theme);
  var bar = document.querySelector('meta[name="theme-color"]');
  if (bar) bar.setAttribute('content', theme === 'light' ? '#f4f5f7' : '#0a0d10');
})();
