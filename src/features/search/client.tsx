import { useState, type FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api, patch } from '../../client/api';
import { PageHeader, ErrorNote, Spinner, useLoad } from '../../client/components';
import { useWorkspace } from '../../client/context';
import '../extensions/extensions.css';
interface SearchConfig {
  baseUrl: string;
  hasKey: boolean;
  maxQueries: number;
  maxResults: number;
}
export function SearchPage() {
  const { navigate, notify } = useWorkspace();
  const { data, error, reload } = useLoad(() => api<SearchConfig>('/admin/search'));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true);
    setFailure('');
    try {
      await patch('/admin/search', {
        baseUrl: form.get('baseUrl'),
        apiKey: form.has('clearKey') ? '' : form.get('apiKey') || undefined,
        maxQueries: Number(form.get('maxQueries')),
        maxResults: Number(form.get('maxResults')),
      });
      (element.elements.namedItem('apiKey') as HTMLInputElement).value = '';
      const clearKey = element.elements.namedItem('clearKey') as HTMLInputElement | null;
      if (clearKey) clearKey.checked = false;
      reload();
      notify('Search 配置已保存');
    } catch (error) {
      setFailure((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page extensions-page">
      <PageHeader
        eyebrow="PERPLEXITY SEARCH"
        title="Search 设置"
        description="让模型整理搜索词，依次检索，再结合来源生成回答。"
        action={
          <button className="button" onClick={() => navigate('settings', 'extensions')}>
            <ArrowLeft size={15} />
            拓展能力
          </button>
        }
      />
      <ErrorNote text={error || failure} />
      {!data && !error && <Spinner />}
      {data && (
        <form className="panel extensions-card" onSubmit={save}>
          <fieldset disabled={busy}>
            <label>
              Search Base URL
              <input
                name="baseUrl"
                type="url"
                required
                defaultValue={data.baseUrl}
                placeholder="https://api.perplexity.ai"
              />
            </label>
            <p className="small muted">使用 Perplexity Search API，自动追加 /search。</p>
            <label>
              Perplexity Search API Key
              <input
                name="apiKey"
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                placeholder={data.hasKey ? '已保存，留空保留密钥' : '输入 API Key'}
              />
            </label>
            {data.hasKey && (
              <label className="check-row">
                <input type="checkbox" name="clearKey" />
                清除已保存的密钥
              </label>
            )}
            <label>
              每次最多搜索词数
              <input
                name="maxQueries"
                type="number"
                min={1}
                max={5}
                required
                defaultValue={data.maxQueries}
              />
            </label>
            <label>
              每个搜索词最多结果数
              <input
                name="maxResults"
                type="number"
                min={1}
                max={10}
                required
                defaultValue={data.maxResults}
              />
            </label>
            <p className="small muted">
              搜索词生成使用拓展能力中选择的 LLM。Search API 不返回 Token
              用量，检索调用显示“未上报”，不会推算账单。
            </p>
            <button className="button primary" disabled={busy}>
              {busy ? '保存中…' : '保存 Search 配置'}
            </button>
          </fieldset>
        </form>
      )}
    </div>
  );
}
