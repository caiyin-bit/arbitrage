# 注册登录系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给全站加上注册 / 登录 / 会话 / 邀请码系统，落实 `docs/superpowers/specs/2026-04-17-auth-system-design.md` 的团队共享 + 邀请码 + DB session + 三层鉴权方案。

**Architecture:** Prisma 新增 `User` / `Session` / `Invite` 三表；业务表不加 `userId`。cookie 存随机 token，DB 存其 sha256 hash。三层防线：`middleware.ts`（L1 cookie 存在性）+ `(dashboard)/layout.tsx`（L2 server-side session 校验）+ tRPC `protectedProcedure`（L3 数据门）；客户端 `QueryCache` / `MutationCache` 的 `onError` 做 401 兜底 redirect。

**Tech Stack:** Next.js 16 App Router (Node runtime for layout, edge for middleware) · React 19 · tRPC 11 · Prisma 6 · Postgres 15 · Redis 7 · ioredis · Vitest 4 · Tailwind v4 · TypeScript 5 · pnpm 10 · `node:crypto`（scrypt + randomBytes + sha256 + timingSafeEqual，零新依赖）.

**Dev prerequisite:** 所有 Task 假设 `./dev.sh` 已在另一终端跑着（Postgres + Redis healthy）。Prisma 相关命令通过 `docker compose run --rm app ...` 执行；tests 用 `pnpm test`（容器内 / 本机都可，见各 Task 的 Run 行）。

---

## 总体任务地图

| # | 范围 | 输出 |
|---|---|---|
| 1 | Schema（User/Session/Invite） | `prisma/schema.prisma` + db push |
| 2 | 密码工具 | `src/server/services/auth/password.ts` + unit |
| 3 | Cookie 工具 | `src/server/services/auth/cookie.ts` + unit |
| 4 | Session 工具 | `src/server/services/auth/session.ts` + unit |
| 5 | tRPC context + `protectedProcedure` + Origin | `src/server/api/trpc.ts` + `src/app/api/trpc/[trpc]/route.ts` |
| 6 | 业务 routers 切 protected | exchange / opportunity / position / settings / dashboard |
| 7 | authRouter 骨架（isBootstrap / me / logout） | `src/server/api/routers/auth.ts` + `root.ts` + unit |
| 8 | auth.register（Serializable + invite 原子消费） | auth.ts + unit（含并发） |
| 9 | auth.login（双层速率 + 恒定时延 + 统一响应） | auth.ts + unit |
| 10 | invite 三件套（create/list/revoke） | auth.ts + unit |
| 11 | middleware.ts（L1） | `middleware.ts` |
| 12 | dashboard layout server-side session（L2） | `src/app/(dashboard)/layout.tsx` |
| 13 | `(auth)` layout + login 页 | `src/app/(auth)/layout.tsx` + `login/page.tsx` |
| 14 | register 页 | `src/app/(auth)/register/page.tsx` |
| 15 | trpc-provider 客户端 401 兜底 | `src/components/trpc-provider.tsx` |
| 16 | Header UserMenu | `src/components/layout/user-menu.tsx` + header |
| 17 | Settings 邀请码 tab | `src/app/(dashboard)/settings/page.tsx` |
| 18 | 集成测试 | `tests/integration/auth-flow.test.ts` |
| 19 | 生成 Prisma migration 文件 | `prisma/migrations/*/migration.sql` |
| 20 | 手动 E2E smoke（验证清单，非 commit） | — |

---

## Task 1: Prisma schema — 新增 User / Session / Invite

**Files:**
- Modify: `prisma/schema.prisma`（追加到文件末尾）

- [ ] **Step 1: 在 `prisma/schema.prisma` 末尾追加三个模型**

```prisma
// -----------------------------------------------------------------------------
// Auth (registration / login / invite)
// -----------------------------------------------------------------------------

model User {
  id           String   @id @default(cuid())
  username     String   @unique
  passwordHash String   @map("password_hash")
  displayName  String?  @map("display_name")
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  sessions    Session[]
  invitesSent Invite[]  @relation("InviteCreator")
  invitesUsed Invite[]  @relation("InviteUser")

  @@map("users")
}

model Session {
  // tokenHash = sha256(cookie_token). 主键是 hash 不是明文 token，即便 DB 读权限泄漏也不能接管会话。
  tokenHash  String   @id @map("token_hash")
  userId     String   @map("user_id")
  expiresAt  DateTime @map("expires_at")
  userAgent  String?  @map("user_agent")
  ipAddress  String?  @map("ip_address")
  createdAt  DateTime @default(now()) @map("created_at")
  lastSeenAt DateTime @default(now()) @map("last_seen_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
  @@map("sessions")
}

model Invite {
  code      String    @id
  createdBy String    @map("created_by")
  usedBy    String?   @map("used_by")
  expiresAt DateTime  @map("expires_at")
  usedAt    DateTime? @map("used_at")
  createdAt DateTime  @default(now()) @map("created_at")

  creator User  @relation("InviteCreator", fields: [createdBy], references: [id])
  user    User? @relation("InviteUser", fields: [usedBy], references: [id])

  @@index([createdBy])
  @@map("invites")
}
```

- [ ] **Step 2: 同步 schema 到 dev DB**

Run:
```
docker compose run --rm app sh -c "pnpm prisma db push && pnpm prisma generate"
```
Expected: 输出 "Your database is now in sync with your Prisma schema" + 生成 client；无 TypeScript 编译错误。

- [ ] **Step 3: 确认表结构**

Run:
```
docker compose exec postgres psql -U arbitrage -c '\dt'
```
Expected: 列出原 8 张表 + 新 3 张：`users`、`sessions`、`invites`。

- [ ] **Step 4: Commit**

```
git add prisma/schema.prisma
git commit -m "feat(auth): add User/Session/Invite Prisma models"
```

---

## Task 2: Password 工具（hashPassword / verifyPassword）

**Files:**
- Create: `src/server/services/auth/password.ts`
- Test: `tests/unit/auth/password.test.ts`

- [ ] **Step 1: 写失败的单测**

Create `tests/unit/auth/password.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/server/services/auth/password";

describe("password", () => {
  it("round-trips: verify returns true for the correct password", () => {
    const hash = hashPassword("hunter2");
    expect(verifyPassword("hunter2", hash)).toBe(true);
  });

  it("returns false for wrong password", () => {
    const hash = hashPassword("hunter2");
    expect(verifyPassword("hunter3", hash)).toBe(false);
  });

  it("returns false for malformed stored hash (no separator)", () => {
    expect(verifyPassword("x", "not-a-valid-hash")).toBe(false);
  });

  it("returns false for malformed stored hash (empty halves)", () => {
    expect(verifyPassword("x", "$")).toBe(false);
  });

  it("two hashes of the same password differ (salted)", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/auth/password.test.ts`
Expected: FAIL — `Cannot find module '@/server/services/auth/password'`。

- [ ] **Step 3: 实现模块**

Create `src/server/services/auth/password.ts`:

```ts
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 64;
const SALT_LEN = 16;

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(plain, salt, KEYLEN, { N, r, p });
  return `${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[0], "base64");
    expected = Buffer.from(parts[1], "base64");
  } catch {
    return false;
  }
  if (salt.length !== SALT_LEN || expected.length !== KEYLEN) return false;
  const actual = scryptSync(plain, salt, KEYLEN, { N, r, p });
  return timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test tests/unit/auth/password.test.ts`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```
git add src/server/services/auth/password.ts tests/unit/auth/password.test.ts
git commit -m "feat(auth): password hashing with node:crypto scrypt"
```

---

## Task 3: Cookie 工具（parse / serialize）

**Files:**
- Create: `src/server/services/auth/cookie.ts`
- Test: `tests/unit/auth/cookie.test.ts`

- [ ] **Step 1: 写失败的单测**

Create `tests/unit/auth/cookie.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseCookie, serializeSessionCookie, SESSION_COOKIE } from "@/server/services/auth/cookie";

