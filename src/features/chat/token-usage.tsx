import { Gauge } from 'lucide-react';
import { Tooltip } from '../../client/tooltip';
import type { Message } from '../../shared/types';
import './token-usage.css';

export function TokenUsage({ message }: { message: Message }) {
  const usage = message.usage;
  const number = (value: number) => value.toLocaleString('zh-CN');
  return (
    <Tooltip
      label="Token 消耗"
      className="copy-button chat-token-trigger"
      content={
        <>
          <strong>本次回复 · Token 消耗</strong>
          {!!message.extensions?.length && (
            <p>此处为最终回答用量；辅助模型和检索调用见上方拓展详情，也计入统计。</p>
          )}
          {usage ? (
            <>
              <dl className="chat-token-counts">
                <div>
                  <dt>输入</dt>
                  <dd>{number(usage.input)}</dd>
                </div>
                <div>
                  <dt>输出</dt>
                  <dd>{number(usage.output)}</dd>
                </div>
                <div>
                  <dt>合计</dt>
                  <dd>{number(usage.total)}</dd>
                </div>
              </dl>
              <p>供应商上报值；输入包含本轮携带的历史上下文及缓存 Token。</p>
              {message.status !== 'complete' && <p>回复未完成，显示截至中断时已上报的用量。</p>}
            </>
          ) : (
            <p>供应商未上报用量，或此历史回复没有用量记录。</p>
          )}
        </>
      }
    >
      <Gauge size={14} aria-hidden="true" />
      <span>{usage ? `${number(usage.total)} tokens` : '用量未上报'}</span>
    </Tooltip>
  );
}
