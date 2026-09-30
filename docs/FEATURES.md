# 添加与扩展功能

先读 [开发指南](DEVELOPMENT.md) 和 [架构](ARCHITECTURE.md)。现有完整实例是 [`src/features/prompts/`](../src/features/prompts/)；本页的 `bookmarks` 是**教学示例，尚未实现或注册到产品**。服务端与客户端作为同一个 feature 维护。

## Feature 契约

```text
src/features/bookmarks/
  manifest.ts       浏览器 / 服务端共同使用的纯数据
  types.ts          本功能共享 DTO（示例扩展文件，不是必需命名）
  server.ts         Cordis plugin、API、可选 Service
  client.tsx        页面
  components/      需要拆分时才增加
  styles.css        需要本地样式时才增加
```

manifest 的实际类型在 [`shared/types.ts`](../src/shared/types.ts)。它描述 `id`、`name`、`description`、`kind`、`version`、可选 `adminOnly`；没有 `server.entry`、`client.entry`、路由或权限声明语言。依赖放在 server 的 `inject`，UI 位置放在 client registry。不要将其他插件框架的 manifest 字段直接套入本项目。

`enabled` 是服务器返回的运行时状态，不应靠在 manifest 中写 `enabled: false` 实现默认停用。当前新 plugin 在没有历史设置时默认启用，已有设置存于 `settings` 的 `feature:<id>`；core 始终启用。改变这个策略需修改 Kernel 并同步测试与说明。

## 示例：私人收藏功能

这个最小纵向示例提供创建与读取，不包含完整的编辑 / 删除 / 手动配色。按以下文件和接入步骤实现后才能工作。

### 1. Manifest 与 DTO

`src/features/bookmarks/manifest.ts`：

```ts
import type { FeatureManifest } from '../../shared/types';

export const manifest: FeatureManifest = {
  id: 'bookmarks',
  name: '收藏',
  description: '保存值得再次阅读的链接',
  kind: 'plugin',
  version: '0.1.0',
};
```

`src/features/bookmarks/types.ts`：

```ts
export interface Bookmark {
  id: string;
  title: string;
  url: string;
}
```

跨多个 feature 通用的 DTO 才放 `src/shared/`。浏览器导入的类型文件不能同时包含 Node 依赖、数据库连接或凭据。

### 2. 数据库追加迁移

在 [`src/kernel/database.ts`](../src/kernel/database.ts) 的数据库初始化中，基础 users 表创建之后增加以下 SQL。必须同时服务全新数据库和已有数据库，不能只改 `CREATE TABLE` 然后假设旧库自动出现新列。

```sql
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id);
```

给已有表追加列时，参照现有 `PRAGMA table_info` 检测后再 `ALTER TABLE`。避免重命名数据库、丢弃历史列或初始化时清空数据。当前没有外部迁移框架、独立 migration runner 或自动 rollback。

### 3. 服务端 API

`src/features/bookmarks/server.ts`：

```ts
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Context } from 'cordis';
import { z } from 'zod';
import { requireUser } from '../../kernel/http';
import type { Bookmark } from './types';
export { manifest } from './manifest';

const inputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  url: z
    .url()
    .max(2000)
    .refine((value) => {
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      } catch {
        return false;
      }
    }, '请输入不含账号密码的 HTTP(S) 链接'),
});

export const server = {
  name: 'bookmarks',
  inject: ['db', 'http'],
  apply(ctx: Context) {
    const router = Router();
    router.use('/bookmarks', requireUser);
    router.get('/bookmarks', (req, res) => {
      res.json(
        ctx.db.all<Bookmark>(
          'SELECT id,title,url FROM bookmarks WHERE user_id=? ORDER BY rowid DESC',
          req.user!.id,
        ),
      );
    });
    router.post('/bookmarks', (req, res) => {
      const input = inputSchema.parse(req.body);
      const item: Bookmark = { id: randomUUID(), ...input };
      ctx.db.run(
        'INSERT INTO bookmarks(id,user_id,title,url) VALUES(?,?,?,?)',
        item.id,
        req.user!.id,
        item.title,
        item.url,
      );
      res.status(201).json(item);
    });
    ctx.effect(() => ctx.http.register(router));
  },
};
```

