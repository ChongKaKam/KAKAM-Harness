import { createHash, randomUUID } from 'node:crypto';
import type { Context } from 'cordis';
import { z } from 'zod';
import { HttpError } from '../../kernel/http';
import type {
  WorkspaceApproval,
  WorkspaceDocument,
  WorkspaceKind,
  WorkspacePreference,
  WorkspaceRevision,
  WorkspaceView,
} from './types';

const instructions = `# AGENTS.md

## 当前环境

这是 Drift Space 的会话私有工作区。用工作区工具列出文件、按文档 ID 和版本读取内容。项目中能看到项目说明、已发布版本和专门分享给本会话的版本。需要其他资料时，说明用途并申请访问。

## 连续工作

先读 MEMORY.md。把已确认的决定、暂定想法、待核实的问题及其来源分开记录。新的决定取代旧决定时写明原因。正式文档按用户要求创建或修订，沿用同一文档和基础版本。

## 插件与交接

以当前可用工具和用户选择的模式为准。搜索结果保留来源，Skill 按已选版本使用，生成的产物归当前会话。交接先写私有草稿，由用户审阅和发布。遇到与项目已发布决定不一致的想法，先提醒用户。`;
const memory = '# MEMORY.md\n\n## 当前决定\n\n## 暂定想法\n\n## 未决问题\n\n## 变化原因与来源\n';
const projectInstructions =
  '# 项目 AGENTS.md\n\n本项目目录使用用户明确发布的版本。引用资料时标明文件和版本，区分已决定、待核实和下一步。';
const id = z.string().uuid();
const versionSchema = z.number().int().positive();
const revisionText = z.string().max(100_000);
const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine(
    (name) => !/[\/\\\u0000-\u001f]/.test(name) && !['.', '..'].includes(name),
    '请输入单个文件名',
  );
export const workspaceCreate = z
  .object({
    name: nameSchema,
    content: revisionText,
    kind: z.enum(['document', 'handoff']).optional(),
  })
  .strict();
export const workspaceEdit = z
  .object({ baseVersion: versionSchema, content: revisionText })
  .strict();
export const workspacePublish = z
  .object({
    documentId: id,
    version: versionSchema,
    content: revisionText.optional(),
    references: z
      .array(z.object({ documentId: id, version: versionSchema }).strict())
      .max(32)
      .optional(),
  })
  .strict();
const reference = { documentId: id, version: versionSchema };
const purpose = z.string().trim().min(1).max(500);
export const workspaceRequest = z
  .object({
    taskId: id,
    sourceConversationId: id,
    documentId: id.optional(),
    version: versionSchema.optional(),
    purpose,
  })
  .strict()
  .refine((v) => !!v.documentId === !!v.version, '须同时指定文件和版本');
const workspaceShare = z.object({ targetConversationId: id, ...reference }).strict();
export const workspaceGrant = z
  .object({
    taskId: z.union([id, z.literal('next')]),
    targetConversationId: id,
    ...reference,
    purpose,
  })
  .strict();
export const workspaceDecision = z
  .object({
    decision: z.enum(['approve', 'reject']),
    documentId: id.optional(),
    version: versionSchema.optional(),
  })
  .strict()
  .refine((v) => !!v.documentId === !!v.version, '须同时指定文件和版本');
const preferenceText = z.string().trim().min(1).max(1000);
export const preferenceCreate = z.object({ content: preferenceText }).strict();
export const preferenceEdit = z
  .object({ version: versionSchema, content: preferenceText })
  .strict();
export const preferenceDecision = z
  .object({ version: versionSchema, decision: z.enum(['admit', 'withdraw']) })
  .strict();

