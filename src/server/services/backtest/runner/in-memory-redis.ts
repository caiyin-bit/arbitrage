import type { RedisLike } from "@/server/services/executor/types";

interface Entry { value: string; expiresAt?: number; }

export class InMemoryRedis implements RedisLike {
  private store = new Map<string, Entry>();
  constructor(private now: () => Date) {}

  private expired(e: Entry): boolean {
    return typeof e.expiresAt === "number" && e.expiresAt <= this.now().getTime();
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<"OK" | null> {
    let ex: number | undefined;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "EX") ex = Number(args[++i]);
      else if (a === "NX") nx = true;
    }
    if (nx) {
      const existing = this.store.get(key);
      if (existing && !this.expired(existing)) return null;
    }
    this.store.set(key, {
      value,
      expiresAt: typeof ex === "number" ? this.now().getTime() + ex * 1000 : undefined,
    });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (this.expired(e)) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.store.delete(k)) n++;
    return n;
  }
}