Router 中写 `/bookmarks`，浏览器端点为 `/api/bookmarks`；`app.ts` 已统一挂载 `/api`，不要重复前缀。输入的 `userId` 不能用作所有者，所有者始终取认证身份。

新增按 ID 修改 / 删除时，使用 `WHERE id=? AND user_id=?`，根据实际受影响行数处理不存在 / 无权结果。管理员专用操作使用 `requireAdmin`；manifest 的 `adminOnly` 不会替代 API 权限中间件。

### 4. 客户端页面

`src/features/bookmarks/client.tsx`：

```tsx
import { useState, type FormEvent } from 'react';
import { api, post } from '../../client/api';
import { PageHeader, Empty, ErrorNote, Spinner, useLoad } from '../../client/components';
import type { Bookmark } from './types';

export function BookmarksPage() {
  const { data, error, reload } = useLoad(() => api<Bookmark[]>('/bookmarks'));
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setFormError('');
    try {
      await post<Bookmark>('/bookmarks', Object.fromEntries(new FormData(form)));
      form.reset();
      reload();
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <PageHeader
        eyebrow="YOUR BOOKMARKS"
        title="值得再次阅读"
        description="为有用的内容留一个位置。"
      />
      <form onSubmit={save}>
        <label>
          名称
          <input name="title" required maxLength={100} />
        </label>
        <label>
          链接
          <input name="url" type="url" required maxLength={2000} />
        </label>
        <ErrorNote text={formError} />
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? '保存中…' : '保存收藏'}
        </button>
      </form>
      <ErrorNote text={error} />
      {!data ? (
        !error && <Spinner />
      ) : !data.length ? (
        <Empty title="还没有收藏">保存一个你想再次阅读的链接。</Empty>
      ) : (
        <ul>
          {data.map((item) => (
            <li key={item.id}>
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                {item.title}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

示例只展示接入闭环；正式卡片布局使用 [UI 指南](UI_GUIDE.md) 的组件写法。`api('/bookmarks')` 自动请求 `/api/bookmarks`；`post` / `patch` / `remove` 封装 JSON，不要重复 `/api` 或将密钥放到客户端。

`useLoad` 返回 `{ data, error, reload }`，依赖变化要明确传第二个参数；请求退出后忽略迟到结果，但它不是统一缓存或自动全局刷新器。需要刷新 Shell 目录、模型或对话列表时用 `useWorkspace().refresh()`；仅刷新当前 feature 列表用自己的 `reload()`。

### 5. 接入两个入口

在 [`src/server/app.ts`](../src/server/app.ts) 导入，并在已有注册序列中、`await kernel.ctx.start()` **之前**加入：

```ts
import * as bookmarks from '../features/bookmarks/server';

// 在 createApp(config) 内；依赖提供者应先注册。
await kernel.register(bookmarks.manifest, bookmarks.server);
```

在 [`src/client/registry.ts`](../src/client/registry.ts) 导入：

```ts
import { Bookmark as BookmarkIcon } from 'lucide-react';
import { BookmarksPage } from '../features/bookmarks/client';
import { manifest as bookmarks } from '../features/bookmarks/manifest';
```

向已有 `clientFeatures` 数组追加以下对象（这是数组项，不是独立模块）：

```ts
{
  manifest: bookmarks,
  component: BookmarksPage,
  icon: BookmarkIcon,
  placement: 'workspace',
}
```

服务端 manifest 与客户端目录取交集，只有服务端启用且当前用户可见时才展示页面。编译期 client 代码即使插件停用仍在 bundle 中，不能在其中保存秘密。

| placement    | 导航位置                               | 推荐导航调用                                   |
| ------------ | -------------------------------------- | ---------------------------------------------- |
| `workspace`  | 工作区                                 | `navigate('bookmarks')` → `#/bookmarks`        |
| `statistics` | 统计                                   | `navigate(id)`                                 |
| `settings`   | 用户设置页；adminOnly 项进入管理员分组 | `navigate('settings', id)` → `#/settings/<id>` |

设置项可提供 `settingsLabel`。现有 `App.tsx` 中的 `settingsRoutes` 是旧 URL 的兼容映射，不是新增设置页的必填注册表。相关信息与功能管理是 Shell 自有页面，不是每个 feature 都需要复制的结构。

### 6. 验证与同步