function atomic<T>(ctx: Context, action: () => T): T {
  return ctx.db.connection.isTransaction ? action() : ctx.db.transaction(action);
}
function notFound(): never {
  throw new HttpError(404, '工作区或资料不存在');
}
type Here = { groupId: string | null };
function workspace(ctx: Context, userId: string, conversationId: string): Here {
  return (
    ctx.db.get<Here>(
      `SELECT c.group_id AS groupId FROM harness_workspaces w JOIN conversations c ON c.id=w.conversation_id AND c.user_id=w.user_id
     WHERE w.user_id=? AND c.id=?`,
      userId,
      conversationId,
    ) ?? notFound()
  );
}
export function isHarnessConversation(
  ctx: Context,
  userId: string,
  conversationId: string,
): boolean {
  return !!ctx.db.get(
    'SELECT 1 FROM harness_workspaces w JOIN conversations c ON c.id=w.conversation_id AND c.user_id=w.user_id WHERE w.user_id=? AND c.id=?',
    userId,
    conversationId,
  );
}
// Bound the durable cost of immutable text revisions and copies published into another lifecycle.
const workspaceByteLimit = 16 * 1024 * 1024;
export function checkTextCapacity(ctx: Context, userId: string, content: string) {
  const size = ctx.db.get<{ bytes: number }>(
    `SELECT
    (SELECT COALESCE(SUM(r.size_bytes),0) FROM harness_revisions r JOIN harness_documents d ON d.id=r.document_id WHERE d.user_id=?) +
    (SELECT COALESCE(SUM(size_bytes),0) FROM harness_publications WHERE user_id=?) +
    (SELECT COALESCE(SUM(size_bytes),0) FROM harness_preferences WHERE user_id=?) AS bytes`,
    userId,
    userId,
    userId,
  )!.bytes;
  if (size + Buffer.byteLength(content) + 256 > workspaceByteLimit)
    throw new HttpError(409, '账户工作区文本版本已达 16 MiB 限额');
}
function addDocument(
  ctx: Context,
  userId: string,
  conversationId: string | null,
  groupId: string | null,
  name: string,
  kind: WorkspaceKind,
  content: string,
) {
  checkTextCapacity(ctx, userId, content);
  const documentId = randomUUID();
  ctx.db.run(
    'INSERT INTO harness_documents(id,user_id,conversation_id,group_id,name,kind,version) VALUES(?,?,?,?,?,?,1)',
    documentId,
    userId,
    conversationId,
    groupId,
    name,
    kind,
  );
  ctx.db.run(
    'INSERT INTO harness_revisions(document_id,version,content) VALUES(?,1,?)',
    documentId,
    content,
  );
  return documentId;
}
function ensureProject(ctx: Context, userId: string, groupId: string | null) {
  if (
    !groupId ||
    ctx.db.get(
      "SELECT id FROM harness_documents WHERE user_id=? AND group_id=? AND kind='instructions'",
      userId,
      groupId,
    )
  )
    return;
  if (!ctx.db.get('SELECT 1 FROM conversation_groups WHERE user_id=? AND id=?', userId, groupId))
    notFound();
  atomic(ctx, () =>
    addDocument(ctx, userId, null, groupId, 'AGENTS.md', 'instructions', projectInstructions),
  );
}
export function initializeWorkspace(ctx: Context, userId: string, conversationId: string): void {
  atomic(ctx, () => {
    const here = ctx.db.get<Here>(
      'SELECT group_id AS groupId FROM conversations WHERE id=? AND user_id=?',
      conversationId,
      userId,
    );
    if (!here) notFound();
    const added = ctx.db.run(
      'INSERT OR IGNORE INTO harness_workspaces(conversation_id,user_id) VALUES(?,?)',
      conversationId,
      userId,
    );
    if (added.changes) {
      addDocument(ctx, userId, conversationId, null, 'AGENTS.md', 'instructions', instructions);
      addDocument(ctx, userId, conversationId, null, 'MEMORY.md', 'memory', memory);
    }
    ensureProject(ctx, userId, here.groupId);
  });
}

// This projection is shared by directory listing, history, and reads. Every exposed row is a specific version.
const visible = `WITH here AS (
  SELECT w.conversation_id AS id,w.user_id,c.group_id FROM harness_workspaces w
  JOIN conversations c ON c.id=w.conversation_id AND c.user_id=w.user_id WHERE w.user_id=? AND w.conversation_id=?
), pins AS (
  SELECT a.user_id,a.group_id,a.document_id,a.version FROM here JOIN harness_access a
    ON a.user_id=here.user_id AND a.target_conversation_id=here.id AND a.group_id=here.group_id AND a.status='approved'
  UNION ALL
  SELECT s.user_id,s.group_id,s.document_id,s.version FROM here JOIN harness_direct_shares s
    ON s.user_id=here.user_id AND s.target_conversation_id=here.id AND s.group_id=here.group_id
), scoped AS (
  SELECT d.id,d.name,d.kind,'private' AS scope,d.conversation_id AS sourceConversationId,r.version
  FROM here JOIN harness_documents d ON d.user_id=here.user_id AND d.conversation_id=here.id JOIN harness_revisions r ON r.document_id=d.id
  UNION ALL
  SELECT d.id,d.name,d.kind,'project',NULL,r.version FROM here JOIN harness_documents d ON d.user_id=here.user_id AND d.group_id=here.group_id JOIN harness_revisions r ON r.document_id=d.id
  UNION ALL
  SELECT p.document_id,p.name,p.kind,'project',p.source_conversation_id,p.version FROM here JOIN harness_publications p ON p.user_id=here.user_id AND p.group_id=here.group_id
  UNION ALL
  SELECT d.id,d.name,d.kind,'granted',d.conversation_id,p.version FROM pins p
  JOIN harness_documents d ON d.id=p.document_id AND d.user_id=p.user_id
  JOIN conversations origin ON origin.id=d.conversation_id AND origin.user_id=p.user_id AND origin.group_id=p.group_id
  JOIN harness_revisions r ON r.document_id=d.id AND r.version=p.version
), allowed AS (
  SELECT * FROM scoped WHERE kind<>'artifact' OR EXISTS(
    SELECT 1 FROM harness_artifact_revisions ar JOIN production_artifacts p ON p.id=ar.artifact_id JOIN here ON here.user_id=p.user_id
    WHERE ar.document_id=scoped.id AND ar.version=scoped.version AND (p.expires_at IS NULL OR p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )
)`;
const precedence =
  "version DESC, CASE scope WHEN 'private' THEN 0 WHEN 'granted' THEN 1 ELSE 2 END";
