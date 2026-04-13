export type NotificationEvent =
  | {
      kind: "opportunity_detected";
      symbol: string;
      annualizedYield: number;
      longExchange: string;
      shortExchange: string;
    }
  | { kind: "position_opened"; symbol: string; size: number; executionId: string }
  | { kind: "position_closed"; symbol: string; pnl: number; reason: string }
  | {
      kind: "rescue_triggered";
      symbol: string;
      side: "long" | "short";
      qty: number;
      note: string;
    }
  | {
      kind: "margin_warning";
      symbol: string;
      exchange: string;
      buffer: number;
    }
  | {
      kind: "volatility_pause";
      symbol: string;
      reason: string;
      change: number;
    }
  | {
      kind: "settlement_recorded";
      symbol: string;
      side: "long" | "short";
      amount: number;
    }
  | {
      kind: "deploy_succeeded";
      tag: string;
      previousTag: string | null;
      durationSec: number;
    }
  | {
      kind: "deploy_failed";
      tag: string;
      previousTag: string | null;
      rolledBack: boolean;
      reason: string;
    };

export interface NotifierProvider {
  name: string;
  send(event: NotificationEvent): Promise<void>;
}
