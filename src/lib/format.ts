import { format, parseISO } from "date-fns";

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const toCurrency = (value: number, currency: "EUR" | "USD"): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: value > 100 ? 0 : 2,
  }).format(value);

export const toNumber = (value: number, digits = 1): string =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(value);

export const toPercent = (value: number, digits = 1): string => `${toNumber(value, digits)}%`;

export const toMonthLabel = (value: string): string => format(parseISO(value), "MMM yyyy");

export const toDateTimeLabel = (value: string): string => format(parseISO(value), "d MMM yyyy, HH:mm");

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
