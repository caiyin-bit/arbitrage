# 注册登录系统设计

- 日期：2026-04-17
- 范围：全站补齐注册 / 登录 / 会话 / 邀请码管理
- 状态：设计稿，待 writing-plans 细化实施任务

## Context

项目原 spec（`docs/superpowers/specs/2026-04-12-funding-rate-arbitrage-platform-design.md:25`）写明 *"初期单用户，多租户/权限后续再加"*：当前 Prisma 无 User/Session 表，tRPC 全部用 `publicProcedure`，Next.js 无 middleware，`(dashboard)` 全开。交易配置、交易所密钥、仓位等敏感数据暴露在任何能访问主机的人面前。

现在要补鉴权门。但保持最小改动——不给业务表加 `userId`，不重构已有 6 个 routers 的数据作用域，仅加"进门"这一层。

## 核心决策（附选项与理由）

| 维度 | 选项 | 决策 | 理由 |
|---|---|---|---|
| 作用域 | A. 单管理员 bootstrap / B. 团队共享同一份数据 / C. 完整多租户 | **B** | 原 spec 明确多租户后续再加；B 只加鉴权门，不动业务表 `userId`，工作量最小且不偏离阶段规划 |
| 注册 | A. 邀请码 / B. 开放 / C. 仅登录 | **A** | 私有交易工具，暴露面比体验更重要；邀请码 + bootstrap 兼顾首次可用性与后续可控 |
| 用户标识 | A. 邮箱 / B. 用户名 / C. 两者 | **B** | 当前不需要邮箱流程（重置 / 验证 / 通知），username 唯一足够；后续要加邮箱可 additive |
| Session | A. DB / B. Redis / C. JWT | **A** | DB session 可在 Prisma Studio 查看、按行 delete 踢人、服务重启不丢；与现有 Prisma 栈一致；revocation 优先于性能 |
| 首管理员 bootstrap | A. 首次注册即管理员 / B. CLI 脚本 / C. Seed 环境变量 | **A** | 部署后第一个人即占位；无须额外脚本；邀请码机制天然把"第一次"与"之后"分开 |
| 密码哈希 | argon2id / bcrypt / scrypt | **Node 内建 `crypto.scrypt`** | 零依赖，避开 argon2 在 alpine 上的原生编译坑；强度对私有工具充足 |
| 权限分级 | 有 admin / member 角色 | **无分级** | 所有登录用户平权，任意人可建 / 撤销邀请码；简化本期模型，后续可 additive 加 role |

## 信任模型（显式声明）

本期所有登录用户**平权**：没有 admin / member 分级。这意味着：

- 任一已登录账号都能 `createInvite` / `revokeInvite` / 看所有交易所密钥（虽然 apiKey/apiSecret 在 DB 里是 AES-GCM 加密，但 tRPC 接口会解密返回）/ 改全局策略参数 / 关平仓位。
- 每个已登录用户等同于"团队成员"，邀请码可以被任意成员无限扩散。

**这是刻意接受的简化**：项目预期使用场景是小团队（2–5 人）内部工具，所有成员都是交易决策参与方，互相完全信任；引入 role/permission 会在本期变成过度设计（见 spec 末 follow-up 条目）。**不适合**：外包给不信任的运维 / 给实习生只读权限 / 多账号共用 / 有"审计观察者"角色。

若后续出现这些需求，additive 加 `User.role` 字段 + 在 invite / settings 写操作前检查是一项独立工作，不在本期范围。

## 架构总览

5 层：

