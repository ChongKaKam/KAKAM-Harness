import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from '../../kernel/database';
import { HttpError } from '../../kernel/http';
import { normalizeTags } from '../prompts/types';
import { skillLimits, type Skill, type SkillSummary } from './types';

export const resourcePath = z
  .string()
  .max(160)
  .refine(
    (path) =>
      /^(references|assets)\/[\p{L}\p{N}_. /-]+\.(md|txt|json|csv)$/u.test(path) &&
      path
        .split('/')
        .every((part) => part && part !== '.' && part !== '..' && part.trim() === part),
    '参考文件需使用 references/ 或 assets/ 下的相对路径，支持 md、txt、json、csv',
  );
export const skillSchema = z.object({
  title: z.string().trim().min(1).max(skillLimits.title),
  content: z
    .string()
    .min(1)
    .max(skillLimits.content)
    .refine((v) => !!v.trim()),
  description: z.string().trim().max(skillLimits.description),
  tags: z
    .array(z.string().trim().min(1).max(skillLimits.tag))
    .max(skillLimits.tags)
    .transform(normalizeTags),
  files: z
    .array(z.object({ path: resourcePath, content: z.string().max(skillLimits.file) }))
    .max(skillLimits.files)
    .refine(
      (files) => new Set(files.map((f) => f.path.toLowerCase())).size === files.length,
      '文件路径不能重复',
    ),
});
type SkillInput = z.infer<typeof skillSchema>;
export class SkillStore {
  constructor(private db: Database) {}
  get(userId: string, id: string, version?: number): Skill {
    const row = this.db.get<{
      id: string;
      name: string;
      version: number;
      colorSlot: number | null;
      document: string;
    }>(
      `SELECT s.id,s.name,v.version,s.color_slot AS colorSlot,v.document FROM skills s
       JOIN skill_versions v ON v.skill_id=s.id AND v.version=COALESCE(?,s.current_version)
       WHERE s.id=? AND s.user_id=? AND s.deleted=0`,
      version ?? null,
      id,
      userId,
    );
    if (!row) throw new HttpError(404, 'Skill 不存在或该版本不可用');
    const { document, ...metadata } = row;
    const data = JSON.parse(document) as SkillInput;
    return { ...metadata, ...data, fileCount: data.files.length };
  }
  list(userId: string, query = ''): SkillSummary[] {
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return this.db
      .all<{ id: string }>(
        'SELECT id FROM skills WHERE user_id=? AND deleted=0 ORDER BY rowid DESC',
        userId,
      )
      .map(({ id }) => this.get(userId, id))
      .filter((skill) =>
        words.every((q) =>
          [skill.title, skill.description, skill.content, ...skill.tags]
            .join('\n')
            .toLocaleLowerCase()
            .includes(q),
        ),
      )
      .map(({ content: _content, files: _files, ...summary }) => summary);
  }
  save(userId: string, input: SkillInput, id: string = randomUUID(), expectedVersion?: number) {
    if (
      input.content.length + input.files.reduce((n, file) => n + file.content.length, 0) >
      skillLimits.package
    )
      throw new HttpError(400, 'Skill 内容总量超过 200000 字符');
    return this.db.transaction(() => {
      const existing = this.db.get<{ current_version: number }>(
        'SELECT current_version FROM skills WHERE id=? AND user_id=? AND deleted=0',
        id,
        userId,
      );
      if (expectedVersion !== undefined && existing?.current_version !== expectedVersion)
        throw new HttpError(409, 'Skill 已更新，请重新打开后编辑');
      const version = (existing?.current_version ?? 0) + 1;
      if (!existing)
        this.db.run(
          'INSERT INTO skills(id,user_id,name,current_version) VALUES(?,?,?,?)',
          id,
          userId,
          `skill-${id}`,
          version,
        );
      else
        this.db.run(
          'UPDATE skills SET current_version=? WHERE id=? AND user_id=?',
          version,
          id,
          userId,
        );
      this.db.run(
        'INSERT INTO skill_versions(skill_id,version,document) VALUES(?,?,?)',
        id,
        version,
        JSON.stringify(input),
      );
      return this.get(userId, id);
    });
  }
  color(userId: string, id: string, color: number | null) {
    this.get(userId, id);
    this.db.run('UPDATE skills SET color_slot=? WHERE id=? AND user_id=?', color, id, userId);
  }
  delete(userId: string, id: string) {
    this.get(userId, id);
    this.db.run('UPDATE skills SET deleted=1 WHERE id=? AND user_id=?', id, userId);
  }
}
