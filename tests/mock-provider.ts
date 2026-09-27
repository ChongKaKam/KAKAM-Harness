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
export async function mockProvider(portNumber = 0) {
  const app = express();
  app.use(express.json({ limit: '30mb' }));
  const requests: unknown[] = [];
  app.get('/v1/models', (_req, res) =>
    res.json({
      data: [
        { id: 'test-vision' },
        { id: 'test-text' },
        { id: 'slow' },
        { id: 'no-usage' },
        { id: 'broken' },
        { id: 'upstream-error' },
      ],
    }),
  );
  app.post('/v1/chat/completions', (req, res) => {
    requests.push(req.body);
    if (req.body.model === 'upstream-error') {
      res.status(401).json({ error: { message: 'sensitive upstream details' } });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const content = req.body.messages.at(-1)?.content;
    const text = Array.isArray(content)
      ? '我收到了一张图片。\n\n' + markdownFixture
      : markdownFixture;
    const richText = text + latexFixture;
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
    if (req.body.model === 'upstream-error') {
      res.status(401).json({ error: { message: 'sensitive upstream details' } });
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const content = req.body.input.at(-1)?.content;
    const text = Array.isArray(content)
      ? '我收到了一张图片。\n\n' + markdownFixture
      : markdownFixture;
    const richText = text + latexFixture;
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
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(portNumber, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
