import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActionTag } from '@/components/trade/ActionTag';

describe('the sold-or-bought label', () => {
  it('[critical] SELL for a sold option and for a trade from before the label; BUY for a bought one', () => {
    const { rerender } = render(<ActionTag action="sell" />);
    expect(screen.getByLabelText('sold to open')).toHaveTextContent('SELL');
    rerender(<ActionTag />);
    expect(screen.getByLabelText('sold to open')).toHaveTextContent('SELL');
    rerender(<ActionTag action={null} />);
    expect(screen.getByLabelText('sold to open')).toHaveTextContent('SELL');
    rerender(<ActionTag action="buy" />);
    expect(screen.getByLabelText('bought to open')).toHaveTextContent('BUY');
  });
});
