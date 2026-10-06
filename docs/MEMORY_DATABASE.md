# Memory 共享数据库接入与运维

本文是 Memory 数据库配置、迁移和运维的主要说明。Memory API 见 [接口文档](MEMORY_API.md)，策略与设置 UI 见 [开发指南](MEMORY_AGENTS.md)。接入依据是 KAKAM-Monitor 的 `docs/shared-database-onboarding.md`。

## 接入身份与职责

生产使用现有 PostgreSQL 16 / pgvector 共享实例。平台账户、原始聊天、模型、用量和上下文快照继续保存在原 SQLite 卷；Memory 使用专属数据库及 schema。2026-10-06 已在当前服务器分配以下 Drift 身份，并验证受限账号、密码认证、搜索路径和扩展；应用上线仍以部署后的数据库健康检查为准。其他环境必须另行分配数据库及凭据。

| 配置                        | 值                                           |
| --------------------------- | -------------------------------------------- |
| 共享容器与应用连接地址      | `kakamlab-db:5656`                           |
| 外部网络                    | `kakamlab-db-net`                            |
| Drift 数据库                | `kakamlab_drift_memory_db`                   |
| 运行 / 迁移账号             | `kakamlab_drift_memory`                      |
| 业务 schema                 | `drift_memory`                               |
| namespace                   | `drift-space`，已有数据后沿用原值            |
| 原 Compose 项目 / SQLite 卷 | `kakam-harness` / `kakam-harness_kakam-data` |

管理员管理账号、库、schema、授权和 `public.vector` 扩展。应用只使用自己的账号创建 Memory 业务表和索引，不创建或改动共享数据库容器、网络和卷，不使用 `kakamlab_admin`、Monitor 或 observer 账号运行。账号初始连接限额为 16；默认池上限为 5，需要合计所有副本、进程和临时迁移容器的连接。

## 管理员首次分配

在服务器检查基础设施，进入管理员终端：

```bash
docker inspect kakamlab-db --format '{{.State.Health.Status}}'
docker network inspect kakamlab-db-net >/dev/null
docker exec -it kakamlab-db psql -X -v ON_ERROR_STOP=1 \
  -U kakamlab_admin -p 5656 -d postgres
```

先查询身份是否存在：

```sql
SELECT datname FROM pg_database WHERE datname = 'kakamlab_drift_memory_db';
SELECT rolname FROM pg_roles WHERE rolname = 'kakamlab_drift_memory';
```

首次创建 SQL 位于 [provision-shared.sql](../infra/memory/provision-shared.sql)。核对后在该管理员终端执行其内容；`CREATE DATABASE` 在事务外执行。已有对象应核对并复用，不删除重建、不自动重置密码。该文件创建受限登录账号、撤销数据库 `PUBLIC` 权限、授予应用连接与建 schema 的权限、指定角色搜索路径 `drift_memory, public`、建立应用所有的业务 schema、撤销 `public` 的公共建表权限，并由管理员安装 vector。应用账号和业务表归属应一致。

随后通过交互终端设置随机密码：

```text
\password kakamlab_drift_memory
```

凭据只交付到应用服务器的私有环境文件或既有安全渠道；无需在聊天中提供密码。业务库和角色独立不等于 CPU、磁盘和连接容量独立。

## 应用环境与 Compose

保留 `/home/chris/workspace/KAKAM-Harness/.env` 的现有配置和 `APP_SECRET`，追加下列项目；占位密码必须替换，并按 URI 用户信息部分编码特殊字符：

```dotenv
MEMORY_DATABASE_URL=postgresql://kakamlab_drift_memory:replace-with-url-encoded-password@kakamlab-db:5656/kakamlab_drift_memory_db
MEMORY_NAMESPACE=drift-space
MEMORY_DB_SCHEMA=drift_memory
MEMORY_DB_HOST=kakamlab-db
MEMORY_DB_PORT=5656
MEMORY_DB_NAME=kakamlab_drift_memory_db
MEMORY_DB_USER=kakamlab_drift_memory
MEMORY_DB_POOL_MAX=5
MEMORY_DB_APPLICATION_NAME=drift-space-memory
COMPOSE_FILE=compose.yaml:compose.memory-shared.yaml
```

`MEMORY_DB_SCHEMA` 校验管理员设置的 `current_schema()`，不会覆盖 `search_path`。指定 schema 不存在、不是搜索路径首项、非应用账号所有，或角色具有实例管理权限时，Memory 拒绝初始化。所有必要表及迁移记录必须归应用账号所有，vector 必须位于本库的 `public` 且保留 public 搜索路径。未指定 schema 的本地开发兼容原角色搜索路径。

