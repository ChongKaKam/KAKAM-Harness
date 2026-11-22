import { HttpError } from '../kernel/http';
import type { ApiMode, LlmApiMode, ReasoningEffort } from '../shared/types';
import { checkContextBudget } from './context-budget';
import type {
  ProviderConnection,
  ProviderMessage,
  ToolDefinition,
  ToolStep,
  ToolTurnOptions,
} from './registry';

export function requireLlmApiMode(mode: ApiMode): LlmApiMode {
  if (mode === 'responses' || mode === 'anthropic-messages') return mode;
  throw new HttpError(400, '此来源协议不支持 Harness 文本生成');
}

export function generationOutputLimit(
  mode: LlmApiMode,
  effort: ReasoningEffort,
  connection: Pick<ProviderConnection, 'maxOutputTokens' | 'contextWindowTokens'>,
): number | undefined {
  if (connection.maxOutputTokens != null) return connection.maxOutputTokens;
  if (mode !== 'anthropic-messages') return undefined;
  const normalLimit = effort === 'none' ? 4096 : 16384;
  return connection.contextWindowTokens
    ? Math.min(normalLimit, Math.floor(connection.contextWindowTokens / 2))
    : normalLimit;
}

function baseMessages(messages: ProviderMessage[], mode: LlmApiMode): unknown[] {
  return messages.map((m) => ({
    role: m.role,
    content:
      mode === 'anthropic-messages'
        ? [
            ...(m.images ?? []).map((image) => {
              const parts = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image.data);
              if (!parts) throw new HttpError(400, '图片格式无效');
              return {
                type: 'image',
                source: { type: 'base64', media_type: parts[1], data: parts[2] },
              };
            }),
            ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ]
        : m.images?.length
          ? [
              { type: 'input_text', text: m.content },
              ...m.images.map((image) => ({
                type: 'input_image',
                image_url: image.data,
                detail: 'auto',
              })),
            ]
          : m.content,
  }));
}

/** Replays protocol-native continuation unchanged, including signed or encrypted reasoning blocks. */
export function generationRequest(
  mode: LlmApiMode,
  connection: ProviderConnection,
  model: string,
  messages: ProviderMessage[],
  effort: ReasoningEffort,
  turn?: ToolTurnOptions & { tools: ToolDefinition[]; steps: ToolStep[] },
): Record<string, unknown> {
  const responses = mode === 'responses';
  if (requireLlmApiMode(connection.apiMode ?? mode) !== mode)
    throw new HttpError(400, '模型来源与调用协议不一致');
  const history = baseMessages(messages, mode);
  for (const step of turn?.steps ?? []) {
    history.push(...step.turn.continuation);
    if (responses) {
      history.push(
        ...step.results.map((result) => ({
          type: 'function_call_output',
          call_id: result.id,
          output: result.output,
        })),
      );
    } else if (step.results.length) {
      history.push({
        role: 'user',
        content: step.results.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: result.output,
        })),
      });
    }
    if (step.steering?.length)
      history.push(
        ...baseMessages(
          step.steering.map((content) => ({ role: 'user', content })),
          mode,
        ),
      );
  }
  const output = generationOutputLimit(mode, effort, connection);
  const body: Record<string, unknown> = { model, stream: true };
  if (responses) {
    body.input = history;
    body.store = false;
    if (output !== undefined) body.max_output_tokens = output;
    if (effort !== 'none') body.reasoning = { effort };
    if (turn) {
      body.include = ['reasoning.encrypted_content'];
      body.tools = turn.tools.map((t) => ({ type: 'function', ...t, strict: true }));
      if (turn.requireTool) body.tool_choice = 'required';
    }
  } else {
    body.messages = history;
    body.max_tokens = output;
    if (effort !== 'none') {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort };
    }
    if (turn)
      body.tools = turn.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
  }
  checkContextBudget(connection, body);
  return body;
}
