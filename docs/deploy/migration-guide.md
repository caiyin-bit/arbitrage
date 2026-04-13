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

**正确**：大多数类型扩宽（比如 Decimal(10,6) → Decimal(12,6)）是兼容的；类型收窄（VARCHAR(255) → VARCHAR(100)）必须两阶段：先加新列、迁移数据、切代码、删旧列。

### 改外键 / 索引的唯一性

**错误**：把一个 `@unique` 加到已有列上，如果存量数据有重复会失败。

**正确**：先做一次数据清理 migration（手写 SQL 删重复），再加 `@unique`。分两次发版。

---

## Migration 开发流程

1. 改 `prisma/schema.prisma`
2. 本地（dev 容器内）生成 migration：
   ```bash
   docker compose exec app pnpm prisma migrate dev --name <descriptive_name>
   ```
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
