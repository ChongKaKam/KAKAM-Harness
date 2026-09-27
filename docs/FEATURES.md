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

在 Cordis scope 中通过 `ctx.effect(() => ctx.adapters.register(id, adapter))` 注册。当前 `ModelsService.adapter()` 固定选择 `openai-compatible`，providers 只记录 `api_mode`；**仅注册第二个 Adapter 并不能让用户选到它**。还需要追加来源 adapter ID、更新 DTO / Zod / 管理表单 / 路由选择和迁移，默认映射旧来源到现有 Adapter。

Chat Completions 与 Responses 已由同一个兼容 Adapter 支持。思考档位是 `none / low / medium / high / xhigh`；`none` 省略上游字段。新协议应在 Adapter 中转换，不让聊天页面负责拼供应商请求。
