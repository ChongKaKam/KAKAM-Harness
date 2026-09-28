import { useState } from 'react';
import { Radio } from 'lucide-react';
import { post } from '../../client/api';
import { ErrorNote } from '../../client/components';
import { apiModeLabels } from '../../shared/types';
import type { ApiMode, ModelConnectionTest, ReasoningEffort } from '../../shared/types';

export function ModelConnectionProbe({
  modelId,
  modelName,
  apiMode,
  busy,
  onTesting,
}: {
  modelId: string;
  modelName: string;
  apiMode: ApiMode;
  busy: boolean;
  onTesting: (value: boolean) => void;
}) {
  const [effort, setEffort] = useState<ReasoningEffort>('none');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ModelConnectionTest>();
  const [error, setError] = useState('');
  async function test() {
    setTesting(true);
    onTesting(true);
    setError('');
    setResult(undefined);
    try {
      setResult(
        await post<ModelConnectionTest>(`/admin/models/${modelId}/test`, {
          reasoningEffort: effort,
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setTesting(false);
      onTesting(false);
    }
  }
  return (
    <section className="models-probe" aria-label="模型连通性测试">
      <h3>连通性测试</h3>
      <p className="small muted models-probe-target">
        {modelName} · {apiModeLabels[apiMode]}
      </p>
      <p className="small muted">
        使用已保存的来源发送简短请求，最多等待 60 秒；实际用量计入当前管理员。
      </p>
      <div className="models-probe-controls">
        <label>
          测试思考程度
          <select
            value={effort}
            disabled={testing || busy}
            onChange={(e) => {
              setEffort(e.target.value as ReasoningEffort);
              setResult(undefined);
              setError('');
            }}
          >
            <option value="none">None · 使用上游默认</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra high</option>
          </select>
        </label>
        <button type="button" className="button" onClick={test} disabled={testing || busy}>
          <Radio size={15} />
          {testing ? '正在测试…' : '测试连通性'}
        </button>
      </div>
      {testing && (
        <p role="status" className="small muted">
          正在等待模型完成回复…
        </p>
      )}
      {result && (
        <div className="models-probe-result" role="status">
          <strong>
            {result.ok ? '连接成功' : '连接测试未通过'} · {apiModeLabels[result.apiMode]}
          </strong>
          <dl className="models-probe-metrics">
            <div>
              <dt>首段文本</dt>
              <dd>{result.firstTextMs === null ? '未收到' : `${result.firstTextMs} ms`}</dd>
            </div>
            <div>
              <dt>总耗时</dt>
              <dd>{result.latencyMs} ms</dd>
            </div>
            <div>
              <dt>文本片段</dt>
              <dd>{result.textChunks}</dd>
            </div>
            <div>
              <dt>Token</dt>
              <dd>{result.usage?.total ?? '未上报'}</dd>
            </div>
          </dl>
          <p className="small muted">
            耗时从服务器发起请求开始计算，不含浏览器网络延迟。片段数量不代表 Token 数量。
          </p>
          <ErrorNote text={result.error} />
        </div>
      )}
      <ErrorNote text={error} />
    </section>
  );
}
