# Plan 3 Design — CI/CD + 生产部署

**Date**: 2026-04-13
**Status**: Approved
**Scope**: CI/CD 流水线（GitHub Actions → ghcr.io）+ 腾讯云硅谷单机生产部署。不含回测引擎、日志聚合、蓝绿部署、Staging 环境 —— 这些是独立的后续项目。

---

## 1. 背景与目标

Plan 1（数据采集）+ Plan 2（执行/监控/通知）+ Plan 2.5（5 个交易所适配器 + 全 Docker 开发模式）已经完成，项目能在本地 Docker 环境里跑通完整流程。

Plan 3 的目标：**让代码从本地 Docker 开发一步进入生产可用状态**，具体指：

- 代码 push 到 main 时自动跑类型检查 / 测试 / 构建验证
- 打一个 git tag（`v*.*.*`）时自动构建生产镜像 → 推到 ghcr.io → 部署到腾讯云硅谷节点
- 部署失败自动回滚到上一个版本，并通过 Telegram 通知
- 所有生产 secrets 只存在服务器本地，GitHub 不接触真实的 API Key / 加密 Key / DB 密码
- 用户从浏览器通过 `https://arbitrage.tadacamp.com` 访问，走 Cloudflare 代理

**前置事实**：
- 腾讯云硅谷节点，2 核 4G
- 已装 Docker + Docker Compose
- 已有宿主机 nginx 在跑 tadacamp.com 相关的其它站点
- 域名 `tadacamp.com` 由 Cloudflare 托管且 DNS 已接入
- 这个项目要分配二级域名 `arbitrage.tadacamp.com`
- Repo 私有，托管在 `github.com/caiyin-bit/arbitrage`

---

## 2. 决策 & 讨论过程

本节按 brainstorm 的顺序记录每个关键决策、考虑过的备选、最终选择和理由。这样未来重读时能理解「为什么当初选 X 而不是 Y」，需求变化时可以重新评估，而不是盲目遵守。

### Q1. 子项目拆分

原始 Plan 3 范围覆盖三大块：回测引擎、CI/CD、生产部署。评估后认为回测和 CI/CD 几乎无依赖，塞进一个 spec 会过大。

**备选**：
- A. 回测引擎优先 —— 先验证策略真实收益
- B. CI/CD + 生产部署优先 —— 先打通上线链路，实盘小资金验证
- C. 回测 + CI/CD 并行

**选择 B**。理由：用户希望先拿到生产链路，能用真实资金（哪怕小额）跑起来，这样策略假设能被市场快速证伪；回测作为独立后续项目。

---

### Q2. 部署触发方式

**备选**：
- A. Push to main 自动部署（最快，但 main 坏 = 生产坏）
- B. Git tag 触发部署（push to main 只验证，tag 才部署）
- C. 服务器侧 Watchtower 拉模式（CI 不需要 SSH 私钥，但部署时间不可控）
- D. 分多环境混合 —— 不适用（只有一台机器）

**选择 B**。理由：
1. 早期项目策略还没验证，不想每次小改都上线
2. Tag 本身就是天然的版本记录，回滚直接拉指定 tag 就行
3. Push to main 的 CI 只做验证，保留快速迭代的同时把上线节奏控制在人工触发

---

### Q3. 反向代理 & HTTPS

**前提**：服务器已有宿主机 nginx 在跑其它站点；域名通过 Cloudflare 代理。

**备选**：
- A. 复用宿主机 nginx，新增一个 server block
- B. 新起 Traefik/Caddy 容器自动管理证书 —— 会和宿主机 nginx 抢 80/443
- C. 把 nginx 迁进 docker compose —— 改动太大

**选择 A**。理由：宿主机已有 nginx 在服务其它站点，侵入最小。

**HTTPS 简化**：因为 Cloudflare 代理模式终止了 SSL，宿主机 nginx **完全不需要证书**，只要一个普通 HTTP `server { listen 80; }` 反代到 `127.0.0.1:3000` 即可。连 certbot 都省了。

