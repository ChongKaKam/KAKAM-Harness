import { useEffect, useState } from 'react';
import { api } from '../../client/api';
import type { WorkspaceApproval } from '../harness/types';

export function HarnessApprovalNotice({
  conversationId,
  lastMessageStatus,
  notificationRevision,
  open,
}: {
  conversationId: string;
  lastMessageStatus: string;
  notificationRevision: number;
  open: () => void;
}) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let sequence = 0;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') return;
      const current = ++sequence;
      try {
        const approvals = await api<WorkspaceApproval[]>(
          `/conversations/${conversationId}/workspace/requests`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted && sequence === current)
          setCount(approvals.filter((item) => item.status === 'pending').length);
      } catch {
        if (!controller.signal.aborted && sequence === current) setCount(0);
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [conversationId, lastMessageStatus, notificationRevision]);
  return count ? (
    <button className="button" onClick={open}>
      待处理文件请求（{count}）
    </button>
  ) : null;
}
