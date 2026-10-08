import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { renderProduction } from '../src/features/llm-production/generators';

function zipEntry(data: Uint8Array, wanted: string) {
  const bytes = Buffer.from(data);
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'valid ZIP end directory');
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const start =
        localOffset +
        30 +
        bytes.readUInt16LE(localOffset + 26) +
        bytes.readUInt16LE(localOffset + 28);
      const file = bytes.subarray(start, start + compressed);
      assert.ok(method === 0 || method === 8);
      return (method === 8 ? inflateRawSync(file) : file).toString('utf8');
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.fail(`ZIP entry missing: ${wanted}`);
}

test('UTF-8 files preserve code filenames and validate JSON / quoted CSV', async () => {
  const code = await renderProduction({
    name: '示例.py',
    format: 'text',
    content: 'print("你好")\n',
  });
  assert.equal(code.name, '示例.py');
  assert.equal(Buffer.from(code.data).toString('utf8'), 'print("你好")\n');
  const json = await renderProduction({
    name: 'data.txt',
    format: 'json',
    content: '{"名称":"示例","值":12}',
  });
  assert.equal(json.name, 'data.json');
  assert.deepEqual(JSON.parse(Buffer.from(json.data).toString()), { 名称: '示例', 值: 12 });
  await renderProduction({
    name: 'table',
    format: 'csv',
    content: 'name,value\r\n"hello,\nworld","a""b"\r\n',
  });
  for (const content of ['a,b\n1', 'a,"b', 'a,"b"tail'])
    await assert.rejects(renderProduction({ name: 'bad.csv', format: 'csv', content }));
  await assert.rejects(
    renderProduction({ name: 'bad.json', format: 'json', content: '{invalid}' }),
  );
  await assert.rejects(renderProduction({ name: '../unsafe.txt', format: 'text', content: 'x' }));
});

test('Word, Excel and PowerPoint are valid OOXML with Chinese content and literal cells', async () => {
  const docx = await renderProduction({
    name: '报告',
    format: 'docx',
    content: '# 中文报告\n正文 <示例> & 数据',
  });
  assert.equal(docx.name, '报告.docx');
  assert.match(zipEntry(docx.data, '[Content_Types].xml'), /wordprocessingml/);
  assert.match(zipEntry(docx.data, 'word/document.xml'), /中文报告/);
  assert.match(zipEntry(docx.data, 'word/document.xml'), /正文 &lt;示例&gt; &amp; 数据/);
  const xlsx = await renderProduction({
    name: '表格.csv',
    format: 'xlsx',
    content: JSON.stringify({
      sheets: [
        {
          name: '中文数据',
          rows: [
            ['名称', '数量', '公式文本'],
            ['示例', 12, '=2+2'],
            [null, true, ''],
          ],
        },
      ],
    }),
  });
  assert.match(zipEntry(xlsx.data, 'xl/workbook.xml'), /中文数据/);
  assert.match(zipEntry(xlsx.data, 'xl/worksheets/sheet1.xml'), /<v>12<\/v>/);
  assert.ok(!zipEntry(xlsx.data, 'xl/worksheets/sheet1.xml').includes('<f>'));
  assert.match(zipEntry(xlsx.data, 'xl/sharedStrings.xml'), /=2\+2/);
  const pptx = await renderProduction({
    name: '幻灯片',
    format: 'pptx',
    content: JSON.stringify({
      slides: [
        { title: '中文标题', body: ['第一条', '第二条'] },
        { title: '结论', body: '正文内容' },
      ],
    }),
  });
  assert.match(zipEntry(pptx.data, 'ppt/slides/slide1.xml'), /中文标题/);
  assert.match(zipEntry(pptx.data, 'ppt/slides/slide1.xml'), /第一条/);
  assert.match(zipEntry(pptx.data, 'ppt/slides/slide2.xml'), /正文内容/);
  await assert.rejects(
    renderProduction({
      name: 'bad.xlsx',
      format: 'xlsx',
      content: '{"sheets":[{"name":"a/b","rows":[]}]}',
    }),
  );
  await assert.rejects(
    renderProduction({
      name: 'bad.xlsx',
      format: 'xlsx',
      content: '{"sheets":[{"name":"a","rows":[[{"formula":"2+2"}]]}]}',
    }),
  );
  await assert.rejects(
    renderProduction({ name: 'bad.pptx', format: 'pptx', content: '{"slides":[]}' }),
  );
});

test('PDF embeds portable Chinese fonts and retains Unicode mapping', async () => {
  const pdf = await renderProduction({
    name: '中文.pdf',
    format: 'pdf',
    content: '# 中文报告\n你好，世界！\nDrift Space 2026\n\n第二段内容。',
  });
  const bytes = Buffer.from(pdf.data);
  assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.match(bytes.toString('latin1'), /\/FontFile[23]/);
  assert.match(bytes.toString('latin1'), /\/ToUnicode/);
  assert.match(bytes.toString('latin1'), /%%EOF/);
});
