import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { PriceChart } from '../src/components/desk/PriceChart';
import { aggregate, readTf, closedBars } from '../src/lib/smc/context';
import data from './today.json';
const m5 = (data.result as { time: number; open: number; high: number; low: number; close: number; volume: number }[]).slice().sort((a, b) => a.time - b.time);
const closed = closedBars(m5, 300, Math.floor(Date.now() / 1000));
const h1 = aggregate(closed, 300, 3600);
const context = [readTf('1H', 'Regime', h1, 3600), readTf('30M', 'Bias', aggregate(closed, 300, 1800), 1800), readTf('15M', 'Structure', aggregate(closed, 300, 900), 900), readTf('5M', 'Setup', closed, 300)];
try { localStorage.setItem('btc-desk:chart:hud-open', 'false'); } catch { /* */ }
createRoot(document.getElementById('root')!).render(
  <PriceChart bars={m5} tf="5m" context={context} regime={{ bars: h1, tfSec: 3600 }}
    higher={[{ tf: '1H', tfSec: 3600, bars: h1, show: 'zones' }, { tf: '15m', tfSec: 900, bars: aggregate(closed, 300, 900), show: 'structure' }]} />,
);
