# Drift Space · Personal Chatbot

基于真实 **Cordis 3.18.1** 引擎的个人 / 小型多用户 AI 工作区。KH-Kernel 在 Cordis 上负责 feature 装配、能力目录、核心能力保护和插件启停；每个 feature 将 `manifest`、`server`、`client` 放在一起。

当前版本 v0.7.0 采用 **Node.js 24 + TypeScript + Express + React + Vite + SQLite**。UI 参考提供的 KAKAM Demo、Notion 和 ChatGPT，适配桌面和手机。

## 已实现

| 能力                | 行为                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 账户                | 邮箱 + 显示名称 + 密码注册（首位为管理员），邮箱登录、旧账户绑定邮箱、资料与密码修改、管理用户和角色                      |
| 模型来源            | 仅管理员可见；设置 Base URL / API Key；编辑 / 删除来源；主动探测 `/models`；Chat Completions / Responses 协议；连通性测试 |
| 白名单 / 模型注册表 | SQLite `models` 表 + `ModelsService`；手动添加或从探测结果加入；逐模型启停、图片能力标记、逐用户授权                      |
| 聊天                | 私有会话、历史持久化、搜索标题、重命名、删除、SSE 流式回复、离开后后台生成与重连同步、停止生成；按用户和模型记忆思考等级  |
| 多模态              | 文字 + 图片；PNG/JPEG/WebP，每条最多 4 张、每张 5 MB；需选择支持图片的模型                                                |
| 内容渲染            | 双方消息支持 Markdown、GFM 表格、代码高亮与一键复制、KaTeX 公式、LaTeX 代码块公式预览、Mermaid 图表、输入框实时富文本编辑 |
| Token 统计          | 输入 / 输出 / 总量，日期与用户筛选、每日 / 每周 / 累计活动热力图、调用记录；管理员看全局，普通用户仅看自己                |
| 可选插件            | 提示词库：私有收藏、一键用于新对话；管理员可启停，停用移除页面和 API，保留数据                                            |
| 界面设置            | 白天 / 黑夜 / 跟随系统，Color Pattern 多色色系、对话和卡片选色、头像按账户保存；四档字号在当前设备按用户保存              |
| 部署                | 多阶段 Dockerfile、Compose 持久化卷、健康检查、`deploy.sh` 一键部署                                                       |

没有预置或虚构模型、聊天或 Token 消耗。首次运行后需要管理员接入模型。

## 一键启动（Docker，推荐）

需要 Docker Engine / Docker Desktop、Compose v2+、Bash、OpenSSL。

```bash
./deploy.sh
```

脚本第一次运行会生成权限为 `600` 的 `.env`，其中只包含随机 `APP_SECRET` 和服务配置；随后构建镜像、启动容器，并等待健康检查通过。**打开网页注册，首位注册用户成为管理员，后续用户为普通用户。** 密码只以加盐哈希保存在数据库，不再通过文件配置。首次远端安装可先通过 SSH 端口转发在私有访问下完成注册，再开放域名。

默认访问 **http://localhost:3600**。统一使用 `deploy.sh` 作为部署入口。

登录后：

1. 「左下角用户 → 设置 → 管理员 → 模型与接入 → 添加来源」填写来源名称、完整 Base URL、API Key 和响应模式。Base URL 必须包含来源要求的 API 前缀，例如 `https://api.example.com/v1`，不要填到 `/chat/completions` 或 `/responses`。填写测试模型后可点击「测试连通性」，使用当前未保存配置发送简短请求；消耗计入当前管理员。
2. 「探测模型」后选择加入白名单，或在「模型管理与授权」手动填写精确模型 ID。
3. 为视觉模型勾选「支持图片输入」。探测 API 通常不返回可靠的能力信息，因此不会自动猜测图片能力。
4. 用户自行注册或由管理员创建，然后在模型设置中授予访问权限。管理员可使用所有已启用模型。
5. 回到「对话」，选择模型并开始聊天。

本地模型在宿主机运行时，容器中使用 `http://host.docker.internal:端口/v1`。容器内的 `localhost` 指向容器自身。

## 本地开发

需要 Node.js **24+**。SQLite 使用 Node 自带的 `node:sqlite`，无需外部数据库；Node 24 可能打印 ExperimentalWarning。

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

