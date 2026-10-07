# 上下文管理：自动压缩与轨迹摘要

插件位于「设置 → 上下文管理」，聊天回复旁的「上下文」打开轨迹与实际请求快照。记忆召回由独立 [Memory Manager](MEMORY_API.md) 提供；本插件负责请求历史压缩、快照、节点摘要和 Hand-off。

## 用户设置

配置保存在当前账户的 SQLite `context_preferences`，兼容旧 `handoff_model_id`。`GET /api/context-manager/preferences` 返回完整设置；`PATCH` 接受部分字段，合并后验证，返回完整设置。所有接口沿用登录 Cookie / Origin 校验，模型必须是启用且当前用户已授权的 LLM。保存设置不调用模型。

| 字段                     | 默认值 | 范围 / 行为                                         |
| ------------------------ | ------ | --------------------------------------------------- |
| handoffModelId           | null   | 默认交接模型，也可每次选择                          |
| compressionEnabled       | false  | 开启发送前自动压缩                                  |
| compressionModelId       | null   | 压缩模型，启用时必填                                |
| compressionThreshold     | 24000  | 2000–1000000 个 UTF-16 字符                         |
| compressionKeepTurns     | 4      | 1–20 次最近提问及其已完成回答保留原文               |
| compressionMaxCharacters | 6000   | 摘要正文预算 500–16000 字符；启用时必须小于触发阈值 |
| trajectoryEnabled        | false  | 完成回答后自动生成本轮节点摘要                      |
| trajectoryModelId        | null   | 节点摘要模型，自动生成启用时必填                    |

```json
{
  "compressionEnabled": true,
  "compressionModelId": "<已授权 LLM 的 UUID>",
  "compressionThreshold": 24000,
  "compressionKeepTurns": 4,
  "compressionMaxCharacters": 6000,
  "trajectoryEnabled": true,
  "trajectoryModelId": "<已授权 LLM 的 UUID>"
}
```

设置页的改动需点击「保存设置」，从下一轮开始生效。压缩、摘要和交接分别计入真实辅助模型用量；不从字符数估算 Token 或账单。

## 自动压缩如何改变请求

每轮发送前，在 Memory / Skill / Search 文本组装后检查消息正文的 UTF-16 字符数。包含历史和当前正文及本轮已注入内容，不含图片、角色、工具定义或协议序列化开销；工具循环追加内容不重新触发压缩。这个阈值不是模型上下文容量或 Token 占比。

较早的历史前缀交给压缩 LLM，摘要以用户级 `conversation_summary` 参考块替代该前缀。当前提问、Memory 的范围与 offsets、近期原文保留不变；不升格为 System prompt。包含图片的消息及其后的历史保留原文，因此有些轮次没有可压缩前缀。单次压缩资料最多 240000 字符，超过时明确记录原因，保留原历史；结果超出预算、没有缩减输入或模型失败也保留原历史。超时 60 秒，停止聊天会取消压缩，插件停用只取消该辅助调用并继续普通聊天。

`context_compressions` 按对话和 owner 保存一个摘要缓存，记录来源前缀数量及 ID / 角色 / 正文哈希、模型配置指纹和摘要预算。后续先复用摘要；复用后的上下文仍达到阈值且存在新的可压缩历史时，将已有摘要与新增前缀一起增量压缩。来源、模型 / 来源配置或预算变化会使缓存失效；保留轮数增加时不会用旧摘要吞掉应保留的原文。停用自动压缩后发送完整历史，原始 `messages` 始终保留。

平台接受的历史扫描上限为 2000 条、约 30000000 字符（图片按原 data URL 长度计入保护预算）；最终回答请求仍最多 200 条历史加当前输入。压缩无法满足最终保护限额时，本轮明确失败并提示调整设置或新建对话，不静默截断。

