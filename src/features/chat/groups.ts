export const groupIcons = ['folder', 'book', 'code', 'briefcase', 'sparkles'] as const;
export type GroupIcon = (typeof groupIcons)[number];

export function isGroupIcon(value: string) {
  return groupIcons.some((icon) => icon === value);
}

/** One emoji grapheme, including flags, skin tones and joined family emoji. */
export function isGroupSymbol(value: string) {
  return (
    isGroupIcon(value) ||
    (value.length <= 32 &&
      [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length === 1 &&
      /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value))
  );
}
