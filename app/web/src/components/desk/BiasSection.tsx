import type { Bias } from '@/types/desk';
import { CardLead } from '@/components/ui/card';
import { Stat, StatDivider } from '@/components/ui/stat';
import { SectionTitle } from '@/components/ui/section';

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
      <SectionTitle hint="Over 12 hours this barely predicts anything. For information only, never a reason to trade.">
        Market lean · for info only
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
        {/*
          Hover gives the sentence, not the jargon. "IV skew (25d): put IV 1.1pt
          over call" is exact and tells a reader who does not already know it
          precisely nothing -- so the row says which side costs more to insure,
          and the hint says what that is counted as and why.
        */}
        {bias.components.map((c) => (
          <Stat
            key={c.name}
            label={
              <>
                {c.name}
                <span className="ml-1 text-[var(--dim)]">· {Math.round(c.weight * 100)}%</span>
              </>
            }
            value={c.note}
            tone="dim"
            hint={c.means}
          />
        ))}
      </div>
    </>
  );
}
