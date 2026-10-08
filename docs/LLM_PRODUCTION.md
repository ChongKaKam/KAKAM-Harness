# LLM Production：产物空间

`llm-production` 是 `kind: 'core'` 的基础能力，提供模型生成文件、私有空间、下载和删除。管理员不能停用它；用户可在「设置 → 产物空间」关闭自己的生成工具，已有文件仍可管理。此页是该能力的主要契约。

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

| 工具                        | 当前支持                                                                         |
| --------------------------- | -------------------------------------------------------------------------------- |
| `production_create_file`    | UTF-8 文本、Markdown、JSON、CSV、HTML、SVG；固定生成器输出 PDF、DOCX、XLSX、PPTX |
| `production_generate_image` | 设置中选择的、当前仍授权的图片模型；接收供应商返回的 base64 图片                 |

文件参数为 `{ name, format, content }`。PDF / DOCX 接收正文段落；XLSX content 为序列化 JSON `{"sheets":[{"name":"Sheet1","rows":[["名称","数量"],["示例",12]]}]}`；PPTX 为 `{"slides":[{"title":"标题","body":["第一项","第二项"]}]}`。数量与输入限制以 `generators.ts` 为准。文件名只用于展示和下载，不成为宿主路径。

当前只提供基础文档排版，未实现任意模板、宏、复杂 Office 布局、脚本沙箱、依赖安装和网页执行；HTML / SVG 仅下载，不在聊天中执行。PDF 嵌入随依赖提供的 Noto Sans SC 字体，支持常用中文和拉丁字符；字体未覆盖的字符会明确拒绝，可改用 DOCX 或文本。Excel 单元格仅支持字符串、数字、布尔值和空值，公式文本按普通文字保存。

图片模型为模型级 `kind: 'image'`，不进入聊天选择器 / 默认 LLM。管理员通过 OpenAI 兼容来源添加并授权，用户在产物设置选择。`ModelsService.generateImage(user, modelId, prompt, signal)` 逐调用授权，Adapter 使用来源 `/images/generations`；Anthropic / Jev 来源不支持图片模型。校验真实图片格式、大小，只接受 base64，不拉取上游图片 URL，不自动重试付费请求。暂不提供图片编辑。文字连通性测试不用于图片模型，实际生成验证图片接口。

图片 usage 逐字段记录，缺失值保留 NULL；独立计入统计，不混入回答 LLM 的文本 Token 合计。

## 接入与任务

`ctx.production` 提供存储、设置和空间生命周期。工具在 `ctx.effect` 中通过 `ctx.extensions.registerConversationTools(provider)` 注册；provider 提供 `id`、`instructions`、`tools(user)`、异步 `execute(scope, call)`。scope 的 user、conversationId、messageId、requestId、signal 均由服务器绑定，模型不能指定 owner 或目标空间。执行前重新检查注册与用户设置，卸载可撤销并取消执行。

先校验 / 渲染，再同步保存文件。工具返回真实 artifact ID、名称、类型、大小和下载地址，字节不回传回答模型。每次回复最多执行 16 次工具调用，与 Skill 文档读取共用次数预算；超过时停止本轮，保留已生成文件。助手消息 ID、模型调用 ID、工具调用 ID 共同构成幂等标识；重复聊天提交不重新调用模型。

SSE 新增 `{ type: 'artifacts', messageId, artifacts }`，浏览器替换本轮列表；历史、done、重连 snapshot 都包含实际保存且未过期的文件。关闭抽屉、页面切换、订阅断线不停止生成；主动停止使用原停止 API / AbortSignal，已完整保存的文件保留。重启保留文件和消息，但不续跑任务。

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
| `DELETE /llm-production/artifacts/:id`       | 删除本人文件，`{ ok: true }`                                        |

生成仅通过已注册聊天工具发生，管理页面不隐式调用模型；没有匿名公共文件 URL。界面契约见 [UI 指南](UI_GUIDE.md#产物空间)，验证位置见 [开发指南](DEVELOPMENT.md)。
