import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { SETTLEMENTS_PER_DAY } from "./constants";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function annualizedYield(
  rateSpreadValue: number,
  intervalHours: number,
): number {
  const settlementsPerDay = SETTLEMENTS_PER_DAY[intervalHours] ?? 24 / intervalHours;
  return rateSpreadValue * settlementsPerDay * 365;
}

export function rateSpread(shortRate: number, longRate: number): number {
  return shortRate - longRate;
}

export function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(4)}%`;
}

export function formatUsd(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(amount);
}
