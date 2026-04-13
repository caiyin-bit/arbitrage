# Plan 3 — CI/CD + 腾讯云生产部署 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通 `push tag → GitHub Actions 构建生产镜像 → SSH 触发服务器部署 → 健康检查 → 失败自动回滚` 的完整上线链路，让本项目能通过 `https://arbitrage.tadacamp.com` 对外提供服务。

**Architecture:** CI 与 Release 分离的两个 GitHub Actions workflow（main push 只验证 / tag 才构建+部署）；生产镜像走多阶段 Next.js standalone 构建；服务器侧 `deploy.sh` 负责"备份→迁移→切换→健康检查→回滚"全流程；secrets 只存服务器本地 `.env.production`，GitHub 仅持有 SSH 凭据。

**Tech Stack:** GitHub Actions, Docker Buildx, ghcr.io, Next.js 16 standalone output, Prisma 6 migrate, Postgres 15, Redis 7, Cloudflare proxy, 宿主机 nginx 反代。

**Design reference:** [docs/superpowers/specs/2026-04-13-plan3-cicd-production-deploy-design.md](../specs/2026-04-13-plan3-cicd-production-deploy-design.md)

**Discussion rationale reminder:** 每个任务在实施时遇到和 spec 第 2 节不一致的情况，优先重读 spec 的决策理由、再决定改 plan 还是改实现。不要盲改。

---

## 任务总览

Phase A — 代码层改动（可 TDD，可本地验证）
- Task 1: `/api/health` 路由 + 单元测试
- Task 2: Telegram notifier 新增 `deploy_succeeded` / `deploy_failed` 事件
- Task 3: `next.config.ts` 启用 standalone 输出
- Task 4: `prisma/schema.prisma` 加 musl binary target
- Task 5: 冻结当前 schema 成首个 migration

Phase B — Docker 构建产物（本地可用 `docker compose config` 验证；镜像构建在 CI 上跑）
- Task 6: `.dockerignore` 补全排除项
- Task 7: `Dockerfile.prod` 三阶段构建
- Task 8: `docker-compose.prod.yml`

Phase C — 服务器侧部署脚本（本地 docker 可 dry-run）
- Task 9: `scripts/deploy.sh` 主部署脚本
- Task 10: `scripts/rollback.sh` 手动兜底
- Task 11: `scripts/notify-deploy.ts` 发 Telegram 的小工具

Phase D — GitHub Actions
- Task 12: `.github/workflows/ci.yml`（push main / PR 的验证流水线）
- Task 13: `.github/workflows/release.yml`（tag 触发的构建 + 部署流水线）

Phase E — 文档
- Task 14: `docs/deploy/bootstrap.md` 首次部署 runbook
- Task 15: `docs/deploy/migration-guide.md` Prisma 向后兼容指南
- Task 16: `docs/deploy/troubleshooting.md` 故障排查速查表

Phase F — 端到端验证
- Task 17: `tests/integration/deploy-script.test.ts` deploy.sh dry-run 回滚路径
- Task 18: 手动 smoke test + 拉起真实生产环境 + 打第一个 tag

---

## Task 1: `/api/health` 路由 + 测试

**Files:**
- Create: `src/app/api/health/route.ts`
- Create: `tests/unit/health-route.test.ts`
- Modify: `src/server/db/client.ts`（若没导出 redis 客户端则补一下）

**Background:** deploy.sh 的健康检查依赖一个只暴露在 `localhost` 的 HTTP 端点，返回 200 当且仅当 Prisma 能执行 `SELECT 1` 且 Redis 能 `PING`。这是自动回滚机制的唯一触发信号，所以必须真检查依赖，不能只返回常量。

- [ ] **Step 1: 确认 redis 客户端模块路径**

```bash
rg "ioredis" src/server/db/ -n
rg "new Redis" src/server/ -n | head
```

预期：能找到一个已经创建好的 `ioredis.Redis` 实例（大概率在 `src/server/db/redis.ts` 或类似路径）。如果没有 default-export / named-export，Step 3 需要调整导入路径。

- [ ] **Step 2: 写失败的单元测试**

创建 `tests/unit/health-route.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/server/db/client", () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));
vi.mock("@/server/db/redis", () => ({
  redis: {
    ping: vi.fn(),
  },
}));

import { GET } from "@/app/api/health/route";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 when prisma and redis are both healthy", async () => {
    (prisma.$queryRaw as any).mockResolvedValue([{ "?column?": 1 }]);
    (redis.ping as any).mockResolvedValue("PONG");

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "ok",
      checks: { database: "ok", redis: "ok" },
    });
  });

  it("returns 503 when prisma query fails", async () => {
    (prisma.$queryRaw as any).mockRejectedValue(new Error("connection refused"));
    (redis.ping as any).mockResolvedValue("PONG");

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("error");
    expect(body.checks.database).toBe("error");
    expect(body.checks.redis).toBe("ok");
  });

  it("returns 503 when redis ping fails", async () => {
    (prisma.$queryRaw as any).mockResolvedValue([{ "?column?": 1 }]);
    (redis.ping as any).mockRejectedValue(new Error("ETIMEDOUT"));

    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.database).toBe("ok");
    expect(body.checks.redis).toBe("error");
  });

  it("returns 503 when both fail", async () => {
    (prisma.$queryRaw as any).mockRejectedValue(new Error("down"));
    (redis.ping as any).mockRejectedValue(new Error("down"));

    const res = await GET();
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

```bash
pnpm vitest run tests/unit/health-route.test.ts
```

预期：FAIL（`Cannot find module '@/app/api/health/route'`）

- [ ] **Step 4: 实现 `src/app/api/health/route.ts`**

```ts
import { NextResponse } from "next/server";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CheckResult = "ok" | "error";

async function checkDatabase(): Promise<CheckResult> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "error";
  }
}

async function checkRedis(): Promise<CheckResult> {
  try {
    const reply = await redis.ping();
    return reply === "PONG" ? "ok" : "error";
  } catch {
    return "error";
  }
}

export async function GET() {
  const [database, redisStatus] = await Promise.all([
    checkDatabase(),
    checkRedis(),
  ]);

  const allOk = database === "ok" && redisStatus === "ok";
  const body = {
    status: allOk ? "ok" : "error",
    checks: { database, redis: redisStatus },
  };

  return NextResponse.json(body, { status: allOk ? 200 : 503 });
}
```

**注意**：如果 Step 1 发现 redis 实例不是从 `@/server/db/redis` 导出的，这里的 import 路径要改成实际路径，且测试文件的 `vi.mock` 路径也同步改。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm vitest run tests/unit/health-route.test.ts
```

预期：PASS（4 tests passing）

- [ ] **Step 6: 本地手工验证**

```bash
./dev.sh  # 如果没跑
curl -sS -w "\nHTTP %{http_code}\n" http://localhost:3000/api/health
```

预期：HTTP 200，body `{"status":"ok","checks":{"database":"ok","redis":"ok"}}`。

- [ ] **Step 7: Commit**

```bash
git add src/app/api/health/route.ts tests/unit/health-route.test.ts
git commit -m "feat(plan3): /api/health route for deploy health check"
```

---

## Task 2: Telegram notifier `deploy_succeeded` / `deploy_failed` 事件

**Files:**
- Modify: `src/server/services/notifier/types.ts`
- Modify: `src/server/services/notifier/format.ts`
- Modify: `tests/unit/telegram-format.test.ts`

**Background:** deploy.sh 在部署成功和失败时各发一条 Telegram 通知。复用 Plan 2 已有的 `NotifierProvider`，只加两个新的 event kind。

- [ ] **Step 1: 写失败的测试**

追加到 `tests/unit/telegram-format.test.ts` 末尾：

```ts
import { describe, it, expect } from "vitest";
import { formatEvent } from "@/server/services/notifier/format";

// ... 已有测试保持不变 ...

describe("formatEvent — deploy events", () => {
  it("formats deploy_succeeded", () => {
    const msg = formatEvent({
      kind: "deploy_succeeded",
      tag: "v0.1.0",
      previousTag: "v0.0.9",
      durationSec: 87,
    });
    expect(msg).toContain("v0.1.0");
    expect(msg).toContain("v0.0.9");
    expect(msg).toContain("87");
    expect(msg).toMatch(/deploy/i);
  });

  it("formats deploy_succeeded without previous tag (first deploy)", () => {
    const msg = formatEvent({
      kind: "deploy_succeeded",
      tag: "v0.1.0",
      previousTag: null,
      durationSec: 92,
    });
    expect(msg).toContain("v0.1.0");
    expect(msg).not.toContain("null");
    expect(msg).toMatch(/first deploy|初次/i);
  });

  it("formats deploy_failed with rollback", () => {
    const msg = formatEvent({
      kind: "deploy_failed",
      tag: "v0.1.0",
      previousTag: "v0.0.9",
      rolledBack: true,
      reason: "health check failed after 5 attempts",
    });
    expect(msg).toContain("v0.1.0");
    expect(msg).toContain("v0.0.9");
    expect(msg).toMatch(/rolled back|回滚/i);
    expect(msg).toContain("health check failed");
  });

  it("formats deploy_failed without rollback (first deploy)", () => {
    const msg = formatEvent({
      kind: "deploy_failed",
      tag: "v0.1.0",
      previousTag: null,
      rolledBack: false,
      reason: "migration crashed",
    });
    expect(msg).toContain("v0.1.0");
    expect(msg).toMatch(/service down|manual/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm vitest run tests/unit/telegram-format.test.ts
```

预期：FAIL（types 里没有这两个 kind，`formatEvent` switch 也不认）

- [ ] **Step 3: 扩展 `types.ts`**

在 `src/server/services/notifier/types.ts` 的 `NotificationEvent` 联合类型末尾加两个分支：

```ts
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
```

- [ ] **Step 4: 扩展 `format.ts`**

在 `src/server/services/notifier/format.ts` 的 switch 里加两个 case：

```ts
    case "deploy_succeeded":
      if (event.previousTag) {
        return `🚀 Deploy succeeded: ${event.tag}\nPrevious: ${event.previousTag}\nDuration: ${event.durationSec}s`;
      }
      return `🚀 Deploy succeeded: ${event.tag}\nFirst deploy\nDuration: ${event.durationSec}s`;
    case "deploy_failed":
      if (event.rolledBack && event.previousTag) {
        return `❌ Deploy failed: ${event.tag}\nRolled back to ${event.previousTag}\nReason: ${event.reason}`;
      }
      return `❌ Deploy failed: ${event.tag}\nService may be down — manual intervention required\nReason: ${event.reason}`;
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm vitest run tests/unit/telegram-format.test.ts
```

预期：PASS（全部测试通过，包括原有的 + 4 个新增的）

- [ ] **Step 6: 跑 tsc 确认没 TS 错误**

```bash
pnpm tsc --noEmit
```

预期：无错误。如果其它 switch-exhaustiveness 检查（比如 `router/notifications.ts`）因为新增分支报了 non-exhaustive，一起修到 case 列表覆盖新 kind。

- [ ] **Step 7: Commit**

```bash
git add src/server/services/notifier/types.ts src/server/services/notifier/format.ts tests/unit/telegram-format.test.ts
git commit -m "feat(plan3): telegram notifier deploy_succeeded/deploy_failed events"
```

---

## Task 3: `next.config.ts` 启用 standalone 输出

