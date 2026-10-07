# Drift Space · Personal Chatbot

基于真实 **Cordis 3.18.1** 引擎的个人 / 小型多用户 AI 工作区。KH-Kernel 在 Cordis 上负责 feature 装配、能力目录、核心能力保护和插件启停；每个 feature 将 `manifest`、`server`、`client` 放在一起。

当前版本 v0.8.0 采用 **Node.js 24 + TypeScript + Express + React + Vite + SQLite**，可选 Memory 使用 **PostgreSQL/pgvector**。UI 参考提供的 KAKAM Demo、Notion 和 ChatGPT，适配桌面和手机。

## 开发者与模型入口

首次接手项目先读 [开发指南](docs/DEVELOPMENT.md)；模型协作规则统一放在根目录 [AGENTS.md](AGENTS.md)。

| 文档                                           | 内容                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| [开发指南](docs/DEVELOPMENT.md)                | 技术栈、目录、修改入口、工作流、验证与规范同步矩阵                              |
| [架构说明](docs/ARCHITECTURE.md)               | Cordis / KH-Kernel 分工、请求与生命周期、权限、持久化、后台生成                 |
| [功能扩展指南](docs/FEATURES.md)               | 新 feature 的 DTO、数据库、server / client 示例、双注册入口、Service 与 Adapter |
| [UI 组件指南](docs/UI_GUIDE.md)                | 公共组件接口、黑白灰 Shell、Color Pattern、字号、CSS 分层、交互与移动端         |
| [Memory API](docs/MEMORY_API.md)               | 三层记忆 API、权限、版本 / 幂等、索引与操作状态                                 |
| [Memory 数据库](docs/MEMORY_DATABASE.md)       | 共享 PostgreSQL 接入、受限账号、迁移 / 诊断、Monitor、备份与恢复                |
| [记忆策略 / Agent 开发](docs/MEMORY_AGENTS.md) | 服务端策略、专属设置 UI、托管模型和构建期注册                                   |
| [发布手册](docs/RELEASE.md)                    | Commit 规范、推送检查、远端备份、指定提交部署与上线验证                         |