1. **数据层** — Prisma 新增 `User` / `Session` / `Invite` 三表；现有业务表保持不变。
2. **密码 & Session 基础设施** — Node 内建 `crypto.scryptSync` 做密码哈希；`randomBytes(32).base64url` 生成 session token（进 cookie），`sha256(token)` 作为 DB 主键。
3. **tRPC 鉴权层** — `createTRPCContext` 读 cookie token → 注入 `ctx.user` + 做 Origin/CSRF 校验；新增 `protectedProcedure`；业务 routers 全量切 protected。
4. **路由保护（三层）** — middleware.ts 快速 cookie 判定（Layer 1）+ `(dashboard)/layout.tsx` 服务端 session 校验（Layer 2）+ tRPC protectedProcedure 数据门（Layer 3）；客户端 `trpc-provider` 全局 401→redirect 兜底。
5. **UI 层** — `(auth)` 路由组放 `/login` / `/register`；Header 加用户菜单；Settings 页加邀请码 tab。

关键原则：**同一份数据，只加鉴权门**。业务表不加 `userId`，所有登录用户看到同一套交易所 / 仓位 / 配置。

## 数据模型

新增在 `prisma/schema.prisma`，现有表不动。

```prisma
model User {
  id           String    @id @default(cuid())
  username     String    @unique
  passwordHash String
  displayName  String?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  sessions     Session[]
  invitesSent  Invite[]  @relation("InviteCreator")
  invitesUsed  Invite[]  @relation("InviteUser")
}

model Session {
  // tokenHash = sha256(cookie_token)，主键是 hash 不是明文 token
  tokenHash  String   @id
  userId     String
  expiresAt  DateTime
  userAgent  String?
  ipAddress  String?
  createdAt  DateTime @default(now())
  lastSeenAt DateTime @default(now())

  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
}

model Invite {
  code       String   @id
  createdBy  String
  usedBy     String?
  expiresAt  DateTime
  usedAt     DateTime?
  createdAt  DateTime @default(now())

  creator    User     @relation("InviteCreator", fields: [createdBy], references: [id])
  user       User?    @relation("InviteUser", fields: [usedBy], references: [id])

  @@index([createdBy])
}
```

约定：
- **Session token 双层**：浏览器 cookie 里存 32 字节随机 token（`randomBytes(32).base64url`）；数据库只存 `sha256(token)` 作为 `Session.tokenHash`（主键）。校验时服务端先 hash cookie 再查库。即便 DB 被读也不能接管任何活跃会话——这是把 session 等同于"已登录能力本身"的直接后果，与 invite code（单次使用 + 短 TTL + 可 revoke，明文存储可接受）不同。
- 密码哈希字符串格式 `<salt_b64>$<hash_b64>`（16B salt + 64B hash，scrypt N=16384 r=8 p=1）。
- `Invite.code` 一次性：`usedBy` 非空即作废，`expiresAt` 过期即作废，无独立布尔标志。code 以明文作为主键——单次使用 + 默认 7d TTL + 可 revoke，暴露窗口有限。
- 业务表不加 `userId`——本期为团队共享。

迁移方式：
- **开发**：`prisma db push`（快速同步 schema 到 dev db，不生成迁移文件）。
- **上生产前**：`prisma migrate dev --name add_auth_tables` 生成迁移文件并提交到仓库。
- **生产部署**：`prisma migrate deploy` 在生产库应用已提交的迁移（只读取迁移文件，不生成新的；scripts/deploy.sh 应调用此命令）。

## 后端鉴权层

### 新增文件

- `src/server/services/auth/password.ts` — `hashPassword` / `verifyPassword`，使用 `node:crypto` 的 `scryptSync + timingSafeEqual`
- `src/server/services/auth/session.ts`
  - `createSession(userId, ua?, ip?)` → 生成 `token = randomBytes(32).base64url`，`tokenHash = sha256(token).hex`，插 Session 行 `{ tokenHash, userId, expiresAt=now+7d, ... }`，返 `{ token, expiresAt }`（token 仅此一次可见，进 cookie）
  - `getSessionUser(token)` → `hash = sha256(token)`，按 `tokenHash` 查库 join User；过期 / 不存在返 null；命中则滑动续期 `expiresAt=now+7d` + `lastSeenAt=now`
  - `destroySession(token)` → 按 tokenHash 删行
  - cookie 常量 `SESSION_COOKIE = "arb_session"`
