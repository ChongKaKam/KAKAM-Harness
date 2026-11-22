import type { Response } from 'express';
import type { LlmApiMode } from '../src/shared/types';
import { toolResults, writeToolTurn } from './provider-tool-fixture';

export const deliveryItems = [
  { kind: 'file', format: 'html', name: '计算器.html', brief: '一个可下载的网页计算器' },
  { kind: 'file', format: 'csv', name: '数据.csv', brief: '计算结果表格' },
  { kind: 'image', format: null, name: '插画一.png', brief: '第一张插画' },
  { kind: 'image', format: null, name: '插画二.png', brief: '第二张插画' },
];

export function deliveryProviderFixture(body: any, mode: LlmApiMode, res: Response): boolean {
  if (!String(body.model).startsWith('delivery-')) return false;
  const outputs = toolResults(body, mode);
  const parsed = outputs.map((output) => JSON.parse(output));
  const plan = parsed.find((value) => value.decision === 'deliver');
  const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  const add = (name: string, args: Record<string, unknown>) =>
    calls.push({ id: `tool-${outputs.length}-${calls.length}`, name, arguments: args });
  if (!outputs.length && !['delivery-noplan', 'delivery-auto'].includes(body.model)) {
    if (body.model === 'delivery-direct-image-failure') {
      add('production_generate_image', { itemId: null, name: '测试.png', prompt: '测试插画' });
    } else {
      const clarify = body.model === 'delivery-clarify';
      add('production_plan', {
        decision: clarify ? 'clarify' : 'deliver',
        items: clarify
          ? []
          : body.model === 'delivery-sequential'
            ? Array.from({ length: 12 }, (_, index) => ({
                kind: 'file',
                format: 'csv',
                name: `表格${index + 1}.csv`,
                brief: `第${index + 1}张表格`,
              }))
            : deliveryItems,
        question: clarify ? '需要交付哪些文件，内容和格式是什么？' : null,
      });
    }
  } else if (
    plan &&
    (outputs.length === 1 ||
      (body.model === 'delivery-sequential' && outputs.length <= plan.items.length))
  ) {
    if (body.model === 'delivery-shrink') {
      add('production_plan', {
        decision: 'deliver',
        items: deliveryItems.slice(0, 1),
        question: null,
      });
    } else {
      const items =
        body.model === 'delivery-sequential'
          ? plan.items.slice(outputs.length - 1, outputs.length)
          : body.model === 'delivery-partial' || body.model === 'delivery-wrong-format'
            ? plan.items.slice(0, 1)
            : plan.items;
      for (const item of items) {
        if (item.kind === 'image') {
          const args = { itemId: item.id, name: item.name, prompt: item.brief };
          add('production_generate_image', args);
          // Repeated completed item must reuse saved bytes, without another paid request.
          if (item === plan.items[2]) add('production_generate_image', args);
        } else {
          add('production_create_file', {
            itemId: item.id,
            name: item.name,
            format: body.model === 'delivery-wrong-format' ? 'text' : item.format,
            content:
              item.format === 'csv'
                ? '表达式,结果\n1+1,2\n'
                : '<!doctype html><html><title>计算器</title><button>1</button></html>',
          });
        }
      }
    }
  }
  const text =
    body.model === 'delivery-noplan' ? '```html\n<button>计算器</button>\n```' : '本轮回答完成。';
  writeToolTurn(mode, res, calls, text);
  return true;
}