**Files:**
- Modify: `next.config.ts`

**Background:** Dockerfile.prod runner stage 依赖 `.next/standalone/server.js` 作为入口。没有 `output: 'standalone'` 这个目录不会生成。这是最小改动但如果漏掉 Dockerfile 就崩。

- [ ] **Step 1: 修改 `next.config.ts`**

替换文件为：

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["ccxt", "bullmq", "ioredis"],
};

export default nextConfig;
```

- [ ] **Step 2: 在容器里跑一次 next build 验证**

（本地直接跑可能会因为 Turbopack 差异慢，用 docker dev 容器跑一次 production build）

```bash
docker compose exec app pnpm next build
```

预期：构建成功结尾会提示 `Creating an optimized production build ...` 然后 `First Load JS / Route (...) / Build Traces` 这些字样。构建结束后验证 `.next/standalone/server.js` 存在：

```bash
docker compose exec app ls -la .next/standalone/server.js
docker compose exec app ls .next/standalone/
```

预期：看到 `server.js` + `node_modules/` + 项目结构的一个 mini 镜像。

**注意**：如果报 `Error: standalone output: Cannot find module '...'` 之类 —— 通常是某个动态 import 没能被 Next 追踪。记下错误，先走完 Task 3 commit（standalone 配置本身没错），Task 7 写 Dockerfile 时再处理（可能需要 `outputFileTracingIncludes` 补充）。

- [ ] **Step 3: 确认 dev 模式不受影响**

```bash
curl -sS -w "\nHTTP %{http_code}\n" http://localhost:3000/
```

预期：HTTP 200（因为 Task 3 只加配置，dev mode 由 `next dev` 驱动，不受 `output: 'standalone'` 影响）

- [ ] **Step 4: Commit**

```bash
git add next.config.ts
git commit -m "feat(plan3): enable Next.js standalone output for prod Docker"
```

---

## Task 4: Prisma musl binary target

**Files:**
- Modify: `prisma/schema.prisma`

**Background:** Alpine Linux 是 musl libc，Prisma 6 默认只生成当前平台的 query engine binary。不加 `linux-musl-openssl-3.0.x` target，CI 构建的 prod 镜像在 alpine runner 里启动时会报 `PrismaClientInitializationError: Query engine binary for ... not found`。

- [ ] **Step 1: 修改 `prisma/schema.prisma`**

把 `generator client` 块改成：

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-musl-openssl-3.0.x"]
}
```

- [ ] **Step 2: 重新生成 Prisma client**

```bash
docker compose exec app pnpm prisma generate
```

预期：看到 `✔ Generated Prisma Client (v6.19.3) to ...`，并且会看到它同时生成两个 engine binary：

```bash
docker compose exec app ls node_modules/.pnpm/@prisma+client@*/node_modules/.prisma/client/ | grep libquery_engine
```

预期：应该看到两个 `libquery_engine-*.node` 文件 —— 一个 native（如 `libquery_engine-linux-musl-arm64-openssl-3.0.x.so.node` 或 `libquery_engine-debian-openssl-3.0.x.so.node`，取决于容器 base），另一个 `linux-musl-openssl-3.0.x`。至少要看到两个就说明 target 配对了。

- [ ] **Step 3: 跑一遍单元测试确认没破坏现有 Prisma 调用**

```bash
docker compose exec app pnpm vitest run tests/unit/
```

预期：全部 PASS。

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(plan3): add linux-musl-openssl-3.0.x prisma binary target for alpine prod image"
```

---

## Task 5: 冻结 schema 成首个 migration

**Files:**
- Create: `prisma/migrations/0_init/migration.sql`
- Create: `prisma/migrations/migration_lock.toml`

**Background:** Dev 用 `db push` 直接同步，没有 migration 历史。生产走 `prisma migrate deploy`，所以要把当前 schema 物化成一个初始 migration 文件。做法是 Prisma 官方的 "baseline an existing database" 流程：`migrate diff` 生成 SQL → 手动放到 `0_init/` → `migrate resolve --applied` 标记 baseline。

- [ ] **Step 1: 生成 baseline SQL**

```bash
docker compose exec app mkdir -p prisma/migrations/0_init
docker compose exec app pnpm prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > /tmp/migration.sql
docker compose exec app sh -c 'cat /tmp/migration.sql > prisma/migrations/0_init/migration.sql'
```

预期：`prisma/migrations/0_init/migration.sql` 里面是 CREATE TABLE 语句（8 张表 + 所有 index + foreign key）。快速 sanity check：

```bash
wc -l prisma/migrations/0_init/migration.sql
grep -c "CREATE TABLE" prisma/migrations/0_init/migration.sql
```

预期：几百行，`CREATE TABLE` 至少 8 次。

- [ ] **Step 2: 创建 migration_lock.toml**

```bash
cat > prisma/migrations/migration_lock.toml <<'EOF'
# Please do not edit this file manually
# It should be added in your version-control system (i.e. Git)
provider = "postgresql"
EOF
```

- [ ] **Step 3: 标记现有 dev DB 为已应用 baseline**

```bash
docker compose exec app pnpm prisma migrate resolve --applied 0_init
```

预期：`Migration 0_init marked as applied.`

- [ ] **Step 4: 验证 `migrate status` 干净**

```bash
docker compose exec app pnpm prisma migrate status
```

预期：`Database schema is up to date!` 且看到 `1 migration found in prisma/migrations: 0_init`，没有 pending / failed。

- [ ] **Step 5: 验证从空 DB 全量 apply 能跑通**

起一个临时的空 postgres 测试 migration 文件是合法的：

```bash
docker run --rm -d --name migrate-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -e POSTGRES_USER=test -p 55432:5432 postgres:15-alpine
sleep 5
docker compose exec app sh -c 'DATABASE_URL=postgresql://test:test@host.docker.internal:55432/test pnpm prisma migrate deploy'
docker stop migrate-test
```

预期：`The following migration(s) have been applied: 0_init`，没有报错。

**如果 `host.docker.internal` 在 Linux 下不可达**：改用 `docker network inspect arbitrage_default` 找 compose 网关 IP，或者直接跑在宿主机 `pnpm prisma migrate deploy` + 一个独立的测试 DATABASE_URL。这步只是信心检查，跑通即可，别卡太久。

- [ ] **Step 6: Commit**

```bash
git add prisma/migrations/0_init/migration.sql prisma/migrations/migration_lock.toml
git commit -m "feat(plan3): freeze current schema as initial prisma migration 0_init"
```

---

## Task 6: `.dockerignore` 补全

**Files:**
- Modify (或 Create): `.dockerignore`

**Background:** Build context 会被完整发给 buildkit。不排除 `.git` / `node_modules` / `.next` 这些大目录，上传动辄几百 MB，拖慢 CI 构建且会导致 secrets 意外混入镜像层。

- [ ] **Step 1: 检查当前 `.dockerignore`**

```bash
cat .dockerignore 2>/dev/null || echo "NOT EXIST"
```

- [ ] **Step 2: 写入完整内容**

```
# Version control
.git
.gitignore

# Node artifacts
node_modules
npm-debug.log*
yarn-debug.log*
pnpm-debug.log*

# Build outputs
.next
out
dist
build

# Env files (must never bake into image; prod env injected by compose env_file)
.env
.env.local
.env.*.local
.env.production

# Editor & OS
.vscode
.idea
.DS_Store
*.swp

# Tests
coverage
playwright-report

# Docs that don't need to be in image
docs
*.md
!README.md

# Dev-only tooling & docker
.claude
docker-compose.yml
Dockerfile.dev
dev.sh

# CI config
.github
```

**注意**：`.env.production` 排除在 dockerignore 里是关键 —— 这个文件只存服务器、绝不能进镜像。

- [ ] **Step 3: 验证排除生效（可选）**

```bash
tar --exclude-from=.dockerignore -cf /tmp/ctx.tar . 2>/dev/null
du -sh /tmp/ctx.tar
rm /tmp/ctx.tar
```

预期：压缩后的 context 应该在 10MB 以内（主要是 `src/`、`prisma/` + `package.json` + `pnpm-lock.yaml` + 配置文件）。

- [ ] **Step 4: Commit**

```bash
git add .dockerignore
git commit -m "feat(plan3): dockerignore excludes .git/node_modules/.next/docs/secrets"
```

---

## Task 7: `Dockerfile.prod` 三阶段构建

**Files:**
- Create: `Dockerfile.prod`

**Background:** 多阶段 standalone 构建，最终镜像目标 ≤300MB。与 `Dockerfile.dev` 的关键区别：
1. `FROM node:20-alpine`（docker.io 官方 tag，不是 `local/node:20-alpine`）—— 因为 CI runner 能访问 docker.io，本地不构建 prod 镜像（spec Q8 决策 X）。
2. 三阶段 —— runner 只有运行必需文件。
3. 非 root 用户。

- [ ] **Step 1: 创建 `Dockerfile.prod`**

```dockerfile
# syntax=docker/dockerfile:1.6

# ============ Stage 1: deps ============
# 装完整依赖（包括 devDeps），供 builder 使用
FROM node:20-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ============ Stage 2: builder ============
# 生成 Prisma client + 跑 next build 拿到 .next/standalone
FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma generate 在 next build 之前 —— 否则 Next 编译 @prisma/client import 时会拿不到类型
RUN pnpm prisma generate

# Production build
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm next build

# ============ Stage 3: runner ============
# 最小化运行时镜像
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 非 root 用户
RUN addgroup -S app && adduser -S app -G app

# Next.js standalone 产物（包含精简后的 node_modules）
COPY --from=builder --chown=app:app /app/.next/standalone ./
COPY --from=builder --chown=app:app /app/.next/static ./.next/static
COPY --from=builder --chown=app:app /app/public ./public

# Prisma runtime artifacts —— standalone 不会追踪 Prisma query engine binary，要显式带
COPY --from=builder --chown=app:app /app/prisma ./prisma
COPY --from=builder --chown=app:app /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=app:app /app/node_modules/@prisma ./node_modules/@prisma

# Prisma CLI 也带一份 —— deploy.sh 在临时容器里跑 `prisma migrate deploy` 需要
COPY --from=builder --chown=app:app /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=app:app /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

USER app
EXPOSE 3000