- `src/server/api/routers/auth.ts` — authRouter

### 修改文件

- `src/server/api/trpc.ts` — 改 `createTRPCContext` 从 `opts.req.headers` 解 cookie，注入 `ctx.user`、`ctx.sessionId`、`ctx.resHeaders`；新增 `protectedProcedure`（`t.procedure.use` 中 `ctx.user` 为 null 抛 `UNAUTHORIZED`，否则窄化 user 为非空）
- `src/server/api/root.ts` — 注册 `authRouter`
- `src/server/api/routers/{exchange,opportunity,position,settings,dashboard}.ts` — 所有 procedure 从 `publicProcedure` 换成 `protectedProcedure`
- `src/app/api/trpc/[trpc]/route.ts` — 把 `fetchRequestHandler` 的 `createContext` 参数拿到 `req` 和 `resHeaders`（tRPC 11 的 FetchAdapter 默认支持）

### authRouter procedures

| Procedure | 类型 | 入参 | 行为 |
|---|---|---|---|
| `auth.isBootstrap` | public query | — | 返 `{ isBootstrap: boolean }`——User 表是否为空。仅用于前端 UI 提示，**不作为授权依据**（授权靠 register 内部的原子判断） |
| `auth.register` | public mutation | `{username, password, inviteCode?}` | 详见下面「register 原子性」段落。成功建 User + Session + 写 cookie；若用了 inviteCode 则标记 `usedBy/usedAt` |
| `auth.login` | public mutation | `{username, password}` | 详见下面「登录防护」段落 |
| `auth.logout` | protected mutation | — | 删当前 session 行 + 清 cookie |
| `auth.me` | public query | — | 返 `{ id, username, displayName } \| null`（显式挑字段，**不含 passwordHash**），前端 hydrate 用户菜单 |
| `auth.createInvite` | protected mutation | — | 生成 `randomBytes(16).base64url` 的 code，默认 `expiresAt = now + 7d`；返 code 明文（仅此一次） |
| `auth.listInvites` | protected query | — | 列所有未用且未过期的 invite + 最近已用的（分两个数组） |
| `auth.revokeInvite` | protected mutation | `{code}` | 未使用则 `expiresAt = now`；已使用直接报错 |

### register 原子性（防 bootstrap 竞态）

"User 表为空时允许无 invite 注册"本身是 TOCTOU：两个并发首次注册都能在看到空表后各自落库，导致双管理员。

实现必须用 **Serializable 事务**（Prisma `$transaction(fn, { isolationLevel: "Serializable" })`）包住 `count + insert`：

```ts
await prisma.$transaction(async (tx) => {
  const userCount = await tx.user.count();
  if (userCount === 0) {
    // bootstrap：忽略 inviteCode
  } else {
    if (!inviteCode) throw UNAUTHORIZED("need invite code");
    const invite = await tx.invite.update({
      where: { code: inviteCode, usedBy: null, expiresAt: { gt: new Date() } },
      data: { usedBy: ...placeholder until user is created... },
    }); // Prisma 不支持在 update 的 where 过滤掉未满足条件，需用 updateMany 校验 count=1
  }
  const user = await tx.user.create({ data: { username, passwordHash } });
  // 若非 bootstrap，再 update invite.usedBy = user.id
}, { isolationLevel: "Serializable" });
```

并发冲突时 Postgres 会抛 `40001 serialization_failure`，服务端捕获后向客户端返 "请重试"。invite 消费也放在同一事务，用 `updateMany({ where: { code, usedBy: null, expiresAt: { gt: now } }, data: { usedBy: <uid>, usedAt: now } })` 的 `count === 1` 判定是否成功抢到，保证 invite 单次使用原子。

### 登录防护

