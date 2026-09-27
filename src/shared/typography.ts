export const fontSizes = [
  { id: 'compact', name: '紧凑', percent: '90%', scale: 0.9, detailScale: 0.96 },
  { id: 'standard', name: '标准', percent: '100%', scale: 1, detailScale: 1 },
  { id: 'comfortable', name: '舒适', percent: '112.5%', scale: 1.125, detailScale: 1.05 },
  { id: 'large', name: '较大', percent: '125%', scale: 1.25, detailScale: 1.1 },
] as const;
export type FontSize = (typeof fontSizes)[number]['id'];
export const defaultFontSize: FontSize = 'standard';
export const fontStorageKey = (userId: string) => `drift:font-size:${userId}`;
export function readFontSize(userId?: string): FontSize {
  if (!userId) return defaultFontSize;
  try {
    const saved = localStorage.getItem(fontStorageKey(userId));
    return fontSizes.find((item) => item.id === saved)?.id ?? defaultFontSize;
  } catch {
    return defaultFontSize;
  }
}
