import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { TimePicker } from '@/components/ui/time-picker';

/**
 * Picking a time on a clock face. What has to hold: it shows AM or PM, it hands
 * back 24-hour "HH:MM", nothing outside min/max can be set, and closing without
 * Set changes nothing.
 */

function Harness(props: { initial?: string; min?: string; max?: string; onChange?: (v: string) => void }) {
  const [v, setV] = useState(props.initial ?? '05:30');
  return (
    <TimePicker
      label="Exit time"
      value={v}
      min={props.min}
      max={props.max}
      presets={[{ label: '5:29 PM · last minute', value: '17:29' }]}
      onChange={(next) => { setV(next); props.onChange?.(next); }}
    />
  );
}

const open = () => fireEvent.click(screen.getByRole('button', { name: /^Exit time:/ }));
const dial = () => within(screen.getByRole('group', { name: /hours|minutes/ }));

describe('the field', () => {
  it('[critical] shows the time with AM or PM, not 24-hour', () => {
    render(<Harness initial="17:29" />);
    expect(screen.getByRole('button', { name: 'Exit time: 5:29 PM' })).toHaveTextContent('5:29 PM');
  });
});

describe('picking', () => {
  it('[critical] hour, then minute, then PM, then Set: hands back 24-hour', () => {
    const onChange = vi.fn();
    render(<Harness initial="05:30" onChange={onChange} />);
    open();
    fireEvent.click(dial().getByRole('button', { name: "5 o'clock" }));
    // the dial moves on to minutes by itself
    fireEvent.click(dial().getByRole('button', { name: '25 minutes' }));
    fireEvent.click(screen.getByRole('button', { name: 'one minute later' }));
    fireEvent.click(screen.getByRole('button', { name: 'one minute later' }));
    fireEvent.click(screen.getByRole('button', { name: 'one minute later' }));
    fireEvent.click(screen.getByRole('button', { name: 'one minute later' }));
    fireEvent.click(screen.getByRole('radio', { name: 'PM' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set 5:29 PM' }));
    expect(onChange).toHaveBeenCalledWith('17:29');
    expect(screen.getByRole('button', { name: 'Exit time: 5:29 PM' })).toBeInTheDocument();
  });

  it('a preset is one tap', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: '5:29 PM · last minute' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set 5:29 PM' }));
    expect(onChange).toHaveBeenCalledWith('17:29');
  });

  it('typing works too, in the ways a time is written', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    open();
    const box = screen.getByRole('textbox', { name: 'type the exit time' });
    fireEvent.change(box, { target: { value: '4:59 pm' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Set 4:59 PM' }));
    expect(onChange).toHaveBeenCalledWith('16:59');
  });

  it('says so when what is typed is not a time', () => {
    render(<Harness />);
    open();
    fireEvent.change(screen.getByRole('textbox', { name: 'type the exit time' }), { target: { value: 'soon' } });
    expect(screen.getByText('Not a time — try 5:29 PM')).toBeInTheDocument();
  });

  it('[critical] Cancel leaves the saved time alone', () => {
    const onChange = vi.fn();
    render(<Harness initial="05:30" onChange={onChange} />);
    open();
    fireEvent.click(dial().getByRole('button', { name: "9 o'clock" }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Exit time: 5:30 AM' })).toBeInTheDocument();
  });
});

describe('the allowed range', () => {
  it('[critical] greys out hours with no allowed minute, and AM when all of it is out of range', () => {
    // exit between 5:31 AM and 5:29 PM
    render(<Harness initial="09:00" min="05:31" max="17:29" />);
    open();
    expect(dial().getByRole('button', { name: "3 o'clock" })).toBeDisabled();   // 3 AM
    expect(dial().getByRole('button', { name: "5 o'clock" })).toBeEnabled();    // 5:31-5:59 AM
    fireEvent.click(screen.getByRole('radio', { name: 'PM' }));
    expect(dial().getByRole('button', { name: "6 o'clock" })).toBeDisabled();   // 6 PM is past 5:29 PM
    expect(screen.getByText('Allowed: 5:31 AM to 5:29 PM')).toBeInTheDocument();
  });

  it('[critical] picking an hour keeps the minute inside the range', () => {
    const onChange = vi.fn();
    render(<Harness initial="09:00" min="05:31" max="17:29" onChange={onChange} />);
    open();
    fireEvent.click(dial().getByRole('button', { name: "5 o'clock" }));        // 5:00 AM is out; 5:31 is nearest
    fireEvent.click(screen.getByRole('button', { name: 'Set 5:31 AM' }));
    expect(onChange).toHaveBeenCalledWith('05:31');
  });

  it('cannot step a minute past the edge', () => {
    render(<Harness initial="17:29" min="05:31" max="17:29" />);
    open();
    expect(screen.getByRole('button', { name: 'one minute later' })).toBeDisabled();
  });

  it('a typed time outside the range is refused, and said why', () => {
    render(<Harness initial="09:00" min="05:31" max="17:29" />);
    open();
    fireEvent.change(screen.getByRole('textbox', { name: 'type the exit time' }), { target: { value: '6 pm' } });
    expect(screen.getByText('Outside 5:31 AM to 5:29 PM')).toBeInTheDocument();
  });
});