将仓库复制到服务器后执行 `./deploy.sh`。首次运行默认仅绑定服务器 `127.0.0.1:3600`，适合放在 Caddy / Nginx 之后。配置 `.env`：

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

| 内容                                                             | 保存位置                                               | 下次构建 / 部署时的行为                                              |
| ---------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| 服务配置与 `APP_SECRET`                                          | 项目目录中的 `.env`                                    | 文件存在时沿用，不会重新生成密钥。迁移服务器时需要一并恢复。         |
| 用户、密码哈希、头像、对话、图片、模型配置、授权、用量和插件数据 | Docker 命名卷中的 `/app/data`，数据库名 `kakam.sqlite` | 重建镜像、替换容器时保留；应用启动时按需迁移数据库结构。             |
| 模型供应商 API Key                                               | 数据库中加密保存                                       | 解密依赖原 `APP_SECRET`。原始 API Key 也建议独立保存在密码管理器中。 |
| 域名和 HTTPS 代理配置                                            | 宿主机 Caddy / Nginx 配置（如有）                      | 不受应用构建影响，需单独留档；自行管理的证书私钥也需备份。           |
| 镜像、容器、依赖和 `dist/`                                       | Docker / 构建产物                                      | 可以从代码重新生成，不作为用户数据备份。                             |

脚本仅在 `.env` 不存在时生成 `APP_SECRET`（32 字节随机值，编码为 64 位十六进制字符串）。它不是登录密码，而是模型 API Key 的加密根密钥。**保留数据库却丢失或改掉此密钥，会导致已保存的模型 API Key 无法解密。** 用户密码的随机盐、加密所需的随机 IV 和认证标签已随数据库保存，无需另行抄录。

`PUBLIC_ORIGIN`、`PORT`、`BIND_ADDRESS`、`COOKIE_SECURE` 和 `TRUST_PROXY` 也会沿用，只有更换域名、端口或代理方式时才需要修改。Compose 当前固定项目名为 `kakam-harness`，默认卷名为 `kakam-harness_kakam-data`；正常更新保持项目名与卷的映射不变，避免连接到新建的空卷。字号、最近模型及思考程度等浏览器本地偏好不在服务器备份内。

备份时应将真实 `.env` 与完整数据目录配套保存到私有位置；`.env.example` 只是模板，不能代替真实配置。以下命令在项目目录执行，将备份放到仓库外的新目录，暂停服务后复制，避免遗漏 WAL 中的内容：

```bash
(
  set -e
  umask 077
  drift_backup_dir="$(mktemp -d ../drift-space-backup.XXXXXX)"
  trap 'docker compose start app' EXIT
  docker compose stop app
  docker compose cp app:/app/data "$drift_backup_dir/data"
  cp .env "$drift_backup_dir/.env"
  echo "备份已保存到 $drift_backup_dir"
)
```

备份中包含账户、对话、图片和加密密钥，需按私有数据保管，并另存一份到服务器之外的私有备份位置。迁移时将完整数据目录恢复到新卷并沿用原 `APP_SECRET`。第一版没有自动密钥轮换；更换密钥前需重新录入模型凭据。Git 不保存 `.env` 或数据卷，单纯克隆仓库会创建一套新数据。

## 架构与开发

```text
src/
  kernel/                 KH-Kernel、数据库、HTTP 注册、密钥保险库
  adapters/               模型协议契约、AdapterRegistry、OpenAI 兼容实现
  features/
    auth/                 manifest.ts + server.ts + client.tsx
    users/                manifest.ts + server.ts + client.tsx
    models/               manifest.ts + server.ts + client.tsx
    chat/                 manifest.ts + server.ts + client.tsx
    usage/                manifest.ts + server.ts + client.tsx
    preferences/          manifest.ts + server.ts + client.tsx（主题与 Chatbot 头像）
    prompts/              manifest.ts + server.ts + client.tsx（可选插件）
  server/                 配置、HTTP app 与启动入口
  client/                 Web Shell、UI registry、公共组件和样式
  shared/                 前后端共享 DTO / manifest 契约
tests/                    API 集成、模拟模型服务、浏览器端到端测试
```

进一步说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，添加插件见 [docs/FEATURES.md](docs/FEATURES.md)。

