import type { ProductionFormat } from './types';

export interface ProductionRequest {
  kind: 'image' | 'file';
  format?: ProductionFormat;
}

/** Conservative imperative requests only. History, quoted examples and instructions are excluded. */
export function productionRequest(content: string): ProductionRequest | undefined {
  const text = content
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/`[^`]*`|“[^”]*”|「[^」]*」|"[^"\n]*"/g, '')
    .replace(/^\s*>.*$/gm, '');
  const clauses = text.split(/[\n。！？!?；;，,]/).map((clause) => clause.trim());
  for (const clause of clauses) {
    if (!clause || /^(?:不要|别|不用|无需|不必)/.test(clause)) continue;
    const command =
      /^(?:(?:请|帮我|为我|给我|替我|麻烦你?|能不能|能否|可以|你能|我想要?|我需要|我要|我希望|再|直接)\s*)*(生成|制作|创建|绘制|画|做|写|编写|开发|设计|输出|导出|保存|提供)(.{1,100})/.exec(
        clause,
      );
    const english =
      /^(?:(?:please|can you|could you|help me(?: to)?|i want(?: you to)?|i need(?: you to)?)\s+)*(generate|create|draw|make|build|write|export|save|produce)\b(.{1,120})/i.exec(
        clause,
      );
    const match = command ?? english;
    if (!match) continue;
    const target = match[2];
    if (/(?:提示词|prompt|教程|方法|流程|机制|代码示例|code example|sample code)/i.test(target))
      continue;
    const imageIndex = target.search(
      /(?:图片|图像|插画|照片|\b(?:images?|pictures?|illustrations?|photos?)\b)/i,
    );
    const formats: Array<[RegExp, ProductionFormat]> = [
      [/\bhtml\b/i, 'html'],
      [/\bpdf\b/i, 'pdf'],
      [/\b(?:docx|word)\b/i, 'docx'],
      [/\b(?:xlsx|excel)\b/i, 'xlsx'],
      [/\b(?:pptx?|powerpoint)\b/i, 'pptx'],
      [/\bsvg\b/i, 'svg'],
      [/\bjson\b/i, 'json'],
      [/\bcsv\b/i, 'csv'],
      [/\b(?:markdown|md)\b/i, 'markdown'],
      [/\b(?:txt|text file)\b/i, 'text'],
    ];
    for (const [pattern, format] of formats) {
      const index = target.search(pattern);
      if (index >= 0 && (imageIndex < 0 || index < imageIndex)) return { kind: 'file', format };
    }
    if (/(?:代码|脚本|程序|工具|接口|功能|说明|code|script|program|tool|api)/i.test(target))
      continue;
    if (imageIndex >= 0) return { kind: 'image' };
    if (
      (match[1] === '画' || /^draw$/i.test(match[1])) &&
      !/(?:流程图|架构图|图表|diagram|graph|chart)/i.test(target)
    )
      return { kind: 'image' };
    if (/(?:文件|可下载|网页|网站|file|downloadable|web\s*(?:page|site))/i.test(target))
      return { kind: 'file' };
  }
  return undefined;
}
