# LLM Production：产物空间

`llm-production` 是 `kind: 'core'` 的基础能力，提供模型生成文件、私有空间、Web 预览、下载和删除。管理员不能停用它；用户可在「设置 → 产物空间」关闭自己的生成工具，已有文件仍可管理。此页是该能力的主要契约。

## 空间与保留时间

- 未分组聊天视为临时聊天，各有独立产物空间；文件从生成时起保留 3–7 天，默认 7 天。查看、下载和继续聊天不会延长时间。
- 同一账户、同一分组的聊天共享空间，默认不过期。管理员不能读取其他用户的文件。
- 聊天加入分组时，其未过期临时产物进入分组并取消过期时间；移出或更换分组时，已共享文件留在原分组，之后生成的文件使用当前空间。
- 删除未分组聊天会删除其独立产物；删除来源聊天保留分组共享文件。编辑 / 重试回复保留旧产物，新请求不会覆盖旧文件。
- 删除分组保留文件：来源聊天已在其他分组的文件进入该分组，其余回到来源聊天或「已删除对话的产物」，从释放时重新开始临时保留期。
- 修改保留天数按固定的临时起算时间重算现有临时文件，缩短可能立即清理到期文件；分组文件不受影响。
- 启动及每小时清理过期记录，查询列表触发清理，下载立即拒绝过期文件。删除释放 SQLite 页供后续写入复用，不承诺数据库文件立即缩小。

文件内容以有上限的 BLOB 保存到现有 SQLite；元数据记录 owner、来源聊天 / 消息、空间、名称、MIME、大小、哈希与幂等标识。单文件 20 MiB、每账户 200 MiB。完整 SQLite / 数据目录备份包含产物，不增加公开静态目录。迁移集中在 `kernel/database.ts`。

## 生成工具与范围

回答模型必须由管理员开启「支持工具调用」。工具经 extensions 注册，与 `skills_read` 合并，复用 Chat Completions / Responses / Anthropic Messages 工具循环。普通模型仍可聊天；Skill 文档不能自行授予工具或脚本权限。

### 触发与交付校验

产物是用户请求交付的文件或图片，与文件内容的业务题材无关。当前聊天模型结合用户要求与对话上下文，选择合适的工具、格式、文件名和内容；请求产物时必须用工具保存真实文件，不能只交付文字或代码块。没有「计算器」等业务专用触发分支。网页只是文件产物的一种，未明确格式时由模型选择合适的受支持格式；用户明确指定 HTML / PDF 等格式时应遵从。仅讨论实现、解释机制、引用请求或索要代码示例，不等于请求文件。

