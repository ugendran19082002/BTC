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
