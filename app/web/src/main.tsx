/**
 * The page's entry: error reporting first, then the desk -- or, at /m, the phone.
 */
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { installGlobalErrorReporting } from '@/lib/report-error';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
// Installed before anything renders, so a failure during the first paint is
// still recorded rather than lost to a blank screen.
installGlobalErrorReporting();

/*
 * A deploy replaced the chunks this page was built with (10 Oct 2026: "Failed to fetch dynamically imported module
 * .../AccountCard-CwGAwC3J.js", a tab left open over a deploy). The page that asks for a screen it no longer has
 * the file for reloads once, onto the new build, rather than showing an error until someone reloads it by hand.
 * Once a minute at most: a chunk that still cannot be fetched after a reload is a network down, not a deploy, and
 * is left to the error boundary to say.
 */
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'btc-desk:reloaded-for-new-build';
  let last = 0;
  try { last = Number(sessionStorage.getItem(KEY) ?? 0); } catch { /* storage blocked: reload anyway, once per load */ }
  if (Date.now() - last < 60_000) return;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* as above */ }
  event.preventDefault();
  window.location.reload();
});

/*
 * /m is the phone (6 Oct 2026): the desk read at a glance, signed in view only. Its own chunk, so a phone on a
 * cell connection never downloads the chain, the chart and the order ticket it has no use for.
 */
const onPhoneView = /^\/m\/?$/.test(window.location.pathname);
const MobileApp = lazy(() => import('@/components/mobile/MobileApp'));
const App = lazy(() => import('@/App'));

createRoot(el).render(
  <StrictMode>
    <Suspense fallback={null}>{onPhoneView ? <MobileApp /> : <App />}</Suspense>
  </StrictMode>,
);