## 验证

`npm test` 在临时 SQLite 和真实本地 HTTP 服务上测试邮箱注册 / 迁移 / 唯一性、权限隔离、模型探测 / 白名单 / 授权、图片传递、Token 统计、断开订阅后持续生成与幂等提交、主动停止、插件生命周期、用户停用和重启持久化。浏览器测试覆盖桌面和手机的页面切换、离线恢复、关闭标签页后恢复生成。

浏览器测试使用 **测试专用模拟模型服务**，不调用付费 API，也不修改开发数据库：

```bash
npm run build
npm run test:e2e
```

默认使用已安装的 Google Chrome，分别运行 1440px 桌面和 Pixel 7 手机视口。无 Chrome 的 CI 可先安装 `npx playwright install chromium`，再执行 `PW_CHANNEL=chromium npm run test:e2e`。截图在 `test-results/`。真实来源需用户填入有效地址 / 密钥后做供应商联调。

## 当前范围

- 模型协议支持 OpenAI 兼容 `/models`、流式 `/chat/completions` 和 `/responses`。原生 Anthropic / Gemini、语音、视频、PDF / 文档解析、Agent 工具调用、RAG 尚未实现。
- Mermaid 在回复完成后渲染，流式阶段显示源码；原始 HTML 不执行，远程 Markdown 图片不会自动加载。附件是私有消息的一部分。
- Token 仅记录来源实际上报的 `usage`；缺失、失败、中断明确标记“未上报”，不会用估算数冒充账单。没有费用换算或配额计费。
- 单进程、单 SQLite 卷，适合个人与小型团队。每用户同时最多一个生成请求；单次生成 180 秒超时。长对话到达保护上限需新建对话。聊天列表最多展示最近 300 条，用量详情最多 200 条，汇总不受详情条数限制。
- 插件来自本地可信代码并参与构建；支持已安装插件的启停，未实现上传任意第三方插件、插件沙箱或在线插件市场。
- Core 使用同一 feature 结构，不能从管理页面停用。管理页将 Core（基础能力）与 Plugin（进阶能力）分栏展示，在手机上纵向排列。前端隐藏入口只是体验层，API 层仍独立执行鉴权与数据隔离。

## 导航与设置

- 左侧「工作区」放置对话、提示词库；「统计」分组放置用量统计。
- 点击左下角用户栏目进入独立「设置」页：通用设置包含明暗模式、Color Pattern 和 Chatbot 头像；账户设置管理个人资料和密码；相关信息显示版本与数据处理说明。
- 代码高亮使用独立的完整明暗语法色板，随白天 / 黑夜 / 系统模式切换；不继承 Shell 辅助文字颜色或 Color Pattern。首页使用小帆船图标，相关信息提供项目 GitHub 链接。
- 账户设置支持上传个人头像（PNG / JPEG / WebP，最大 10 MB），自动居中裁剪并压缩为不超过 512×512 的图片；用户栏、聊天提问和用户管理列表同步显示，可恢复默认。头像与账户一起保存在 SQLite，刷新和重新登录后保留。
- 聊天输入工具栏采用紧凑布局，模型与思考程度共用一个入口：展开后调节五档强度，进入模型列表可搜索名称或来源；支持键盘、点击外部关闭和按用户 / 模型记住强度。
- Color Pattern 用标签页选择「自然鲜明」或「柔和经典」色系，每组保留 9 色，柔和经典采用更清透的色值和较低的背景不透明度。Shell 背景、正文、辅助文字和导航使用固定黑白灰；色系用于组件背景、边框与图标，不再把全页染成一种颜色。
- 对话列表与提示词卡片的调色板按钮可以从当前色系中选色，也可恢复自动配色；选择随账户保存。切换色系时保留颜色位置，映射到新色系对应颜色。旧主题色自动迁移到所属色系，原有聊天、模型和头像保留。
- 首页建议、统计卡片与 Token 活动图使用当前色系。自动配色通过稳定标识与顺序分配，刷新、重排对话时不会重新随机变色。
- 管理员在设置页中额外看到「管理员」分组，包含模型与接入、用户管理、功能与插件。普通用户没有这些入口，API 鉴权保持独立。
- 设置子页可通过 URL 直接访问和刷新；原有 `#/auth`、`#/preferences`、`#/models`、`#/users`、`#/features` 链接仍会进入对应设置页。
- 密码仅要求填写，不限制位数、字符类型或组合；注册、登录、修改密码与管理员重置保持一致，密码不裁剪空格，并继续使用加盐哈希存储。

