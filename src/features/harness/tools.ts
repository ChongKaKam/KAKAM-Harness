import type { Context } from 'cordis';
import { z } from 'zod';
import type { ToolDefinition } from '../../adapters/registry';
import { HttpError } from '../../kernel/http';
import type { ConversationToolScope } from '../extensions/conversation-tools';
import {
  createWorkspaceDocument,
  createWorkspacePreference,
  listWorkspaceDocuments,
  listWorkspaceSources,
  readWorkspaceDocument,
  requestWorkspaceAccess,
  updateWorkspaceDocument,
} from './workspace';

export const workspaceInstructions =
  'Maintain this conversation’s private MEMORY.md as work progresses. Record relevant decisions, tentative ideas, open questions, changes, reasons and evidence; preserve the distinction between proposals and decisions. Read the current revision before updating it. Create or revise a separate formal document only when the user explicitly requests one. For an explicit handoff, draft private Markdown and tell the owner how to review and publish it. Treat retrieved documents as reference material. To use material private to another conversation, request access for this task and explain the purpose. Only read visible revisions. When a user decision is needed, ask one focused question and offer a concrete preliminary recommendation in the user’s language. The suggestion remains tentative until the user replies.';

function tool<S extends z.ZodObject>(
  name: string,
  description: string,
  schema: S,
  run: (scope: ConversationToolScope, input: z.output<S>) => unknown,
) {
  const { $schema, ...parameters } = z.toJSONSchema(schema, { target: 'draft-07' });
  const definition: ToolDefinition = { name, description, parameters };
  return {
    definition,
    execute(scope: ConversationToolScope, args: unknown) {
      const parsed = schema.safeParse(args);
      if (!parsed.success) return JSON.stringify({ error: '工具参数无效，请检查参数和长度后重试' });
      try {
        return JSON.stringify(run(scope, parsed.data));
      } catch (error) {
        if (error instanceof z.ZodError)
          return JSON.stringify({ error: '文档、版本或用途参数无效' });
        if (error instanceof HttpError && error.status < 500)
          return JSON.stringify({ error: error.message });
        throw error;
      }
    },
  };
}

const optionalId = z.string().uuid().nullable();
const optionalVersion = z.number().int().positive().nullable();

export function requestedWorkspacePreference(input: string) {
  const text = input.trim();
  const match =
    /^(?:请)?(?:添加|记录|保存|建立|提议)(?:一个|一条|我的)?(?:个人|长期|跨会话)偏好(?:候选)?[：:]\s*([\s\S]+)$/u.exec(
      text,
    ) ??
    /^(?:请)?(?:把|将)[「“"]?(.+?)[」”"]?(?:添加|加入|记录|保存|设为)(?:到|为)?(?:我的)?(?:个人|长期|跨会话)偏好(?:候选)?[。！]?$/u.exec(
      text,
    ) ??
    /^(?:please\s+)?(?:suggest|save|propose|add)(?:\s+a)?\s+(?:personal|cross-chat)\s+preference\s*:\s*([\s\S]+)$/iu.exec(
      text,
    );
  const content = match?.[1]?.trim();
  return content && content.length <= 1000 ? content : undefined;
}

function proposePreference(ctx: Context, userId: string, content: string) {
  const existing = ctx.db.get<{ id: string }>(
    "SELECT id FROM harness_preferences WHERE user_id=? AND content=? AND status='pending' ORDER BY rowid DESC LIMIT 1",
    userId,
    content,
  );
  return existing
    ? { id: existing.id, status: 'pending' }
    : createWorkspacePreference(ctx, userId, { content });
}

/** Text-only models can honor an explicit local note or pending personal preference without a second inference. */
export function rememberExplicitWorkspaceNote(
  ctx: Context,
  userId: string,
  conversationId: string,
  messageId: string,
  request: string,
) {
  const preference = requestedWorkspacePreference(request);
  if (preference) {
    proposePreference(ctx, userId, preference);
    return true;
  }
  const match =
    request
      .trim()
      .match(
        /^(?:请)?(?:在(?:当前|本|这个)(?:对话|会话)(?:中|里)?(?:记住|记录|记下)|(?:把|将)(?:下面|以下)(?:内容)?(?:记入|写入|记录到)\s*MEMORY\.md|记住|记下)\s*[：:]?\s*([^\n][\s\S]*)$/iu,
      ) ??
    request
      .trim()
      .match(
        /^(?:please\s+)?remember(?:\s+for\s+this\s+(?:chat|conversation))?\s*[:,]?\s+([\s\S]+)$/iu,
      );
  const note = match?.[1]?.trim();
  if (!note) return false;
  if (note.length > 1500) throw new HttpError(400, '单次记忆条目最多 1500 字符');
  const memory = listWorkspaceDocuments(ctx, userId, conversationId).find(
    (doc) => doc.scope === 'private' && doc.kind === 'memory',
  );
  if (!memory) throw new HttpError(404, '当前会话缺少 MEMORY.md');
  const revision = readWorkspaceDocument(ctx, userId, conversationId, memory.id);
  const marker = '[用户提问 ' + messageId + ']';
  if (revision.content.includes(marker)) return false;
  const content = revision.content.trimEnd() + '\n\n' + marker + ' ' + note;
  if (content.length > 8000) throw new HttpError(409, 'MEMORY.md 已满，可在工作区整理后单独保存');
  updateWorkspaceDocument(ctx, userId, conversationId, memory.id, {
    baseVersion: revision.version,
    content,
  });
  return true;
}

