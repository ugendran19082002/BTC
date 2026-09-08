import type { Bias } from '../types';
import { CardLead } from './ui/card';
import { Stat, StatDivider } from './ui/stat';
import { SectionTitle } from './ui/section';

/**
 * Which way the option board is leaning right now.
 *
 * A section under the contract, not a card. It is describing the same market
 * the contract card is describing, and given a card of its own it read as an
 * input to the decision. It is not one: every figure here was tried as a
 * trading rule and none held up across all three years.
 */
export function BiasSection({ bias }: { bias: Bias }) {
  const pct = ((bias.score + 1) / 2) * 100;
  const tone = bias.score > 0.15 ? 'up' : bias.score < -0.15 ? 'down' : 'plain';

  return (
    <>
      <StatDivider />
      <SectionTitle hint="Over 12 hours this barely predicts anything. Background, never the reason to trade.">
        which way it leans · background only
      </SectionTitle>

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
    </>
  );
}
