import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Updating, useAnswer } from '@/components/report/Updating';

/**
 * 19 Oct 2026, owner: "portfolio not working". Methods by win % for a run from 1 Oct were refused by the server --
 * "no finished days before 1 Oct to pick from" -- and the screen went on showing the last run's result at full
 * strength, as if it were the answer to the new settings. A refused answer is said, and the old one greyed.
 */
function Screen() {
  const [ask, setAsk] = useState('good');
  const read = useAnswer(ask, () => (ask === 'good' ? Promise.resolve('the first run') : Promise.reject(new Error('For the run: there are no finished days before 2026-10-01 to pick from.'))), 300_000);
  return (
    <>
      <button type="button" onClick={() => setAsk('refused')}>Change</button>
      {read.data && <Updating busy={read.stale} failed={read.failed} what="the run together"><p>{read.data}</p></Updating>}
    </>
  );
}

describe('Updating', () => {
  it('[critical] settings refused: why is said, and the result on the screen is greyed as the previous settings\'', async () => {
    render(<Screen />);
    await screen.findByText('the first run');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Change' })); });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('These settings could not be run: For the run: there are no finished days before 2026-10-01 to pick from.'));
    expect(screen.getByRole('alert')).toHaveTextContent("Below: the previous settings' result, not these.");
    expect(screen.getByText('the first run').parentElement).toHaveClass('opacity-40');
    expect(screen.queryByText(/Working out/)).not.toBeInTheDocument();
  });

  /*
   * The same evening: "Days before" refused, "First days" chosen -- and the old refusal said over the new run for the
   * seconds it took. An error is said only of the settings it was to; the new run is said to be on its way.
   */
  it('[critical] an error of the settings before is not said of those now chosen: the new run is on its way', async () => {
    let finish!: (v: string) => void;
    function Switch() {
      const [ask, setAsk] = useState('ok');
      const read = useAnswer(ask, () => (ask === 'ok' ? Promise.resolve('result 1')
        : ask === 'before' ? Promise.reject(new Error('no finished days before 2026-10-01'))
          : new Promise<string>((r) => { finish = r; })), 300_000);
      return (
        <>
          <button type="button" onClick={() => setAsk('before')}>Days before</button>
          <button type="button" onClick={() => setAsk('first')}>First days</button>
          {read.data && <Updating busy={read.stale} failed={read.failed} what="the run together"><p>{read.data}</p></Updating>}
        </>
      );
    }
    render(<Switch />);
    await screen.findByText('result 1');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Days before' })); });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no finished days before 2026-10-01'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'First days' })); });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Working out the run together for the settings you chose');
    await act(async () => { finish('result 2'); });
    await screen.findByText('result 2');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
