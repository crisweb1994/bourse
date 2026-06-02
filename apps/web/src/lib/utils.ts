import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export function getCookie(name: string) {
  if (typeof document === 'undefined') return null;

  return (
    document.cookie
      .split('; ')
      .find((row) => row.startsWith(`${name}=`))
      ?.split('=')[1] ?? null
  );
}

export function csrfHeaders(): Record<string, string> {
  const token = getCookie('sc_csrf');
  return token ? { 'x-csrf-token': decodeURIComponent(token) } : {};
}
