import { skillProviderFixture } from './skill-provider-fixture';
import express from 'express';
import { createServer } from 'node:http';
export const imageData =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=';
export const markdownFixture =
  '# 你好，世界\n\n这是 **Markdown** 测试。\n\n| 项目 | 结果 |\n| --- | --- |\n| 流式回复 | 正常 |\n\n```javascript\nconst answer = 42;\n```\n\n公式：$E = mc^2$\n\n```mermaid\ngraph LR\n  A[用户] --> B[KH-Kernel]\n  B --> C[模型]\n```\n\n<script>window.hacked = true</script>\n';
export const latexFixture =
  '\n```latex\n' +
  String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
The Fibonacci sequence:
\[F_n=F_{n-1}+F_{n-2}\]
\end{document}` +
  '\n```\n';
function extensionText(content: unknown): string | undefined {
  if (typeof content !== 'string') return;
  if (content.startsWith('Compress conversation history'))
    return '用户正在完善 Drift Space 的记忆与上下文管理；保留原聊天，按阈值压缩历史，下一步核对设置及实际请求。';
  if (content.startsWith('Summarize one completed conversation turn'))
    return content.includes('[bad-trajectory-json]')
      ? 'not JSON'
      : JSON.stringify({
          title: '完善记忆与上下文管理',
          intent: '希望整理设置并保持对话连续性',
          answerSummary: '助手说明了记忆召回、历史压缩和后续验证步骤，结论需核对原文。',
        });
  if (content.startsWith('Select useful saved memories')) {
    const candidates = JSON.parse(content.slice(content.indexOf('Candidates: ') + 12)) as {
      id: string;
    }[];
    return JSON.stringify({
      selected: candidates.map(({ id }) => ({ id, reason: '本地夹具匹配' })),
    });
  }
  if (content.startsWith('Extract durable user memories')) return JSON.stringify({ memories: [] });
  if (content.startsWith('Create a hand-off prompt'))
    return '# Hand-off\n\n## 用户意图轨迹\n用户希望整理项目交接资料。\n\n## 目前进度\n已检查对话中提供的资料；尚未验证的内容需继续确认。\n\n## 后续方向\n继续核对需求并完成剩余工作。\n\n## 相关文档资料\n以交接证据中实际提供的文档路径和链接为准。';
  if (content.startsWith('Write a short introduction for this prompt-library card'))
    return content.includes('[empty-description]')
      ? '   '
      : '帮你梳理写作思路、润色表达，适合整理初稿和日常写作。';
  if (content.startsWith('Decide whether to enable'))
    return content.includes('[bad-json]')
      ? '{"enabled":"true"}'
      : JSON.stringify({ enabled: !content.includes('[skip-search]') });
  if (content.startsWith('Summarize the latest user request'))
    return JSON.stringify({
      state: content.includes('[skip-search]')
        ? 'The user says hello.'
        : 'The user requests current news and supporting sources.',
    });
  if (content.startsWith('Generate 1 to')) {
    if (content.includes('[bad-json]')) return 'not JSON';
    const queries = content.includes('[search-slow]')
      ? ['slow']
      : content.includes('[search-error]')
        ? ['upstream-error']
        : content.includes('[search-empty]')
          ? ['empty']
          : content.includes('[search-partial-error]')
            ? ['Drift documentation', 'upstream-error']
            : ['Drift documentation', 'Drift sources'];
    return JSON.stringify({ queries });
  }
  if (content.includes('Web search evidence follows'))
    return '根据检索结果，Drift 支持拓展能力。[1](https://example.test/docs)';
  if (content.includes('Web search returned no usable sources'))
    return '未找到可用的支持来源，无法核实。';
}
export async function mockProvider(portNumber = 0) {
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  const requests: unknown[] = [];
  const searches: { query: string; max_results: number }[] = [];
  const decisions: unknown[] = [];
  app.post('/v1/embeddings', (req, res) => {
    requests.push(req.body);
    const inputs = Array.isArray(req.body.input) ? req.body.input : [req.body.input];
    const dimensions = req.body.dimensions ?? 3;
    res.json({
      data: inputs.map((_input: string, index: number) => ({
        index,
        embedding: [1, ...Array(dimensions - 1).fill(0)],
      })),
      usage: { prompt_tokens: inputs.length * 3, total_tokens: inputs.length * 3 },
    });
  });
  app.get('/jev/models', (_req, res) =>
    res.json({
      models: [{ name: 'jev-latest', description: 'Decision model', release_date: '2026-09-01' }],
    }),
  );
  app.post('/jev/systemone', (req, res) => {
    decisions.push(req.body);
    if (req.body.model === 'jev-error') {
      res
        .status(401)
        .json({ error: { message: 'Invalid API key', api_key: req.headers.authorization } });
      return;
    }
    const respond = () =>
      res.json({
        model: req.body.model,
        answers: {
          enabled: {
            type: 'choice',
            choice:
              req.body.model === 'jev-invalid'
                ? 'invalid'
                : String(req.body.state).includes('hello')
                  ? 'off'
                  : 'on',
            probabilities: { on: 0.9, off: 0.1 },
            confidence: 0.9,
          },
        },
        ...(req.body.model === 'jev-no-usage'
          ? {}
          : { usage: { input_tokens: 17, output_tokens: 3 } }),
      });
    if (req.body.model === 'jev-slow') {
      const timer = setTimeout(respond, 1000);
      res.on('close', () => clearTimeout(timer));
    } else respond();
  });
  app.post('/search', (req, res) => {
    searches.push(req.body);
    if (req.body.query === 'upstream-error') {
      res.status(429).json({ error: 'private upstream error' });
      return;
    }
    const respond = () =>
      res.json({
        results:
          req.body.query === 'empty'
            ? []
            : [
                {
                  title: 'Drift documentation',
                  url: 'https://example.test/docs',
                  snippet: 'Drift supports extensions.',
                  date: '2026-09-01',
                },
                {
                  title: 'Repeated URL',
                  url: 'https://example.test/docs#section',
                  snippet: 'Duplicate.',
                },
                { title: 'Unsafe', url: 'javascript:alert(1)', snippet: 'Not a source.' },
                {
                  title: 'More information',
                  url: 'https://example.test/source',
                  snippet: 'Additional evidence. <script>not executed</script>',
                },
              ],
        id: 'mock-search',
      });
    if (req.body.query === 'slow') {
      const timer = setTimeout(respond, 1000);
      res.on('close', () => clearTimeout(timer));
    } else respond();
  });
  const anthropicHeaders: Record<string, string | string[] | undefined>[] = [];
  app.get('/v1/models', (req, res) => {
    if (req.headers['x-api-key']) {
      anthropicHeaders.push(req.headers);
      res.json(
        req.query.after_id
          ? { data: [{ id: 'test-text' }], has_more: false, last_id: 'test-text' }
          : { data: [{ id: 'test-vision' }], has_more: true, last_id: 'test-vision' },
      );
      return;
    }
    res.json({
      data: [
        { id: 'test-vision' },
        { id: 'test-text' },
        { id: 'slow' },
        { id: 'no-usage' },
        { id: 'broken' },
        { id: 'upstream-error' },
      ],
    });
  });
  app.post('/v1/chat/completions', (req, res) => {
    requests.push(req.body);
    if (skillProviderFixture(req.body, 'chat-completions', res)) return;
    if (req.body.model === 'upstream-error') {
      res.status(401).json({ error: { message: 'sensitive upstream details' } });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const content = req.body.messages.at(-1)?.content;
    const text = Array.isArray(content)
      ? '我收到了一张图片。\n\n' + markdownFixture
      : markdownFixture;
    const richText = extensionText(content) ?? text + latexFixture;
    const slow = req.body.model === 'slow';
    const parts = slow
      ? Array(50).fill('慢速回复 ')
      : [richText.slice(0, 5), richText.slice(5, 30), richText.slice(30)];
    let index = 0;
    const timer = setInterval(
      () => {
        if (index < parts.length) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: parts[index++] } }] })}\r\n\r\n`,
          );
          return;
        }
        clearInterval(timer);
        if (req.body.model === 'broken') {
          res.end();
          return;
        }
        if (req.body.model !== 'no-usage')
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 23, completion_tokens: 42, total_tokens: 65 } })}\n\n`,
          );
        res.end('data: [DONE]\n\n');
      },
      slow ? 80 : 8,
    );
    res.on('close', () => clearInterval(timer));
  });
  app.post('/v1/responses', (req, res) => {
    requests.push(req.body);
    if (skillProviderFixture(req.body, 'responses', res)) return;
    if (req.body.model === 'upstream-error') {
      res.status(401).json({ error: { message: 'sensitive upstream details' } });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const content = req.body.input.at(-1)?.content;
    const text = Array.isArray(content)
      ? '我收到了一张图片。\n\n' + markdownFixture
      : markdownFixture;
    const richText = extensionText(content) ?? text + latexFixture;
    const slow = req.body.model === 'slow';
    const parts = slow
      ? Array(50).fill('慢速回复 ')
      : [richText.slice(0, 5), richText.slice(5, 30), richText.slice(30)];
    const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
    emit({ type: 'response.created', response: { id: 'mock-response' } });
    let index = 0;
    const timer = setInterval(
      () => {
        if (index < parts.length) {
          emit({ type: 'response.output_text.delta', delta: parts[index++] });
          return;
        }
        clearInterval(timer);
        if (req.body.model === 'broken') {
          res.end();
          return;
        }
        const type =
          req.body.model === 'incomplete'
            ? 'response.incomplete'
            : req.body.model === 'failed'
              ? 'response.failed'
              : 'response.completed';
        emit({
          type,
          response: {
            usage:
              req.body.model === 'no-usage'
                ? undefined
                : { input_tokens: 23, output_tokens: 42, total_tokens: 65 },
          },
        });
        res.end();
      },
      slow ? 80 : 8,
    );
    res.on('close', () => clearInterval(timer));
  });
  app.post('/v1/messages', (req, res) => {
    requests.push(req.body);
    if (skillProviderFixture(req.body, 'anthropic-messages', res)) return;
    anthropicHeaders.push(req.headers);
    if (req.body.model === 'upstream-error') {
      res.status(401).json({ error: { message: 'sensitive upstream details' } });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const emit = (event: Record<string, unknown>) =>
      res.write(`event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`);
    const missing = req.body.model === 'no-usage';
    const zero = req.body.model === 'zero-usage';
    emit({
      type: 'message_start',
      message: {
        usage: missing
          ? undefined
          : {
              input_tokens: req.body.model === 'invalid-usage' ? -1 : zero ? 0 : 3,
              cache_creation_input_tokens: zero ? 0 : 13,
              cache_read_input_tokens: zero ? 0 : 7,
              output_tokens: zero ? 0 : 1,
            },
      },
    });
    emit({ type: 'ping' });
    emit({ type: 'future_event', payload: 'ignore' });
    emit({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'not answer text' },
    });
    emit({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    const slow = req.body.model === 'slow';
    const hasImage = req.body.messages
      .at(-1)
      ?.content.some((block: { type: string }) => block.type === 'image');
    const promptText = req.body.messages
      .at(-1)
      ?.content.filter((block: { type: string }) => block.type === 'text')
      .map((block: { text: string }) => block.text)
      .join('');
    const text =
      extensionText(promptText) ?? (hasImage ? '我收到了一张图片。\n\n' : '') + markdownFixture;
    const parts = slow ? Array(50).fill('慢速回复 ') : [text.slice(0, 6), text.slice(6)];
    let index = 0;
    const timer = setInterval(
      () => {
        if (index < parts.length) {
          emit({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: parts[index++] },
          });
          return;
        }
        clearInterval(timer);
        if (req.body.model === 'broken') {
          res.end();
          return;
        }
        if (req.body.model === 'stream-error') {
          emit({ type: 'error', error: { message: 'sensitive upstream details' } });
          res.end();
          return;
        }
        emit({ type: 'content_block_stop', index: 1 });
        emit({
          type: 'message_delta',
          usage: missing ? undefined : { output_tokens: zero ? 0 : 40 },
          delta: {},
        });
        emit({
          type: 'message_delta',
          usage: missing ? undefined : { output_tokens: zero ? 0 : 42 },
          delta: { stop_reason: req.body.model === 'incomplete' ? 'max_tokens' : 'end_turn' },
        });
        emit({ type: 'message_stop' });
        res.end();
      },
      slow ? 80 : 8,
    );
    res.on('close', () => clearInterval(timer));
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(portNumber, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    searches,
    decisions,
    anthropicHeaders,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
