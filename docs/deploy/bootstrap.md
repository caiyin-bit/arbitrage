# Bootstrap Runbook — 首次部署到腾讯云硅谷节点

> **This is a one-shot runbook.** 首次部署时走一遍，之后不再碰。所有后续部署走 `git tag v*.*.*` 触发 GitHub Actions `release.yml`。

**目标**：把一台装了 Docker + Docker Compose、有 nginx 在跑的服务器，配置成能接收 `deploy.sh` 发来的生产部署。

## 0. 前提检查

SSH 登录服务器后，确认：

```bash
docker --version          # >= 20.10
docker compose version    # >= 2.0
nginx -v                  # 已装
cat /etc/os-release       # 记录 OS 版本
```

---

## 1. 创建 deploy 用户

用 deploy 专用的非 root 账户避免把生产服务器 root 权限暴露给 CI。

```bash
sudo useradd -m -s /bin/bash deploy
sudo usermod -aG docker deploy      # 可以跑 docker 命令
```

验证 deploy 可以跑 docker：

```bash
sudo -u deploy docker ps
```

预期：成功列出容器（可能为空）。如果报 `permission denied`，需要重新登录一次刷新 group。

---

## 2. 生成 SSH key 给 GitHub Actions

**在本机（不是服务器）**生成：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/arbitrage_deploy -C "github-actions@arbitrage" -N ""
```

把 **public** key 放到服务器的 deploy 用户：

```bash
# 在本机
cat ~/.ssh/arbitrage_deploy.pub
# 复制输出

# 在服务器
sudo -u deploy mkdir -p /home/deploy/.ssh
sudo -u deploy chmod 700 /home/deploy/.ssh
echo "<paste public key here>" | sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys
sudo -u deploy chmod 600 /home/deploy/.ssh/authorized_keys
```

**private** key（`~/.ssh/arbitrage_deploy`）稍后 Step 9 粘进 GitHub Secrets。

从本机测试 SSH：

```bash
ssh -i ~/.ssh/arbitrage_deploy deploy@<server-ip>
```

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
   ```bash
   dig +short arbitrage.tadacamp.com
   ```
   预期：看到 Cloudflare IP（104.21.x.x 或 172.67.x.x），**不是**你服务器真实 IP。

---

## 4. 腾讯云安全组

只允许 Cloudflare IP 段访问 80 端口，防止绕过 CF WAF。

拿 Cloudflare 最新 IP 段：

```bash
curl -sS https://www.cloudflare.com/ips-v4
curl -sS https://www.cloudflare.com/ips-v6
```

在腾讯云控制台 → 云服务器 → 安全组：
- 入站规则：
  - 22 端口：`0.0.0.0/0` ALLOW（或限制为你本机 IP + 0.0.0.0/0 放行 GH Actions，权衡自决）
  - 80 端口：**只放行 Cloudflare IPv4 + IPv6 段**（上面 curl 返回的列表，一条条加）
  - 443 端口：视情况 —— 如果 nginx 只监听 80 就不需要
- 出站规则：全放行

**验证**：从不在 CF 段的 IP curl 你的服务器 80 应该 timeout；通过 `https://arbitrage.tadacamp.com` 访问应该通（Task 8 完成后才会）。

---

## 5. 宿主机 nginx server block

```bash
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
```

预期：`nginx -t` 返回 `syntax is ok` + `test is successful`。

---

## 6. 创建 /srv/arbitrage 目录结构

```bash
sudo mkdir -p /srv/arbitrage/backups
sudo mkdir -p /srv/arbitrage/scripts
sudo chown -R deploy:deploy /srv/arbitrage
```

---

## 7. 写 /srv/arbitrage/.env.production

在服务器上创建（**所有真实 secret 都在这个文件**）：

```bash
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
```

**注意**：
1. `DB_PASSWORD` 和 `DATABASE_URL` 在 compose `env_file` 里一起加载，compose 会先展开 `${DB_PASSWORD}`。
2. 这里的 `DB_PASSWORD` 随机生成一次永久保存 —— 丢了重建需要 restore DB。
3. 这个文件**只有 root 可读**，deploy 用户在跑 `docker compose` 时需要通过 compose 的 `env_file:` 加载 —— compose 以 docker daemon 身份读文件，不受 deploy 用户权限限制。

---

## 8. 复制 docker-compose.prod.yml 和 scripts 到服务器

在本机：

