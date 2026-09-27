import { useEffect, useRef, useState } from 'react';
import type { Message, StreamEvent } from '../../shared/types';

// Browser connections are replaceable viewers. Generation belongs to the server.
export function useConversation(
  id: string | undefined,
  revision: number,
  onComplete: () => Promise<void>,
) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState('');
  const previousId = useRef<string | undefined>(undefined);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  useEffect(() => {
    if (previousId.current !== id) setMessages([]);
    previousId.current = id;
    setError('');
    if (!id) {
      setLoading(false);
      setReconnecting(false);
      return;
    }
    let disposed = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const disconnect = () => {
      clearTimeout(timer);
      controller?.abort();
    };
    const connect = async () => {
      disconnect();
      if (disposed || document.visibilityState === 'hidden') return;
      if (!navigator.onLine) {
        setLoading(false);
        setReconnecting(true);
        return;
      }
      const current = new AbortController();
      controller = current;
      let terminal = false;
      let receivedSnapshot = false;
      try {
        const response = await fetch('/api/conversations/' + id + '/events', {
          signal: current.signal,
        });
        if (!response.ok) {
          if (response.status === 401) window.dispatchEvent(new Event('kh:unauthorized'));
          if ([401, 403, 404].includes(response.status)) {
            setError((await response.json()).error ?? '对话暂不可用');
            setLoading(false);
            setReconnecting(false);
            return;
          }
          throw new Error('连接暂时不可用');
        }
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (current.signal.aborted || disposed) return;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!frame.startsWith('data: ')) continue;
            const event = JSON.parse(frame.slice(6)) as StreamEvent;
            if (event.type === 'snapshot') {
              receivedSnapshot = true;
              terminal = !event.messages.some((message) => message.status === 'streaming');
              setMessages(event.messages);
              setLoading(false);
              setReconnecting(false);
              failures = 0;
            } else if (event.type === 'delta') {
              setMessages((previous) =>
                previous.map((message) =>
                  message.id === event.messageId
                    ? { ...message, content: message.content + event.text }
                    : message,
                ),
              );
            } else if (event.type === 'done') {
              terminal = true;
              setMessages((previous) =>
                previous.map((message) =>
                  message.id === event.message.id ? event.message : message,
                ),
              );
              void complete.current().catch(() => {});
            } else if (event.type === 'error') setError(event.message);
          }
        }
        if (!receivedSnapshot || !terminal) throw new Error('订阅已断开');
      } catch {
        if (disposed || current.signal.aborted) return;
        setLoading(false);
        setReconnecting(true);
        timer = setTimeout(() => void connect(), Math.min(1000 * 2 ** failures++, 10_000));
      }
    };
    const resume = () => {
      if (document.visibilityState !== 'hidden') void connect();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') disconnect();
      else resume();
    };
    const offline = () => {
      disconnect();
      setReconnecting(true);
      setLoading(false);
    };
    setLoading(true);
    void connect();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    return () => {
      disposed = true;
      disconnect();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', offline);
    };
  }, [id, revision]);
  return { messages, loading, reconnecting, error };
}
