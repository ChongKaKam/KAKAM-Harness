export interface PromptCard {
  id: string;
  title: string;
  content: string;
  description: string;
  tags: string[];
  colorSlot: number | null;
}

export interface PromptPreferences {
  summaryModelId: string | null;
}

export const promptLimits = { title: 80, content: 20_000, description: 160, tags: 8, tag: 24 };

/** Tags are labels, with case-insensitive identity and user-facing spelling preserved. */
export function normalizeTags(tags: string[]) {
  const seen = new Set<string>();
  return tags
    .map((tag) => tag.trim())
    .filter((tag) => {
      const key = tag.toLocaleLowerCase();
      if (!tag || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
