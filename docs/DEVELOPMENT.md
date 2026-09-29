# Drift Space 开发指南

本指南让新加入的开发者和模型快速理解项目、选择扩展位置并保持风格一致。内容依据当前 v0.8.0 源码；版本以 [`APP_VERSION`](../src/shared/version.ts) 和 [`package.json`](../package.json) 为准。规范变化需要与实现一起更新文档，不要求每次文档修改都发布新版本。

## 阅读地图

| 文档                               | 负责回答的问题                                                    |
| ---------------------------------- | ----------------------------------------------------------------- |
| [README](../README.md)             | 用户如何运行、配置、部署、备份这个应用？                          |
| [AGENTS.md](../AGENTS.md)          | 模型和开发者工作时必须保持哪些边界、如何验证和交付？              |
| 本文                               | 代码在哪里、改哪一层、怎样同步规范与版本？                        |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 引擎、平台、服务、请求、数据与后台生成如何协作？                  |
| [FEATURES.md](FEATURES.md)         | 如何添加一个包含 server / client 的功能，如何扩展服务与 Adapter？ |
| [UI_GUIDE.md](UI_GUIDE.md)         | 如何新增 UI 组件并继承颜色、字号、布局与交互规范？                |

推荐先读本页的项目结构，再实际打开 `src/features/prompts/`；它是当前最小的完整插件实例。涉及登录、模型授权或流式生成时，再读对应 feature 和测试。

## 项目是什么

Drift Space 是个人 / 小型多用户 AI Web 应用。它连接管理员配置的模型服务，本身不是大模型推理服务器。产品架构是 **Cordis 引擎 + KH-Kernel 平台层 + 按能力聚合的 features + 模型 Adapter + React Web Shell**。

| 部分            | 当前技术 / 职责                                                          |
| --------------- | ------------------------------------------------------------------------ |
| 运行时与语言    | Node.js 24+、TypeScript strict、ES modules                               |
| Engine          | 锁定 Cordis 3.18.1；Context、Service、依赖与生命周期                     |
| Platform Kernel | feature 目录、Core 保护、启停串行化、关闭协调                            |
| HTTP            | Express 5；JSON API、Cookie 会话、SSE；Zod 校验                          |
| 存储            | Node 内置 `node:sqlite`、单数据库、WAL；无 ORM                           |
| 前端            | React 19、Vite、hash 路由、Context / hooks；无独立全局状态库             |
| 内容            | Tiptap 输入；react-markdown、GFM、KaTeX、Mermaid、rehype-highlight 输出  |
| 样式            | 手写 CSS、语义变量、lucide-react 图标；无 Tailwind / UI 组件库           |
| 构建与部署      | Vite 构建客户端，esbuild 打包服务入口；Docker Compose 单应用容器与持久卷 |

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

## 应该改哪一层

| 需求                               | 推荐位置                                                 | 注册 / 契约影响                                                |
| ---------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| 新增私人知识、收藏、记忆等独立能力 | 新 `src/features/<id>/`，通常为 plugin                   | server + client 两个注册入口；需要存储时追加迁移               |
| 扩展已有聊天或账户功能             | 对应 feature；局部组件 / hooks 放同目录                  | 保持已有接口兼容，更新 DTO / 校验 / 测试                       |
| 多个页面复用的小 UI                | `src/client/<component>.tsx`，参照 UI 指南               | 普通组件不需要 manifest 或 Kernel 注册                         |
| 设置中的新页面                     | feature client 的 `placement: 'settings'`                | 使用 `navigate('settings', id)`，不要在侧栏重复加入口          |
| 多个服务端能力复用的业务服务       | 由所属 feature 提供 Cordis Service                       | Context 类型扩充、消费者 inject、生命周期清理                  |
| 新模型协议                         | `src/adapters/` + 来源配置能力                           | Registry、来源 apiMode 与 Adapter 映射、表单、迁移、适配器测试 |
| 全局主题 / 字号规则                | `shared/appearance.ts`、`shared/typography.ts`、公共 CSS | 影响所有页面，需要完整视觉回归                                 |
| 用户身份、来源校验、全局 HTTP 限制 | `server/app.ts`、auth / users、kernel/http               | 属于全局边界，不能由页面显示状态代替后端鉴权                   |

