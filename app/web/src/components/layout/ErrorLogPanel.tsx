import { useState } from 'react';
import { Check, ChevronRight, Copy, Server, Globe, Landmark, Activity } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { getErrors, resolveError, resolveAllErrors } from '@/api/errors';
import type { ErrorRow, ErrorSource } from '@/types/errors';
import { usePoll } from '@/hooks/usePoll';
import { Card, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Checkbox } from '@/components/ui/checkbox';
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
          rows.length > 0 && !resolved ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { void resolveAllErrors().then(() => refresh()); }}
            >
              mark all read
            </Button>
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
            all
            <Count n={data?.summary.unresolved} />
          </ToggleGroupItem>
          {(['server', 'browser', 'exchange', 'trading'] as const).map((s) => (
            <ToggleGroupItem key={s} value={s}>
              {s}
              <Count n={data?.summary.bySource[s]} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Checkbox
          className="ml-auto"
          checked={resolved}
          onChange={(e) => setResolved(e.target.checked)}
          label="show read"
        />
      </div>

      {rows.length === 0 ? (
        <p className="m-0 py-4 text-center text-[13px] text-muted-foreground">
          Nothing has failed{source === 'all' ? '' : ` in ${source}`}.
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
          'flex w-full cursor-pointer appearance-none items-start gap-2 border-0 bg-transparent',
          'p-2.5 text-left font-[inherit]',
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
        </span>
      </Collapsible.Trigger>

      <Collapsible.Content>
        <div className="border-t border-border px-2.5 py-2">
          <dl className="m-0 mb-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <Field label="first seen" value={stamp(row.firstSeen)} />
            <Field label="last seen" value={stamp(row.lastSeen)} />
          </dl>

          {row.context && (
            <Block title="context">{JSON.stringify(row.context, null, 2)}</Block>
          )}
          {row.stack && <Block title="stack">{row.stack}</Block>}

          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigator.clipboard?.writeText(asText).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'copied' : 'copy'}
            </Button>
            {!row.resolved && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { void resolveError(row.id).then(onResolved); }}
              >
                mark read
              </Button>
            )}
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

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="m-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 tabular-nums text-foreground">{value}</dd>
    </>
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
