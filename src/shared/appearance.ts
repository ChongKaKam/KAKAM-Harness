export const accentGroups = [
  { id: 'natural', name: '自然鲜明', description: '更饱满的色彩，搭配同色系的明暗背景。' },
  { id: 'classic', name: '柔和经典', description: '九种清透的柔和配色，轻盈而有温度。' },
] as const;
export const accentColors = [
  // Keep the default ID so existing green themes adopt the requested reference green.
  { id: 'sage', name: '苔绿', original: 'Moss', color: '#607a4c', group: 'natural' },
  { id: 'wheat', name: '麦穗金', original: 'Wheat', color: '#98762f', group: 'natural' },
  { id: 'oat', name: '燕麦棕', original: 'Oat', color: '#94704b', group: 'natural' },
  { id: 'apricot', name: '杏桃橘', original: 'Apricot', color: '#b45f42', group: 'natural' },
  { id: 'terracotta', name: '赤陶棕', original: 'Terracotta', color: '#a26645', group: 'natural' },
  { id: 'espresso', name: '浓咖啡', original: 'Espresso', color: '#80512f', group: 'natural' },
  { id: 'lake', name: '湖水蓝', original: 'Lake', color: '#427b98', group: 'natural' },
  { id: 'amber', name: '琥珀金', original: 'Amber', color: '#a47123', group: 'natural' },
  { id: 'rose', name: '玫瑰粉', original: 'Rose', color: '#ae5b77', group: 'natural' },
  { id: 'ivory', name: '象牙白', original: 'Marfil', color: '#f5e9d8', group: 'classic' },
  { id: 'beige', name: '米色', original: 'Beige', color: '#edd5b5', group: 'classic' },
  { id: 'nude', name: '裸粉', original: 'Nude', color: '#edc3b6', group: 'classic' },
  { id: 'camel', name: '驼色', original: 'Camel', color: '#dfb593', group: 'classic' },
  { id: 'coffee', name: '咖啡色', original: 'Café', color: '#b78b58', group: 'classic' },
  { id: 'soft-sage', name: '鼠尾草绿', original: 'Sage', color: '#b1c59f', group: 'classic' },
  { id: 'blue-gray', name: '蓝灰', original: 'Azul gris', color: '#98b9ca', group: 'classic' },
  { id: 'champagne', name: '香槟色', original: 'Champagne', color: '#f4dfc6', group: 'classic' },
  { id: 'soft-pink', name: '柔粉', original: 'Rosado suave', color: '#f0c9d1', group: 'classic' },
] as const;
export type AccentColor = (typeof accentColors)[number]['id'];
export const defaultAccent: AccentColor = 'sage';
export function isAccentColor(value: unknown): value is AccentColor {
  return accentColors.some((accent) => accent.id === value);
}

function mix(color: string, target: string, weight: number) {
  return (
    '#' +
    [1, 3, 5]
      .map((offset) => {
        const a = parseInt(color.slice(offset, offset + 2), 16);
        const b = parseInt(target.slice(offset, offset + 2), 16);
        return Math.round(a * (1 - weight) + b * weight)
          .toString(16)
          .padStart(2, '0');
      })
      .join('')
  );
}
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
function contrast(a: string, b: string) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}
export function swatchForeground(color: string) {
  return contrast(color, '#ffffff') >= contrast(color, '#000000') ? '#ffffff' : '#000000';
}

