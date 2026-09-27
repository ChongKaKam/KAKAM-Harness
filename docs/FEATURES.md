# 添加一个 feature

参考已经实现的 `src/features/prompts/`。UI 和 API 随同一个产品能力一起维护。

## 文件结构

```text
src/features/my-feature/
  manifest.ts        纯数据：id / name / kind / version / adminOnly
  server.ts          Cordis plugin：服务、路由及 effect 清理
  client.tsx         React 页面组件，可复用 Web Shell context
```

## 服务端

```ts
import { Router } from 'express';
import type { Context } from 'cordis';
import { requireUser } from '../../kernel/http';

export const server = {
  name: 'my-feature',
  inject: ['db', 'http'],
  apply(ctx: Context) {
    const router = Router();
    router.get('/my-feature', requireUser, (req, res) => {
      // 所有个人数据查询必须限制 req.user!.id。
      res.json({ ownerId: req.user!.id });
    });
    ctx.effect(() => ctx.http.register(router));
  },
};
```

在 `src/server/app.ts` 的 composition root 调用 `kernel.register(manifest, server)`。把表定义迁移加入数据库模块，避免在请求处理中变更 schema。需要独立服务时继承 `Service` 并在 `kernel/context.ts` 增加类型；消费服务的插件声明 `inject`。

**当前插件是受信任的构建期模块。** manifest 不允许客户端指定任意服务端模块路径，API 也不执行上传的代码。

## 客户端

`client.tsx` 导出页面组件。在 `src/client/registry.ts` 添加 `{ manifest, component, icon }`，Web Shell 自动根据服务器启用状态生成菜单。一般无需改 Shell 的导航或页面判断。

调用 `useWorkspace()` 获取当前用户、已授权模型、刷新函数、导航与提示消息。`api()` 处理 JSON 错误与登录失效。不要把服务端密钥或数据库实体直接传给页面。

## Adapter

新模型协议实现 `src/adapters/registry.ts` 的 `ModelAdapter`：

- `discover(connection)` 返回精确模型 ID。
- `generate(connection, model, messages, signal)` 返回 text / usage 的异步事件流，必须处理取消信号。
- 在 Cordis 插件中使用 `ctx.effect(() => ctx.adapters.register(id, adapter))` 注册。

当前来源仅使用 `openai-compatible`；增加第二种协议时再给 providers 表及表单增加 adapter ID 字段，并让 `ModelsService` 按来源选择 Adapter，无需改聊天 UI。

## 检查要点

测试实际行为：未登录 / 无权用户访问应失败，数据不能跨用户读取，启停能撤销路由与清理资源，重新启用不产生重复路由。对外部请求用本地测试服务模拟正常响应、异常与取消；避免对实现细节逐行写镜像测试。
