import type { ProviderMessage } from '../../adapters/registry';

const contextBudget = 16_000;
const omitted = '\n[... middle omitted ...]\n';

/** Bound serialized input, including JSON escaping, while retaining both ends. */
function fit(message: ProviderMessage, budget: number) {
  const serialize = (length: number) => {
    const truncated = length < message.content.length;
    const head = Math.ceil((length * 2) / 3);
    return JSON.stringify({
      role: message.role,
      content: truncated
        ? message.content.slice(0, head).replace(/[\uD800-\uDBFF]$/, '') +
          omitted +
          (length > head
            ? message.content.slice(-(length - head)).replace(/^[\uDC00-\uDFFF]/, '')
            : '')
        : message.content,
      ...(truncated ? { truncated: true } : {}),
    });
  };
  let low = 0;
  let high = Math.min(message.content.length, 8000);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serialize(middle).length <= budget) low = middle;
    else high = middle - 1;
  }
  return serialize(low);
}

/** The optional first message is the processor's earlier-history summary. */
export function capabilityContext(messages: ProviderMessage[], hasHistorySummary = false) {
  if (!messages.length) return '[]';
  const summary = hasHistorySummary && messages.length > 1 ? fit(messages[0], 2000) : undefined;
  const recent = messages.slice(summary ? 1 : 0).slice(-6);
  const current = fit(recent.at(-1)!, 8000);
  const history = recent.slice(0, -1);
  const commas = history.length + (summary ? 1 : 0);
  const historyBudget = contextBudget - 2 - commas - current.length - (summary?.length ?? 0);
  const perMessage = Math.floor(historyBudget / Math.max(history.length, 1));
  return `[${[...(summary ? [summary] : []), ...history.map((message) => fit(message, perMessage)), current].join(',')}]`;
}