四项 `MEMORY_DB_HOST / PORT / NAME / USER` 是 Monitor 元数据，一旦设置任意一项就必须完整且与实际 URL 一致。URL 不允许以查询参数覆盖主机、端口、账号或库名，避免标签与驱动实际连接不同。`MEMORY_DB_POOL_MAX` 为 1–16，默认 5；`MEMORY_DB_APPLICATION_NAME` 默认 `drift-space-memory`，仅帮助辨认连接。namespace 继续用于部署隔离，Manager 在所有私人查询中同时限定 owner。

```bash
chmod 600 .env
export COMPOSE_FILE=compose.yaml:compose.memory-shared.yaml
docker compose --env-file .env config --quiet
```

[共享 overlay](../compose.memory-shared.yaml) 将 app 加入原默认网络及现有外部数据库网络，保留项目名、端口和 SQLite 卷，不声明数据库服务或数据库卷。四个 `kakamlab.db.*` labels 仅含主机、端口、库名和账号；Monitor 当前不识别 `MEMORY_DATABASE_URL`，因此通过 labels 关联应用。labels 不证明连接成功。Compose 会把标签所用的同一元数据显式传入容器，应用校验它们与连接 URL 一致。

当前生产 `.env` 保存 `COMPOSE_FILE=compose.yaml:compose.memory-shared.yaml`，使之后的部署、预检和备份沿用同一组合；示例的显式 export 也使用相同值。所有管理命令沿用同一 `COMPOSE_FILE` 和 `--env-file .env`。Shell 同名变量可能覆盖 Compose 插值；部署前清理残留覆盖。不要打印 `docker compose config` 的完整输出，凭据不进入 Git、镜像或日志。

## 迁移、检查、断线恢复

迁移集中在 [memory-database.ts](../src/kernel/memory-database.ts)。应用以数据库 / schema 范围的 advisory lock 串行执行追加迁移；迁移记录和业务表位于当前业务 schema。初始化只检查扩展，不执行 `CREATE EXTENSION`。迁移不在 HTTP 请求或模型调用事务中执行。

构建后提供两个独立命令，均无需启动平台、访问 SQLite 或调用模型：

```bash
npm run build
npm run memory:migrate
npm run memory:check
```

生产镜像中的对应入口为 `node dist/server/memory-db.js migrate` 和 `check`。`check` 只读连接、扩展、表归属和迁移版本，不补建结构；失败退出码为 1。成功输出库名、账号、schema、搜索路径、application_name、pgvector 和迁移版本，不输出密码或完整 URL。

连接超时为 5 秒，SQL 超时 10 秒，客户端查询上限 12 秒。后台初始化失败或连接中断后以 1 秒起、最大 30 秒的退避重试，恢复时重新核对结构并幂等迁移；关闭插件清理定时器与连接池。连接失败不会改用另一个数据库。普通聊天跳过不可用的 Memory，设置显示安全的失败原因；恢复后的首次操作会清理本进程启动前遗留的任务状态，任务本身不跨重启续跑。

`GET /api/health` 保持平台存活检查。无需登录的 `GET /api/health/memory` 使用应用连接执行 `SELECT 1` 并检查 schema / 扩展 / 迁移归属：配置且就绪返回 200 / `ok`，配置但不可用返回 503 / `unavailable`；未配置或插件停用返回 200 / `unconfigured` 或 `disabled`。响应仅含配置、就绪状态和安全说明，无业务数据。Docker 的基础存活检查仍使用平台接口，Memory 故障不阻断普通聊天。

## 发布与验收

遵循 [发布手册](RELEASE.md)：本地完成验证、提交并推送 `main`，远端核对干净工作树、备份现有 `.env` 与完整 SQLite 数据，已有 Memory 时还需同一写入暂停窗口的 PostgreSQL dump，之后才快进到指定已推送提交。接入配置修改也先备份旧 `.env`。不能用未推送的本地源码部署。

首次共享接入，在管理员分配和本地代码推送完成后于远端项目目录执行：

```bash
export COMPOSE_FILE=compose.yaml:compose.memory-shared.yaml
git pull --ff-only origin main
docker compose --env-file .env config --quiet
./deploy.sh
curl --fail --silent http://127.0.0.1:3600/api/health/memory
```

`deploy.sh` 构建镜像，发现 `.env` 配置 Memory 后以应用账号非交互运行一次迁移，再更新 app，并执行只读数据库检查。迁移命令禁用 TTY 且标准输入来自 `/dev/null`，避免批量 SSH 部署吞掉后续核验命令。首次分配失败会在替换应用前停止。若手动拆分同一流程：

