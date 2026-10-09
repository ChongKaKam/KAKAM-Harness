import { z } from 'zod';
import { HttpError } from '../../kernel/http';
import { productionLimits, type ProductionFormat } from './types';

const formats = z.enum([
  'text',
  'markdown',
  'json',
  'csv',
  'html',
  'svg',
  'pdf',
  'docx',
  'xlsx',
  'pptx',
]);
const extensions: Record<ProductionFormat, string> = {
  text: 'txt',
  markdown: 'md',
  json: 'json',
  csv: 'csv',
  html: 'html',
  svg: 'svg',
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
};
export const productionMimeTypes: Record<ProductionFormat, string> = {
  text: 'text/plain',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface RenderedProduction {
  name: string;
  mimeType: string;
  data: Uint8Array;
}

function filename(name: string, format: ProductionFormat) {
  if (!name.trim() || name.length > 175 || /[\\/\x00-\x1f\x7f]/.test(name) || /^\.+$/.test(name))
    throw new HttpError(400, '文件名无效，请使用不含路径或控制字符的 1–175 字符名称');
  name = name.trim();
  if (format === 'text' && /\.[^.]+$/.test(name)) return name;
  const stem = name.replace(/\.[^.]+$/, '');
  return `${stem || 'artifact'}.${extensions[format]}`;
}

function parseJson(content: string) {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new HttpError(400, 'JSON 内容无效，请提供完整的 JSON');
  }
}

/** RFC 4180 quoting, including escaped quotes and newlines inside quoted fields. */
function validateCsv(content: string) {
  let quoted = false;
  let closed = false;
  let fieldStart = true;
  let columns = 1;
  let expected: number | null = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"') {
        if (content[i + 1] === '"') i++;
        else {
          quoted = false;
          closed = true;
        }
      }
      continue;
    }
    if (c === '"') {
      if (!fieldStart || closed) throw new HttpError(400, 'CSV 引号格式无效');
      quoted = true;
      fieldStart = false;
      continue;
    }
    if (c === ',') {
      columns++;
      fieldStart = true;
      closed = false;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && content[i + 1] === '\n') i++;
      expected ??= columns;
      if (expected !== columns) throw new HttpError(400, 'CSV 各行列数必须一致');
      columns = 1;
      fieldStart = true;
      closed = false;
      continue;
    }
    if (closed) throw new HttpError(400, 'CSV 引号后只能使用逗号或换行');
    fieldStart = false;
  }
  if (quoted) throw new HttpError(400, 'CSV 引号未闭合');
  if (expected !== null && !/[\r\n]$/.test(content) && expected !== columns)
    throw new HttpError(400, 'CSV 各行列数必须一致');
}

const workbookSchema = z
  .object({
    sheets: z
      .array(
        z
          .object({
            name: z
              .string()
              .trim()
              .min(1)
              .max(31)
              .refine((name) => !/[\\/*?:\[\]]/.test(name), '工作表名包含不支持的字符'),
            rows: z
              .array(
                z
                  .array(
                    z.union([z.string().max(32_767), z.number().finite(), z.boolean(), z.null()]),
                  )
                  .max(256),
              )
              .max(10_000),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.sheets.map((sheet) => sheet.name.toLowerCase())).size === value.sheets.length,
    '工作表名称不能重复',
  );
const presentationSchema = z
  .object({
    slides: z
      .array(
        z
          .object({
            title: z.string().max(200),
            body: z.union([z.string().max(8_000), z.array(z.string().max(2_000)).max(40)]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();

async function renderDocx(content: string) {
  const { Document, Paragraph, TextRun, Packer, HeadingLevel } = await import('docx');
  const paragraphs = content.split(/\r?\n/).map((line) => {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    return new Paragraph({
      children: [new TextRun({ text: heading ? heading[2] : line, font: 'Microsoft YaHei' })],
      ...(heading
        ? {
            heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][
              heading[1].length - 1
            ],
          }
        : {}),
      spacing: { after: heading ? 200 : 100 },
    });
  });
  const document = new Document({
    creator: 'Drift Space',
    styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 } } } },
    sections: [{ properties: {}, children: paragraphs }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

async function renderXlsx(content: string) {
  const value = workbookSchema.parse(parseJson(content));
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Drift Space';
  for (const sheet of value.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    worksheet.addRows(sheet.rows);
    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.eachRow((row) => {
      row.font = { name: 'Microsoft YaHei', size: 11 };
    });
    const columns = Math.max(0, ...sheet.rows.map((row) => row.length));
    for (let i = 1; i <= columns; i++) worksheet.getColumn(i).width = 22;
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

async function renderPptx(content: string) {
  const value = presentationSchema.parse(parseJson(content));
  const { default: PptxGenJS } = await import('pptxgenjs');
  const presentation = new PptxGenJS();
  presentation.layout = 'LAYOUT_WIDE';
  presentation.author = 'Drift Space';
  presentation.subject = 'Generated presentation';
  presentation.theme = {
    headFontFace: 'Microsoft YaHei',
    bodyFontFace: 'Microsoft YaHei',
  };
  for (const source of value.slides) {
    const slide = presentation.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(source.title, {
      x: 0.6,
      y: 0.4,
      w: 12.1,
      h: 0.8,
      fontFace: 'Microsoft YaHei',
      lang: 'zh-CN',
      fontSize: 28,
      bold: true,
      color: '111111',
      breakLine: false,
      fit: 'shrink',
    });
    slide.addText(Array.isArray(source.body) ? source.body.join('\n') : source.body, {
      x: 0.6,
      y: 1.5,
      w: 12.1,
      h: 5.3,
      fontFace: 'Microsoft YaHei',
      lang: 'zh-CN',
      fontSize: 20,
      color: '333333',
      margin: 0,
      breakLine: false,
      fit: 'shrink',
      valign: 'top',
    });
  }
  const output = await presentation.write({ outputType: 'nodebuffer' });
  if (!(output instanceof Uint8Array)) throw new HttpError(500, 'PPTX 生成器未返回文件内容');
  return output;
}

async function renderPdf(content: string) {
  const { renderPdfText } = await import('./pdf-generator');
  return renderPdfText(content) as Promise<Uint8Array>;
}

/** Trusted serializers only: no generated scripts, HTML execution, shell or network access. */
export async function renderProduction(input: {
  name: string;
  format: ProductionFormat;
  content: string;
}): Promise<RenderedProduction> {
  const format = formats.parse(input.format);
  const name = filename(input.name, format);
  const content = z.string().max(productionLimits.textCharacters).parse(input.content);
  if (['docx', 'xlsx', 'pptx'].includes(format) && /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content))
    throw new HttpError(400, 'Office 文档内容包含不支持的控制字符');
  let data: Uint8Array;
  if (format === 'docx') data = await renderDocx(content);
  else if (format === 'xlsx') data = await renderXlsx(content);
  else if (format === 'pptx') data = await renderPptx(content);
  else if (format === 'pdf') data = await renderPdf(content);
  else {
    if (format === 'json') parseJson(content);
    if (format === 'csv') validateCsv(content);
    if (format === 'svg' && !/<svg(?:\s|>)/i.test(content))
      throw new HttpError(400, 'SVG 内容必须包含 svg 根元素');
    data = Buffer.from(content, 'utf8');
  }
  if (data.byteLength > productionLimits.fileBytes)
    throw new HttpError(400, '产物超过 20 MiB 文件限制');
  return { name, mimeType: productionMimeTypes[format], data };
}