**派生安全要求**：因为 Cloudflare 代理让宿主机 80 端口理论上可被任何人直连（跳过 WAF），生产部署必须在腾讯云安全组里只放行 Cloudflare IP 段到 80 端口。写进 bootstrap runbook。

---

### Q4. 首次部署 & secrets 管理

**备选**：
- A. 手写 runbook，人肉照着做一次；secrets 由人直接写到服务器 `.env.production`
- B. 用 Ansible / shell 脚本自动化 bootstrap —— 为一台机器的一次动作写自动化，性价比低
- C. 全部走 CI —— GitHub Actions 拿到 sudo 私钥 + 改 nginx + 写 secrets。安全面太大

**选择 A**。理由：单机单次操作，写自动化的工程成本 > 手工操作的时间成本；Cloudflare DNS / 腾讯云安全组这些环节天然是人工的，自动化不了。

**Secrets 分工**：
- **存在服务器本地**：`/srv/arbitrage/.env.production`，`chmod 600 root:root`。所有真实敏感信息（`ENCRYPTION_KEY`、`DATABASE_URL`、Telegram token、交易所 API keys 通过用户界面后续写入数据库所以不在文件里）都在这里
- **存在 GitHub Secrets**：只有 `SSH_HOST` / `SSH_USER` / `SSH_KEY` / `SSH_PORT`。**GitHub 永远不接触 production secrets**
- **原则**：泄露 GitHub 仓库 write 权限 ≠ 能看到任何生产 secret

---

### Q5. Prisma Migration 策略

**背景**：Dev 环境目前用 `prisma db push`（直接同步 schema，不产生 migration 文件）。生产如果沿用会有 3 个问题：没有 migration 历史、破坏性改动静默丢数据、多环境 schema drift 无审计。

**备选**：
- A. 生产切 `prisma migrate deploy`，dev 保留 `db push`，上线前冻结当前 schema 成首个 migration
- B. 生产也继续 `db push`，只适合 pre-launch 丢数据无所谓的情况
- C. 混合过渡：先 `db push`，等真实交易数据进来再切 `migrate deploy`

**选择 A**。理由：
1. 项目涉及真实资金，`trade_logs` / `positions` / `settlements` 数据丢失 = 丢钱
2. 一开始就建立 migration 历史，避免后期经历"切换时刻"这种高风险操作
3. 冻结当前 schema 只是一个 one-shot task，不会拖延 Plan 3 进度

**派生约束**：Migration 必须**向后兼容**（旧 app 能跑在新 schema 上），这样 deploy.sh 先跑 migration 再切 app 时，如果新 app 启动失败回滚到旧 app，旧 app 也能吃得住已经改过的 schema。这是 Plan 3 交付物之一 `docs/deploy/migration-guide.md` 的核心内容。

---

### Q6. 数据库备份策略

**备选**：
- A. Cloudflare R2 每日定时备份 + 部署前临时 dump（完整方案）
- B. 腾讯云 COS 同账号备份
- C. 只做本地备份 + 人工定期 scp 下载
- D. MVP：只做部署前临时 dump，没有定时异地备份

**选择 D**。理由：
1. 用户倾向最小化 Plan 3 范围、尽快上线
2. 「部署前临时 dump」已经覆盖 90% 的风险场景（部署翻车要回滚）
3. 日常运行期间 Postgres 容器挂盘的场景，作为 follow-up 补 R2 异地备份

**明确承认的风险**：Plan 3 上线后到 R2 备份就位前，如果宿主机磁盘挂了，所有数据丢失。用户接受这个风险。

---

### Q7. 部署失败的回滚机制

**备选**：
- A. 自动回滚：health check 失败 → `docker compose` 拉旧 tag + `psql` restore dump + Telegram 告警
- B. 手动回滚：只发告警，人工 ssh 进去处理
- C. 不回滚：只存 dump 作兜底，出大事人肉恢复

