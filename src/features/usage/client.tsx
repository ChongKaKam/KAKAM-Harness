import { ActivityChart } from './activity-chart';
import { useState } from 'react';
import { Activity, ArrowDownLeft, ArrowUpRight, Hash } from 'lucide-react';
import { api } from '../../client/api';
import { useWorkspace } from '../../client/context';
import { PageHeader, Spinner, ErrorNote, Empty, useLoad } from '../../client/components';
import type { UsageData, User } from '../../shared/types';
import { usePatternColors } from '../../client/color-pattern';
import './usage.css';
const number = (n: number | null) => (n === null ? '未上报' : n.toLocaleString());
export function UsagePage() {
  const colors = usePatternColors();
  const { user } = useWorkspace();
  const [days, setDays] = useState('365');
  const [userId, setUserId] = useState('');
  const users = useLoad(() =>
    user.role === 'admin' ? api<User[]>('/admin/users') : Promise.resolve([]),
  );
  const { data, error } = useLoad(
    () => api<UsageData>(`/usage?days=${days}${userId ? `&userId=${userId}` : ''}`),
    [days, userId],
  );
  return (
    <div className="page">
      <PageHeader
        eyebrow="USAGE & INSIGHTS"
        title="每一次思考，都有迹可循"
        description={
          user.role === 'admin'
            ? '查看工作区全部用户的模型调用与 Token 消耗。'
            : '查看你自己的模型调用与 Token 消耗。'
        }
      />
      <div className="toolbar">
        {user.role === 'admin' && (
          <select
            aria-label="按用户筛选"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          >
            <option value="">全部用户</option>
            {users.data?.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName} ({u.email ?? u.legacyUsername})
              </option>
            ))}
          </select>
        )}
        <select aria-label="统计时间范围" value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="7">最近 7 天</option>
          <option value="30">最近 30 天</option>
          <option value="90">最近 90 天</option>
          <option value="365">最近一年</option>
        </select>
      </div>
      <ErrorNote text={error} />
      {!data ? (
        !error && <Spinner />
      ) : (
        <>
          <div className="stats-grid">
            {[
              { label: '总 Tokens', value: data.totals.total, icon: Hash },
              { label: '输入 Tokens', value: data.totals.input, icon: ArrowUpRight },
              { label: '输出 Tokens', value: data.totals.output, icon: ArrowDownLeft },
              { label: '模型调用', value: data.totals.requests, icon: Activity },
            ].map((s, index) => (
              <div
                className="panel stat-card pattern-card"
                key={s.label}
                style={colors.style({ key: 'usage-stats', index: index * 2 })}
              >
                <div className="row">
                  <span>{s.label}</span>
                  <s.icon size={17} />
                </div>
                <strong>{number(s.value)}</strong>
              </div>
            ))}
          </div>
          <ActivityChart rows={data.activity} days={Number(days)} />
          <div className="notice">
            统计仅累计模型来源实际上报的 Token 数。所选期间有 {data.totals.unreported}{' '}
            次调用未上报用量（包括中断或不支持 usage 的来源），实际消耗可能更高。
          </div>
          <div className="section-label usage-recent-heading">
            最近调用<span>最多显示 200 条 · 汇总包含全部记录</span>
          </div>
          <div className="panel table-wrap usage-recent">
            <table aria-label="最近调用">
              <thead>
                <tr>
                  <th>时间</th>
                  {user.role === 'admin' && <th>用户</th>}
                  <th>模型</th>
                  <th>输入</th>
                  <th>输出</th>
                  <th>总计</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="nowrap">
                      {new Date(row.createdAt).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    {user.role === 'admin' && <td>{row.email}</td>}
                    <td>{row.modelName}</td>
                    <td>{number(row.inputTokens)}</td>
                    <td>{number(row.outputTokens)}</td>
                    <td>{number(row.totalTokens)}</td>
                    <td>
                      <span className="usage-status" data-status={row.status}>
                        {
                          (
                            {
                              complete: '完成',
                              error: '失败',
                              cancelled: '已停止',
                              streaming: '生成中',
                            } as Record<string, string>
                          )[row.status]
                        }
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.rows.length && <p className="table-empty">暂无调用记录</p>}
          </div>
        </>
      )}
    </div>
  );
}
