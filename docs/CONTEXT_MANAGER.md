# 上下文管理：自动压缩与轨迹摘要

新 Harness 复用这里的历史压缩、轨迹与轮次观察。新工作区的文档及工具结果受版本授权保护，快照保留工具操作的结构，获取正文时重新校验访问范围。这里的“交接”是按选中轮次生成并交给当前用户的文本；将资料开放给另一个对话需用户在[对话工作区](HARNESS.md)发布或批准指定版本。

插件位于「设置 → 上下文管理」，聊天回复旁的「上下文」打开轨迹与实际请求快照。记忆召回由独立 [Memory Manager](MEMORY_API.md) 提供；本插件负责请求历史压缩、快照、节点摘要和 Hand-off。

## 用户设置

配置保存在当前账户的 SQLite `context_preferences`，兼容旧 `handoff_model_id`。`GET /api/context-manager/preferences` 返回完整设置；`PATCH` 接受部分字段，合并后验证，返回完整设置。所有接口沿用登录 Cookie / Origin 校验，模型必须是启用且当前用户已授权的 LLM。保存设置不调用模型。

| 字段                     | 默认值 | 范围 / 行为                                                            |
| ------------------------ | ------ | ---------------------------------------------------------------------- |
| handoffModelId           | null   | 默认交接模型，也可每次选择                                             |
| compressionEnabled       | false  | 开启发送前自动压缩                                                     |
| compressionModelId       | null   | 压缩模型，启用时必填                                                   |
| compressionThreshold     | null   | 自动按主模型输入额度触发。可填写 2000–1000000 个 UTF-16 字符以提前触发 |
| compressionKeepTurns     | 4      | 1–20 次最近提问及其已完成回答保留原文                                  |
| compressionMaxCharacters | 6000   | 摘要正文预算 500–16000 字符；须小于显式字符阈值                        |
| trajectoryEnabled        | false  | 完成回答后自动生成本轮节点摘要                                         |
| trajectoryModelId        | null   | 节点摘要模型，自动生成启用时必填                                       |

```json
{
  "compressionEnabled": true,
  "compressionModelId": "<已授权 LLM 的 UUID>",
  "compressionThreshold": null,
  "compressionKeepTurns": 4,
  "compressionMaxCharacters": 6000,
  "trajectoryEnabled": true,
  "trajectoryModelId": "<已授权 LLM 的 UUID>"
}
```

设置页的改动需点击「保存设置」，从下一轮开始生效。压缩、摘要和交接分别计入真实辅助模型用量；不从字符数估算 Token 或账单。

## 自动压缩如何改变请求

在「模型与接入 → 模型设置与授权」中为每个 LLM 填写该来源实际支持的上下文窗口和所需的单次最大输出（单位均为 token）。新旧模型的两个字段都允许留空。网关限额可能比原厂低，同名模型在不同来源可分别配置。模型列表探测不推断容量。

启用自动压缩并选择压缩模型后，默认在预计输入达到可用输入额度的 80% 时压缩一次。可用输入额度等于总窗口减去预留输出。例如窗口 1,000,000、最大输出 16,000 时，预留后的输入额度是 984,000，自动压缩点为 787,200。80% 是 Drift Space 为后续搜索和工具结果留空间的取值。设置页已有的显式字符阈值继续生效，与模型阈值中先达到的一项触发。窗口未知且字符阈值留空时，沿用 24,000 个 UTF-16 字符。自动压缩默认关闭，开启后才会产生摘要调用。

输出留空时，Responses 沿用上游默认，本地规划留出窗口的八分之一，最多 8,192 tokens。Anthropic Messages 要求发送输出上限，按思考程度使用 4,096 或 16,384，配置了小窗口时最多占该窗口的一半。管理员显式填写的最大输出优先生效。

**发送前的两次判断**

1. 历史压缩位于搜索之前。自动阈值估算已复用摘要的历史、当前输入、图片、Skill、工作区资料及首轮可用工具的协议声明与指令。显式字符阈值沿用历史、当前输入、Skill 的文本计量。压缩摘要替代较早的历史前缀，以用户级 `conversation_summary` 进入请求。默认保留最近四轮原文，历史中的第一张图片及后续消息也保留。原始聊天记录始终保存在数据库中。
2. 如有搜索等外部能力，Harness 先用压缩后的历史和已知首轮工具检查主模型请求，避免在已确定无法回答时先消耗检索额度。拿到外部资料后，主回答、工具续轮和辅助文本模型均在实际出站前，按各自模型的已配置窗口检查协议请求。检查包含最终输入、工具声明、搜索与文件结果、原生协议续接、用户补充和输出预留。文本采用跨模型的本地估算，原生图片每张预留约 2,048 tokens，实际分词和视觉计量取决于提供方。估算超过额度时中止该次发送并提示原因。提供方仍可能按自己的计量拒绝请求。用量记录只采信提供方上报。