export function listWorkspaceDocuments(
  ctx: Context,
  userId: string,
  conversationId: string,
): WorkspaceDocument[] {
  ensureProject(ctx, userId, workspace(ctx, userId, conversationId).groupId);
  return ctx.db.all<WorkspaceDocument>(
    visible +
      ` SELECT id,name,kind,scope,sourceConversationId,version FROM
    (SELECT *,row_number() OVER(PARTITION BY id ORDER BY ${precedence}) AS position FROM allowed)
    WHERE position=1 ORDER BY scope,name,id`,
    userId,
    conversationId,
  );
}
export function listWorkspaceSources(
  ctx: Context,
  userId: string,
  conversationId: string,
): { id: string; title: string }[] {
  const { groupId } = workspace(ctx, userId, conversationId);
  if (!groupId) return [];
  return ctx.db.all(
    'SELECT c.id,c.title FROM conversations c JOIN harness_workspaces w ON w.conversation_id=c.id AND w.user_id=c.user_id WHERE c.user_id=? AND c.group_id=? AND c.id<>? ORDER BY c.updated_at DESC,c.id',
    userId,
    groupId,
    conversationId,
  );
}
export function workspaceVersions(
  ctx: Context,
  userId: string,
  conversationId: string,
  documentId: string,
): number[] {
  const rows = ctx.db.all<{ version: number }>(
    visible + ' SELECT DISTINCT version FROM allowed WHERE id=? ORDER BY version DESC',
    userId,
    conversationId,
    documentId,
  );
  if (!rows.length) notFound();
  return rows.map((r) => r.version);
}
export function readWorkspaceDocument(
  ctx: Context,
  userId: string,
  conversationId: string,
  documentId: string,
  version?: number,
): WorkspaceRevision {
  const document = ctx.db.get<WorkspaceDocument>(
    visible +
      ` SELECT * FROM allowed WHERE id=? AND (? IS NULL OR version=?) ORDER BY ${precedence} LIMIT 1`,
    userId,
    conversationId,
    documentId,
    version ?? null,
    version ?? null,
  );
  if (!document) notFound();
  let revision: { content: string } | undefined;
  if (document.scope === 'project')
    revision = ctx.db.get(
      'SELECT p.content FROM harness_publications p JOIN conversations c ON c.group_id=p.group_id AND c.user_id=p.user_id WHERE c.user_id=? AND c.id=? AND p.document_id=? AND p.version=?',
      userId,
      conversationId,
      documentId,
      document.version,
    );
  revision ??= ctx.db.get(
    'SELECT r.content FROM harness_revisions r JOIN harness_documents d ON d.id=r.document_id WHERE d.user_id=? AND d.id=? AND r.version=?',
    userId,
    documentId,
    document.version,
  );
  if (!revision) notFound();
  return { ...document, ...revision };
}
export function createWorkspaceDocument(
  ctx: Context,
  userId: string,
  conversationId: string,
  raw: z.input<typeof workspaceCreate>,
): WorkspaceRevision {
  const input = workspaceCreate.parse(raw);
  workspace(ctx, userId, conversationId);
  return atomic(ctx, () => {
    if (
      ctx.db.get(
        'SELECT 1 FROM harness_documents WHERE user_id=? AND conversation_id=? AND name=?',
        userId,
        conversationId,
        input.name,
      )
    )
      throw new HttpError(409, '文件名已存在，请更新原文件');
    const documentId = addDocument(
      ctx,
      userId,
      conversationId,
      null,
      input.name,
      input.kind ?? 'document',
      input.content,
    );
    return readWorkspaceDocument(ctx, userId, conversationId, documentId);
  });
}
export function updateWorkspaceDocument(
  ctx: Context,
  userId: string,
  conversationId: string,
  documentId: string,
  raw: z.input<typeof workspaceEdit>,
  allowProjectRules = false,
): WorkspaceRevision {
  const input = workspaceEdit.parse(raw);
  const { groupId } = workspace(ctx, userId, conversationId);
  return atomic(ctx, () => {
    const doc = ctx.db.get<{ kind: WorkspaceKind; version: number }>(
      `SELECT kind,version FROM harness_documents WHERE id=? AND user_id=? AND (conversation_id=? OR (?=1 AND group_id=? AND kind='instructions'))`,
      documentId,
      userId,
      conversationId,
      Number(allowProjectRules),
      groupId,
    );
    if (!doc) notFound();
    if (doc.kind === 'artifact') throw new HttpError(409, '请通过生成工具更新产物文件');
    if (doc.version !== input.baseVersion) throw new HttpError(409, '文件已更新，请先读取最新版本');
    if ((doc.kind === 'instructions' || doc.kind === 'memory') && input.content.length > 8000)
      throw new HttpError(400, '工作区基础文档最多 8000 字符');
    checkTextCapacity(ctx, userId, input.content);
    ctx.db.run(
      'INSERT INTO harness_revisions(document_id,version,content) VALUES(?,?,?)',
      documentId,
      doc.version + 1,
      input.content,
    );
    ctx.db.run(
      'UPDATE harness_documents SET version=? WHERE id=? AND user_id=?',
      doc.version + 1,
      documentId,
      userId,
    );
    return readWorkspaceDocument(ctx, userId, conversationId, documentId, doc.version + 1);
  });
}
export function publishWorkspaceDocument(
  ctx: Context,
  userId: string,
  conversationId: string,
  raw: z.input<typeof workspacePublish>,
): WorkspaceRevision {
  const input = workspacePublish.parse(raw);
  const { groupId } = workspace(ctx, userId, conversationId);
  if (!groupId) throw new HttpError(409, '请先将对话加入项目分组');
  return atomic(ctx, () => {
    let revision = readWorkspaceDocument(
      ctx,
      userId,
      conversationId,
      input.documentId,
      input.version,
    );
    if (revision.scope !== 'private') notFound();
    if (input.content !== undefined && revision.content !== input.content) {
      const previous = ctx.db.get<{ content: string }>(
        'SELECT content FROM harness_publications WHERE user_id=? AND group_id=? AND document_id=? AND version=?',
        userId,
        groupId,
        revision.id,
        input.version + 1,
      );
      revision =
        previous?.content === input.content
          ? readWorkspaceDocument(ctx, userId, conversationId, revision.id, input.version + 1)
          : updateWorkspaceDocument(ctx, userId, conversationId, input.documentId, {
              baseVersion: input.version,
              content: input.content,
            });
    }
    const references = (input.references ?? []).map((ref) =>
      readWorkspaceDocument(ctx, userId, conversationId, ref.documentId, ref.version),
    );
    for (const item of [revision, ...references]) {
      if (item.scope !== 'private') throw new HttpError(403, '只能将当前对话的私有文件发布到项目');
      if (
        ctx.db.get(
          'SELECT 1 FROM harness_publications WHERE user_id=? AND group_id=? AND document_id=? AND version=?',
          userId,
          groupId,
          item.id,
          item.version,
        )
      )
        continue;
      checkTextCapacity(ctx, userId, item.content);
      ctx.db.run(
        `INSERT INTO harness_publications(user_id,group_id,document_id,version,name,kind,source_conversation_id,content) VALUES(?,?,?,?,?,?,?,?)`,
        userId,
        groupId,
        item.id,
        item.version,
        item.name,
        item.kind,
        conversationId,
        item.content,
      );
    }
    return { ...revision, scope: 'project' };
  });
}

