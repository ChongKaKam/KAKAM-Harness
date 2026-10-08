import type { ToolCall, ToolDefinition } from '../../adapters/registry';
import type { User } from '../../shared/types';
import { HttpError } from '../../kernel/http';

export interface ConversationToolScope {
  user: User;
  conversationId: string;
  messageId: string;
  requestId: string;
  signal: AbortSignal;
}

export interface ConversationToolProvider {
  id: string;
  instructions: string;
  tools(user: User): ToolDefinition[];
  execute(scope: ConversationToolScope, call: ToolCall): Promise<string>;
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

  select(user: User) {
    const selected = new Map<
      string,
      { provider: ConversationToolProvider; abort: AbortController }
    >();
    const tools: ToolDefinition[] = [];
    const instructions: string[] = [];
    for (const entry of this.providers.values()) {
      const definitions = entry.provider.tools(user);
      if (definitions.length) instructions.push(entry.provider.instructions);
      for (const definition of definitions) {
        if (selected.has(definition.name))
          throw new Error(`Duplicate conversation tool: ${definition.name}`);
        selected.set(definition.name, entry);
        tools.push(definition);
      }
    }
    return {
      tools,
      instructions: instructions.join('\n\n'),
      async execute(scope: ConversationToolScope, call: ToolCall) {
        const entry = selected.get(call.name);
        if (
          !entry ||
          entry.abort.signal.aborted ||
          !entry.provider.tools(scope.user).some((tool) => tool.name === call.name)
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
