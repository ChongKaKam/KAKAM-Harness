import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  ModelAdapter,
  ProviderConnection,
  ToolDefinition,
  ToolStep,
  ToolTurn,
} from '../../adapters/registry';
import { HttpError } from '../../kernel/http';
import type { ModelConnectionTest, ReasoningEffort } from '../../shared/types';
import { ProviderDiagnostics } from '../../adapters/diagnostics';
import { EmbeddingError, validateEmbeddingResponse } from '../../adapters/embeddings';

function initialResult(
  connection: ProviderConnection,
  model: string,
  effort: ReasoningEffort,
): ModelConnectionTest {
  return {
    ok: false,
    model,
    apiMode: connection.apiMode ?? 'responses',
    reasoningEffort: effort,
    firstTextMs: null,
    latencyMs: 0,
    textChunks: 0,
    usage: null,
    diagnostics: { output: '', truncated: false },
  };
}

/** Probe the same streaming path as chat, without persisting a conversation. */
export async function testModelConnection(
  adapter: ModelAdapter,
  connection: ProviderConnection,
  model: string,
  effort: ReasoningEffort,
  signal = AbortSignal.timeout(60_000),
): Promise<ModelConnectionTest> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const diagnostics = new ProviderDiagnostics(connection);
  connection = { ...connection, diagnostics };
  let failure: unknown;
  const result = initialResult(connection, model, effort);
  try {
    const events =
      connection.apiMode === 'jev' && adapter.decide
        ? adapter.decide(
            connection,
            model,
            { state: 'The user asks for current news.', instructions: 'Should we search the web?' },
            signal,
          )
        : adapter.generate(
            connection,
            model,
            [{ role: 'user', content: 'Reply with only OK.' }],
            signal,
            effort,
          );
    for await (const chunk of events) {
      if (chunk.type === 'decision') {
        diagnostics.text(JSON.stringify({ enabled: chunk.enabled }));
        result.ok = true;
        continue;
      }
      if (chunk.type === 'usage') result.usage = chunk.usage;
      else if (chunk.text.length) {
        diagnostics.text(chunk.text);
        result.textChunks++;
        if (chunk.text.trim() && result.firstTextMs === null) result.firstTextMs = elapsed();
      }
    }
    if (connection.apiMode === 'jev') {
      if (!result.ok) result.error = '未收到有效的 Jev 决策';
    } else if (result.firstTextMs === null)
      result.error = '请求已结束，但未收到可显示的文本，请检查来源的流式协议兼容性。';
    else result.ok = true;
  } catch (error) {
    failure = error;
    result.ok = false;
    result.error = signal.aborted
      ? '连接测试超时，请降低思考程度或检查上游响应。'
      : error instanceof HttpError
        ? error.message
        : '连接测试失败，请检查来源地址、密钥、模型及响应模式。';
  }
  result.latencyMs = elapsed();
  result.diagnostics = diagnostics.finish(failure ?? result.error);
  return result;
}

const probeTool: ToolDefinition = {
  name: 'read_probe',
  description: 'Read the single test document probe.txt and return its verification code.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', enum: ['probe.txt'] } },
    required: ['name'],
    additionalProperties: false,
  },
};
const probeArgs = z.strictObject({ name: z.literal('probe.txt') });
type ToolRound = NonNullable<ModelConnectionTest['toolRounds']>[number];

