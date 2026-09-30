export interface SkillFile {
  path: string;
  content: string;
}
export interface SkillSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  colorSlot: number | null;
  version: number;
  fileCount: number;
}
export interface Skill extends SkillSummary {
  content: string;
  files: SkillFile[];
}
export interface SkillSelection {
  id: string;
  version: number;
  scope: 'conversation' | 'turn';
}
export interface SelectedSkill extends SkillSelection {
  title: string;
}
export interface SkillRead {
  skillId: string;
  title: string;
  version: number;
  path: string;
  offset: number;
  characters: number;
}
export const skillLimits = {
  title: 80,
  content: 20_000,
  description: 160,
  tags: 8,
  tag: 24,
  files: 16,
  file: 40_000,
  package: 200_000,
  selected: 8,
  context: 80_000,
  read: 12_000,
  reads: 16,
  rounds: 8,
};

export function skillDocument(skill: Pick<Skill, 'name' | 'description' | 'content'>) {
  return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}`;
}