**选择 A**。理由：
1. 单人项目 + 国内时区，半夜部署挂了没人响应就是挂一夜
2. Health route 也就十几行代码
3. 回滚丢掉的 1 分钟数据在本项目可接受，因为：
   - 三层 idempotency 协议保证重试不会重复下单
   - Health check 失败说明新版本根本没正常跑起来，大概率没写任何交易
   - 但 runbook 明确要求：回滚后人工比对一次交易所实际仓位 vs `positions` 表

**隐含要求**：新增 `/api/health` 路由，检查 Prisma + Redis 连通性。这是 Plan 3 的一个 task。

---

### Q8. 生产 Dockerfile

**备选**：
- A. 多阶段 standalone 构建（deps / builder / runner）
- B. 单阶段全量构建（2GB+ 镜像，不推荐生产）

**选择 A**。理由：镜像体积 ≤300MB、启动快、攻击面小。

**派生约束 & 取舍**：
- `next.config.ts` 必须加 `output: 'standalone'`
- `schema.prisma` 必须加 `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]`（alpine 是 musl libc，Prisma 默认 binary 跑不动）
- **Dockerfile.prod 用 `node:20-alpine`（docker.io 官方 tag），不用 dev 里的 `local/node:20-alpine`** —— 因为 CI 在 GitHub runner 上跑，runner 能访问 docker.io。代价：本地无法构建 Dockerfile.prod。可接受，因为开发时不构建 prod 镜像。

---

### CI 环境 & Repo 可见性

- **Runner**：GitHub-hosted（Self-hosted 在 2C4G 同机跑构建 + 生产服务会 OOM）
- **Repo**：保持 private。私有 repo 每月 GitHub Actions 2000 分钟免费额度 + ghcr.io 无限私有存储 + 500MB/月免费出站，按一周一次发版的频率完全够用。
- **CI 失败通知**：默认 GitHub 邮件（CI 失败频率远低于 deploy 失败，不专门接 Telegram，避免通知噪声）

---

## 3. 架构总览

### 3.1 请求链

```
用户浏览器
   │  HTTPS
   ▼
Cloudflare (proxy, SSL termination, WAF)
   │  HTTP (HTTP→Origin, 仅 CF IP 段可达)
   ▼
腾讯云硅谷节点 (2C4G)
   │
   ├─ 宿主机 nginx:80
   │    server_name arbitrage.tadacamp.com
   │    proxy_pass http://127.0.0.1:3000
   │
   └─ Docker 容器（单 network, docker-compose.prod.yml）
        ├─ app     — ghcr.io/caiyin-bit/arbitrage:vX.Y.Z → next start (standalone)
        ├─ postgres — postgres:15-alpine + pgdata volume
        └─ redis    — redis:7-alpine
```

### 3.2 部署链

```
开发者 push main ────────▶ GitHub Actions (ci.yml)
                            └─ lint + typecheck + vitest + prisma migrate + next build
                               （不推镜像、不部署）

开发者 git tag v0.1.0
      git push --tags ─────▶ GitHub Actions (release.yml)
                              ├─ docker buildx build Dockerfile.prod
                              ├─ docker push ghcr.io/.../arbitrage:v0.1.0
                              └─ ssh deploy@server /srv/arbitrage/deploy.sh v0.1.0
                                  │
                                  ▼ 服务器本地 deploy.sh
                                  ├─ pg_dump → /srv/arbitrage/backups/
                                  ├─ docker pull
                                  ├─ prisma migrate deploy (临时容器)
                                  ├─ docker compose up -d app (新镜像)
                                  ├─ curl /api/health × 5
                                  └─ 成功: 更新 .current-tag + Telegram 成功告警
                                     失败: 拉旧 tag + psql restore + Telegram 失败告警
```

---

## 4. 组件设计

### 4.1 `src/app/api/health/route.ts`

新增路由。返回 200 条件：
- `prisma.$queryRaw\`SELECT 1\`` 成功
- `redis.ping()` 返回 `PONG`

任一失败返回 503。响应体包含每项子检查的状态，方便人工调试。

