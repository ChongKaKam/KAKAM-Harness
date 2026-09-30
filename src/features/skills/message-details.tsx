import type { Message } from '../../shared/types';
import './skills.css';
export function SkillDetails({ message }: { message: Message }) {
  if (!message.skills?.length) return null;
  return (
    <details className="skills-details">
      <summary>
        {message.role === 'user' ? '已选择 Skill' : 'Skill 载入记录'} · {message.skills.length} 项
      </summary>
      <div className="skills-details-content">
        {message.skills.map((skill) => (
          <p key={skill.id}>
            {skill.title} · v{skill.version} · {skill.scope === 'turn' ? '仅本轮' : '本对话'}
          </p>
        ))}
        {message.skillReads?.map((read, i) => (
          <p key={i}>
            已读取 {read.path} · {read.title} v{read.version} · {read.offset}–
            {read.offset + read.characters} 字符
          </p>
        ))}
        {message.calls?.map((call) => (
          <p key={call.id}>
            {call.stage} ·{' '}
            {call.status === 'streaming'
              ? '生成中'
              : call.status === 'complete'
                ? '完成'
                : call.status === 'cancelled'
                  ? '已停止'
                  : '失败'}{' '}
            ·{' '}
            {call.usage
              ? `输入 ${call.usage.input} / 输出 ${call.usage.output} / 合计 ${call.usage.total} tokens`
              : '用量未上报'}
          </p>
        ))}
        {message.role === 'assistant' && message.status === 'error' && (
          <p>本轮未完成，以上仅列出已读取的文档。</p>
        )}
      </div>
    </details>
  );
}
