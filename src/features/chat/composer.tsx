import {
  NodeViewWrapper,
  NodeViewContent,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from '@tiptap/react';
import CodeBlock from '@tiptap/extension-code-block';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { EditorContent, InputRule, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown as MarkdownExtension } from '@tiptap/markdown';
import { InlineMath, BlockMath } from '@tiptap/extension-mathematics';
import { TableKit } from '@tiptap/extension-table';
import Placeholder from '@tiptap/extension-placeholder';
import { Bold, List, Code2, Sigma, Table2, Undo2 } from 'lucide-react';
import { Markdown, normalizeMath } from '../../client/markdown';
import { Modal } from '../../client/components';

function ComposerCodeBlock({ node, updateAttributes, editor }: NodeViewProps) {
  const language = String(node.attrs.language ?? '');
  const preview = ['mermaid', 'latex', 'tex', 'math'].includes(language);
  return (
    <NodeViewWrapper className="composer-code-node">
      <div className="composer-code-header" contentEditable={false}>
        <span>代码</span>
        <input
          aria-label="代码语言"
          placeholder="语言，如 javascript"
          value={language}
          disabled={!editor.isEditable}
          onChange={(event) => updateAttributes({ language: event.target.value })}
        />
      </div>
      <pre>
        <NodeViewContent<'code'> as="code" />
      </pre>
      {preview && (
        <div className="composer-code-preview" contentEditable={false}>
          <Markdown content={'```' + language + '\n' + node.textContent + '\n```'} />
        </div>
      )}
    </NodeViewWrapper>
  );
}
const LiveCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(ComposerCodeBlock);
  },
});

