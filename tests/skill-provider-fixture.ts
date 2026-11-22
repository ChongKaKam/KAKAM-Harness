import type { Response } from 'express';
import type { LlmApiMode } from '../src/shared/types';
import { toolResults } from './provider-tool-fixture';
// Deliberately splits tool JSON and emits cumulative usage to exercise the real adapters.
export function skillProviderFixture(body: any, mode: LlmApiMode, res: Response): boolean {
  if (!body.tools?.some((tool: any) => tool.name === 'skills_read')) return false;
  const history = body.input ?? body.messages;
  const prompt = history
    .flatMap((m: any) =>
      typeof m.content === 'string' ? [m.content] : (m.content ?? []).map((b: any) => b.text ?? ''),
    )
    .find((t: string) => t.includes('Selected skills (JSON):\n'));
  const selected = JSON.parse(prompt.split('Selected skills (JSON):\n')[1].split('\n', 1)[0])[0];
  const results = toolResults(body, mode);
  const needCall =
    results.length < (body.model === 'skill-two' ? 2 : 1) || body.model === 'skill-repeat';
  const missingUsage = body.model === 'skill-no-usage' && results.length > 0;
  const args = JSON.stringify({
    skillId: selected.skillId,
    path: prompt.includes('[bad-path]')
      ? '../secrets'
      : selected.files[results.length && body.model === 'skill-two' ? 1 : 0].path,
    offset: 0,
    limit: 12000,
  });
  const callId = `call-${results.length}`;
  const text = `已按 Skill 完成：${results.map((r: string) => JSON.parse(r).content).join('；')}`;
  res.setHeader('Content-Type', 'text/event-stream');
  const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
  const respond = () => {
    if (mode === 'responses') {
      const output: unknown[] = needCall
        ? [
            { id: 'reason', type: 'reasoning', summary: [], encrypted_content: 'opaque-reasoning' },
            {
              id: callId,
              type: 'function_call',
              call_id: callId,
              name: 'skills_read',
              arguments: args,
            },
          ]
        : [
            {
              id: 'answer',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          ];
      if (needCall) {
        if (prompt.includes('[visible-tool-preface]')) {
          const preface = `准备读取第 ${results.length + 1} 份资料。`;
          output.push({
            id: `preface-${results.length}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: preface, annotations: [] }],
          });
          emit({ type: 'response.output_text.delta', delta: preface });
        }
        emit({
          type: 'response.function_call_arguments.delta',
          output_index: 1,
          delta: args.slice(0, 5),
        });
        emit({
          type: 'response.function_call_arguments.delta',
          output_index: 1,
          delta: args.slice(5),
        });
      } else emit({ type: 'response.output_text.delta', delta: text });
      output.forEach((item, index) =>
        emit({ type: 'response.output_item.done', output_index: index, item }),
      );
      emit({
        type:
          body.model === 'skill-broken' && results.length
            ? 'response.incomplete'
            : 'response.completed',
        response: {
          output,
          ...(missingUsage
            ? {}
            : { usage: { input_tokens: 23, output_tokens: 42, total_tokens: 65 } }),
        },
      });
    } else {
      emit({
        type: 'message_start',
        message: { usage: missingUsage ? undefined : { input_tokens: 23, output_tokens: 0 } },
      });
      if (needCall) {
        emit({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        });
        emit({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'private thought' },
        });
        emit({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'signed-thought' },
        });
        emit({ type: 'content_block_stop', index: 0 });
        emit({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: callId, name: 'skills_read', input: {} },
        });
        emit({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: args.slice(0, 5) },
        });
        emit({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: args.slice(5) },
        });
      } else {
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      }
      if (body.model === 'skill-broken' && results.length) {
        res.end();
        return;
      }
      emit({ type: 'content_block_stop', index: needCall ? 1 : 0 });
      if (!missingUsage) emit({ type: 'message_delta', delta: {}, usage: { output_tokens: 40 } });
      emit({
        type: 'message_delta',
        delta: { stop_reason: needCall ? 'tool_use' : 'end_turn' },
        ...(missingUsage ? {} : { usage: { output_tokens: 42 } }),
      });
      emit({ type: 'message_stop' });
    }
    res.end();
  };
  if (body.model === 'skill-slow' && results.length) {
    const timer = setTimeout(respond, 1500);
    res.on('close', () => clearTimeout(timer));
  } else respond();
  return true;
}