/** The document exists only in memory. The provider must read its previously unknown value. */
export async function testToolConnection(
  adapter: ModelAdapter,
  connection: ProviderConnection,
  model: string,
  effort: ReasoningEffort,
  record: (round: ToolRound, index: number) => void,
  checkModel: () => void,
  signal = AbortSignal.timeout(60_000),
): Promise<ModelConnectionTest> {
  const result = initialResult(connection, model, effort);
  const rounds: ToolRound[] = [];
  result.toolRounds = rounds;
  const started = performance.now();
  const code = randomUUID();
  const messages = [
    {
      role: 'user' as const,
      content:
        'Call read_probe exactly once with name "probe.txt". After receiving the tool result, reply with its verification code.',
    },
  ];
  const steps: ToolStep[] = [];
  let diagnostics = new ProviderDiagnostics(connection);
  let failure: unknown;
  try {
    if (!adapter.generateTurn) throw new HttpError(400, '当前来源协议未提供工具调用能力');
    for (let index = 0; index < 2; index++) {
      signal.throwIfAborted();
      checkModel();
      diagnostics = new ProviderDiagnostics(connection);
      const round: ToolRound = { ok: false, usage: null };
      try {
        let turn: ToolTurn | undefined;
        let output = '';
        for await (const event of adapter.generateTurn(
          { ...connection, diagnostics },
          model,
          messages,
          [probeTool],
          steps,
          signal,
          effort,
        )) {
          signal.throwIfAborted();
          if (event.type === 'usage') round.usage = event.usage;
          else if (event.type === 'turn') turn = event.turn;
          else if (event.text.length) {
            output += event.text;
            diagnostics.text(event.text);
            if (event.text.trim() && result.firstTextMs === null)
              result.firstTextMs = Math.round(performance.now() - started);
            result.textChunks++;
            if (output.length > 32_768) throw new HttpError(502, '工具测试回复超出长度上限');
          }
        }
        signal.throwIfAborted();
        if (!turn) throw new HttpError(502, '模型未完整返回本轮工具协议消息');
        if (index === 0) {
          const call = turn.calls[0];
          if (
            turn.calls.length !== 1 ||
            !call.id ||
            call.name !== probeTool.name ||
            !probeArgs.safeParse(call.arguments).success
          )
            throw new HttpError(502, '第一轮未收到约定的只读工具调用及参数');
          steps.push({
            turn,
            results: [{ id: call.id, output: JSON.stringify({ verificationCode: code }) }],
          });
        } else if (turn.calls.length || !output.includes(code)) {
          throw new HttpError(502, '第二轮未能引用工具返回的验证码');
        }
        round.ok = true;
      } finally {
        if (diagnostics.requestStarted) {
          rounds.push(round);
          record(round, index);
        }
      }
    }
    result.ok = true;
  } catch (error) {
    failure = error;
    result.error = signal.aborted
      ? '工具调用测试超过 60 秒。'
      : error instanceof HttpError
        ? error.message
        : '工具调用测试失败，请检查模型和来源协议。';
  }
  result.latencyMs = Math.round(performance.now() - started);
  if (rounds.length && rounds.every((round) => round.usage)) {
    result.usage = rounds.reduce(
      (total, { usage }) => ({
        input: total.input + usage!.input,
        output: total.output + usage!.output,
        total: total.total + usage!.total,
      }),
      { input: 0, output: 0, total: 0 },
    );
  }
  result.diagnostics = diagnostics.finish(failure);
  return result;
}

/** Probe the saved embedding endpoint; no chat or vector-index mutation is performed. */
export async function testEmbeddingConnection(
  adapter: ModelAdapter,
  connection: ProviderConnection,
  model: string,
  dimensions: number | null,
  signal = AbortSignal.timeout(60_000),
): Promise<ModelConnectionTest> {
  const started = performance.now();
  const diagnostics = new ProviderDiagnostics(connection);
  const result: ModelConnectionTest = {
    ...initialResult(connection, model, 'none'),
    kind: 'embedding',
    configuredDimensions: dimensions,
    actualDimensions: null,
    dimensionsMatch: null,
  };
  let failure: unknown;
  try {
    if (!adapter.embed || result.apiMode !== 'responses')
      throw new HttpError(400, 'Anthropic / Jev 来源协议不支持 Embedding');
    const embedded = await adapter.embed(
      { ...connection, diagnostics },
      model,
      ['Drift Space embedding connectivity test.'],
      signal,
      dimensions ?? undefined,
    );
    result.usage = embedded.usage;
    result.actualDimensions = embedded.dimensions;
    validateEmbeddingResponse(
      embedded.vectors.map((embedding, index) => ({ embedding, index })),
      1,
      embedded.usage,
      dimensions ?? undefined,
    );
    result.dimensionsMatch = dimensions === null ? null : embedded.dimensions === dimensions;
    diagnostics.text(
      JSON.stringify({ dimensions: embedded.dimensions, vectors: embedded.vectors.length }),
    );
    result.ok = true;
  } catch (error) {
    failure = error;
    if (error instanceof EmbeddingError) {
      result.usage = error.usage;
      result.actualDimensions = error.dimensions;
      result.dimensionsMatch =
        dimensions === null || error.dimensions === null ? null : dimensions === error.dimensions;
    }
    result.error = signal.aborted
      ? 'Embedding 连接测试超时，请检查上游响应。'
      : error instanceof HttpError
        ? error.message
        : 'Embedding 连接测试失败，请检查来源地址、密钥和响应格式。';
  }
  result.latencyMs = Math.round(performance.now() - started);
  result.diagnostics = diagnostics.finish(failure);
  return result;
}
