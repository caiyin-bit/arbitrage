import type { ExchangeName } from "@/lib/constants";
import type { ExchangeAdapter } from "./types";
import { BinanceAdapter } from "./binance";
import { OkxAdapter } from "./okx";
import { BybitAdapter } from "./bybit";
import { GateioAdapter } from "./gateio";

export function createAdapter(
  name: ExchangeName,
  apiKey: string,
  apiSecret: string,
  passphrase?: string,
): ExchangeAdapter {
  switch (name) {
    case "binance":
      return new BinanceAdapter(apiKey, apiSecret);
    case "okx":
      return new OkxAdapter(apiKey, apiSecret, passphrase ?? undefined);
    case "bybit":
      return new BybitAdapter(apiKey, apiSecret);
    case "gateio":
      return new GateioAdapter(apiKey, apiSecret);
  }
}
