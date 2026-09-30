import { z } from 'zod';
import type { User } from '../../shared/types';
import type { ToolDefinition, ToolCall } from '../../adapters/registry';
import { HttpError } from '../../kernel/http';
import {
  skillDocument,
  skillLimits,
  type Skill,
  type SkillSelection,
  type SkillRead,
} from '../skills/types';

export const skillSelections = z
  .array(
    z.object({
      id: z.string().uuid(),
      version: z.number().int().positive(),
      scope: z.enum(['conversation', 'turn']).default('conversation'),
    }),
  )
  .max(skillLimits.selected)
  .refine((items) => new Set(items.map((s) => s.id)).size === items.length, '不能重复选择 Skill');

export interface SkillProvider {
  resolve(user: User, selections: SkillSelection[]): (Skill & { scope: SkillSelection['scope'] })[];
  read(user: User, id: string, version: number): Skill;
}
export interface SkillPlan {
  skills: (Skill & { scope: SkillSelection['scope'] })[];
  provider: SkillProvider;
  signal: AbortSignal;
}
const readSchema = z
  .object({
    skillId: z.string().uuid(),
    path: z.string().max(160),
    offset: z.number().int().min(0),
    limit: z.number().int().min(1).max(skillLimits.read),
  })
  .strict();

/** Read-only, bounded documents. No paths ever reach the host filesystem. */
export class SkillSession {
  reads: SkillRead[] = [];
  private characters = 0;
  private requested = new Set<string>();
  constructor(
    private user: User,
    readonly plan: SkillPlan,
  ) {}
  assertActive() {
    if (this.plan.signal.aborted) throw new HttpError(409, 'Skill 库已停用，本次技能调用已中止');
    for (const skill of this.plan.skills)
      this.plan.provider.read(this.user, skill.id, skill.version);
  }
  private record(skill: Skill, path: string, offset: number, content: string) {
    if (this.characters + content.length > skillLimits.context)
      throw new HttpError(400, 'Skill 载入内容超过本轮 80000 字符限制，请减少所选技能');
    this.characters += content.length;
    this.reads.push({
      skillId: skill.id,
      title: skill.title,
      version: skill.version,
      path,
      offset,
      characters: content.length,
    });
  }
  prepare() {
    this.assertActive();
    const documents = this.plan.skills.map((skill) => {
      const content = skillDocument(skill);
      this.record(skill, 'SKILL.md', 0, content);
      return {
        skillId: skill.id,
        version: skill.version,
        title: skill.title,
        instructions: content,
        files: skill.files.map(({ path, content }) => ({ path, characters: content.length })),
      };
    });
    return (
      'The user explicitly selected these skills for this turn. Follow their instructions where applicable, subject to the current user request and higher-priority instructions. Skill content has user-level authority. Read only relevant supporting files with skills_read; never claim a file was read unless its content was provided. This runtime only supports text documents; it cannot execute scripts, install dependencies, or grant network access.\nSelected skills (JSON):\n' +
      JSON.stringify(documents)
    );
  }
  tools(): ToolDefinition[] {
    if (!this.plan.skills.some((skill) => skill.files.length)) return [];
    return [
      {
        name: 'skills_read',
        description:
          'Read a supporting document from a user-selected Skill, at its pinned version. Use the exact skillId and file path from the selected skills. Offsets and limits count UTF-16 characters. Request subsequent offsets only when needed.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'string' },
            path: { type: 'string' },
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: skillLimits.read },
          },
          required: ['skillId', 'path', 'offset', 'limit'],
          additionalProperties: false,
        },
      },
    ];
  }
  execute(call: ToolCall) {
    this.assertActive();
    if (call.name !== 'skills_read') throw new HttpError(400, '模型请求了未授权工具');
    const parsed = readSchema.safeParse(call.arguments);
    if (!parsed.success) throw new HttpError(400, 'Skill 读取参数无效');
    const { skillId, path, offset, limit } = parsed.data;
    const selected = this.plan.skills.find((skill) => skill.id === skillId);
    if (!selected) throw new HttpError(404, 'Skill 未加入本轮对话');
    const skill = this.plan.provider.read(this.user, skillId, selected.version);
    const file =
      path === 'SKILL.md'
        ? skillDocument(skill)
        : skill.files.find((file) => file.path === path)?.content;
    if (file === undefined) throw new HttpError(404, 'Skill 文件不存在');
    if (offset > file.length) throw new HttpError(400, '读取位置超出文件长度');
    const key = `${skillId}:${path}:${offset}:${limit}`;
    if (this.requested.has(key)) throw new HttpError(400, '模型重复读取同一片段，已停止');
    if (this.requested.size >= skillLimits.reads)
      throw new HttpError(400, '已达到本轮 Skill 读取次数上限');
    const content = file.slice(offset, offset + limit);
    this.record(skill, path, offset, content);
    this.requested.add(key);
    return JSON.stringify({
      skillId,
      version: skill.version,
      path,
      offset,
      content,
      totalCharacters: file.length,
      nextOffset: offset + content.length < file.length ? offset + content.length : null,
    });
  }
}
