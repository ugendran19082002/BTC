import { useState } from 'react';
import { Check, ChevronRight, Copy, Server, Globe, Landmark, Activity, Trash2 } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { deleteAllErrors, deleteError, getErrors, resolveError, resolveAllErrors } from '@/api/errors';
import type { ErrorRow, ErrorSource } from '@/types/errors';
import { usePoll } from '@/hooks/usePoll';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Checkbox } from '@/components/ui/checkbox';
import { KV } from '@/components/ui/kv';
import { ago, stamp } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The error log, for whoever has to fix it.
 *
 * Not a toast and not a red dot: a list you can read, with the stack and the
 * arguments that produced it, and a copy button so it can be pasted somewhere
 * useful. Identical failures are one row with a count, so a poll failing every
 * second does not push everything else off the screen.
 */

const ICON: Record<ErrorSource, typeof Server> = {
  server: Server,
  browser: Globe,
  exchange: Landmark,
  trading: Activity,
};

const SOURCE_LABEL: Record<ErrorSource, string> = {
  server: 'Server',
  browser: 'Browser',
  exchange: 'Delta',
  trading: 'Trading',
};

/**
 * What a known error means, in one plain sentence -- so the log answers "do I
 * need to do anything" before anyone opens a stack trace.
 */
function meaningOf(row: ErrorRow): string | null {
  if (row.code === 'network') {
    return 'The connection between this device and the desk dropped. Usually weak signal or a restart; only a concern if it keeps happening.';
  }
  if (row.code === 'RequestTimedOut') {
    return 'Delta did not answer in time. Reads are retried once automatically; nothing is ever sent twice.';
  }
  if (row.code === 'RateLimited') return 'Delta asked the desk to slow down. It waits, then tries again.';
  if (row.code === 'NotConfigured') return 'No Delta API key is set on the server, so account data is off.';
  if (row.code === 'UnreadableReply' || row.code === 'http_200') {
    return 'Delta answered, but the reply arrived broken or cut off. Reads are asked again once automatically; nothing is ever sent twice.';
  }
  if (row.source === 'exchange' && (row.code === 'internal_server_error' || /^http_5\d\d$/.test(row.code ?? ''))) {
    return 'Delta’s own server had a problem. Reads are asked again once automatically; only a concern if it keeps happening.';
  }
  if (row.code === 'unsupported' || row.code === 'no_liquidity_for_market_order') {
    return 'That contract had no order book at that moment, so Delta could not accept an order priced "at the market". '
      + 'Stops go on as limit orders through their trigger, and a close falls back to a limit through the touch, so this '
      + 'should now be rare — the desk also watches the stop itself and closes if the price reaches it.';
  }
  if (row.source === 'exchange' && /refused/i.test(row.message)) {
    return 'Delta rejected the request. The message says which field it did not accept.';
  }
  if (row.code && /^5\d\d$/.test(row.code)) return 'The desk server hit a problem answering. The stack trace below shows where.';
  return null;
}

const SOURCE_TONE: Record<ErrorSource, string> = {
  server: 'text-[var(--accent)]',
  browser: 'text-[var(--ce)]',
  exchange: 'text-[var(--warn)]',
  trading: 'text-[var(--pe)]',
};

export function ErrorLogPanel() {
  const [source, setSource] = useState<ErrorSource | 'all'>('all');
  const [resolved, setResolved] = useState(false);
  const { data, refresh } = usePoll(
    () => getErrors({ source: source === 'all' ? undefined : source, resolved }),
    10_000,
    { deps: [source, resolved] },
  );

  const rows = data?.errors ?? [];

  return (
    <Card>
      <CardTitle
        right={
          rows.length > 0 ? (
            <span className="flex items-center gap-1">
              {!resolved && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { void resolveAllErrors().then(() => refresh()); }}
                >
                  Mark all read
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="text-[var(--down)] hover:bg-[var(--down-bg)]"
                onClick={() => { void deleteAllErrors().then(() => refresh()); }}
              >
                <Trash2 className="h-3 w-3" />
                Clear all
              </Button>
            </span>
          ) : null
        }
      >
        Errors
      </CardTitle>

      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={source}
          onValueChange={(v) => v && setSource(v as ErrorSource | 'all')}
          className="flex"
        >
          <ToggleGroupItem value="all">
            All
            <Count n={data?.summary.unresolved} />
          </ToggleGroupItem>
          {(['server', 'browser', 'exchange', 'trading'] as const).map((s) => (
            <ToggleGroupItem key={s} value={s}>
              {SOURCE_LABEL[s]}
              <Count n={data?.summary.bySource[s]} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Checkbox
          className="ml-auto"
          checked={resolved}
          onChange={(e) => setResolved(e.target.checked)}
          label="Show read"
        />
      </div>

      {rows.length === 0 ? (
        <p className="m-0 py-4 text-center text-[13px] text-muted-foreground">
          No errors{source === 'all' ? '' : ` from ${SOURCE_LABEL[source]}`}. All good.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row) => (
            <ErrorRowView key={row.id} row={row} onResolved={() => void refresh()} />
          ))}
        </div>
      )}
    </Card>
  );
}

