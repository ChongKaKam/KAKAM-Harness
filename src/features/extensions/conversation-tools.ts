import type { ToolCall, ToolDefinition } from '../../adapters/registry';
import type { User } from '../../shared/types';
import { HttpError } from '../../kernel/http';

export interface ConversationToolScope {
  user: User;
  conversationId: string;
  messageId: string;
  requestId: string;
  signal: AbortSignal;
  /** Trusted delivery policy of the current submission. */
  requireDelivery?: boolean;
}

export interface ConversationToolProvider {
  id: string;
  instructions: string;
  tools(user: User, scope?: ConversationToolScope): ToolDefinition[];
  requirement?(
    user: User,
    request: string,
    requireDelivery?: boolean,
  ): ConversationToolRequirement | undefined;
  requirements?(scope: ConversationToolScope): ConversationToolRequirement[];
  execute(scope: ConversationToolScope, call: ToolCall): Promise<string>;
}

export interface ConversationToolRequirement {
  toolName: string;
  instructions: string;
  failureMessage: string;
  stopOnFailure?: boolean;
  /** Trusted allowance for sequential delivery, bounded by the shared tool-call budget. */
  maxRounds?: number;
  satisfied(scope: ConversationToolScope): boolean;
}

/** Trusted, lifecycle-bound tools. User identity and resource scope come from the server. */
export class ConversationToolRegistry {
  private providers = new Map<
    string,
    { provider: ConversationToolProvider; abort: AbortController }
  >();

  register(provider: ConversationToolProvider) {
    if (this.providers.has(provider.id)) throw new Error(`Duplicate tool provider: ${provider.id}`);
    const entry = { provider, abort: new AbortController() };
    this.providers.set(provider.id, entry);
    return () => {
      entry.abort.abort();
      this.providers.delete(provider.id);
    };
  }

  select(user: User, request = '', requireDelivery = false) {
    const selected = new Map<
      string,
      { provider: ConversationToolProvider; abort: AbortController }
    >();
    const tools: ToolDefinition[] = [];
    const instructions: string[] = [];
    const requirements: ConversationToolRequirement[] = [];
    const providers = [...this.providers.values()];
    const protect = (
      entry: (typeof providers)[number],
      requirement: ConversationToolRequirement,
    ) => ({
      ...requirement,
      satisfied(scope: ConversationToolScope) {
        if (entry.abort.signal.aborted) throw new HttpError(403, '生成工具已停用');
        return requirement.satisfied(scope);
      },
    });
    for (const entry of providers) {
      const requirement = entry.provider.requirement?.(user, request, requireDelivery);
      const definitions = entry.provider.tools(user);
      if (definitions.length) instructions.push(entry.provider.instructions);
      if (requirement) {
        if (!definitions.some((tool) => tool.name === requirement.toolName))
          throw new HttpError(400, '所需产物工具不可用，请检查产物设置');
        instructions.push(requirement.instructions);
        requirements.push(protect(entry, requirement));
      }
      for (const definition of definitions) {
        if (selected.has(definition.name))
          throw new Error(`Duplicate conversation tool: ${definition.name}`);
        selected.set(definition.name, entry);
        tools.push(definition);
      }
    }
    const available = (scope: ConversationToolScope) => {
      const current = new Map<
        string,
        { definition: ToolDefinition; entry: (typeof providers)[number] }
      >();
      for (const entry of providers) {
        if (entry.abort.signal.aborted) continue;
        for (const definition of entry.provider.tools(scope.user, scope)) {
          if (current.has(definition.name)) throw new HttpError(500, '工具名称冲突');
          current.set(definition.name, { definition, entry });
        }
      }
      return current;
    };
    return {
      tools,
      requirements,
      instructions: instructions.join('\n\n'),
      toolsFor(scope: ConversationToolScope) {
        return [...available(scope).values()].map(({ definition }) => definition);
      },
      pending(scope: ConversationToolScope) {
        scope.signal.throwIfAborted();
        const dynamic = providers.flatMap((entry) => {
          if (entry.abort.signal.aborted) throw new HttpError(403, '生成工具已停用');
          return (entry.provider.requirements?.(scope) ?? []).map((requirement) =>
            protect(entry, requirement),
          );
        });
        return [...requirements, ...dynamic].filter((requirement) => !requirement.satisfied(scope));
      },
      async execute(scope: ConversationToolScope, call: ToolCall) {
        const entry = available(scope).get(call.name)?.entry;
        if (
          !entry ||
          entry.abort.signal.aborted ||
          !entry.provider.tools(scope.user, scope).some((tool) => tool.name === call.name)
        )
          throw new HttpError(403, '生成工具已停用或未授权');
        const signal = AbortSignal.any([scope.signal, entry.abort.signal]);
        signal.throwIfAborted();
        const output = await entry.provider.execute({ ...scope, signal }, call);
        signal.throwIfAborted();
        return output;
      },
    };
  }
}