功能或规范变化时，在同次改动中同步对应文档；规则与负责位置见 [规范与文档同步](docs/DEVELOPMENT.md#规范与文档同步)。文档中的教学组件与功能示例不代表已经上线的能力。

## 已实现

| 能力                | 行为                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 账户                | 邮箱 + 显示名称 + 密码注册（首位为管理员），邮箱登录、旧账户绑定邮箱、资料与密码修改、管理用户和角色                                                                             |
| 模型来源            | 仅管理员可见；设置 Base URL / API Key；编辑 / 删除来源；主动探测与定时检查模型列表接口；Chat Completions / Responses / Anthropic Messages / Jev 协议；可选平台链接               |
| 白名单 / 模型注册表 | SQLite `models` 表 + `ModelsService`；手动添加或从探测结果加入；逐模型 LLM / Jev / Embedding 类型、启停、能力、维度与授权；拖动排序与 LLM 默认模型；连通性测试与实际维度诊断     |
| 聊天                | 私有会话、历史持久化、搜索标题、重命名、删除、SSE 流式回复、离开后后台生成与重连同步、停止生成、编辑最后一问及失败 / 停止后重新输出；按用户和模型记忆思考等级                    |
| 多模态              | 文字 + 图片；PNG/JPEG/WebP，每条最多 4 张、每张 5 MB；需选择支持图片的模型                                                                                                       |
| 内容渲染            | 双方消息支持 Markdown、GFM 表格、代码高亮与一键复制、KaTeX 公式、LaTeX 代码块公式预览、Mermaid 图表、输入框实时富文本编辑                                                        |
| Token 统计          | 回复复制按钮旁可查看本次输入 / 输出 / 总量；日期与用户筛选、每日 / 每周 / 累计活动热力图、调用记录；管理员看全局，普通用户仅看自己                                               |
| 拓展能力            | 核心统一托管，统一拓展菜单与灰度管理列表，同步 Auto / On / Off 默认模式；LLM 或 LLM + Jev 自动决策；独立阶段用量与来源记录                                                       |
| 可选插件            | Search：检索与来源引用；Skill 库：版本化指令与参考文件、简介生成、聊天载入；context-manager：自动压缩、逐轮快照、轨迹摘要与 hand-off；管理员可启停，停用移除页面和 API，保留数据 |
| 三层记忆            | 独立 PostgreSQL/pgvector、长期 / 分组 / Session、LLM + Prompt 检索与抽取、Remember it 回复摘要及来源回溯、长期显式纳入、工作区管理、策略内部设置、索引重建与 API                 |
| 界面设置            | 白天 / 黑夜 / 跟随系统，Color Pattern 多色色系、对话分组和卡片选色、头像按账户保存；四档字号在当前设备按用户保存                                                                 |
| 部署                | 多阶段 Dockerfile、Compose 持久化卷、健康检查、`deploy.sh` 一键部署                                                                                                              |

没有预置或虚构模型、聊天或 Token 消耗。首次运行后需要管理员接入模型。

## 一键启动（Docker，推荐）

需要 Docker Engine / Docker Desktop、Compose v2+、Bash、OpenSSL。

```bash
./deploy.sh
```

脚本第一次运行会生成权限为 `600` 的 `.env`，其中只包含随机 `APP_SECRET` 和服务配置；随后构建镜像、启动容器，并等待健康检查通过。**打开网页注册，首位注册用户成为管理员，后续用户为普通用户。** 密码只以加盐哈希保存在数据库，不再通过文件配置。首次远端安装可先通过 SSH 端口转发在私有访问下完成注册，再开放域名。

默认访问 **http://localhost:3600**。统一使用 `deploy.sh` 作为部署入口。

登录后：

1. 「左下角用户 → 设置 → 管理员 → 模型与接入 → 添加来源」填写来源名称、完整 Base URL、API Key 和响应模式。Base URL 必须包含来源要求的 API 前缀，例如 `https://api.example.com/v1`，不要填到 `/chat/completions` 或 `/responses`。可在来源表单中点击「探测模型」，使用当前未保存配置获取列表，不发送聊天请求或修改来源配置。修改地址、密钥或协议后，原探测结果失效。
2. 探测后「保存来源」，在结果列表中选择加入白名单；也可以直接保存，之后通过来源条目的「探测模型」添加，或在「模型管理与授权」手动填写精确模型 ID。探测失败不妨碍手动配置。
3. 已保存模型的「模型设置与授权」提供「连通性测试」，使用来源当前保存的地址、密钥和协议。可选择测试思考程度，显示首段文本、总耗时、文本片段数与实际 Token；最长 60 秒，用量计入当前管理员，失败或未上报也会保留记录。失败时自动展开诊断日志，包含实际请求输入、HTTP 状态、响应体、模型输出和错误；API Key 脱敏，长内容截断，日志不写入数据库。新模型需要先保存。为视觉模型勾选「支持图片输入」。探测 API 通常不返回可靠的能力信息，因此不会自动猜测图片能力。
4. 用户自行注册或由管理员创建，然后在模型设置中授予访问权限。管理员可使用所有已启用模型。
5. 回到「对话」，选择模型并开始聊天。

本地模型在宿主机运行时，容器中使用 `http://host.docker.internal:端口/v1`。容器内的 `localhost` 指向容器自身。

## 上下文管理

「设置 → 上下文管理」可配置自动压缩的字符阈值、最近原文保留轮数、摘要预算与 LLM，也可选择模型在回答完成后生成轨迹节点的标题、意图和回答摘要。两项自动能力默认关闭；原聊天记录保留，辅助调用计入实际用量，失败原因可在上下文抽屉查看。压缩复用摘要并按需增量更新，轨迹摘要可手动重试。设置、计量边界和 API 见 [上下文管理指南](docs/CONTEXT_MANAGER.md)。

## 记忆模块与 PostgreSQL

Memory 插件将长期、分组和 Session 记忆保存到独立 PostgreSQL/pgvector，平台账户、模型、聊天原文和真实用量继续使用 SQLite。工作区「记忆」提供管理和待纳入入口，「设置 → 记忆管理」配置模型与策略；未配置记忆数据库不影响普通聊天，两处均显示未就绪原因。`MEMORY_NAMESPACE` 默认为 `drift-space`，已有数据后保持不变，不作为用户可切换的租户字段。

生产接入 KAKAM Lab 已有 PostgreSQL 16 / pgvector。管理员先分配专属数据库、受限账号、`drift_memory` schema 和 `public.vector` 扩展，然后保留私有 `.env` 的现有配置，追加以下占位项；密码必须 URL 编码，不把真实配置提交到 Git：

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
```

使用共享网络 overlay，保留原项目和 SQLite 卷：

```bash
COMPOSE_FILE=compose.yaml:compose.memory-shared.yaml ./deploy.sh
```

后续命令沿用同一文件组合、`--env-file .env` 和项目名 `kakam-harness`。应用通过四个无密码 labels 让 Monitor 识别连接；元数据必须与 URL 一致。应用只迁移自身业务表，不安装扩展、不覆盖管理员的搜索路径；schema、表归属或扩展不符合约定时拒绝初始化。连接失败后台重试，普通聊天仍可使用。

构建后可运行 `npm run memory:migrate` / `npm run memory:check`；后者只读校验，不补建结构。`deploy.sh` 在替换应用前迁移，启动后检查。`/api/health/memory` 另行报告数据库就绪状态。管理员建库 SQL、权限、部署、Monitor 验收、备份 / 回滚和可选本地 [`compose.memory.yaml`](compose.memory.yaml) 方案统一见 [Memory 数据库接入](docs/MEMORY_DATABASE.md)。两种 overlay 不同时使用；已有记忆不能仅改 URL，需先备份、迁移和核验。

配置步骤：

1. 管理员在「模型管理与授权」添加 `Embedding · 向量模型`，复用现有 OpenAI-compatible 来源和密钥。可指定配置维度，也可使用上游默认；测试显示实际维度、匹配状态、耗时和真实用量。Anthropic / Jev 来源不支持 embedding。
2. 授予普通用户模型访问权；个人在「设置 → 记忆管理」选择 embedding、检索 LLM、抽取 LLM，也可从工作区「记忆」进入策略配置。个人开关默认关闭，配置后启用；开关立即保存并显示生效结果，其他修改点击保存。
3. 选择策略并微调专属内部设置。首版 default 使用 embedding + pgvector 召回候选，再用 LLM + Prompt 选择记忆；也在回答后用 LLM + Prompt 抽取带用户原文证据的草稿。
4. 选择三类写入模式。默认长期候选需确认，分组和 Session 自动保存；长期选择自动时也只存为「待纳入」，不能自动影响其他对话。分组自动保存仅在对话已属于该分组时生效。长期默认无限保留，分组 / Session 默认闲置 30 天；召回近期窗口只影响选择，不删除旧长期记忆。
5. 在工作区「记忆」按作用域、状态、分组和正文 / 标签检索，编辑、置顶、查看来源；在「待纳入与候选」明确批准长期候选或纳入草稿后，才参与后续召回并记录纳入时间。手动新增长期也先待纳入；修改已纳入的长期正文或类型后需再次确认。历史已启用记忆继续保留，未记录过纳入时间的条目明确显示历史状态。
6. 在索引 / 操作页查看模型、维度和进度。修改 embedding 来源、模型或维度后重建向量空间；不同空间不会混查。辅助 LLM 和 embedding 每次调用都计入来源上报的真实用量，缺失字段保留未知。

已完成回复旁提供 **Remember it**：点击后调用所选抽取 LLM 总结「这条回答值得记住什么」，先展示可编辑摘要和原文证据，再由用户选择当前分组或全局长期并确认。选分组直接保存为分组记忆；选长期先保存为待纳入，在记忆管理页明确纳入后生效。没有分组时不能选择分组。摘要保存原始消息引用和哈希，可回溯到本人原文；原回复被编辑 / 修订后拒绝迟到保存，选择分组时还需对话仍在原分组。仅生成预览或取消弹窗不会将内容纳入记忆。

Context Manager 显示实际发送的长期 / 分组 / Session 记忆及 ID、版本、理由和准备状态，回答后抽取单独查看。停用插件保留数据，原聊天继续；重启不自动续跑记忆操作，可查询失败状态后重试。首版没有语义冲突自动替换、原平台历史迁移、原聊天裁剪、任意 Agent 上传或外部 Agent 专用 Token 鉴权。完整接口和策略扩展见 [Memory API](docs/MEMORY_API.md) 与 [记忆策略 / Agent 开发指南](docs/MEMORY_AGENTS.md)。

## 本地开发

需要 Node.js **24+**。平台 SQLite 使用 Node 自带的 `node:sqlite`；未启用记忆时无需外部数据库，记忆需要 PostgreSQL/pgvector；Node 24 可能打印 ExperimentalWarning。

```bash
npm ci
cp .env.example .env
# 编辑 .env：替换 APP_SECRET，并设置 PUBLIC_ORIGIN=http://localhost:5173
npm run dev
```

访问 **http://localhost:5173**。Vite 将 `/api` 代理到 `127.0.0.1:3600`。数据库默认保存在 `data/kakam.sqlite`。

```bash
npm run typecheck
npm test
npm run build
# 生产模式直接运行时，PUBLIC_ORIGIN 应匹配实际访问地址
npm start
```

从 v0.1 更新时，原有账户、模型和对话保持不变；部署脚本移除已不使用的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，不会重置密码。数据库执行追加迁移；沿用 `kakam.sqlite`、Compose 项目名和持久化卷以保留数据。

升级到 v0.4 后，新账户用「邮箱、显示名称、密码」注册，以邮箱登录。已有用户名账户在登录页选择「旧账户绑定邮箱」，填写原用户名、原密码和邮箱完成绑定，保留角色、对话、授权和偏好。已有登录会话也可在账户设置中填写邮箱并用当前密码确认。邮箱忽略大小写且全局唯一；显示名称可重复。当前邮箱作为登录标识，尚未接入邮件验证或邮件找回密码。

本版本默认端口为 3600。升级旧部署时，将已有 `.env` 的 `PORT` 和本地 `PUBLIC_ORIGIN` 同步改为 3600；使用域名时保留域名并更新反向代理的目标端口。

## 远端部署

首次安装或更新统一使用 `./deploy.sh`。现有生产服务器的 SSH 目标、备份、拉取指定提交与上线验证步骤见 [发布手册](docs/RELEASE.md)；不要只凭容器运行状态判断部署完成。首次运行默认仅绑定服务器 `127.0.0.1:3600`，适合放在 Caddy / Nginx 之后。配置 `.env`：

```dotenv
PUBLIC_ORIGIN=https://ai.example.com
COOKIE_SECURE=true
TRUST_PROXY=1
BIND_ADDRESS=127.0.0.1
PORT=3600
```

`PUBLIC_ORIGIN` 必须等于浏览器访问的协议、域名与端口，否则修改类请求会被拒绝。`TRUST_PROXY=1` 仅用于前方有一层可信代理的部署；直接访问时使用 `0`。反向代理负责 HTTPS。无需将模型密钥放入 `.env`，它们由管理员页面配置。

Nginx 代理位置的必要配置（TLS 按服务器已有方式配置）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3600;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 240s;
    client_max_body_size 30m;
}
```

如果要直接通过服务器 IP / 局域网访问，将 `BIND_ADDRESS=0.0.0.0`、`PUBLIC_ORIGIN=http://服务器IP:3600`、`COOKIE_SECURE=false`、`TRUST_PROXY=0`。公开互联网部署应使用 HTTPS。

修改配置后再次执行 `./deploy.sh`。Compose 会保留数据库卷。不要运行 `docker compose down -v`，除非确实要删除所有数据。

常用命令：

```bash
docker compose ps
docker compose logs -f app
docker compose restart app
docker compose down
```

### 备份与重新构建

| 内容                                                             | 保存位置                                                        | 下次构建 / 部署时的行为                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| 服务配置与 `APP_SECRET`                                          | 项目目录中的 `.env`                                             | 文件存在时沿用，不会重新生成密钥。迁移服务器时需要一并恢复。         |
| 用户、密码哈希、头像、对话、图片、模型配置、授权、用量和插件数据 | Docker 命名卷中的 `/app/data`，数据库名 `kakam.sqlite`          | 重建镜像、替换容器时保留；应用启动时按需迁移数据库结构。             |
| 三层记忆、向量、版本、候选和记忆配置                             | 独立 PostgreSQL；可选 Compose 的 `kakam-harness_memory-data` 卷 | 应配套备份 PostgreSQL dump，不能只备份 SQLite。                      |
| 模型供应商 API Key                                               | 数据库中加密保存                                                | 解密依赖原 `APP_SECRET`。原始 API Key 也建议独立保存在密码管理器中。 |
| 域名和 HTTPS 代理配置                                            | 宿主机 Caddy / Nginx 配置（如有）                               | 不受应用构建影响，需单独留档；自行管理的证书私钥也需备份。           |
| 镜像、容器、依赖和 `dist/`                                       | Docker / 构建产物                                               | 可以从代码重新生成，不作为用户数据备份。                             |

脚本仅在 `.env` 不存在时生成 `APP_SECRET`（32 字节随机值，编码为 64 位十六进制字符串）。它不是登录密码，而是模型 API Key 的加密根密钥。**保留数据库却丢失或改掉此密钥，会导致已保存的模型 API Key 无法解密。** 用户密码的随机盐、加密所需的随机 IV 和认证标签已随数据库保存，无需另行抄录。

`PUBLIC_ORIGIN`、`PORT`、`BIND_ADDRESS`、`COOKIE_SECURE` 和 `TRUST_PROXY` 也会沿用，只有更换域名、端口或代理方式时才需要修改。Compose 当前固定项目名为 `kakam-harness`，默认卷名为 `kakam-harness_kakam-data`；正常更新保持项目名与卷的映射不变，避免连接到新建的空卷。字号、最近模型及思考程度等浏览器本地偏好不在服务器备份内。

备份时应将真实 `.env` 与完整数据目录配套保存到私有位置；`.env.example` 只是模板，不能代替真实配置。生产更新前使用 [发布手册的备份步骤](docs/RELEASE.md#2-备份配置与数据)，短暂停止服务再复制，以免遗漏 SQLite WAL 中的内容。

启用 Memory 时还要配套保存 PostgreSQL dump、数据库账号配置和 `MEMORY_NAMESPACE`。在暂停应用写入的备份窗口内，由有权限的数据库账号使用 `pg_dump -Fc` 导出记忆库，并与同一时间点的 SQLite / `.env` 备份放在仓库外的私有目录；共享库的命令和隔离恢复步骤见 [Memory 数据库备份](docs/MEMORY_DATABASE.md#备份隔离恢复与回滚)。可选本地 Compose 服务内的命令为 `pg_dump -U memory -d drift_memory -Fc`，通过 `COMPOSE_FILE=compose.yaml:compose.memory.yaml docker compose --env-file .env exec -T memory-db` 执行并把 stdout 重定向到私有备份文件。恢复继续使用原 namespace 和平台用户 ID。只恢复其中一个数据库可能造成来源 / 用户关联缺失；数据库原始卷的运行中复制不能代替一致的逻辑备份。

备份中包含账户、对话、图片和加密密钥，需按私有数据保管，并另存一份到服务器之外的私有备份位置。迁移时将完整数据目录恢复到新卷并沿用原 `APP_SECRET`。第一版没有自动密钥轮换；更换密钥前需重新录入模型凭据。Git 不保存 `.env` 或数据卷，单纯克隆仓库会创建一套新数据。

## 架构与开发

```text
src/
  kernel/                 KH-Kernel、数据库、HTTP 注册、密钥保险库
  adapters/               模型协议契约、AdapterRegistry、OpenAI 兼容与 Anthropic Messages 实现
  features/
    auth/                 manifest.ts + server.ts + client.tsx
    users/                manifest.ts + server.ts + client.tsx
    models/               manifest.ts + server.ts + client.tsx
    chat/                 manifest.ts + server.ts + client.tsx
    usage/                manifest.ts + server.ts + client.tsx
    preferences/          manifest.ts + server.ts + client.tsx（主题与 Chatbot 头像）
    prompts/              manifest.ts + server.ts + client.tsx（可选插件）
    memory/               Manager、PostgreSQL Repository、策略 / 设置 UI（可选插件）
  server/                 配置、HTTP app 与启动入口
  client/                 Web Shell、UI registry、公共组件和样式
  shared/                 前后端共享 DTO / manifest 契约
tests/                    API 集成、模拟模型服务、浏览器端到端测试
```

完整开发入口见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)；架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，添加功能见 [docs/FEATURES.md](docs/FEATURES.md)，新增或修改 UI 组件见 [docs/UI_GUIDE.md](docs/UI_GUIDE.md)。

## 验证

`npm test` 在临时 SQLite 和真实本地 HTTP 服务上测试邮箱注册 / 迁移 / 唯一性、权限隔离、模型探测 / 白名单 / 授权、图片传递、Token 统计、断开订阅后持续生成与幂等提交、主动停止、插件生命周期、用户停用和重启持久化。浏览器测试覆盖桌面和手机的页面切换、离线恢复、关闭标签页后恢复生成。

浏览器测试使用 **测试专用模拟模型服务**，不调用付费 API，也不修改开发数据库：

```bash
npm run build
npm run test:e2e
```

默认使用已安装的 Google Chrome，分别运行 1440px 桌面和 Pixel 7 手机视口。无 Chrome 的 CI 可先安装 `npx playwright install chromium`，再执行 `PW_CHANNEL=chromium npm run test:e2e`。截图在 `test-results/`。真实来源需用户填入有效地址 / 密钥后做供应商联调。

## 当前范围

- 模型协议支持 OpenAI 兼容 `/models`、流式 `/chat/completions`、`/responses`，非流式 `/embeddings`，以及 Anthropic 原生流式 `/messages` 和分页 `/models`。Gemini 原生协议、语音、视频、PDF / 文档解析、通用 Agent 工具执行与文档 RAG 尚未实现；记忆策略可通过托管工具扩展，模型 Skill 工具读取已有实现。
- Mermaid 在回复完成后渲染，流式阶段显示源码；原始 HTML 不执行，远程 Markdown 图片不会自动加载。附件是私有消息的一部分。
- 用量统计仅记录来源实际上报的 `usage`；缺失、失败、中断明确标记“未上报”，不会用估算数冒充账单。上下文抽屉另提供文本字符占比。没有费用换算或配额计费。
- 单进程、平台 SQLite 卷加可选独立 PostgreSQL，适合个人与小型团队。每用户同时最多一个生成请求；生成空闲 5 分钟或总计 15 分钟超时。长对话到达保护上限需新建对话。聊天列表按分组展示当前账户全部对话（暂不分页），用量详情最多 200 条，汇总不受详情条数限制。
- 插件来自本地可信代码并参与构建；支持已安装插件的启停，未实现上传任意第三方插件、插件沙箱或在线插件市场。
- Core 使用同一 feature 结构，不能从管理页面停用。管理页将 Core（基础能力）与 Plugin（进阶能力）分栏展示，在手机上纵向排列。前端隐藏入口只是体验层，API 层仍独立执行鉴权与数据隔离。

## 导航与设置

- 左侧「工作区」放置对话、Skill 库、记忆；「统计」分组放置用量统计。记忆工作区与设置页使用同一插件，停用或权限过滤同时作用于两处。
- 点击左下角用户栏目进入独立「设置」页：通用设置包含明暗模式、Color Pattern 和 Chatbot 头像；账户设置管理个人资料和密码；相关信息显示版本与数据处理说明。
- 代码高亮使用独立的完整明暗语法色板，随白天 / 黑夜 / 系统模式切换；不继承 Shell 辅助文字颜色或 Color Pattern。首页使用小帆船图标，相关信息提供项目 GitHub 链接。
- 账户设置支持上传个人头像（PNG / JPEG / WebP，最大 10 MB），自动居中裁剪并压缩为不超过 512×512 的图片；用户栏、聊天提问和用户管理列表同步显示，可恢复默认。头像与账户一起保存在 SQLite，刷新和重新登录后保留。
- 聊天输入工具栏采用紧凑布局，模型与思考程度共用一个入口：展开后调节五档强度，进入模型列表可搜索名称或来源；支持键盘、点击外部关闭和按用户 / 模型记住强度。
- Color Pattern 用标签页选择「自然鲜明」或「柔和经典」色系，每组保留 9 色，柔和经典采用更清透的色值和较低的背景不透明度。Shell 背景、正文、辅助文字和导航使用固定黑白灰；色系用于组件背景、边框与图标，不再把全页染成一种颜色。
- 对话分组的编辑窗口与 Skill 卡片的调色板按钮可以从当前色系中选色，也可恢复自动配色；选择随账户保存。切换色系时保留颜色位置，映射到新色系对应颜色。普通对话条目、消息气泡与助手头像使用灰度，不再采用历史单条对话颜色。原有选色数据保留以兼容旧客户端。
- 首页建议、统计卡片与 Token 活动图使用当前色系。自动配色通过稳定标识与顺序分配，刷新、重排对话时不会重新随机变色。
- 管理员在设置页中额外看到「管理员」分组，包含模型与接入、用户管理、功能与插件。普通用户没有这些入口，API 鉴权保持独立。
- 设置子页可通过 URL 直接访问和刷新；原有 `#/auth`、`#/preferences`、`#/models`、`#/users`、`#/features` 链接仍会进入对应设置页。
- 密码仅要求填写，不限制位数、字符类型或组合；注册、登录、修改密码与管理员重置保持一致，密码不裁剪空格，并继续使用加盐哈希存储。

## Skill 库

- 原有提示词自动迁移为单文档 Skill，保留原文、归属、简介、标签、颜色和设置。编辑器支持主指令与 `references/`、`assets/` 下的文本参考文件；每次保存生成新版本。
- 聊天输入框的「附件 → Skill 库」带「插件」标签，可搜索、按标签筛选、在条目内预览并选择最多 8 项；手机端使用底部弹窗，列表滚动时仍可看到已选数量与完成按钮。选择不覆盖消息正文；「载入新对话」也传递技能引用。纯文本模型同样可以打开此入口，图片支持只影响「添加图片」。
- Skill 库卡片展示版本与参考文件数量，桌面和手机都可直接编辑或载入对话；配色、删除位于「更多操作」。手机端标签横向滚动，编辑器将参考文档折叠，减少长列表和长表单的滚动距离。
- 默认「本对话」持续生效，也可切换「仅本轮」。随下一条成功提交的消息保存选择；移除从下一轮起停止注入。既有回答保留。已有对话固定使用选中版本，在选择器点击「更新到 vN」才更新。
- 用户明确选择后载入主指令，模型按需读取参考文件。管理员须在具体模型上勾选「支持工具调用」；未启用时可使用单文档 Skill，含参考文件的技能会在提交前提示更换模型。模型实际工具能力由供应商决定，连接测试不会自动探测此能力。
- 回复的「Skill 载入记录」显示版本、实际读取的文件片段和逐请求用量。回复 Token 为所有回答模型请求的合计，任一请求缺失上报时合计为未知；已知部分仍可在明细和统计中查看。Search 等辅助调用单独统计。
- 首版仅支持文档型 Skill，不执行脚本、不安装依赖、不自动访问文件里的 URL，也不自动扫描整个技能库。完整后续事项见 [Skill TODO](docs/SKILLS_TODO.md)。
- 每张卡片最多 8 个标签，每个最多 24 字符；输入回车或逗号添加，也可选择已有标签。标签忽略大小写去重，支持删除和重设。
- 搜索同时匹配标题、简介、正文与标签；多个关键词和多个选中标签均需同时匹配。搜索和标签筛选可以组合，未匹配时可一键清除。
- 在左下角「设置 → Skill 库」选择简介模型，建议选用速度快的轻量 LLM。可用模型来自模型管理并遵守当前账户授权，选择仅保存到自己的账户。
- 编辑卡片时点击「生成简介」才会调用模型；当前标题与完整正文将交给所选模型，输出最多 160 字符的介绍，可修改后保存。新建、编辑、打开列表不会自动调用模型。未配置模型也可手动填写。
- 生成只返回编辑草稿，失败保留已有介绍；取消 / 关闭编辑窗口、停用插件或服务关闭会取消简介请求。真实 Token 计入用量统计，缺失则显示未上报。模型失去授权时需要重新选择，不能借用管理员权限调用。

## 对话上下文与 hand-off

- 启用 context-manager 后，每轮回复都可打开「上下文」抽屉，以提交记录式的时间线查看历史轮次、编辑 / 重试关系、模型、状态与本轮输入组成。快照只属于当前账户；删除对话会同时删除快照。
- 带记忆元数据的新快照分为 System prompt、长期记忆、分组记忆、Session 记忆和当前 prompt，旧快照兼容四分区。Session 包含本对话记忆、实际历史、Skill / Search 补充与可见工具内容；未注入的部分明确为空。数量为文本字符、UTF-8 字节及图片数；图片保留元数据，不把大小估算为 Token。
- 「上下文字符分布」按字符数量依次填充分区方格，默认每格最多 64 字符，各分类不足一格也单独显示一格，其余格子保持灰色。图表共 224 格，长上下文会自动增大每格字符数并标明刻度；灰格为展示留白，不表示模型剩余容量。紧凑图例显示各部分字符数，支持悬停、键盘聚焦或点击高亮，颜色沿用 Color Pattern。字符数直接使用快照已有的 UTF-16 统计，包含空格与换行，图片不计入；无需分词器或模型调用。详细口径见 [context-manager 接口](docs/FEATURES.md#对话-context-manager)。
- 在「设置 → 上下文管理」选择 hand-off 模型，或在抽屉中选择当前账户有权限的 LLM。点击生成后，模型根据截至所选轮次的记录整理用户意图轨迹、进度、后续方向、文档资料与待确认事项。结果可复制或下载为 Markdown，再交给下一个 agent；不自动读取链接或发送给其他 agent。交接文档仅留在当前抽屉，关闭前需复制或下载。
- 只有主动生成 hand-off 才新增模型调用，真实 Token 计入统计；打开抽屉和保存模型偏好不调用模型。证据过长会明确提示，模型生成的交接内容应在使用前核对。供应商私有推理、图片内容和未载入的文档原文不进入交接。
- 插件停用后停止捕获新轮次，已有聊天继续执行，历史数据保留；重新启用后可继续查看。启用前或停用期间未捕获的轮次无法还原当时上下文。快照与 hand-off 不向后续聊天注入长期记忆，也不让任务跨服务重启续跑。

## 对话分组

- 在侧栏「对话分组」旁点击新建按钮，填写名称，选择文件夹 / 阅读 / 代码 / 工作 / 灵感图标，也可选择或输入一个 emoji；分组名称、图标与 Color Pattern 颜色按账户保存。
- 分组可展开或折叠；点击分组右侧 `+` 直接创建组内对话。现有对话的「更多」按钮打开管理窗口，可改名、选择所属分组或移回「未分组」。一个对话最多属于一个分组。
- 搜索同时匹配对话标题和分组名称，匹配分组名时显示整组对话；搜索期间自动展开命中项。打开已有对话时会展开其分组。
- 删除分组解除归属，全部对话和消息保留在「未分组」，Memory 同时清理该分组记忆，不停止生成。删除对话仍需单独确认。分组只属于当前账户，管理员不能读取或修改其他账户的分组。
- 当前为单层分组，按创建顺序排列；组内对话按最近更新排列。尚不支持嵌套、共享或拖拽排序。

## 字号与长对话阅读

- 「设置 → 通用设置 → 字体大小」提供紧凑 90%、标准 100%（默认）、舒适 112.5%、较大 125%。切换立即生效，预览包含正文、表格、代码、公式与输入文字，并提供恢复默认。
- 基准字号：聊天正文 / 输入 16px，导航 / 按钮 / 代码 14px，辅助说明 12px，页面标题 30px。CSS 语义字号变量统一乘缩放系数，辅助文字始终至少 12px；手机聊天正文沿用相同比例。只对聊天头像和部分控件图标做轻微适配，侧栏宽度与页面布局尺寸不随字号缩放，不使用整页 zoom 或 transform scale。
- 字号使用当前浏览器的 localStorage，按用户 ID 隔离。刷新、退出后重新登录保留；不同设备独立选择，清除浏览器存储会恢复标准档。Color Pattern、组件选色、明暗模式、头像仍由服务器保存。
- 发送新问题会回到最新消息。停留底部时跟随流式输出、图片 / 图表展开；向上翻阅或点击大纲后暂停跟随，点击下箭头即可返回底部并恢复跟随。
- 对话正文左侧的大纲按用户提问生成，鼠标悬停或键盘聚焦显示简介，点击跳到该问题开头；手机可直接点按。重新打开对话时根据完整历史重建大纲，默认定位最新消息。

## 排查 Responses 与 Chat Completions 的速度差异

两种模式均逐片转发文字，不等待最终事件才输出。Responses 的思考参数为 `reasoning.effort`，Chat Completions 为 `reasoning_effort`；本应用的 None 是省略字段，不能当作关闭思考。推理档位和默认值由模型 / 来源决定，第三方中转也可能对两个端点采用不同路由或协议转换，不能仅凭协议名判断哪一种更快。

在「模型设置与授权 → 连通性测试」固定同一个模型、同一档思考程度进行比较。首段文本耗时是应用服务器收到第一段可显示文本的时间，总耗时包含随后输出与结束事件，不包含浏览器到应用的网络时间。若首段快、总耗时慢，检查输出长度和尾部事件；若首段就慢，检查上游排队、推理或中转缓冲。文本片段数不是 Token 数，短回答只有一个片段也不能证明缓冲。

测试不会自动切换协议、重试或替换模型。需要比较另一协议时，在来源中明确保存该协议后再次测试，并留意这会影响使用同一来源的其他模型。短请求的一次测量不是性能保证；对长上下文问题还需同内容、同配置复测。官方依据：[流式输出](https://developers.openai.com/api/docs/guides/streaming-responses)、[思考参数与速度](https://developers.openai.com/api/docs/guides/reasoning)。

## 内容与模型设置

- Chat Completions、Responses 与 Anthropic Messages 均向上游请求 `stream: true`，收到文字增量后立即通过 SSE 显示。提交成功后，生成任务由服务器持有；浏览器离开、锁屏、切换应用、断网或关闭标签页不会取消任务。返回时先同步完整消息，再继续接收增量；已经完成则直接显示完整回复。只有主动点击停止、上游错误、生成超时或服务关闭才会结束任务。
- 后台生成限于当前服务器进程，重启或重新部署不会自动续跑模型请求：已保存的部分回复保留，异常重启的未完成记录标记为失败。客户端恢复连接只订阅结果，不重新提交模型请求；同一个提交 ID 的重试也不会重复调用模型。
- 正在持续输出的长回复不会再在固定 180 秒中断：连续 5 分钟没有新进度或总时长达到 15 分钟才超时。失败会在回复下方保留具体、安全的原因；旧消息若没有记录原因仍显示“回复未完成”。
- 最后一条提问可点击“编辑提问”，在原输入框中修改并发送，替换该轮问答；取消编辑会恢复尚未发送的草稿。最近一次回复失败或手动停止后可点击“重新输出”，保留原提问并使用当前选定模型重新生成。被替换调用的真实 Token 用量仍保留在统计中。
- 输入框使用 Tiptap 实时富文本编辑，直接显示渲染结果，无需切换编辑与预览。支持 Markdown 输入快捷语法与粘贴、粗体、列表、表格、代码、公式和撤销；发送时序列化为 Markdown。点选公式可修改 LaTeX，Mermaid / LaTeX 代码块附带实时预览。桌面普通段落 Enter 发送，Shift + Enter 换行；列表、表格、代码块中 Enter 继续编辑。手机 Enter 换行；Ctrl / ⌘ + Enter 可发送。
- 支持 `$…$`、`$$…$$`、`\(…\)`、`\[…\]`；`latex` / `tex` / `math` 代码块显示公式预览，原文可展开和复制。KaTeX 支持常见数学环境，但不是完整 TeX 编译器，不编译任意宏包、TikZ 或 LaTeX 文档排版。
- 思考程度提供 `none / low / medium / high / extra high`。Extra high 对应 API 的 `xhigh`。**None 完全省略思考字段，由来源使用默认行为，不保证关闭模型内部推理。** 其他等级是否可用取决于具体模型；不支持时选择 None。Chat Completions 使用 `reasoning_effort`，Responses 使用 `reasoning: { effort }`。
- Anthropic 来源选择 **Anthropic Messages**，Base URL 填 `https://api.anthropic.com/v1`（代理填写其 API 前缀），使用 `x-api-key` 与 `anthropic-version: 2023-06-01`。支持文字、图片、模型探测与连通性测试。None 省略思考配置，输出上限为 4096；其他档位发送 `thinking: { type: 'adaptive' }` 和 `output_config: { effort }`，输出上限为 16384（含思考）。这些档位要求模型支持 adaptive thinking 及相应 effort；旧模型或不支持的代理请选择 None，当前不自动降级或重试付费调用。达到输出上限会保留已生成内容并标记未完成。
- 「模型管理与授权」拖动左侧手柄排序，鼠标、手机触控及键盘均可操作（空格选中，上下方向键移动，空格保存，Escape 取消）。顺序自动保存，首个已启用模型标记默认；普通用户按该顺序选择首个有权限的模型。新模型追加至末尾，用户已主动选择的模型优先保留。停用或无授权模型不能成为聊天实际使用的默认模型。
- 来源中的「平台链接」可留空，用于快速打开供应商控制台 / 官网，与 Base URL 分开保存，仅管理员可见，不作为模型请求地址。
- 已保存来源会在启动、添加或修改后即时检查模型列表接口；周期检测按中国时间每天 08:00、10:00、12:00、14:00、16:00、18:00 运行，夜间暂停。来源卡片用绿灯 / 红灯显示结果，页面每 30 秒刷新一次；此检查不发送付费聊天请求。绿灯只表示模型列表接口可访问，某个模型能否生成仍需在其设置中主动运行连通性测试。
- 每条回复下方的用量提示支持悬停、键盘聚焦或手机点击；显示真实上报的输入、输出与合计，刷新后仍保留。历史记录没有用量或供应商未上报时明确显示「用量未上报」，实际零消耗仍显示 0。输入包含本次发送的历史上下文；Anthropic 的输入合计还包含 cache creation / cache read Token，输出累计值取最新值，不重复相加。
- 回复底部与复制、Token 消耗并列显示生成用时，从服务器发起模型请求到结束（含等待与生成）。刷新、重新登录后保留，失败 / 停止时显示“已用时”；旧消息没有计时数据则不显示。
- 用量统计的最近调用表格采用稍大的统一字号；完成标记为绿色，失败为红色，生成中与已停止保持中性，明暗主题均保留清晰文字。
- Responses 使用 `store: false`，历史由本地保存并逐次发送，支持文本与图片、流式结束/失败/不完整事件及真实 Token 用量。
- 热力图使用 UTC 日界线。每日每格一天，每周按周一分组，累计为所选时间范围内的累计值。多模型一天以分段颜色展示，聚焦或点击可查看详情；未上报用量的调用仍保留。

字段依据：[OpenAI Chat Completions 参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[迁移到 Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[推理参数](https://developers.openai.com/api/docs/guides/reasoning)、[Responses 流式事件](https://developers.openai.com/api/docs/guides/streaming-responses)。

Anthropic 字段依据：[Messages](https://platform.claude.com/docs/en/api/messages/create)、[流式事件](https://platform.claude.com/docs/en/build-with-claude/streaming)、[思考程度](https://platform.claude.com/docs/en/build-with-claude/effort)、[图片输入](https://platform.claude.com/docs/en/build-with-claude/vision)。

## 搜索与自动决策

1. 管理员进入「设置 → 拓展能力 → Search → 插件设置」，配置 Search Base URL（默认 `https://api.perplexity.ai`）与 Perplexity Search API Key；每轮最多 1–5 个词条、每个词条 1–10 条结果，默认 3 / 5。密钥加密保存，编辑时留空保留。
2. 回到「拓展能力」的灰度列表，点击该条目的「能力设置」，选择辅助 LLM（默认跟随本轮聊天模型）和 Auto 策略。普通 LLM 输出 `{ "enabled": true / false }`；LLM + Jev 先整理英文输入再调用 Jev 作决定。所有模型都来自模型管理，普通用户必须同时拥有相应模型授权。
3. 使用 Jev 时，在「模型与接入」添加来源：Base URL `https://api.typesafe.ai/v1`，响应模式「Jev 决策」，填写 TypeSafe API Key，探测并添加 `jev-latest` 或供应商支持的精确模型名。Jev 统一在模型管理中排序、授权、启停、测试，分类为决策模型，不参与聊天默认模型选择。
4. 聊天输入栏只显示统一的四菱形拓展图标；点击后展开能力列表，为 Search 等各项能力选择 **Auto（自动）/ On（开启）/ Off（关闭）**，初始为 Off。管理列表的「默认模式」与聊天菜单共用当前账户偏好，修改后双向同步（同源标签页即时通知，重新聚焦和定期刷新兜底），不改变其他账户的选择。Auto 判断是否需要搜索；On 始终生成搜索词并顺序检索；Off 不增加拓展调用。选择按账户保存，提交后模式固定。
5. 回复上方默认显示紧凑的 Search 状态条，实时提示正在判断、生成搜索词、检索进度及完成 / 失败 / 停止状态。点击展开可查看判断结果、搜索词、去重来源和各阶段用量，详情限定高度并在内部滚动。最终回答使用来源编号链接；断网、刷新和离开页面不会中断服务器任务。主动停止会中止拓展和回答生成。管理员停用 Search 会中断当时仍执行的检索，但保留配置与历史来源。

辅助 LLM、Jev 和最终回答的实际 Token 分开记录并汇总到统计；Perplexity Search 不返回 Token usage，检索记录为“未上报”，不估算消耗或价格。没有来源时明确提示；自动判断 JSON 无效或检索失败时本轮标错，不偷偷回退为“已搜索”的回答。

当前利用 Search 返回的摘要归纳，不抓取网页全文，也不保证模型结论绝对真实。每个来源可打开原文核实。辅助模型仅读取最近 6 条文本（每条末尾最多 8000 字符），不接收图片。整个生成任务同样受聊天生成时限限制，不支持跨服务重启续跑。

Jev 使用 `POST /v1/systemone` 和 `Authorization: Bearer <API_KEY>`，连通性测试使用固定英文 state / Choice 问题。官方支持中文等非英语文本，但当前英语准确率较好，因此 Auto 保留前置 LLM 英文整理。HTTP 401 表示密钥缺失或无效，与输入语言无关；在模型来源编辑中核对 TypeSafe 的有效密钥，并查看诊断日志。参见 [TypeSafe 的语言支持](https://docs.typesafe.ai/models#language-support) 与 [错误码](https://docs.typesafe.ai/api#errors)。

接口依据：[Perplexity Search API](https://docs.perplexity.ai/api-reference/search-post)、[TypeSafe Jev API](https://docs.typesafe.ai/api)。后续能力的接入规则见 [功能扩展指南](docs/FEATURES.md#注册托管的-llm-能力)。