# Next.js standalone 入口
CMD ["node", "server.js"]
```

**坑点警示**：
1. `COPY --from=builder /app/node_modules/.prisma` 和 `.../@prisma` 这两行是必须的 —— 没有就会启动时报 `@prisma/client did not initialize yet`。这个项目用的是 pnpm，但 `node_modules/.prisma` 是 Prisma 生成到 top-level `node_modules` 下的 symlink/real dir，无论 pnpm 怎么 hoist 这个位置都存在。如果 CI 上跑起来发现 `.prisma/client/default.js` 找不到，可能要改成从 pnpm 的 `.pnpm` store 深处拷，参照 `Dockerfile.dev` 里 seed 报错时的解决路径。
2. Next.js standalone 默认只带 `server.js` + 追踪到的源码 import。动态 require（比如 ccxt 的某些 adapter loader）可能追踪不到 —— 如果 CI 构建成功但镜像运行时报 `Cannot find module 'ccxt/...'`，Task 7 的 follow-up 是在 `next.config.ts` 加 `outputFileTracingIncludes` 显式包含。

- [ ] **Step 2: 本地不构建（spec 明确决策）**

不要试图本地 `docker build -f Dockerfile.prod`。spec 第 2.Q8 决定镜像只在 CI 上构建，本地 docker 的 buildx 可能访问不到 docker.io/node:20-alpine。真正的验证留给 Task 13 的 `release.yml` 第一次在 GH Actions 上跑。

作为替代，只做静态 lint：

```bash
docker run --rm -i hadolint/hadolint < Dockerfile.prod
```

预期：没有 `error` 级别问题（warnings 如 `DL3018` pin apk 版本可以忽略，因为我们没装任何 apk 包）。如果本机没装 hadolint 或 docker.io 也拉不到，这步跳过。

- [ ] **Step 3: Commit**

```bash
git add Dockerfile.prod
git commit -m "feat(plan3): multi-stage Dockerfile.prod with Next standalone + Prisma runtime"
```

---

## Task 8: `docker-compose.prod.yml`

**Files:**
- Create: `docker-compose.prod.yml`

**Background:** 生产编排与 dev 的根本区别是 —— app 服务用 `image:` 而不是 `build:`，源码不挂载，`ports` 只绑 `127.0.0.1`（因为外部流量从宿主机 nginx 反代进来）。

- [ ] **Step 1: 创建 `docker-compose.prod.yml`**

```yaml
services:
  app:
    image: ghcr.io/caiyin-bit/arbitrage:${TAG:-latest}
    restart: unless-stopped
    ports:
      # 只绑 localhost —— 外部流量走宿主机 nginx 反代
      - "127.0.0.1:3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    env_file: .env.production
    environment:
      DATABASE_URL: postgresql://arbitrage:${DB_PASSWORD}@postgres:5432/arbitrage
      REDIS_URL: redis://redis:6379
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s

  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    # 不对外暴露 5432 —— 只在 docker network 内部可达
    environment:
      POSTGRES_DB: arbitrage
      POSTGRES_USER: arbitrage
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U arbitrage"]
      interval: 5s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    # 不对外暴露 6379
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

**关键差异回顾**：

| 项 | dev | prod |
|---|---|---|
| app image | `build: .` | `image: ghcr.io/...:${TAG}` |
| 源码挂载 | `- .:/app` | 无 |
| `.next` volume | anonymous | 无 |
| ports | `3000:3000` | `127.0.0.1:3000:3000` |
| postgres ports | `5432:5432` | 无（内部） |
| redis ports | `6379:6379` | 无（内部） |
| env_file | `.env.local` | `.env.production` |
| restart 策略 | 无 | `unless-stopped` |
| healthcheck | 无 | 所有服务 |

- [ ] **Step 2: 静态 validate（不启动容器）**

```bash
DB_PASSWORD=placeholder TAG=v0.0.0 docker compose -f docker-compose.prod.yml config --quiet
```

预期：无输出（`--quiet` 成功时不打印）。如果报 schema 错误，看错误消息修。

**⚠️ 不要** `docker compose -f docker-compose.prod.yml up`，本地没有这个 tag 的镜像会失败；且会和 `docker-compose.yml` 的 dev 容器冲突（相同 service 名）。

- [ ] **Step 3: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "feat(plan3): docker-compose.prod.yml with ghcr image + localhost-only ports"
```

---

## Task 9: `scripts/deploy.sh` 主部署脚本

**Files:**
- Create: `scripts/deploy.sh`

**Background:** 这是整个 Plan 3 的核心。由 GitHub Actions 通过 SSH 以 `deploy` 用户身份触发：`/srv/arbitrage/deploy.sh v0.1.0`。脚本**只存在于服务器**（通过 runbook 里的 `scp` 人工放置），但源文件在仓库里维护，便于 code review 和版本追溯。

脚本流程：`pg_dump → docker pull → prisma migrate deploy (临时容器) → docker compose up app → health check ×5 → 成功记版本 / 失败回滚`。

- [ ] **Step 1: 创建 `scripts/deploy.sh`**

```bash
#!/usr/bin/env bash
#
# deploy.sh — 生产部署入口
#
# 使用：/srv/arbitrage/deploy.sh <tag>
#   由 GitHub Actions release.yml 通过 SSH 触发
#   需要 deploy 用户在 docker 组，且 `docker login ghcr.io` 已完成
#
# 变量：
#   DEPLOY_ROOT      默认 /srv/arbitrage
#   HEALTH_ATTEMPTS  默认 5（每次间隔 12s，总窗口 60s）
#   HEALTH_INTERVAL  默认 12
#   NOTIFY_CMD       默认 `$DEPLOY_ROOT/scripts/notify-deploy.sh`，失败时不阻塞部署
#
set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: $0 <tag>" >&2
  exit 2
fi

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/arbitrage}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-5}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-12}"
NOTIFY_CMD="${NOTIFY_CMD:-$DEPLOY_ROOT/scripts/notify-deploy.sh}"
COMPOSE_FILE="$DEPLOY_ROOT/docker-compose.prod.yml"
ENV_FILE="$DEPLOY_ROOT/.env.production"
IMAGE_REPO="ghcr.io/caiyin-bit/arbitrage"
CURRENT_TAG_FILE="$DEPLOY_ROOT/.current-tag"
FAILED_TAG_FILE="$DEPLOY_ROOT/.failed-tag"

cd "$DEPLOY_ROOT"

START_TS=$(date +%s)
STAMP=$(date +%Y%m%d-%H%M%S)
DUMP="$DEPLOY_ROOT/backups/pre-deploy-$STAMP.sql.gz"
PREV_TAG=""
if [[ -f "$CURRENT_TAG_FILE" ]]; then
  PREV_TAG=$(cat "$CURRENT_TAG_FILE")
fi

log() { echo "[deploy $(date +%H:%M:%S)] $*"; }

notify() {
  # 失败不阻塞部署主流程
  local kind=$1 reason=${2:-}
  if [[ -x "$NOTIFY_CMD" ]]; then
    DEPLOY_KIND="$kind" \
    DEPLOY_TAG="$TAG" \
    DEPLOY_PREV_TAG="$PREV_TAG" \
    DEPLOY_DURATION="$(($(date +%s) - START_TS))" \
    DEPLOY_REASON="$reason" \
    DEPLOY_ROLLED_BACK="${ROLLED_BACK:-false}" \
    "$NOTIFY_CMD" || log "notify failed (non-fatal)"
  else
    log "no notify cmd at $NOTIFY_CMD, skipping"
  fi
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# ---------------------------------------------------------------------------
# Step 1: 备份 DB
# ---------------------------------------------------------------------------
log "step 1: pg_dump → $DUMP"
mkdir -p "$DEPLOY_ROOT/backups"
compose exec -T postgres pg_dump -U arbitrage arbitrage \
  | gzip -9 > "$DUMP"
log "backup size: $(du -h "$DUMP" | cut -f1)"

# ---------------------------------------------------------------------------
# Step 2: 拉新镜像（此步失败不影响线上服务）
# ---------------------------------------------------------------------------
# SKIP_PULL=1 供集成测试使用（测试环境提前 docker tag 好镜像，不走 ghcr.io）
if [[ "${SKIP_PULL:-0}" != "1" ]]; then
  log "step 2: docker pull $IMAGE_REPO:$TAG"
  TAG="$TAG" compose pull app
else
  log "step 2: SKIP_PULL=1, skipping docker pull"
fi

# ---------------------------------------------------------------------------
# Step 3: Migration（在临时容器里跑，不重启 app）
# ---------------------------------------------------------------------------
log "step 3: prisma migrate deploy (throwaway container)"
if ! TAG="$TAG" compose run --rm \
       --no-deps \
       -e DATABASE_URL="postgresql://arbitrage:$DB_PASSWORD@postgres:5432/arbitrage" \
       app node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma; then
  log "ERROR: migration failed — NOT restarting app. Manual intervention required."
  echo "$TAG" > "$FAILED_TAG_FILE"
  notify "deploy_failed" "prisma migrate deploy failed — check logs at $DEPLOY_ROOT"
  exit 3
fi

# ---------------------------------------------------------------------------
# Step 4: 切换 app 容器到新镜像
# ---------------------------------------------------------------------------
log "step 4: docker compose up -d app with TAG=$TAG"
TAG="$TAG" compose up -d app

# ---------------------------------------------------------------------------
# Step 5: Health check
# ---------------------------------------------------------------------------
log "step 5: health check ($HEALTH_ATTEMPTS × ${HEALTH_INTERVAL}s)"
HEALTH_OK=0
for i in $(seq 1 "$HEALTH_ATTEMPTS"); do
  sleep "$HEALTH_INTERVAL"
  if curl -fsS http://127.0.0.1:3000/api/health > /dev/null; then
    log "  attempt $i/$HEALTH_ATTEMPTS: OK"
    HEALTH_OK=$((HEALTH_OK + 1))
  else
    log "  attempt $i/$HEALTH_ATTEMPTS: FAIL"
  fi
done

if [[ $HEALTH_OK -lt "$HEALTH_ATTEMPTS" ]]; then
  log "ERROR: health check failed ($HEALTH_OK/$HEALTH_ATTEMPTS succeeded)"
  ROLLED_BACK=false

  if [[ -n "$PREV_TAG" ]]; then
    log "rollback: switching app to $PREV_TAG"
    TAG="$PREV_TAG" compose up -d app || log "rollback up failed"

    log "rollback: restoring DB from $DUMP"
    if gunzip -c "$DUMP" | compose exec -T postgres psql -U arbitrage -d arbitrage > /dev/null; then
      ROLLED_BACK=true
      log "rollback complete"
    else
      log "ERROR: DB restore failed — service may be in inconsistent state"
    fi
  else
    log "no previous tag; stopping app (first deploy failure)"
    compose stop app || true
  fi

  echo "$TAG" > "$FAILED_TAG_FILE"
  notify "deploy_failed" "health check failed after $HEALTH_ATTEMPTS attempts"
  exit 4
fi

# ---------------------------------------------------------------------------
# Step 6: 成功
# ---------------------------------------------------------------------------
echo "$TAG" > "$CURRENT_TAG_FILE"
rm -f "$FAILED_TAG_FILE"
log "SUCCESS: $TAG is now live (prev: ${PREV_TAG:-none})"
notify "deploy_succeeded"
```

**设计细节说明（不在脚本注释里、但要写进 plan 让读者明白）**：

1. **`SKIP_PULL` flag**：集成测试（Task 17）需要跳过 `docker pull` 因为测试镜像是本地 `docker tag` 出来的不在 ghcr.io。生产环境不设 SKIP_PULL 就保持正常行为。

2. **Step 3 migration 为什么传 `DATABASE_URL`**：`compose run` 默认会加载 `env_file: .env.production`，但 env_file 里的 `DATABASE_URL` 可能是 localhost（留着给 dev 用的误配）；我们强制用 compose network 内的 `postgres` 服务名来确保连到同一 postgres 容器。如果服务器上 `.env.production` 已经正确配置 `DATABASE_URL=postgresql://...@postgres:5432/arbitrage`，这个 `-e` 是冗余的 —— 冗余是有意的，防御误配。

3. **Step 5 为什么要求"5 次全过"而不是"至少 1 次过"**：第一次 GET /api/health 可能在容器刚起 prisma 连接池还没建完时失败。要求连续成功确保 "稳定运行 60 秒" 才算真正 OK，而不是昙花一现。

4. **Step 5 回滚顺序为什么先切 app 再 restore DB**：spec 第 4.4 节明确 —— 先让服务恢复可用，再处理数据。app 先回滚到旧版本后，旧 app 正在运行，此时 restore DB 可能会把旧 app 正在读的连接踢掉；但因为旧 app 的连接会自动重连且 restore 是原子的（psql 一次事务），可接受这段短暂的读中断（<5s）。

5. **`notify` 失败不阻塞主流程**：Telegram token 没配 / 网络不通不应该让部署脚本退出失败。

- [ ] **Step 2: 设置可执行权限**

```bash
chmod +x scripts/deploy.sh
```

- [ ] **Step 3: Bash 语法检查**

```bash
bash -n scripts/deploy.sh
```

预期：无输出（无语法错）。

```bash
# 如果装了 shellcheck
shellcheck scripts/deploy.sh
```

预期：无 error 级别问题。常见的 info 级别可以忽略。

- [ ] **Step 4: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat(plan3): scripts/deploy.sh — backup/migrate/switch/healthcheck/rollback"
```

---

## Task 10: `scripts/rollback.sh` 手动兜底

**Files:**
- Create: `scripts/rollback.sh`

**Background:** `deploy.sh` 失败时自动回滚，但某些场景需要手动回滚（比如部署成功了但几小时后发现线上有 bug，要退回旧版本）。这个脚本**只切 app 镜像，不碰 DB** —— 因为手动回滚时数据已经是"真实业务数据"，不能随便 restore。

- [ ] **Step 1: 创建 `scripts/rollback.sh`**

```bash
#!/usr/bin/env bash
#
# rollback.sh — 手动回滚 app 容器到指定 tag
#
# 使用：/srv/arbitrage/rollback.sh <tag>
#
# 注意：此脚本**不会** restore 数据库。如果需要同时回滚数据库，
# 手动从 /srv/arbitrage/backups/ 选一个 dump 然后：
#   gunzip -c backups/pre-deploy-XXX.sql.gz \
#     | docker compose exec -T postgres psql -U arbitrage arbitrage
#
set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: $0 <tag>" >&2
  echo ""
  echo "Available tags on this server:"
  docker image ls ghcr.io/caiyin-bit/arbitrage --format '  {{.Tag}}' 2>/dev/null || true
  exit 2
fi

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/arbitrage}"
COMPOSE_FILE="$DEPLOY_ROOT/docker-compose.prod.yml"
ENV_FILE="$DEPLOY_ROOT/.env.production"
CURRENT_TAG_FILE="$DEPLOY_ROOT/.current-tag"