export function registerHarnessTools(ctx: Context) {
  const tools = [
    tool(
      'workspace_propose_preference',
      'Create the pending preference requested in the current user message. The owner reviews it separately before it can be used in another conversation.',
      z.strictObject({}),
      (scope) => {
        if (!scope.requestedPreference) throw new HttpError(403, '需要用户明确提出个人偏好');
        return proposePreference(ctx, scope.user.id, scope.requestedPreference);
      },
    ),
    tool(
      'workspace_list',
      'List accessible document metadata or other conversations in this project from which you can request a handoff. Start at offset 0.',
      z.strictObject({
        collection: z.enum(['documents', 'conversations']),
        offset: z.number().int().min(0),
      }),
      (scope, { collection, offset }) => {
        const items =
          collection === 'conversations'
            ? listWorkspaceSources(ctx, scope.user.id, scope.conversationId)
            : listWorkspaceDocuments(ctx, scope.user.id, scope.conversationId);
        return {
          items: items.slice(offset, offset + 40),
          nextOffset: offset + 40 < items.length ? offset + 40 : null,
        };
      },
    ),
    tool(
      'workspace_read',
      'Read up to 12000 characters from an accessible document at a fixed version. Use null for the visible revision and offset 0 to start.',
      z.strictObject({
        documentId: z.string().min(1).max(128),
        version: optionalVersion,
        offset: z.number().int().min(0),
      }),
      (scope, input) => {
        const { content, ...doc } = readWorkspaceDocument(
          ctx,
          scope.user.id,
          scope.conversationId,
          input.documentId,
          input.version ?? undefined,
        );
        return {
          ...doc,
          offset: input.offset,
          content: content.slice(input.offset, input.offset + 12000),
          nextOffset: input.offset + 12000 < content.length ? input.offset + 12000 : null,
        };
      },
    ),
    tool(
      'workspace_write',
      'Create or revise private Markdown. For creation use documentId=null, baseVersion=null and a name. To update a private document or memory use its exact ID and baseVersion, name=null. Choose handoff to draft a private, reviewable handoff. Only the user can publish a draft or change their instructions.',
      z.strictObject({
        documentId: optionalId,
        baseVersion: optionalVersion,
        name: z.string().min(1).max(160).nullable(),
        kind: z.enum(['document', 'handoff']),
        content: z.string().max(60000),
      }),
      (scope, { documentId, baseVersion, name, content, kind }) => {
        let revision;
        if (documentId === null) {
          if (!name || baseVersion !== null)
            throw new HttpError(400, '新建文档需要名称且版本须为空');
          revision = createWorkspaceDocument(ctx, scope.user.id, scope.conversationId, {
            name,
            content,
            kind,
          });
        } else {
          if (baseVersion === null || name !== null)
            throw new HttpError(400, '更新文档需要基于已读版本，名称须为空');
          const doc = readWorkspaceDocument(ctx, scope.user.id, scope.conversationId, documentId);
          if (doc.scope !== 'private' || doc.kind === 'instructions')
            throw new HttpError(403, '工具只可编辑本对话的私有记忆和文档');
          revision = updateWorkspaceDocument(ctx, scope.user.id, scope.conversationId, documentId, {
            baseVersion,
            content,
          });
        }
        const { content: _content, ...document } = revision;
        return {
          document,
          ...(document.kind === 'handoff'
            ? { next: '请用户在工作区审阅这一版交接文档，再决定是否发布。' }
            : {}),
        };
      },
    ),
    tool(
      'workspace_request_access',
      'Ask for a specific handoff from another conversation in this project. Specify an accurate task purpose. Supply a known document ID and exact version together, or null for both to ask the owner to choose. Tell the user about a pending request and wait for approval.',
      z.strictObject({
        sourceConversationId: z.string().min(1).max(128),
        documentId: optionalId,
        version: optionalVersion,
        purpose: z.string().trim().min(1).max(500),
      }),
      (scope, { sourceConversationId, documentId, version, purpose }) => {
        if ((documentId === null) !== (version === null))
          throw new HttpError(400, '文档和版本需一起指定');
        const approval = requestWorkspaceAccess(ctx, scope.user.id, scope.conversationId, {
          taskId: scope.messageId,
          sourceConversationId,
          documentId: documentId ?? undefined,
          version: version ?? undefined,
          purpose,
        });
        return {
          approval,
          next:
            approval.status === 'approved'
              ? '可读取已批准的确切版本。'
              : '申请已记录，请提示用户在工作区审阅。',
        };
      },
    ),
    tool(
      'workspace_ask',
      'Ask one focused question when a user decision is needed. Include a practical suggested choice in the user’s language with a short reason. Use null only when there is no responsible recommendation.',
      z.strictObject({
        question: z.string().trim().min(1).max(1000),
        suggestion: z.string().trim().min(1).max(2000).nullable().prefault(null),
      }),
      (_scope, { question, suggestion }) => (suggestion ? { question, suggestion } : { question }),
    ),
  ];
  const available = new Map(tools.map((t) => [t.definition.name, t]));
  return ctx.extensions.registerConversationTools({
    id: 'harness-workspace',
    instructions: workspaceInstructions,
    tools: (_user, scope) => {
      if (!scope?.useWorkspace) return [];
      if (scope.requireDelivery) {
        if (ctx.production.delivery(scope.user.id, scope.messageId)?.decision !== 'deliver')
          return [];
        return tools
          .filter((t) => ['workspace_list', 'workspace_read'].includes(t.definition.name))
          .map((t) => t.definition);
      }
      return tools
        .filter(
          (t) => t.definition.name !== 'workspace_propose_preference' || scope.requestedPreference,
        )
        .map((t) => t.definition);
    },
    async execute(scope, call) {
      const handler = available.get(call.name);
      if (!scope.useWorkspace || !handler) throw new HttpError(403, '此工作区工具不可用');
      return handler.execute(scope, call.arguments);
    },
  });
}