const accessSelect = `SELECT a.id,a.group_id AS groupId,a.source_conversation_id AS sourceConversationId,
  a.target_conversation_id AS targetConversationId,a.task_id AS taskId,a.purpose,
  a.document_id AS documentId,a.version,d.name,a.status,a.expires_at AS expiresAt
  FROM harness_access a LEFT JOIN harness_documents d ON d.user_id=a.user_id AND d.id=a.document_id
  JOIN conversations origin ON origin.id=a.source_conversation_id AND origin.user_id=a.user_id AND origin.group_id=a.group_id
  JOIN conversations target ON target.id=a.target_conversation_id AND target.user_id=a.user_id AND target.group_id=a.group_id`;
const now = () => new Date().toISOString();
function accessRow(
  ctx: Context,
  userId: string,
  conversationId: string,
  requestId: string,
): WorkspaceApproval {
  return (
    ctx.db.get<WorkspaceApproval>(
      accessSelect +
        ' WHERE a.user_id=? AND a.id=? AND (a.source_conversation_id=? OR a.target_conversation_id=?)',
      userId,
      requestId,
      conversationId,
      conversationId,
    ) ?? notFound()
  );
}
export function listWorkspaceApprovals(
  ctx: Context,
  userId: string,
  conversationId: string,
): WorkspaceApproval[] {
  return ctx.db.all<WorkspaceApproval>(
    accessSelect +
      ` WHERE a.user_id=? AND (a.source_conversation_id=? OR a.target_conversation_id=?)
    AND (a.status<>'preauthorized' OR a.expires_at>?) ORDER BY a.created_at DESC,a.id`,
    userId,
    conversationId,
    conversationId,
    now(),
  );
}
function sharedGroup(ctx: Context, userId: string, source: string, target: string): string {
  const origin = workspace(ctx, userId, source);
  const destination = workspace(ctx, userId, target);
  if (!origin.groupId || origin.groupId !== destination.groupId || source === target) notFound();
  return origin.groupId;
}
function checkTask(ctx: Context, userId: string, conversationId: string, taskId: string) {
  if (
    !ctx.db.get(
      `SELECT m.id FROM messages m JOIN harness_workspaces w ON w.conversation_id=m.conversation_id
    JOIN conversations c ON c.id=w.conversation_id AND c.user_id=w.user_id
    WHERE w.user_id=? AND m.conversation_id=? AND m.id=? AND m.role='assistant'`,
      userId,
      conversationId,
      taskId,
    )
  )
    throw new HttpError(404, '目标对话中没有这项任务');
}
function privateRevision(
  ctx: Context,
  userId: string,
  source: string,
  documentId: string,
  version: number,
) {
  if (readWorkspaceDocument(ctx, userId, source, documentId, version).scope !== 'private')
    notFound();
}
function accessKey(
  groupId: string,
  source: string,
  target: string,
  task: string,
  doc: string | null,
  version: number | null,
  purpose: string,
) {
  return createHash('sha256')
    .update(JSON.stringify([groupId, source, target, task, doc, version, purpose]))
    .digest('hex');
}
export function shareWorkspaceDocument(
  ctx: Context,
  userId: string,
  source: string,
  raw: z.input<typeof workspaceShare>,
) {
  const share = workspaceShare.parse(raw);
  return atomic(ctx, () => {
    const groupId = sharedGroup(ctx, userId, source, share.targetConversationId);
    privateRevision(ctx, userId, source, share.documentId, share.version);
    ctx.db.run(
      `INSERT INTO harness_direct_shares(user_id,group_id,target_conversation_id,document_id,version)
      VALUES(?,?,?,?,?) ON CONFLICT(user_id,target_conversation_id,group_id,document_id,version) DO NOTHING`,
      userId,
      groupId,
      share.targetConversationId,
      share.documentId,
      share.version,
    );
    return share;
  });
}