1. **统一响应形状**：用户名不存在 / 密码错误返回完全相同的错误消息（`"用户名或密码错误"`）和状态码（`UNAUTHORIZED`）。
2. **恒定时延**：无论是哪种失败路径，成功前恒定 ≥ 400ms 延迟（可用 `Promise.all([verify, sleep(400)])`）——防止通过时间差枚举用户名。
3. **双层速率限制**（都走 Redis，用 `INCR + EXPIRE`）：
   - 按 IP：`login:ip:<ip>` 30 次 / 10 分钟 → 锁 IP 15 分钟
   - 按 (IP, username) 对：`login:pair:<ip>:<username>` 10 次 / 10 分钟 → 锁该对 15 分钟
   - **不按纯 username 计数**——否则远程攻击者可用 "轮询 IP + 固定 username" 把任何已知用户打进锁定，造成可触发的账户 DoS。
4. **用户名不存在时仍要走 IP 计数**，但不进 (IP, username) 桶——避免"不存在用户不计数"泄漏用户存在性。

### CSRF 防护

- cookie 是 `HttpOnly; SameSite=Lax`。SameSite=Lax 会拦掉跨站 POST，但并非所有浏览器 / 所有场景都可靠——且浏览器实现过去有过绕过。
- **额外加 Origin 校验**：在 tRPC context 创建函数里，对有写操作的请求（HTTP POST）读 `Origin` 或 `Referer` header，若存在且与期望的 host（`process.env.APP_ORIGIN`，开发 `http://localhost:3000`，生产由部署脚本注入）不匹配则 `403`。缺失 header 的老客户端对 POST 放行（Next.js App Router 的 fetch mutation 会带 Origin）。
- 本期**不引独立 CSRF token**。若后续暴露 REST 接口或服务移至非浏览器客户端，再重估。

### Cookie 规则

- 名字：`arb_session`
- flags：`HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`（7d）；生产加 `Secure`（依 `process.env.NODE_ENV === "production"`）
- register / login 在 mutation 内通过 `ctx.resHeaders.append("set-cookie", ...)` 写；logout 写 `Max-Age=0`
- cookie 值为明文 token（仅 set-cookie 这一次写进响应），DB 只存其 sha256 hash

### 三层鉴权防线

单靠 middleware（只能看 cookie 存在）会出现"cookie 还在但 session 行已被删"的半坏 UX：壳子能进，数据全 401。三层协同：

**Layer 1 — `middleware.ts`（仓库根，edge runtime）**
- 仅快速 cookie 存在性判断，**不校验 session 有效性**（edge runtime 拿不到 Prisma）
- 规则：未见 `arb_session` cookie 且路径命中 `(dashboard)` 区（`/`、`/opportunities`、`/positions`、`/backtest`、`/settings`、`/settings/invites`） → 302 `/login?next=<orig-pathname>`
- 例外放行：`/login`、`/register`、`/api/trpc/*`、`/api/health`、Next 静态资源（`_next/*`）
- 作用：无 cookie 用户的首访优化，不做任何授权判定

**Layer 2 — `(dashboard)/layout.tsx`（Server Component，Node runtime）**
- 在 server component 中用 `cookies()` 读 token → 调 `getSessionUser(token)`；返 null 时 `redirect("/login")`
- **不带 `?next=`**：App Router 的 server layout 拿不到当前 pathname（Next 16 官方无直接 API），强行从 `headers()` 里塞 `x-pathname` 需要 middleware 协作且容易在 edge 缓存 / 流式渲染场景踩坑——得不偿失。deep-link 记忆交给 Layer 1（middleware 在无 cookie 首访时已经能写 `?next=`），stale cookie 的边缘场景接受"回登录页后手动重访"的 UX 折损。
- 这一层消除"stale cookie 进壳子"的 UX 缺口：session 行被删 / 过期后下一次页面加载就会重定向
- 不 hit Prisma 的 `auth.me` 客户端查询保留（UserMenu 需要 displayName），此处 server-side 校验是补充

