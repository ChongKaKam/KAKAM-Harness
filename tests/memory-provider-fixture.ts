import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Local deterministic embedding and LLM responses; never uses a paid provider. */
export async function memoryProviderFixture() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const delays = { embedding: 0 };
  const requests: {
    model: string;
    input?: string[];
    messages?: { role: string; content: string }[];
  }[] = [];
  app.get('/v1/models', (_req, res) =>
    res.json({
      data: ['memory-llm', 'memory-embedding', 'memory-embedding-next', 'memory-broken'].map(
        (id) => ({ id }),
      ),
    }),
  );
  app.post('/v1/embeddings', async (req, res) => {
    requests.push(req.body);
    if (delays.embedding) await delay(delays.embedding);
    const inputs = Array.isArray(req.body.input) ? req.body.input : [req.body.input];
    const dimensions = req.body.model === 'memory-embedding-next' ? 4 : 3;
    res.json({
      data: inputs.map((_input: string, index: number) => ({
        index,
        embedding: [1, ...Array(dimensions - 1).fill(0)],
      })),
      usage: { prompt_tokens: inputs.length * 3, total_tokens: inputs.length * 3 },
    });
  });
  app.post('/v1/chat/completions', (req, res) => {
    requests.push(req.body);
    if (req.body.model === 'memory-broken') {
      res.status(503).json({ error: { message: 'fixture provider unavailable' } });
      return;
    }
    const text = req.body.messages.at(-1)?.content ?? '';
    let answer = '收到，本轮已使用提供的上下文。';
    if (text.includes('Select useful saved memories')) {
      const candidates = JSON.parse(text.slice(text.indexOf('Candidates: ') + 12));
      answer = JSON.stringify({
        selected: [
          ...candidates.map((item: { id: string }) => ({ id: item.id, reason: '与问题相关' })),
          { id: randomUUID(), reason: '模型虚构的候选应被拒绝' },
        ],
      });
    } else if (text.includes('Extract durable user memories')) {
      answer = JSON.stringify({
        memories: [
          {
            scope: 'user',
            kind: 'preference',
            content: '用户喜欢中文回答',
            evidence: '我喜欢中文回答',
            tags: ['语言'],
          },
          {
            scope: 'group',
            kind: 'fact',
            content: '本项目使用中文说明',
            evidence: '项目使用中文说明',
            tags: ['项目'],
          },
          {
            scope: 'session',
            kind: 'task',
            content: '当前任务是实现记忆功能',
            evidence: '实现记忆功能',
            tags: [],
          },
          {
            scope: 'user',
            kind: 'fact',
            content: '缺少证据的内容不可保存',
            evidence: '原文未出现的证据',
            tags: [],
          },
        ],
      });
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    requests,
    delays,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