// Use the same math delimiters in typed text, pasted Markdown and sent messages.
const LiveInlineMath = InlineMath.extend({
  addInputRules() {
    return [/(?<!\$)\$([^$\n]+)\$$/, /\\\(([^\n]+?)\\\)$/].map(
      (find) =>
        new InputRule({
          find,
          handler: ({ state, range, match }) => {
            state.tr.replaceWith(range.from, range.to, this.type.create({ latex: match[1] }));
          },
        }),
    );
  },
});
const LiveBlockMath = BlockMath.extend({
  addInputRules() {
    return [/^\$\$([^$]+)\$\$$/, /^\\\[([\s\S]+?)\\\]$/].map(
      (find) =>
        new InputRule({
          find,
          handler: ({ state, range, match }) => {
            const $from = state.doc.resolve(range.from);
            state.tr.replaceRangeWith(
              $from.before(),
              $from.after(),
              this.type.create({ latex: match[1] }),
            );
          },
        }),
    );
  },
});
export interface ComposerHandle {
  focus: () => void;
}
interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  ref?: Ref<ComposerHandle>;
}
export function LiveComposer({ value, onChange, onSend, disabled, ref }: Props) {
  const callbacks = useRef({ onChange, onSend, disabled });
  callbacks.current = { onChange, onSend, disabled };
  const lastValue = useRef(value);
  const restoreEditorFocus = useRef(false);
  const [math, setMath] = useState<{ latex: string; block: boolean; pos?: number }>();
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false }, underline: false, codeBlock: false }),
      LiveCodeBlock,
      MarkdownExtension.configure({ markedOptions: { gfm: true, breaks: true } }),
      Placeholder.configure({ placeholder: '在这里开始你的想法…' }),
      TableKit,
      LiveInlineMath.configure({
        katexOptions: { throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20 },
        onClick: (node, pos) => {
          if (!callbacks.current.disabled) setMath({ latex: node.attrs.latex, block: false, pos });
        },
      }),
      LiveBlockMath.configure({
        katexOptions: {
          displayMode: true,
          throwOnError: false,
          trust: false,
          maxExpand: 1000,
          maxSize: 20,
        },
        onClick: (node, pos) => {
          if (!callbacks.current.disabled) setMath({ latex: node.attrs.latex, block: true, pos });
        },
      }),
    ],
    content: normalizeMath(value),
    contentType: 'markdown',
    editable: !disabled,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': '消息',
        'aria-multiline': 'true',
        class: 'live-composer markdown',
      },
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text || !editor) return false;
        if (editor.isActive('codeBlock')) editor.commands.insertContent({ type: 'text', text });
        else editor.commands.insertContent(normalizeMath(text), { contentType: 'markdown' });
        return true;
      },
      handleKeyDown: (view, event) => {
        if (event.key !== 'Enter' || event.isComposing || view.composing || event.keyCode === 229)
          return false;
        if (callbacks.current.disabled) return true;
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          callbacks.current.onSend();
          return true;
        }
        if (!event.shiftKey && (editor?.isActive('inlineMath') || editor?.isActive('blockMath'))) {
          const block = editor.isActive('blockMath');
          setMath({
            block,
            latex: editor.getAttributes(block ? 'blockMath' : 'inlineMath').latex,
            pos: view.state.selection.from,
          });
          return true;
        }
        // Structured blocks need Enter for continuing lists, table cells and code.
        if (
          event.shiftKey ||
          !matchMedia('(min-width: 761px)').matches ||
          editor?.isActive('listItem') ||
          editor?.isActive('codeBlock') ||
          editor?.isActive('table')
        )
          return false;
        event.preventDefault();
        callbacks.current.onSend();
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const next = editor.getMarkdown();
      lastValue.current = next;
      callbacks.current.onChange(next);
    },
  });
  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        editor?.commands.focus('end');
      },
    }),
    [editor],
  );
  useEffect(() => {
    // Changing editability is not a draft edit; emitting an update here can restore a sent draft.
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);
  useEffect(() => {
    // Mobile browsers cannot focus the editor while the modal makes it inert.
    if (!math && restoreEditorFocus.current && editor) {
      restoreEditorFocus.current = false;
      editor.commands.focus();
    }
  }, [editor, math]);
  useEffect(() => {
    if (!editor || value === lastValue.current) return;
    lastValue.current = value;
    editor.commands.setContent(normalizeMath(value), {
      contentType: 'markdown',
      emitUpdate: false,
    });
  }, [editor, value]);
  return (
    <>
      <div className="composer-format" role="toolbar" aria-label="文本格式">
        <button
          type="button"
          disabled={disabled}
          aria-label="插入粗体"
          title="粗体 · ⌘/Ctrl B"
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Bold size={15} />
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="插入列表"
          title="列表"
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <List size={16} />
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="插入代码块"
          title="代码块"
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
        >
          <Code2 size={16} />
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="插入公式"
          title="公式"
          onClick={() => setMath({ latex: '', block: false })}
        >
          <Sigma size={16} />
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-label="插入表格"
          title="表格"
          onClick={() =>
            editor?.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()
          }
        >
          <Table2 size={15} />
        </button>
        <span className="grow" />
        <button
          type="button"
          disabled={disabled}
          aria-label="撤销编辑"
          title="撤销 · ⌘/Ctrl Z"
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Undo2 size={15} />
        </button>
      </div>
      <EditorContent editor={editor} />
      {math && (
        <Modal
          title={math.pos === undefined ? '插入公式' : '编辑公式'}
          close={() => setMath(undefined)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!math.latex.trim() || !editor) return;
              if (math.pos === undefined) {
                editor.commands.insertContent({
                  type: math.block ? 'blockMath' : 'inlineMath',
                  attrs: { latex: math.latex },
                });
              } else {
                const options = { pos: math.pos, latex: math.latex };
                if (math.block) editor.commands.updateBlockMath(options);
                else editor.commands.updateInlineMath(options);
                // Continue after the edited formula, instead of replacing a selected math node.
                const after = math.pos + 1;
                if (math.block && !editor.state.doc.nodeAt(after)?.isTextblock)
                  editor.commands.insertContentAt(after, { type: 'paragraph' });
                editor.commands.setTextSelection(math.block ? after + 1 : after);
              }
              restoreEditorFocus.current = true;
              setMath(undefined);
            }}
          >
            <label>
              LaTeX 公式
              <input
                autoFocus
                required
                value={math.latex}
                onChange={(e) => setMath({ ...math, latex: e.target.value })}
                placeholder="例如 x^2 + y^2 = z^2"
              />
            </label>
            {math.pos === undefined && (
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={math.block}
                  onChange={(e) => setMath({ ...math, block: e.target.checked })}
                />
                独立成行
              </label>
            )}
            <div className="formula-live-preview">
              <Markdown content={`$$\n${math.latex}\n$$`} />
            </div>
            <div className="modal-actions">
              <button className="button primary">应用公式</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