**Layer 3 — tRPC `protectedProcedure`**
- 真正的数据授权门。任何未带有效 session 的 tRPC 调用一律 `UNAUTHORIZED`
- 即使 Layer 1/2 被绕过（例如直接调 `/api/trpc/exchange.list`），数据不会泄漏

**客户端兜底**：处理用户正在使用时 session 被远程踢掉的情况（Layer 2 只在页面切换时生效）。**不要用 `defaultOptions.onError`** —— 现有组件如 [exchange-form.tsx:48](src/components/settings/exchange-form.tsx) 的 `onError: (err) => alert(...)` 会覆盖掉默认项，导致"部分请求被踢会跳登录、部分只弹本地错误"的行为分裂。

正确做法是在 `src/components/trpc-provider.tsx` 的 `QueryClient` 构造里挂 `QueryCache` + `MutationCache` 的 `onError`（它们不会被局部 `onError` 覆盖，是全局最后一道）：

```ts
import { QueryCache, MutationCache, QueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";

const onAuthError = (err: unknown) => {
  if (err instanceof TRPCClientError && err.data?.code === "UNAUTHORIZED") {
    if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
      window.location.assign("/login");
    }
  }
};

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
});
```

如未来想收紧到链路层（更干净、不依赖 react-query 版本），替代方案是在 tRPC `httpBatchLink` 外套一个自定义 link 拦 `UNAUTHORIZED` 统一跳转——本期用上面 cache-level 即可。

## 前端

### 路由组

```
src/app/(auth)/
├── layout.tsx          居中卡片布局，深色，logo
├── login/page.tsx
└── register/page.tsx

src/app/(dashboard)/settings/page.tsx   (内部加 "邀请码" tab，不另起路由)

src/components/layout/
├── header.tsx          加 UserMenu 触发器
└── user-menu.tsx       新：悬浮面板
```

### 登录页 (`/login`)

`"use client"`，沿用现有 [src/components/settings/exchange-form.tsx](src/components/settings/exchange-form.tsx) 的 `useState + trpc.mutation` 模式，不引 react-hook-form。

- 字段：`<Input>` username / password
- 提交：`trpc.auth.login.useMutation({ onSuccess: () => router.push(search.get("next") ?? "/"), onError: (e) => setError(e.message) })`
- 错误：红色文字行内；loading 时按钮 disabled 显示 "登录中..."
- 页脚链接："还没账号？去注册" → `/register`（注意：若邀请码模式生效，未登录也允许到 `/register`；register 页会自己处理 invite 校验）

### 注册页 (`/register`)

- mount 时调 `trpc.auth.isBootstrap.useQuery()`
  - `isBootstrap=true`：inviteCode 字段隐藏，顶部提示 "你将成为首个管理员"
  - `isBootstrap=false`：inviteCode 必填
- 字段：username（≥3）/ password（≥8）/ confirmPassword（一致）/ inviteCode（条件）
- 客户端 + 服务端双重 zod 校验，服务端为准
- 提交成功：后端已写 cookie，`router.push("/")`

### Header 用户菜单

`src/components/layout/user-menu.tsx`：

- 触发器：圆形按钮，显示 `displayName ?? username` 的首字符
- 悬浮面板：纯 Tailwind（`absolute right-0 top-full mt-2 w-56 rounded-lg border bg-card shadow-lg`）；`useEffect` 挂 `document.click` 关闭；不引 Radix
- 面板内容：用户名全称 / "邀请码管理"（滚到 Settings 页内对应 anchor 或 push `/settings#invites`） / "退出登录"
- 退出登录：`trpc.auth.logout.useMutation({ onSuccess: () => router.push("/login") })`

### Settings 里的邀请码 tab

改 `src/app/(dashboard)/settings/page.tsx`，在现有分区下加：