cd "$DEPLOY_ROOT"

log() { echo "[rollback $(date +%H:%M:%S)] $*"; }

CURRENT=""
[[ -f "$CURRENT_TAG_FILE" ]] && CURRENT=$(cat "$CURRENT_TAG_FILE")
log "current tag: ${CURRENT:-unknown}"
log "rolling back to: $TAG"

# 如果本地没有这个 image，先拉
if ! docker image inspect "ghcr.io/caiyin-bit/arbitrage:$TAG" > /dev/null 2>&1; then
  log "image not present locally, pulling..."
  TAG="$TAG" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull app
fi

TAG="$TAG" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d app

# 给 5 秒启动时间
sleep 5
if curl -fsS http://127.0.0.1:3000/api/health > /dev/null; then
  echo "$TAG" > "$CURRENT_TAG_FILE"
  log "SUCCESS: $TAG is now live"
else
  log "WARNING: app is up but /api/health not responding yet — monitor manually"
  echo "$TAG" > "$CURRENT_TAG_FILE"
fi
```

- [ ] **Step 2: 设置可执行权限**

```bash
chmod +x scripts/rollback.sh
```

- [ ] **Step 3: 语法检查**

```bash
bash -n scripts/rollback.sh
```

预期：无输出。

- [ ] **Step 4: Commit**

```bash
git add scripts/rollback.sh
git commit -m "feat(plan3): scripts/rollback.sh — manual rollback without DB restore"
```

---

## Task 11: `scripts/notify-deploy.sh` Telegram 通知小工具

**Files:**
- Create: `scripts/notify-deploy.sh`

**Background:** `deploy.sh` 需要发 Telegram 通知，但 deploy.sh 本身是 bash，不适合直接调 Telegram Bot API（还要加载 `.env.production` 解析 TOKEN / CHAT_ID）。做一个薄壳 bash 脚本，读 env vars 然后 `curl` Telegram HTTP API。不走 node —— 避免 node 启动开销和依赖复用。

- [ ] **Step 1: 创建 `scripts/notify-deploy.sh`**

```bash
#!/usr/bin/env bash
#
# notify-deploy.sh — deploy.sh 的 Telegram 通知回调
#
# 从环境变量读取：
#   DEPLOY_KIND        deploy_succeeded | deploy_failed
#   DEPLOY_TAG         当前部署的 tag
#   DEPLOY_PREV_TAG    上一个 tag（首次部署为空）
#   DEPLOY_DURATION    秒数
#   DEPLOY_REASON      失败原因（仅 failed）
#   DEPLOY_ROLLED_BACK true | false（仅 failed）
#
# 以及从 .env.production 读取：
#   TELEGRAM_BOT_TOKEN
#   TELEGRAM_CHAT_ID
#
set -euo pipefail

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/arbitrage}"

# 加载 .env.production 拿 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
if [[ -f "$DEPLOY_ROOT/.env.production" ]]; then
  # shellcheck disable=SC1091
  set -a
  . "$DEPLOY_ROOT/.env.production"
  set +a
fi

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "[notify] telegram not configured, skipping" >&2
  exit 0
fi

KIND="${DEPLOY_KIND:-unknown}"
TAG="${DEPLOY_TAG:-unknown}"
PREV="${DEPLOY_PREV_TAG:-}"
DUR="${DEPLOY_DURATION:-0}"
REASON="${DEPLOY_REASON:-}"
ROLLED="${DEPLOY_ROLLED_BACK:-false}"

case "$KIND" in
  deploy_succeeded)
    if [[ -n "$PREV" ]]; then
      MSG="🚀 Deploy succeeded: ${TAG}
Previous: ${PREV}
Duration: ${DUR}s"
    else
      MSG="🚀 Deploy succeeded: ${TAG}
First deploy
Duration: ${DUR}s"
    fi
    ;;
  deploy_failed)
    if [[ "$ROLLED" == "true" && -n "$PREV" ]]; then
      MSG="❌ Deploy failed: ${TAG}
Rolled back to ${PREV}
Reason: ${REASON}"
    else
      MSG="❌ Deploy failed: ${TAG}
Service may be down — manual intervention required
Reason: ${REASON}"
    fi
    ;;
  *)
    MSG="⚠️ Unknown deploy event: $KIND for $TAG"
    ;;
esac

# Telegram Bot HTTP API
curl -fsS -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${MSG}" \
  > /dev/null

echo "[notify] sent $KIND for $TAG"
```

**注意**：消息格式**必须和 Task 2 里 `format.ts` 的输出一致** —— 避免两处手写格式不一致。如果 Task 2 改了格式，这里也要同步。两处同步的原因是：deploy.sh 是 bash 环境，调用 TS 的 `formatEvent` 成本太高（要启 node + 装依赖），就接受这个 duplication 但靠格式测试拦住 drift（见 Task 17）。

- [ ] **Step 2: 可执行权限 + 语法检查**

```bash
chmod +x scripts/notify-deploy.sh
bash -n scripts/notify-deploy.sh
```

- [ ] **Step 3: Commit**

```bash
git add scripts/notify-deploy.sh
git commit -m "feat(plan3): scripts/notify-deploy.sh — telegram callback for deploy.sh"
```

---

## Task 12: `.github/workflows/ci.yml` 构建验证流水线

**Files:**
- Create: `.github/workflows/ci.yml`

**Background:** main push + PR 的轻量验证流水线。跑 lint / typecheck / vitest / next build + prisma migrate（确认迁移文件合法）。不推镜像、不部署。

- [ ] **Step 1: 创建 `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:15-alpine
        env:
          POSTGRES_DB: arbitrage
          POSTGRES_USER: arbitrage
          POSTGRES_PASSWORD: test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 3s
          --health-retries 5
      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 5

    env:
      DATABASE_URL: postgresql://arbitrage:test@localhost:5432/arbitrage
      REDIS_URL: redis://localhost:6379
      ENCRYPTION_KEY: "0000000000000000000000000000000000000000000000000000000000000000"
      NEXT_TELEMETRY_DISABLED: "1"

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10.33.0

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Prisma generate
        run: pnpm prisma generate

      - name: Prisma migrate deploy (verify migrations)
        run: pnpm prisma migrate deploy

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm tsc --noEmit

      - name: Unit tests
        run: pnpm vitest run tests/unit

      - name: Next build
        run: pnpm next build
```

**设计细节**：

1. **`concurrency` 取消旧 run**：同一 PR 连续 push 时自动取消前一次未跑完的 CI，省分钟数。
2. **CI 里的 `ENCRYPTION_KEY`** 是 64 个 `0`，只是为了让应用能启动；CI 不处理真实加密数据，没有泄漏风险。
3. **不跑 `tests/integration`**：Plan 2 的集成测试依赖真实 Redis + Postgres 且跑起来比较慢。CI 只跑 unit。如果后续想把 integration 加进来，另开 task。
4. **Node 20 + pnpm 10.33.0** 匹配本地 `package.json` 的 `packageManager` 字段。

- [ ] **Step 2: 本地 lint 这个 yaml 格式**

```bash
# 如果装了 yamllint
yamllint .github/workflows/ci.yml
```

预期：无错误（只要缩进和 key 合法即可）。如果没装 yamllint 跳过。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat(plan3): ci workflow — lint/tsc/vitest/migrate/next build"
```

- [ ] **Step 4: 推到远端触发首次运行**

```bash
git push origin main
```

在 `https://github.com/caiyin-bit/arbitrage/actions` 观察 CI run 结果。

**如果失败**：记下错误类型。常见问题：
- `pnpm prisma migrate deploy` 报 `P3005 database schema is not empty`：CI 的 postgres service 每次都是空的，不应该有这个错；如果出了说明 schema 里有残留，检查 Task 5 的 migration 是否真的是全量 DDL。
- `next build` 失败：可能是 Task 3 的 `output: "standalone"` 遇到某个 dynamic import 追踪不了；看错误具体是哪个模块，在 `next.config.ts` 加 `outputFileTracingIncludes`。
- Lint 或 tsc 错：修到全绿再往下走。

**不要** 把失败跳过继续往 Task 13。CI 不通就说明代码不产生健康镜像，release.yml 必然失败。

---

## Task 13: `.github/workflows/release.yml` 发布 + 部署流水线

**Files:**
- Create: `.github/workflows/release.yml`

**Background:** `git tag v*.*.*` 触发的完整构建 + 部署流水线。步骤：checkout → login ghcr → buildx build + push Dockerfile.prod → SSH 到服务器跑 deploy.sh。

