# Drift Space 开发协作约定

本文件供在本仓库工作的模型和开发者读取。产品名是 **Drift Space**，仓库名是 **KAKAM-Harness**，平台层叫 **KH-Kernel**。以下约定描述当前实现；用户明确提出的新要求优先，并应同步更新受影响的规范。

## 开始工作

1. 先读 [开发指南](docs/DEVELOPMENT.md)，再按任务阅读相关文档和实际源码。
2. 用 `git status --short` 检查已有改动，保留用户正在进行的工作。源代码与锁文件决定真实 API；文档与代码冲突时核实并修正文档，不依赖对其他框架的经验猜测接口。
3. 按下表定位任务，优先扩展现有实现，不为一个局部功能重新建立全局状态、路由或样式系统。

| 任务                                 | 首先阅读                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Kernel、服务依赖、权限、聊天生命周期 | [架构](docs/ARCHITECTURE.md)、`src/kernel/`、相关 feature 的 `server.ts` |
| 新增 feature、API、模型协议          | [功能扩展](docs/FEATURES.md)、`src/features/prompts/`、两个注册入口      |
| 页面、组件、主题、字号、移动端       | [UI 指南](docs/UI_GUIDE.md)、`src/client/main.tsx`、现有同类组件         |
| 部署、Origin、数据备份               | [README](README.md)、`deploy.sh`、`compose.yaml`、`src/server/config.ts` |

## 架构边界

