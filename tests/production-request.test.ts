import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionRequest } from '../src/features/llm-production/request';

test('explicit creation commands select images or their requested downloadable format', () => {
  for (const content of [
    '帮我生成一个图片',
    '请帮我生成一张猫的图片',
    '画一只猫',
    'Please generate two images of cats',
    'Create an image of a CSV icon',
  ])
    assert.deepEqual(productionRequest(content), { kind: 'image' }, content);
  for (const content of ['帮我写一个网页计算器', 'Please build a calculator webpage'])
    assert.deepEqual(productionRequest(content), { kind: 'file' }, content);
  assert.deepEqual(productionRequest('请开发一个 HTML 页面'), { kind: 'file', format: 'html' });
  for (const [format, request] of [
    ['pdf', '请生成一个 PDF 文件'],
    ['docx', '请生成一个 Word 文件'],
    ['xlsx', '请生成一个 Excel 文件'],
    ['pptx', '请生成一个 PPT 文件'],
    ['json', '请导出一个 JSON 文件'],
    ['csv', '请导出一个 CSV 文件'],
    ['markdown', '请保存一个 Markdown 文件'],
    ['text', '请生成一个 TXT 文件'],
  ])
    assert.deepEqual(productionRequest(request), { kind: 'file', format }, request);
  assert.deepEqual(productionRequest('生成一个 SVG 图片'), { kind: 'file', format: 'svg' });
  assert.deepEqual(productionRequest('不要给代码，请帮我生成一个 PDF 文件'), {
    kind: 'file',
    format: 'pdf',
  });
  assert.deepEqual(productionRequest('生成一个可下载文件'), { kind: 'file' });
});

test('negations, quoted material, coding help and diagnostic discussion do not authorize generation', () => {
  for (const content of [
    '为什么生成图片没有调用模型？',
    '教我怎么生成图片',
    '帮我生成一个图片的提示词',
    'Write code that generates an image',
    '帮我编写一个图片生成工具',
    '一个生成图片的模型应该如何配置？',
    '只给一个 HTML 代码示例，不要生成文件',
    '请不要生成图片',
    '不要生成图片，解释一下机制',
    '用户说“帮我生成一个图片”，这句话该怎么处理？',
    '> 帮我生成一个图片\n解释上面的请求',
    '```text\n帮我生成一个图片\n```\n解释代码',
    '画一个流程图',
  ])
    assert.equal(productionRequest(content), undefined, content);
});
