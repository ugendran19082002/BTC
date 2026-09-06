import { useState, type ReactNode } from 'react';

/**
 * A labelled number that can show its own arithmetic.
 *
 * Every figure on this desk is derived from something, and a reader who cannot
 * see the derivation has to take it on trust. Opening one shows the actual sum
 * with the current values substituted in, not a textbook definition.
 *
 * The label, the value and the explanation are one component rather than a
 * toggle nested inside a label, so the value keeps its place on the row when
 * the explanation opens.
 */
export function Metric({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="metric">
      <div className="metric-row">
        <span className="metric-label">
          {label}
          {children && (
            <button
              type="button"
              className="explain-toggle"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              title={open ? 'hide the working' : `how ${label} is worked out`}
            >
              ?
            </button>
          )}
        </span>
        <span className="metric-value">{value}</span>
      </div>
      {open && <div className="explain">{children}</div>}
    </div>
  );
}

export function Formula({ children }: { children: ReactNode }) {
  return <div className="formula">{children}</div>;
}

/**
 * A labelled control that can explain itself.
 *
 * The controls on this desk are not self-evident -- "hedge gap" means nothing
 * until someone tells you it is measured in strikes, and that each strike is
 * $200 apart. The note opens under the field rather than in a tooltip so it can
 * be read at length and stay open while you change the value.
 */
export function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: ReactNode;
  help?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="field">
      <label>
        {label}
        {help && (
          <button
            type="button"
            className="explain-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            title={open ? 'hide' : `what ${label} means`}
          >
            ?
          </button>
        )}
      </label>
      {children}
      {open && <div className="explain field-explain">{help}</div>}
    </div>
  );
}
