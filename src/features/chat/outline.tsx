import { useEffect, useRef, useState } from 'react';
import type { Message } from '../../shared/types';
function summary(message: Message) {
  return (
    message.content
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`#*_~>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || `图片提问 · ${message.images.map((image) => image.name).join('、')}`
  ).slice(0, 180);
}
export function ConversationOutline({
  messages,
  active,
  jumpTo,
  conversationId,
}: {
  messages: Message[];
  active: string;
  jumpTo: (id: string) => void;
  conversationId?: string;
}) {
  const questions = messages.filter((message) => message.role === 'user');
  const [preview, setPreview] = useState<{ id: string; top: number }>();
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => setPreview(undefined), [conversationId]);
  useEffect(() => {
    const rail = track.current;
    const current = rail?.querySelector<HTMLElement>('[aria-current]');
    if (!rail || !current) return;
    const bounds = rail.getBoundingClientRect();
    const marker = current.getBoundingClientRect();
    if (marker.top < bounds.top) rail.scrollTop += marker.top - bounds.top;
    else if (marker.bottom > bounds.bottom) rail.scrollTop += marker.bottom - bounds.bottom;
  }, [active, questions.length]);
  if (!questions.length) return null;
  const hovered = questions.find((question) => question.id === preview?.id);
  return (
    <nav
      className="conversation-outline"
      aria-label="本次对话大纲"
      onMouseLeave={() => setPreview(undefined)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setPreview(undefined);
      }}
    >
      <div ref={track} className="outline-track" onScroll={() => setPreview(undefined)}>
        {questions.map((question, index) => (
          <button
            type="button"
            key={question.id}
            aria-label={`问题 ${index + 1}：${summary(question)}`}
            aria-current={question.id === active ? 'location' : undefined}
            aria-describedby={preview?.id === question.id ? 'question-preview' : undefined}
            onMouseEnter={(event) =>
              setPreview({ id: question.id, top: event.currentTarget.getBoundingClientRect().top })
            }
            onFocus={(event) =>
              setPreview({ id: question.id, top: event.currentTarget.getBoundingClientRect().top })
            }
            onBlur={() => setPreview(undefined)}
            onClick={() => jumpTo(question.id)}
          >
            <span className="outline-marker" />
            <span className="outline-index">{index + 1}</span>
          </button>
        ))}
      </div>
      {hovered && preview && (
        <div
          className="outline-preview"
          id="question-preview"
          role="tooltip"
          style={{ top: Math.max(80, Math.min(preview.top, window.innerHeight - 200)) }}
        >
          <strong>问题 {questions.indexOf(hovered) + 1}</strong>
          <p>{summary(hovered)}</p>
        </div>
      )}
    </nav>
  );
}
