import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// US phone display. Strips non-digits, drops a leading 1, then formats the
// last 10 digits as "(305) 555-0142". Anything else falls back to the raw
// input so we don't silently hide international or malformed numbers.
export function formatPhone(input: string | null | undefined): string {
  if (!input) return "";
  const digits = String(input).replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return input.trim();
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// Single canonical phone mask. Formats to "(305) ***-0142", falling back to
// "***-1234" for numbers that don't match the US 10-digit shape.
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return "—";
  const formatted = formatPhone(e164);
  const m = formatted.match(/^\((\d{3})\)\s(\d{3})-(\d{4})$/);
  if (m) return `(${m[1]}) ***-${m[3]}`;
  const digits = String(e164).replace(/\D/g, "");
  if (digits.length >= 4) return `***-${digits.slice(-4)}`;
  return e164;
}
