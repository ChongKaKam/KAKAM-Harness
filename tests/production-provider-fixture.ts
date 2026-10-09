import type { Response } from 'express';
import type { ApiMode } from '../src/shared/types';

export const productionFileName = '测试产物.md';
export const productionFileContent = '# 生成产物\n\n这是模型通过受控工具生成的 Markdown 文件。\n';
export const productionHtmlContent =
  '<!doctype html><html lang="zh-CN"><title>计算器</title><body><button>1</button></body></html>';

export function productionProviderFixture(body: any, mode: ApiMode, res: Response): boolean {
  if (
    !['production-tool', 'production-trigger', 'production-stubborn'].includes(body.model) ||
    !body.tools?.some(
      (tool: any) => (tool.name ?? tool.function?.name) === 'production_create_file',
    )
  )
    return false;
  const history = body.input ?? body.messages;
  const outputs =
    mode === 'responses'
      ? history
          .filter((message: any) => message.type === 'function_call_output')
          .map((message: any) => message.output)
      : mode === 'anthropic-messages'
        ? history.flatMap((message: any) =>
            Array.isArray(message.content)
              ? message.content
                  .filter((block: any) => block.type === 'tool_result')
                  .map((block: any) => block.content)
              : [],
          )
        : history
            .filter((message: any) => message.role === 'tool')
            .map((message: any) => message.content);
  const trigger = body.model !== 'production-tool';
  const lastUser = [...history].reverse().find((message: any) => message.role === 'user');
  const userText =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : (lastUser?.content
          ?.filter((block: any) => block.type === 'text')
          .map((block: any) => block.text)
          .join('\n') ?? '');
  const required =
    body.tool_choice === 'required' ||
    (mode === 'anthropic-messages' && userText.includes('Required artifact:'));
  const creating =
    !outputs.length && (!trigger || (required && body.model !== 'production-stubborn'));
  const image =
    JSON.stringify(history).includes('[production-image]') ||
    (trigger && userText.split('\n\n').at(-1)?.includes('图片'));
  const html = trigger && userText.split('\n\n').at(-1)?.includes('网页');
  const toolName = image ? 'production_generate_image' : 'production_create_file';
  const args = JSON.stringify(
    image
      ? { name: '测试图片.png', prompt: '一张测试插画' }
      : html
        ? { name: '计算器.html', format: 'html', content: productionHtmlContent }
        : { name: productionFileName, format: 'markdown', content: productionFileContent },
  );
  const text =
    !creating && !outputs.length
      ? '下面是示例说明，未调用生成工具。'
      : `已生成产物：${image ? '测试图片.png' : html ? '计算器.html' : productionFileName}`;
  res.setHeader('Content-Type', 'text/event-stream');
  const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const finish = () => {
    if (mode === 'responses') {
      const output = creating
        ? [
            {
              id: 'file-tool',
              type: 'function_call',
              call_id: 'create-file',
              name: toolName,
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
      if (!creating) emit({ type: 'response.output_text.delta', delta: text });
      output.forEach((item, index) =>
        emit({ type: 'response.output_item.done', output_index: index, item }),
      );
      emit({
        type: 'response.completed',
        response: { output, usage: { input_tokens: 23, output_tokens: 42, total_tokens: 65 } },
      });
    } else if (mode === 'anthropic-messages') {
      emit({ type: 'message_start', message: { usage: { input_tokens: 23, output_tokens: 0 } } });
      emit({
        type: 'content_block_start',
        index: 0,
        content_block: creating
          ? { type: 'tool_use', id: 'create-file', name: toolName, input: {} }
          : { type: 'text', text: '' },
      });
      emit({
        type: 'content_block_delta',
        index: 0,
        delta: creating
          ? { type: 'input_json_delta', partial_json: args }
          : { type: 'text_delta', text },
      });
      emit({ type: 'content_block_stop', index: 0 });
      emit({
        type: 'message_delta',
        delta: { stop_reason: creating ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 42 },
      });
      emit({ type: 'message_stop' });
    } else {
      emit({
        choices: [
          {
            delta: creating
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'create-file',
                      type: 'function',
                      function: { name: toolName, arguments: args },
                    },
                  ],
                }
              : { content: text },
          },
        ],
      });
      emit({ choices: [{ delta: {}, finish_reason: creating ? 'tool_calls' : 'stop' }] });
      emit({ choices: [], usage: { prompt_tokens: 23, completion_tokens: 42, total_tokens: 65 } });
      res.write('data: [DONE]\n\n');
    }
    res.end();
  };
  if (creating && JSON.stringify(history).includes('[production-slow]')) {
    const timer = setTimeout(finish, 120);
    res.on('close', () => clearTimeout(timer));
  } else finish();
  return true;
}