- Card「生成邀请码」：按钮 → 新生成的 code 明文展示一次 + "复制" 按钮；关页后不再可取回
- Card「未使用邀请码」：table（code 前 8 位...后 4 位脱敏 / 创建者 / 创建时间 / 过期时间 / 撤销按钮）
- Card「已使用记录」（折叠）：table（使用者 / 创建者 / 使用时间）

## 测试

### 单元测试（`tests/unit/`）

- `auth/password.test.ts` — hash/verify 往返；错密码返 false；格式错返 false；timingSafe 路径
- `auth/session.test.ts`
  - createSession 返回的 token 不等于 DB 里存的 tokenHash
  - 用原 token 可查到 session；用 tokenHash 作为 token 查不到（防御"读库接管"的回归测试）
  - 过期 session 返 null；滑动续期 `expiresAt` 被刷新
- `auth/auth-router.test.ts`（真 Postgres + Redis，不 mock，因要验 Serializable）
  - register bootstrap：User 空允许无 invite
  - register 非 bootstrap：invite 必填、不可复用、过期拒绝
  - register 并发 bootstrap：两个 `Promise.all` 的 register 请求里只有一个成功，另一个报 serialization_failure 或 "用户已存在"
  - register 并发同 invite：两个 register 带同一 invite 只有一个成功
  - duplicate username 冲突
  - login：错密码 / 不存在用户 返回同一消息同一状态码；成功前恒定 ≥ 400ms
  - login 速率限制：按 IP 超限锁 IP；按 (IP, username) 超限仅锁该对；单改 IP 换账号仍能登
  - logout：session 行消失；随后 protected 调用返 401
  - CSRF：带 `Origin: https://evil.example` 的请求被 403

### 集成测试（`tests/integration/auth-flow.test.ts`）

真 Postgres + Redis。完整流程：
1. bootstrap register → 建 User + Session
2. logout → Session 消失
3. login → 新 Session
4. createInvite → Invite 行 + 返 code
5. 第二账号用 invite 注册 → 成功；Invite `usedBy/usedAt` 被写
6. 同一 invite 再用 → 失败
7. revoke 某个未用 invite → 后续不可用

### 手动端到端（用 `./dev.sh`）

```
1. 清库：
   docker compose exec postgres psql -U arbitrage -c \
     'TRUNCATE "User","Session","Invite" CASCADE;'
2. 访问 http://localhost:3000 → 302 /login → 检测 bootstrap → 302 /register
3. 注册 admin / password123 → 自动进入 /，Header 右上看到用户菜单
4. Settings → 邀请码 tab → 生成一个 code → 复制
5. 无痕窗口 /register → 填 user2 / pwd + invite → 成功
6. 同一 invite 再用 → 报 "已使用"
7. 主窗口 logout → 302 /login
8. 同一 IP 错密码登 10 次 (IP,username) → 第 11 次锁定（Redis 速率限制生效）
9. 踢人生效（Layer 2 验证）：
   docker compose exec postgres psql -c 'DELETE FROM "Session";'
   刷新一个 (dashboard) 页面 → 302 /login（服务端 layout 检测到 session 已删）
10. 客户端 401 兜底（Layer 3 → 客户端跳转）：
    在 user2 会话中，让 admin 删掉 user2 的 session，user2 接着点任何按钮触发 mutation → 自动跳 /login
11. CSRF：curl -X POST http://localhost:3000/api/trpc/auth.logout -H 'Origin: https://evil.example' -b 'arb_session=...'
    → 403
```

## 实施顺序（writing-plans 会进一步拆任务）

1. Prisma schema（含 Session.tokenHash 主键）+ `prisma db push` → Studio 看到 3 张空表
2. `password.ts` + `session.ts`（含 token / tokenHash 双层）+ 对应单测 → 单测绿，含"用 tokenHash 当 token 查不到"回归测试
3. tRPC context 改造（cookie 解析 + Origin 校验 + `ctx.user` 注入）+ `protectedProcedure` → 现有业务 routers 暂时都 401
4. 业务 routers 批量切到 `protectedProcedure` → pnpm test 绿
5. `authRouter`：
   - register（Serializable 事务 + invite updateMany 原子消费）
   - login（双层速率限制 + 恒定时延 + 统一响应）
   - logout / me / isBootstrap
   - 手动 curl 打通：register→login→me→logout；并发竞态测试