**为什么放在 app 里而不是 compose healthcheck**：compose healthcheck 只能检查容器进程活着，不能检查 DB/Redis 可达。deploy.sh 需要的是「app 能正常处理业务请求」的信号。

### 4.2 `Dockerfile.prod`

三阶段：

1. **deps**：`pnpm install --frozen-lockfile`（含 dev 依赖，因为 builder 需要 typescript/next 等）
2. **builder**：`pnpm prisma generate` → `pnpm next build` → `pnpm prune --prod`
3. **runner**：基于 `node:20-alpine`，只 COPY `.next/standalone` + `.next/static` + `public` + Prisma schema + generated client + query engine binary。非 root 用户 (`app:app`) 运行。入口 `node server.js`。

详细 Dockerfile 见设计讨论分段 3/5。Plan 文档会给出完整文件内容。

### 4.3 `docker-compose.prod.yml`

与 `docker-compose.yml`（dev）的区别：

| 项 | dev | prod |
|---|---|---|
| app image | `build: .` | `image: ghcr.io/caiyin-bit/arbitrage:${TAG}` |
| 源码挂载 | `- .:/app` | 不挂载 |
| `node_modules` volume | anonymous | 无 |
| `.next` volume | anonymous | 无 |
| env_file | `.env.local` | `.env.production` |
| watch 相关 env | `WATCHPACK_POLLING` 等 | 不设 |
| `ports` | `3000:3000` | `127.0.0.1:3000:3000`（只绑 localhost，nginx 反代） |

### 4.4 `scripts/deploy.sh`

由 GitHub Actions 通过 SSH 触发。参数 `$1 = TAG`。

职责：备份 DB → 拉镜像 → 跑 migration → 切换 app → health check → 成功记录版本 / 失败自动回滚。

完整逻辑见设计分段 2/5。关键点：
- Migration 在独立临时容器里先跑，先于 app 容器重启 —— app 启动时 schema 一定对的
- Health check 5 次（间隔 12 秒），总窗口 60 秒
- 失败回滚顺序：**先切回旧 app 镜像，再 restore DB**（尽量先让服务恢复，再处理数据）
- 记录 `.current-tag` / `.failed-tag` 两个文件，便于故障排查

### 4.5 `scripts/rollback.sh`

人工兜底。参数 `$1 = TAG`（要回到哪个版本）。不做 DB restore（人工操作要求更可控），只切换 app 镜像。

### 4.6 `.github/workflows/ci.yml`

**触发**：`push: [main]` + `pull_request`

**Job**：`verify`
- `services: postgres + redis`（GH Actions 原生支持的 service 容器）
- `pnpm install --frozen-lockfile`
- `pnpm prisma generate` + `pnpm prisma migrate deploy`
- `pnpm lint` + `pnpm tsc --noEmit` + `pnpm vitest run` + `pnpm next build`

**为什么 CI 里也跑 migration**：确保每个 migration 文件在干净 DB 上能跑通，防止开发时手写坏的 migration 合进 main。

### 4.7 `.github/workflows/release.yml`

**触发**：`push: tags: ['v*.*.*']`

**Job**：`build-and-deploy`
- `docker/login-action` → `ghcr.io`（用自动提供的 `GITHUB_TOKEN`）
- `docker/setup-buildx-action`
- `docker/build-push-action`
  - file: `Dockerfile.prod`
  - tags: `ghcr.io/caiyin-bit/arbitrage:${{ github.ref_name }}` + `:latest`
  - cache: `type=gha`
- `appleboy/ssh-action` → `/srv/arbitrage/deploy.sh ${TAG}`

**Permissions**：`contents: read`, `packages: write`。

---

## 5. 交付物清单

### 5.1 代码改动

- `next.config.ts` — 加 `output: 'standalone'`
- `prisma/schema.prisma` — 加 `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]`
- `prisma/migrations/0_init/migration.sql` — 冻结当前 schema 成首个 migration
- `src/app/api/health/route.ts` — 健康检查端点
- `src/server/services/notifier/telegram.ts` — 新增 `deploy_succeeded` / `deploy_failed` event type
- `Dockerfile.prod` — 多阶段 standalone 构建
- `docker-compose.prod.yml` — 生产编排
- `.dockerignore` — 补全排除项（`.git`、`node_modules`、`.next`、`docs`、`.claude`、`*.md` 等）
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `scripts/deploy.sh`
- `scripts/rollback.sh`

