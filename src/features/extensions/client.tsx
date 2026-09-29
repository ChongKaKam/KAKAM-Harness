import { useState, type FormEvent } from 'react';
import { Puzzle, Globe, ArrowUpRight } from 'lucide-react';
import { api, patch } from '../../client/api';
import { PageHeader, ErrorNote, Spinner, Empty, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { usePatternColors } from '../../client/color-pattern';
import type { ExtensionInfo, ExtensionPolicy, Model } from '../../shared/types';
import './extensions.css';
export function ExtensionsPage() {
  const { features, navigate, refresh, notify } = useWorkspace();
  const colors = usePatternColors();
  const { data, error, reload } = useLoad(async () => {
    const [capabilities, models] = await Promise.all([
      api<(ExtensionInfo & { policy: ExtensionPolicy })[]>('/admin/extensions'),
      api<Model[]>('/models?kind=all'),
    ]);
    return { capabilities, models };
  }, [features.map((f) => `${f.id}:${f.enabled}`).join(',')]);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState('');
  async function save(id: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(id);
    setFailure('');
    try {
      await patch(`/admin/extensions/${id}`, {
        enabled: form.has('enabled'),
        strategy: form.get('strategy'),
        llmModelId: form.get('llmModelId') || null,
        decisionModelId: form.get('decisionModelId') || null,
      });
      reload();
      notify('拓展能力配置已保存');
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="page extensions-page">
      <PageHeader
        eyebrow="LLM CAPABILITIES"
        title="拓展能力"
        description="统一管理对话中的能力。每次发送可选择自动、开启或关闭。"
      />
      <ErrorNote text={error || failure} />
      <p className="notice">
        Auto 由模型判断；On 始终执行；Off
        不执行。辅助模型从模型管理中选择，每次调用均按当前用户的授权校验并记录用量。
      </p>
      {!data && !error && <Spinner />}
      {data?.capabilities.map((item) => (
        <section
          className="panel pattern-card extensions-card"
          style={colors.style({ key: item.id })}
          key={item.id}
        >
          <div className="row">
            <Globe size={21} />
            <h2 className="grow">{item.name}</h2>
            <span className="badge">{item.ready ? '已配置' : '待配置'}</span>
          </div>
          <p className="muted">{item.description}</p>
          <button className="button" onClick={() => navigate('settings', item.settingsId)}>
            插件设置 <ArrowUpRight size={15} />
          </button>
          <form onSubmit={(event) => void save(item.id, event)}>
            <fieldset disabled={!!busy}>
              <label className="check-row">
                <input type="checkbox" name="enabled" defaultChecked={item.policy.enabled} />
                允许在聊天中使用
              </label>
              <label>
                Auto 决策方式
                <select name="strategy" defaultValue={item.policy.strategy}>
                  <option value="llm">LLM → JSON</option>
                  <option value="llm-jev">LLM 英文预处理 → Jev → JSON</option>
                </select>
              </label>
              <label>
                辅助 LLM
                <select name="llmModelId" defaultValue={item.policy.llmModelId ?? ''}>
                  <option value="">跟随本次聊天模型</option>
                  {item.policy.llmModelId &&
                    !data.models.some((m) => m.id === item.policy.llmModelId) && (
                      <option value={item.policy.llmModelId}>原模型已不可用，请重新选择</option>
                    )}
                  {data.models
                    .filter((m) => m.kind === 'llm')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.providerName}
                      </option>
                    ))}
                </select>
              </label>
              <p className="small muted">
                用于自动判断、英文预处理和搜索词生成；普通用户也需要该模型的授权。
              </p>
              <label>
                Jev 决策模型
                <select name="decisionModelId" defaultValue={item.policy.decisionModelId ?? ''}>
                  <option value="">未选择（仅 LLM + Jev 需要）</option>
                  {item.policy.decisionModelId &&
                    !data.models.some((m) => m.id === item.policy.decisionModelId) && (
                      <option value={item.policy.decisionModelId}>
                        原模型已不可用，请重新选择
                      </option>
                    )}
                  {data.models
                    .filter((m) => m.kind === 'jev')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {m.providerName}
                      </option>
                    ))}
                </select>
              </label>
              <button className="button primary" disabled={!!busy}>
                {busy === item.id ? '保存中…' : '保存能力配置'}
              </button>
            </fieldset>
          </form>
        </section>
      ))}
      {features
        .filter((f) => f.capability && !f.enabled)
        .map((item) => (
          <section className="panel extensions-card" key={item.id}>
            <h2>
              <Puzzle size={20} /> {item.name}
            </h2>
            <p className="muted">插件已停用，已有配置保留。</p>
            <button
              className="button"
              disabled={!!busy}
              onClick={async () => {
                setBusy(item.id);
                setFailure('');
                try {
                  await patch(`/features/${item.id}`, { enabled: true });
                  await refresh();
                  reload();
                } catch (error) {
                  setFailure((error as Error).message);
                } finally {
                  setBusy('');
                }
              }}
            >
              启用插件
            </button>
          </section>
        ))}
      {data && !data.capabilities.length && !features.some((f) => f.capability) && (
        <Empty title="暂无托管能力">启用拓展插件后会在这里显示。</Empty>
      )}
    </div>
  );
}
