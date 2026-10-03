import * as React from 'react';
import { reportError } from '@/lib/report-error';

/**
 * A component that throws takes its part of the screen down, not the desk.
 *
 * Scoped rather than wrapped around the whole app on purpose: if the backtest
 * panel throws, the positions and the stop behind them must stay on screen.
 * The failure is reported before the fallback renders, so the row is in the log
 * whether or not anyone reads the message.
 *
 * Retry-with-cooldown: if the child throws again within 2 seconds of "try
 * again", the boundary stays crashed rather than looping (throw → report →
 * reset → throw → report). A stuck component says so once, not a thousand
 * times.
 */

/** Minimum ms between a retry and the next crash before retrying is allowed again. */
const RETRY_COOLDOWN_MS = 2_000;

type Props = { children: React.ReactNode; where: string; fallback?: React.ReactNode };
type State = { error: Error | null; retryKey: number; retriedAt: number | null; locked: boolean };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, retryKey: 0, retriedAt: null, locked: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError({
      message: error.message,
      stack: error.stack ?? null,
      where: this.props.where,
      context: { componentStack: info.componentStack?.slice(0, 2_000) ?? null },
    });

    // If we retried recently and the component threw again immediately, lock
    // the boundary so "try again" is replaced with a permanent crash message.
    const { retriedAt } = this.state;
    if (retriedAt !== null && Date.now() - retriedAt < RETRY_COOLDOWN_MS) {
      this.setState({ locked: true });
    }
  }

  private handleRetry = () => {
    this.setState((s) => ({
      error: null,
      retryKey: s.retryKey + 1,
      retriedAt: Date.now(),
      locked: false,
    }));
  };

  render() {
    const { error, locked } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="rounded-lg border border-[var(--down)]/50 bg-[var(--down)]/10 p-3">
        <p className="m-0 text-[13px] font-semibold text-[var(--down)]">
          {this.props.where} could not be drawn
        </p>
        <p className="m-0 mt-1 text-[12px] text-muted-foreground">{error.message}</p>
        {locked ? (
          <p className="m-0 mt-2 text-[11px] text-muted-foreground">
            This section keeps failing. Reload the page to try again.
          </p>
        ) : (
          <button
            onClick={this.handleRetry}
            className="mt-2 appearance-none rounded-md border border-border bg-muted px-2.5 py-1 font-[inherit] text-[12px] text-foreground"
          >
            try again
          </button>
        )}
      </div>
    );
  }
}