- 使用真实 Cordis 3.18.1 作为引擎；KH-Kernel 封装 feature 注册、启停和关闭过程。不要另写一套并行的插件运行时。
- 产品能力按 `src/features/<id>/{manifest.ts,server.ts,client.tsx}` 聚合，可在同目录增加 hooks、组件、类型和 CSS。manifest 是浏览器可导入的纯数据，不导入服务端依赖或凭据。
- `kind: 'core'` 是必须启用的基础能力；`kind: 'plugin'` 是可选产品能力。两者使用同一 feature 结构。当前不是在线安装任意第三方代码的平台。
- Skill 库通过 extensions 注册版本解析与受控文档读取，chat 不直接依赖可选插件。Skill 文档是用户级指令；工具循环逐请求校验模型权限、记录真实用量，协议续接中的推理块不进入聊天正文。脚本/网络/依赖执行尚未实现，见 [TODO](docs/SKILLS_TODO.md)。
- LLM 拓展能力插件先向 `extensions` 核心注册，不直接接入聊天；显式辅助任务使用同一核心的 utility 接口，不加入聊天能力菜单；辅助 LLM / Jev 必须来自模型管理、逐调用校验当前用户权限并记录真实用量。详见 [功能扩展](docs/FEATURES.md#注册托管的-llm-能力)。
- 新 feature 分别接入 `src/server/app.ts` 和 `src/client/registry.ts`；当前没有文件扫描、动态模块加载或自动注册。
- 服务端依赖声明在 `inject`；共享服务用 Cordis `Service`，类型扩充在 `src/kernel/context.ts`。路由和其他副作用通过 `ctx.effect` 注册并返回清理函数。
- Context 不保存当前用户。API 从 `req.user` 获取身份，跨服务调用显式传递用户。私人资源查询与修改同时限定资源 ID 和用户 ID；管理员身份不是读取他人聊天的通行证。
- 路由内使用 Zod 验证输入、参数化 SQL 和 `HttpError`。`adminOnly` 只控制目录可见性，管理员 API 仍必须使用 `requireAdmin`。
- 表结构与追加迁移集中在 `src/kernel/database.ts`，不要在请求处理中改 schema。数据库事务回调是同步的，不能把异步请求放进 `db.transaction()`。
- 客户端不导入 `server.ts`、Node 模块或密钥；共享 DTO 放 `src/shared/` 或 feature 的纯类型文件，用 `import type` 明确边界。

## 必须保留的行为

- 首位注册用户成为管理员；后续用户为普通用户。使用邮箱、显示名称、密码；密码非空，不新增长度或字符组合限制，也不裁剪密码空格。
- 聊天调用模型前执行模型白名单、启用状态和用户授权校验。Token 消耗使用来源上报数据，缺失值不能伪装成零消耗或估算账单。
- 模型探测、连通性测试和聊天均通过 `ModelsService.adapter(apiMode)` 选择协议；用量为累计值时取最新值，不重复相加。模型排序必须保持授权过滤，默认是排序后首个可用模型，不能绕过启用与授权。
- 聊天提交与 SSE 订阅分离：离开页面、锁屏、断网、卸载组件只清理订阅，不能因此停止服务器生成任务。主动停止才调用停止 API。
- 最后一问编辑 / 失败回复重试沿用聊天提交路由与新 requestId；仅可替换本人对话的末条问答，旧用量保留。生成按活动进度计空闲时限并有总时限，失败原因应安全地持久化。
- 自动来源状态仅探测模型列表接口，不发送定时付费聊天；绿灯不代表每个白名单模型的生成测试已通过。
- 保留提交幂等、重连 snapshot 替换、账号切换隔离和关机前保存状态。当前任务不能跨服务重启续跑，不得声称具备持久任务队列。
- 来源表单只探测模型列表，不发聊天或隐式保存配置；连通性测试绑定已保存的具体模型，记录首段文本与总耗时、真实用量，失败也保留已上报用量。诊断结果的 HTTP 200 不等于 ok=true。
- `none` 思考程度表示省略上游字段，不保证关闭模型内部推理。
- UI 设置位于左下角用户入口的设置页；统计独立分组；管理员功能位于设置页。普通 feature 不应硬编码 Shell 导航。

## UI 约定

- Web Shell 使用纯黑白灰；装饰色来自 Color Pattern 的组件背景、边框、图标与图表。成功 / 失败状态采用独立的绿色 / 红色语义配色，兼容明暗主题并保留文字标签。不要把整个 Shell 染成主题色。
- Quiet Precision 的公共间距、圆角、控件尺寸和表面层级以 `styles.css` token 与最后导入的 `quiet-precision.css` 为准；静态区域不用阴影，阴影只给浮层。局部状态仍放所属 feature CSS，新增固定间距遵循 4px 网格。
- 复用 `PageHeader`、`Empty`、`Spinner`、`ErrorNote`、`Modal`、`UserAvatar`、`AssistantAvatar`、`Markdown` 与现有按钮 / 表单类。
- 字号使用 `--font-chat/input/ui/code/caption/title` 等语义变量。保持四档字号、辅助说明至少 12px；不使用整页 `zoom` 或 `transform: scale`，不随字号放大侧栏宽度。
- 对话分组使用 Color Pattern；普通对话条目、消息气泡和助手头像保持灰度。分组删除仅解除归属，保留对话与消息。
- 用 `usePatternColors()` 与稳定 key 分配颜色，手动颜色存 `colorSlot`。不要在 render 中随机配色或自己拼一套色板。
- 新 CSS 优先放 feature / 组件旁，使用命名空间类和公共 token。不要追加全局 `button`、`p`、`span` 或 `.hljs-*` 覆盖去修局部显示。
- 保留明暗模式、键盘焦点、中文输入法、手机触控与大字号布局。弹窗复用原生 dialog；轻量浮层可参照 `ModelPicker` 的 Popover，处理 Escape、关闭与焦点恢复。
- 聊天内容复用安全的 Markdown 渲染管线；不直接执行用户 / 模型 HTML。语法高亮独立于 Shell 和 Color Pattern，明暗主题都要检查。

## 验证与交付

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run format:check
```

- 按改动选择有意义的检查，详见开发指南的验证矩阵。只改文档时检查格式、链接和示例即可，不必启动完整服务或重复全部浏览器测试。
- E2E 使用构建后的 `dist/client`，先运行 build；默认 Chrome，桌面与 Pixel 7 两个项目。没有 Chrome 时安装 Chromium 并设置 `PW_CHANNEL=chromium`。
- 行为测试使用临时 SQLite 和 `tests/mock-provider.ts`。不要用真实用户数据、付费模型请求或远端生产服务做测试夹具。
- 不把 `.env`、`.env.*` 的真实配置 / 备份、数据库、令牌、Cookie 或密钥纳入提交或打印到日志；`.env.example` 仅保存占位示例。按文件明确暂存，避免把本地设计草稿和备份顺带加入。
- 部署统一使用 `deploy.sh`。保留已有 `APP_SECRET`、Compose 项目名和数据卷；不能为完成测试清空用户或删除生产卷。运行中的服务并不等于当前源码已部署，报告时区分本地修改、提交、推送和部署状态。
- 最终交付说明改了什么、验证了什么、仍有哪些限制；只报告实际执行并通过的检查。

## 文档同步是完成条件

新增能力或修改规范时，在同一次改动 / 提交中更新对应文档。入口和同步矩阵见 [开发指南](docs/DEVELOPMENT.md#规范与文档同步)。不能只在聊天记录中解释新的约定。

- 功能、目录、路由或服务契约变化：更新 `docs/FEATURES.md` / `docs/ARCHITECTURE.md`。
- 公共组件、颜色、字号、布局或交互规范变化：更新 `docs/UI_GUIDE.md`，必要时同步本文件的简要规则。
- 命令、测试、依赖工作流、发布和部署行为变化：更新 `docs/DEVELOPMENT.md` / `README.md`；环境变量同步 `.env.example`，不提交真实 `.env`。
- 每条规范保留一个主要说明位置，其余文档链接引用。区分“当前实现”“开发约定”“尚未实现的扩展方向”，不要把计划描述成现有能力。