function ErrorRowView({ row, onResolved }: { row: ErrorRow; onResolved: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const Icon = ICON[row.source] ?? Server;

  // Everything a person would want in a bug report, in one paste.
  const asText = [
    `${row.source} · ${row.level} · ${row.code ?? 'no code'}`,
    `${row.message}`,
    row.where ? `at ${row.where}` : null,
    `first ${stamp(row.firstSeen)} · last ${stamp(row.lastSeen)} · ${row.count}x`,
    row.context ? `\ncontext:\n${JSON.stringify(row.context, null, 2)}` : null,
    row.stack ? `\nstack:\n${row.stack}` : null,
  ].filter(Boolean).join('\n');

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'rounded-lg border border-border bg-muted',
        row.resolved && 'opacity-55',
        row.level === 'error' && !row.resolved && 'border-l-2 border-l-[var(--down)]',
      )}
    >
      <Collapsible.Trigger
        className={cn(
          'flex w-full appearance-none items-start gap-2 border-0 bg-transparent',
          'p-3 text-left font-[inherit]',
        )}
      >
        <ChevronRight className={cn('mt-[3px] h-3.5 w-3.5 flex-none text-muted-foreground transition-transform', open && 'rotate-90')} />
        <Icon className={cn('mt-[2px] h-3.5 w-3.5 flex-none', SOURCE_TONE[row.source])} />
        <span className="min-w-0 flex-1 overflow-hidden">
          <span className="block break-words text-[12.5px] leading-snug text-foreground">{row.message}</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">
            {row.where && <span className="break-all font-mono">{row.where}</span>}
            {row.where && ' · '}
            {ago(row.lastSeen)}
            {row.count > 1 && <> · <b className="text-[var(--warn)]">{row.count}×</b></>}
            {row.code && <> · {row.code}</>}
          </span>
          {meaningOf(row) && (
            <span className="mt-1 block text-[11.5px] leading-snug text-muted-foreground">{meaningOf(row)}</span>
          )}
        </span>
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div className="border-t border-border px-3 py-2">
          <dl className="m-0 mb-2 grid gap-1">
            <KV label="First seen">{stamp(row.firstSeen)}</KV>
            <KV label="Last seen">{stamp(row.lastSeen)}</KV>
          </dl>

          {row.context && (
            <Block title="Details">{JSON.stringify(row.context, null, 2)}</Block>
          )}
          {row.stack && <Block title="Stack trace">{row.stack}</Block>}

          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-9"
              onClick={() => {
                void navigator.clipboard?.writeText(asText).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            {!row.resolved && (
              <Button
                size="sm"
                variant="ghost"
                className="h-9"
                onClick={() => { void resolveError(row.id).then(onResolved); }}
              >
                Mark read
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-9 text-[var(--down)] hover:bg-[var(--down-bg)]"
              onClick={() => { void deleteError(row.id).then(onResolved); }}
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </Button>
          </div>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** The number beside a filter, kept out of the word so it cannot wrap into it. */
function Count({ n }: { n?: number }) {
  if (!n) return null;
  return (
    <span className="rounded-full bg-background px-1.5 text-[10.5px] font-semibold tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

function Block({ title, children }: { title: string; children: string }) {
  return (
    <div className="mt-1.5">
      <p className="m-0 mb-1 text-[10px] uppercase tracking-[0.6px] text-muted-foreground">{title}</p>
      <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background p-2 text-[11px] leading-relaxed text-foreground">
        {children}
      </pre>
    </div>
  );
}
