import { lazy, Suspense, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Copy, Check } from 'lucide-react';
import { copyText } from './clipboard';
import { useUi } from './ui-preferences';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
const Mermaid = lazy(async () => {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
    fontFamily: 'system-ui',
    suppressErrorRendering: true,
    maxTextSize: 30_000,
  });
  let queue = Promise.resolve();
  return {
    default: function Diagram({ code }: { code: string }) {
      const { resolvedTheme } = useUi();
      const id = `mermaid${useId().replace(/[^a-z0-9]/gi, '')}`;
      const [svg, setSvg] = useState('');
      const [failed, setFailed] = useState(false);
      useEffect(() => {
        let active = true;
        queue = queue.then(async () => {
          try {
            mermaid.initialize({
              startOnLoad: false,
              securityLevel: 'strict',
              theme: resolvedTheme === 'dark' ? 'dark' : 'neutral',
              fontFamily: 'system-ui',
              suppressErrorRendering: true,
              maxTextSize: 30_000,
            });
            const { svg } = await mermaid.render(id, code);
            if (active) {
              setSvg(svg);
              setFailed(false);
            }
          } catch {
            if (active) setFailed(true);
          }
        });
        return () => {
          active = false;
        };
      }, [code, id, resolvedTheme]);
      return failed ? (
        <pre className="diagram-fallback">
          <code>{code}</code>
          <small>图表语法不完整，已显示源码</small>
        </pre>
      ) : (
        <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      );
    },
  };
});

// Preserve fenced and inline code; Markdown normally consumes backslash delimiters as escapes.
export function normalizeMath(content: string) {
  const convert = (text: string) =>
    text
      .split(/(`+[^`]*`+)/g)
      .map((part) =>
        part.startsWith('`')
          ? part
          : part
              .replace(/\\\[([\s\S]*?)\\\]/g, (_m, math: string) => `\n$$\n${math.trim()}\n$$\n`)
              .replace(/\\\(([\s\S]*?)\\\)/g, (_m, math: string) => `$${math.trim()}$`),
      )
      .join('');
  let result = '',
    normal = '',
    fence = '';
  for (const line of content.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      result += line;
      if (
        marker?.[0] === fence[0] &&
        marker.length >= fence.length &&
        /^ {0,3}(?:`+|~+)\s*$/.test(line)
      )
        fence = '';
    } else if (marker) {
      result += convert(normal) + line;
      normal = '';
      fence = marker;
    } else normal += line;
  }
  return result + convert(normal);
}
function latexBody(code: string) {
  let body = code.includes('\\begin{document}')
    ? code.split('\\begin{document}')[1].split('\\end{document}')[0]
    : code;
  body = body.replace(/\\(?:documentclass|usepackage)(?:\[[^\]]*\])?\{[^}]*\}/g, '');
  body = body.replace(
    /\\begin\{(equation\*?|align\*?|gather\*?|displaymath)\}([\s\S]*?)\\end\{\1\}/g,
    (_m, env: string, math: string) =>
      `\n$$\n${env.startsWith('align') ? '\\begin{aligned}' + math + '\\end{aligned}' : env.startsWith('gather') ? '\\begin{gathered}' + math + '\\end{gathered}' : math}\n$$\n`,
  );
  if (!/\\\[|\\\(|\$/.test(body)) body = `$$\n${body}\n$$`;
  return normalizeMath(body);
}
function CodeBlock({
  code,
  language,
  children,
  streaming,
}: {
  code: string;
  language: string;
  children: ReactNode;
  streaming: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const latex =
    ['latex', 'tex', 'math'].includes(language) ||
    (['', 'text', 'plaintext'].includes(language) &&
      /\\(?:documentclass|begin\{document\})/.test(code));
  const diagram = language === 'mermaid' && !streaming;
  return (
    <div className="code-container">
      <div className="code-toolbar">
        <span>
          {language || 'text'}
          {latex ? ' · 公式预览' : ''}
        </span>
        <button
          type="button"
          aria-label="复制代码"
          onClick={async () => {
            try {
              await copyText(code);
              setCopied(true);
              setError('');
              setTimeout(() => setCopied(false), 1800);
            } catch {
              setError('复制失败，请选择源码复制');
            }
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? '已复制' : '复制代码'}
        </button>
      </div>
      {error && <small role="status">{error}</small>}
      {latex ? (
        <>
          <div className="latex-preview">
            <MathMarkdown content={latexBody(code)} />
          </div>
          <details>
            <summary>查看 LaTeX 源码</summary>
            <pre>{children}</pre>
          </details>
        </>
      ) : diagram ? (
        <>
          <Suspense fallback={<pre>{children}</pre>}>
            <Mermaid code={code} />
          </Suspense>
          <details>
            <summary>查看 Mermaid 源码</summary>
            <pre>{children}</pre>
          </details>
        </>
      ) : (
        <pre>{children}</pre>
      )}
    </div>
  );
}
function MathMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { trust: false, maxExpand: 1000, maxSize: 20 }]]}
      components={{
        img: () => <span className="muted">[外部图片已省略]</span>,
        a: ({ node: _node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
function nodeText(node: { type: string; value?: string; children?: unknown[] }): string {
  return node.type === 'text'
    ? (node.value ?? '')
    : (node.children ?? [])
        .map((child) => nodeText(child as Parameters<typeof nodeText>[0]))
        .join('');
}
export function Markdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  // Stable renderers preserve code-copy feedback and diagrams when the chat scroll state changes.
  const components = useMemo<Components>(
    () => ({
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      img: () => <span className="muted">[外部图片已省略]</span>,
      pre: ({ node, children }) => {
        const codeNode = node?.children.find(
          (child) => child.type === 'element' && child.tagName === 'code',
        );
        const classes = codeNode?.type === 'element' ? codeNode.properties.className : [];
        const language = Array.isArray(classes)
          ? String(classes.find((c) => String(c).startsWith('language-')) ?? '').replace(
              'language-',
              '',
            )
          : '';
        return (
          <CodeBlock
            code={node ? nodeText(node).replace(/\n$/, '') : ''}
            language={language}
            streaming={streaming}
          >
            {children}
          </CodeBlock>
        );
      },
      table: ({ node: _node, ...props }) => (
        <div className="markdown-table">
          <table {...props} />
        </div>
      ),
    }),
    [streaming],
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { trust: false, maxExpand: 1000, maxSize: 20 }],
          [rehypeHighlight, { detect: false }],
        ]}
        components={components}
      >
        {normalizeMath(content)}
      </ReactMarkdown>
    </div>
  );
}