export function requestWorkspaceAccess(
  ctx: Context,
  userId: string,
  target: string,
  raw: z.input<typeof workspaceRequest>,
): WorkspaceApproval {
  const input = workspaceRequest.parse(raw);
  const source = input.sourceConversationId;
  return atomic(ctx, () => {
    const groupId = sharedGroup(ctx, userId, source, target);
    checkTask(ctx, userId, target, input.taskId);
    if (input.documentId && input.version)
      privateRevision(ctx, userId, source, input.documentId, input.version);
    const key = accessKey(
      groupId,
      source,
      target,
      input.taskId,
      input.documentId ?? null,
      input.version ?? null,
      input.purpose,
    );
    const existing = ctx.db.get<{ id: string }>(
      'SELECT id FROM harness_access WHERE user_id=? AND request_key=?',
      userId,
      key,
    );
    if (existing) return accessRow(ctx, userId, target, existing.id);
    // A single matching advance grant already records the human's exact file selection.
    const matches = ctx.db.all<{ id: string; documentId: string; version: number }>(
      `SELECT id,document_id AS documentId,version FROM harness_access WHERE user_id=? AND group_id=?
      AND source_conversation_id=? AND target_conversation_id=? AND (? IS NULL OR (document_id=? AND version=?)) AND purpose=?
      AND status='preauthorized' AND expires_at>? AND (task_id=? OR task_id='next') ORDER BY (task_id='next') ASC,created_at LIMIT 2`,
      userId,
      groupId,
      source,
      target,
      input.documentId ?? null,
      input.documentId ?? null,
      input.version ?? null,
      input.purpose,
      now(),
      input.taskId,
    );
    const grant = matches.length === 1 ? matches[0] : undefined;
    if (grant) {
      privateRevision(ctx, userId, source, grant.documentId, grant.version);
      ctx.db.run(
        "UPDATE harness_access SET status='approved',task_id=?,request_key=?,expires_at=NULL WHERE user_id=? AND id=? AND status='preauthorized'",
        input.taskId,
        key,
        userId,
        grant.id,
      );
      return accessRow(ctx, userId, target, grant.id);
    }
    const requestId = randomUUID();
    ctx.db.run(
      `INSERT INTO harness_access(id,user_id,group_id,source_conversation_id,target_conversation_id,task_id,purpose,
      document_id,version,status,created_at,request_key) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)`,
      requestId,
      userId,
      groupId,
      source,
      target,
      input.taskId,
      input.purpose,
      input.documentId ?? null,
      input.version ?? null,
      now(),
      key,
    );
    return accessRow(ctx, userId, target, requestId);
  });
}
export function decideWorkspaceAccess(
  ctx: Context,
  userId: string,
  conversationId: string,
  requestId: string,
  raw: z.input<typeof workspaceDecision>,
): WorkspaceApproval {
  const input = workspaceDecision.parse(raw);
  return atomic(ctx, () => {
    const a = accessRow(ctx, userId, conversationId, requestId);
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    if (
      input.documentId &&
      a.documentId &&
      (input.documentId !== a.documentId || input.version !== a.version)
    )
      throw new HttpError(409, '授权必须匹配申请中的文件版本');
    if (a.status === status) return a;
    if (a.status !== 'pending') throw new HttpError(409, '申请已处理');
    if (status === 'approved') {
      checkTask(ctx, userId, a.targetConversationId, a.taskId);
      if (!a.documentId && conversationId !== a.sourceConversationId)
        throw new HttpError(409, '请在来源对话选择要开放的文件版本');
      const doc = a.documentId ?? input.documentId;
      const version = a.version ?? input.version;
      if (!doc || !version) throw new HttpError(400, '请选择要开放的文件版本');
      privateRevision(ctx, userId, a.sourceConversationId, doc, version);
      ctx.db.run(
        "UPDATE harness_access SET status='approved', document_id=?,version=? WHERE id=? AND user_id=? AND status='pending'",
        doc,
        version,
        requestId,
        userId,
      );
    } else
      ctx.db.run(
        "UPDATE harness_access SET status='rejected' WHERE id=? AND user_id=? AND status='pending'",
        requestId,
        userId,
      );
    return accessRow(ctx, userId, conversationId, requestId);
  });
}
export function preauthorizeWorkspaceAccess(
  ctx: Context,
  userId: string,
  source: string,
  raw: z.input<typeof workspaceGrant>,
  onPendingApproved?: (approval: WorkspaceApproval) => void,
): WorkspaceApproval {
  const input = workspaceGrant.parse(raw);
  const target = input.targetConversationId;
  let matchedPending = false;
  const grant = atomic(ctx, () => {
    const groupId = sharedGroup(ctx, userId, source, target);
    privateRevision(ctx, userId, source, input.documentId, input.version);
    if (input.taskId !== 'next') checkTask(ctx, userId, target, input.taskId);
    const key = accessKey(
      groupId,
      source,
      target,
      input.taskId,
      input.documentId,
      input.version,
      input.purpose,
    );
    const previous = ctx.db.get<{ id: string }>(
      'SELECT id FROM harness_access WHERE user_id=? AND grant_key=?',
      userId,
      key,
    );
    if (previous) {
      const row = accessRow(ctx, userId, source, previous.id);
      if (row.status === 'approved' || (row.expiresAt && row.expiresAt > now())) return row;
      ctx.db.run(
        'UPDATE harness_access SET grant_key=NULL WHERE user_id=? AND id=?',
        userId,
        previous.id,
      );
    }
    const pending = ctx.db.get<{ id: string }>(
      "SELECT id FROM harness_access WHERE user_id=? AND request_key=? AND status='pending'",
      userId,
      key,
    );
    if (pending) {
      const result = decideWorkspaceAccess(ctx, userId, source, pending.id, {
        decision: 'approve',
      });
      ctx.db.run(
        'UPDATE harness_access SET grant_key=? WHERE user_id=? AND id=?',
        key,
        userId,
        pending.id,
      );
      matchedPending = true;
      return result;
    }
    const grantId = randomUUID();
    ctx.db.run(
      `INSERT INTO harness_access(id,user_id,group_id,source_conversation_id,target_conversation_id,task_id,purpose,document_id,version,status,created_at,expires_at,grant_key)
      VALUES(?,?,?,?,?,?,?,?,?,'preauthorized',?,?,?)`,
      grantId,
      userId,
      groupId,
      source,
      target,
      input.taskId,
      input.purpose,
      input.documentId,
      input.version,
      now(),
      new Date(Date.now() + 86400_000).toISOString(),
      key,
    );
    return accessRow(ctx, userId, source, grantId);
  });
  if (matchedPending) onPendingApproved?.(grant);
  return grant;
}

