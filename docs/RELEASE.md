# 提交、推送与远端部署

本页是 Drift Space 的发布操作手册，供开发者和 Agent 执行。产品使用 GitHub `main` 作为当前生产代码来源，`deploy.sh` 是唯一部署入口。实现任务完成并不自动意味着可以提交、推送或部署；按当前请求及会话中已有的用户授权执行。用户一次提出「commit、push、部署」即授权完整流程，无需每一步重复确认。提交、推送、部署是三个独立结果，交付时分别报告。

当前生产目标（2026-10-06 核对）：SSH `chris@ssh.kakamlab.com`，仓库 `~/workspace/KAKAM-Harness`，公开地址 `https://drift.kakamlab.com`，Compose 项目 `kakam-harness`，应用监听宿主机 `127.0.0.1:3600`。共享 Memory 身份已分配，生产 `.env` 保存 `COMPOSE_FILE=compose.yaml:compose.memory-shared.yaml`；数据库接入与备份见 [Memory 数据库](MEMORY_DATABASE.md)。目标如有变更，先核对真实部署状态并同步本页；不要把登录密钥或真实 `.env` 写进仓库。

## Git 提交规范

一次提交只表达一个可审查的变更。标题使用 `type(scope): summary`，scope 可省略；summary 简短、用动词描述最终行为，例如：

```text
feat(chat): add retry for interrupted replies
fix(models): preserve reported usage on failed diagnostics
style(ui): refine shell spacing and surface hierarchy
docs: document commit and deployment workflow
```

常用 type 为 `feat`、`fix`、`style`、`refactor`、`test`、`docs`、`chore`。不要用 `update`、`misc` 等无法说明内容的标题。跨模块、数据迁移或部署变更在正文简述动机、验证及文档同步；简单修订不必填充模板。提交标题和说明描述最终实现，不写聊天过程或未完成的计划。

执行顺序：

