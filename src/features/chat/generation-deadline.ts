import { HttpError } from '../../kernel/http';

/** A long reply may run for minutes, but a stalled connection must eventually release its slot. */
export function generationDeadline(
  cancel: AbortSignal,
  additional?: AbortSignal,
  idleMs = 5 * 60_000,
  totalMs = 15 * 60_000,
) {
  const timeout = new AbortController();
  let idle: ReturnType<typeof setTimeout>;
  const total = setTimeout(
    () => timeout.abort(new HttpError(504, '回复已超过最长生成时间，请重新输出')),
    totalMs,
  );
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => timeout.abort(new HttpError(504, '模型长时间没有新输出，请重新输出')),
      idleMs,
    );
  };
  touch();
  return {
    signal: AbortSignal.any([cancel, timeout.signal, ...(additional ? [additional] : [])]),
    touch,
    close: () => {
      clearTimeout(idle);
      clearTimeout(total);
    },
  };
}
