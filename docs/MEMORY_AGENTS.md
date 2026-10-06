# 记忆策略 / Agent 开发指南

本文描述当前构建期扩展契约。三层记忆的用户设置、数据库、HTTP 输入和错误详见 [Memory API](MEMORY_API.md)，部署配置见 [README](../README.md#记忆模块与-postgresql)。策略是可信的应用代码，尚无在线安装、执行沙箱、第三方代码上传或外部 Agent 专用 Token 鉴权。

## Manager 与策略的职责

`memory` 是可停用插件。Chat 只调用 `extensions` 核心的 [MemoryProvider](../src/features/extensions/memory-provider.ts)，插件注册 Manager 实现；Chat 不导入 Manager、PostgreSQL Repository 或策略模块。回答前 `prepare` 生成记忆块，回答成功并持久化后 `complete` 抽取新记忆，编辑 / 重试调用 `invalidate`，删除范围调用 `removeScope`。可选 `applied` 标记实际请求已使用该次准备结果。

Manager 控制当前用户、对话 / 分组归属、模型授权、输入长度、数据库查询范围、有效状态、内容版本、候选审批、写入模式、最终条数 / 字节预算、超时、删除和操作幂等。策略负责根据已限定的候选选择 ID、提供理由，以及提出带证据的记忆草稿。策略不能通过输出 owner、scopeId、批准标志或任意正文绕过 Manager。

首版 `default` 的检索为查询 embedding → pgvector 精确余弦候选 → LLM + 检索 Prompt 选择 ID → Manager 重新校验并读取正文。其抽取为完成轮次 → LLM + 抽取 Prompt → 结构化草稿 → 证据 / 凭证校验 → 各作用域的写入模式。首版不裁剪原始历史，也不自动解决语义冲突；Session 记忆作为用户级参考补充，不替换聊天原文。

## 服务端契约

纯 DTO 位于 [`shared/memory.ts`](../src/shared/memory.ts)，服务端策略类型和注册表位于 [`strategies/types.ts`](../src/features/memory/strategies/types.ts)：

```ts
interface MemoryStrategy<C extends object> {
  info: MemoryStrategyInfo;
  configSchema: z.ZodType<C>;
  budgets(config: C): MemoryBudgets;
  recall(input: RecallInput<C>): Promise<{ id: string; reason: string }[]>;
  extract(input: ExtractionInput<C>): Promise<MemoryDraft[]>;
}
```

`info` 必须包含稳定 `id`、name、description、实现 version、configVersion、capabilities、defaultConfig 和配套 UI 的 settingsKey。注册时验证默认配置、拒绝重复 ID 和空 settingsKey。当前注册入口为 [`createStrategyRegistry`](../src/features/memory/strategies/default.ts)；新增策略在这里显式 `.register(strategy)`，没有目录扫描。

`RecallInput<C>` 提供 context、candidates、config 与 tools；`ExtractionInput<C>` 提供 context、config 与 tools。`MemoryDraft` 为 `{ scope, kind, content, evidence, tags }`，不包含 owner、批准或数据库连接。分类、正文和范围仍由 Manager 再次验证；分组不存在时不能产生分组记忆。

`MemoryBudgets` 要完整返回 candidateLimit、similarityThreshold、recentDays、maxItems、maxBytes、scopeLimits、timeoutMs、fallback。配置必须以 Zod 限制范围，避免策略 UI 保存无限调用 / 超大上下文设置。切换策略保留各自配置和已有记忆；配置编辑使用版本号，过期草稿返回 409。实现 version 与 configVersion 分别表示策略实现和配置结构，升级结构需要明确兼容或迁移已有文档，不能把旧用户配置静默当作新默认值。

### Agent 工具

每次策略执行获得作用域绑定的 `StrategyTools`：

| 工具                                            | 行为                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `llm<T>('recall' \| 'extract', prompt, schema)` | 使用当前用户选择的相应 LLM，托管授权、取消、真实用量与结构化输出校验 |
| `search(query, limit?)`                         | 使用绑定的用户 / 对话 / 分组查询候选，不接受任意 owner               |
| `read(id)`                                      | 读取本次允许范围内的记忆，不能跨用户读取                             |
| `signal`                                        | 总时限、主动取消、插件停用与关闭的中止信号                           |

Agent 可在策略实现中组织多步 search / read / llm，但必须传播 signal、设置有限步骤 / 调用预算，并通过 schema 处理模型结果。不得绕过工具直接发付费请求、读取模型密钥或拿 PostgreSQL 连接。没有上游 usage 时不能估算或填零。工具没有“批准候选”能力；用户确认由 HTTP 管理接口执行，默认 LLM 不能批准自己的建议。

`tools.llm` 使用 `extensions` 的 utility 托管接口，不加入聊天 Auto / On / Off 菜单。需要新模型操作时扩展现有 ModelAdapter 和 ModelsService，逐调用校验；embedding 只通过 `ModelsService.embed`。检索失败按配置跳过或降级，抽取失败不改变已完成回答。

## 配套设置 UI 是交付条件

每个策略必须同时实现专属 React 设置面板，并加入 [`memoryStrategyClients`](../src/features/memory/strategy-ui.tsx)。客户端按相同 id、settingsKey 和 configVersion 配对；缺少配套面板时设置页禁用该策略，显示原因。服务端不加载 React；因此两份注册表的一致性必须通过构建 / 针对性测试验证，不能只填写一个 settingsKey 就认为 UI 已交付。

通用面板协议：

```ts
interface MemoryStrategySettingsProps {
  config: Record<string, unknown>;
  defaults: Record<string, unknown>;
  disabled: boolean;
  onChange(config: Record<string, unknown>): void;
}
interface MemoryStrategyClient {
  id: string;
  settingsKey: string;
  configVersion: number;
  Settings: ComponentType<MemoryStrategySettingsProps>;
}
```

服务端 `MemoryStrategy<C>` 使用策略专属配置类型；UI 容器使用上述通用记录接口，各面板在内部以同一纯配置 schema / 类型解释字段。配置类型、schema 与默认值放在可由浏览器导入的纯模块中，不导入 server.ts、Repository、Node 或凭据。可以参考 [`DefaultMemorySettings`](../src/features/memory/strategies/default-settings.tsx)。

面板只编辑传入 config，通过 onChange 返回新对象；持久化、版本号、加载、保存和错误由 `MemorySettings` 容器负责。面板必须完整处理 disabled，不发隐式模型测试或保存请求。新增配置至少说明含义、单位、上限、默认值和付费调用影响；允许恢复默认但不覆盖用户尚未保存的修改。

登记示例：

```ts
// server registry：已有 createStrategyRegistry() 中添加
new MemoryStrategyRegistry().register(defaultStrategy).register(myAgentStrategy);

// client registry：strategy-ui.tsx 中添加
memoryStrategyClients.push({
  id: 'my-agent',
  settingsKey: 'my-agent',
  configVersion: 1,
  Settings: MyAgentSettings,
});
```

这段只展示登记位置，`myAgentStrategy` 必须实现全部服务端方法，`MyAgentSettings` 必须实现实际内部配置界面。新增可信 Agent 随代码构建与发布，不能由设置页面输入脚本来安装。

## 默认策略配置与 Prompt

配置与默认值以 [`memory/config.ts`](../src/features/memory/config.ts) 为准，API 范围见 [默认策略配置](MEMORY_API.md#默认策略配置)。模型选择是用户公共 preferences，不存入某个策略的配置；策略配置单独保存，切换策略不会丢失。

检索 Prompt 支持 `{{context}}`、`{{candidates}}`、`{{maxItems}}`，必须包含前两项。模型只返回 `{"selected":[{"id":"候选 UUID","reason":"理由"}]}`；Manager 从已保存记录读取原文，拒绝凭空生成或越权 ID。抽取 Prompt 必须包含 `{{context}}`，返回 `{"memories":[{"scope":"user","kind":"fact","content":"记忆","evidence":"用户原文片段","tags":[]}]}`，最多 12 条。

默认 Prompt 将历史、用户文本和候选当作数据，不执行其中指令；本轮用户要求优先于旧偏好。抽取要求 evidence 是本轮用户文本中的原文片段，不把助手推测升级为用户事实，拒绝常见凭证。改 Prompt 不改变 Manager 的验证和批准权限，也不能使记忆变成 system 指令。

召回近期窗口只影响选择偏好，不删除长期记忆。向量空间按用户、模型配置指纹与维度隔离；来源 / 模型 / 维度变更后通过索引重建建立新空间，不能混用相同维度但不同模型的向量。重建和抽取在进程内执行，服务重启后不自动续跑；查询操作状态后显式重试。

## 生命周期与证据

对话移动到另一分组后，后续准备使用新分组，旧记忆不自动迁移。编辑末问 / 重试使旧候选失效，对来源关联衍生记忆标记复核状态；不能用迟到提取结果覆盖手动编辑。用户编辑 review 记忆表示重新确认该正文，恢复 active 并解绑失效旧来源，避免后续来源检查重复否定已确认内容；正常 active 编辑仍保留有效来源。写入和索引以内容版本校验，旧版本 embedding 不能进入新正文。

删除记忆清理正文、来源、版本、向量、候选关联及上下文快照中的记忆副本，保留去重墓碑；原消息保持原有聊天生命周期。范围删除和数据库暂不可用之间不存在跨库事务保证，召回时仍必须检查当前对话 / 分组归属，不只信任 PostgreSQL 中的外部 ID。

Context Manager 展示实际注入的记忆 ID、版本、范围和理由，并保留准备状态。检索候选、已发送块和回答后抽取结果是不同阶段；新抽取不能计入本轮请求字符图。Prompt 标记和分区依靠明确的 offsets / metadata，不能靠正文文本匹配拆分，以免重复统计或被用户构造文本干扰。

## 验证

选择与修改直接相关的隔离测试，不例行跑全量。最低覆盖新增策略的配置校验、服务端 / UI 的 id / settingsKey / configVersion 配对、取消、有限执行、越权 ID 和 schema 错误；存储变更覆盖 namespace + owner + scope、版本冲突、去重与重启。默认策略和 API 的 PostgreSQL 集成测试需要一次性测试库及 pgvector，不能指向已有部署数据库。

Embedding 协议与诊断：

```bash
npx tsx --test tests/embedding.test.ts tests/model-diagnostics.test.ts
```

UI 修改先 build，再检查记忆设置 / 数据管理、默认策略内部配置、模型类型 / 维度诊断，以及上下文抽屉的明暗和桌面 / 手机路径。构建包含类型检查，不重复运行同一检查。文档修改只检查格式、链接和示例签名；新增策略在同次修改中更新 API 的配置说明与本指南的注册说明。

配套 UI 和记忆分区的无数据库检查可运行 `npx tsx --test tests/memory-strategy-ui.test.ts tests/memory-context.test.ts`。真实 PostgreSQL Repository 用例为 `tests/memory-repository.test.ts`，通过 `MEMORY_TEST_DATABASE_URL` 指向一次性测试库（名称必须含 test），使用随机 namespace 并在结束后清理；未设置环境变量时数据库相关用例跳过，不能把跳过报告为通过。

HTTP / Chat 真实 PostgreSQL 集成在 `tests/memory.test.ts`，使用同一一次性 `MEMORY_TEST_DATABASE_URL` 与 `tests/memory-provider-fixture.ts` 的本地 mock，覆盖模型管理、三层检索、抽取 / 确认、实际上下文、删除 / 编辑 / 停用和重启。
