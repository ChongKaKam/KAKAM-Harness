import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { HttpError } from '../../kernel/http';

interface FontSubset {
  name: string;
  file: string;
  ranges: Array<[number, number]>;
}
const require = createRequire(import.meta.url);
let subsetPromise: Promise<FontSubset[]> | undefined;

/** The packaged CSS is the font's authoritative Unicode-to-subset mapping. */
function fontSubsets() {
  return (subsetPromise ??= (async () => {
    const cssFile = require.resolve('@fontsource/noto-sans-sc/400.css');
    const css = await readFile(cssFile, 'utf8');
    const subsets: FontSubset[] = [];
    for (const block of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
      // Fontkit's WOFF2 subsetting can lose glyph outlines; the packaged WOFF has verified outlines.
      const source = /url\(['"]?(\.\/files\/[^'"\s)]+\.woff)['"]?\)/.exec(block[1]);
      const range = /unicode-range:\s*([^;]+);/.exec(block[1]);
      if (!source || !range) continue;
      const ranges: Array<[number, number]> = [];
      for (const interval of range[1].matchAll(/U\+([\dA-F]+)(?:-([\dA-F]+))?/gi)) {
        const start = parseInt(interval[1], 16);
        ranges.push([start, interval[2] ? parseInt(interval[2], 16) : start]);
      }
      subsets.push({
        name: `noto-${subsets.length}`,
        file: resolve(dirname(cssFile), source[1]),
        ranges,
      });
    }
    if (!subsets.length) throw new HttpError(500, '中文 PDF 字体资源缺失');
    return subsets;
  })());
}

/** Embed the used Noto Sans SC glyphs, so downloads do not depend on the reader's Chinese fonts. */
export async function renderPdfText(content: string): Promise<Uint8Array> {
  const { default: PDFDocument } = await import('pdfkit');
  const subsets = await fontSubsets();
  const matches = new Map<number, FontSubset>();
  for (const character of content) {
    if (/\s/.test(character)) continue;
    const code = character.codePointAt(0)!;
    if (matches.has(code)) continue;
    const subset = subsets.find((font) =>
      font.ranges.some(([start, end]) => code >= start && code <= end),
    );
    if (!subset)
      throw new HttpError(
        400,
        `PDF 字体不支持字符 U+${code.toString(16).toUpperCase()}，请改用 DOCX 或文本格式`,
      );
    matches.set(code, subset);
  }
  const document = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Creator: 'Drift Space', Producer: 'Drift Space' },
  });
  const chunks: Buffer[] = [];
  const finished = new Promise<Uint8Array>((resolveResult, reject) => {
    document.on('data', (chunk: Buffer) => chunks.push(chunk));
    document.on('end', () => resolveResult(Buffer.concat(chunks)));
    document.on('error', reject);
  });
  const registered = new Set<string>();
  const defaultSubset =
    subsets.find((font) => font.ranges.some(([start, end]) => 65 >= start && 65 <= end)) ??
    subsets[0];
  const choose = (font: FontSubset) => {
    if (!registered.has(font.name)) {
      document.registerFont(font.name, font.file);
      registered.add(font.name);
    }
    document.font(font.name);
  };
  try {
    for (const line of content.split(/\r?\n/)) {
      const heading = /^(#{1,3})\s+(.*)$/.exec(line);
      const text = (heading ? heading[2] : line).replace(/\t/g, '    ');
      document.fontSize(heading ? 18 - heading[1].length * 2 : 11);
      if (!text) {
        choose(defaultSubset);
        document.moveDown(0.7);
        continue;
      }
      const runs: Array<{ font: FontSubset; text: string }> = [];
      for (const character of text) {
        const font = matches.get(character.codePointAt(0)!) ?? runs.at(-1)?.font ?? defaultSubset;
        const previous = runs.at(-1);
        if (previous?.font === font) previous.text += character;
        else runs.push({ font, text: character });
      }
      for (let i = 0; i < runs.length; i++) {
        choose(runs[i].font);
        document.text(runs[i].text, {
          continued: i < runs.length - 1,
          lineGap: 4,
          paragraphGap: heading ? 8 : 4,
        });
      }
    }
    document.end();
    return await finished;
  } catch (error) {
    document.destroy(error instanceof Error ? error : new Error(String(error)));
    await finished.catch(() => {});
    throw error;
  }
}
