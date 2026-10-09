# Drift Space 开发指南

本指南让新加入的开发者和模型快速理解项目、选择扩展位置并保持风格一致。内容依据当前 v0.8.0 源码；版本以 [`APP_VERSION`](../src/shared/version.ts) 和 [`package.json`](../package.json) 为准。规范变化需要与实现一起更新文档，不要求每次文档修改都发布新版本。

## 阅读地图

| 文档                                     | 负责回答的问题                                                    |
| ---------------------------------------- | ----------------------------------------------------------------- |
| [README](../README.md)                   | 用户如何运行、配置、部署、备份这个应用？                          |
| [AGENTS.md](../AGENTS.md)                | 模型和开发者工作时必须保持哪些边界、如何验证和交付？              |
| 本文                                     | 代码在哪里、改哪一层、怎样同步规范与版本？                        |
| [ARCHITECTURE.md](ARCHITECTURE.md)       | 引擎、平台、服务、请求、数据与后台生成如何协作？                  |
| [FEATURES.md](FEATURES.md)               | 如何添加一个包含 server / client 的功能，如何扩展服务与 Adapter？ |
| [UI_GUIDE.md](UI_GUIDE.md)               | 如何新增 UI 组件并继承颜色、字号、布局与交互规范？                |
| [RELEASE.md](RELEASE.md)                 | 如何规范提交、推送并把指定提交安全部署到当前远端服务器？          |
| [CONTEXT_MANAGER.md](CONTEXT_MANAGER.md) | 自动压缩、轨迹摘要、用户设置、缓存与手动摘要 API                  |
| [MEMORY_API.md](MEMORY_API.md)           | 三层记忆的 HTTP API、输入限制、权限、幂等、索引和操作状态         |
| [MEMORY_AGENTS.md](MEMORY_AGENTS.md)     | 如何新增带配套设置 UI 的记忆策略 / Agent，如何复用托管模型调用？  |
| [MEMORY_DATABASE.md](MEMORY_DATABASE.md) | 如何接入共享 PostgreSQL、迁移、诊断、备份与恢复？                 |

推荐先读本页的项目结构，再实际打开 `src/features/prompts/`；它是包含私人卡片、设置页和按需模型调用的完整插件实例。涉及登录、模型授权或流式生成时，再读对应 feature 和测试。

## 项目是什么

Drift Space 是个人 / 小型多用户 AI Web 应用。它连接管理员配置的模型服务，本身不是大模型推理服务器。产品架构是 **Cordis 引擎 + KH-Kernel 平台层 + 按能力聚合的 features + 模型 Adapter + React Web Shell**。

| 部分            | 当前技术 / 职责                                                                     |
| --------------- | ----------------------------------------------------------------------------------- |
| 运行时与语言    | Node.js 24+、TypeScript strict、ES modules                                          |
| Engine          | 锁定 Cordis 3.18.1；Context、Service、依赖与生命周期                                |
| Platform Kernel | feature 目录、Core 保护、启停串行化、关闭协调                                       |
| HTTP            | Express 5；JSON API、Cookie 会话、SSE；Zod 校验                                     |
| 存储            | 平台使用 Node 内置 `node:sqlite` / WAL；Memory 使用独立 PostgreSQL/pgvector；无 ORM |
| 前端            | React 19、Vite、hash 路由、Context / hooks；无独立全局状态库                        |
| 内容            | Tiptap 输入；react-markdown、GFM、KaTeX、Mermaid、rehype-highlight 输出             |
| 样式            | 手写 CSS、语义变量、lucide-react 图标；无 Tailwind / UI 组件库                      |
| 构建与部署      | Vite 构建客户端，esbuild 打包服务入口；Docker Compose 单应用容器与持久卷            |

当前插件随代码构建，可信且可启停。没有在线插件市场、任意代码上传、插件沙箱、多个实例共享的生成队列或自动扫描目录的插件加载器。

## 目录与装配入口

