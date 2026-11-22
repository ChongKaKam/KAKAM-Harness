import type { ReactNode } from 'react';
import { Activity, ChevronDown } from 'lucide-react';
import type { Message } from '../../shared/types';

const statuses: Record<string, string> = {
  running: '进行中',
  complete: '已完成',
  error: '失败',
  skipped: '已跳过',
  cancelled: '已停止',
};

export function HarnessProgress({
  run,
  taskId,
  children,
}: {
  run: NonNullable<Message['harnessRun']>;
  taskId: string;
  children?: ReactNode;
}) {
  const latest = run.steering.at(-1);
  return (
    <details className="harness-progress">
      <summary>
        <Activity size={15} aria-hidden="true" />
        <span role="status" title={run.detail}>
          {run.detail}
        </span>
        {latest && <small>{latest.applied ? '补充已应用' : '补充已收到'}</small>}
        <ChevronDown size={14} aria-hidden="true" className="harness-progress-chevron" />
      </summary>
      <div className="harness-progress-body">
        <small>
          任务 ID <code>{taskId}</code>
        </small>
        {run.steps.length > 0 && (
          <ol aria-label="运行步骤">
            {run.steps.map((step, index) => (
              <li key={index}>
                {step.label} <small>{statuses[step.status] ?? step.status}</small>
              </li>
            ))}
          </ol>
        )}
        {run.steering.length > 0 && (
          <ul aria-label="本轮补充">
            {run.steering.map((item) => (
              <li key={item.id}>
                {item.content}{' '}
                <small>{item.receipt ?? (item.applied ? '已应用' : '已收到，待处理')}</small>
              </li>
            ))}
          </ul>
        )}
        {children}
      </div>
    </details>
  );
}
