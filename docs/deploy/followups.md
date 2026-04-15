# Plan 3 Follow-ups

生产环境从 2026-04-15 起正式跑在 `https://arbitrage.tadacamp.com` 上（Vultr Tokyo），以下是 Plan 3 验收时明确推迟的工作项。按优先级排序。

## 🔴 P1 — 安全相关，应尽早

### F1. Cloudflare SSL 升级到 Full 模式

**现状**：CF SSL 模式是 **Flexible** —— 浏览器 → CF 走 HTTPS，但 **CF → 源站 nginx 走 HTTP 明文**。中间任何网络节点（ISP / CF 和 Vultr 之间的 transit）都能看到请求和响应内容。对于一个涉及真实资金的交易平台，这是不能长期接受的。

**目标**：CF SSL 模式改成 **Full**，源站 nginx 用 Cloudflare Origin Certificate 提供 HTTPS。

**怎么做**：
1. Cloudflare Dashboard → SSL/TLS → Origin Server → Create Certificate
2. 生成一对 15 年有效期的证书和私钥（Cloudflare 签发，只有 CF 会信任）
3. 在服务器 `/srv/arbitrage/nginx/certs/` 下放 `origin.pem` + `origin.key`
4. 修改 `nginx/conf.d/arbitrage.conf` 加 `listen 443 ssl` + `ssl_certificate` / `ssl_certificate_key` 指令
5. `docker-compose.prod.yml` 的 nginx service `ports:` 加 `- "443:443"`
6. Vultr 防火墙加 443 端口对 CF IP 段的放行规则（IPv4 15 条）
7. 回 CF Dashboard → SSL/TLS 改成 **Full**（不是 strict —— 我们用的是 CF 自签 origin cert，不是公开 CA 签发的）
8. 测试 `curl -v https://arbitrage.tadacamp.com/api/health` 仍然 200

**估时**：1-2 小时。

---

### F2. Vultr 防火墙的 443 端口规则

和 F1 绑在一起 —— 当 F1 做到 nginx 监听 443 时，Vultr Firewall Group 也要加 443 对 CF IPv4 段的放行。

---

## 🟡 P2 — 运维健壮性

### F3. pg_dump 异地备份到 Cloudflare R2

**现状**：deploy.sh 每次部署前 pg_dump 备份到本机 `/srv/arbitrage/backups/`，但磁盘一挂就什么都没了。没有异地副本。

**目标**：每日定时（cron）+ 每次部署前，把 dump 上传到 Cloudflare R2（免费 10GB + 零出站流量费）。保留策略：每日 7 份 + 每周 4 份。

**怎么做**：
1. 注册 R2 bucket，申请 API token
2. 服务器装 `rclone`（或用 aws-cli）
3. 写 `scripts/backup-to-r2.sh` 并加到 systemd timer 或者 cron
4. 修改 deploy.sh 的 step 1 pg_dump 完后立刻上传一份到 R2

**估时**：2-3 小时。

---

### F4. 清理旧镜像和旧 backup 文件

**现状**：`docker pull ghcr.io/caiyin-bit/arbitrage:v*` 每次都新增一个镜像层到服务器磁盘。`/srv/arbitrage/backups/*.sql.gz` 每次部署 +1。长期会塞满磁盘。

**目标**：加 cron 任务每周清理：
- 旧 docker 镜像：只保留最近 3 个 tag（`docker image ls` sort + prune 老的）
- 旧 pg_dump：只保留最近 10 份

具体命令见 `troubleshooting.md` 第 10 章，只需把它们加到 `crontab -e`。

**估时**：30 分钟。

---

### F5. deploy.sh 自动分发

**现状**：`scripts/deploy.sh` 是项目源码的一部分，但服务器上的那个是首次部署时手动 scp 上去的。**改了之后不会自动同步** —— 需要手动 scp 一次（今天 Task 18 就是这样踩过坑）。

**目标**：要么把 deploy.sh 打进镜像（`/app/scripts/deploy.sh`）然后 release.yml 额外 ssh 一次把它从容器里拷到 `/srv/arbitrage/`，要么让 release.yml 直接 scp。

**怎么做**（推荐后者）：在 `.github/workflows/release.yml` 的 "Trigger deploy over SSH" step 之前加一个 `scp` action 同步 `scripts/deploy.sh` 到 `/srv/arbitrage/deploy.sh`。

**估时**：30 分钟。

---

### F6. Seed 脚本能在 prod image 里跑

**现状**：`src/server/db/seed.ts` 用 `tsx` 跑，但 `Dockerfile.prod` 的 prune 把 tsx 删了（devDep）。bootstrap 时需要用 dev 镜像 + port-forward 才能跑 seed，见 `troubleshooting.md` 第 11 章。

**目标**：让 seed 可以直接用 prod image 跑，或者把默认 settings 改成首次启动时自动插入（app 启动代码里检测空表就 seed）。

**估时**：1-2 小时。推荐改成 app 启动自动 seed，逻辑更干净。

---

## 🟢 P3 — 优化 / Nice to have

### F7. Cloudflare SSL 观察阶段的 Logger

开几天 Cloudflare Logs → 观察有没有意外流量类型。免费版看不到完整日志但能看统计。

### F8. 监控 / 告警

- Grafana Cloud 免费版装一个 dashboard（Prisma 连接数 / Redis 命中率 / BullMQ 任务堆积）
- Telegram 还没配 bot，deploy 成功/失败通知都在 skip —— 建一个专用 bot 补上

### F9. 镜像体积优化

当前 prod image ~1.6GB（未压缩）。可以通过 `node-linker=hoisted` 或 `pnpm deploy` 砍到 300-500MB。但现在不是瓶颈，拉取时间也能接受。

### F10. lint-debt 清理

Plan 3 Task 12 的时候为了让 CI 通过，把 `@typescript-eslint/no-explicit-any` 和 `react-hooks/set-state-in-effect` 降级成 warning。应该专门开一个 plan 清理掉所有 any 和两个 setState-in-effect 违规，然后重新把规则提升回 error。

---

## 怎么用这份清单

- 这是 **Plan 3 的债务记录**，不是 Plan 4 或之后的新功能
- 每个条目是一个独立可做的小项目，不需要连贯做
- 新开一个会话时如果我想做这些，直接挑一个告诉 Claude，它会从这里开始
- 做完一项就从这份文档里删掉对应条目