export type ColorMode = 'light' | 'dark';
export interface PatternColor {
  readonly id: string;
  readonly name: string;
  readonly original: string;
  readonly color: string;
}
export interface ColorPattern {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly colors: readonly PatternColor[];
  /** Surface tint opacity; foreground ink remains independent. */
  readonly tint?: Readonly<Record<ColorMode, { fill: number; soft: number; line: number }>>;
}
export interface ColorAssignment {
  key: string;
  slot?: number | null;
  /** A stable group seed plus an index gives neighboring cards different colors. */
  index?: number;
}
export const defaultPattern = 'natural';
export function shellTokens(theme: ColorMode) {
  const dark = theme === 'dark';
  return {
    '--ink': dark ? '#ededed' : '#262626',
    '--muted': dark ? '#b6b6b6' : '#626262',
    '--faint': dark ? '#999999' : '#6c6c6c',
    '--line': dark ? '#373737' : '#e6e6e6',
    '--sidebar': dark ? '#202020' : '#f7f7f7',
    '--soft': dark ? '#292929' : '#f3f3f3',
    '--surface': dark ? '#191919' : '#ffffff',
    '--surface-alt': dark ? '#222222' : '#fafafa',
    '--code': dark ? '#222222' : '#f6f6f6',
    '--cell': dark ? '#373737' : '#e6e6e6',
    '--accent': dark ? '#d0d0d0' : '#444444',
    '--accent-base': dark ? '#aaaaaa' : '#777777',
    '--selection': dark ? '#303030' : '#ececec',
    '--primary': dark ? '#e8e8e8' : '#292929',
    '--primary-hover': dark ? '#ffffff' : '#111111',
    '--on-primary': dark ? '#191919' : '#ffffff',
    '--control': dark ? '#515151' : '#cecece',
  };
}
export function stableColorHash(key: string) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}
/** Shared by server validation and client rendering. Features never construct their own palettes. */
export class ColorPatternRegistry {
  private entries = new Map<string, ColorPattern>();
  register(pattern: ColorPattern) {
    if (!/^[a-z][a-z0-9-]*$/.test(pattern.id) || this.entries.has(pattern.id))
      throw new Error('Invalid or duplicate color pattern: ' + pattern.id);
    if (
      !pattern.colors.length ||
      pattern.colors.length > 64 ||
      new Set(pattern.colors.map((color) => color.id)).size !== pattern.colors.length ||
      pattern.colors.some((color) => !/^#[0-9a-f]{6}$/i.test(color.color))
    )
      throw new Error('Invalid pattern colors: ' + pattern.id);
    if (
      pattern.tint &&
      Object.values(pattern.tint).some((tokens) =>
        Object.values(tokens).some(
          (opacity) => !Number.isFinite(opacity) || opacity < 0 || opacity > 1,
        ),
      )
    )
      throw new Error('Invalid pattern tint: ' + pattern.id);
    const colors = Object.freeze(pattern.colors.map((color) => Object.freeze({ ...color })));
    this.entries.set(pattern.id, Object.freeze({ ...pattern, colors }));
    return this;
  }
  has(id: unknown): id is string {
    return typeof id === 'string' && this.entries.has(id);
  }
  list() {
    return [...this.entries.values()];
  }
  get(id: string) {
    const pattern = this.entries.get(id);
    if (!pattern) throw new Error('Unknown color pattern: ' + id);
    return pattern;
  }
  resolve(id: string, theme: ColorMode, assignment: ColorAssignment) {
    const pattern = this.get(id);
    const slot = assignment.slot ?? stableColorHash(assignment.key) + (assignment.index ?? 0);
    if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('Invalid color slot');
    const index = slot % pattern.colors.length;
    const color = pattern.colors[index];
    const shell = shellTokens(theme);
    const dark = theme === 'dark';
    const tint = pattern.tint?.[theme] ?? {
      fill: dark ? 0.3 : 0.2,
      soft: dark ? 0.16 : 0.08,
      line: dark ? 0.65 : 0.45,
    };
    // Preserve readable secondary text even for very light colors in new palettes.
    let fillWeight = 1 - tint.fill;
    let fill = mix(color.color, shell['--surface'], fillWeight);
    while (contrast(shell['--muted'], fill) < 4.5 && fillWeight < 1) {
      fillWeight = Math.min(1, fillWeight + 0.02);
      fill = mix(color.color, shell['--surface'], fillWeight);
    }
    return {
      index,
      color,
      tokens: {
        '--item-color': color.color,
        '--item-fill': fill,
        '--item-soft': mix(color.color, shell['--surface'], 1 - tint.soft),
        '--item-line': mix(color.color, shell['--surface'], 1 - tint.line),
        '--item-ink': shell['--ink'],
      },
    };
  }
}
export const colorPatterns = new ColorPatternRegistry();
for (const group of accentGroups)
  colorPatterns.register({
    ...group,
    ...(group.id === 'classic'
      ? {
          tint: {
            light: { fill: 0.14, soft: 0.05, line: 0.38 },
            dark: { fill: 0.2, soft: 0.1, line: 0.48 },
          },
        }
      : {}),
    description:
      group.id === 'natural'
        ? '自然中的饱满色彩，让每个想法各有颜色。'
        : '清透的大地与粉彩色，让柔和也有清晰的色彩。',
    colors: accentColors.filter((color) => color.group === group.id),
  });
export const isColorPattern = (id: unknown): id is string => colorPatterns.has(id);
export function patternFromAccent(accent: AccentColor) {
  return accentColors.find((color) => color.id === accent)?.group ?? defaultPattern;
}
