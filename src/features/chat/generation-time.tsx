import { Clock3 } from 'lucide-react';
import type { Message } from '../../shared/types';
import './generation-time.css';

export function GenerationTime({ message }: { message: Message }) {
  const duration = message.durationMs;
  if (
    message.status === 'streaming' ||
    duration == null ||
    !Number.isFinite(duration) ||
    duration < 0
  )
    return null;
  const seconds = duration < 100 ? '< 0.1' : (duration / 1000).toFixed(1);
  return (
    <small className="chat-generation-time" title="从服务器发起模型请求到结束，包含等待与生成。">
      <Clock3 size={14} aria-hidden="true" />
      {message.status === 'complete' ? '用时' : '已用时'} {seconds} 秒
    </small>
  );
}