const preferenceSelect =
  'SELECT id,content,version,status,admitted_at AS admittedAt FROM harness_preferences';
function preference(ctx: Context, userId: string, prefId: string): WorkspacePreference {
  return (
    ctx.db.get<WorkspacePreference>(
      preferenceSelect + ' WHERE id=? AND user_id=?',
      prefId,
      userId,
    ) ?? notFound()
  );
}
export function createWorkspacePreference(
  ctx: Context,
  userId: string,
  raw: z.input<typeof preferenceCreate>,
): WorkspacePreference {
  const { content } = preferenceCreate.parse(raw);
  checkTextCapacity(ctx, userId, content);
  const prefId = randomUUID();
  ctx.db.run(
    "INSERT INTO harness_preferences(id,user_id,content,version,status) VALUES(?,?,?,1,'pending')",
    prefId,
    userId,
    content,
  );
  return preference(ctx, userId, prefId);
}
export function editWorkspacePreference(
  ctx: Context,
  userId: string,
  prefId: string,
  raw: z.input<typeof preferenceEdit>,
): WorkspacePreference {
  const input = preferenceEdit.parse(raw);
  const row = preference(ctx, userId, prefId);
  if (row.version !== input.version) throw new HttpError(409, '偏好版本已变化');
  if (
    row.content !== input.content &&
    Buffer.byteLength(input.content) > Buffer.byteLength(row.content)
  )
    checkTextCapacity(ctx, userId, input.content);
  if (row.content !== input.content)
    ctx.db.run(
      "UPDATE harness_preferences SET status='pending',content=?,version=version+1,admitted_at=NULL WHERE user_id=? AND id=? AND version=?",
      input.content,
      userId,
      prefId,
      input.version,
    );
  return preference(ctx, userId, prefId);
}
export function decideWorkspacePreference(
  ctx: Context,
  userId: string,
  prefId: string,
  raw: z.input<typeof preferenceDecision>,
): WorkspacePreference {
  const input = preferenceDecision.parse(raw);
  const row = preference(ctx, userId, prefId);
  const status = input.decision === 'admit' ? 'active' : 'withdrawn';
  if (input.version !== row.version) throw new HttpError(409, '偏好版本已变化');
  if (row.status !== status && status === 'active') {
    const active = ctx.db.get<{ count: number; characters: number }>(
      "SELECT COUNT(*) AS count, COALESCE(SUM(length(content)),0) AS characters FROM harness_preferences WHERE user_id=? AND status='active'",
      userId,
    )!;
    if (active.count >= 64 || active.characters + [...row.content].length > 8000)
      throw new HttpError(409, '已纳入偏好最多 64 条、合计 8000 字符，请先撤回部分偏好');
  }
  if (row.status !== status)
    ctx.db.run(
      'UPDATE harness_preferences SET status=?,admitted_at=?,version=version+1 WHERE user_id=? AND id=? AND version=?',
      status,
      status === 'active' ? now() : null,
      userId,
      prefId,
      input.version,
    );
  return preference(ctx, userId, prefId);
}
export function workspaceView(ctx: Context, userId: string, conversationId: string): WorkspaceView {
  return {
    groupId: workspace(ctx, userId, conversationId).groupId,
    documents: listWorkspaceDocuments(ctx, userId, conversationId),
    approvals: listWorkspaceApprovals(ctx, userId, conversationId),
    preferences: ctx.db.all<WorkspacePreference>(
      preferenceSelect + ' WHERE user_id=? ORDER BY rowid',
      userId,
    ),
    sources: listWorkspaceSources(ctx, userId, conversationId),
  };
}
export function loadWorkspaceContext(ctx: Context, userId: string, conversationId: string): string {
  const documents = listWorkspaceDocuments(ctx, userId, conversationId);
  const blocks = documents
    .filter(
      (d) =>
        (d.scope === 'private' && (d.kind === 'instructions' || d.kind === 'memory')) ||
        (d.scope === 'project' &&
          d.kind === 'instructions' &&
          !d.sourceConversationId &&
          !!ctx.db.get(
            'SELECT 1 FROM harness_documents WHERE id=? AND user_id=? AND group_id IS NOT NULL',
            d.id,
            userId,
          )),
    )
    .map(
      (d) =>
        `[${d.scope === 'project' ? '项目' : '当前会话'}/${d.name} v${d.version}]\n${readWorkspaceDocument(ctx, userId, conversationId, d.id, d.version).content}`,
    );
  const personal = ctx.db.all<{ content: string }>(
    "SELECT content FROM harness_preferences WHERE user_id=? AND status='active' ORDER BY rowid DESC",
    userId,
  );
  if (personal.length)
    blocks.push('[用户已纳入的个人偏好]\n' + personal.map((p) => p.content).join('\n'));
  const directory = documents.filter(
    (d) =>
      d.kind === 'document' ||
      d.kind === 'handoff' ||
      d.kind === 'artifact' ||
      d.scope === 'granted',
  );
  if (directory.length)
    blocks.push(
      '[按需读取的文件：文件名 / 当前可读版本 / 文件 ID]\n' +
        directory
          .slice(0, 80)
          .map((d) => `${d.name} / v${d.version} / ${d.id}`)
          .join('\n'),
    );
  return '以下是用户级工作区资料。普通知识问题先讲原理，项目文件按需读取。\n' + blocks.join('\n\n');
}

