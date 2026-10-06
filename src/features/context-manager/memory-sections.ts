import type { MemoryContextRange } from '../../shared/memory';
import type { ContextEntry } from './types';

/** Split only validated offsets; malformed metadata leaves the original text visible. */
export function splitMemoryContext(
  content: string,
  original: string,
  ranges: MemoryContextRange[] = [],
) {
  const prefix = content.startsWith(original) ? original.length : 0;
  let cursor = prefix;
  const remaining: string[] = [];
  const entries: ContextEntry[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < cursor ||
      range.end <= range.start ||
      range.end > content.length
    )
      continue;
    remaining.push(content.slice(cursor, range.start));
    entries.push({
      label: `记忆 · ${range.block.memoryId.slice(0, 8)} · v${range.block.version}`,
      role: 'user',
      content: content.slice(range.start, range.end),
      images: [],
      memoryId: range.block.memoryId,
      memoryVersion: range.block.version,
      memoryScope: range.block.scope,
      memoryReason: range.block.reason,
    });
    cursor = range.end;
  }
  remaining.push(content.slice(cursor));
  return { appended: remaining.join(''), entries };
}
