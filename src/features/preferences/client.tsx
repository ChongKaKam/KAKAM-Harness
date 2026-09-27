import { useRef, useState, type ChangeEvent } from 'react';
import { Monitor, Moon, Sun, Upload } from 'lucide-react';
import { colorPatterns } from '../../shared/appearance';
import { usePatternColors } from '../../client/color-pattern';
import { PageHeader, ErrorNote } from '../../client/components';
import { AssistantAvatar, useUi } from '../../client/ui-preferences';
import type { UiPreferences } from '../../shared/types';
import { fontSizes, defaultFontSize } from '../../shared/typography';
import { Markdown } from '../../client/markdown';
export function PreferencesPage() {
  const { preferences, save, fontSize, setFontSize } = useUi();
  const colors = usePatternColors();
  const [fontError, setFontError] = useState('');
  function chooseFont(value: typeof fontSize) {
    setFontError(setFontSize(value) ? '' : '字号已生效，但浏览器未允许保存；刷新后可能恢复默认。');
  }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  async function update(value: UiPreferences) {
    setBusy(true);
    setError('');
    try {
      await save(value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const image = e.target.files?.[0];
    e.target.value = '';
    if (!image) return;
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(image.type) ||
      image.size > 512 * 1024
    ) {
      setError('请选择 512 KB 以内的 PNG、JPEG 或 WebP 图片');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => void update({ ...preferences, assistantIcon: String(reader.result) });
    reader.onerror = () => setError('图片读取失败');
    reader.readAsDataURL(image);
  }
  return (
    <div className="page preferences-page">
      <PageHeader
        eyebrow="MAKE IT YOURS"
        title="通用设置"
        description="调整文字、外观和对话头像，让空间更适合你。"
      />
      <ErrorNote text={error} />
      <section className="panel preferences-section font-settings">
        <div className="font-setting-heading">
          <h3>字体大小</h3>
          <button
            className="button"
            disabled={fontSize === defaultFontSize}
            onClick={() => chooseFont(defaultFontSize)}
          >
            恢复默认字号
          </button>
        </div>
        <p className="muted">立即调整文字大小，保留视觉层级。仅保存在当前设备，并按账户区分。</p>
        <div className="font-options" role="radiogroup" aria-label="字体大小">
          {fontSizes.map((item) => (
            <button
              type="button"
              role="radio"
              key={item.id}
              aria-label={`${item.name} ${item.percent}`}
              aria-checked={fontSize === item.id}
              className={`font-option ${fontSize === item.id ? 'selected' : ''}`}
              onClick={() => chooseFont(item.id)}
            >
              <strong>{item.name}</strong>
              <span>
                {item.percent}
                {item.id === defaultFontSize ? ' · 默认' : ''}
              </span>
            </button>
          ))}
        </div>
        <ErrorNote text={fontError} />
        <div className="font-preview" aria-label="字号效果预览">
          <p className="font-preview-title">让想法清晰可见</p>
          <div className="message-author">
            <AssistantAvatar />
            <strong>Chatbot</strong>
            <span>效果预览</span>
          </div>
          <Markdown
            content={
              '这是一段聊天正文。**重点内容**、表格、代码与公式会保持各自的比例。\n\n| 内容 | 示例 |\n| --- | --- |\n| 行内公式 | $E=mc^2$ |\n\n```javascript\nconst idea = "从一个问题开始";\n```'
            }
          />
          <p className="font-preview-caption">辅助说明始终不小于 12px。</p>
          <input aria-label="输入文字预览" placeholder="在这里试试输入文字…" />
        </div>
      </section>
      <section className="panel preferences-section">
        <h3>界面外观</h3>
        <p className="muted">选择白天、黑夜，或跟随设备的系统设置。</p>
        <div className="theme-options" role="radiogroup" aria-label="界面主题">
          {(
            [
              { value: 'light', label: '白天', icon: Sun },
              { value: 'dark', label: '黑夜', icon: Moon },
              { value: 'system', label: '跟随系统', icon: Monitor },
            ] as const
          ).map((item) => (
            <button
              key={item.value}
              role="radio"
              aria-checked={preferences.theme === item.value}
              disabled={busy}
              className={`theme-option ${preferences.theme === item.value ? 'selected' : ''}`}
              onClick={() => update({ ...preferences, theme: item.value })}
            >
              <item.icon size={24} />
              <span>{item.label}</span>
              <span className={`theme-swatch ${item.value}`}>
                <i />
                <i />
                <i />
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="panel preferences-section color-pattern-settings">
        <h3>Color Pattern</h3>
        <p className="muted">选择一组颜色，让卡片与对话各有个性。页面框架和文字保持中性色。</p>
        <div className="pattern-tabs" role="tablist" aria-label="Color Pattern">
          {colorPatterns.list().map((pattern) => (
            <button
              type="button"
              role="tab"
              key={pattern.id}
              id={`pattern-tab-${pattern.id}`}
              aria-controls={`pattern-panel-${pattern.id}`}
              aria-selected={preferences.colorPattern === pattern.id}
              tabIndex={preferences.colorPattern === pattern.id ? 0 : -1}
              disabled={busy}
              onClick={() => update({ ...preferences, colorPattern: pattern.id })}
              onKeyDown={(event) => {
                const all = colorPatterns.list();
                const index = all.findIndex((item) => item.id === pattern.id);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % all.length
                    : event.key === 'ArrowLeft'
                      ? (index + all.length - 1) % all.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? all.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                document.getElementById(`pattern-tab-${all[next].id}`)?.focus();
                void update({ ...preferences, colorPattern: all[next].id });
              }}
            >
              {pattern.name}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`pattern-panel-${colors.pattern.id}`}
          aria-labelledby={`pattern-tab-${colors.pattern.id}`}
          tabIndex={0}
          className="pattern-panel"
        >
          <p className="muted">{colors.pattern.description}</p>
          <div className="pattern-colors">
            {colors.pattern.colors.map((color) => (
              <div className="pattern-color" key={color.id}>
                <span className="pattern-swatch" style={{ background: color.color }} />
                <span>
                  {color.name}
                  <small>{color.original}</small>
                </span>
              </div>
            ))}
          </div>
          <div className="pattern-preview-grid" aria-label="组件配色预览">
            {['灵感笔记', '阅读计划', '下一次对话'].map((title, index) => (
              <div
                className="pattern-card"
                key={title}
                style={colors.style({ key: 'home-ideas', index: index * 3 })}
              >
                <span className="pattern-preview-mark" />
                <strong>{title}</strong>
                <p>给想法留一点颜色。</p>
              </div>
            ))}
          </div>
          <p className="small muted">
            此色系已应用。对话列表和提示词卡片上的调色板按钮可单独选色，或恢复自动配色。
          </p>
        </div>
      </section>
      <section className="panel preferences-section">
        <h3>Chatbot 头像</h3>
        <p className="muted">为你的对话伙伴选择一个图标。PNG、JPEG 或 WebP，最大 512 KB。</p>
        <div className="avatar-setting">
          <AssistantAvatar />
          <div>
            <strong>Chatbot</strong>
            <p className="muted small">应用于你看到的所有模型回复</p>
          </div>
          <span className="grow" />
          <input
            ref={file}
            type="file"
            aria-label="上传 Chatbot 头像"
            hidden
            accept="image/png,image/jpeg,image/webp"
            onChange={upload}
          />
          <button className="button" disabled={busy} onClick={() => file.current?.click()}>
            <Upload size={15} />
            上传图标
          </button>
          <button
            className="button"
            disabled={busy || !preferences.assistantIcon}
            onClick={() => update({ ...preferences, assistantIcon: null })}
          >
            恢复默认
          </button>
        </div>
      </section>
    </div>
  );
}