至少验证：未登录不能访问，A 用户不能读取 / 修改 B 的数据，无效输入失败；停用移除导航并撤销 API，重新启用仍能读取原数据且不会重复注册路由；旧库重启升级成功。浏览器覆盖创建、加载、空列表、错误反馈、刷新和窄屏。

最后同步 README 能力描述和改变了的契约文档；仅新增一个遵循原约定的实例，不必改写整个架构。完整同步矩阵见 [开发指南](DEVELOPMENT.md#规范与文档同步)。

## 服务组合与生命周期

需要被多个 feature 调用的业务逻辑，放入所属能力提供的 Cordis `Service`，参考 [`ModelsService`](../src/features/models/server.ts)。步骤：定义服务方法与身份参数 → 在 `kernel/context.ts` 扩充 Context 类型 → 提供者 `ctx.plugin(ServiceClass, config)` → 消费者 `inject: ['serviceName']` → 通过 `ctx.serviceName` 调用。

同一个 feature 刚创建 Service 后才注册依赖它的路由，可参照 models 中的 `ctx.inject(['models', 'db', 'http'], ...)`。**类型声明不会创建运行时服务**；缺依赖时 Kernel 会拒绝将 feature 视为成功激活。

必需依赖要明确声明。若 A 是可选插件而 B 是 core，不要让 B 硬依赖可随时停用的 A；应将稳定契约放在基础服务或 B 提供的注册表中，由 A 注册贡献并返回 disposer。当前项目只有已实现的 HTTP / Adapter 等注册表，没有现成的 Memory / RAG 扩展总线；新扩展点需单独设计和验证。

事件、定时器、订阅等都必须有清理路径：

```ts
ctx.effect(() => {
  const timer = setInterval(() => {
    // 执行本 feature 的工作；异步工作需要自行处理拒绝与退出。
  }, 30_000);
  return () => clearInterval(timer);
});
```

`ctx.effect` 的释放负责卸载，不能只创建定时器而依赖进程退出。需要在数据库关闭前等待任务落盘时，参考 chat 注册 `ctx.kernel.onShutdown` 的方式；这是进程关闭协调，不能单独替代可选插件停用时的清理。数据库 `transaction` 是同步的，先完成外部 I/O 再在同步事务里提交关联写入。

## 添加模型 Adapter

实际契约在 [`src/adapters/registry.ts`](../src/adapters/registry.ts)：

```ts
interface ModelAdapter {
  discover(connection: ProviderConnection): Promise<string[]>;
  generate(
    connection: ProviderConnection,
    model: string,
    messages: ProviderMessage[],
    signal: AbortSignal,
    effort?: ReasoningEffort,
  ): AsyncIterable<ProviderEvent>;
}
```

`ProviderEvent` 是 `{ type: 'text', text }` 或 `{ type: 'usage', usage: { input, output, total } }`；相关类型均从该契约文件导入，`ReasoningEffort` 来自共享 DTO。Adapter 必须处理取消、协议错误、流结束及真实用量，不能将无 usage 伪造成零。

在 Cordis scope 中通过 `ctx.effect(() => ctx.adapters.register(id, adapter))` 注册，当前 Kernel 注册 `openai-compatible`、`anthropic-messages` 和 `jev`。`ModelsService.adapter(apiMode)` 是唯一协议路由入口：前者处理 `chat-completions` / `responses`，`anthropic-messages` 处理原生 Messages，`jev` 处理 TypeSafe System One。来源表保留 `api_mode`，旧来源迁移默认 Chat Completions。

新增协议时同步共享 `ApiMode` / `apiModeLabels`、provider Zod、管理表单、ModelsService 映射与注册；已有协议值保持兼容。聊天、连通性测试、探测都传入来源的 apiMode，不在调用点硬编码 Adapter ID。如果未来协议需要独立于来源的 Adapter ID，再设计相应迁移。

思考档位是 `none / low / medium / high / xhigh`；None 省略上游字段。OpenAI 两种模式分别使用 reasoning_effort / reasoning.effort；Anthropic 当前使用 adaptive thinking / output_config.effort，不支持该字段的模型使用 None。协议转换放在 Adapter 中，聊天页面只提交统一 DTO。不要把 thinking_delta 当最终回复正文，也不要为协议错误自动重复付费调用。

用量计数必须来自供应商，累计 usage 以最新值替换，不将多次事件重复相加。`TokenUsage` 是共享 `MessageUsage` 的类型别名。新增或变更计数方式时同时验证统计页、消息历史及 SSE done 的一致性。参考 `tests/anthropic-adapter.test.ts`（图片、认证、分页、五档思考、缓存计数、缺失/零用量、失败及取消）与 `tests/models-iteration.test.ts`（权限、迁移、顺序、来源链接及消息用量）。

## 来源探测与模型连通性测试

- `POST /admin/providers/discover` 接收未保存的 `{ baseUrl, apiMode, apiKey?, id? }`。编辑来源时，省略 apiKey 会沿用 id 对应的已存密钥；显式空字符串表示免鉴权。只调用 Adapter.discover，不写来源、白名单或用量。现有来源也可调用 `POST /admin/providers/:id/discover`。
- `POST /admin/models/:id/test` 替代旧的 `/admin/providers/test`。仅管理员可调用，body 只允许可选 `reasoningEffort`，默认 none。模型 API 名称、来源与协议从数据库读取，不接受任意临时模型或连接覆盖；停用模型也可在启用前测试，不改变权限。
- `features/models/connection-test.ts` 对 LLM 调用与聊天相同的 generate 流，对 Jev 调用原生 decide，单次简短请求，60 秒截止。DTO `ModelConnectionTest` 包含 ok、model、apiMode、reasoningEffort、firstTextMs（未收到则 null）、latencyMs、textChunks、usage、可选脱敏 error 与 diagnostics（请求、HTTP 响应、模型输出、错误、截断标志）。已有有效用量在后续失败时保留，累计值取最新。
- 显式管理员测试才创建 `ProviderDiagnostics`，通过 `ProviderConnection.diagnostics` 与 `providerFetch` 观察实际适配器请求和已消费的响应字节，不使用第二次请求或全局 fetch 拦截。请求、响应和输出各保留最多 32,768 字符；已知密钥、URL 凭据 / 查询值和敏感字段脱敏，响应头只保留类型、请求 ID 和重试提示。普通聊天仍不暴露原始上游错误。日志只返回当前管理员浏览器，不写数据库 / 控制台；HTML、非 JSON、半截流、超时也保留已获得的诊断信息。
- API 校验 / 权限错误仍使用 HTTP 错误码；完成诊断后返回 HTTP 200，客户端必须检查 ok，不能仅凭 HTTP 成功或收到 usage 判定模型连接成功。无可显示文字的流判为失败。每次真正开始生成的测试记录当前管理员的用量，独立于聊天，不保存测试文本。
- 前端来源表单探测后展示列表，保存成功再打开白名单添加弹窗。输入地址、密钥或协议变化即清除过期结果；取消不能保存配置或自动添加模型。

`tests/streaming-latency.test.ts` 使用受控流在结束帧发送前验证首个文字已转发，同时覆盖拆分 UTF-8 / SSE 边界；它验证本地逐片行为，不代表真实供应商延迟。集成测试覆盖草稿探测不写库、权限、三种协议、失败用量与思考参数。真实来源问题需要用户授权后的独立诊断，不加入付费凭据或生产数据到自动测试。

## 注册托管的 LLM 能力

新增能力仍是普通 feature，manifest 声明 `capability: true`，由 server / client 两个入口显式注册。核心 `extensions` 提供能力目录、用户模式、管理员 Auto 策略与辅助调用记录。能力插件不直接接入 chat；参考 [`search/server.ts`](../src/features/search/server.ts)：

1. 在 server 的 inject 中声明 extensions，以及实际使用的其他服务。
2. 在 `ctx.effect` 中调用 `ctx.extensions.register(definition)` 并返回 disposer。
3. definition 提供 id、name、description、icon（globe / puzzle）、settingsId、ready、英文 decisionInstructions 和异步 execute。
4. execute 接收 `ExtensionScope`，使用 `scope.llm(stage, prompt, zodSchema)` 生成并校验 JSON；使用 `scope.track(stage, modelName, work)` 记录其他上游调用。必须传递 `scope.signal`，不得另配辅助模型凭据或自行绕过授权。通过 `run` 与 `update()` 保存查询、来源及状态，返回追加给最终回答的上下文。
5. capability 的 client 使用 `placement: 'settings'` 与 `settingsParent: 'extensions'` 注册自己的设置页，由托管页链接访问，不新增 Shell 导航。服务端配置路由必须 requireAdmin。

当前接口：

| API                                 | 权限与内容                                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `GET /extensions`                   | 当前用户的模式和活动能力可用性；不返回密钥或管理员模型选择                                                                   |
| `PATCH /extensions/preferences`     | 当前用户单项更新 `{ id, mode }`，保留其他能力选择；兼容整组 `{ modes: { [id]: 'auto' / 'on' / 'off' } }`，返回保存后的 modes |
| `GET /admin/extensions`             | 管理员读取活动托管能力和 policy                                                                                              |
| `PATCH /admin/extensions/:id`       | 管理员写 `{ enabled, strategy: 'llm' / 'llm-jev', llmModelId: UUID / null, decisionModelId: UUID / null }`                   |
| `GET /admin/search`                 | 管理员读取 baseUrl、hasKey、maxQueries、maxResults                                                                           |
| `PATCH /admin/search`               | 管理员写检索配置；省略 apiKey 保留，空字符串清除                                                                             |
| `GET /models?kind=all` / `kind=jev` | 在原有已启用、已授权范围内列出全部类型 / 仅 Jev，默认 kind=llm                                                               |

`POST /conversations/:id/messages` 新增可选 `extensions` 模式快照，省略等同全部 Off。幂等仍使用 requestId，重复提交不会重复搜索。SSE 新增 `{ type: 'extensions', messageId, extensions: ExtensionRun[] }`，重连必须沿用完整 snapshot 替换，不能把查询或用量重复追加。

`ModelAdapter.decide` 为可选的决策接口，输入 state + instructions，产出 usage 或 `{ type: 'decision', enabled }`。Jev 的 `generate` 明确拒绝聊天；discover 使用 TypeSafe `models[].name`，decide 使用 `/systemone`，管理员连通性测试使用英文 state / Choice 验证有效决策而非伪造文本片段。401 明确提示鉴权失败，并在诊断日志中保留脱敏后的上游错误；不把语言支持问题混同为鉴权失败。协议依据 [TypeSafe API](https://docs.typesafe.ai/api)、[模型列表](https://docs.typesafe.ai/models)；检索依据 [Perplexity Search](https://docs.perplexity.ai/api-reference/search-post)。

检索流程参考 [Open WebUI 的查询生成与搜索预处理](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/utils/middleware.py) 的阶段划分，没有复制其运行时。失败、权限与用量边界见 [架构](ARCHITECTURE.md#llm-拓展能力核心)。

## 对话分组 API

分组路由由 chat 的 `groups-server.ts` 注册到现有 router，沿用 `requireUser`、数据库生命周期和统一错误处理，无新增 feature / 全局服务。

| 接口                                  | 输入 / 返回                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /api/conversation-groups`        | 返回当前账户的 `{ id, name, icon, colorSlot }[]`                                                     |
| `POST /api/conversation-groups`       | `name` 必填（trim 后 1–60 字符）；`icon` 默认 `folder`；`colorSlot` 默认 null，返回创建的分组（201） |
| `PATCH /api/conversation-groups/:id`  | 部分修改 `name`、`icon`、`colorSlot`，至少一个字段                                                   |
| `DELETE /api/conversation-groups/:id` | 仅删除当前账户的分组，将原成员的 `groupId` 置 null，保留对话 / 消息                                  |
| `POST /api/conversations`             | 增加可选 `groupId: UUID \| null`，省略为 null；传入时验证当前账户拥有目标分组                        |
| `PATCH /api/conversations/:id`        | 增加可选 `groupId`，null 移出分组，可与 title 同时修改；保留旧 colorSlot 输入兼容                    |
| `GET /api/conversations`              | 每项增加 `groupId: string \| null`；按更新时间降序返回全部私人对话                                   |

`icon` 为 `folder / book / code / briefcase / sparkles` 或一个 emoji 字素（最长 32 个 UTF-16 code units，支持肤色、旗帜与 ZWJ 组合），以共享 `groups.ts` 验证；`colorSlot` 为 null 或 0–63 整数。跨账户分组 / 对话返回 404，未登录返回 401，输入错误返回 400。分组仅整理已有对话，不建立共享上下文或影响模型请求。