1. `git status --short --branch` 确认分支、已有暂存和未跟踪文件；保留他人改动。按 [开发指南的验证矩阵](DEVELOPMENT.md#选择有意义的验证)完成检查，文档变更至少检查格式、链接和示例。
2. `git fetch origin main`，再用 `git rev-list --left-right --count HEAD...origin/main` 看本地独有与远端独有提交。右侧非零时先核对并整合远端变化；不要在不清楚差异时强推或重置。生产部署只使用已经进入 `main` 的提交。
3. 按文件路径暂存本次变更，例如 `git add src/features/chat/client.tsx tests/e2e/chat.spec.ts docs/UI_GUIDE.md`。不要用 `git add .` 把 `output/`、备份或别人的草稿一起收入；不要提交真实 `.env`、数据库、凭据、Cookie、`dist/` 或 `test-results/`。
4. 用 `git diff --cached --name-only`、`git diff --cached --stat` 和 `git diff --cached --check` 核对提交范围与空白错误；审阅实际暂存差异，确认没有密钥或个人数据。已有暂存项也属于待提交内容，不能忽略。
5. `git commit -m "type(scope): summary"`。提交后用 `git show --stat --oneline HEAD` 和 `git status --short --branch` 复核。若只授权提交，到这里结束。
6. 推送属于已授权范围时，对当前分支推送；当前生产流程在 `main` 上使用 `git push origin main`，然后对照 `git rev-parse HEAD` 与 `git ls-remote origin refs/heads/main` 的完整 SHA。若仓库改为受保护分支，走 PR 与合并流程，不绕过保护或使用 `--force`。

不要默认修改上一个提交、跳过钩子、强推、清空工作树或替用户提交无关文件。需要修正尚未推送的自己提交时可另作判断；已推送提交优先新增修复提交，保留审计历史。

## 生产部署流程

部署会重建并重启容器，正在生成的模型回复会中断；选择合适时间执行。浏览器离开不断流只适用于服务进程仍在运行的情况。**部署前备份必须完成，部署后以健康检查和公开域名验证为准。**

### 1. 本地与远端预检

确认待部署提交已经推送到 GitHub `main`，记下 `git rev-parse HEAD` 的完整 SHA。通过 SSH 只读检查远端：

```bash
ssh chris@ssh.kakamlab.com
cd ~/workspace/KAKAM-Harness
git status --short --branch
git rev-parse --short HEAD
test -f .env
docker compose config --quiet
docker compose ps
docker volume inspect kakam-harness_kakam-data --format '{{.Name}}'
```

远端应在 `main`，工作树干净，`.env` 已存在，Compose 项目和数据卷沿用原有配置。若远端有未提交改动、工作目录或项目名不符，先查明来源，不直接覆盖或删除。首次安装按 [README 的远端配置](../README.md#远端部署)单独准备；以下是已有生产实例的更新流程。

### 2. 备份配置与数据

启用 Memory 的部署还需在应用暂停写入的同一窗口导出 PostgreSQL，配套保存原 `MEMORY_NAMESPACE`、`.env` 和 SQLite；下面的基础脚本只复制平台数据。共享接入使用 `export COMPOSE_FILE=compose.yaml:compose.memory-shared.yaml`；可选本地数据库沿用 `compose.yaml:compose.memory.yaml`。所有 Compose 命令使用 `--env-file .env`。按 [Memory 数据库备份与恢复](MEMORY_DATABASE.md#备份隔离恢复与回滚)增加 `pg_dump -Fc`；Monitor 的备份不覆盖 Drift 业务库。Memory dump 失败同样停止部署，不能仅凭 SQLite 备份继续。

继续在远端仓库目录执行下列块。它短暂停止应用，复制完整 `/app/data` 与 `.env` 到仓库外的私有目录，并在退出时恢复原本运行的服务。备份路径要记入本次部署记录，不放进 Git 或聊天日志中的文件内容。

```bash
(
  set -euo pipefail
  umask 077
  drift_backup_dir="$(mktemp -d ../drift-space-backup.XXXXXX)"
  drift_was_running=0
  if docker compose ps --status running --services | grep -qx app; then
    drift_was_running=1
  fi
  drift_restore_service() {
    if (( drift_was_running )); then docker compose start app >/dev/null; fi
  }
  trap drift_restore_service EXIT
  docker compose stop app
  docker compose cp app:/app/data "$drift_backup_dir/data"
  cp .env "$drift_backup_dir/.env"
  test -f "$drift_backup_dir/.env"
  test -d "$drift_backup_dir/data"
  test -n "$(find "$drift_backup_dir/data" -name kakam.sqlite -type f -print -quit)"
  printf '备份目录：%s\n' "$drift_backup_dir"
)
```

任何备份步骤失败都停止部署，先确认服务恢复。`.env` 中的 `APP_SECRET` 必须与数据库配套保留；建议把备份另存到服务器外的私有位置。不要运行 `docker compose down -v`，也不要为更新重新生成 `.env`。数据、密钥和卷的关系见 [README 的备份说明](../README.md#备份与重新构建)。

### 3. 拉取指定提交并部署

共享 Memory 同一次预检、备份和部署始终使用 `COMPOSE_FILE=compose.yaml:compose.memory-shared.yaml`，保留项目名、SQLite 卷、分配的库 / schema 和 namespace；本地可选数据库使用 `compose.yaml:compose.memory.yaml` 并保留 Memory 卷。不要混合或省略当前 overlay。`deploy.sh` 构建后先运行应用账号的集中迁移，启动后执行只读检查；基础健康检查不能代替 `/api/health/memory`。首次接入需先由管理员分配身份并安装扩展；可执行步骤见 [数据库接入](MEMORY_DATABASE.md#发布与验收)。

在同一远端仓库目录，将占位符替换为本地已推送的**完整** SHA。以下块会在拉取到别的提交、`.env` 改变或部署失败时停止。正常更新使用快进拉取，不改 Compose 项目名和卷名。

```bash
(
  set -euo pipefail
  drift_expected_commit='<已推送的完整 SHA>'
  drift_env_before="$(sha256sum .env | cut -d ' ' -f1)"
  git pull --ff-only origin main
  test "$(git rev-parse HEAD)" = "$drift_expected_commit"
  ./deploy.sh
  test "$(sha256sum .env | cut -d ' ' -f1)" = "$drift_env_before"
)
```

`PUBLIC_ORIGIN` 使用浏览器实际访问的 `https://drift.kakamlab.com`，不是 Cloudflare Tunnel 的 Target 域名；现有配置通常无需修改。变更域名、端口或代理时，先核对 [README 的配置说明](../README.md#远端部署)，再编辑远端 `.env` 并重新运行 `./deploy.sh`。不要在命令输出或提交中打印真实配置。

### 4. 验证并交付

```bash
git rev-parse --short HEAD
git status --short --branch
docker compose ps
curl -fsS -o /dev/null -w 'local health: %{http_code}\n' http://127.0.0.1:3600/api/health
curl -fsS -o /dev/null -w 'public web: %{http_code}\n' https://drift.kakamlab.com/
```

确认容器为 `healthy`、两处返回 HTTP 200、远端 HEAD 等于本次提交；公开地址最好再从部署服务器以外访问一次，必要时比较首页引用的带哈希资源与本次构建。交付时分别写明提交 SHA、推送分支、部署目标与结果、备份路径、实际通过的检查，以及任何无法确认的部分。单有 `git pull` 或容器显示 `running` 不能宣称新版已上线。

若构建或健康检查失败，先保留备份并查看 `docker compose ps` 与经过脱敏的少量应用日志，确认旧容器是否仍可用。不要自动 `git reset --hard`、清卷或直接把数据库交给旧镜像：新版本可能已执行追加迁移。恢复代码与数据应按故障具体原因制定，并告知用户当前线上状态。
