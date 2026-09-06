import { DayPicker } from 'react-day-picker';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-0', className)}
      classNames={{
        months: 'flex flex-col',
        month: 'space-y-3',
        caption: 'flex justify-center pt-1 relative items-center',
        caption_label: 'text-[13px] font-medium',
        nav: 'flex items-center gap-1',
        nav_button:
          'h-6 w-6 inline-flex items-center justify-center rounded-md border border-border ' +
          'bg-muted text-muted-foreground hover:text-foreground hover:bg-accent',
        nav_button_previous: 'absolute left-1',
        nav_button_next: 'absolute right-1',
        table: 'w-full border-collapse',
        head_row: 'flex',
        head_cell: 'text-muted-foreground w-8 text-[10px] uppercase tracking-wide font-normal',
        row: 'flex w-full mt-1',
        cell: 'h-8 w-8 text-center p-0 relative',
        day: 'h-8 w-8 p-0 font-normal rounded-md text-[12.5px] hover:bg-accent aria-selected:opacity-100',
        day_selected: 'bg-primary text-primary-foreground hover:bg-primary',
        day_today: 'ring-1 ring-ring',
        day_outside: 'text-muted-foreground opacity-40',
        day_disabled: 'text-muted-foreground opacity-30 hover:bg-transparent cursor-not-allowed',
        ...classNames,
      }}
      components={{
        IconLeft: () => <ChevronLeft className="h-3.5 w-3.5" />,
        IconRight: () => <ChevronRight className="h-3.5 w-3.5" />,
      }}
      {...props}
    />
  );
}
