import { useState } from 'react';
import { FolderOpen, Settings } from 'lucide-react';
import { api } from '../../client/api';
import { ErrorNote, PageHeader, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { ProductionLibrary } from './library';
import type { ProductionSettings, ProductionSpace } from './types';
import { productionBytes } from './presentation';
import './production.css';

export function ProductionPage() {
  const { user } = useWorkspace();
  return <ProductionPageContent key={user.id} />;
}

function ProductionPageContent() {
  const { navigate } = useWorkspace();
  const [scope, setScope] = useState('all');
  const { data, error, reload } = useLoad(async () => {
    const [spaces, settings] = await Promise.all([
      api<ProductionSpace[]>('/llm-production/spaces'),
      api<ProductionSettings>('/llm-production/settings'),
    ]);
    return { spaces, settings };
  });
  const [scopeKind, scopeId] = scope.split(':');
  return (
    <div className="page llm-production-page">
      <PageHeader
        eyebrow="PRODUCTION SPACE"
        title="产物空间"
        description="统一管理聊天生成的文件与图片，查看来源、下载或清理。"
        action={
          <button
            type="button"
            className="button"
            onClick={() => navigate('settings', 'llm-production')}
          >
            <Settings size={16} aria-hidden="true" />
            产物设置
          </button>
        }
      />
      <ErrorNote text={error} />
      {!data && !error && <Spinner />}
      {data && (
        <>
          <div className="llm-production-overview">
            <FolderOpen size={20} aria-hidden="true" />
            <div>
              <strong>{data.spaces.length} 个空间</strong>
              <p>
                已用 {productionBytes(data.settings.storage.usedBytes)} /{' '}
                {productionBytes(data.settings.storage.limitBytes)}
              </p>
            </div>
            <span className="llm-production-generation-state">
              {data.settings.preferences.enabled ? '生成已启用' : '生成已关闭'}
            </span>
          </div>
          <div className="llm-production-guide">
            <p>
              选择已启用工具调用的聊天模型，再提出具体要求，例如「将结果生成 Excel
              文件供我下载」或「生成一张产品插画」。输入栏可选择「必须产物」，本轮按真实文件检查交付。
            </p>
            <p>
              未分组聊天拥有独立临时空间，产物保留{' '}
              {data.settings.preferences.temporaryRetentionDays}{' '}
              天；同一分组内的聊天共享空间，默认不过期。所有产物仅自己可见。
            </p>
            <button type="button" className="button" onClick={() => navigate('chat')}>
              前往聊天
            </button>
          </div>
          <label className="llm-production-space-filter">
            产物空间
            <select
              aria-label="产物空间"
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="all">全部空间</option>
              {data.spaces
                .filter((item) => item.kind !== 'orphan')
                .map((item) => (
                  <option key={`${item.kind}:${item.id}`} value={`${item.kind}:${item.id}`}>
                    {item.kind === 'group' ? '分组' : '对话'} · {item.name}（{item.artifactCount}）
                  </option>
                ))}
            </select>
          </label>
          <ProductionLibrary
            key={scope}
            conversationId={scopeKind === 'conversation' ? scopeId : undefined}
            groupId={scopeKind === 'group' ? scopeId : undefined}
            showSpace={scope === 'all'}
            refreshed={reload}
          />
        </>
      )}
      {error && !data && (
        <button type="button" className="button" onClick={reload}>
          重新加载
        </button>
      )}
    </div>
  );
}