- [ ] **Step 1: 创建 `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - "v*.*.*"

concurrency:
  group: release
  cancel-in-progress: false

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    env:
      IMAGE: ghcr.io/${{ github.repository_owner }}/arbitrage

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set lowercase image repo
        id: repo
        run: |
          LC_OWNER=$(echo "${{ github.repository_owner }}" | tr '[:upper:]' '[:lower:]')
          echo "image=ghcr.io/${LC_OWNER}/arbitrage" >> $GITHUB_OUTPUT

      - name: Login to ghcr.io
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Setup Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: Dockerfile.prod
          push: true
          tags: |
            ${{ steps.repo.outputs.image }}:${{ github.ref_name }}
            ${{ steps.repo.outputs.image }}:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Trigger deploy over SSH
        uses: appleboy/ssh-action@v1.0.3
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_KEY }}
          port: ${{ secrets.SSH_PORT }}
          command_timeout: 10m
          envs: GITHUB_REF_NAME
          script: |
            set -euo pipefail
            /srv/arbitrage/deploy.sh "${GITHUB_REF_NAME}"
```

**设计细节**：

1. **`concurrency: group: release cancel-in-progress: false`**：同时只允许一个 release job 跑，但**不取消正在进行的**（部署进行到一半被取消非常危险）。后来的 tag 排队等。
2. **`repository_owner` 小写化**：ghcr.io 要求 image 仓库名全小写，而 GitHub username 可能有大写。
3. **`GITHUB_TOKEN` 的 `packages: write` 权限** 来自 job-level `permissions`。不需要额外 PAT。
4. **`command_timeout: 10m`**：deploy.sh 最长 pg_dump + pull + migrate + 60s health check ≈ 5 分钟，留 10 分钟 buffer。
5. **`envs: GITHUB_REF_NAME`**：把 tag 名传给 SSH 远程 shell。

- [ ] **Step 2: 记下需要配的 GitHub Secrets（还没配，Task 18 会配）**

| Secret | 值 |
|---|---|
| `SSH_HOST` | 腾讯云节点公网 IP |
| `SSH_USER` | `deploy`（Task 14 bootstrap 里创建） |
| `SSH_KEY` | deploy 用户的 **private** key（PEM 格式） |
| `SSH_PORT` | `22`（除非改过） |