不要仅因为“以后可能有很多插件”就先建立任意扩展点系统。LLM 拓展已有 extensions 核心，能力插件统一向它注册；其他场景先明确谁提供能力、谁消费能力，沿用已有 Service / Registry 模式；依赖关系和失败时行为应可描述、可测试。

## 一个功能进入产品的顺序

1. 写清用户行为、谁可使用、数据归谁、是否可停用，以及需要的加载 / 空 / 错误状态。
2. 先定义纯数据 DTO 和输入校验，设计数据库追加迁移与用户隔离条件。
3. 编写 feature server、依赖和副作用清理；接入 `createApp()`。新表当前仍由 `Database` 集中初始化。
4. 编写 feature client，复用公共 UI / API / Context；加入 `clientFeatures`。通用组件与业务操作分离。
5. 验证端到端行为、权限、生命周期和持久化；涉及 UI 时检查明暗与手机。
6. 根据下方同步矩阵更新文档，交付时说明验证结果与实际支持范围。

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

| 改动                       | 检查                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| 文档 / 注释                | Prettier、相对链接、命令与示例 API 是否仍存在；无需重复 E2E                                    |
| 部署脚本                   | `bash -n deploy.sh`；用临时目录 / Docker stub 验证首次生成与重复保留配置，不为了检查而重启生产 |
| TS / DTO / API             | `npm run typecheck` 与相关 Node 测试；跨 feature 契约变化执行 `npm test`                       |
| 权限 / 迁移 / 插件生命周期 | 未登录、跨用户、非管理员、启停再启用、旧库升级及重启持久化                                     |
| 模型协议 / 聊天生成        | mock provider 的文本、usage、异常、停止、幂等和订阅断开；不调用付费 API 验证常规修改           |
| React / CSS / 编辑器       | 先 build，再运行受影响的 Playwright 用例；公共 UI / 样式变更执行桌面和手机完整回归             |
| 准备发布                   | typecheck、相关测试、生产 build、format check；全局变更运行完整 Node / E2E 套件                |

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run format:check
```

`npm run build` 已包含类型检查。Node 测试位于 `tests/*.test.ts(x)`，使用临时目录。Playwright 通过 `tests/e2e-server.ts` 启动隔离应用（3210）与模拟模型（3211），客户端读取 **已构建的 `dist/client`**；改 UI 后不重建会测到旧页面。

默认浏览器为已安装的 Chrome，配置在 `playwright.config.ts`；可用 `npx playwright install chromium` 后执行 `PW_CHANNEL=chromium npm run test:e2e`。E2E 默认顺序执行，有共享初始化与限速约束，不应随意增加并发。模型选择等共用浏览器操作放 `tests/e2e/controls.ts`。

`tests/streaming-latency.test.ts` 验证文本先于结束事件交付；`tests/e2e/model-connections.spec.ts` 验证来源草稿探测、紧凑列表、模型诊断与明暗 / 字号 / 手机布局。自动回归使用模拟服务；用户授权的真实供应商耗时测量单独执行，不能将密钥写入测试或日志。

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

更新通常为 `git pull --ff-only` 后 `./deploy.sh`；先按 README 备份配置和数据。已有 `.env` 不会重建密钥，SQLite 卷会继续使用。生产重启会中断当前模型生成，不能把“浏览器离开不断流”等同于“服务重启也续跑”。具体的备份、部署和限制以 [README](../README.md) 为主。

新增浏览器功能测试可调用 `tests/e2e-session.ts` 的 `useFixtureSession(page)`，复用临时测试服务器首次注册的会话；文件仅保存在系统临时目录且关闭服务器时移除。登录/注册行为仍由原有用例验证，不通过提高生产限流阈值来容纳测试。

拓展能力回归在 `tests/extensions.test.ts` 与 `tests/e2e/extensions.spec.ts`，覆盖 Search、Jev、权限、模式、来源持久化、停止、卸载与重连；mock-provider 提供隔离的原生 Jev 和 Perplexity Search 响应，不需要真实密钥或付费调用。