export const readWorkspaceApproval = accessRow;
// Only the authenticated human submission route calls this interpreter. Tools never receive it.
export function applyWorkspaceCommand(
  ctx: Context,
  userId: string,
  conversationId: string,
  text: string,
  onApproved?: (approval: WorkspaceApproval) => void,
): string | undefined {
  const command = text.trim().replace(/[。！!]+$/u, '');
  const decide =
    /^(同意|批准|允许|拒绝|不同意)(?:这项申请|此申请|该申请|该请求|这个申请|申请|请求)?(?:\s+([0-9a-f-]{36}))?(?:[，, ]+读取[「“"]([^」”"]+)[」”"]\s*[vV](\d+))?$/iu.exec(
      command,
    );
  if (decide) {
    const rows = listWorkspaceApprovals(ctx, userId, conversationId).filter((a) =>
      decide[2] ? a.id === decide[2] : a.status === 'pending',
    );
    if (!rows.length) return decide[2] ? '当前对话中没有这项申请。' : undefined;
    if (rows.length !== 1) return '有多项待审核申请，请在卡片选择，或输入“同意申请 申请ID”。';
    const row = rows[0];
    const decision = ['拒绝', '不同意'].includes(decide[1]) ? 'reject' : 'approve';
    let docId = row.documentId;
    if (decide[3]) {
      const doc = listWorkspaceDocuments(ctx, userId, conversationId).find(
        (d) => d.scope === 'private' && d.name === decide[3],
      );
      if (!doc || conversationId !== row.sourceConversationId)
        return '请在来源对话选择具体的文件和版本。';
      docId = doc.id;
    }
    if (decision === 'approve' && !docId) return '请在来源对话的申请卡选择具体文件和版本后批准。';
    const result = decideWorkspaceAccess(ctx, userId, conversationId, row.id, {
      decision,
      ...(docId
        ? { documentId: docId, version: decide[4] ? Number(decide[4]) : row.version! }
        : {}),
    });
    if (row.status === 'pending' && result.status === 'approved') onApproved?.(result);
    return result.status === 'approved'
      ? `已批准目标对话读取「${result.name}」v${result.version}。`
      : '已拒绝这项读取申请。';
  }
  if (/^(?:请)?更新到(?:当前|本)?项目$/u.test(command)) {
    const { groupId } = workspace(ctx, userId, conversationId);
    if (!groupId) return '请先将当前对话加入一个项目分组。';
    const drafts = ctx.db.all<{ id: string; name: string; version: number }>(
      `SELECT d.id,d.name,d.version FROM harness_documents d
      WHERE d.user_id=? AND d.conversation_id=? AND d.kind IN ('document','handoff')
      AND NOT EXISTS(SELECT 1 FROM harness_publications p WHERE p.user_id=d.user_id AND p.group_id=?
      AND p.document_id=d.id AND p.version=d.version) ORDER BY d.name,d.id LIMIT 21`,
      userId,
      conversationId,
      groupId,
    );
    if (!drafts.length) return '当前对话没有待发布的正式文档或交接草稿。';
    if (drafts.length > 1) {
      const choices = drafts
        .slice(0, 20)
        .map((doc) => `「${doc.name}」v${doc.version}`)
        .join('、');
      return `有多个待发布版本：${choices}${drafts.length > 20 ? '等' : ''}。请指定要发布的文件名和版本。`;
    }
    const doc = drafts[0];
    const published = publishWorkspaceDocument(ctx, userId, conversationId, {
      documentId: doc.id,
      version: doc.version,
    });
    return `已将「${published.name}」v${published.version} 发布到项目。`;
  }
  const publish =
    /^(?:请)?(?:发布|开放|共享|更新)[「『“"]([^」』”"]+)[」』”"]\s*[vV](\d+)\s*(?:到|给|至)\s*(?:当前|本)?项目$/u.exec(
      command,
    );
  if (publish) {
    const doc = listWorkspaceDocuments(ctx, userId, conversationId).find(
      (d) => d.scope === 'private' && (d.id === publish[1] || d.name === publish[1]),
    );
    if (!doc) return '当前对话中没有这份私有文件，请核对文件名。';
    const result = publishWorkspaceDocument(ctx, userId, conversationId, {
      documentId: doc.id,
      version: Number(publish[2]),
    });
    return `已将「${result.name}」v${result.version} 发布到项目。`;
  }
  const direct =
    /^(?:请)?(?:仅|只)?分享[「“"]([^」”"]+)[」”"]\s*[vV](\d+)\s*给(?:对话)?[「“"]([^」”"]+)[」”"]$/u.exec(
      command,
    );
  if (direct) {
    const targets = listWorkspaceSources(ctx, userId, conversationId).filter(
      (item) => item.id === direct[3] || item.title === direct[3],
    );
    if (targets.length !== 1) return '无法唯一确定目标对话，请使用目标对话 ID。';
    const doc = listWorkspaceDocuments(ctx, userId, conversationId).find(
      (item) => item.scope === 'private' && (item.id === direct[1] || item.name === direct[1]),
    );
    if (!doc) return '请指定本对话私有文件的名称或 ID。';
    const shared = shareWorkspaceDocument(ctx, userId, conversationId, {
      targetConversationId: targets[0].id,
      documentId: doc.id,
      version: Number(direct[2]),
    });
    return `已将「${doc.name}」v${shared.version} 分享给对话「${targets[0].title}」。`;
  }
  const grant =
    /^(?:预授权|授权|允许)[「“"]([^」”"]+)[」”"](?:的)?任务[「“"]([^」”"]+)[」”"]读取[「“"]([^」”"]+)[」”"]\s*[vV](\d+)[，, ]+用途[：:]\s*(.+)$/u.exec(
      command,
    );
  if (grant) {
    const sources = listWorkspaceSources(ctx, userId, conversationId).filter(
      (s) => s.id === grant[1] || s.title === grant[1],
    );
    if (sources.length !== 1) return '无法唯一确定目标对话，请使用目标对话 ID。';
    const doc = listWorkspaceDocuments(ctx, userId, conversationId).find(
      (d) => d.scope === 'private' && (d.id === grant[3] || d.name === grant[3]),
    );
    if (!doc) return '请指定本对话私有文件的名称或 ID。';
    const taskId = ['下一次', '下次', 'next'].includes(grant[2]) ? 'next' : grant[2];
    if (taskId !== 'next' && !id.safeParse(taskId).success)
      return '请指定目标对话的任务 ID，或“下一次”匹配请求。';
    const result = preauthorizeWorkspaceAccess(
      ctx,
      userId,
      conversationId,
      {
        targetConversationId: sources[0].id,
        taskId,
        documentId: doc.id,
        version: Number(grant[4]),
        purpose: grant[5],
      },
      onApproved,
    );
    return `已授权「${sources[0].title}」为“${result.purpose}”读取「${result.name}」v${result.version}。`;
  }
  return undefined;
}