```text
AGENTS.md                       模型与开发者协作规则
README.md                       产品能力、运行和部署手册
docs/                           本指南、架构、功能扩展、UI 规范
src/
  server/
    main.ts                     读取配置、监听端口、退出信号
    config.ts                   环境变量校验
    app.ts                      服务端 composition root、注册 feature、HTTP 中间件
  kernel/
    index.ts                    KHKernel 与 Cordis 作用域管理
    context.ts                  Cordis Context 的 TypeScript 类型扩充
    database.ts                 SQLite service、表结构和追加迁移
    memory-database.ts          Memory 独立 PostgreSQL 连接与集中追加迁移
    memory-config.ts            Memory 环境、schema / 连接池和 Monitor 元数据校验
    http.ts                     可撤销 Router registry、鉴权与 HttpError
    crypto.ts                   密码哈希、会话摘要、模型密钥加密
  adapters/                     ModelAdapter 契约、注册表、OpenAI 兼容与 Anthropic Messages 实现
  features/<id>/
    manifest.ts                 纯数据目录声明
    server.ts                   服务 / API / 生命周期
    client.tsx                  页面；可继续拆成组件、hooks、CSS
  client/
    main.tsx                    React 入口、UiProvider、全局 CSS 导入顺序
    App.tsx                     登录状态、Shell、hash 导航、目录刷新
    registry.ts                 编译期 ClientFeature 目录
    settings.tsx                设置容器、相关信息、Core / Plugin 管理
    components.tsx              PageHeader / Modal / Empty / Spinner / ErrorNote / useLoad
    api.ts                      JSON 请求封装与登录失效事件
    context.tsx                 useWorkspace
    ui-preferences.tsx          useUi、主题、字号、Chatbot 头像
    color-pattern.tsx           色彩 hooks 与颜色选择弹窗
    user-avatar.tsx             用户头像与本地图片压缩
    markdown.tsx                内容渲染管线
  shared/                       DTO、主题注册表、字号定义、版本、图片校验
tests/                          Node 行为测试、模拟供应商、Playwright 浏览器测试
deploy.sh                       唯一部署入口
compose.yaml / Dockerfile       运行和构建契约
```

`dist/`、`node_modules/`、`test-results/` 是生成目录；数据库与真实 `.env` 是部署状态，均不是功能代码。`output/` 可能包含设计探索产物，不是应用自动加载的资产目录；素材要进入产品必须显式接入、验证体积与使用位置。