```bash
scp -i ~/.ssh/arbitrage_deploy docker-compose.prod.yml deploy@<server-ip>:/srv/arbitrage/
scp -i ~/.ssh/arbitrage_deploy scripts/deploy.sh deploy@<server-ip>:/srv/arbitrage/
scp -i ~/.ssh/arbitrage_deploy scripts/rollback.sh deploy@<server-ip>:/srv/arbitrage/
scp -i ~/.ssh/arbitrage_deploy scripts/notify-deploy.sh deploy@<server-ip>:/srv/arbitrage/scripts/
```

在服务器上：

```bash
chmod +x /srv/arbitrage/deploy.sh /srv/arbitrage/rollback.sh /srv/arbitrage/scripts/notify-deploy.sh
```

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

```bash
echo "<paste-pat>" | sudo -u deploy docker login ghcr.io -u <your-github-username> --password-stdin
```

预期：`Login Succeeded`。凭据存在 `/home/deploy/.docker/config.json`。

### 10.3 让 CI 先推一个镜像

在本机：

```bash
git tag v0.1.0
git push origin v0.1.0
```

观察 GitHub Actions。**预期**：`release.yml` 会跑 "Build and push" 成功（镜像到 ghcr.io），但 "Trigger deploy over SSH" 这步 deploy.sh 会**失败**，因为服务器还没有 postgres / redis 容器 —— 这一步失败可接受，我们只要镜像被推上去了。

### 10.4 服务器上手动拉起 postgres + redis（首次）

```bash
ssh -i ~/.ssh/arbitrage_deploy deploy@<server-ip>
cd /srv/arbitrage
docker compose --env-file .env.production -f docker-compose.prod.yml up -d postgres redis
```

等 10 秒，验证：

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

预期：postgres + redis 都是 `Up (healthy)`。

### 10.5 手动跑 migration

```bash
TAG=v0.1.0 docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  -e DATABASE_URL="postgresql://arbitrage:${DB_PASSWORD}@postgres:5432/arbitrage" \
  app node_modules/.bin/prisma migrate deploy
```

预期：`The following migration(s) have been applied: 0_init`。

### 10.6 手动跑 seed（首次需要默认 settings）

```bash
TAG=v0.1.0 docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
  app node dist/server/db/seed.js 2>/dev/null \
  || TAG=v0.1.0 docker compose --env-file .env.production -f docker-compose.prod.yml run --rm \
       app sh -c "cd /app && node -e 'console.log(\"seed may be unavailable in standalone build — check troubleshooting.md\")'"
```

**注意**：Next standalone build 可能不含 `tsx` 和 `src/server/db/seed.ts`。如果这一步跑不通，临时解决办法：用 dev image 跑一次。写进 `troubleshooting.md` 的 "Seed 在 prod image 里跑不了" 章节。

### 10.7 启动 app

```bash
TAG=v0.1.0 docker compose --env-file .env.production -f docker-compose.prod.yml up -d app
sleep 15
curl -sS -w "\nHTTP %{http_code}\n" http://127.0.0.1:3000/api/health
```

预期：HTTP 200，body `{"status":"ok",...}`。

### 10.8 记录 baseline tag

```bash
echo "v0.1.0" > /srv/arbitrage/.current-tag
```

### 10.9 从本机验证外部可达

```bash
curl -sS -w "\nHTTP %{http_code}\n" https://arbitrage.tadacamp.com/api/health
```

预期：HTTP 200。如果是 502 检查 nginx 配置 + app 容器是否在 localhost:3000 监听。如果是 Cloudflare 521 检查 Step 4 安全组是否放行 CF IP。

---

## 11. 验证 release.yml 全链路

打第二个 tag，这次应该完整成功：

```bash
git tag v0.1.1
git push origin v0.1.1
```

预期：
1. GH Actions `release.yml` 整个 job 绿
2. 服务器上 `/srv/arbitrage/.current-tag` 内容变为 `v0.1.1`
3. Telegram 收到 `🚀 Deploy succeeded: v0.1.1 / Previous: v0.1.0 / Duration: XXs`

**恭喜，CI/CD 全链路打通。**

---

## Bootstrap 完成后的日常流程

以后所有部署都只需要：

```bash
git tag v0.1.2
git push origin v0.1.2
```

然后去看 Telegram 消息 + GitHub Actions 页面。如果失败了自动回滚；如果需要手动回退：

```bash
ssh deploy@<server-ip>
/srv/arbitrage/rollback.sh v0.1.1
```