**不需要** 配 `GHCR_TOKEN` —— 用 GitHub 自动注入的 `GITHUB_TOKEN`。

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(plan3): release workflow — build + push ghcr + ssh deploy on tag"
```

- [ ] **Step 4: push 到远端但不打 tag**

```bash
git push origin main
```

不要现在打 tag。服务器侧环境（`/srv/arbitrage/*`）还没有配好，现在打 tag SSH 那步必然失败。Task 14-18 配好服务器后再打第一个 tag。

---

## Task 14: `docs/deploy/bootstrap.md` 首次部署 runbook

**Files:**
- Create: `docs/deploy/bootstrap.md`

**Background:** 这是上线前人肉照着敲的操作手册。需要详细到让"任何一个能 ssh 进服务器的人"都能按步骤做对，包括具体命令、预期输出、常见出错点。

- [ ] **Step 1: 创建 `docs/deploy/bootstrap.md`**

```markdown
# Bootstrap Runbook — 首次部署到腾讯云硅谷节点

> **This is a one-shot runbook.** 首次部署时走一遍，之后不再碰。所有后续部署走 `git tag v*.*.*` 触发 GitHub Actions `release.yml`。

**目标**：把一台装了 Docker + Docker Compose、有 nginx 在跑的服务器，配置成能接收 `deploy.sh` 发来的生产部署。

## 0. 前提检查

SSH 登录服务器后，确认：

\`\`\`bash
docker --version          # >= 20.10
docker compose version    # >= 2.0
nginx -v                  # 已装
cat /etc/os-release       # 记录 OS 版本
\`\`\`

---

## 1. 创建 deploy 用户

用 deploy 专用的非 root 账户避免把生产服务器 root 权限暴露给 CI。

\`\`\`bash
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy      # 可以跑 docker 命令
\`\`\`

验证 deploy 可以跑 docker：

\`\`\`bash
sudo -u deploy docker ps
\`\`\`

预期：成功列出容器（可能为空）。如果报 `permission denied`，需要重新登录一次刷新 group。

---

## 2. 生成 SSH key 给 GitHub Actions

**在本机（不是服务器）**生成：

\`\`\`bash
ssh-keygen -t ed25519 -f ~/.ssh/arbitrage_deploy -C "github-actions@arbitrage" -N ""
\`\`\`

把 **public** key 放到服务器的 deploy 用户：

\`\`\`bash
# 在本机
cat ~/.ssh/arbitrage_deploy.pub
# 复制输出

# 在服务器
sudo -u deploy mkdir -p /home/deploy/.ssh
sudo -u deploy chmod 700 /home/deploy/.ssh
echo "<paste public key here>" | sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys
sudo -u deploy chmod 600 /home/deploy/.ssh/authorized_keys
\`\`\`

**private** key（`~/.ssh/arbitrage_deploy`）稍后 Step 9 粘进 GitHub Secrets。

从本机测试 SSH：

\`\`\`bash
ssh -i ~/.ssh/arbitrage_deploy deploy@<server-ip>
\`\`\`

预期：成功登录。

---

## 3. Cloudflare DNS

在 Cloudflare Dashboard：

1. 选 `tadacamp.com` zone
2. 添加 DNS 记录：
   - Type: `A`
   - Name: `arbitrage`
   - IPv4: `<服务器公网 IP>`
   - Proxy status: **Proxied**（橙色云朵）
   - TTL: Auto
3. SSL/TLS → Overview → Encryption mode → **Full**（不是 Flexible）
   - Full 模式下 CF → origin 走 HTTPS 验证证书；我们的 origin 只监听 80，所以实际上 CF 会 fallback 到 HTTP。但设置 Full 的目的是防止以后有人把 Flexible 打开后回源走 HTTP 明文（Flexible 是不安全模式）。
4. 等 2 分钟 DNS 生效，验证：
   \`\`\`bash
   dig +short arbitrage.tadacamp.com
   \`\`\`
   预期：看到 Cloudflare IP（104.21.x.x 或 172.67.x.x），**不是**你服务器真实 IP。

---

## 4. 腾讯云安全组

只允许 Cloudflare IP 段访问 80 端口，防止绕过 CF WAF。

拿 Cloudflare 最新 IP 段：

\`\`\`bash
curl -sS https://www.cloudflare.com/ips-v4
curl -sS https://www.cloudflare.com/ips-v6
\`\`\`

在腾讯云控制台 → 云服务器 → 安全组：
- 入站规则：
  - 22 端口：`0.0.0.0/0` ALLOW（或限制为你本机 IP + 0.0.0.0/0 放行 GH Actions，权衡自决）
  - 80 端口：**只放行 Cloudflare IPv4 + IPv6 段**（上面 curl 返回的列表，一条条加）
  - 443 端口：视情况 —— 如果 nginx 只监听 80 就不需要
- 出站规则：全放行

**验证**：从不在 CF 段的 IP curl 你的服务器 80 应该 timeout；通过 `https://arbitrage.tadacamp.com` 访问应该通（Task 8 完成后才会）。

---

## 5. 宿主机 nginx server block

\`\`\`bash
sudo tee /etc/nginx/conf.d/arbitrage.conf > /dev/null <<'EOF'
server {
    listen 80;
    server_name arbitrage.tadacamp.com;

    # Cloudflare 已经终止 TLS，这里是纯 HTTP。
    # X-Forwarded-Proto 强制 https 让 Next.js 觉得自己在 HTTPS 后面。
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        client_max_body_size 10M;
    }
}
EOF

sudo nginx -t
sudo systemctl reload nginx
\`\`\`

预期：`nginx -t` 返回 `syntax is ok` + `test is successful`。

---

## 6. 创建 /srv/arbitrage 目录结构

\`\`\`bash
sudo mkdir -p /srv/arbitrage/backups
sudo mkdir -p /srv/arbitrage/scripts
sudo chown -R deploy:deploy /srv/arbitrage
\`\`\`

---

## 7. 写 /srv/arbitrage/.env.production

在服务器上创建（**所有真实 secret 都在这个文件**）：

\`\`\`bash
sudo -u deploy tee /srv/arbitrage/.env.production > /dev/null <<EOF
# Database
DB_PASSWORD=$(openssl rand -hex 16)
DATABASE_URL=postgresql://arbitrage:\${DB_PASSWORD}@postgres:5432/arbitrage

# Redis
REDIS_URL=redis://redis:6379

# Encryption (for ExchangeKey AES-256-GCM)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# Telegram (留空则 deploy.sh 不发通知；开户后填)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Next.js
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
EOF

sudo chmod 600 /srv/arbitrage/.env.production
sudo chown root:root /srv/arbitrage/.env.production
\`\`\`

**注意**：
1. `DB_PASSWORD` 和 `DATABASE_URL` 在 compose `env_file` 里一起加载，compose 会先展开 `${DB_PASSWORD}`。
2. 这里的 `DB_PASSWORD` 随机生成一次永久保存 —— 丢了重建需要 restore DB。
3. 这个文件**只有 root 可读**，deploy 用户在跑 `docker compose` 时需要通过 compose 的 `env_file:` 加载 —— compose 以 docker daemon 身份读文件，不受 deploy 用户权限限制。

---

## 8. 复制 docker-compose.prod.yml 和 scripts 到服务器

在本机：

\`\`\`bash
scp -i ~/.ssh/arbitrage_deploy docker-compose.prod.yml deploy@<server-ip>:/srv/arbitrage/
scp -i ~/.ssh/arbitrage_deploy scripts/deploy.sh deploy@<server-ip>:/srv/arbitrage/
scp -i ~/.ssh/arbitrage_deploy scripts/rollback.sh deploy@<server-ip>:/srv/arbitrage/
scp -i ~/.ssh/arbitrage_deploy scripts/notify-deploy.sh deploy@<server-ip>:/srv/arbitrage/scripts/
\`\`\`

在服务器上：

\`\`\`bash
chmod +x /srv/arbitrage/deploy.sh /srv/arbitrage/rollback.sh /srv/arbitrage/scripts/notify-deploy.sh
\`\`\`

---

## 9. 配 GitHub Secrets

在 `https://github.com/caiyin-bit/arbitrage/settings/secrets/actions` 添加：

| Secret | 值 |
|---|---|
| `SSH_HOST` | 服务器公网 IP |
| `SSH_USER` | `deploy` |
| `SSH_KEY` | `~/.ssh/arbitrage_deploy`（PRIVATE key）的**完整内容**，包括 `-----BEGIN OPENSSH PRIVATE KEY-----` 和 `-----END OPENSSH PRIVATE KEY-----` |
| `SSH_PORT` | `22` |

---

## 10. 首次手动部署一次

GitHub Actions 还不能自动部署（还没有镜像在 ghcr.io），先手工走一遍完整流程建立 baseline：

### 10.1 生成一个 ghcr.io PAT

在 `https://github.com/settings/tokens/new` 创建一个 classic PAT：
- Note: `arbitrage-server-pull`
- Expiration: 90 days（或 No expiration，按你偏好）
- Scope: **`read:packages`** （只要这一个）

复制 token。

### 10.2 在服务器上 docker login ghcr.io

\`\`\`bash
echo "<paste-pat>" | sudo -u deploy docker login ghcr.io -u <your-github-username> --password-stdin
\`\`\`

预期：`Login Succeeded`。凭据存在 `/home/deploy/.docker/config.json`。

### 10.3 让 CI 先推一个镜像

在本机：

\`\`\`bash
git tag v0.1.0
git push origin v0.1.0
\`\`\`

观察 GitHub Actions。**预期**：`release.yml` 会跑 "Build and push" 成功（镜像到 ghcr.io），但 "Trigger deploy over SSH" 这步 deploy.sh 会**失败**，因为服务器还没有 postgres / redis 容器 —— 这一步失败可接受，我们只要镜像被推上去了。

### 10.4 服务器上手动拉起 postgres + redis（首次）

\`\`\`bash
ssh -i ~/.ssh/arbitrage_deploy deploy@<server-ip>
cd /srv/arbitrage
docker compose --env-file .env.production -f docker-compose.prod.yml up -d postgres redis
\`\`\`

等 10 秒，验证：

\`\`\`bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
\`\`\`

预期：postgres + redis 都是 `Up (healthy)`。

### 10.5 手动跑 migration

\`\`\`bash
TAG=v0.1.0 docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  -e DATABASE_URL="postgresql://arbitrage:${DB_PASSWORD}@postgres:5432/arbitrage" \
  app node_modules/.bin/prisma migrate deploy
\`\`\`

预期：`The following migration(s) have been applied: 0_init`。

### 10.6 手动跑 seed（首次需要默认 settings）

\`\`\`bash
TAG=v0.1.0 docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  app node dist/server/db/seed.js 2>/dev/null \
  || TAG=v0.1.0 docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
       app sh -c "cd /app && node -e 'console.log(\"seed may be unavailable in standalone build — check troubleshooting.md\")'"
\`\`\`

**注意**：Next standalone build 可能不含 `tsx` 和 `src/server/db/seed.ts`。如果这一步跑不通，临时解决办法：用 dev image 跑一次。写进 `troubleshooting.md` 的 "Seed 在 prod image 里跑不了" 章节。

### 10.7 启动 app

\`\`\`bash
TAG=v0.1.0 docker compose --env-file .env.production -f docker-compose.prod.yml up -d app
sleep 15
curl -sS -w "\nHTTP %{http_code}\n" http://127.0.0.1:3000/api/health
\`\`\`

预期：HTTP 200，body `{"status":"ok",...}`。

### 10.8 记录 baseline tag

\`\`\`bash
echo "v0.1.0" > /srv/arbitrage/.current-tag
\`\`\`

### 10.9 从本机验证外部可达

\`\`\`bash
curl -sS -w "\nHTTP %{http_code}\n" https://arbitrage.tadacamp.com/api/health
\`\`\`

预期：HTTP 200。如果是 502 检查 nginx 配置 + app 容器是否在 localhost:3000 监听。如果是 Cloudflare 521 检查 Step 4 安全组是否放行 CF IP。

---

## 11. 验证 release.yml 全链路

打第二个 tag，这次应该完整成功：

\`\`\`bash
git tag v0.1.1
git push origin v0.1.1
\`\`\`

预期：
1. GH Actions `release.yml` 整个 job 绿
2. 服务器上 `/srv/arbitrage/.current-tag` 内容变为 `v0.1.1`
3. Telegram 收到 `🚀 Deploy succeeded: v0.1.1 / Previous: v0.1.0 / Duration: XXs`

**恭喜，CI/CD 全链路打通。**

---

## Bootstrap 完成后的日常流程

以后所有部署都只需要：

\`\`\`bash
git tag v0.1.2
git push origin v0.1.2
\`\`\`

然后去看 Telegram 消息 + GitHub Actions 页面。如果失败了自动回滚；如果需要手动回退：

\`\`\`bash
ssh deploy@<server-ip>
/srv/arbitrage/rollback.sh v0.1.1
\`\`\`
```

- [ ] **Step 2: 快速通读一遍**

```bash
less docs/deploy/bootstrap.md
```

确认：
- 所有 `<server-ip>` / `<paste public key here>` 等占位符都有明确的上下文说明
- 所有命令都是复制粘贴就能跑的（除了需要填入变量的地方）
- 章节顺序是真实操作顺序

- [ ] **Step 3: Commit**

```bash
git add docs/deploy/bootstrap.md
git commit -m "docs(plan3): bootstrap runbook for first-time production deploy"
```

---

## Task 15: `docs/deploy/migration-guide.md` 向后兼容指南

**Files:**
- Create: `docs/deploy/migration-guide.md`

**Background:** spec 第 2.Q5 节明确 —— deploy.sh 先跑 migration 再切 app，要求 migration **向后兼容**（旧 app 能跑在新 schema 上）。这个文档是开发者写 migration 前要看的指引。

- [ ] **Step 1: 创建 `docs/deploy/migration-guide.md`**

```markdown
# Prisma Migration 向后兼容指南

> 写 migration 前**必看**。违反本指南的 migration 在 deploy.sh 回滚路径下会导致旧 app 启动失败。

## 核心原则

**deploy.sh 的流程是**：
1. 跑 `prisma migrate deploy`（schema 先改）
2. 重启 app 容器（代码后改）
3. Health check
4. Health check 失败 → **切回旧镜像**

第 4 步的旧镜像跑的是**改之前的代码**，但数据库已经是**改之后的 schema**。如果 schema 改动不兼容旧代码，旧 app 启动就会崩，回滚无效。

所以每一个 migration 都要保证：**改后的 schema 能被改前的代码正确读写**。

---

## 安全改动（直接写 migration）

- ✅ 新增 nullable 列（`col String?`）
- ✅ 新增表
- ✅ 新增 index
- ✅ 删除未被任何代码引用的列或表（先确认没有旧 app 读）
- ✅ 放宽约束（NOT NULL → nullable）
- ✅ 扩大数字类型 / VARCHAR 长度

---

## 危险改动（必须两阶段）

### 删除列或重命名列

**错误**：一次 migration 里 `DROP COLUMN old_col` + 一次代码改动里把代码从读 `old_col` 改成读 `new_col`。如果 deploy 失败回滚，旧代码找不到 `old_col` 就崩。

**正确（两次发版）**：

**发版 1**（双写阶段）：
- Migration：`ADD COLUMN new_col`
- 代码：同时写入 `old_col` 和 `new_col`，读优先用 `new_col` fallback 到 `old_col`
- 后台任务：回填存量 `new_col`（从 `old_col` 复制）

**发版 2**（清理阶段，发版 1 稳定几天后）：
- 代码：只读 / 只写 `new_col`
- Migration：`DROP COLUMN old_col`

### 新增 NOT NULL 列

**错误**：`ADD COLUMN new_col VARCHAR NOT NULL`。会直接失败（存量行没有值）。

**正确（两阶段或 default）**：

- 方案 A：先加 `ADD COLUMN new_col VARCHAR` (nullable)，代码升级时填入，稳定后再改成 NOT NULL。
- 方案 B：加 `ADD COLUMN new_col VARCHAR NOT NULL DEFAULT 'xxx'`，Prisma 6 支持这样一次性加。

### 改列类型

**错误**：`ALTER COLUMN fee_rate TYPE NUMERIC(12,6)` 如果旧代码用 `@db.Decimal(10, 6)` 可能失配。

**正确**：大多数类型收窄（比如 Decimal(10,6) → Decimal(12,6)）是兼容的；类型收窄（VARCHAR(255) → VARCHAR(100)）必须两阶段：先加新列、迁移数据、切代码、删旧列。

### 改外键 / 索引的唯一性

**错误**：把一个 `@unique` 加到已有列上，如果存量数据有重复会失败。

**正确**：先做一次数据清理 migration（手写 SQL 删重复），再加 `@unique`。分两次发版。

---

## Migration 开发流程

1. 改 `prisma/schema.prisma`
2. 本地（dev 容器内）生成 migration：
   \`\`\`bash
   docker compose exec app pnpm prisma migrate dev --name <descriptive_name>
   \`\`\`
3. **人肉 review 生成的 `migration.sql`**，按上述指南确认向后兼容
4. 跑 `prisma migrate status` 确认干净
5. 跑单元测试 + 集成测试
6. Commit `prisma/migrations/*` 目录
7. push → CI 会在空 DB 上验证 migration 能跑通
8. 打 tag → release 部署

---

## Migration 失败时 deploy.sh 的行为

deploy.sh 在 Step 3（`prisma migrate deploy`）失败时会：
1. **不**继续切换 app 镜像
2. **不**自动反向 migrate（太危险）
3. 写 `/srv/arbitrage/.failed-tag`
4. 发 Telegram 告警
5. 退出 code 3

旧 app 仍在跑旧镜像读旧 schema（migration 失败说明新 schema 没生效）。人工介入：
- ssh 上服务器看 `docker logs` 里的 migration 错误
- 修 migration 或手工在数据库里补救
- 重新打一个修复版 tag 再部署

**所以 migration 即使失败也不能"部分成功"** —— Prisma migrate 本身是事务性的，但某些 DDL（比如并发 index 创建）不在事务里，要格外小心。
```

- [ ] **Step 2: Commit**

```bash
git add docs/deploy/migration-guide.md
git commit -m "docs(plan3): migration backward-compat guide for rollback safety"
```

---

## Task 16: `docs/deploy/troubleshooting.md` 故障排查速查表

**Files:**
- Create: `docs/deploy/troubleshooting.md`

**Background:** 线上出问题时查的速查表。按症状索引，每个症状对应检查步骤 + 常见原因 + 解决办法。

- [ ] **Step 1: 创建 `docs/deploy/troubleshooting.md`**

```markdown
# Deploy Troubleshooting

> 按症状找章节。每章的格式：症状 → 检查步骤 → 可能原因 → 解决办法。

## 索引

1. [浏览器访问 arbitrage.tadacamp.com 报 521 / 522](#1-521--522)
2. [浏览器访问报 502 Bad Gateway](#2-502)
3. [/api/health 返回 503](#3-health-503)
4. [GitHub Actions release.yml 在 "Build and push" 失败](#4-build-push-失败)
5. [release.yml 在 "Trigger deploy" 失败](#5-trigger-deploy-失败)
6. [deploy.sh step 3 migration 卡住 / 报错](#6-migration)
7. [deploy.sh step 5 health check 全部失败 + 自动回滚成功](#7-health-check-失败)
8. [deploy.sh step 5 health check 失败 + 回滚也失败](#8-回滚也失败)
9. [Telegram 收不到 deploy 通知](#9-telegram)
10. [镜像越来越多，磁盘满](#10-磁盘)
11. [Seed 在 prod image 里跑不了](#11-seed)

---

## 1. 521 / 522

**症状**：`https://arbitrage.tadacamp.com` 返回 Cloudflare 521（Web server is down）或 522（Connection timed out）。

**检查**：
\`\`\`bash
ssh deploy@<server-ip>
curl -sS -w "\nHTTP %{http_code}\n" http://127.0.0.1:3000/api/health
\`\`\`

**可能原因 & 解决**：
- 127.0.0.1:3000 不响应 → app 容器挂了。`docker compose ps`，看日志 `docker compose logs app --tail 100`
- 127.0.0.1:3000 响应但 80 不通 → nginx 配置挂了。`sudo nginx -t && sudo systemctl status nginx`
- 80 通但外网 521 → 腾讯云安全组没放行 Cloudflare IP 段，重新对一遍 bootstrap Step 4

---

## 2. 502

**症状**：浏览器看到 nginx 502 Bad Gateway。

**检查**：
\`\`\`bash
curl http://127.0.0.1:3000/api/health
sudo tail -50 /var/log/nginx/error.log
\`\`\`

**原因**：nginx 能处理请求但 upstream（3000 端口）不响应。
- app 容器没起 → `docker compose ps`
- 容器在但 Next 还在启动 → 等 30 秒重试
- 端口监听在 `0.0.0.0:3000` 而 nginx 配的是 `127.0.0.1:3000` → 检查 compose file `ports` 配置是否是 `127.0.0.1:3000:3000`

---

## 3. /api/health 503

**症状**：`curl /api/health` 返回 503，body 里 `checks.database` 或 `checks.redis` 是 `error`。

**检查**：
\`\`\`bash
curl -s http://127.0.0.1:3000/api/health | jq
docker compose logs postgres --tail 50
docker compose logs redis --tail 50
\`\`\`

**原因 & 解决**：
- `database: error` → postgres 没起 / 没 healthy / DATABASE_URL 错。确认 `.env.production` 的 `DATABASE_URL` 用的是 `postgres:5432`（compose service 名）而不是 `localhost`
- `redis: error` → 同上，redis

---

## 4. Build and push 失败

**症状**：GitHub Actions release.yml 的 "Build and push" 步骤红了。

**常见原因**：
- **Dockerfile 语法错** → 看 log 里的 step number，定位到 Dockerfile.prod 对应行
- **pnpm install 失败** → lockfile 和 package.json 不同步。本地跑 `pnpm install` 重新生成 lockfile commit
- **Next build 失败** → 本地 `docker compose exec app pnpm next build` 复现。常见是 standalone tracing 追不到某个 module，加 `outputFileTracingIncludes` 到 `next.config.ts`
- **Prisma generate 失败** → 看是不是 `binaryTargets` 漏了

---

## 5. Trigger deploy 失败

**症状**：镜像推成功了，但 "Trigger deploy over SSH" 步骤报错。

**常见原因**：
- **Permission denied (publickey)** → `SSH_KEY` secret 不对，或 deploy 用户的 authorized_keys 没设对
- **Host key verification failed** → appleboy/ssh-action 默认 strict host checking 关。如果手工设了 `strict_host_key_checking: true` 要删掉
- **connect: connection refused** → 腾讯云安全组没放行 22 端口给 GH Actions IP 段（GH Actions IP 不固定，只能放 0.0.0.0/0）
- **deploy.sh: command not found** → scripts 没复制到 `/srv/arbitrage/`，见 bootstrap Step 8

---

## 6. Migration 失败

**症状**：deploy.sh 在 step 3 退出 code 3，Telegram 发了失败通知 "prisma migrate deploy failed"。

**检查**：
\`\`\`bash
ssh deploy@<server-ip>
cd /srv/arbitrage
# 重跑 migration 看详细错误
TAG=$(cat .failed-tag) docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  -e DATABASE_URL="postgresql://arbitrage:${DB_PASSWORD}@postgres:5432/arbitrage" \
  app node_modules/.bin/prisma migrate deploy
\`\`\`

**常见原因**：
- Migration 写了破坏性改动，存量数据违反新约束 → 看 migration-guide.md
- Migration 已经部分成功，Prisma 状态错乱 → `prisma migrate status` 查看、可能需要 `prisma migrate resolve`

**修复流程**：手工修数据 / 改 migration SQL → 重新打一个修复 tag（比如 `v0.1.2-hotfix`）重新部署。

---

## 7. Health check 失败（回滚成功）

**症状**：Telegram 收到 "Deploy failed: vX.Y.Z / Rolled back to vA.B.C"。

**这是正常的自动回滚路径**。检查：
1. 线上仍是旧版本在跑（`curl https://arbitrage.tadacamp.com/api/health` 应该 200）
2. **手工比对交易所实际仓位 vs 数据库 positions 表**（spec 第 2.Q7 要求）
3. 看新镜像的日志定位 bug：
   \`\`\`bash
   docker image pull ghcr.io/caiyin-bit/arbitrage:<failed-tag>
   docker run --rm ghcr.io/caiyin-bit/arbitrage:<failed-tag>  # 看启动错误
   \`\`\`
4. 修 bug 后重新打 tag 部署

---

## 8. 回滚也失败

**症状**：Telegram "Service may be down — manual intervention required"。

**这是最严重的情况**。可能路径：
- 首次部署失败（没有旧 tag 可回滚）
- 旧镜像也拉不起来（极少见）
- DB restore 失败（psql 报错）

**应急**：
1. `ssh deploy@<server-ip>`
2. `cd /srv/arbitrage && ls backups/` 找最近的 dump
3. 手动回滚：
   \`\`\`bash
   # 拉一个确定能跑的老 tag
   TAG=<known-good> docker compose --env-file .env.production -f docker-compose.prod.yml up -d app
   # 手动 restore DB
   gunzip -c backups/<dump>.sql.gz | docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres psql -U arbitrage arbitrage
   \`\`\`
4. 修完后写一份 post-mortem 到 `docs/incidents/`

---

## 9. Telegram 收不到通知

**检查顺序**：
1. `/srv/arbitrage/.env.production` 里 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 都非空
2. 手动跑 `/srv/arbitrage/scripts/notify-deploy.sh` 模拟一次：
   \`\`\`bash
   DEPLOY_KIND=deploy_succeeded DEPLOY_TAG=test DEPLOY_PREV_TAG=v0.0.1 DEPLOY_DURATION=10 \
     /srv/arbitrage/scripts/notify-deploy.sh
   \`\`\`
3. 直接 curl Telegram API 检查 token：
   \`\`\`bash
   curl "https://api.telegram.org/bot<TOKEN>/getMe"
   \`\`\`

---

## 10. 磁盘满

**症状**：`df -h /` 接近 100%。

**清理命令**：
\`\`\`bash
# 删旧 docker 镜像（保留最近 3 个 tag）
docker image ls ghcr.io/caiyin-bit/arbitrage --format '{{.Tag}} {{.ID}}' | \
  grep -v latest | sort -rV | tail -n +4 | awk '{print $2}' | xargs -r docker image rm

# 删旧 pg_dump（保留最近 10 个）
ls -1t /srv/arbitrage/backups/pre-deploy-*.sql.gz | tail -n +11 | xargs -r rm

# docker 系统清理
docker system prune -f
\`\`\`

**长期解决**：加 cron 每周自动跑上面的清理命令。Plan 3 follow-up 项。

---

## 11. Seed 在 prod image 里跑不了

**症状**：bootstrap step 10.6 跑 seed 报 `Cannot find module 'tsx'` 或 `Cannot find module '/app/dist/server/db/seed.js'`。

**原因**：Next standalone build 只打包 `next` 运行时需要的文件，不会包含 `src/server/db/seed.ts`（tsx 脚本）也不跑 tsc。

**应急方案**：首次用 dev image 跑一次 seed：
\`\`\`bash
# 在开发机器上（不是服务器），连服务器的 postgres
ssh -L 55432:postgres:5432 deploy@<server-ip> &
# 等隧道建立
DATABASE_URL=postgresql://arbitrage:<DB_PASSWORD>@localhost:55432/arbitrage pnpm tsx src/server/db/seed.ts
kill %1
\`\`\`

**长期方案**（Plan 3 follow-up）：把 seed 编译成 `.next/standalone/seed.js` 或者在 Dockerfile.prod 里显式 COPY `src/server/db/seed.ts` 和 tsx runtime。
```

- [ ] **Step 2: Commit**

```bash
git add docs/deploy/troubleshooting.md
git commit -m "docs(plan3): troubleshooting cheatsheet for common deploy failures"
```

---

## Task 17: `deploy.sh` dry-run 集成测试

**Files:**
- Create: `tests/integration/deploy-script.test.ts`

**Background:** 核心脚本 `deploy.sh` 的回滚路径是"真正测试不到就真的不 work"的那种代码。写一个集成测试：本地用 docker 起一套完整的 postgres + redis + 两个 tag 的假 app 镜像，跑一次 deploy.sh 让 health check 故意失败，验证：
1. pg_dump 文件被创建
2. 回滚后 .current-tag 保持旧值（或 .failed-tag 被创建）
3. app 容器运行的是旧 tag

这个测试**不需要真 Next.js 镜像** —— 构造两个简单的 "假 app" 镜像（一个健康、一个不健康）即可。

- [ ] **Step 1: 创建测试 fixture — 假 app 镜像构造**

先在 `tests/integration/fixtures/` 下准备两个 Dockerfile：

```bash
mkdir -p tests/integration/fixtures/fake-app-good
mkdir -p tests/integration/fixtures/fake-app-bad
```

`tests/integration/fixtures/fake-app-good/Dockerfile`：

```dockerfile
FROM node:20-alpine
WORKDIR /app
RUN cat > server.js <<'EOF'
const http = require("http");
http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok","checks":{"database":"ok","redis":"ok"}}');
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(3000, "0.0.0.0");
EOF
EXPOSE 3000
CMD ["node", "server.js"]
```

`tests/integration/fixtures/fake-app-bad/Dockerfile`：把 `"status":"ok"` / 200 改成 `res.writeHead(500)` + `'{"status":"down"}'`。其余一致。

- [ ] **Step 2: 创建测试用 `docker-compose.test.yml`**

`tests/integration/fixtures/docker-compose.test.yml`：

```yaml
services:
  app:
    image: ${TAG:-fake-app-good}
    ports:
      - "127.0.0.1:33000:3000"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://test:test@postgres:5432/test
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U test"]
      interval: 2s
      timeout: 2s
      retries: 10
  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 2s
      timeout: 2s
      retries: 10
```

**注意**：端口用 33000 避免和真的 dev `docker-compose.yml` 的 3000 冲突。

- [ ] **Step 3: 写集成测试**

`tests/integration/deploy-script.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURES = resolve(__dirname, "fixtures");
const DEPLOY_SCRIPT = resolve(__dirname, "../../scripts/deploy.sh");

function sh(cmd: string, opts: { cwd?: string; env?: NodeJS.ProcessEnv; allowFail?: boolean } = {}) {
  const result = spawnSync("bash", ["-c", cmd], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0 && !opts.allowFail) {
    console.error("STDOUT:", result.stdout);
    console.error("STDERR:", result.stderr);
    throw new Error(`Command failed (${result.status}): ${cmd}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("deploy.sh dry-run", () => {
  let deployRoot: string;

  beforeAll(() => {
    // Build fake images
    sh(`docker build -t fake-app-good ${FIXTURES}/fake-app-good`);
    sh(`docker build -t fake-app-bad ${FIXTURES}/fake-app-bad`);

    // Prepare isolated deploy root
    deployRoot = mkdtempSync(join(tmpdir(), "arbitrage-deploy-test-"));
    mkdirSync(join(deployRoot, "backups"));
    mkdirSync(join(deployRoot, "scripts"));

    // Write a compose file that points to the test fixture
    sh(`cp ${FIXTURES}/docker-compose.test.yml ${deployRoot}/docker-compose.prod.yml`);

    // Write a dummy .env.production (compose needs env_file even if empty fields)
    writeFileSync(join(deployRoot, ".env.production"), [
      "DB_PASSWORD=test",
      "TELEGRAM_BOT_TOKEN=",
      "TELEGRAM_CHAT_ID=",
    ].join("\n"));

    // Copy deploy.sh
    sh(`cp ${DEPLOY_SCRIPT} ${deployRoot}/deploy.sh && chmod +x ${deployRoot}/deploy.sh`);

    // Start postgres + redis first (deploy.sh expects them running)
    sh(`docker compose --env-file .env.production -f docker-compose.prod.yml up -d postgres redis`, { cwd: deployRoot });
    // Wait for health
    for (let i = 0; i < 15; i++) {
      const r = sh(`docker compose --env-file .env.production -f docker-compose.prod.yml ps --format json postgres`, { cwd: deployRoot, allowFail: true });
      if (r.stdout.includes('"healthy"')) break;
      execSync("sleep 1");
    }
  }, 120_000);

  afterAll(() => {
    if (deployRoot) {
      sh(`docker compose --env-file .env.production -f docker-compose.prod.yml down -v`, { cwd: deployRoot, allowFail: true });
      sh(`rm -rf ${deployRoot}`);
    }
  });

  it("success path: good image + health check all pass → .current-tag updated", () => {
    // First manually `up` the good image as "previous" so rollback has a baseline
    sh(`TAG=fake-app-good docker compose --env-file .env.production -f docker-compose.prod.yml up -d app`, { cwd: deployRoot });
    execSync("sleep 3");
    writeFileSync(join(deployRoot, ".current-tag"), "fake-app-good");

    // Now run deploy.sh with a new "tag" (same good image under a different alias)
    sh(`docker tag fake-app-good fake-app-v2`);

    // Point deploy.sh at our fixture via env overrides. We can't easily override
    // the compose file's image repo, so we rely on the test fixture already using
    // ${TAG:-fake-app-good} as the image ref.
    const result = sh(`./deploy.sh fake-app-v2`, {
      cwd: deployRoot,
      env: {
        DEPLOY_ROOT: deployRoot,
        HEALTH_ATTEMPTS: "2",
        HEALTH_INTERVAL: "2",
        NOTIFY_CMD: "/bin/true",  // skip notify
      },
    });

    expect(result.status).toBe(0);
    const currentTag = readFileSync(join(deployRoot, ".current-tag"), "utf8").trim();
    expect(currentTag).toBe("fake-app-v2");

    // Backup file should exist
    const backups = sh(`ls ${deployRoot}/backups/`).stdout.trim();
    expect(backups).toMatch(/pre-deploy-\d+/);
  }, 120_000);

  it("failure path: bad image triggers rollback to previous tag", () => {
    // Ensure .current-tag points to a good image before starting
    writeFileSync(join(deployRoot, ".current-tag"), "fake-app-good");
    sh(`TAG=fake-app-good docker compose --env-file .env.production -f docker-compose.prod.yml up -d app`, { cwd: deployRoot });
    execSync("sleep 3");

    const result = sh(`./deploy.sh fake-app-bad`, {
      cwd: deployRoot,
      env: {
        DEPLOY_ROOT: deployRoot,
        HEALTH_ATTEMPTS: "2",
        HEALTH_INTERVAL: "2",
        NOTIFY_CMD: "/bin/true",
      },
      allowFail: true,
    });

    expect(result.status).toBe(4);  // deploy.sh exits 4 on health check failure
    expect(existsSync(join(deployRoot, ".failed-tag"))).toBe(true);
    const failedTag = readFileSync(join(deployRoot, ".failed-tag"), "utf8").trim();
    expect(failedTag).toBe("fake-app-bad");

    // .current-tag should still be the good one (we don't rewrite it on failure)
    const currentTag = readFileSync(join(deployRoot, ".current-tag"), "utf8").trim();
    expect(currentTag).toBe("fake-app-good");

    // The running app container should be the good image
    const psOut = sh(`docker compose --env-file .env.production -f docker-compose.prod.yml ps --format json app`, { cwd: deployRoot }).stdout;
    expect(psOut).toContain("fake-app-good");
  }, 180_000);
});
```

**注意**：
1. `deploy.sh` 的 `compose` 函数对 `IMAGE` / `TAG` 的处理依赖 compose file 的 `${TAG:-latest}`。我们的测试 fixture compose 里写的是 `${TAG:-fake-app-good}`，所以通过 `TAG=<tag>` 环境变量传进去。
2. `deploy.sh` 里硬编码了 `IMAGE_REPO=ghcr.io/caiyin-bit/arbitrage`。测试靠 `SKIP_PULL=1` 跳过 `docker pull`（Task 9 已经支持这个 flag）+ 本地 `docker tag` 准备镜像。测试的 env 里已经传了 `SKIP_PULL: "1"`（如果实现时忘了要补回去）。

- [ ] **Step 4: 跑测试**

```bash
pnpm vitest run tests/integration/deploy-script.test.ts
```

预期：两个 test 都 PASS。首次 build 镜像会慢（~30s），后续 cache 命中快。

**可能出错点**：
- Docker daemon 不可用 → 测试跑不了。本地用 docker-desktop / OrbStack 的环境里跑（跟 dev.sh 一致）
- Ports 冲突 → 33000 端口被占。改 fixture compose 的 port。
- compose `down -v` 在 afterAll 超时 → 手动 `docker compose -f tests/integration/fixtures/docker-compose.test.yml down -v`

- [ ] **Step 5: Commit**

```bash
git add tests/integration/deploy-script.test.ts tests/integration/fixtures/
git add scripts/deploy.sh  # 如果 Task 9 的 deploy.sh 修了 SKIP_PULL
git commit -m "test(plan3): integration test for deploy.sh success + rollback paths"
```

---

## Task 18: 手动上线 smoke test

**Files:** 无代码改动，按 bootstrap runbook 真实执行。

**Background:** 所有代码就位后，按 `docs/deploy/bootstrap.md` 在真实服务器上做一次完整上线，拿到真实的"end-to-end 通了"信号。

- [ ] **Step 1: 预检查 —— CI 全绿**

确认：
- 最近一次 `push origin main` 在 GitHub Actions 上 `ci.yml` 是绿的
- 本地 `pnpm vitest run` 全绿
- 本地 `pnpm vitest run tests/integration/deploy-script.test.ts` 全绿

- [ ] **Step 2: 执行 bootstrap runbook Step 1-9**

按 `docs/deploy/bootstrap.md` 真的 ssh 上服务器把 1-9 步做完。**不要跳过任何一步**。

边做边在 plan 的 Step 2 勾 check。遇到 runbook 和现实不符的地方：
- 如果是 runbook 文档错 → 改 `docs/deploy/bootstrap.md` + commit
- 如果是代码错 → 回到对应 Task 修

- [ ] **Step 3: 执行 bootstrap Step 10（首次部署）**

按 runbook 做：
- 10.1 生成 ghcr.io PAT
- 10.2 服务器 docker login
- 10.3 打 tag `v0.1.0` 触发 release.yml（SSH 失败不要紧）
- 10.4 手动起 postgres + redis
- 10.5 手动跑 migration
- 10.6 手动跑 seed（如果 prod image 里 seed 跑不了，按 troubleshooting.md 第 11 节临时方案处理）
- 10.7 手动起 app + curl /api/health

- [ ] **Step 4: 执行 bootstrap Step 11（全链路 tag 触发部署）**

```bash
git tag v0.1.1
git push origin v0.1.1
```

观察：
1. GH Actions release.yml 整个 job 变绿
2. 服务器 `cat /srv/arbitrage/.current-tag` 应是 `v0.1.1`
3. **最关键**：Telegram 收到 `🚀 Deploy succeeded: v0.1.1 / Previous: v0.1.0 / Duration: XXs`

**如果第 3 步没收到** — 按 troubleshooting.md 第 9 节排查。

- [ ] **Step 5: 验证外部可达**

```bash
curl -sS -w "\nHTTP %{http_code}\n" https://arbitrage.tadacamp.com/api/health
curl -sS https://arbitrage.tadacamp.com/api/health | jq
```

预期：HTTP 200，`{"status":"ok","checks":{"database":"ok","redis":"ok"}}`。

- [ ] **Step 6: 故意让一次部署失败 —— 验证自动回滚**

做一个可控的故意失败：
1. 在仓库里临时写一个会在启动时抛错的改动。推荐最小化方案：改 `src/app/api/health/route.ts` 让它总返回 503（不要改崩服务器 —— 只让 health check 失败触发回滚路径）：
   ```ts
   export async function GET() {
     return NextResponse.json({ status: "error", checks: { database: "error", redis: "error" } }, { status: 503 });
   }
   ```
2. Commit 到一个临时分支，PR 到 main 合并（或者直接 main push）
3. `git tag v0.1.2-rollbacktest && git push origin v0.1.2-rollbacktest`
4. 观察 release.yml 整个跑完，**预期**：
   - Build + push 成功
   - SSH trigger deploy.sh 开始跑
   - deploy.sh step 5 health check 5 次全部失败
   - 自动回滚到 v0.1.1
   - Telegram 收到 `❌ Deploy failed: v0.1.2-rollbacktest / Rolled back to v0.1.1 / ...`
   - `curl https://arbitrage.tadacamp.com/api/health` 仍是 200（旧版本在跑）
   - `cat /srv/arbitrage/.current-tag` 仍是 `v0.1.1`
   - `cat /srv/arbitrage/.failed-tag` 是 `v0.1.2-rollbacktest`
5. 立即 revert 那个临时 commit：
   ```bash
   git revert HEAD
   git push origin main
   git tag v0.1.3 && git push origin v0.1.3
   ```
   验证 v0.1.3 正常部署成功。

- [ ] **Step 7: 清理 .failed-tag（手工）**

```bash
ssh deploy@<server-ip> 'rm -f /srv/arbitrage/.failed-tag'
```

- [ ] **Step 8: Commit plan 完成记录 + 收尾**

不需要额外代码 commit。如果 Step 2/3 过程中改了 bootstrap.md / troubleshooting.md 的话，在这里 final commit 一下：

```bash
git add docs/deploy/
git commit -m "docs(plan3): runbook fixes from real-world bootstrap walkthrough" || true
git push origin main
```

**Plan 3 完成标志**：验收标准全部达成
- [x] `git tag vX.Y.Z && git push --tags` → `https://arbitrage.tadacamp.com/api/health` 返回 200（Step 5）
- [x] 故意加一个启动时抛异常的改动 → deploy.sh 自动回滚，Telegram 收到 deploy_failed，旧版本仍在服务（Step 6）
- [x] CI workflow 对每个 PR 和 main push 自动跑通（Task 12 Step 4）
- [x] GitHub Actions 永远不接触真实 `.env.production`（验证：`gh secret list` 只有 SSH_* 四个）

---

## 实施完成后的动作

1. **发一条总结到 Telegram / 笔记**：Plan 3 交付时间、哪些 task 遇到问题、哪些文档需要修
2. **开 GitHub Issue 跟踪 follow-up**：
   - Cloudflare R2 异地备份
   - Seed 在 prod image 里跑通（Task 16 第 11 节的长期方案）
   - 日志聚合（Loki / Grafana）
   - CI cache 优化
3. **Update MEMORY.md**：记一条 project memory —— "Plan 3 上线完成 / 生产环境地址 / 当前 baseline tag"
