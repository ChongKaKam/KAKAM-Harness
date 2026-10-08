import { useState } from 'react';
import { FolderOpen, Settings } from 'lucide-react';
import { Modal } from '../../client/components';
import { useWorkspace } from '../../client/context';
import { ProductionLibrary } from './library';
import './production.css';

export function ChatProductionTopbar() {
  const { user, features, conversationId } = useWorkspace();
  if (!features.some((feature) => feature.id === 'llm-production' && feature.enabled)) return null;
  return (
    <ProductionChatControl
      key={`${user.id}:${conversationId ?? ''}`}
      conversationId={conversationId}
    />
  );
}

export function ProductionChatControl({ conversationId }: { conversationId?: string }) {
  const { user, navigate } = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="button llm-production-chat-trigger"
        aria-label="查看当前聊天产物"
        disabled={!conversationId}
        title={conversationId ? '查看当前聊天产物' : '发送消息后创建产物空间'}
        onClick={() => setOpen(true)}
      >
        <FolderOpen size={16} aria-hidden="true" />
        <span>产物</span>
      </button>
      {open && conversationId && (
        <Modal title="聊天产物空间" className="llm-production-drawer" close={() => setOpen(false)}>
          <p className="llm-production-drawer-description">
            分组内共享产物空间；未分组聊天的产物到期后自动清理。
          </p>
          <div className="llm-production-drawer-links">
            <button type="button" className="button" onClick={() => navigate('llm-production')}>
              <FolderOpen size={16} aria-hidden="true" />
              全部产物
            </button>
            <button
              type="button"
              className="button"
              onClick={() => navigate('settings', 'llm-production')}
            >
              <Settings size={16} aria-hidden="true" />
              产物设置
            </button>
          </div>
          <ProductionLibrary key={`${user.id}:${conversationId}`} conversationId={conversationId} />
        </Modal>
      )}
    </>
  );
}
