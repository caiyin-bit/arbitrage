# Executor 依赖注入迁移（Plan 4, Phase 3）

## 改动前

`src/server/services/executor/*.ts` 直接 import `prisma` / `redis` / `createAdapter`. 无法单元测试，无法回测。

## 改动后

所有 executor 函数接受 `ExecutorContext` 作为第一个参数：

```ts
export interface ExecutorContext {
  store: PositionStore;
  redis: RedisLike;
  adapterFor: (name: string) => Promise<ExchangeAdapter>;
  clock: Clock;
  random: () => number;
  log: (msg, meta?) => void;
}
```

## 生产入口

```ts
import { buildProdContext } from "@/server/services/executor/context-prod";

const ctx = buildProdContext();
await openHedgedPosition(ctx, req);
```

## 回测入口

`runBacktest()` 构造"假"ctx：
- `store`: InMemoryPositionStore（JS Map）
- `redis`: InMemoryRedis（带 TTL 的 Map）
- `adapterFor`: HistoricalAdapter（基于 OHLCV + clock.now() 回放）
- `clock`: VirtualClock（回测时间线）
- `random`: seeded PRNG（确定性失败注入）

生产和回测共享完全相同的 executor 代码。

## 规则

- `src/server/services/executor/` 里**不得**直接 import `prisma` 或 `redis`
- 每个新的 executor 函数签名以 `ctx: ExecutorContext` 为第一个参数
- 单元测试可用 mocked ctx；集成测试用 `buildProdContext()`