## 字号与长对话阅读

- 「设置 → 通用设置 → 字体大小」提供紧凑 90%、标准 100%（默认）、舒适 112.5%、较大 125%。切换立即生效，预览包含正文、表格、代码、公式与输入文字，并提供恢复默认。
- 基准字号：聊天正文 / 输入 16px，导航 / 按钮 / 代码 14px，辅助说明 12px，页面标题 30px。CSS 语义字号变量统一乘缩放系数，辅助文字始终至少 12px；手机聊天正文沿用相同比例。只对聊天头像和部分控件图标做轻微适配，侧栏宽度与页面布局尺寸不随字号缩放，不使用整页 zoom 或 transform scale。
- 字号使用当前浏览器的 localStorage，按用户 ID 隔离。刷新、退出后重新登录保留；不同设备独立选择，清除浏览器存储会恢复标准档。Color Pattern、组件选色、明暗模式、头像仍由服务器保存。
- 发送新问题会回到最新消息。停留底部时跟随流式输出、图片 / 图表展开；向上翻阅或点击大纲后暂停跟随，点击下箭头即可返回底部并恢复跟随。
- 对话正文左侧的大纲按用户提问生成，鼠标悬停或键盘聚焦显示简介，点击跳到该问题开头；手机可直接点按。重新打开对话时根据完整历史重建大纲，默认定位最新消息。

## 内容与模型设置

- Chat Completions 与 Responses 均向上游请求 `stream: true`，收到文字增量后立即通过 SSE 显示。提交成功后，生成任务由服务器持有；浏览器离开、锁屏、切换应用、断网或关闭标签页不会取消任务。返回时先同步完整消息，再继续接收增量；已经完成则直接显示完整回复。只有主动点击停止、上游错误、生成超时或服务关闭才会结束任务。
- 后台生成限于当前服务器进程，重启或重新部署不会自动续跑模型请求：已保存的部分回复保留，异常重启的未完成记录标记为失败。客户端恢复连接只订阅结果，不重新提交模型请求；同一个提交 ID 的重试也不会重复调用模型。
- 输入框使用 Tiptap 实时富文本编辑，直接显示渲染结果，无需切换编辑与预览。支持 Markdown 输入快捷语法与粘贴、粗体、列表、表格、代码、公式和撤销；发送时序列化为 Markdown。点选公式可修改 LaTeX，Mermaid / LaTeX 代码块附带实时预览。桌面普通段落 Enter 发送，Shift + Enter 换行；列表、表格、代码块中 Enter 继续编辑。手机 Enter 换行；Ctrl / ⌘ + Enter 可发送。
- 支持 `$…$`、`$$…$$`、`\(…\)`、`\[…\]`；`latex` / `tex` / `math` 代码块显示公式预览，原文可展开和复制。KaTeX 支持常见数学环境，但不是完整 TeX 编译器，不编译任意宏包、TikZ 或 LaTeX 文档排版。
- 思考程度提供 `none / low / medium / high / extra high`。Extra high 对应 API 的 `xhigh`。**None 完全省略思考字段，由来源使用默认行为，不保证关闭模型内部推理。** 其他等级是否可用取决于具体模型；不支持时选择 None。Chat Completions 使用 `reasoning_effort`，Responses 使用 `reasoning: { effort }`。
- Responses 使用 `store: false`，历史由本地保存并逐次发送，支持文本与图片、流式结束/失败/不完整事件及真实 Token 用量。
- 热力图使用 UTC 日界线。每日每格一天，每周按周一分组，累计为所选时间范围内的累计值。多模型一天以分段颜色展示，聚焦或点击可查看详情；未上报用量的调用仍保留。

字段依据：[OpenAI Chat Completions 参考](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[迁移到 Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[推理参数](https://developers.openai.com/api/docs/guides/reasoning)、[Responses 流式事件](https://developers.openai.com/api/docs/guides/streaming-responses)。