describe("cookie", () => {
  it("parses a single cookie", () => {
    expect(parseCookie("a=1")).toEqual({ a: "1" });
  });

  it("parses multiple cookies", () => {
    expect(parseCookie("a=1; b=hello")).toEqual({ a: "1", b: "hello" });
  });

  it("returns {} for empty / undefined input", () => {
    expect(parseCookie("")).toEqual({});
    expect(parseCookie(undefined)).toEqual({});
  });

  it("url-decodes values", () => {
    expect(parseCookie("x=hello%20world")).toEqual({ x: "hello world" });
  });

  it("serializeSessionCookie emits HttpOnly + Lax + Path + Max-Age, no Secure in dev", () => {
    const s = serializeSessionCookie("tok123", 604800, false);
    expect(s).toContain(`${SESSION_COOKIE}=tok123`);
    expect(s).toContain("HttpOnly");
    expect(s).toContain("SameSite=Lax");
    expect(s).toContain("Path=/");
    expect(s).toContain("Max-Age=604800");
    expect(s).not.toContain("Secure");
  });

  it("serializeSessionCookie adds Secure in prod", () => {
    expect(serializeSessionCookie("tok", 604800, true)).toContain("Secure");
  });

  it("serializeSessionCookie with maxAge=0 clears cookie", () => {
    const s = serializeSessionCookie("", 0, false);
    expect(s).toContain("Max-Age=0");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/auth/cookie.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: 实现**

Create `src/server/services/auth/cookie.ts`:

```ts
export const SESSION_COOKIE = "arb_session";

export function parseCookie(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function serializeSessionCookie(
  token: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm test tests/unit/auth/cookie.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```
git add src/server/services/auth/cookie.ts tests/unit/auth/cookie.test.ts
git commit -m "feat(auth): cookie parse/serialize helpers"
```

---

## Task 4: Session 工具（create / get / destroy + token/hash 双层）

**Files:**
- Create: `src/server/services/auth/session.ts`
- Test: `tests/unit/auth/session.test.ts`

- [ ] **Step 1: 写失败的单测**

Create `tests/unit/auth/session.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/server/db/client";
import {
  createSession,
  getSessionUser,
  destroySession,
  hashToken,
  SESSION_TTL_SECONDS,
} from "@/server/services/auth/session";

async function makeUser() {
  return prisma.user.create({
    data: { username: `u_${Math.random().toString(36).slice(2, 8)}`, passwordHash: "x$y" },
  });
}

describe("session", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.invite.deleteMany();
    await prisma.user.deleteMany();
  });

  it("createSession returns a token whose sha256 matches the DB row", async () => {
    const user = await makeUser();
    const { token, expiresAt } = await createSession(user.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const row = await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe(user.id);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + (SESSION_TTL_SECONDS - 60) * 1000);
    expect(expiresAt.getTime()).toBe(row!.expiresAt.getTime());
  });

  it("token in cookie is NOT equal to the DB primary key (hash storage check)", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const hashed = hashToken(token);
    expect(token).not.toBe(hashed);
    const lookupByRawToken = await prisma.session.findUnique({ where: { tokenHash: token } });
    expect(lookupByRawToken).toBeNull();
  });

  it("getSessionUser returns the user for a valid token, null for a random one", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const got = await getSessionUser(token);
    expect(got?.id).toBe(user.id);
    expect(await getSessionUser("does-not-exist")).toBeNull();
  });

  it("using the stored tokenHash as a fake cookie token does NOT hit the session (regression for DB-read takeover)", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    const stolenFromDb = hashToken(token);
    expect(await getSessionUser(stolenFromDb)).toBeNull();
  });

  it("getSessionUser on an expired session returns null and deletes the row", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await prisma.session.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await getSessionUser(token)).toBeNull();
    expect(await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } })).toBeNull();
  });

  it("getSessionUser slides expiresAt forward on a valid hit", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await prisma.session.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() + 60_000) },
    });
    const before = (await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } }))!.expiresAt;
    await getSessionUser(token);
    const after = (await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } }))!.expiresAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it("destroySession deletes the row; subsequent getSessionUser returns null", async () => {
    const user = await makeUser();
    const { token } = await createSession(user.id);
    await destroySession(token);
    expect(await getSessionUser(token)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/auth/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: 实现模块**

Create `src/server/services/auth/session.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/server/db/client";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7d

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  userAgent?: string | null,
  ipAddress?: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await prisma.session.create({
    data: {
      tokenHash,
      userId,
      expiresAt,
      userAgent: userAgent ?? null,
      ipAddress: ipAddress ?? null,
    },
  });
  return { token, expiresAt };
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string | null;
}

export async function getSessionUser(token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, username: true, displayName: true } } },
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    // best-effort cleanup; ignore errors if another request deletes first
    await prisma.session.delete({ where: { tokenHash } }).catch(() => {});
    return null;
  }
  // sliding renewal
  await prisma.session.update({
    where: { tokenHash },
    data: {
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
      lastSeenAt: new Date(),
    },
  });
  return row.user;
}

export async function destroySession(token: string): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  await prisma.session.deleteMany({ where: { tokenHash } });
}
```

- [ ] **Step 4: 运行测试**

Run: `pnpm test tests/unit/auth/session.test.ts`
Expected: 7 passing（容器内运行时序敏感测试：若 sliding 测试偶尔失败可把 `> before.getTime()` 改成 `>= before.getTime()`，但应总能 pass，因为我们手动把 expiresAt 拨早了）。

- [ ] **Step 5: Commit**

```
git add src/server/services/auth/session.ts tests/unit/auth/session.test.ts
git commit -m "feat(auth): session store with token/hash double-layer"
```

---

## Task 5: tRPC context + protectedProcedure + Origin 校验

**Files:**
- Modify: `src/server/api/trpc.ts`
- Modify: `src/app/api/trpc/[trpc]/route.ts`
- Test: `tests/unit/auth/trpc-context.test.ts`

- [ ] **Step 1: 写失败的单测**

Create `tests/unit/auth/trpc-context.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createTRPCContext } from "@/server/api/trpc";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/services/auth/session";
import { SESSION_COOKIE } from "@/server/services/auth/cookie";

function makeOpts({
  cookie,
  origin,
  method = "POST",
}: { cookie?: string; origin?: string; method?: string }) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (origin) headers.set("origin", origin);
  const req = new Request("http://localhost:3000/api/trpc/x", { method, headers });
  return { req, resHeaders: new Headers(), info: {} as never };
}

describe("createTRPCContext", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();
  });

  it("injects user=null when no cookie", async () => {
    const ctx = await createTRPCContext(makeOpts({}) as never);
    expect(ctx.user).toBeNull();
  });

  it("injects the user when a valid session cookie is present", async () => {
    const user = await prisma.user.create({
      data: { username: "alice", passwordHash: "x$y" },
    });
    const { token } = await createSession(user.id);
    const ctx = await createTRPCContext(
      makeOpts({ cookie: `${SESSION_COOKIE}=${token}` }) as never,
    );
    expect(ctx.user?.id).toBe(user.id);
    expect(ctx.user?.username).toBe("alice");
  });

  it("throws 403 when POST has a mismatched Origin", async () => {
    await expect(
      createTRPCContext(makeOpts({ origin: "https://evil.example" }) as never),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows POST with matching Origin", async () => {
    const ctx = await createTRPCContext(
      makeOpts({ origin: "http://localhost:3000" }) as never,
    );
    expect(ctx.user).toBeNull(); // no cookie, but not thrown
  });

  it("allows POST with missing Origin (legacy clients)", async () => {
    const ctx = await createTRPCContext(makeOpts({}) as never);
    expect(ctx.user).toBeNull();
  });

  it("does not check Origin for GET (queries work from any link preview)", async () => {
    const ctx = await createTRPCContext(
      makeOpts({ method: "GET", origin: "https://evil.example" }) as never,
    );
    expect(ctx.user).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/auth/trpc-context.test.ts`
Expected: FAIL — 现在的 `createTRPCContext` 签名是 `async ()`，不接受 opts；也无 Origin 校验。

- [ ] **Step 3: 重写 tRPC context + protectedProcedure**

Replace `src/server/api/trpc.ts` entirely:

```ts
import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import superjson from "superjson";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { parseCookie, SESSION_COOKIE } from "@/server/services/auth/cookie";
import { getSessionUser, type SessionUser } from "@/server/services/auth/session";

const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3000";

export async function createTRPCContext(opts: FetchCreateContextFnOptions) {
  const { req, resHeaders } = opts;

  // CSRF defense-in-depth: reject POST with a mismatched Origin. Missing Origin
  // is allowed (covers SameSite-Lax-only POSTs from older clients and server-side
  // tRPC callers). SameSite=Lax still blocks the cross-site submit scenario.
  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin && origin !== APP_ORIGIN) {
      throw new TRPCError({ code: "FORBIDDEN", message: "bad origin" });
    }
  }

  const cookies = parseCookie(req.headers.get("cookie"));
  const token = cookies[SESSION_COOKIE] ?? null;
  const user: SessionUser | null = token ? await getSessionUser(token) : null;

  return {
    prisma,
    redis,
    user,
    sessionToken: token,
    resHeaders,
    req,
  };
}

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
```

- [ ] **Step 4: 更新 tRPC fetch adapter 传 full opts**

Replace `src/app/api/trpc/[trpc]/route.ts`:

```ts
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: (opts) => createTRPCContext(opts),
  });

export { handler as GET, handler as POST };
```

- [ ] **Step 5: 运行测试**

Run: `pnpm test tests/unit/auth/trpc-context.test.ts`
Expected: 6 passing.

- [ ] **Step 6: 确认业务 tRPC 现有测试仍通过（若有）**

Run: `pnpm test`
Expected: 若原先有业务单测且使用 `createTRPCContext`，签名变更可能引起 TS 报错。如果命中，**暂时**在那些调用处加 `as any` 以解锁此 Task；Task 6 / Task 7 后会自然清理。任何通过 HTTP 端点走完整链路的测试应仍 pass。

- [ ] **Step 7: Commit**

```
git add src/server/api/trpc.ts src/app/api/trpc/\[trpc\]/route.ts \
        tests/unit/auth/trpc-context.test.ts
git commit -m "feat(auth): tRPC context reads session cookie + Origin CSRF check + protectedProcedure"
```

---

## Task 6: 业务 routers 切到 `protectedProcedure`

**Files:**
- Modify: `src/server/api/routers/exchange.ts`
- Modify: `src/server/api/routers/opportunity.ts`
- Modify: `src/server/api/routers/position.ts`
- Modify: `src/server/api/routers/settings.ts`
- Modify: `src/server/api/routers/dashboard.ts`

- [ ] **Step 1: 批量替换 `publicProcedure` → `protectedProcedure`**

在每个 router 文件里：
1. 把 `import { router, publicProcedure } from "../trpc";` 改成 `import { router, protectedProcedure } from "../trpc";`
2. 全文把 `publicProcedure` 替换成 `protectedProcedure`

完成后各 router 应长成：
```ts
import { router, protectedProcedure } from "../trpc";
// ...
export const exchangeRouter = router({
  list: protectedProcedure.query(...),
  create: protectedProcedure.input(...).mutation(...),
  // ...
});
```

- [ ] **Step 2: 本地冒烟 — 没登录时 /api/trpc/dashboard.* 应返 UNAUTHORIZED**

Run:
```
curl -i -X POST http://localhost:3000/api/trpc/dashboard.overview \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://localhost:3000' \
  -d '{}'
```
Expected: HTTP 200（tRPC 错误通过 body 返回）+ body 里包含 `"code":"UNAUTHORIZED"` / `"httpStatus":401` 字段。

- [ ] **Step 3: Commit**

```
git add src/server/api/routers/*.ts
git commit -m "feat(auth): switch business tRPC routers to protectedProcedure"
```

> 此时访问 http://localhost:3000 页面会加载但所有 tRPC 查询报错。这是预期——后续 Task 建 login 页和 UI 后闭环。

---

## Task 7: authRouter 骨架（isBootstrap / me / logout）

**Files:**
- Create: `src/server/api/routers/auth.ts`
- Modify: `src/server/api/root.ts`
- Test: `tests/unit/auth/auth-router.test.ts`

- [ ] **Step 1: 写失败的单测**

Create `tests/unit/auth/auth-router.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { createSession, hashToken } from "@/server/services/auth/session";
import type { TRPCContext } from "@/server/api/trpc";

function ctx(overrides: Partial<TRPCContext> = {}): TRPCContext {
  return {
    prisma,
    redis,
    user: null,
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST" }),
    ...overrides,
  } as TRPCContext;
}

describe("auth router — isBootstrap / me / logout", () => {
  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.invite.deleteMany();
    await prisma.user.deleteMany();
  });

  it("isBootstrap=true when the users table is empty", async () => {
    const caller = appRouter.createCaller(ctx());
    expect(await caller.auth.isBootstrap()).toEqual({ isBootstrap: true });
  });

  it("isBootstrap=false after a user exists", async () => {
    await prisma.user.create({ data: { username: "first", passwordHash: "x$y" } });
    const caller = appRouter.createCaller(ctx());
    expect(await caller.auth.isBootstrap()).toEqual({ isBootstrap: false });
  });

  it("me returns null when no session", async () => {
    const caller = appRouter.createCaller(ctx());
    expect(await caller.auth.me()).toBeNull();
  });

  it("me returns { id, username, displayName } (never passwordHash)", async () => {
    const user = await prisma.user.create({
      data: { username: "alice", passwordHash: "secret$hash", displayName: "Alice" },
    });
    const caller = appRouter.createCaller(ctx({ user }));
    const me = await caller.auth.me();
    expect(me).toEqual({ id: user.id, username: "alice", displayName: "Alice" });
    expect((me as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it("logout deletes the session row and sets a clearing cookie", async () => {
    const user = await prisma.user.create({ data: { username: "bob", passwordHash: "x$y" } });
    const { token } = await createSession(user.id);
    const c = ctx({ user, sessionToken: token });
    const caller = appRouter.createCaller(c);
    await caller.auth.logout();
    expect(
      await prisma.session.findUnique({ where: { tokenHash: hashToken(token) } }),
    ).toBeNull();
    const setCookie = c.resHeaders.get("set-cookie");
    expect(setCookie).toContain("Max-Age=0");
  });

  it("logout without a session throws UNAUTHORIZED", async () => {
    const caller = appRouter.createCaller(ctx());
    await expect(caller.auth.logout()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/auth/auth-router.test.ts`
Expected: FAIL — `auth` not in `appRouter`.

- [ ] **Step 3: 实现 authRouter 骨架**

Create `src/server/api/routers/auth.ts`:

```ts
import { router, publicProcedure, protectedProcedure } from "../trpc";
import { destroySession } from "@/server/services/auth/session";
import { serializeSessionCookie } from "@/server/services/auth/cookie";

const IS_PROD = process.env.NODE_ENV === "production";

function clearCookie(ctx: { resHeaders: Headers }) {
  ctx.resHeaders.append("set-cookie", serializeSessionCookie("", 0, IS_PROD));
}

export const authRouter = router({
  isBootstrap: publicProcedure.query(async ({ ctx }) => {
    const count = await ctx.prisma.user.count();
    return { isBootstrap: count === 0 };
  }),

  me: publicProcedure.query(({ ctx }) => {
    if (!ctx.user) return null;
    return {
      id: ctx.user.id,
      username: ctx.user.username,
      displayName: ctx.user.displayName,
    };
  }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    if (ctx.sessionToken) {
      await destroySession(ctx.sessionToken);
    }
    clearCookie(ctx);
    return { ok: true as const };
  }),
});
```

- [ ] **Step 4: 挂到 root**

Replace `src/server/api/root.ts`:

```ts
import { router } from "./trpc";
import { authRouter } from "./routers/auth";
import { exchangeRouter } from "./routers/exchange";
import { opportunityRouter } from "./routers/opportunity";
import { positionRouter } from "./routers/position";
import { settingsRouter } from "./routers/settings";
import { dashboardRouter } from "./routers/dashboard";

export const appRouter = router({
  auth: authRouter,
  exchange: exchangeRouter,
  opportunity: opportunityRouter,
  position: positionRouter,
  settings: settingsRouter,
  dashboard: dashboardRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 5: 运行测试**

Run: `pnpm test tests/unit/auth/auth-router.test.ts`
Expected: 6 passing.

- [ ] **Step 6: Commit**

```
git add src/server/api/routers/auth.ts src/server/api/root.ts \
        tests/unit/auth/auth-router.test.ts
git commit -m "feat(auth): authRouter scaffold — isBootstrap/me/logout"
```

---

## Task 8: auth.register（Serializable 事务 + invite 原子消费）

**Files:**
- Modify: `src/server/api/routers/auth.ts`
- Test: `tests/unit/auth/auth-register.test.ts`

- [ ] **Step 1: 写失败的单测**

Create `tests/unit/auth/auth-register.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import type { TRPCContext } from "@/server/api/trpc";

function freshCtx(): TRPCContext {
  return {
    prisma,
    redis,
    user: null,
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST" }),
  } as TRPCContext;
}

async function reset() {
  await prisma.session.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.user.deleteMany();
}

describe("auth.register", () => {
  beforeEach(reset);

  it("bootstrap: users table empty — no inviteCode required", async () => {
    const c = freshCtx();
    const caller = appRouter.createCaller(c);
    const out = await caller.auth.register({ username: "admin", password: "hunter22" });
    expect(out.user.username).toBe("admin");
    expect(await prisma.user.count()).toBe(1);
    expect(c.resHeaders.get("set-cookie")).toMatch(/arb_session=[^;]+/);
  });

  it("non-bootstrap: missing inviteCode rejects", async () => {
    await prisma.user.create({ data: { username: "first", passwordHash: "x$y" } });
    const caller = appRouter.createCaller(freshCtx());
    await expect(
      caller.auth.register({ username: "u2", password: "hunter22" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("non-bootstrap: valid invite consumes atomically — invite row shows usedBy/usedAt after", async () => {
    const admin = await prisma.user.create({ data: { username: "admin", passwordHash: "x$y" } });
    const inv = await prisma.invite.create({
      data: {
        code: "INV-1",
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const caller = appRouter.createCaller(freshCtx());
    const out = await caller.auth.register({
      username: "bob",
      password: "hunter22",
      inviteCode: "INV-1",
    });
    const used = await prisma.invite.findUnique({ where: { code: inv.code } });
    expect(used?.usedBy).toBe(out.user.id);
    expect(used?.usedAt).not.toBeNull();
  });

  it("non-bootstrap: already-used invite rejects", async () => {
    const admin = await prisma.user.create({ data: { username: "admin", passwordHash: "x$y" } });
    const bob = await prisma.user.create({ data: { username: "bob", passwordHash: "x$y" } });
    await prisma.invite.create({
      data: {
        code: "INV-USED",
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 3600_000),
        usedBy: bob.id,
        usedAt: new Date(),
      },
    });
    const caller = appRouter.createCaller(freshCtx());
    await expect(
      caller.auth.register({ username: "x", password: "hunter22", inviteCode: "INV-USED" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("non-bootstrap: expired invite rejects", async () => {
    const admin = await prisma.user.create({ data: { username: "admin", passwordHash: "x$y" } });
    await prisma.invite.create({
      data: {
        code: "INV-OLD",
        createdBy: admin.id,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const caller = appRouter.createCaller(freshCtx());
    await expect(
      caller.auth.register({ username: "x", password: "hunter22", inviteCode: "INV-OLD" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("duplicate username rejects (even in bootstrap)", async () => {
    const caller1 = appRouter.createCaller(freshCtx());
    await caller1.auth.register({ username: "dup", password: "hunter22" });
    const caller2 = appRouter.createCaller(freshCtx());
    await expect(
      caller2.auth.register({ username: "dup", password: "hunter22" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("concurrent bootstrap: only one of two simultaneous registers succeeds", async () => {
    const c1 = appRouter.createCaller(freshCtx());
    const c2 = appRouter.createCaller(freshCtx());
    const results = await Promise.allSettled([
      c1.auth.register({ username: "a", password: "hunter22" }),
      c2.auth.register({ username: "b", password: "hunter22" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(1);
    expect(await prisma.user.count()).toBe(1);
  });

  it("concurrent same-invite: only one of two register calls consumes the invite", async () => {
    const admin = await prisma.user.create({ data: { username: "admin", passwordHash: "x$y" } });
    await prisma.invite.create({
      data: {
        code: "RACE",
        createdBy: admin.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const c1 = appRouter.createCaller(freshCtx());
    const c2 = appRouter.createCaller(freshCtx());
    const results = await Promise.allSettled([
      c1.auth.register({ username: "r1", password: "hunter22", inviteCode: "RACE" }),
      c2.auth.register({ username: "r2", password: "hunter22", inviteCode: "RACE" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  });

  it("password shorter than 8 chars rejects with BAD_REQUEST", async () => {
    const caller = appRouter.createCaller(freshCtx());
    await expect(
      caller.auth.register({ username: "a", password: "short" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/auth/auth-register.test.ts`
Expected: FAIL — `auth.register` not defined.

- [ ] **Step 3: 实现 register**

Edit `src/server/api/routers/auth.ts` — 在 `authRouter = router({ ... })` 内部追加 `register`，并在文件顶部补 import：

```ts
// add to imports at top:
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { Prisma } from "@prisma/client";
import { hashPassword } from "@/server/services/auth/password";
import { createSession, SESSION_TTL_SECONDS } from "@/server/services/auth/session";

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const registerInput = z.object({
  username: z.string().regex(USERNAME_RE),
  password: z.string().min(8).max(200),
  displayName: z.string().max(64).optional(),
  inviteCode: z.string().min(1).max(100).optional(),
});

function writeCookie(ctx: { resHeaders: Headers }, token: string) {
  ctx.resHeaders.append("set-cookie", serializeSessionCookie(token, SESSION_TTL_SECONDS, IS_PROD));
}
```

Then add the procedure inside the router object (keep existing `isBootstrap`/`me`/`logout`):

```ts
register: publicProcedure.input(registerInput).mutation(async ({ ctx, input }) => {
  const passwordHash = hashPassword(input.password);
  const uaHeader = ctx.req.headers.get("user-agent");
  const ipHeader =
    ctx.req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  let userId: string;
  try {
    userId = await ctx.prisma.$transaction(
      async (tx) => {
        const userCount = await tx.user.count();
        if (userCount === 0) {
          // bootstrap path: ignore inviteCode
          const u = await tx.user.create({
            data: {
              username: input.username,
              passwordHash,
              displayName: input.displayName ?? null,
            },
          });
          return u.id;
        }
        if (!input.inviteCode) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "need invite code" });
        }
        const u = await tx.user.create({
          data: {
            username: input.username,
            passwordHash,
            displayName: input.displayName ?? null,
          },
        });
        const consumed = await tx.invite.updateMany({
          where: {
            code: input.inviteCode,
            usedBy: null,
            expiresAt: { gt: new Date() },
          },
          data: { usedBy: u.id, usedAt: new Date() },
        });
        if (consumed.count !== 1) {
          throw new TRPCError({ code: "UNAUTHORIZED", message: "invalid or used invite" });
        }
        return u.id;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new TRPCError({ code: "CONFLICT", message: "username taken" });
    }
    // Serializable conflict: Postgres returns 40001 / P2034. Surface as retriable.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      (e.code === "P2034" || (e.meta as { code?: string } | undefined)?.code === "40001")
    ) {
      throw new TRPCError({ code: "CONFLICT", message: "please retry" });
    }
    throw e;
  }

  const { token } = await createSession(userId, uaHeader, ipHeader);
  writeCookie(ctx, token);
  const user = await ctx.prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, username: true, displayName: true },
  });
  return { user };
}),
```

- [ ] **Step 4: 运行 register 测试**

Run: `pnpm test tests/unit/auth/auth-register.test.ts`
Expected: 9 passing. 如并发测试 `concurrent bootstrap` 偶尔两个都成功（取决于 Postgres 对 Serializable 的冲突检测时机），单独加一个 `User.username unique` 兜底就已经保证不会有两个同名用户——测试断言是 `User.count === 1`，而 `Promise.allSettled` 里 fulfilled 数量为 1 也由 unique 约束保证。这个设计是正确的。

- [ ] **Step 5: Commit**

```
git add src/server/api/routers/auth.ts tests/unit/auth/auth-register.test.ts
git commit -m "feat(auth): register procedure with Serializable tx and atomic invite consumption"
```

---

## Task 9: auth.login（双层速率限制 + 恒定时延 + 统一响应）

**Files:**
- Modify: `src/server/api/routers/auth.ts`
- Create: `src/server/services/auth/rate-limit.ts`
- Test: `tests/unit/auth/auth-login.test.ts`
- Test: `tests/unit/auth/rate-limit.test.ts`

- [ ] **Step 1: 写 rate-limit 模块的失败单测**

Create `tests/unit/auth/rate-limit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { redis } from "@/server/db/redis";
import { hitLoginBucket } from "@/server/services/auth/rate-limit";

describe("rate-limit", () => {
  beforeEach(async () => {
    await redis.flushdb();
  });

  it("increments the counter and returns remaining", async () => {
    const r1 = await hitLoginBucket("bucket:test", 3, 60);
    expect(r1.locked).toBe(false);
    expect(r1.count).toBe(1);
    const r2 = await hitLoginBucket("bucket:test", 3, 60);
    expect(r2.count).toBe(2);
  });

  it("returns locked=true once count exceeds max and applies lock TTL", async () => {
    await hitLoginBucket("bucket:lock", 2, 60);
    await hitLoginBucket("bucket:lock", 2, 60);
    const r = await hitLoginBucket("bucket:lock", 2, 60);
    expect(r.locked).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/auth/rate-limit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: 实现 rate-limit**

Create `src/server/services/auth/rate-limit.ts`:

```ts
import { redis } from "@/server/db/redis";

export async function hitLoginBucket(
  key: string,
  max: number,
  windowSeconds: number,
): Promise<{ locked: boolean; count: number }> {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, windowSeconds);
  return { locked: n > max, count: n };
}
```

- [ ] **Step 4: 运行 rate-limit 测试**

Run: `pnpm test tests/unit/auth/rate-limit.test.ts`
Expected: 2 passing.

- [ ] **Step 5: 写 login 测试**

Create `tests/unit/auth/auth-login.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import { hashPassword } from "@/server/services/auth/password";
import type { TRPCContext } from "@/server/api/trpc";

function ctxWithIp(ip: string): TRPCContext {
  const headers = new Headers({ "x-forwarded-for": ip });
  return {
    prisma,
    redis,
    user: null,
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST", headers }),
  } as TRPCContext;
}

async function reset() {
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
  await redis.flushdb();
}

describe("auth.login", () => {
  beforeEach(reset);

  it("wrong password rejects with UNAUTHORIZED and the canonical message", async () => {
    await prisma.user.create({
      data: { username: "alice", passwordHash: hashPassword("hunter22") },
    });
    const caller = appRouter.createCaller(ctxWithIp("1.1.1.1"));
    await expect(
      caller.auth.login({ username: "alice", password: "wrong" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "用户名或密码错误" });
  });

  it("nonexistent username returns the same error shape as wrong password", async () => {
    const caller = appRouter.createCaller(ctxWithIp("1.1.1.1"));
    await expect(
      caller.auth.login({ username: "ghost", password: "any" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: "用户名或密码错误" });
  });

  it("login takes at least 400ms on failure (constant-time guard)", async () => {
    await prisma.user.create({
      data: { username: "alice", passwordHash: hashPassword("hunter22") },
    });
    const caller = appRouter.createCaller(ctxWithIp("1.1.1.1"));
    const start = Date.now();
    await caller.auth.login({ username: "alice", password: "wrong" }).catch(() => {});
    expect(Date.now() - start).toBeGreaterThanOrEqual(400);
  });

  it("success: creates session and sets cookie", async () => {
    await prisma.user.create({
      data: { username: "alice", passwordHash: hashPassword("hunter22") },
    });
    const c = ctxWithIp("1.1.1.1");
    const caller = appRouter.createCaller(c);
    const out = await caller.auth.login({ username: "alice", password: "hunter22" });
    expect(out.user.username).toBe("alice");
    expect(c.resHeaders.get("set-cookie")).toMatch(/arb_session=[^;]+/);
    expect(await prisma.session.count()).toBe(1);
  });

  it("(IP, username) rate limit: 10 fails from same IP to same user locks that pair, but same user from different IP still works", async () => {
    await prisma.user.create({
      data: { username: "alice", passwordHash: hashPassword("hunter22") },
    });
    const bad = appRouter.createCaller(ctxWithIp("2.2.2.2"));
    for (let i = 0; i < 11; i++) {
      await bad.auth.login({ username: "alice", password: "wrong" }).catch(() => {});
    }
    const eleventh = bad.auth.login({ username: "alice", password: "hunter22" });
    await expect(eleventh).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    // different IP can still log in the same user
    const good = appRouter.createCaller(ctxWithIp("3.3.3.3"));
    const out = await good.auth.login({ username: "alice", password: "hunter22" });
    expect(out.user.username).toBe("alice");
  });

  it("IP rate limit: 30+ fails from same IP across different usernames locks the IP", async () => {
    const bad = appRouter.createCaller(ctxWithIp("9.9.9.9"));
    for (let i = 0; i < 31; i++) {
      await bad.auth
        .login({ username: `u${i}`, password: "wrong" })
        .catch(() => {});
    }
    await expect(
      bad.auth.login({ username: "anyone", password: "x" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `pnpm test tests/unit/auth/auth-login.test.ts`
Expected: FAIL — `auth.login` not defined.

- [ ] **Step 7: 实现 login**

Add to `src/server/api/routers/auth.ts` imports:
```ts
import { verifyPassword } from "@/server/services/auth/password";
import { hitLoginBucket } from "@/server/services/auth/rate-limit";
```

Add to the router object:

```ts
login: publicProcedure
  .input(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }))
  .mutation(async ({ ctx, input }) => {
    const ip =
      ctx.req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    const ipBucket = await hitLoginBucket(`login:ip:${ip}`, 30, 600);
    if (ipBucket.locked) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "请稍后再试" });
    }
    const pairBucket = await hitLoginBucket(
      `login:pair:${ip}:${input.username}`,
      10,
      600,
    );
    if (pairBucket.locked) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "请稍后再试" });
    }

    const ua = ctx.req.headers.get("user-agent");
    const delay = new Promise((r) => setTimeout(r, 400));

    const user = await ctx.prisma.user.findUnique({ where: { username: input.username } });
    const ok = user ? verifyPassword(input.password, user.passwordHash) : false;
    await delay;
    if (!user || !ok) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "用户名或密码错误" });
    }

    const { token } = await createSession(user.id, ua, ip === "unknown" ? null : ip);
    writeCookie(ctx, token);
    return {
      user: { id: user.id, username: user.username, displayName: user.displayName },
    };
  }),
```

- [ ] **Step 8: 运行 login 测试**

Run: `pnpm test tests/unit/auth/auth-login.test.ts`
Expected: 6 passing. 注意：第 5 个测试 reset 会清 redis，但测试体内循环跑完 11 次就锁定—不清除 DB 所以 user 仍在。

- [ ] **Step 9: Commit**

```
git add src/server/api/routers/auth.ts \
        src/server/services/auth/rate-limit.ts \
        tests/unit/auth/rate-limit.test.ts \
        tests/unit/auth/auth-login.test.ts
git commit -m "feat(auth): login with IP + (IP,username) rate limit, constant-time failure, unified message"
```

---

## Task 10: 邀请码三件套（createInvite / listInvites / revokeInvite）

**Files:**
- Modify: `src/server/api/routers/auth.ts`
- Test: `tests/unit/auth/auth-invites.test.ts`

- [ ] **Step 1: 写失败测试**

Create `tests/unit/auth/auth-invites.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import type { TRPCContext } from "@/server/api/trpc";

async function makeAuthedCtx(username = "admin"): Promise<TRPCContext> {
  const user = await prisma.user.create({
    data: { username, passwordHash: "x$y" },
  });
  return {
    prisma,
    redis,
    user: { id: user.id, username: user.username, displayName: user.displayName },
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST" }),
  } as TRPCContext;
}

async function reset() {
  await prisma.session.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.user.deleteMany();
}

describe("invites", () => {
  beforeEach(reset);

  it("createInvite returns a code, persists a row with createdBy=me and future expiresAt", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    const out = await caller.auth.createInvite();
    expect(out.code).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    const row = await prisma.invite.findUnique({ where: { code: out.code } });
    expect(row?.createdBy).toBe(c.user!.id);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("createInvite rejects without a session", async () => {
    const caller = appRouter.createCaller({
      prisma,
      redis,
      user: null,
      sessionToken: null,
      resHeaders: new Headers(),
      req: new Request("http://localhost:3000", { method: "POST" }),
    } as TRPCContext);
    await expect(caller.auth.createInvite()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("listInvites returns unused-active and recent-used arrays", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    await caller.auth.createInvite();
    await caller.auth.createInvite();
    await prisma.invite.create({
      data: {
        code: "USED",
        createdBy: c.user!.id,
        expiresAt: new Date(Date.now() + 3600_000),
        usedBy: c.user!.id,
        usedAt: new Date(),
      },
    });
    const out = await caller.auth.listInvites();
    expect(out.active).toHaveLength(2);
    expect(out.used).toHaveLength(1);
  });

  it("revokeInvite: unused invite becomes unusable (expiresAt moves to past)", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    const { code } = await caller.auth.createInvite();
    await caller.auth.revokeInvite({ code });
    const row = await prisma.invite.findUnique({ where: { code } });
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("revokeInvite: already-used invite rejects", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    await prisma.invite.create({
      data: {
        code: "U",
        createdBy: c.user!.id,
        expiresAt: new Date(Date.now() + 3600_000),
        usedBy: c.user!.id,
        usedAt: new Date(),
      },
    });
    await expect(caller.auth.revokeInvite({ code: "U" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("revokeInvite: unknown code rejects", async () => {
    const c = await makeAuthedCtx();
    const caller = appRouter.createCaller(c);
    await expect(caller.auth.revokeInvite({ code: "nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test tests/unit/auth/auth-invites.test.ts`
Expected: FAIL — invite procedures not defined.

- [ ] **Step 3: 实现**

Add to `src/server/api/routers/auth.ts` imports:
```ts
import { randomBytes } from "node:crypto";
```

Add three procedures to the router:

```ts
createInvite: protectedProcedure.mutation(async ({ ctx }) => {
  const code = randomBytes(16).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await ctx.prisma.invite.create({
    data: { code, createdBy: ctx.user.id, expiresAt },
  });
  return { code, expiresAt };
}),

listInvites: protectedProcedure.query(async ({ ctx }) => {
  const now = new Date();
  const active = await ctx.prisma.invite.findMany({
    where: { usedBy: null, expiresAt: { gt: now } },
    include: { creator: { select: { username: true } } },
    orderBy: { createdAt: "desc" },
  });
  const used = await ctx.prisma.invite.findMany({
    where: { usedBy: { not: null } },
    include: {
      creator: { select: { username: true } },
      user: { select: { username: true } },
    },
    orderBy: { usedAt: "desc" },
    take: 50,
  });
  return { active, used };
}),

revokeInvite: protectedProcedure
  .input(z.object({ code: z.string().min(1).max(100) }))
  .mutation(async ({ ctx, input }) => {
    const row = await ctx.prisma.invite.findUnique({ where: { code: input.code } });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "invite not found" });
    if (row.usedBy) throw new TRPCError({ code: "BAD_REQUEST", message: "already used" });
    await ctx.prisma.invite.update({
      where: { code: input.code },
      data: { expiresAt: new Date(0) },
    });
    return { ok: true as const };
  }),
```

- [ ] **Step 4: 运行测试**

Run: `pnpm test tests/unit/auth/auth-invites.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```
git add src/server/api/routers/auth.ts tests/unit/auth/auth-invites.test.ts
git commit -m "feat(auth): invite code create/list/revoke procedures"
```

---

## Task 11: middleware.ts（L1 — 未登录跳 /login）

**Files:**
- Create: `middleware.ts`（仓库根）

- [ ] **Step 1: 实现 middleware**

Create `middleware.ts` at the repository root:

```ts
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "arb_session";

// 受保护的顶级 path 前缀（对应 (dashboard) 路由组的所有页面）
const PROTECTED_PREFIXES = ["/", "/opportunities", "/positions", "/backtest", "/settings"];
// 放行的 path（精确或前缀）
const PUBLIC_PATHS = ["/login", "/register"];
const PUBLIC_PREFIXES = ["/api/trpc", "/api/health", "/_next", "/favicon"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();
  for (const p of PUBLIC_PREFIXES) {
    if (pathname === p || pathname.startsWith(`${p}/`)) return NextResponse.next();
  }

  const isProtected =
    pathname === "/" ||
    PROTECTED_PREFIXES.some((p) => p !== "/" && (pathname === p || pathname.startsWith(`${p}/`)));
  if (!isProtected) return NextResponse.next();

  if (req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.next();
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
```

- [ ] **Step 2: 冒烟验证**

启动 dev 环境（`./dev.sh` 已在跑），清一下会话 cookie（浏览器 DevTools → Application → Cookies），然后：

```
curl -i http://localhost:3000/ -o /dev/null
```
Expected: `HTTP/1.1 307 Temporary Redirect`（Next.js 用 307）+ `Location: /login?next=%2F`。

```
curl -i http://localhost:3000/login -o /dev/null
```
Expected: 200（页面还不存在，会是 404 from Next — Task 13 建完后就 200）。这里关键是 **不** 302 到 `/login` 再死循环。

- [ ] **Step 3: Commit**

```
git add middleware.ts
git commit -m "feat(auth): repo-root middleware gates (dashboard) routes by cookie presence"
```

---

## Task 12: `(dashboard)/layout.tsx` 服务端 session 校验（L2）

**Files:**
- Modify: `src/app/(dashboard)/layout.tsx`

- [ ] **Step 1: 改 dashboard layout 为 server component 里调 session**

Replace `src/app/(dashboard)/layout.tsx`:

```tsx
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { SESSION_COOKIE } from "@/server/services/auth/cookie";
import { getSessionUser } from "@/server/services/auth/session";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value ?? null;
  const user = token ? await getSessionUser(token) : null;
  if (!user) {
    // L2 无法拿到 pathname — 不带 next；L1 middleware 在无 cookie 首访时已带 next。
    redirect("/login");
  }

  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 冒烟**

- 把 dev 容器里的 session 表清空：`docker compose exec postgres psql -U arbitrage -c 'TRUNCATE sessions CASCADE;'`
- 在浏览器手动给 `http://localhost:3000` 加一个假 `arb_session=garbage` cookie（DevTools）
- 刷新 → 预期 307 → `/login`（L2 校验到 session 无效）。
- `curl -i -H 'Cookie: arb_session=garbage' http://localhost:3000/` 也能看到 307 Location: /login。

- [ ] **Step 3: Commit**

```
git add src/app/\(dashboard\)/layout.tsx
git commit -m "feat(auth): dashboard layout server-side session check (Layer 2)"
```

---

## Task 13: `(auth)` 路由组 + 登录页

**Files:**
- Create: `src/app/(auth)/layout.tsx`
- Create: `src/app/(auth)/login/page.tsx`

- [ ] **Step 1: `(auth)` 共用 layout**

Create `src/app/(auth)/layout.tsx`:

```tsx
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-[400px]">
        <div className="text-center mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Funding Rate Arbitrage
          </h1>
        </div>
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: login 页**

Create `src/app/(auth)/login/page.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

export default function LoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const login = trpc.auth.login.useMutation({
    onSuccess: () => {
      const next = search.get("next");
      router.push(next && next.startsWith("/") ? next : "/");
      router.refresh();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        login.mutate({ username, password });
      }}
    >
      <h2 className="text-lg font-semibold text-foreground">登录</h2>

      <div className="space-y-1.5">
        <Label htmlFor="username">用户名</Label>
        <Input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">密码</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" className="w-full" disabled={login.isPending}>
        {login.isPending ? "登录中..." : "登录"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        还没账号？
        <Link href="/register" className="ml-1 text-primary hover:underline">
          去注册
        </Link>
      </p>
    </form>
  );
}
```

- [ ] **Step 3: 冒烟**

- 浏览器访问 `http://localhost:3000/login` — 应看到居中卡片 + 用户名密码表单。
- 随便输入登录 → 应该回"用户名或密码错误"（约 400ms 后）。
- 如果此时 user 表是空的，该错误也正常——登录对空表就是无效。

- [ ] **Step 4: Commit**

```
git add src/app/\(auth\)/layout.tsx src/app/\(auth\)/login/page.tsx
git commit -m "feat(auth): (auth) route group layout + /login page"
```

---

## Task 14: 注册页

**Files:**
- Create: `src/app/(auth)/register/page.tsx`

- [ ] **Step 1: 实现 register 页**

Create `src/app/(auth)/register/page.tsx`:

```tsx
"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";

export default function RegisterPage() {
  const router = useRouter();
  const { data: boot, isLoading: bootLoading } = trpc.auth.isBootstrap.useQuery();
  const isBootstrap = boot?.isBootstrap ?? false;

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const register = trpc.auth.register.useMutation({
    onSuccess: () => {
      router.push("/");
      router.refresh();
    },
    onError: (e) => setError(e.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (username.length < 3) return setError("用户名至少 3 个字符");
    if (password.length < 8) return setError("密码至少 8 个字符");
    if (password !== confirm) return setError("两次密码不一致");
    if (!isBootstrap && !inviteCode) return setError("请输入邀请码");
    register.mutate({
      username,
      password,
      inviteCode: isBootstrap ? undefined : inviteCode,
    });
  }

  if (bootLoading) {
    return <p className="text-sm text-muted-foreground text-center">加载中...</p>;
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <h2 className="text-lg font-semibold text-foreground">注册</h2>

      {isBootstrap && (
        <p className="text-sm text-muted-foreground">你将成为首个管理员。</p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="username">用户名</Label>
        <Input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">密码（≥ 8 位）</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">确认密码</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </div>

      {!isBootstrap && (
        <div className="space-y-1.5">
          <Label htmlFor="invite">邀请码</Label>
          <Input
            id="invite"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            required
          />
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" className="w-full" disabled={register.isPending}>
        {register.isPending ? "注册中..." : "注册"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        已有账号？
        <Link href="/login" className="ml-1 text-primary hover:underline">
          去登录
        </Link>
      </p>
    </form>
  );
}
```

- [ ] **Step 2: 冒烟 — bootstrap**

- 确保 user 表为空：`docker compose exec postgres psql -U arbitrage -c 'TRUNCATE users, sessions, invites CASCADE;'`
- 浏览器访问 `/register` → 应显示"你将成为首个管理员"，无邀请码字段。
- 提交 admin / hunter22 → 应跳 `/`；但 `/` 页面此时 tRPC 查询可能因客户端还未拿到 cookie 同步不稳，刷新一次即可看到 dashboard 壳子。

- [ ] **Step 3: 冒烟 — invite-required**

- `/login` 登进来，访问 `/settings`（此时还没 invite tab，但能验证 admin 能进 dashboard）。
- 暂时手动在 DB 里插一个 invite：
  ```
  docker compose exec postgres psql -U arbitrage -c \
    "INSERT INTO invites(code, created_by, expires_at, created_at) \
     VALUES('TEST', (SELECT id FROM users LIMIT 1), NOW()+interval '1 day', NOW());"
  ```
- 无痕窗口访问 `/register` → 应看到邀请码字段。填 user2/hunter22/TEST → 成功跳 `/`。

- [ ] **Step 4: Commit**

```
git add src/app/\(auth\)/register/page.tsx
git commit -m "feat(auth): /register page with bootstrap + invite-code paths"
```

---

## Task 15: 客户端 401 兜底（QueryCache / MutationCache）

**Files:**
- Modify: `src/components/trpc-provider.tsx`

- [ ] **Step 1: 替换 trpc-provider**

Replace `src/components/trpc-provider.tsx`:

```tsx
"use client";

import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { useState } from "react";
import superjson from "superjson";
import { trpc } from "@/lib/trpc";

function makeQueryClient() {
  const onAuthError = (err: unknown) => {
    if (err instanceof TRPCClientError && err.data?.code === "UNAUTHORIZED") {
      if (
        typeof window !== "undefined" &&
        !window.location.pathname.startsWith("/login")
      ) {
        window.location.assign("/login");
      }
    }
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: onAuthError }),
    mutationCache: new MutationCache({ onError: onAuthError }),
  });
}

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
```

- [ ] **Step 2: 冒烟**

- 登录进 dashboard。
- 开一个 terminal：`docker compose exec postgres psql -U arbitrage -c 'DELETE FROM sessions;'`
- 回浏览器点任意按钮/触发一个 mutation → 应 `window.location.assign("/login")`，跳到登录页（页面刷新）。

- [ ] **Step 3: Commit**

```
git add src/components/trpc-provider.tsx
git commit -m "feat(auth): global 401 → /login via QueryCache/MutationCache onError"
```

---

## Task 16: Header UserMenu

**Files:**
- Create: `src/components/layout/user-menu.tsx`
- Modify: `src/components/layout/header.tsx`

- [ ] **Step 1: 新建 UserMenu 组件**

Create `src/components/layout/user-menu.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";

export function UserMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: me } = trpc.auth.me.useQuery();
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => {
      router.push("/login");
      router.refresh();
    },
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  if (!me) return null;

  const label = (me.displayName ?? me.username).slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground hover:bg-accent transition-colors"
        aria-label="User menu"
      >
        {label}
      </button>
      {open && (
        <div
          className={cn(
            "absolute right-0 top-full mt-2 w-56 rounded-lg border border-border bg-card shadow-lg",
            "text-sm",
          )}
        >
          <div className="px-3 py-2 border-b border-border">
            <div className="font-medium text-foreground">
              {me.displayName ?? me.username}
            </div>
            <div className="text-xs text-muted-foreground">@{me.username}</div>
          </div>
          <Link
            href="/settings?tab=invites"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 hover:bg-accent text-foreground"
          >
            邀请码管理
          </Link>
          <button
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="w-full text-left px-3 py-2 hover:bg-accent text-destructive disabled:opacity-50"
          >
            {logout.isPending ? "登出中..." : "退出登录"}
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 把 UserMenu 挂到 Header**

Modify `src/components/layout/header.tsx`:

Change the imports (add UserMenu):
```tsx
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/layout/user-menu";
import { cn } from "@/lib/utils";
```

In the right-hand flex container, add `<UserMenu />` after `<ThemeToggle />`:
```tsx
        {/* Theme toggle */}
        <ThemeToggle />

        {/* User menu */}
        <UserMenu />
      </div>
    </header>
```

- [ ] **Step 3: 冒烟**

- 登录后看 header 右上角：应有一个圆形首字母按钮。
- 点开 → 看到用户名 + "邀请码管理" + "退出登录"。
- 点外面 → 面板消失。
- 点"退出登录" → 跳 `/login`。

- [ ] **Step 4: Commit**

```
git add src/components/layout/user-menu.tsx src/components/layout/header.tsx
git commit -m "feat(auth): header UserMenu with logout + invite link"
```

---

## Task 17: Settings 邀请码 tab

**Files:**
- Read first: `src/app/(dashboard)/settings/page.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`
- Create: `src/components/settings/invites-section.tsx`

- [ ] **Step 1: 先读现有 settings 页找到挂载点**

Run: `cat src/app/\(dashboard\)/settings/page.tsx`
记住它的顶层结构（可能是若干 Section Card 竖排或一个 tab 容器）。本任务采取"竖排再加一个 section"的追加策略，不重构现有 tab（YAGNI）。

- [ ] **Step 2: 新建 InvitesSection 组件**

Create `src/components/settings/invites-section.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

function maskCode(code: string): string {
  if (code.length <= 12) return code;
  return `${code.slice(0, 8)}...${code.slice(-4)}`;
}

export function InvitesSection() {
  const utils = trpc.useUtils();
  const { data } = trpc.auth.listInvites.useQuery();
  const [justCreated, setJustCreated] = useState<string | null>(null);

  const create = trpc.auth.createInvite.useMutation({
    onSuccess: (out) => {
      setJustCreated(out.code);
      utils.auth.listInvites.invalidate();
    },
  });
  const revoke = trpc.auth.revokeInvite.useMutation({
    onSuccess: () => utils.auth.listInvites.invalidate(),
    onError: (e) => alert(`撤销失败: ${e.message}`),
  });

  return (
    <div id="invites" className="space-y-4">
      <h2 className="text-base font-semibold text-foreground">邀请码</h2>

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-foreground">生成邀请码</div>
            <div className="text-xs text-muted-foreground">默认 7 天有效，单次使用</div>
          </div>
          <Button onClick={() => create.mutate()} disabled={create.isPending}>
            {create.isPending ? "生成中..." : "生成"}
          </Button>
        </div>
        {justCreated && (
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground mb-1">
              邀请码（仅此一次展示，关闭后无法再取回）：
            </div>
            <div className="flex items-center gap-2">
              <code className="font-mono text-sm text-foreground">{justCreated}</code>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => navigator.clipboard.writeText(justCreated)}
              >
                复制
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="p-4 space-y-2">
        <div className="text-sm font-medium text-foreground">未使用邀请码</div>
        {!data?.active.length ? (
          <div className="text-xs text-muted-foreground">（无）</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground uppercase tracking-wide">
                <th className="text-left py-1.5">code</th>
                <th className="text-left py-1.5">创建者</th>
                <th className="text-left py-1.5">创建时间</th>
                <th className="text-left py-1.5">过期时间</th>
                <th className="text-right py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {data.active.map((inv) => (
                <tr key={inv.code} className="border-t border-border">
                  <td className="py-2 font-mono">{maskCode(inv.code)}</td>
                  <td className="py-2">{inv.creator.username}</td>
                  <td className="py-2 text-muted-foreground">
                    {inv.createdAt.toLocaleString()}
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {inv.expiresAt.toLocaleString()}
                  </td>
                  <td className="py-2 text-right">
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => revoke.mutate({ code: inv.code })}
                      disabled={revoke.isPending}
                    >
                      撤销
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="p-4 space-y-2">
        <div className="text-sm font-medium text-foreground">已使用记录</div>
        {!data?.used.length ? (
          <div className="text-xs text-muted-foreground">（无）</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground uppercase tracking-wide">
                <th className="text-left py-1.5">使用者</th>
                <th className="text-left py-1.5">创建者</th>
                <th className="text-left py-1.5">使用时间</th>
              </tr>
            </thead>
            <tbody>
              {data.used.map((inv) => (
                <tr key={inv.code} className="border-t border-border">
                  <td className="py-2">{inv.user?.username ?? "—"}</td>
                  <td className="py-2">{inv.creator.username}</td>
                  <td className="py-2 text-muted-foreground">
                    {inv.usedAt?.toLocaleString() ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: 把 InvitesSection 挂到 settings 页底部**

Edit `src/app/(dashboard)/settings/page.tsx`:
1. 在 import 区加：`import { InvitesSection } from "@/components/settings/invites-section";`
2. 在页面主 JSX 的最底部（最后一个已有 Section 之后、外层容器关闭之前）插入：`<InvitesSection />`

举例（你的 settings page 具体结构可能不同，关键是加在页面竖排内容流的末尾）：
```tsx
export default function SettingsPage() {
  return (
    <div className="p-8 space-y-8">
      {/* ...existing sections... */}
      <InvitesSection />
    </div>
  );
}
```

- [ ] **Step 4: 冒烟**

- 登录进 `/settings` → 拉到底部应看到"邀请码"三个 Card。
- 点"生成" → 看到新 code 明文一次，刷新页面后 code 消失（但出现在"未使用"列表中，脱敏形态）。
- 点"撤销" → 该行消失。
- 用另一账号走 `/register` + 被撤销的邀请码 → 失败。

- [ ] **Step 5: Commit**

```
git add src/app/\(dashboard\)/settings/page.tsx src/components/settings/invites-section.tsx
git commit -m "feat(auth): invite code management section in Settings"
```

---

## Task 18: 集成测试（auth-flow）

**Files:**
- Create: `tests/integration/auth-flow.test.ts`

- [ ] **Step 1: 写集成测试**

Create `tests/integration/auth-flow.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/api/root";
import { prisma } from "@/server/db/client";
import { redis } from "@/server/db/redis";
import type { TRPCContext } from "@/server/api/trpc";
import { SESSION_COOKIE, parseCookie } from "@/server/services/auth/cookie";

function freshCtx(cookie?: string): TRPCContext {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  headers.set("x-forwarded-for", "1.1.1.1");
  return {
    prisma,
    redis,
    user: null,
    sessionToken: null,
    resHeaders: new Headers(),
    req: new Request("http://localhost:3000", { method: "POST", headers }),
  } as TRPCContext;
}

function extractSessionToken(ctx: TRPCContext): string {
  const sc = ctx.resHeaders.get("set-cookie")!;
  const token = /arb_session=([^;]+)/.exec(sc)?.[1];
  return token!;
}

async function reset() {
  await prisma.session.deleteMany();
  await prisma.invite.deleteMany();
  await prisma.user.deleteMany();
  await redis.flushdb();
}

describe("auth full flow", () => {
  beforeEach(reset);

  it("bootstrap → logout → login → invite → second user → replay blocked → revoke cycle", async () => {
    // 1. bootstrap register
    let c = freshCtx();
    await appRouter.createCaller(c).auth.register({ username: "admin", password: "hunter22" });
    const adminToken = extractSessionToken(c);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.session.count()).toBe(1);

    // 2. logout
    const adminCookie = `${SESSION_COOKIE}=${adminToken}`;
    const { getSessionUser } = await import("@/server/services/auth/session");
    const authed = await getSessionUser(adminToken);
    expect(authed).not.toBeNull();
    const c2 = freshCtx(adminCookie);
    c2.user = authed;
    c2.sessionToken = adminToken;
    await appRouter.createCaller(c2).auth.logout();
    expect(await prisma.session.count()).toBe(0);

    // 3. login again
    const c3 = freshCtx();
    const loggedIn = await appRouter
      .createCaller(c3)
      .auth.login({ username: "admin", password: "hunter22" });
    expect(loggedIn.user.username).toBe("admin");
    const adminToken2 = extractSessionToken(c3);

    // 4. createInvite as admin
    const adminUser = await getSessionUser(adminToken2);
    const c4 = freshCtx();
    c4.user = adminUser;
    c4.sessionToken = adminToken2;
    const { code } = await appRouter.createCaller(c4).auth.createInvite();
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);

    // 5. second user registers with invite
    const c5 = freshCtx();
    await appRouter
      .createCaller(c5)
      .auth.register({ username: "user2", password: "hunter22", inviteCode: code });
    expect(await prisma.user.count()).toBe(2);
    const invAfter = await prisma.invite.findUnique({ where: { code } });
    expect(invAfter?.usedBy).not.toBeNull();

    // 6. replay same invite
    const c6 = freshCtx();
    await expect(
      appRouter
        .createCaller(c6)
        .auth.register({ username: "user3", password: "hunter22", inviteCode: code }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // 7. admin revokes a fresh invite
    const c7 = freshCtx();
    c7.user = adminUser;
    c7.sessionToken = adminToken2;
    const { code: code2 } = await appRouter.createCaller(c7).auth.createInvite();
    await appRouter.createCaller(c7).auth.revokeInvite({ code: code2 });
    const c8 = freshCtx();
    await expect(
      appRouter
        .createCaller(c8)
        .auth.register({ username: "user4", password: "hunter22", inviteCode: code2 }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("protected business routers reject unauthenticated calls", async () => {
    const c = freshCtx();
    await expect(
      appRouter.createCaller(c).dashboard.overview(),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
```

> 注意：若 `dashboard.overview` 的 procedure 名在仓库里叫别的，把那行改成实际存在的任何 query，只为验 `UNAUTHORIZED`。

- [ ] **Step 2: 运行集成测试**

Run: `pnpm test tests/integration/auth-flow.test.ts`
Expected: 2 passing.

- [ ] **Step 3: Commit**

```
git add tests/integration/auth-flow.test.ts
git commit -m "test(auth): full integration flow — bootstrap/login/invite/revoke/401"
```

---

## Task 19: 生成 Prisma 迁移文件（供生产使用）

**Files:**
- Create: `prisma/migrations/<timestamp>_add_auth_tables/migration.sql`（由 Prisma 生成）
- Modify: `prisma/migrations/migration_lock.toml`（首次由 Prisma 创建；若已存在不变）

- [ ] **Step 1: 生成迁移文件**

Run:
```
docker compose run --rm app pnpm prisma migrate dev --name add_auth_tables
```

这会：
1. 按当前 schema 与 dev db 的差异生成 `prisma/migrations/<timestamp>_add_auth_tables/migration.sql`
2. 应用到 dev db（幂等——Task 1 的 db push 已经建过表，migrate dev 会识别并跳过应用但仍生成文件）

若报 "drift detected"，说明 db push 和 migration 历史分歧。方案：重置 dev db 然后重跑：
```
docker compose exec postgres psql -U arbitrage -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker compose run --rm app pnpm prisma migrate dev --name add_auth_tables
docker compose run --rm app pnpm tsx src/server/db/seed.ts
```

- [ ] **Step 2: 验证迁移文件存在**

Run: `ls prisma/migrations/`
Expected: 看到一个 `<timestamp>_add_auth_tables/` 目录，内含 `migration.sql`（包含 CREATE TABLE users/sessions/invites + 索引）。

- [ ] **Step 3: 生产部署脚本验证（无需改）**

[scripts/deploy.sh:102](scripts/deploy.sh#L102) 已经用 `prisma migrate deploy`，无需改动。本任务只是把迁移文件交给它。

- [ ] **Step 4: Commit**

```
git add prisma/migrations/
git commit -m "chore(prisma): migration for auth tables"
```

---

## Task 20: 手动 E2E smoke（验证清单，不 commit 代码）

按 [spec 的手动 E2E 节](docs/superpowers/specs/2026-04-17-auth-system-design.md#手动端到端用-devsh) 走一遍：

- [ ] **1.** 清库：`docker compose exec postgres psql -U arbitrage -c 'TRUNCATE users,sessions,invites CASCADE;'`
- [ ] **2.** 浏览器访问 `http://localhost:3000/` → 307 → `/login?next=%2F` → 继续链到 `/register`（通过页面上的"去注册"链接；或直接访问 `/register` 检验 isBootstrap 提示）
- [ ] **3.** 注册 admin / hunter22 → 进入 `/`；header 右上看到"A"圆形按钮
- [ ] **4.** 进 Settings 底部 → 生成一个 invite code → 点复制
- [ ] **5.** 无痕窗口 → `/register` → 应显示邀请码字段 → 填 user2 / hunter22 / `<code>` → 成功
- [ ] **6.** 再用同一 code 到另一无痕窗口注册 user3 → 报"invalid or used invite"
- [ ] **7.** 主窗口点 UserMenu "退出登录" → 跳 `/login`
- [ ] **8.** 错误密码连登 11 次（同一 IP 同一 username） → 第 11 次应 "请稍后再试"
- [ ] **9.** 清 redis (`docker compose exec redis redis-cli flushdb`) 恢复登录；登进去。然后：`docker compose exec postgres psql -U arbitrage -c 'DELETE FROM sessions;'`。在已打开的 dashboard 页点任意导航 → 跳 `/login`（L2 生效）；或点任意按钮触发 mutation → 客户端 401 兜底跳 `/login`
- [ ] **10.** CSRF：`curl -i -X POST http://localhost:3000/api/trpc/auth.logout -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -b 'arb_session=<valid-token>' -d '{}'` → 响应 body 里应看到 `"code":"FORBIDDEN"`

如全部通过，auth 系统端到端可用。

---

## 不在本期范围（follow-up backlog）

- 邮箱验证 / 密码重置
- 2FA
- 登录设备列表 UI（Session 表的 userAgent / ipAddress 已为此预留）
- 角色 / 权限分级
- OAuth / 第三方登录
- 独立审计日志表
- 把 `APP_ORIGIN` 环境变量加到 .env.example 和 docker-compose.prod.yml（生产部署前必改）
- 清理过期 session 的定时任务（现在靠 sliding 读时懒删除 + `@@index([expiresAt])`）

---

## Self-Review 备忘（执行者可忽略）

- **Spec 覆盖**：spec 的 10 步 + 3 层防线 + 登录防护 + CSRF + 信任模型 + 迁移策略 都对应到 Tasks。
- **并发测试**：Task 8 含并发 bootstrap 和并发同 invite 两项。
- **回归测试**：Task 4 含"拿 tokenHash 当 token 查不到"的直接回归。
- **placeholder 扫描**：所有 step 都给出具体代码或 shell 命令。
- **类型一致性**：`SessionUser`、`TRPCContext`、`hashToken`、`serializeSessionCookie`、`SESSION_COOKIE` 在首次定义后保持同名。
- **缺口**：Task 17 对 settings page 采用"追加 section"的保守策略，因 exploration 阶段没精确读该页面结构——执行 Task 17 的 Step 1 就是为此补读。如果该页是 tab 容器，应改为注入一个新 tab；如果是竖排 Card，则追加 Section。这个 step 1 的读文件就是作这个决定。
