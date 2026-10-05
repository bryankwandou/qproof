import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function short(s: string, n = 4) {
  return s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`;
}
