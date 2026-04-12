import type { NotificationEvent } from "./types";

function signed(n: number): string {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

export function formatEvent(event: NotificationEvent): string {
  switch (event.kind) {
    case "opportunity_detected":
      return `🎯 New opportunity: ${event.symbol}\n${pct(event.annualizedYield)} APY\nLong ${event.longExchange} → Short ${event.shortExchange}`;
    case "position_opened":
      return `✅ Position opened: ${event.symbol}\nSize ${event.size}\nExec ${event.executionId}`;
    case "position_closed":
      return `🔒 Position closed: ${event.symbol}\nP&L ${signed(event.pnl)}\nReason: ${event.reason}`;
    case "rescue_triggered":
      return `⚠️ Rescue: ${event.symbol}\n${event.side} ${event.qty}\n${event.note}`;
    case "margin_warning":
      return `🚨 Margin warning: ${event.symbol} on ${event.exchange}\nBuffer ${pct(event.buffer)}`;
    case "volatility_pause":
      return `⏸ Volatility pause: ${event.symbol}\n${event.reason} — change ${pct(event.change)}`;
    case "settlement_recorded":
      return `💰 Settlement: ${event.symbol} ${event.side} ${signed(event.amount)}`;
  }
}
