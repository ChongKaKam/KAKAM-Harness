import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, normalizeMath } from '../src/client/markdown';

test('common LaTeX delimiters render outside code while ordinary code remains literal', () => {
  const html = renderToStaticMarkup(
    <Markdown
      content={String.raw`Inline \(x^2\), block:
\[
F_n = F_{n-1} + F_{n-2}
\]

\`literal\`
`}
    />,
  );
  assert.ok(html.includes('katex-display'), 'display math is rendered');
  assert.ok((html.match(/class="katex"/g) ?? []).length >= 2, 'inline math is rendered');
});

test('LaTeX documents in fenced code have formula previews and original code copy', () => {
  const content =
    '```latex\n' +
    String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
The Fibonacci sequence:
\[F_n=F_{n-1}+F_{n-2}\]
\end{document}` +
    '\n```';
  const html = renderToStaticMarkup(<Markdown content={content} />);
  assert.ok(html.includes('katex-display'));
  assert.ok(html.includes('复制代码'));
});

test('math normalization leaves fenced and inline code untouched, including incomplete streaming fences', () => {
  const inline = '`' + String.raw`\(x^2\)` + '`';
  const fenced = '```javascript\n' + String.raw`const formula = "\[x^2\]";` + '\n```';
  const unclosed = '~~~text\n' + String.raw`\(x^2\)`;
  for (const code of [inline, fenced, unclosed]) assert.equal(normalizeMath(code), code);
});
test('unlabelled LaTeX documents render formulas while preserving source', () => {
  const content =
    '```\n' +
    String.raw`\documentclass{article}
\begin{document}
\[\frac{1+\sqrt{5}}{2}\]
\end{document}` +
    '\n```';
  assert.ok(renderToStaticMarkup(<Markdown content={content} />).includes('katex-display'));
});
