import { AlertTriangle, CheckCircle2, OctagonX } from 'lucide-react';
import type { Glance } from '@/api/glance';
import { Card, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * The phone's desk-health card: one line first -- a word, an icon and a colour, never colour alone -- then the
 * reasons in the server's words, then the six readings behind them. The judgement is the server's
 * (observability/glance.ts); this card only says it.
 */

const VERDICT = {
  ok: { icon: CheckCircle2, text: 'All OK', tone: 'text-[var(--up)]', bg: 'bg-[var(--up-bg)]' },
  warn: { icon: AlertTriangle, text: 'Needs a look', tone: 'text-[var(--warn)]', bg: 'bg-[var(--warn-bg)]' },
  down: { icon: OctagonX, text: 'Something is down', tone: 'text-[var(--down)]', bg: 'bg-[var(--down-bg)]' },
} as const;

const age = (ms: number | null) => (ms === null ? 'none yet' : ms < 1_000 ? 'now' : ms < 120_000 ? `${Math.round(ms / 1000)} s old` : `${Math.round(ms / 60_000)} min old`);

export function HealthCard({ glance, error }: { glance: Glance | null; error: Error | null }) {
  if (!glance) {
    return (
      <Card aria-busy={!error}>
        <CardTitle>Desk health</CardTitle>
        <p className="m-0 text-[14px] text-muted-foreground">{error ? `Could not read the desk: ${error.message}` : 'Reading the desk…'}</p>
      </Card>
    );
  }
  const v = VERDICT[glance.health];
  const r = glance.readings;
  return (
    <Card>
      <CardTitle>Desk health</CardTitle>
      <div role="status" className={cn('flex items-center gap-2.5 rounded-md px-3 py-2.5', v.bg)}>
        <v.icon className={cn('h-6 w-6 shrink-0', v.tone)} aria-hidden="true" />
        <span className={cn('text-[17px] font-semibold', v.tone)}>{v.text}</span>
      </div>
      {glance.issues.length > 0 && (
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0" aria-label="What needs a look">
          {glance.issues.map((i) => (
            <li key={i.text} className="flex gap-2 text-[13.5px] leading-snug">
              <span aria-hidden="true" className={i.level === 'down' ? 'text-[var(--down)]' : 'text-[var(--warn)]'}>●</span>
              <span>{i.text}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="m-0 mt-3 grid grid-cols-2 gap-2">
        <Reading label="Mode" value={r.mode === 'live' ? 'LIVE' : 'Paper'} tone={r.mode === 'live' ? 'live' : undefined} />
        <Reading label="Scheduler" value={r.schedulerOn ? 'On' : 'Off'} tone={r.schedulerOn ? undefined : 'dim'} />
        <Reading label="Option prices" value={age(glance.boardAgeMs)} tone={glance.boardAgeMs === null || glance.boardAgeMs >= 15_000 ? 'warn' : undefined} />
        <Reading label="Delta quota used" value={`${r.delta.usedPct}%`} tone={r.delta.usedPct >= 80 || r.delta.rateLimited > 0 ? 'warn' : undefined} />
        <Reading label="Open errors" value={r.errors.open >= 100 ? '100+' : String(r.errors.open)} tone={r.errors.open > 0 ? 'warn' : undefined} />
        <Reading label="Database" value={r.db.ok ? `${r.db.latencyMs} ms` : 'Not answering'} tone={r.db.ok ? undefined : 'down'} />
      </dl>
    </Card>
  );
}

function Reading({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'down' | 'dim' | 'live' }) {
  return (
    <div className="rounded-md bg-muted px-3 py-2">
      <dt className="text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className={cn(
        'm-0 text-[15px] font-semibold tabular-nums',
        tone === 'warn' && 'text-[var(--warn)]',
        tone === 'down' && 'text-[var(--down)]',
        tone === 'dim' && 'text-muted-foreground',
        tone === 'live' && 'text-[var(--accent)]',
      )}>
        {value}
      </dd>
    </div>
  );
}