上下文字符占比直接复用快照已有的 UTF-16 字符统计，无分词器依赖或 Worker 资源。计量口径和真实用量边界见 [context-manager 接口](FEATURES.md#对话-context-manager)。

Git 与 Docker 构建上下文均排除 `.env` 及 `.env.*` 配置 / 备份，仅允许占位示例 `.env.example`；Docker 构建同时排除 `output/` 设计产物。

构建同时打包 `src/server/memory-db.ts` 为独立数据库 CLI；`npm run memory:migrate` 和 `npm run memory:check` 使用构建产物，check 不执行 DDL。共享数据库部署与本地开发 overlay 分别见 [Memory 数据库接入](MEMORY_DATABASE.md)，数据库接入行为测试在 `tests/memory-database.test.ts`；需要临时 PostgreSQL/pgvector、隔离测试库与管理员测试账号，以创建仅本次测试使用的受限角色 / schema，不能使用生产共享实例。

## 应该改哪一层

| 需求                               | 推荐位置                                                         | 注册 / 契约影响                                                |
| ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| 新增私人知识、收藏等独立能力       | 新 `src/features/<id>/`，通常为 plugin                           | server + client 两个注册入口；需要存储时追加迁移               |
| 记忆管理与策略 / Agent             | `src/features/memory/`，按 [策略开发指南](MEMORY_AGENTS.md) 扩展 | 服务端策略与客户端设置双注册；独立 PostgreSQL 集中迁移         |
| 扩展已有聊天或账户功能             | 对应 feature；局部组件 / hooks 放同目录                          | 保持已有接口兼容，更新 DTO / 校验 / 测试                       |
| 多个页面复用的小 UI                | `src/client/<component>.tsx`，参照 UI 指南                       | 普通组件不需要 manifest 或 Kernel 注册                         |
| 设置中的新页面                     | feature client 的 `placement: 'settings'` 或 `settingsComponent` | 使用 `navigate('settings', id)`，不要在侧栏重复加入口          |
| 多个服务端能力复用的业务服务       | 由所属 feature 提供 Cordis Service                               | Context 类型扩充、消费者 inject、生命周期清理                  |
| 新模型协议                         | `src/adapters/` + 来源配置能力                                   | Registry、来源 apiMode 与 Adapter 映射、表单、迁移、适配器测试 |
| 全局主题 / 字号规则                | `shared/appearance.ts`、`shared/typography.ts`、公共 CSS         | 影响所有页面，需要完整视觉回归                                 |
| 用户身份、来源校验、全局 HTTP 限制 | `server/app.ts`、auth / users、kernel/http                       | 属于全局边界，不能由页面显示状态代替后端鉴权                   |

不要仅因为“以后可能有很多插件”就先建立任意扩展点系统。LLM 拓展已有 extensions 核心，能力插件统一向它注册；其他场景先明确谁提供能力、谁消费能力，沿用已有 Service / Registry 模式；依赖关系和失败时行为应可描述、可测试。

## 一个功能进入产品的顺序

1. 写清用户行为、谁可使用、数据归谁、是否可停用，以及需要的加载 / 空 / 错误状态。
2. 先定义纯数据 DTO 和输入校验，设计数据库追加迁移与用户隔离条件。
3. 编写 feature server、依赖和副作用清理；接入 `createApp()`。平台表由 `Database` 集中初始化，Memory 表由 `MemoryDatabase` 集中迁移，不在请求中创建。
4. 编写 feature client，复用公共 UI / API / Context；加入 `clientFeatures`。通用组件与业务操作分离。
5. 按变更范围选择相关的端到端、权限、生命周期或持久化用例；涉及 UI 时仅检查受影响的主题与设备。
6. 根据下方同步矩阵更新文档，交付时说明验证结果与实际支持范围。用户授权提交或发布时按 [发布手册](RELEASE.md) 操作。

不要把后端权限检查推给浏览器，也不要把只有 UI 的小组件包装成可停用的平台插件。完整代码步骤见 [FEATURES.md](FEATURES.md)。

## 本地工作流

```bash
npm ci
cp .env.example .env
# 用 openssl rand -hex 32 生成开发环境自己的 APP_SECRET；不要覆盖已有部署密钥。
# 开发 UI 默认 http://localhost:5173，PUBLIC_ORIGIN 应与其一致。
npm run dev
```

开发服务器 API 默认 3600，Vite 默认 5173 并代理 `/api`。已有 `.env` 时直接沿用；部署目录不要执行覆盖配置的 `cp`。生产构建与运行详见 README。

### 选择有意义的验证

每次迭代以最小可证明的检查为默认：从改动涉及的行为出发，运行最直接的一个或少数几个检查，验证通过就继续交付。不要为了“保险”例行跑完整 Node / E2E 套件，也不要把提交、推送、部署等同于全面回归。构建已包含类型检查，避免重复执行。测试失败、影响跨越多个核心边界或出现具体回归迹象时，再逐步扩大验证范围；用户明确要求全面验收时按其要求执行。

| 改动                       | 优先选择的最小检查                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| 文档 / 注释                | 本次改动文件的 Prettier、相对链接、命令与示例 API；无需运行应用或 E2E                    |
| 部署脚本                   | `bash -n deploy.sh`；必要时用临时目录 / Docker stub 验证受影响路径，不为了检查而重启生产 |
| TS / DTO / API             | `npm run typecheck` 与直接相关的 Node 用例；仅在跨 feature 契约受影响时扩大到相关模块    |
| 权限 / 迁移 / 插件生命周期 | 挑选本次改动直接触及的未登录、跨用户、启停、升级或持久化场景                             |
| 模型协议 / 聊天生成        | 挑选相关 mock provider 的协议、usage、异常或断流用例；常规修改不调用付费 API             |
| React / CSS / 编辑器       | 先 build，再运行受影响页面的少量 Playwright 用例；仅检查实际影响的主题、字号和设备       |
| 准备发布                   | 核对相关测试、构建、格式与提交范围；不因发布动作本身自动运行全量套件                     |

下面是可按需选择的命令，不是固定的逐项清单：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run format:check
```

`npm run build` 已包含类型检查。Node 测试位于 `tests/*.test.ts(x)`，使用临时目录。Playwright 通过 `tests/e2e-server.ts` 启动隔离应用（3210）与模拟模型（3211），客户端读取 **已构建的 `dist/client`**；改 UI 后不重建会测到旧页面。

依赖或锁文件变化时，额外使用部署镜像所用的 npm 版本运行 `npm ci --dry-run --ignore-scripts --no-audit --no-fund`，检查干净安装的依赖闭包；已有 node_modules 下构建通过不能证明锁文件完整。若本机 npm 与镜像版本不同，应使用对应版本的临时 npm CLI 校验，不通过修改服务器工作树或跳过 `npm ci` 解决缺项。

默认浏览器为已安装的 Chrome，配置在 `playwright.config.ts`；可用 `npx playwright install chromium` 后执行 `PW_CHANNEL=chromium npm run test:e2e`。E2E 默认顺序执行，有共享初始化与限速约束，不应随意增加并发。模型选择等共用浏览器操作放 `tests/e2e/controls.ts`。

`tests/streaming-latency.test.ts` 验证文本先于结束事件交付；`tests/e2e/model-connections.spec.ts` 验证来源草稿探测、紧凑列表、模型诊断与明暗 / 字号 / 手机布局。自动回归使用模拟服务；用户授权的真实供应商耗时测量单独执行，不能将密钥写入测试或日志。

聊天并发的针对性回归为 `npx tsx --test tests/chat-concurrency.test.ts`，使用手动结束的本地模型流验证默认 / 配置额度、幂等、单独停止、订阅隔离与关机保存；`npx playwright test tests/e2e/chat-revision.spec.ts` 覆盖桌面 / 手机的会话草稿及编辑状态隔离、换模型再次生成、旧用量保留与切换会话并行提交。

## 规范与文档同步

文档与代码在同一次变更中同步，这是交付完成条件；不是另设周期任务，也不是只在对话中说明。新增约定注明适用范围，实际实现尚不支持的内容明确标记为方案。

| 变更触发                                          | 必须检查的主要说明位置                                                                     | 对应代码 / 验证                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 分层、依赖、持久化与后台任务语义                  | `ARCHITECTURE.md`                                                                          | Kernel、Context、server composition root、生命周期测试                |
| feature 结构、注册步骤、权限或服务 / Adapter 接口 | `FEATURES.md`                                                                              | manifest、server/client registry、DTO、API 测试                       |
| 公共组件 API、颜色、字号、样式层与交互标准        | `UI_GUIDE.md`                                                                              | 公共组件、appearance / typography、明暗 / 手机 / 字号测试             |
| 新增用户可见功能、限制或配置                      | `README.md` 的能力表、使用方法、当前范围                                                   | 实际页面、服务端校验、错误提示                                        |
| 环境变量、端口、持久卷、脚本名、备份 / 代理要求   | `README.md`、`.env.example`                                                                | config、Dockerfile、compose、deploy；不提交真实 `.env`                |
| 开发命令、构建顺序、测试工具                      | 本文                                                                                       | package scripts、Playwright、测试入口                                 |
| 改变后续模型必须遵守的规则                        | `AGENTS.md` 的摘要 + 所属详细指南                                                          | 检查重复说明，避免不同文档给出相反要求                                |
| 发布版本                                          | `package.json`、`package-lock.json` 根与根包版本、`src/shared/version.ts`、README 版本说明 | UI 版本与 `/api/health` 一致；feature manifest 版本按能力自身变化维护 |

维护时先修改该主题的主要说明位置，再检查其他文档中的链接或简述。例如 UI 色彩规范主要写在 UI 指南，AGENTS 只保留必须遵守的摘要。新增全局边界或取舍时，在架构文档记录原因、影响和限制；无需仅为一段说明引入新的 ADR / issue 工具。

修改后至少执行以下文档检查（只列本次改过的文件，不必重排无关源码）：

```bash
npx prettier --check AGENTS.md README.md docs/*.md
git diff --check
```

检查：相对路径能找到文件，代码示例符合当前签名，必需字段没有省略，示例功能不会被误认成已上线功能，没有真实凭据或部署私密信息。提交说明中简述相关规范已同步；若无需更新，能够解释改动为何不改变任何契约即可。

## 发布与数据边界

仓库包含源码，不包含用户数据库或真实 `.env`。远端配置是部署状态，不应硬编码到 UI、示例文档或测试。`PUBLIC_ORIGIN` 当前只支持单一浏览器来源；填写 Tunnel 的公开访问域名，不填写 CNAME Target，应用配置变更需要重建容器加载环境。

提交使用 `type(scope): summary`，只暂存当前变更，核对上游、验证结果和文档同步；推送与部署是另外的动作。具体命令、远端目标、备份和上线后检查以 [发布手册](RELEASE.md) 为主。已有 `.env` 不会重建密钥，SQLite 卷会继续使用。生产重启会中断当前模型生成，不能把“浏览器离开不断流”等同于“服务重启也续跑”。配置与数据边界见 [README](../README.md)。

新增浏览器功能测试可调用 `tests/e2e-session.ts` 的 `useFixtureSession(page)`，复用临时测试服务器首次注册的会话；文件仅保存在系统临时目录且关闭服务器时移除。登录/注册行为仍由原有用例验证，不通过提高生产限流阈值来容纳测试。

拓展能力回归在 `tests/extensions.test.ts` 与 `tests/e2e/extensions.spec.ts`，覆盖 Search、Jev、权限、模式、来源持久化、停止、卸载与重连；mock-provider 提供隔离的原生 Jev 和 Perplexity Search 响应，不需要真实密钥或付费调用。

模型诊断回归位于 `tests/model-diagnostics.test.ts`：覆盖四种协议的真实测试请求、401、半截流、超时、非 JSON、日志限长及凭据脱敏。拓展菜单与管理列表的模式同步、原生 Popover 键盘和手机布局由 `tests/e2e/extensions.spec.ts` 验证。

Skill 库兼容回归位于 `tests/prompts.test.ts`（编辑、标签校验、账户隔离、三类 LLM Adapter、真实用量、停用取消）与 `tests/e2e/prompts.spec.ts`（设置模型、生成简介、编辑 / 搜索 / 标签、明暗和四档字号）；旧库升级与重启保存在 `tests/kernel.test.ts` 验证。局部迭代运行受影响用例即可，无需每次执行全部浏览器套件。

Skill 文档读取与工具循环回归在 `tests/skills.test.ts`，模型工具夹具在 `tests/skill-provider-fixture.ts`，覆盖三种协议、版本绑定、读取权限、累计用量、断线、停用和停止。迁移覆盖在 `tests/kernel.test.ts`，浏览器在 `tests/e2e/skills.spec.ts`；原提示词用例继续验证兼容接口和管理页面。后续执行环境的工作范围集中在 [Skill TODO](SKILLS_TODO.md)，这些能力尚未实现。

Embedding 的针对性回归使用 `npx tsx --test tests/embedding.test.ts tests/model-diagnostics.test.ts`，包含部分真实用量、无用量、维度、乱序 / 重复 index、无效与零向量、模型授权和旧模型类型迁移。所有请求都指向本地 mock，数据库使用临时目录。Memory 集成验证使用隔离的 PostgreSQL/pgvector，不能将开发或生产连接地址用作测试夹具；具体环境和用例见 [策略开发指南](MEMORY_AGENTS.md#验证)。

## 产物空间验证

空间、生成工具和 API 的主要契约在 [LLM Production](LLM_PRODUCTION.md)。llm-production 核心复用模型授权和聊天工具循环，文档生成依赖安装在生产依赖中；PDF 的中文字体随依赖提供，部署无需额外下载字体。产物字节随 SQLite 数据目录备份。

针对性用例为 tests/llm-production.test.ts（权限 / 空间 / 清理 / 迁移）、tests/production-chat.test.ts（三协议工具循环 / SSE / 幂等 / 断线）、生成器及图片 Adapter 的相应用例；tests/e2e/production.spec.ts 验证当前空间、管理、下载、设置和受影响的明暗 / 手机布局。改动涉及模型种类或现有 Skill 工具循环时，再运行对应模型 / Skill 回归；不要求全套测试。

管理首页的对话卡片、Color Pattern、类型 / 分组筛选、来源详情与共享空间切换由 tests/e2e/production-spaces.spec.ts 验证，包含已删除来源的保留产物；预览窗口的安全源码、加载重试和明暗 / 手机布局由 tests/e2e/production-preview.spec.ts 覆盖。

触发与交付回归位于 tests/production-request.test.ts（一般文件需求、明确格式与否定 / 引用 / 示例边界）、tests/production-trigger.test.ts（原始提问、配置预检、三协议调用、模型选择网页文件格式、未调用工具不能成功、图片失败不自动重试），均使用本地 mock；工具预算仍由 tests/production-budget.test.ts 验证。

结构化计划回归在 tests/production-delivery.test.ts（三协议混合产物、必须产物模式、部分交付、澄清、十二项逐次生成、Auto 普通请求次数），服务不变量在 tests/production-delivery-service.test.ts（计划锁定、权限、项目 / 格式绑定、失败图片去重），动态通用接口在 tests/conversation-tools.test.ts。tests/e2e/production-delivery.spec.ts 仅检查新增输入模式、清单、下载、未完成提示、澄清及桌面 / 手机布局；无需为计划改动运行全套浏览器测试。
