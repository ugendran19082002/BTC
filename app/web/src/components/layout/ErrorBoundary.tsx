import * as React from 'react';
import { reportError } from '@/lib/report-error';

/**
 * A component that throws takes its part of the screen down, not the desk.
 *
 * Scoped rather than wrapped around the whole app on purpose: if the backtest
 * panel throws, the positions and the stop behind them must stay on screen.
 * The failure is reported before the fallback renders, so the row is in the log
 * whether or not anyone reads the message.
 */

type Props = { children: React.ReactNode; where: string; fallback?: React.ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError({
      message: error.message,
      stack: error.stack ?? null,
      where: this.props.where,
      context: { componentStack: info.componentStack?.slice(0, 2_000) ?? null },
    });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="rounded-lg border border-[var(--down)]/50 bg-[var(--down)]/10 p-3">
        <p className="m-0 text-[13px] font-semibold text-[var(--down)]">
          {this.props.where} could not be drawn
        </p>
        <p className="m-0 mt-1 text-[12px] text-muted-foreground">{error.message}</p>
        <button
          onClick={() => this.setState({ error: null })}
          className="mt-2 appearance-none rounded-md border border-border bg-muted px-2.5 py-1 font-[inherit] text-[12px] text-foreground"
        >
          try again
        </button>
      </div>
    );
  }
}