```bash
docker compose --env-file .env build app
docker compose --env-file .env run --rm --no-deps -T app node dist/server/memory-db.js migrate < /dev/null
docker compose --env-file .env up -d --wait app
docker compose --env-file .env exec -T app node dist/server/memory-db.js check
```

通过现有设置页进行一次手动记忆保存、读取、编辑和删除，确认属于当前用户；在配置授权的 Embedding 后验证实际维度与召回（实际模型调用可能产生费用，不用生产模型作为自动测试夹具）。在 Monitor 数据库管理页核对专属数据库、受限账号授权、app 容器及当前连接；等待约 5–10 秒采样后刷新。短连接没有出现在采样快照里不等于故障。

本地的自动行为测试使用临时 PostgreSQL/pgvector 与 mock provider，`MEMORY_TEST_DATABASE_URL` 必须指向隔离测试库。不得把生产库作为测试夹具。

## 备份、隔离恢复与回滚

Monitor 的基础设施备份不自动覆盖 Drift 业务库。每次部署与迁移前，暂停 app 写入，将 SQLite、`.env`、namespace、角色授权记录和以下管理员 dump 放在仓库外同一私有目录。设定每日备份、保留周期和离机位置由部署管理员落实；当前仓库没有自动备份定时任务。

```bash
umask 077
drift_backup_dir="$HOME/workspace/backups/drift-space/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$drift_backup_dir"
docker exec kakamlab-db pg_dump -U kakamlab_admin -p 5656 \
  -d kakamlab_drift_memory_db -Fc > "$drift_backup_dir/memory.dump.tmp" && \
  mv "$drift_backup_dir/memory.dump.tmp" "$drift_backup_dir/memory.dump"
```

只有成功退出后得到的正式 `.dump` 有效，失败停止发布；备份目录权限 700、文件 600。SQLite 和 `.env` 的配套备份命令见发布手册；不可复制运行中的 PostgreSQL 原始目录替代逻辑备份。

隔离恢复时管理员另建临时恢复库、专属恢复角色及应用所有的 `drift_memory` schema，预装兼容 pgvector 并配置相同搜索路径。`pg_restore --schema` 不恢复 schema 本身，须先在恢复库执行 `CREATE SCHEMA drift_memory AUTHORIZATION <恢复应用角色>`，并授予该角色 public 的 USAGE 权限。随后在没有运行应用连接的情况下执行下例，由恢复角色拥有业务表。只恢复业务 schema，保留管理员预装的 public 扩展，避免以应用角色恢复扩展的定义或注释；使用 `--no-owner` 后不要把表留给管理员。

```bash
docker exec -i kakamlab-db pg_restore -U kakamlab_admin -p 5656 \
  -d '<隔离恢复库>' --schema=drift_memory --no-owner --no-privileges --role='<恢复应用角色>' \
  --exit-on-error < "$drift_backup_dir/memory.dump"
```

在该隔离库核对表数、行数、schema / 表所有者、向量空间与迁移版本；使用隔离的 SQLite / `.env` 副本及原 namespace / 用户 ID 验证真实读写。不要对生产库执行 `--clean` 或重置脚本。

已有本地或其他 PostgreSQL 记忆数据时，不能只替换 URL。先冻结写入并配套导出，记录原 namespace / 用户 ID / schema；在隔离库完成 schema 映射、所有权调整、必要 pgvector 安装和导入核验后，再安排切换。默认 public schema 的旧 dump 不能直接当作 drift_memory 数据恢复；本仓库没有自动跨 schema 迁移工具。

回滚应用使用已推送且兼容当前 schema 的旧提交重新构建；镜像回滚不会回滚迁移。若要回退数据库，恢复到新隔离库完成核验后协调 SQLite、`.env` 和 namespace 一起切换，保留原库与备份。首次启用失败可恢复旧环境配置和 Compose 组合继续普通聊天，不删除共享库、网络、卷或他人数据。

## 本地可选数据库

[compose.memory.yaml](../compose.memory.yaml) 保留为本地开发方案，不能与共享 overlay 同时使用。设置本地 URL `postgresql://memory:<编码密码>@memory-db:5432/drift_memory` 和 `MEMORY_DB_PASSWORD`，不设置共享 schema / 元数据。新卷由只用于本地的 [初始化 SQL](../infra/memory/local-init.sql) 预装 vector；既有卷若缺扩展需开发数据库管理员补装，不删除卷解决问题。该开发容器账号由镜像初始化，不能将其管理员权限模式照搬到生产共享实例。

```bash
COMPOSE_FILE=compose.yaml:compose.memory.yaml ./deploy.sh
```
