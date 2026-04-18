import type { Clock } from "@/server/services/executor/types";

export class VirtualClock implements Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  setTime(t: Date): void {
    if (t.getTime() < this.current.getTime()) {
      throw new Error(`VirtualClock.setTime: cannot move backwards (${t.toISOString()} < ${this.current.toISOString()})`);
    }
    this.current = new Date(t);
  }
}
