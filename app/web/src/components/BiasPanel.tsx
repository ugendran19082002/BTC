import type { Bias, SnapshotMeta } from '../types';
import { Card, CardTitle, CardLead, Note } from './ui/card';
import { Stat } from './ui/stat';

/** Which way the option board is leaning right now. */
export function BiasPanel({ bias, snap }: { bias: Bias; snap: SnapshotMeta }) {
  const pct = ((bias.score + 1) / 2) * 100;
  const tone = bias.score > 0.15 ? 'up' : bias.score < -0.15 ? 'down' : 'plain';

  return (
    <Card>
      <CardTitle>Which way it leans</CardTitle>
      <CardLead tone={tone}>{bias.label}</CardLead>

      <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <i
          className="absolute inset-y-0 block"
          style={{
            left: `${Math.min(pct, 50)}%`,
            width: `${Math.abs(pct - 50)}%`,
            background: bias.score >= 0 ? 'var(--up)' : 'var(--down)',
          }}
        />
      </div>

      <div className="mt-2.5">
        {bias.components.map((c) => (
          <Stat key={c.name} label={c.name} value={c.note} tone="dim" />
        ))}
      </div>

      <Note>
        Read straight off the board: how many puts against calls, whether puts cost
        more than calls, and which side is trading more.
      </Note>
      <Note tone="dim">
        Over 12 hours this barely predicts anything. It is background, never the
        reason to trade.
        {snap.expectedMove !== null && (
          <> The market is pricing about ±${snap.expectedMove.toFixed(0)} by settlement.</>
        )}
      </Note>
    </Card>
  );
}
