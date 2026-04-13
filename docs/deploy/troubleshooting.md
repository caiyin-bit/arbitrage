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
```bash
ssh deploy@<server-ip>
curl -sS -w "\nHTTP %{http_code}\n" http://127.0.0.1:3000/api/health
```

**可能原因 & 解决**：
- 127.0.0.1:3000 不响应 → app 容器挂了。`docker compose ps`，看日志 `docker compose logs app --tail 100`
- 127.0.0.1:3000 响应但 80 不通 → nginx 配置挂了。`sudo nginx -t && sudo systemctl status nginx`
- 80 通但外网 521 → 腾讯云安全组没放行 Cloudflare IP 段，重新对一遍 bootstrap Step 4

---

## 2. 502

**症状**：浏览器看到 nginx 502 Bad Gateway。

**检查**：
```bash
curl http://127.0.0.1:3000/api/health
sudo tail -50 /var/log/nginx/error.log
```

**原因**：nginx 能处理请求但 upstream（3000 端口）不响应。
- app 容器没起 → `docker compose ps`
- 容器在但 Next 还在启动 → 等 30 秒重试
- 端口监听在 `0.0.0.0:3000` 而 nginx 配的是 `127.0.0.1:3000` → 检查 compose file `ports` 配置是否是 `127.0.0.1:3000:3000`

---

## 3. /api/health 503

**症状**：`curl /api/health` 返回 503，body 里 `checks.database` 或 `checks.redis` 是 `error`。

**检查**：
```bash
curl -s http://127.0.0.1:3000/api/health | jq
docker compose logs postgres --tail 50
docker compose logs redis --tail 50
```

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
```bash
ssh deploy@<server-ip>
cd /srv/arbitrage
# 重跑 migration 看详细错误
TAG=$(cat .failed-tag) docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  -e DATABASE_URL="postgresql://arbitrage:${DB_PASSWORD}@postgres:5432/arbitrage" \
  app node_modules/.bin/prisma migrate deploy
```

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
   ```bash
   docker image pull ghcr.io/caiyin-bit/arbitrage:<failed-tag>
   docker run --rm ghcr.io/caiyin-bit/arbitrage:<failed-tag>  # 看启动错误
   ```
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
   ```bash
   # 拉一个确定能跑的老 tag
   TAG=<known-good> docker compose --env-file .env.production -f docker-compose.prod.yml up -d app
   # 手动 restore DB
   gunzip -c backups/<dump>.sql.gz | docker compose --env-file .env.production -f docker-compose.prod.yml exec -T postgres psql -U arbitrage arbitrage
   ```
4. 修完后写一份 post-mortem 到 `docs/incidents/`

---

## 9. Telegram 收不到通知

**检查顺序**：
1. `/srv/arbitrage/.env.production` 里 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 都非空
2. 手动跑 `/srv/arbitrage/scripts/notify-deploy.sh` 模拟一次：
   ```bash
   DEPLOY_KIND=deploy_succeeded DEPLOY_TAG=test DEPLOY_PREV_TAG=v0.0.1 DEPLOY_DURATION=10 \
     /srv/arbitrage/scripts/notify-deploy.sh
   ```
3. 直接 curl Telegram API 检查 token：
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/getMe"
   ```

---

## 10. 磁盘满

**症状**：`df -h /` 接近 100%。

**清理命令**：
```bash
# 删旧 docker 镜像（保留最近 3 个 tag）
docker image ls ghcr.io/caiyin-bit/arbitrage --format '{{.Tag}} {{.ID}}' | \
  grep -v latest | sort -rV | tail -n +4 | awk '{print $2}' | xargs -r docker image rm

# 删旧 pg_dump（保留最近 10 个）
ls -1t /srv/arbitrage/backups/pre-deploy-*.sql.gz | tail -n +11 | xargs -r rm

# docker 系统清理
docker system prune -f
```

**长期解决**：加 cron 每周自动跑上面的清理命令。Plan 3 follow-up 项。

---

## 11. Seed 在 prod image 里跑不了

**症状**：bootstrap step 10.6 跑 seed 报 `Cannot find module 'tsx'` 或 `Cannot find module '/app/dist/server/db/seed.js'`。

**原因**：Next standalone build 只打包 `next` 运行时需要的文件，不会包含 `src/server/db/seed.ts`（tsx 脚本）也不跑 tsc。

**应急方案**：首次用 dev image 跑一次 seed：
```bash
# 在开发机器上（不是服务器），连服务器的 postgres
ssh -L 55432:postgres:5432 deploy@<server-ip> &
# 等隧道建立
DATABASE_URL=postgresql://arbitrage:<DB_PASSWORD>@localhost:55432/arbitrage pnpm tsx src/server/db/seed.ts
kill %1
```

**长期方案**（Plan 3 follow-up）：把 seed 编译成 `.next/standalone/seed.js` 或者在 Dockerfile.prod 里显式 COPY `src/server/db/seed.ts` 和 tsx runtime。