6. 邀请码相关 procedures（createInvite / listInvites / revokeInvite）→ 集成测试绿
7. `middleware.ts`（Layer 1）+ `(dashboard)/layout.tsx` 服务端 session 校验（Layer 2）→ stale cookie 场景验证
8. `(auth)` 路由组 + 登录注册页 → 浏览器走一遍 bootstrap
9. Header UserMenu + Settings 邀请码 tab + trpc-provider 客户端 401→redirect 兜底（走 QueryCache/MutationCache `onError`，不用 defaultOptions）→ 可生成 / 撤销 / 踢人生效
10. 集成测试 + 手动 E2E（含并发 bootstrap / CSRF / 踢人三项新验证）

## 不在本期范围（follow-up）

- 邮箱验证 / 密码重置
- 2FA
- 登录设备列表 UI（Session 表字段已预留）
- 角色 / 权限分级（目前所有登录用户平权）
- OAuth / 第三方登录
- 独立审计日志表（login/logout 成功失败轨迹）

## 关键文件索引

| 改动类型 | 路径 |
|---|---|
| 新建 | `prisma/schema.prisma`（新增 3 模型） |
| 新建 | `src/server/services/auth/password.ts` |
| 新建 | `src/server/services/auth/session.ts` |
| 新建 | `src/server/api/routers/auth.ts` |
| 新建 | `middleware.ts`（仓库根） |
| 新建 | `src/app/(auth)/layout.tsx` |
| 新建 | `src/app/(auth)/login/page.tsx` |
| 新建 | `src/app/(auth)/register/page.tsx` |
| 新建 | `src/components/layout/user-menu.tsx` |
| 修改 | `src/server/api/trpc.ts`（context + protectedProcedure） |
| 修改 | `src/server/api/root.ts`（挂 authRouter） |
| 修改 | `src/server/api/routers/exchange.ts` 等 5 个（public → protected） |
| 修改 | `src/app/api/trpc/[trpc]/route.ts`（传 resHeaders） |
| 修改 | `src/components/layout/header.tsx`（挂 UserMenu） |
| 修改 | `src/app/(dashboard)/settings/page.tsx`（加邀请码 tab） |
| 修改 | `src/app/(dashboard)/layout.tsx`（Layer 2：server component 里校验 session 并 redirect） |
| 修改 | `src/components/trpc-provider.tsx`（客户端 401 全局兜底→跳 /login） |
| 修改 | `scripts/deploy.sh`（生产切 `prisma migrate deploy`，不再用 `db push`） |
| 新增测试 | `tests/unit/auth/{password,session,auth-router}.test.ts` |
| 新增测试 | `tests/integration/auth-flow.test.ts`（含并发 bootstrap / 并发同 invite / CSRF 拒绝 / 踢人生效） |

## 复用的现有工具

- [`src/server/services/crypto/encryption.ts`](src/server/services/crypto/encryption.ts) — 参考其 Node `crypto` 使用风格
- [`src/components/ui/{button,input,label,card}.tsx`](src/components/ui/) — 登录 / 注册页直接复用
- [`src/components/settings/exchange-form.tsx`](src/components/settings/exchange-form.tsx) — 表单模式 `useState + trpc.mutation + 错误态`
- [`src/components/trpc-provider.tsx`](src/components/trpc-provider.tsx) — 已有 tRPC 客户端；本期给 QueryClient 传 `QueryCache` + `MutationCache` 的 `onError` 做全局 401→redirect 兜底（不要用 defaultOptions.onError，会被局部覆盖）
- [`DESIGN.md`](DESIGN.md) — 颜色 / 间距 / 字体规范
