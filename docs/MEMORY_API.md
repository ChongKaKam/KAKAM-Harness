# Memory API 参考

首版 Memory 插件使用独立 PostgreSQL/pgvector，提供长期、分组和 Session 记忆的管理、检索、准备、抽取、候选确认、策略配置和索引 API。实际路由位于 [`memory/server.ts`](../src/features/memory/server.ts)，业务校验位于 [`manager.ts`](../src/features/memory/manager.ts)，纯 DTO 位于 [`shared/memory.ts`](../src/shared/memory.ts)。策略扩展见 [开发指南](MEMORY_AGENTS.md)，运行配置见 [README](../README.md#记忆模块与-postgresql)。

共享数据库的账号、schema、扩展、迁移 CLI 与恢复流程见 [数据库接入](MEMORY_DATABASE.md)。平台另提供无需登录的 `GET /api/health/memory`：就绪为 200 / `ok`，配置但不可用为 503 / `unavailable`，未配置或停用为 200 / `unconfigured` 或 `disabled`。仅返回配置 / 就绪状态和安全说明；私人 Memory API 仍须登录。`GET /api/health` 继续表示平台存活，不能作为记忆数据库连通的证据。

## 认证与公共规则

前缀为 `/api/memory/v1`。全部接口使用现有登录 Cookie `kh_session`；没有新增 API Key / Bearer Token 鉴权。浏览器同源调用沿用现有会话。外部 Agent 若使用 HTTP，也必须在部署的访问规则下通过已有登录会话操作，不能凭空发送 ownerId 或把管理员身份当作他人记忆的通行证。可信进程内 Agent 使用 Manager 的绑定工具，见策略指南。

写请求必须是 JSON。全局服务校验浏览器 Origin，接口沿用 Zod 和 `{ "error": "说明" }` 错误格式。身份来自 `req.user`，PostgreSQL 查询限定部署级 `MEMORY_NAMESPACE` 和当前 owner；请求不能选择 namespace / owner。对话与分组 ID 同时在平台 SQLite 中检查当前用户归属。

| HTTP 状态 | 含义                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| 400       | 字段 / 配置无效、模型类型错误、来源范围错误、缺少所需模型                    |
| 401       | 未登录或会话失效                                                             |
| 403       | Origin 不匹配，或模型未启用 / 未授权                                         |
| 404       | 私有资源不属于当前用户、资源已删除 / 不存在、插件停用                        |
| 409       | 内容 / 配置 / 范围版本冲突、来源内容变化、幂等键冲突、删除墓碑、重复活动任务 |
| 415       | 写请求不是 JSON                                                              |
| 429       | 同一用户已有 4 个或全局已有 32 个活动记忆任务                                |
| 502       | 上游协议、结构化结果或 embedding 校验失败                                    |
| 503       | PostgreSQL 未配置 / 未就绪、数据库操作失败或 Manager 正在关闭                |

聊天中的准备失败安全降级，回答仍继续；直接调用管理 API 仍按上述错误返回。异步接口返回 202 只代表接受任务，需查询 operation.state 判断成功。`prepare-turn` 的 HTTP 200 同样需要检查其业务 status。

## 类型与作用域

| 字段          | 值 / 行为                                                               |
| ------------- | ----------------------------------------------------------------------- |
| `scope`       | `user` 长期、`group` 当前用户分组、`session` 持久化对话                 |
| `scopeId`     | user 必须 null；group 为本人分组 UUID；session 为本人 conversation UUID |
| `kind`        | `profile / preference / instruction / fact / episode / summary / task`  |
| `status`      | 活动 `active` 或待复核 `review`；删除记录不由普通列表 / 读取返回        |
| `writeMode`   | `off` 不抽取、`confirm` 候选确认、`auto` 自动保存                       |
| `indexStatus` | `pending / ready / error`，正文保存与索引可分开完成                     |

`MemoryItem` 返回 id、scope、scopeId、kind、content、status、version、tags、pinned、createdAt、updatedAt、expiresAt、sources、indexStatus；搜索额外返回 similarity，Session 显式优先项可带 `selection: "prefer"`。时间为 ISO 字符串，未设置到期为 null。`MemorySource` 为 `{ conversationId, messageId, hash, evidence? }`；hash 是原始已保存消息 content 的 SHA-256 十六进制值，不做 trim / NFKC。指定 evidence 时必须是该消息的原文片段。来源被编辑、删除或不可访问时写入 / 批准返回 409。

源消息、平台身份和 Memory 之间没有跨库外键。移动对话后下轮使用目标分组记忆，旧分组记忆不迁移；删除分组清理其记忆并保留对话原文，删除对话清理 Session 并处理来源，独立长期记忆保留。

## 状态、用户设置和策略

| 方法与路径                     | 输入 / 返回                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `GET /status`                  | `{ configured, ready, error, spaces }`，数据库不可用仍返回安全状态；连接串不会返回      |
| `GET /strategies`              | 已注册 `MemoryStrategyInfo[]`，不需要 PostgreSQL 就绪                                   |
| `GET /preferences`             | 当前用户完整 `MemoryPreferences`                                                        |
| `PATCH /preferences`           | 部分修改公共设置，嵌套 writeModes / retentionDays 可局部修改；返回合并后完整值          |
| `GET /strategies/:id/config`   | `{ version, config }`，未保存为 version 0 + 默认配置                                    |
| `PATCH /strategies/:id/config` | `{ version, config }`，version 为读取到的非负整数；配置字段与原值合并、校验后返回新版本 |

preferences 默认：

```json
{
  "enabled": false,
  "strategyId": "default",
  "embeddingModelId": null,
  "recallModelId": null,
  "extractModelId": null,
  "writeModes": { "user": "confirm", "group": "auto", "session": "auto" },
  "retentionDays": { "group": 30, "session": 30 }
}
```

设置页的对话记忆开关立即提交并显示服务器生效状态，失败回退并在开关附近说明原因；其他配置显式保存。启用必须选择可用 embedding 和检索 LLM；任一写入模式不为 off 时还需抽取 LLM。保存模型 ID 和每次调用都校验启用、类型、用户授权。保留天数为 1–3650；长期默认 expiresAt=null，分组 / Session 清理由最近活动和此设置控制。启用 / 停用的是本用户聊天召回与自动抽取，显式管理、搜索、提取和重建 API 仍可使用。

策略 info 含 id、name、description、version、configVersion、capabilities、settingsKey、defaultConfig。新增策略必须配套设置 UI；HTTP 不装载 React，不提供在线新增策略接口。未知策略读取为 404，preferences 选择未注册策略为 400。策略 config 序列化长度最多 64000 字符；版本冲突为 409，不覆盖草稿。default 的 scopeLimits 支持局部合并，其他自定义策略的嵌套合并由其配置设计决定。

### 默认策略配置

| 字段                | 默认   | 有效范围 / 单位                                                                |
| ------------------- | ------ | ------------------------------------------------------------------------------ |
| candidateLimit      | 36     | 1–120 条                                                                       |
| similarityThreshold | 0.3    | -1–1，精确余弦相似度门槛                                                       |
| recentDays          | 30     | 1–3650 天，召回近期偏好，不删除更早长期记忆                                    |
| maxItems            | 12     | 1–32 条，最终注入上限                                                          |
| maxBytes            | 6000   | 500–32000 UTF-8 字节，包含记忆块标记                                           |
| scopeLimits         | 每类 4 | user / group / session 分别 0–32 条                                            |
| timeoutMs           | 15000  | 1000–120000 ms，准备总时限                                                     |
| fallback            | vector | `vector` LLM 失败使用既有向量候选，或 `skip` 跳过                              |
| recallPrompt        | 内置   | 20–20000 字符，必须含 `{{context}}` 和 `{{candidates}}`；另支持 `{{maxItems}}` |
| extractPrompt       | 内置   | 20–20000 字符，必须含 `{{context}}`                                            |

配置以 [`config.ts`](../src/features/memory/config.ts) 为准。Manager 对自定义策略 budgets 同样施加上述范围上限。LLM 返回选中的候选 ID / 理由，正文由 Manager 读取原记录；状态、版本、作用域、Session 排除和预算会再次校验。

## 记忆 CRUD

| 方法与路径             | 输入 / 返回                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /memories`        | 可选 query（最多 200 字符）、scope、scopeId、status（active / review）；按置顶、更新时间排序，最多 200 项，无分页 cursor |
| `POST /memories`       | MemoryInput，额外可选 sources（最多 20）和 idempotencyKey；201 返回保存后的 MemoryItem                                   |
| `GET /memories/:id`    | 当前用户指定活动 / 待复核记忆；删除或跨用户为 404                                                                        |
| `PATCH /memories/:id`  | 必须 version；可改 content、kind、tags、pinned、expiresAt；返回新版本，不能迁移 scope / scopeId                          |
| `DELETE /memories/:id` | `{ ok: true }`，再次删除返回 404                                                                                         |

MemoryInput 的 scope / kind / content 必填。scopeId 默认 null；正文 trim 后 1–8000 字符。tags 默认 []，最多 20 个、每个 trim 后 1–40 字符；pinned 默认 false；expiresAt 为带时区 ISO 时间或 null，默认 null。创建和编辑拒绝常见密码、Token、私钥等凭证形态；检测是有限模式检查，不是通用敏感信息识别。

```json
{
  "scope": "user",
  "scopeId": null,
  "kind": "preference",
  "content": "默认使用中文回复。",
  "tags": ["语言"],
  "pinned": true,
  "expiresAt": null,
  "sources": [],
  "idempotencyKey": "settings-save-20261006-1"
}
```

手动 CRUD 是经过当前用户认证的显式写入，创建 / 编辑会视为已确认；策略工具没有直接 CRUD 权限。正文去重限定在 namespace + owner + scope + scopeId + kind，使用 NFKC、连续空白折叠后的哈希；重复活记录返回已有 ID，删除墓碑阻止同一归一化内容重新保存（409）。尚无语义去重或冲突自动替代。

编辑要求正整数 version，相同版本更新后 version+1，保留旧版本并清除旧向量，重新建立索引。编辑 review 记忆视为用户重新确认，恢复 active 并解绑失效旧来源；正常 active 记忆编辑保留有效来源。正文保存成功不代表索引成功，可通过 indexStatus / operations 查询。删除清空正文与标签、移除向量 / 来源 / 版本 / 选择 / 已关联候选，清理 context 记忆副本，保留去重墓碑和非正文操作记录；原聊天消息不因此删除。

### 幂等

idempotencyKey 在 JSON body 中，为 1–128 字符，可用于 memories 创建、extract、indexes/rebuild。键按 namespace + owner + 操作类型隔离。同一键不同输入为 409；成功写入重放返回原记忆，进行中或失败的同键写入返回 409。抽取 / 重建重放返回已有 operation，不再启动第二次任务；配置版本或模型指纹变化后要使用新键。

正文精确去重与操作幂等不同：不提供 key 仍会按正文去重，但来源 / 配置 / 索引操作状态不等同于同一请求。修改记忆使用 version，不使用幂等键。

## 搜索与本轮准备

| 方法与路径           | 输入 / 返回                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /search`       | `{ query, conversationId?, limit? }`；query trim 后 1–8000 字符，limit 1–120 且不超过策略 candidateLimit；返回 MemoryItem[] |
| `POST /prepare-turn` | `{ conversationId, messageId?, current? }`；返回 MemoryPreparation                                                          |

search 调用 embedding 与 pgvector，不调用选择 LLM。省略 conversationId 只查长期记忆；指定本人对话后增加当前分组和当前 Session，并应用 Session 排除项。只搜索 active、未过期、正文版本与当前空间一致的向量；不会把 review 或未索引记录当成可注入记忆。近期偏好、置顶和相关性用于排序。

prepare-turn 使用当前策略的 LLM 选择、再次校验与最终预算。conversationId 必填；current 可选，trim 后 1–8000 字符，省略使用已保存的最后用户消息，没有用户消息时为 400。messageId 是本次准备标识，省略由服务器生成；同标识再次执行返回业务 status=error，不重放已准备的块。因此 HTTP 调用用于显式准备 / 调试，普通聊天由 Chat 核心自动接入，不需要浏览器重复调用。

```ts
interface MemoryPreparation {
  operationId: string | null;
  strategyId: string;
  strategyVersion: string;
  /** 当前用户已保存的配置版本，与策略结构 configVersion 分开。 */
  configVersion?: number;
  status: 'skipped' | 'ready' | 'degraded' | 'error';
  blocks: {
    memoryId: string;
    version: number;
    scope: 'user' | 'group' | 'session';
    content: string;
    reason: string;
  }[];
  durationMs: number;
  error: string | null;
  omittedIds: string[];
  timings?: {
    embeddingMs: number;
    searchMs: number;
    selectionMs: number;
    validationMs: number;
  };
}
```

skipped 表示个人未启用或未配置数据库，ready 表示准备完成，degraded 表示 LLM 选择失败后按配置处理，error 表示召回失败。omittedIds 为因条数、字节或作用域额度未注入的选择项。timings 为准备阶段测量，嵌套 Agent 调用计入策略选择阶段，分阶段之和不含全部框架开销。HTTP 准备得到结果只标为 prepared；只有 Chat 真正发送模型请求后才标为 applied。Context Manager 根据实际请求及 offsets 显示长期 / 分组 / Session，不能仅凭准备结果宣称已发送。

## 抽取与候选

| 方法与路径                     | 输入 / 返回                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /extract`                | `{ conversationId, messageId?, idempotencyKey? }`；messageId 为本人已完成的助手消息，省略使用最近已完成问答；202 返回 MemoryOperation |
| `GET /proposals`               | state 默认 pending，可选 all / approved / rejected / invalidated；可按 conversationId、messageId 过滤，最多 200 项                    |
| `POST /proposals`              | MemoryInput + sources（1–20 条已保存来源）；201 返回 MemoryProposal                                                                   |
| `POST /proposals/:id/decision` | `{ decision: "approve" \| "reject" }`；返回 `{ proposal, memory }`，拒绝时 memory=null                                                |

抽取读取已保存的问答，不接受模型提供的任意聊天正文或批准标志。错误 / 停止 / 正在生成的助手消息不能作为已完成轮次；来源变化为 409。default 草稿需要本轮用户原文 evidence，最多 12 项，各作用域分别按 off / confirm / auto 处理。默认长期产生待确认候选，分组与 Session 自动保存有来源的记忆；助手推测不能升级为用户事实。抽取的输入截取本轮用户 / 助手各最多 12000 字符及近期少量历史，不代表全量长对话分析。

MemoryProposal 返回 id、scope、scopeId、kind、content、sources、state、createdAt、expiresAt、可选 memoryId。state 为 pending / approved / rejected / invalidated。候选确认再检查范围、来源哈希、到期、凭证和墓碑，在事务内决策；若正文已存在可关联既有记录；同一候选重复批准 / 拒绝均返回 409，不能在拒绝后变为批准。确认是用户交互接口，不能注册为模型自我批准工具。外部 Agent 应提出 proposals，显式用户授权的 CRUD 才可直接保存。

提取结果在 operation.facts 中返回 proposalIds、savedIds、discarded，不属于本轮已发送上下文。编辑末问 / 重试取消相关提取，旧候选失效；来源关联记忆进入 review 后不再召回，可通过版本化编辑复核。原始聊天不会被压缩或修改。

## 范围状态与优先 / 排除

| 方法与路径                  | 输入 / 返回                                            |
| --------------------------- | ------------------------------------------------------ |
| `GET /sessions/:id/state`   | MemoryScopeState，本人 conversation                    |
| `PATCH /sessions/:id/state` | `{ revision, summary?, selections? }`，返回新 revision |
| `GET /groups/:id/state`     | MemoryScopeState，本人 group                           |
| `PATCH /groups/:id/state`   | `{ revision, summary? }`，group 不支持非空 selections  |

MemoryScopeState 为 `{ summary, revision, selections, updatedAt }`，新范围 revision=0。summary 最多 8000 字符，是作用域管理状态，不会自动转成一条记忆或隐式注入 Prompt；需要注入的信息应保存为范围记忆。selections 为 `{ "memory UUID": "prefer" | "exclude" | null }`，null 清除已有选择；仅允许当前 Session 可见的长期 / 当前分组 / 本 Session 记忆。输入按项合并，revision 冲突返回 409；优先不能绕过有效性和预算，排除在最终注入前再次校验。

## 向量索引

`GET /status` 的 spaces 项为 `{ id, modelId, dimensions, fingerprint, state, createdAt, indexed, total }`。state 为 building / active / retired；fingerprint 来自模型、来源、协议、配置维度和向量版本，不含 API Key。相同维度但不同模型 / 来源也属于不同空间。

`POST /indexes/rebuild` body 为 `{ idempotencyKey? }`，202 返回 MemoryOperation。使用当前 embedding 模型验证维度、逐条生成缺失 / 过期正文版本的向量、记录进度，完成且配置未改变后切换 active。修改模型或维度需显式重建，失败继续保留正文和旧空间；查询时按当前配置隔离空间，不把旧空间向量混入新模型查询。每用户同时一个索引任务，重建最长 30 分钟；过程中同用户索引活动冲突可返回 409。

检索使用 pgvector 精确余弦，没有 HNSW / Redis。默认模型配置维度可空，实际维度来自 Embedding 服务，非有限数、零向量、数量 / index / 维度不一致均拒绝。新正文或编辑可触发后台索引；失败通过操作记录查看并重建 / 重试，不需要重新保存正文。

## 操作与取消 / 重试

| 方法与路径                    | 输入 / 返回                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /operations`             | 可选 conversationId / messageId，最近 200 项 MemoryOperation[]                               |
| `GET /operations/:id`         | 当前用户指定 operation                                                                       |
| `POST /operations/:id/cancel` | JSON body 可为空对象，返回当前 operation；活动任务被取消，已准备 / 已发送 / 终结状态不被改写 |
| `POST /operations/:id/retry`  | 仅 error / cancelled 的 extract / rebuild，202 返回新 operation；其他类型为 400              |

MemoryOperation 为 `{ id, type, state, createdAt, finishedAt, error, facts }`。类型包含 write、index、recall、extract、rebuild。状态：running 执行中，prepared 已准备但未发送，applied 已由 Chat 发送，complete 完成，error 失败，cancelled 取消。facts 包含策略 / 配置版本、作用域 / 消息关联、ID 和进度计数，不保存模型凭据。尚未终结的 finishedAt=null。

取消按 owner 校验，只中止该辅助操作；不会停止回答模型或删除已保存记忆。抽取 / 索引不是跨重启持久任务队列：重启把 running / prepared 标为 error，需手动 retry 或重新提交。自动抽取绑定服务器生命周期，浏览器离开只清理聊天订阅；关闭 context 抽屉同样不会停止原聊天。

## 浏览器调用示例

同源页面可复用项目 [`client/api.ts`](../src/client/api.ts)；以下展示标准 fetch 语义，不需要读取 HttpOnly Cookie：

```ts
const response = await fetch('/api/memory/v1/memories', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    scope: 'user',
    kind: 'preference',
    content: '默认使用中文回复。',
    idempotencyKey: 'settings-save-20261006-1',
  }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
```

异步操作在轮询中检查 state / error；原会话过期时重新登录，不能继续使用已失效身份。API 不提供用户清空、上传任意策略、跨用户审计查询、自动语义冲突合并或原平台记忆迁移接口。