### 5.2 文档

- `docs/deploy/bootstrap.md` — 首次部署 runbook（11 章，见设计分段 5/5）
- `docs/deploy/migration-guide.md` — Prisma migration 向后兼容指南
- `docs/deploy/troubleshooting.md` — 常见故障排查速查表

### 5.3 测试

- **单元**：`/api/health` route 的 happy / sad path（mock prisma / redis）
- **集成**：`deploy.sh` 的 dry-run 模式 —— 在本地 docker 环境模拟完整部署 + 故意让 health check 失败验证回滚路径

### 5.4 验收标准

1. `git tag v0.1.0 && git push --tags` → 5-10 分钟后 `https://arbitrage.tadacamp.com/api/health` 返回 200
2. 故意加一个启动时抛异常的改动 → 打 tag → deploy.sh 自动回滚；Telegram 收到 `deploy_failed`；旧版本仍在服务；`https://arbitrage.tadacamp.com` 仍然 200
3. CI workflow（`ci.yml`）对每个 PR 和 main push 自动跑通
4. GitHub Actions 永远不接触真实 `.env.production` —— 通过 `gh secret list` 验证只有 SSH 相关 secret

---

## 6. 明确不在 Plan 3 范围内（Follow-up 项目）

- **Cloudflare R2 异地备份** —— 等 Plan 3 上线稳定后补
- **日志聚合 / Loki / Grafana** —— 2C4G 跑不动完整 observability stack，等升级配置或上云再做
- **蓝绿部署 / 零停机** —— 单机跑不起两套 app + postgres，下次升配或增机器时做
- **Staging 环境** —— 同上
- **回测引擎**（原 Plan 3 范围的另一部分）—— 独立 spec / plan 循环
- **CI 性能优化（cache tuning、并行 job）** —— 现在跑 5 分钟可接受，等慢了再优化
- **Prisma migration 的自动回滚** —— migration 失败直接告警人工介入，不自动反向 migrate（自动反向太危险）

---

## 7. 风险 & 应对

| 风险 | 可能性 | 影响 | 应对 |
|---|---|---|---|
| Prisma alpine binary target 漏配 | 中 | 高（app 启动崩） | CI 里跑 `next build` 验证 + 首次本地构建 prod 镜像 smoke test |
| Cloudflare 代理下宿主机 80 被直连绕过 WAF | 中 | 中 | 腾讯云安全组限制 CF IP 段 + nginx allowlist 二层防护 |
| GH Actions runner IP 不固定，SSH 入站规则必须 0.0.0.0/0 | 高 | 中 | 接受，但 deploy 用户限制为非 root + 只能跑 deploy.sh（`ForceCommand`）|
| Migration 写坏导致 deploy 卡在 migration 阶段 | 中 | 高 | CI 里强制跑 migration；migration-guide.md 要求所有破坏性改动走两阶段（add col → dual-write → drop col） |
| 宿主机磁盘挂盘丢数据（Plan 3 没有异地备份） | 低 | 极高 | 接受；follow-up 补 R2 |
| 本地 pnpm-lock 和 CI 不一致 | 低 | 中 | `--frozen-lockfile` 强制失败 |

---

## 8. 开放问题（实现期再定）

- Migration 失败时 deploy.sh 怎么处理？**初步方案**：不继续往下走、不自动回滚（migration 反向操作太危险）、发 Telegram 告警让人工介入。具体文案放到 plan 里。
- `deploy_succeeded` / `deploy_failed` 消息的具体字段格式 —— plan 里定。
- Rollback 后人工比对交易所仓位的具体操作步骤 —— 放 troubleshooting.md。
- nginx server block 是否加 `client_max_body_size`、gzip 等 —— plan 里给一份完整推荐配置。
