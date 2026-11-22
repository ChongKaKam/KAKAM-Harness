import { useState } from 'react';
import { Radio } from 'lucide-react';
import { post } from '../../client/api';
import { ErrorNote } from '../../client/components';
import { apiModeLabels } from '../../shared/types';
import type { ApiMode, Model, ModelConnectionTest, ReasoningEffort } from '../../shared/types';

export function ModelConnectionProbe({
  modelId,
  modelName,
  apiMode,
  kind = 'llm',
  toolCalling,
  busy,
  onTesting,
  onResult,
}: {
  modelId: string;
  modelName: string;
  apiMode: ApiMode;
  kind?: Model['kind'];
  toolCalling?: boolean;
  busy: boolean;
  onTesting: (value: boolean) => void;
  onResult?: (result: ModelConnectionTest) => void;
}) {
  const [effort, setEffort] = useState<ReasoningEffort>('none');
  const [activeMode, setActiveMode] = useState<'text' | 'tools'>();
  const testing = Boolean(activeMode);
  const [result, setResult] = useState<ModelConnectionTest>();
  const [error, setError] = useState('');
  async function test(mode: 'text' | 'tools') {
    setActiveMode(mode);
    onTesting(true);
    setError('');
    setResult(undefined);
    try {
      const tested = await post<ModelConnectionTest>(`/admin/models/${modelId}/test`, {
        reasoningEffort: effort,
        mode,
      });
      setResult(tested);
      onResult?.(tested);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setActiveMode(undefined);
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
        使用已保存的来源{kind === 'embedding' ? '发送 Embedding 请求' : '发送简短请求'}，最多等待 60
        秒；实际用量计入当前管理员。
      </p>
      {apiMode === 'jev' && (
        <p className="small muted">
          使用英文 state 和 Choice 问题调用 /systemone。HTTP 401 表示鉴权失败，与中文支持无关。
        </p>
      )}
      {kind === 'llm' && toolCalling && (
        <p className="small muted">
          工具测试沿用 Auto
          工具选择，最多发起两次模型请求，验证工具调用和工具结果回传。每轮单独计量。
        </p>
      )}
      <div className="models-probe-controls">
        {apiMode !== 'jev' && kind !== 'embedding' && (
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
              <option value="max">Max</option>
            </select>
          </label>
        )}
        <button
          type="button"
          className="button"
          onClick={() => void test('text')}
          disabled={testing || busy}
        >
          <Radio size={15} />
          {activeMode === 'text' ? '正在测试…' : '测试连通性'}
        </button>
        {kind === 'llm' && toolCalling && (
          <button
            type="button"
            className="button"
            onClick={() => void test('tools')}
            disabled={testing || busy}
          >
            {activeMode === 'tools' ? '正在测试工具…' : '测试工具调用'}
          </button>
        )}
      </div>
      {testing && (
        <p role="status" className="small muted">
          {kind === 'embedding' ? '正在等待向量响应…' : '正在等待模型完成回复…'}
        </p>
      )}
      {result && (
        <div className="models-probe-result" role="status">
          <strong>
            {result.toolRounds
              ? result.ok
                ? '工具测试通过'
                : '工具测试未通过'
              : result.ok
                ? '连接成功'
                : '连接测试未通过'}{' '}
            · {apiModeLabels[result.apiMode]}
          </strong>
          {result.toolRounds && (
            <ol className="small">
              {['请求只读工具', '引用工具结果'].map((label, index) => {
                const round = result.toolRounds?.[index];
                return (
                  <li key={label}>
                    {label} · {round ? (round.ok ? '通过' : '未通过') : '未发起'}
                    {round && ` · Token ${round.usage?.total ?? '未上报'}`}
                  </li>
                );
              })}
            </ol>
          )}
          <dl className="models-probe-metrics">
            {kind === 'embedding' ? (
              <>
                <div>
                  <dt>配置维度</dt>
                  <dd>{result.configuredDimensions ?? '自动'}</dd>
                </div>
                <div>
                  <dt>实际维度</dt>
                  <dd>{result.actualDimensions ?? '未收到'}</dd>
                </div>
                <div>
                  <dt>维度校验</dt>
                  <dd>
                    {result.dimensionsMatch === null
                      ? result.ok
                        ? '已验证上游维度'
                        : '未验证'
                      : result.dimensionsMatch
                        ? '一致'
                        : '不一致'}
                  </dd>
                </div>
              </>
            ) : (
              <div>
                <dt>{apiMode === 'jev' ? '决策响应' : '首段文本'}</dt>
                <dd>
                  {apiMode === 'jev'
                    ? result.ok
                      ? '有效 JSON'
                      : '未收到'
                    : result.firstTextMs === null
                      ? '未收到'
                      : `${result.firstTextMs} ms`}
                </dd>
              </div>
            )}
            <div>
              <dt>总耗时</dt>
              <dd>{result.latencyMs} ms</dd>
            </div>
            {kind !== 'embedding' && (
              <div>
                <dt>文本片段</dt>
                <dd>{result.textChunks}</dd>
              </div>
            )}
            <div>
              <dt>Token</dt>
              <dd>{result.usage?.total ?? '未上报'}</dd>
            </div>
            {kind === 'embedding' && (
              <>
                <div>
                  <dt>输入 Token</dt>
                  <dd>{result.usage?.input ?? '未上报'}</dd>
                </div>
                <div>
                  <dt>输出 Token</dt>
                  <dd>{result.usage?.output ?? '未上报'}</dd>
                </div>
              </>
            )}
          </dl>
          <p className="small muted">
            耗时从服务器发起请求开始计算，不含浏览器网络延迟。
            {kind !== 'embedding' && '片段数量不代表 Token 数量。'}
          </p>
          <ErrorNote text={result.error} />
          {result.diagnostics && (
            <details className="models-probe-log" open={!result.ok}>
              <summary>
                诊断日志 · {result.toolRounds ? '最近一轮请求' : '输入 / 输出 / 错误'}
              </summary>
              <p className="small muted">
                密钥已脱敏；日志仅用于本次测试，不会存入数据库。
                {result.diagnostics.truncated && '内容过长，已截断。'}
              </p>
              <h4>请求输入</h4>
              <pre>
                {result.diagnostics.request
                  ? `${result.diagnostics.request.method} ${result.diagnostics.request.url}\n${JSON.stringify(result.diagnostics.request.headers, null, 2)}\n\n${pretty(result.diagnostics.request.body)}`
                  : '请求尚未发出'}
              </pre>
              <h4>
                上游响应
                {result.diagnostics.response ? ` · HTTP ${result.diagnostics.response.status}` : ''}
              </h4>
              <pre>
                {result.diagnostics.response
                  ? `${JSON.stringify(result.diagnostics.response.headers, null, 2)}\n\n${pretty(result.diagnostics.response.body) || '响应体为空'}`
                  : '未收到 HTTP 响应'}
              </pre>
              <h4>模型输出</h4>
              <pre>{pretty(result.diagnostics.output) || '未收到模型输出'}</pre>
              {result.diagnostics.error && (
                <>
                  <h4>错误信息</h4>
                  <pre>{result.diagnostics.error}</pre>
                </>
              )}
            </details>
          )}
        </div>
      )}
      <ErrorNote text={error} />
    </section>
  );
}
function pretty(value: string) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}
