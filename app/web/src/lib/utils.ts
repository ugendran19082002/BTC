import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Class-name helpers shared by every component.
 */

/** shadcn's class helper: merge conditional classes, last Tailwind class wins. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
