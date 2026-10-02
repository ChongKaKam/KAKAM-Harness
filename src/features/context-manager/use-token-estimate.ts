import { useEffect, useMemo, useState } from 'react';
import type { ContextSnapshot } from './types';
import {
  tokenEstimateCharacterLimit,
  tokenEstimateLimitMessage,
  type TokenEstimate,
  type TokenEstimateInput,
  type TokenEstimateResult,
} from './token-estimate-types';

export function useTokenEstimate(snapshot: ContextSnapshot) {
  const [revision, setRevision] = useState(0);
  // Unchanged polling snapshots must not restart the tokenizer or retain old-account text.
  const key = useMemo(() => {
    const input: TokenEstimateInput = snapshot.sections.map(({ id, entries }) => ({
      id,
      texts: entries.map(({ content }) => content),
    }));
    if (
      input.reduce((n, part) => n + part.texts.reduce((sum, text) => sum + text.length, 0), 0) >
      tokenEstimateCharacterLimit
    )
      return null;
    return JSON.stringify(input);
  }, [snapshot.sections]);
  const [result, setResult] = useState<{
    key: string | null;
    revision: number;
    data?: TokenEstimate;
    error: string;
  }>();
  useEffect(() => {
    let active = true;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: { data?: TokenEstimate; error: string }) => {
      if (!active) return;
      clearTimeout(timer);
      worker?.terminate();
      setResult({ key, revision, ...value });
    };
    if (key === null) {
      finish({ error: tokenEstimateLimitMessage });
      return;
    }
    try {
      worker = new Worker(new URL('./token-estimator.worker.ts', import.meta.url), {
        type: 'module',
      });
      worker.onmessage = ({ data }: MessageEvent<TokenEstimateResult>) =>
        finish('data' in data ? { data: data.data, error: '' } : { error: data.error });
      worker.onerror = (event) => {
        event.preventDefault();
        finish({ error: '无法加载本地分词器，请重试。原始快照仍可查看。' });
      };
      worker.onmessageerror = () => finish({ error: '无法读取 Token 估算结果，请重试。' });
      timer = setTimeout(
        () => finish({ error: 'Token 估算超时，请重试。原始快照仍可查看。' }),
        30_000,
      );
      worker.postMessage(JSON.parse(key));
    } catch {
      finish({ error: '当前浏览器无法运行本地分词，请重试或使用其他浏览器。' });
    }
    return () => {
      active = false;
      clearTimeout(timer);
      worker?.terminate();
    };
  }, [key, revision]);
  const current = result?.key === key && result.revision === revision ? result : undefined;
  return {
    data: current?.data,
    error: current?.error ?? '',
    retry: () => setRevision((n) => n + 1),
  };
}