聊天[加号菜单](UI_GUIDE.md#聊天输入)提供两种「产物输出」模式，默认选项和说明收在菜单中；选择「必须产物」后输入栏显示状态标签。聊天提交参数为 `productionMode: 'auto' | 'required'`，省略为 auto。用户消息与助手消息保存该模式，编辑和重试沿用原提问的模式；账户和聊天的输入选项隔离。

- **自动**：主模型结合上下文决定是否生成。单个文件或图片可以直接调用工具；多个文件、多张图片、混合交付或有依赖步骤的任务先声明结构化交付计划。普通聊天不增加计划请求或辅助模型调用。
- **必须产物**：框架先仅提供计划工具（可同时读取已授权 Skill），要求主模型先声明完整清单；需求不足时可以提出澄清问题。计划未声明，或已声明的文件未全部保存，均不能将本轮标记为成功。切换到不支持工具调用的模型时提示并禁止提交此模式。

服务端仍用当前用户原始提问保守识别中英文直白创建命令，作为 Auto 的强制交付兜底，例如「帮我生成一个图片」「帮我写一个网页」「生成一个 PDF 文件」。图片检查真实 PNG / JPEG / WebP，一般文件检查实际保存，明确格式按 MIME 校验。该兜底不是完整的语义分类器；间接请求仍依赖主模型主动选工具或声明计划。Auto 未声明计划时仅校验首个被识别的要求，不能保证复杂请求的类型与数量。需要稳定检查整份交付清单时使用「必须产物」。

接受任务前，extensions 调用产物 provider 的 `requirement(user, request, requireDelivery)`：强制交付的生成开关、回答模型工具能力，以及原始提问明确请求图片时的配置和授权，均预检，失败返回 400，不先发送付费模型请求。只有模型计划才识别出的图片项，在声明计划时验证图片模型；执行时继续校验当前设置与授权。保留已有 requestId 的幂等返回。

尚有交付要求时，Chat Completions / Responses 发 `tool_choice: 'required'`；允许先读取 Skill，计划声明且全部项目完成后恢复自动工具选择。Anthropic 保留自动选择并加入明确交付指令，避免对不支持强制工具调用的模型发送无效参数；见 [Anthropic 工具选择限制](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use) 与 [OpenAI 工具选择](https://developers.openai.com/api/docs/guides/function-calling#tool-choice)。模型的拒绝或忽略工具不能由框架伪造成功。

有强制交付要求时，模型结束前必须检查本轮助手消息实际保存的产物。只有文字、提示词、代码块、假下载链接，或文件格式不符，均不能满足该要求：本轮状态记为失败并保留已收到文本、真实用量和已保存文件。付费图片调用失败后立即结束本轮并持久化安全失败原因，不自动重复生图；已完成计划项的重复调用返回已保存文件。不会将任意回复代码块自动转换为文件，也不会跳过授权直接调用生图。

### 结构化交付计划

`production_plan` 接收 `{ decision, items, question }`：

```json
{
  "decision": "deliver",
  "items": [
    { "kind": "file", "format": "html", "name": "计算器.html", "brief": "网页计算器" },
    { "kind": "image", "format": null, "name": "插画.png", "brief": "配套插画" }
  ],
  "question": null
}
```

每项表示一个独立文件，上限 12 项；多张图片逐张列出。文件格式可以为 null，由主模型在生成时选择；图片格式必须为 null，按供应商返回的真实格式保存。服务器生成稳定 UUID，模型随后把该 `itemId` 传给对应生成工具。owner、消息和目标空间由服务器绑定，模型不能传入或覆盖。计划在本轮锁定，完全相同的重复声明返回原计划；不能缩减、换项或在直接生成之后补计划来重新标记旧文件。

每个计划项绑定一个实际产物，并校验本人、本轮消息、itemId、file / image 类型与明确格式。不同项目不能用一个文件充数；下载链接和代码块不计数。已删除或过期的文件重新呈现为未完成。`productionDelivery` 保存 / 返回 `decision`、`items` 和可选 `question`；每项包含 id、kind、format、name、brief、pending / complete / failed 状态，以及完成后的 artifactId 或安全 error。状态由实际未过期文件推导，图片失败状态持久化。

需求必须澄清时声明 `{ "decision": "clarify", "items": [], "question": "需要哪些格式和内容？" }`。它是合法的本轮完成结果，UI 展示问题，当前轮次不生成文件；补充需求在下一轮提交。计划的内容与是否需要澄清由主模型判断，框架检查结构和实际交付，不声称自动证明计划完整理解了原需求或文件内容质量。

### 意图判断与搜索扩展的区别

当前产物生成没有额外辅助分类调用。Search 的 Auto 是回答前的资料准备：extensions 先调用配置的辅助 LLM（也可沿用当前聊天模型）或 LLM + Jev 判断是否检索，再生成搜索词、获取证据并追加到回答上下文。产物则是回答过程中的工具执行和结果交付，不能因二者都涉及意图判断就直接复用搜索预处理链路。

默认设计是主聊天模型理解产物需求并选择工具，服务器负责可用性、授权、参数、保存、下载和完成校验。辅助小模型不是必需前提，也不能代替文件交付；新增它会增加一次模型调用和独立的误判路径。

结构化计划在同一主模型工具循环中声明，不单独增加分类模型。Auto 仍不能保证模型一定调用工具；「必须产物」把计划声明变成完成条件。未来若引入辅助决策，仍须经 extensions 托管、逐调用授权并记录真实用量，不能另设未受控凭据。

| 工具                        | 当前支持                                                                         |
| --------------------------- | -------------------------------------------------------------------------------- |
| `production_plan`           | 声明完整交付清单并获取服务器项目 ID，或提出必要的澄清问题                        |
| `production_create_file`    | UTF-8 文本、Markdown、JSON、CSV、HTML、SVG；固定生成器输出 PDF、DOCX、XLSX、PPTX |
| `production_generate_image` | 设置中选择的、当前仍授权的图片模型；接收供应商返回的 base64 图片                 |

文件参数为 `{ itemId, name, format, content }`，图片参数为 `{ itemId, name, prompt }`；未规划的 Auto 单产物用 itemId=null，旧调用省略也兼容。PDF / DOCX 接收正文段落；XLSX content 为序列化 JSON `{"sheets":[{"name":"Sheet1","rows":[["名称","数量"],["示例",12]]}]}`；PPTX 为 `{"slides":[{"title":"标题","body":["第一项","第二项"]}]}`。数量与输入限制以 `generators.ts` 为准。文件名只用于展示和下载，不成为宿主路径。

当前只提供基础文档排版，未实现任意模板、宏、复杂 Office 布局、脚本沙箱、依赖安装和网页执行；HTML / SVG 支持源码预览与下载，不在聊天中执行。PDF 嵌入随依赖提供的 Noto Sans SC 字体，支持常用中文和拉丁字符；字体未覆盖的字符会明确拒绝，可改用 DOCX 或文本。Excel 单元格仅支持字符串、数字、布尔值和空值，公式文本按普通文字保存。

图片模型为模型级 `kind: 'image'`，不进入聊天选择器 / 默认 LLM。管理员通过 OpenAI 兼容来源添加并授权，用户在产物设置选择。`ModelsService.generateImage(user, modelId, prompt, signal)` 逐调用授权，Adapter 使用来源 `/images/generations`；Anthropic / Jev 来源不支持图片模型。校验真实图片格式、大小，只接受 base64，不拉取上游图片 URL，不自动重试付费请求。暂不提供基于原图字节的编辑；继续生成的范围见下方 Web 预览说明。文字连通性测试不用于图片模型，实际生成验证图片接口。

图片 usage 逐字段记录，缺失值保留 NULL；独立计入统计，不混入回答 LLM 的文本 Token 合计。

## Web 预览

聊天里的 PNG / JPEG / WebP 产物直接展示缩略图，点击可放大查看；消息文件卡片、聊天产物抽屉和统一产物空间提供同一个预览窗口。预览保留名称、大小、到期说明与下载入口，不触发模型调用，也不延长临时文件保留时间。

Markdown 使用已有安全渲染管线；文本、JSON、CSV、HTML 和 SVG 展示纯文本 / 源码，正文最多展示 100,000 字符并明确提示截断，下载仍返回完整文件。HTML / SVG 不执行或加载外部资源。PDF、DOCX、XLSX、PPTX 等二进制文件当前提供下载提示，尚无页面 / Office 排版预览。

预览内容经独立私有 `/content` 接口读取：只有签名与 MIME 匹配的 PNG / JPEG / WebP 和 PDF 保留原类型；文本、JSON、XML、HTML、SVG 降为 `text/plain`，其他或伪装媒体使用 `application/octet-stream` 和 attachment。响应使用 private/no-store、nosniff 与限制主动内容的 CSP。客户端再次检查响应类型；关闭预览、切换账号或删除后取消读取并释放临时 object URL，防止旧响应进入新的界面。

用户可以在聊天中提出修改意见，再请求生成新版图片；当前图片工具仅接收文字提示，不传入已有产物的图像字节，因而不保证精准保留原图细节。这与基于参考原图的编辑不同；后者尚未接入，原图与再次生成的图片作为独立产物保留。

## 接入与任务

`ctx.production` 提供存储、设置、空间生命周期与消息交付计划。工具在 `ctx.effect` 中通过 `ctx.extensions.registerConversationTools(provider)` 注册；provider 提供 `id`、`instructions`、`tools(user, scope?)`、异步 `execute(scope, call)`，可选 `requirement(user, request, requireDelivery?)` 声明预检要求，`requirements(scope)` 返回当前动态要求。要求包含工具名、指令、安全失败消息、satisfied(scope) 与可选 stopOnFailure / maxRounds。`conversationTools(user, request, requireDelivery)` 返回 toolsFor(scope) 和 pending(scope)，每次模型请求重新选工具和逐项检查要求。extensions 保持通用契约，Chat 不硬编码产物工具名或直接依赖 provider 的意图规则。scope 的 user、conversationId、messageId、requestId、signal、requireDelivery 均由服务器绑定，模型不能指定 owner 或目标空间。执行前重新检查注册与用户设置，卸载可撤销并取消执行。

先校验 / 渲染，再同步保存文件。工具返回真实 artifact ID、项目 ID、名称、类型、大小和下载地址，字节不回传回答模型。每次回复最多执行 16 次工具调用，计划声明和 Skill 文档读取共用次数预算。默认最多 8 轮模型请求；交付计划申请最多 14 轮，以支持计划、12 项逐次生成和最终回复，通用框架把任何扩轮申请限制在 16 轮内。超限保留已生成文件。助手消息 ID、模型调用 ID、工具调用 ID 共同构成幂等标识；完成项目额外按项目 ID 去重，重复聊天提交不重新调用模型。

SSE 使用 `{ type: 'artifacts', messageId, artifacts, productionDelivery }`，浏览器替换本轮文件和交付状态；历史、done、重连 snapshot 包含 productionMode、交付清单及实际未过期文件。关闭抽屉、页面切换、订阅断线不停止生成；主动停止使用原停止 API / AbortSignal，已完整保存的文件保留。重启保留文件、计划和消息，但不续跑任务。

## 私有 API

所有路径加 `/api` 前缀且要求登录；资源查询、下载和删除同时限定资源与本人 ID。

| 方法与路径                                   | 契约                                                                |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `GET /llm-production/settings`               | `{ preferences, storage }`，包含实际存储用量、账户及单文件上限      |
| `GET /llm-production/preferences`            | `{ enabled, temporaryRetentionDays, imageModelId }`                 |
| `PATCH /llm-production/preferences`          | 至少一个同名字段；天数为整数 3–7；模型为本人可用 image ID 或 null   |
| `GET /llm-production/spaces`                 | 本人的聊天 / 分组空间与数量、大小                                   |
| `GET /llm-production/artifacts`              | 全部文件或单个 conversationId / groupId；`{ artifacts, space }`     |
| `GET /llm-production/artifacts/:id/download` | 原字节，attachment、private/no-store、nosniff；过期或非本人返回 404 |
| `GET /llm-production/artifacts/:id/content`  | 私有预览原字节；响应类型受控，过期、删除或非本人返回 404            |
| `DELETE /llm-production/artifacts/:id`       | 删除本人文件，`{ ok: true }`                                        |

生成仅通过已注册聊天工具发生，管理页面不隐式调用模型；没有匿名公共文件 URL。界面契约见 [UI 指南](UI_GUIDE.md#产物空间)，验证位置见 [开发指南](DEVELOPMENT.md)。
