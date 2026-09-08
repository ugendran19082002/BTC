import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '@/App';
import './styles.css';
import { installGlobalErrorReporting } from '@/lib/report-error';

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
// Installed before anything renders, so a failure during the first paint is
// still recorded rather than lost to a blank screen.
installGlobalErrorReporting();

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
