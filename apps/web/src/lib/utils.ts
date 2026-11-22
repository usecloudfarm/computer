import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, letting a later Tailwind utility win over an earlier one
 * in the same group. `clsx` alone would keep both `p-2` and `p-4`, and which
 * applied would come down to stylesheet order rather than call order.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
