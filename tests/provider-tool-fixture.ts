import type { Response } from 'express';
import type { LlmApiMode } from '../src/shared/types';

export interface FixtureToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export function toolResults(body: any, mode: LlmApiMode): string[] {
  return mode === 'responses'
    ? body.input
        .filter((item: any) => item.type === 'function_call_output')
        .map((item: any) => item.output)
    : body.messages.flatMap((item: any) =>
        Array.isArray(item.content)
          ? item.content
              .filter((block: any) => block.type === 'tool_result')
              .map((block: any) => block.content)
          : [],
      );
}

/** Emit the native streamed exchange the server must decode and replay on the next turn. */
export function writeToolTurn(
  mode: LlmApiMode,
  res: Response,
  calls: FixtureToolCall[],
  text: string,
  usage: { input_tokens: number; output_tokens: number } | null = {
    input_tokens: 23,
    output_tokens: 42,
  },
) {
  res.type('text/event-stream');
  const emit = (event: unknown) => res.write('data: ' + JSON.stringify(event) + '\n\n');
  if (mode === 'responses') {
    const output = calls.length
      ? calls.map((call) => ({
          type: 'function_call',
          id: 'fc_' + call.id,
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        }))
      : [
          {
            type: 'message',
            id: 'answer',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ];
    if (!calls.length) emit({ type: 'response.output_text.delta', delta: text });
    output.forEach((item, output_index) =>
      emit({ type: 'response.output_item.done', output_index, item }),
    );
    emit({
      type: 'response.completed',
      response: {
        output,
        ...(usage && {
          usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens },
        }),
      },
    });
  } else {
    emit({
      type: 'message_start',
      message: { ...(usage && { usage: { input_tokens: usage.input_tokens, output_tokens: 0 } }) },
    });
    (calls.length ? calls : [null]).forEach((call, index) => {
      emit({
        type: 'content_block_start',
        index,
        content_block: call
          ? { type: 'tool_use', id: call.id, name: call.name, input: {} }
          : { type: 'text', text: '' },
      });
      emit({
        type: 'content_block_delta',
        index,
        delta: call
          ? { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) }
          : { type: 'text_delta', text },
      });
      emit({ type: 'content_block_stop', index });
    });
    emit({
      type: 'message_delta',
      delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn' },
      ...(usage && { usage: { output_tokens: usage.output_tokens } }),
    });
    emit({ type: 'message_stop' });
  }
  res.end();
}
