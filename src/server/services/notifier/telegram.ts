import TelegramBot from "node-telegram-bot-api";
import type { NotifierProvider, NotificationEvent } from "./types";
import { formatEvent } from "./format";

export class TelegramProvider implements NotifierProvider {
  readonly name = "telegram";
  private bot: TelegramBot | null = null;
  private chatId: string | null = null;

  constructor(token: string | undefined, chatId: string | undefined) {
    if (token && chatId) {
      this.bot = new TelegramBot(token, { polling: false });
      this.chatId = chatId;
    }
  }

  async send(event: NotificationEvent) {
    if (!this.bot || !this.chatId) {
      console.log("[telegram] not configured, skipping:", event.kind);
      return;
    }
    try {
      await this.bot.sendMessage(this.chatId, formatEvent(event));
    } catch (err) {
      console.error("[telegram] send failed:", err);
    }
  }
}