快照的 `compression` 记录 compressed / reused / skipped / error、处理前后字符、压缩与保留消息数、阈值、模型、耗时、可得的真实用量和安全错误。Session 分区显示实际发送的「历史压缩摘要」和保留原文；字符图据此变化。

## 轨迹节点摘要

回答成功完成后，启用的摘要模型在后台处理当前原始提问和实际回答，返回结构化 `title / intent / answerSummary`，分别限制 120 / 600 / 1200 字符。模型仅总结证据，不能把助手声称的进展视为已验证事实；不读取供应商推理、凭据或整份上下文快照。输入保留提问前 12000 与回答前 32000 字符，发生截取时通过 `inputTruncated` 和 UI 明确说明。

摘要保存在对应快照的 `trajectory`，原 `prompt`、回答、状态、字符统计和回答模型用量保留。它含 generationId、pending / ready / error 状态、三个文本字段、模型、创建时间、可得的辅助用量、安全错误和截取标记。generationId 用于防止旧任务迟到覆盖新摘要，不是持久任务队列。生成失败不影响已完成回答；缺少用量保持 null，已上报的失败调用用量仍记录在统计中。重启 / 重新启用时将遗留 pending 标为中断，允许显式重试，不自动重跑。

轨迹列表使用已完成摘要的标题并显示意图；未生成时使用原始提问。详情展示三个字段、模型和独立辅助用量；原文仍在「当前 prompt」与「本轮回复」。抽屉查看期间轮询 pending 状态，关闭只停止查看与手动摘要请求，不取消服务器已开始的自动摘要。

### 手动生成 / 重试 API

`POST /api/context-manager/conversations/:id/turns/:messageId/summary`

```json
{ "modelId": "<可选的已授权 LLM UUID>" }
```

省略模型时使用当前账户 `trajectoryModelId`，无需开启自动生成。对话和快照必须属于当前用户且该轮已完成；管理员不能代读其他用户快照。返回 `ContextTrajectory`，HTTP 200 后仍需检查业务 `status`；上游 / JSON 校验失败返回 error 并持久化安全原因。同一节点已有活动任务返回 409；权限、参数、快照缺失沿用 400 / 403 / 404。手动任务在请求断开、插件停用或服务关闭时取消；同一次任务的迟到结果不能覆盖重新生成的摘要。

已有查询与 Hand-off API 见 [功能扩展](FEATURES.md#对话-context-manager)。对话删除级联清理快照与压缩缓存；停用插件保留数据。

## 开发契约与验证

chat 仅依赖 extensions 核心。`ContextObserver` 继续同步、只读地记录实际请求；独立的 [ContextProcessor](../src/features/extensions/context-processor.ts) 提供异步 prepare / complete，由 context-manager 经 `ctx.effect` 注册。prepare 返回请求消息与压缩记录；complete 在回答保存后调度节点摘要。辅助调用统一使用 `registerUtility` / `generateUtility`，逐次校验模型授权、使用真实协议适配器并记录真实用量。SQLite 迁移集中在 `kernel/database.ts`，网络调用在事务外。

Memory 暂时撤出、修改正文或来源失效时，清理该版本及更旧快照中的记忆正文；重新纳入后的新版本可以进入后续快照，不恢复已清理的旧副本。彻底删除才清理该 ID 的所有版本，开发契约见 [记忆生命周期](MEMORY_AGENTS.md#生命周期与证据)。清理后的快照沿用 `[记忆已删除]`、`memoryDeleted` 兼容标记并重新计算数量；对于暂时撤出，这个标记表示旧副本已清除，不表示 MemoryItem 已永久删除。正文查看、复制和 Hand-off 不再包含被清理副本的原文。

针对性测试为 `tests/context-processing.test.ts`、原 `context-manager.test.ts` 和 Memory 上下文兼容用例；浏览器检查 `tests/e2e/context-automation.spec.ts` 与 `memory-settings.spec.ts`。仅使用临时 SQLite、本地 mock provider 和隔离会话，不调用付费模型或使用生产数据作夹具。
