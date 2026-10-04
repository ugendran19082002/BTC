import { getDeskMetrics, type MsSpread } from '@/api/desk';
import { CollapsibleCard } from '@/components/ui/collapsible-card';
import { usePoll } from '@/hooks/usePoll';

/**
 * The desk's speed, counted: what it asks of Delta and how much of Delta's
 * quota that uses, how long a pass over the open trades takes, and how long the
 * signal run holds the thread the SL and TGT watch runs on.
 *
 * Read-only. It is here so a change to the desk's speed -- polling contracts
 * side by side, moving the signal run off the thread -- is decided on these
 * numbers and checked against them afterwards.
 */
const ms = (v: number | null): string => (v === null ? '—' : v >= 1_000 ? `${(v / 1_000).toFixed(1)} s` : `${Math.round(v)} ms`);
const spreadOf = (s: MsSpread): string => (s.p50Ms === null ? 'nothing measured yet' : `${ms(s.p50Ms)} median · ${ms(s.p95Ms)} at worst 5% · ${ms(s.maxMs)} longest`);

export function DeskMetricsCard() {
  const { data, error } = usePoll(getDeskMetrics, 5_000);
  if (!data) {
    return (
      <CollapsibleCard id="logs-speed" title="Speed and Delta quota" ariaLabel="speed and quota">
        <p className="m-0 text-[12px] text-muted-foreground">{error ? 'Not available on this server.' : 'Reading…'}</p>
      </CollapsibleCard>
    );
  }
  const d = data.delta;
  // Two thirds of the quota is where polling harder stops being a safe idea.
  const quota = d.usedPct >= 60 ? 'warn' : '';
  const warming = data.countingForMs < d.windowMs;
  return (
    <CollapsibleCard
      id="logs-speed"
      title="Speed and Delta quota"
      ariaLabel="speed and quota"
      right={<span className="settings-note">last 5 minutes</span>}
    >
      <p className="settings-lead">
        Counted, not changed: these are what the desk does now. {warming ? 'The server restarted under five minutes ago, so the window is not full yet.' : ''}
      </p>
      <dl className="desk-metrics" aria-label="desk metrics">
        <div>
          <dt>Delta quota used</dt>
          <dd className={quota} aria-label="quota used">
            {d.units.toLocaleString('en-US')} of {d.quotaUnits.toLocaleString('en-US')} units ({d.usedPct}%) · {d.calls.toLocaleString('en-US')} calls
          </dd>
          <dd className="desk-metrics-bar" aria-hidden><span style={{ width: `${Math.min(100, d.usedPct)}%` }} className={quota} /></dd>
        </div>
        {d.byKind.length > 0 && (
          <div>
            <dt>By kind of call</dt>
            {d.byKind.map((k) => <dd key={k.kind}>{k.kind}: {k.units.toLocaleString('en-US')} units · {k.calls.toLocaleString('en-US')} calls</dd>)}
          </div>
        )}
        <div>
          <dt>Refused for the rate limit (429)</dt>
          <dd className={d.rateLimited.sinceStart > 0 ? 'warn' : ''} aria-label="rate limited">
            {d.rateLimited.sinceStart === 0 ? 'None since the server started' : `${d.rateLimited.inWindow} in the last 5 minutes · ${d.rateLimited.sinceStart} since the server started`}
          </dd>
        </div>
        <div>
          <dt>Delta's answer time</dt>
          <dd aria-label="delta response time">{spreadOf(d.response)}{d.failed > 0 ? ` · ${d.failed} never answered` : ''}</dd>
        </div>
        <div>
          <dt>One pass over the open trades</dt>
          <dd aria-label="pass time">{spreadOf(data.passes)}</dd>
          <dd className={data.passes.late > 0 ? 'warn' : ''} aria-label="late passes">
            {data.passes.count === 0 ? 'No pass yet' : `${data.passes.late} of ${data.passes.count} took over a second · ${data.passes.tradesNow} trade${data.passes.tradesNow === 1 ? '' : 's'} polled now`}
          </dd>
        </div>
        <div>
          <dt>The signal run, once a minute</dt>
          <dd aria-label="signal read time">reading the market: {spreadOf(data.signalRun.read)}</dd>
          <dd aria-label="signal calculation time">every method on it: {spreadOf(data.signalRun.calc)} — the SL and TGT watch waits this long</dd>
          {data.signalRun.afterClose && (
            <dd aria-label="signals ready after the close">
              signals ready after the candle closed: {spreadOf(data.signalRun.afterClose)}
              {data.signalRun.count > 0 ? ` · ${data.signalRun.early ?? 0} of ${data.signalRun.count} went early, on a candle checked against the tape` : ''}
            </dd>
          )}
        </div>
        <div>
          <dt>The thread, in the last minute</dt>
          <dd aria-label="thread held">{data.thread ? `held ${ms(data.thread.p99Ms)} at worst 1% · ${ms(data.thread.maxMs)} longest` : 'measuring…'}</dd>
        </div>
      </dl>
    </CollapsibleCard>
  );
}
