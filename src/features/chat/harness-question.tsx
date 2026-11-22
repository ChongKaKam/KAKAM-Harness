import { Markdown } from '../../client/markdown';
import type { HarnessClarification } from '../../shared/types';
import { clarificationText } from '../harness/clarification';

export function HarnessQuestion({
  clarification,
  content,
  respond,
}: {
  clarification: HarnessClarification;
  content: string;
  respond?: (suggestion?: string) => void;
}) {
  const text = clarificationText(clarification);
  const preamble = content.endsWith(text)
    ? content.slice(0, content.length - text.length).trimEnd()
    : content;
  return (
    <>
      {preamble && <Markdown content={preamble} />}
      <section className="harness-question" aria-label="待确认问题">
        <strong>需要你决定</strong>
        <p>{clarification.question}</p>
        {clarification.suggestion && (
          <div>
            <small>初步建议</small>
            <p>{clarification.suggestion}</p>
          </div>
        )}
        {respond && (
          <div className="harness-actions">
            <button className="button" onClick={() => respond()}>
              自行回复
            </button>
            {clarification.suggestion && (
              <button className="button" onClick={() => respond(clarification.suggestion)}>
                用建议起草回复
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
