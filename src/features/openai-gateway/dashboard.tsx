import { useState } from 'react';
import { Activity, Clock3, Database, Hash, RefreshCw } from 'lucide-react';
import { api } from '../../client/api';
import { usePatternColors } from '../../client/color-pattern';
import { Empty, ErrorNote, Spinner, useLoad } from '../../client/components';
import type { GatewayDashboard, GatewayDashboardDays } from './dashboard-types';
import './dashboard.css';

const numbers = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const count = (value: number | null) => (value === null ? '—' : numbers.format(value));
const percent = (value: number | null) => (value === null ? '—' : count(value) + '%');
function duration(ms: number | null) {
  if (ms === null) return '—';
  return ms < 1000 ? count(Math.round(ms)) + ' 毫秒' : count(ms / 1000) + ' 秒';
}

const trends = {
  calls: { title: '调用次数', format: count },
  cacheHitRate: { title: '缓存命中率', format: percent },
  successRate: { title: '调用成功率', format: percent },
  averageDurationMs: { title: '平均返回时间', format: duration },
  totalTokens: { title: 'Token 消耗', format: count },
};
type Trend = keyof typeof trends;

function DailyTrend({ daily }: Pick<GatewayDashboard, 'daily'>) {
  const [metric, setMetric] = useState<Trend>('calls');
  const colors = usePatternColors();
  const { format, title } = trends[metric];
  const values = daily.map((day) => day[metric]).filter((v) => v !== null);
  const maximum =
    metric === 'successRate' || metric === 'cacheHitRate' ? 100 : Math.max(1, ...values);
  const activeDays = daily.filter((day) => day.calls > 0).reverse();

  return (
    <section className="panel gateway-dashboard-trend" aria-label="每日趋势">
      <div className="gateway-dashboard-section-heading">
        <h2>
          每日趋势 <small>UTC</small>
        </h2>
        <select
          aria-label="趋势指标"
          value={metric}
          onChange={(event) => setMetric(event.target.value as Trend)}
        >
          {Object.entries(trends).map(([key, option]) => (
            <option key={key} value={key}>
              {option.title}
            </option>
          ))}
        </select>
      </div>
      {values.length ? (
        <div aria-hidden="true" style={colors.style({ key: 'gateway-trend-' + metric })}>
          <div className="gateway-dashboard-chart">
            <div className="gateway-dashboard-axis">
              <span>{format(maximum)}</span>
              <span>0</span>
            </div>
            <div className="gateway-dashboard-bars" data-dense={daily.length > 30}>
              {daily.map((day) => {
                const value = day[metric];
                return (
                  <div
                    key={day.day}
                    className="gateway-dashboard-day"
                    title={day.day + ' · ' + title + ' ' + format(value)}
                  >
                    {value !== null && (
                      <span
                        className="gateway-dashboard-bar"
                        style={{ height: (value / maximum) * 100 + '%' }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div className="gateway-dashboard-dates">
            <span>{daily[0]?.day}</span>
            <span>{daily.at(-1)?.day}</span>
          </div>
        </div>
      ) : (
        <p className="gateway-dashboard-no-samples">所选时段缺少此指标的样本。</p>
      )}
      <details className="gateway-dashboard-history">
        <summary>查看逐日明细</summary>
        <div className="gateway-dashboard-scroll" role="region" aria-label="逐日明细" tabIndex={0}>
          <table aria-label="转发调用逐日明细">
            <thead>
              <tr>
                {['日期（UTC）', '调用', '成功率', '缓存命中率', '平均返回时间', '总 Token'].map(
                  (h) => (
                    <th key={h} scope="col">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {activeDays.map((day) => (
                <tr key={day.day}>
                  <th scope="row">{day.day}</th>
                  <td>{count(day.calls)}</td>
                  <td>{percent(day.successRate)}</td>
                  <td>{percent(day.cacheHitRate)}</td>
                  <td>{duration(day.averageDurationMs)}</td>
                  <td>{count(day.totalTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function DashboardReport({ data, error, reload }: ReturnType<typeof useLoad<GatewayDashboard>>) {
  const colors = usePatternColors();
  if (error)
    return (
      <div>
        <ErrorNote text={error} />
        <button type="button" className="button" onClick={reload}>
          重试
        </button>
      </div>
    );
  if (!data) return <Spinner />;
  const { totals } = data;
  if (!totals.calls)
    return (
      <Empty title="这段时间没有转发调用">
        可以切换时间范围，或在开发机通过转发密钥发起调用后刷新。
      </Empty>
    );

  const cards = [
    {
      label: '缓存命中率',
      value: percent(totals.cacheHitRate),
      detail: `缓存已上报 ${count(totals.cacheSamples)} / ${count(totals.calls)} 次`,
      icon: Database,
    },
    {
      label: '调用成功率',
      value: percent(totals.successRate),
      detail: `${count(totals.succeeded)} / ${count(totals.calls)} 次成功`,
      icon: Activity,
    },
    {
      label: '平均返回时间',
      value: duration(totals.averageDurationMs),
      detail: `${count(totals.durationSamples)} / ${count(totals.succeeded)} 次成功调用有计时`,
      icon: Clock3,
    },
    {
      label: 'Token 消耗',
      value: count(totals.totalTokens),
      detail: `总量已上报 ${count(totals.tokenSamples)} / ${count(totals.calls)} 次`,
      icon: Hash,
    },
  ];
  return (
    <>
      <dl className="gateway-dashboard-metrics">
        {cards.map(({ label, value, detail, icon: Icon }, index) => (
          <div
            className="panel gateway-dashboard-metric"
            key={label}
            style={colors.style({ key: 'gateway-overview', index: index * 2 })}
          >
            <dt>
              <span className="gateway-dashboard-metric-icon">
                <Icon size={16} aria-hidden="true" />
              </span>
              {label}
            </dt>
            <dd>{value}</dd>
            <dd className="gateway-dashboard-caption">{detail}</dd>
          </div>
        ))}
      </dl>
      <div className="gateway-dashboard-body">
        <DailyTrend daily={data.daily} />
        <section className="panel gateway-dashboard-breakdown" aria-label="转发明细">
          <h2>Token 明细</h2>
          <dl>
            <div>
              <dt>输入 Token</dt>
              <dd>{count(totals.inputTokens)}</dd>
            </div>
            <div>
              <dt>其中缓存命中</dt>
              <dd>{count(totals.cachedInputTokens)}</dd>
            </div>
            <div>
              <dt>输出 Token</dt>
              <dd>{count(totals.outputTokens)}</dd>
            </div>
          </dl>
          <h2>调用结果</h2>
          <dl>
            <div>
              <dt>成功</dt>
              <dd>{count(totals.succeeded)}</dd>
            </div>
            <div>
              <dt>失败</dt>
              <dd>{count(totals.failed)}</dd>
            </div>
            <div>
              <dt>已取消</dt>
              <dd>{count(totals.cancelled)}</dd>
            </div>
          </dl>
        </section>
      </div>
      <p className="gateway-dashboard-note">
        缓存命中率按有缓存明细的调用计算，等于命中的输入 Token 除以这些调用的输入
        Token。平均返回时间从转发开始计至成功响应结束，包含流式输出。缺少数据的指标显示为「—」。
      </p>
    </>
  );
}

export function GatewayDashboardPanel() {
  const [days, setDays] = useState<GatewayDashboardDays>(7);
  const report = useLoad(
    () => api<GatewayDashboard>(`/admin/openai-gateway/dashboard?days=${days}`),
    [days],
  );
  return (
    <div className="gateway-dashboard">
      <div className="gateway-dashboard-toolbar">
        <label className="usage-filter">
          时间范围
          <select
            aria-label="看板时间范围"
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as GatewayDashboardDays)}
          >
            {[7, 30, 90].map((n) => (
              <option value={n} key={n}>
                最近 {n} 天
              </option>
            ))}
          </select>
        </label>
        <button className="button" type="button" onClick={report.reload}>
          <RefreshCw size={14} aria-hidden="true" />
          刷新
        </button>
      </div>
      <DashboardReport {...report} data={report.data?.days === days ? report.data : undefined} />
    </div>
  );
}
