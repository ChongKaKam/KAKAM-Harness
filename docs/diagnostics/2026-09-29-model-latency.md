# 模型端点延迟诊断 · 2026-09-29

针对用户报告的 Responses 响应较慢，使用用户授权的 `https://api.gpt.ge/v1`，对指定的 `gpt-6-sol` 与 `gpt-6-astra` 各发送一次 Responses 与 Chat Completions 请求。凭据只经进程标准输入传递，未写入文件、仓库或诊断输出。

## 条件与结果

从开发机器直接请求上游，绕过 Drift Space UI 和部署服务。统一提示 `Reply with only OK.`、Low 思考程度、流式输出，输出上限 1,024（含推理 Token），每次最多等待 90 秒。两个模型并发测试，同一模型的两个端点依次测试；Sol 先 Chat，Astra 先 Responses。Responses 使用 `store: false`；Chat 使用 `stream_options.include_usage: true`。共四次请求，全部 HTTP 200，均收到文本和正常结束事件。

| 请求模型    | 协议             | 响应头   | 首段文本 | 总耗时   | 输入 / 输出 Token（来源上报） |
| ----------- | ---------------- | -------- | -------- | -------- | ----------------------------- |
| gpt-6-sol   | Chat Completions | 11.563 s | 11.600 s | 11.601 s | 4,391 / 5                     |
| gpt-6-sol   | Responses        | 4.705 s  | 4.900 s  | 5.986 s  | 4,391 / 5                     |
| gpt-6-astra | Responses        | 2.842 s  | 3.078 s  | 3.154 s  | 4,125 / 5                     |
| gpt-6-astra | Chat Completions | 23.199 s | 24.026 s | 24.038 s | 11 / 5                        |

两次 Responses 均收到 `response.output_text.delta` 与 `response.completed`，上报 reasoning_tokens 为 0。四次短回复都只有一个非空文本片段，不能据此判断是否存在缓冲。来源上报 Sol 两次、Astra Responses 的缓存输入为 3,840；Astra Chat 未上报缓存数。

## 可以得出的结论

本轮没有复现 Responses 更慢，不能将用户的原始观察解释为 Responses 协议必然更慢。相反，较慢的两次 Chat 请求大部分耗时发生在响应头到达之前；这次直接上游测量的差异不经过前端 Markdown 渲染或应用的 SSE 转发。

相同的短提示下，Astra 两端点输入计量明显不同，说明来源的处理或计量口径需要进一步核实。额外上下文、内部模板、协议转换、路由、缓存或排队均属于可能原因，不能凭这些指标确定其中某一种，也未验证中转实际使用的模型身份。

每个组合只有一次样本，且测量来自开发机器、使用短提示与显式 Low；不代表远端服务器、长对话、图片或其他思考档位的表现。官方模型默认档位不保证被中转完整沿用。后续应在同一部署位置、相同内容与明确思考档位下采样，或向供应商核对两端点路由和计量差异。

## 本地实现验证

源码中两种协议都发送 `stream: true`，并在收到文本增量时立即转发。`tests/streaming-latency.test.ts` 刻意暂不发送终止事件，验证两种协议的首段文字都能先交付；同时验证碎片化 UTF-8 与 SSE 帧边界。该回归使用受控模拟流，不把真实供应商请求作为测试夹具。

管理员模型测试现在分开显示首段文本与总耗时，使用保存的来源和具体模型，支持显式选择思考程度。项目的 None 表示省略字段，可能采用上游默认思考，而非关闭推理。

依据：[OpenAI 流式输出文档](https://developers.openai.com/api/docs/guides/streaming-responses)、[OpenAI 思考参数文档](https://developers.openai.com/api/docs/guides/reasoning)。常规操作和限制见 [README](../../README.md#排查-responses-与-chat-completions-的速度差异)。
