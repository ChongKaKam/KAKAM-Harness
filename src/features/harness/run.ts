import type { Context } from 'cordis';
import type {
  ExtensionCall,
  ExtensionRun,
  HarnessRun,
  ReasoningEffort,
  StreamEvent,
} from '../../shared/types';
import { HttpError } from '../../kernel/http';

/** Only user-visible progress is durable. Upstream requests never resume after restart. */
export class HarnessExecution {
  readonly state: HarnessRun = {
    phase: 'prepare',
    detail: '正在读取会话工作区',
    steps: [],
    steering: [],
  };

  private calls = new Map<string, HarnessRun['steps'][number]>();

  constructor(
    private ctx: Context,
    private messageId: string,
    modelId: string,
    effort: ReasoningEffort,
    private publish: (event: StreamEvent) => void,
  ) {
    Object.assign(this.state, { modelId, effort });
    this.save();
  }

  private save() {
    this.ctx.db.run(
      'UPDATE messages SET harness_run=? WHERE id=?',
      JSON.stringify(this.state),
      this.messageId,
    );
    this.publish({ type: 'harness-progress', messageId: this.messageId, run: this.state });
  }

  phase(phase: HarnessRun['phase'], detail: string) {
    if (this.state.phase === phase && this.state.detail === detail) return;
    Object.assign(this.state, { phase, detail });
    this.save();
  }

  search(runs: ExtensionRun[]) {
    for (const run of runs) this.recordCalls(run.calls, run.name + ' · ');
    const search = runs.find((run) => run.id === 'search');
    const active = search?.calls.filter(
      (call) => call.stage === '检索' && call.status === 'streaming',
    ).length;
    if (search && active) {
      this.state.detail = '已查到 ' + search.sources.length + ' 个来源，还有 ' + active + ' 路查询';
    }
    this.save();
  }

  private recordCalls(calls: ExtensionCall[], prefix = '') {
    for (const call of calls) {
      const status = call.status === 'streaming' ? 'running' : call.status;
      const step = this.calls.get(call.id);
      if (step) step.status = status;
      else {
        const entry = { label: prefix + call.stage, status };
        this.calls.set(call.id, entry);
        this.state.steps.push(entry);
      }
    }
  }

  answerCalls(calls: ExtensionCall[]) {
    this.recordCalls(calls);
    this.save();
  }

  activity(label: string, status = 'complete') {
    this.state.steps.push({ label, status });
    this.state.detail = label;
    this.save();
  }

  steer(id: string, content: string, command?: () => string | undefined) {
    const existing = this.state.steering.find((item) => item.id === id);
    if (existing) {
      if (existing.content !== content) throw new HttpError(409, '相同请求标识对应了不同的补充');
      return existing.receipt;
    }
    if (this.state.steering.length >= 12) throw new HttpError(409, '本次任务已达到补充次数上限');
    const receipt = command?.();
    this.state.steering.push({ id, content, applied: receipt !== undefined, receipt });
    this.save();
    return receipt;
  }

  takeSteering() {
    const pending = this.state.steering.filter((item) => !item.applied);
    if (pending.length) {
      for (const item of pending) item.applied = true;
      this.save();
    }
    return pending.map((item) => item.content);
  }
}
