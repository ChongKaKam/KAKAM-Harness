import type { MemoryStrategySettingsProps } from '../strategy-ui';
import type { DefaultMemoryConfig } from '../../../shared/memory';

export function DefaultMemorySettings({
  config: supplied,
  defaults: suppliedDefaults,
  disabled,
  onChange,
}: MemoryStrategySettingsProps) {
  const defaults = suppliedDefaults as unknown as DefaultMemoryConfig;
  const config = {
    ...defaults,
    ...supplied,
    scopeLimits: {
      ...defaults.scopeLimits,
      ...(supplied.scopeLimits as DefaultMemoryConfig['scopeLimits'] | undefined),
    },
  } as DefaultMemoryConfig;
  const update = <K extends keyof DefaultMemoryConfig>(key: K, value: DefaultMemoryConfig[K]) =>
    onChange({ ...config, [key]: value });
  const numeric = (
    key:
      | 'candidateLimit'
      | 'similarityThreshold'
      | 'recentDays'
      | 'maxItems'
      | 'maxBytes'
      | 'timeoutMs',
    label: string,
    min: number,
    max: number,
    step = 1,
  ) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        required
        value={config[key]}
        onChange={(event) => update(key, Number(event.target.value))}
      />
    </label>
  );
  return (
    <fieldset className="memory-strategy-fields" disabled={disabled}>
      <legend>Default · 向量候选 + LLM 选择</legend>
      <p className="muted">
        先用 embedding 与 pgvector 检索候选，再由 LLM 按 Prompt 选择已有记忆。权限、范围与注入预算由
        Memory Manager 执行。
      </p>
      <div className="memory-form-grid">
        {numeric('candidateLimit', '检索候选数量', 1, 120)}
        {numeric('similarityThreshold', '最低余弦相似度', -1, 1, 0.01)}
        {numeric('recentDays', '近期偏好窗口（天）', 1, 3650)}
        {numeric('maxItems', '最多注入条数', 1, 32)}
        {numeric('maxBytes', '注入预算（UTF-8 字节）', 500, 32000)}
        {numeric('timeoutMs', '召回总超时（毫秒）', 1000, 120000)}
      </div>
      <p className="memory-caption">
        近期窗口用于召回排序，不会删除更旧的长期记忆。预算包含注入标记与换行。
      </p>
      <div className="memory-form-grid">
        {(['user', 'group', 'session'] as const).map((scope) => (
          <label key={scope}>
            {{ user: '长期', group: '分组', session: 'Session' }[scope]}记忆配额
            <input
              type="number"
              min={0}
              max={32}
              required
              value={config.scopeLimits[scope]}
              onChange={(event) =>
                update('scopeLimits', {
                  ...config.scopeLimits,
                  [scope]: Number(event.target.value),
                })
              }
            />
          </label>
        ))}
        <label>
          LLM 选择失败时
          <select
            value={config.fallback}
            onChange={(event) =>
              update('fallback', event.target.value as DefaultMemoryConfig['fallback'])
            }
          >
            <option value="vector">采用向量候选（仍受范围与预算限制）</option>
            <option value="skip">本轮跳过记忆，继续回答</option>
          </select>
        </label>
      </div>
      <label>
        检索 Prompt
        <textarea
          className="memory-prompt-editor"
          rows={10}
          minLength={20}
          maxLength={20000}
          required
          value={config.recallPrompt}
          onChange={(event) => update('recallPrompt', event.target.value)}
        />
      </label>
      <p className="memory-caption">
        保留 {'{{context}}'} 与 {'{{candidates}}'} 占位符，可用 {'{{maxItems}}'}。输出 JSON selected
        数组，每项为候选 id 和 reason。
      </p>
      <button
        type="button"
        className="button"
        onClick={() => update('recallPrompt', defaults.recallPrompt)}
      >
        恢复默认检索 Prompt
      </button>
      <label>
        抽取 Prompt
        <textarea
          className="memory-prompt-editor"
          rows={10}
          minLength={20}
          maxLength={20000}
          required
          value={config.extractPrompt}
          onChange={(event) => update('extractPrompt', event.target.value)}
        />
      </label>
      <p className="memory-caption">
        保留 {'{{context}}'}。输出 JSON memories 数组，每项包含 scope、kind、content、evidence 和
        tags；写入模式由上方设置决定。
      </p>
      <button
        type="button"
        className="button"
        onClick={() => update('extractPrompt', defaults.extractPrompt)}
      >
        恢复默认抽取 Prompt
      </button>
    </fieldset>
  );
}