压缩一次最多发出一个辅助请求。若较早历史超过压缩模型容量，按完整轮次选取能容纳的最长前缀，其余消息照原文传递，以后可继续增量压缩。压缩模型窗口未知时，每次摘要输入的历史资料上限沿用 240,000 字符。如果连首个待处理轮次都装不下，保留历史并提示更换压缩模型。超时为 60 秒，停止聊天会取消压缩。辅助模型失败时尝试用原历史作答，最终发送仍受主模型检查约束。工具循环期间沿用同一份历史，已执行工具的结果和原生推理续接原样参与下一轮检查。

`context_compressions` 按对话和 owner 缓存摘要，并校验来源前缀的消息 ID、角色和正文哈希、模型配置指纹和摘要预算。提高近期保留轮数后，旧缓存只在仍符合条件时复用。快照记录处理前后字符数、压缩和保留的消息数、阈值及其单位、耗时、可得的真实用量和错误。工作区私有材料的观察规则见[对话工作区](HARNESS.md)。

历史扫描上限仍为 2,000 条、约 30,000,000 字符，包含历史图片 data URL。已配置窗口的模型可在容量范围内使用超过 201 条短消息。窗口未知时沿用压缩后含当前输入最多 201 条的保护。

Codex 单独配置模型窗口与自动压缩阈值。Claude Code 的文档以原生 1M 模型约 967k tokens 时压缩为例，并支持自定义压缩点、按实际网关覆盖容量。这两项机制是这里将容量配置与压缩策略分开的参考。[Codex 配置参考](https://developers.openai.com/codex/config-reference/) · [Claude Code 网关窗口配置](https://code.claude.com/docs/en/model-config#context-window-behind-an-llm-gateway) · [Claude Code 默认压缩点](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds)

本地 Claude Code 2.1.107 的静态分析还展示了一种按绝对量留余量的设计：该版本的 `qTY` 从有效窗口扣除最多 20,000 个输出 tokens 和 13,000 个余量，且有配置覆盖分支；`RC6` 在压缩后按预算重新附上工作状态。这里借鉴“输出预留”和“工作资料单独装入”，Drift Space 的默认 80% 适用于本地估算和两个提供方。该旧版本的常数不代表当前 Claude Code 默认值。

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

已有 Memory provider 快照接口的 `ContextRequest.memoryRanges` 必须指向该次实际请求最后一条用户消息中的记忆块，`currentOffset` 是原始提问在同一条消息中的起点（旧调用默认 0）。产物工具说明和每轮交付要求前插时，由 generateReply 逐轮移动这些位置，不修改准备阶段的原始 ranges。Observer 只在给定范围内校验序列化记忆块，不搜索正文标记来猜位置；失配的元数据保留为普通请求文本，不伪装成记忆。原始提问与前插的工具说明分别计入当前 prompt / Session，字符不重复计算。此修复作用于新记录的请求，不重写已有历史快照。

Memory 暂时撤出、修改正文或来源失效时，清理该版本及更旧快照中的记忆正文；重新纳入后的新版本可以进入后续快照，不恢复已清理的旧副本。彻底删除才清理该 ID 的所有版本，开发契约见 [记忆生命周期](MEMORY_AGENTS.md#生命周期与证据)。清理后的快照沿用 `[记忆已删除]`、`memoryDeleted` 兼容标记并重新计算数量；对于暂时撤出，这个标记表示旧副本已清除，不表示 MemoryItem 已永久删除。正文查看、复制和 Hand-off 不再包含被清理副本的原文。

针对性测试为 `tests/context-processing.test.ts`、原 `context-manager.test.ts` 和 Memory 上下文兼容用例；浏览器检查 `tests/e2e/context-automation.spec.ts` 与 `memory-settings.spec.ts`。仅使用临时 SQLite、本地 mock provider 和隔离会话，不调用付费模型或使用生产数据作夹具。
