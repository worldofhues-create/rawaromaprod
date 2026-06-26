import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merge conditional class names and de-duplicate conflicting Tailwind utilities.
 * The single class-composition helper every component in this RN kit uses — same helper
 * (and behaviour) as the web kit, so authoring patterns transfer 1:1.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
