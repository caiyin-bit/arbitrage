import type { NotificationEvent, NotifierProvider } from "./types";
import { TelegramProvider } from "./telegram";

const providers: NotifierProvider[] = [
  new TelegramProvider(
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID,
  ),
];

export async function dispatch(event: NotificationEvent) {
  await Promise.allSettled(providers.map((p) => p.send(event)));
}
