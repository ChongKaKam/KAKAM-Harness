import type { ReasoningEffort } from '../shared/types';

const unsupportedMax = '当前模型不支持 Max 思考强度，请切换其他思考程度后重试。';
const effortField = /\b(?:reasoning[._ ]effort|output_config[._ ]effort|effort)\b/i;
const qualifiedEffortField = /\b(?:reasoning[._ ]effort|output_config[._ ]effort)\b/i;
const rejection =
  /\b(?:unsupported|not supported|does not support|not allowed|not permitted|invalid (?:value|enum|parameter)|supported values|must be one of|should be|unrecognized (?:value|parameter)|unknown parameter)\b|不支持|无效|仅支持/i;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Inspect only error fields; never expose the upstream body or credentials to users. */
export function unsupportedMaxEffortMessage(payload: unknown, effort: ReasoningEffort) {
  if (effort !== 'max') return;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      // Some compatible providers return a plain-text parameter error.
    }
  }
  const envelope = record(payload);
  const error = record(envelope?.error) ?? record(record(envelope?.response)?.error) ?? envelope;
  const param = typeof error?.param === 'string' ? error.param : '';
  // A rejected temperature / max_tokens / tool parameter does not establish Max support.
  if (param && !effortField.test(param)) return;
  const message =
    typeof payload === 'string' ? payload : typeof error?.message === 'string' ? error.message : '';
  const code = typeof error?.code === 'string' ? error.code : '';
  if (
    (effortField.test(param) ||
      qualifiedEffortField.test(message) ||
      (effortField.test(message) && /\bmax\b/i.test(message))) &&
    (rejection.test(message) || /^(?:unsupported|invalid)_(?:value|parameter|enum)$/.test(code))
  )
    return unsupportedMax;
}
