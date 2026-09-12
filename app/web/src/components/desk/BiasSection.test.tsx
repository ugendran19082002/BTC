import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BiasSection } from '@/components/desk/BiasSection';
import type { Bias } from '@/types/desk';

/**
 * The market lean, read as an indicator.
 *
 * It is the one section on the desk that must never read as a reason to trade,
 * so the two things pinned hardest are that it says which way in words -- not
 * only as a coloured bar somebody has to interpret -- and that it never stops
 * saying it is for information only.
 */

const component = (over: Partial<Bias['components'][number]> = {}): Bias['components'][number] => ({
  name: 'which side costs more to insure',
  value: -0.5,
  weight: 0.4,
  note: 'downside, by 0.1 points',
  means: 'Puts are priced richer than calls. Counted as negative.',
  ...over,
});

const bias = (over: Partial<Bias> = {}): Bias => ({
  score: 0,
  label: 'not leaning either way',
  pcr: 0.49,
  ivSkew: 0.001,
  components: [
    component({ name: 'how many puts are held, against calls', value: 0.2, weight: 0.3, note: '0.49 puts per call' }),
    component(),
  ],
  ...over,
});

describe('the market lean', () => {
  it('[critical] never stops saying it is for information only', () => {
    render(<BiasSection bias={bias({ score: 0.8, label: 'leaning up' })} />);
    expect(screen.getByText(/for info only/i)).toBeInTheDocument();
  });

  it('says which way in words, at the top', () => {
    render(<BiasSection bias={bias({ score: 0.5, label: 'leaning up' })} />);
    expect(screen.getByText('leaning up')).toBeInTheDocument();
  });

  it('[critical] gives every input a direction in words, not just a bar', () => {
    render(<BiasSection bias={bias()} />);
    // -0.5 reads "down"; +0.2 reads "slightly up"
    expect(screen.getByLabelText('which side costs more to insure: down')).toBeInTheDocument();
    expect(screen.getByLabelText('how many puts are held, against calls: slightly up')).toBeInTheDocument();
  });

  it('the scale is labelled at both ends, so the middle means something', () => {
    render(<BiasSection bias={bias()} />);
    expect(screen.getByText('Down')).toBeInTheDocument();
    expect(screen.getByText('Up')).toBeInTheDocument();
    expect(screen.getByLabelText('market lean: flat')).toBeInTheDocument();
  });

  it('keeps the figure behind each row, one size down', () => {
    render(<BiasSection bias={bias()} />);
    expect(screen.getByText('0.49 puts per call')).toBeInTheDocument();
    expect(screen.getByText('downside, by 0.1 points')).toBeInTheDocument();
  });
});
