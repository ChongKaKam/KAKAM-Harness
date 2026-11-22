import type { Response } from 'express';
import type { LlmApiMode } from '../src/shared/types';
import { toolResults, writeToolTurn } from './provider-tool-fixture';

export const productionFileName = '测试产物.md';
export const productionFileContent = '# 生成产物\n\n这是模型通过受控工具生成的 Markdown 文件。\n';
export const productionHtmlContent =
  '<!doctype html><html lang="zh-CN"><title>计算器</title><body><button>1</button></body></html>';

export function productionProviderFixture(body: any, mode: LlmApiMode, res: Response): boolean {
  if (
    !['production-tool', 'production-trigger', 'production-stubborn'].includes(body.model) ||
    !body.tools?.some((tool: any) => tool.name === 'production_create_file')
  )
    return false;
  const history = body.input ?? body.messages;
  const outputs = toolResults(body, mode);
  const trigger = body.model !== 'production-tool';
  const lastUser = [...history].reverse().find((message: any) => message.role === 'user');
  const userText =
    typeof lastUser?.content === 'string'
      ? lastUser.content
      : (lastUser?.content
          ?.filter((block: any) => block.type === 'text' || block.type === 'input_text')
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
  const args = image
    ? { name: '测试图片.png', prompt: '一张测试插画' }
    : html
      ? { name: '计算器.html', format: 'html', content: productionHtmlContent }
      : { name: productionFileName, format: 'markdown', content: productionFileContent };
  const text =
    !creating && !outputs.length
      ? '下面是示例说明，未调用生成工具。'
      : `已生成产物：${image ? '测试图片.png' : html ? '计算器.html' : productionFileName}`;
  const finish = () =>
    writeToolTurn(
      mode,
      res,
      creating ? [{ id: 'create-file', name: toolName, arguments: args }] : [],
      text,
    );
  if (creating && JSON.stringify(history).includes('[production-slow]')) {
    const timer = setTimeout(finish, 120);
    res.on('close', () => clearTimeout(timer));
  } else finish();
  return true;
}
