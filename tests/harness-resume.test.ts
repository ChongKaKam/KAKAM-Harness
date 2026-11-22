import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { createApp } from '../src/server/app';
import type { WorkspaceApproval } from '../src/features/harness/types';
import type { Message } from '../src/shared/types';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + (server.address() as { port: number }).port;
}
async function close(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

for (const entry of ['chat', 'grants'] as const)
  test(`HTTP ${entry} approval continues only the requesting task with its fixed version; duplicate approval/continue spend nothing`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kh-harness-resume-'));
    const app = await createApp({
      dataDir: dir,
      secret: 'harness-http-integration-fixture-at-least-32-characters',
      port: 0,
      host: '127.0.0.1',
      trustProxy: 0,
      secureCookies: false,
    });
    const server = createServer(app.app);
    const mock = express().use(express.json());
    const provider = createServer(mock);
    const firstVersion = 'only-approved-revision',
      privateVersion = 'never-share-the-new-revision';
    const calls: string[] = [];
    const prompts: string[] = [];
    let source = '',
      documentId = '',
      cookie = '';
    mock.get('/models', (_req, res) => res.json({ data: [{ id: 'harness-model' }] }));
    mock.post('/responses', (req, res) => {
      const messages = req.body.input as {
        type?: string;
        output?: string;
        role?: string;
        content?: string;
      }[];
      const prompt = JSON.stringify(messages);
      prompts.push(prompt);
      const last = messages.at(-1)!;
      const result = last.type === 'function_call_output' ? JSON.parse(last.output!) : undefined;
      const resumed = messages.some(
        (m) =>
          m.role === 'user' &&
          typeof m.content === 'string' &&
          m.content.includes('文件访问已获批准'),
      );
      res.type('text/event-stream');
      const emit = (data: unknown) => res.write('data: ' + JSON.stringify(data) + '\n\n');
      let call: { name: string; arguments: unknown } | undefined;
      let text = '';
      if (result) {
        calls.push(result.approval ? 'waiting' : 'answer');
        text = result.approval
          ? '已完成独立核对，等待资料授权。'
          : '已核对授权材料：' + result.content;
        emit({ type: 'response.output_text.delta', delta: text });
      } else if (resumed) {
        calls.push('read');
        call = { name: 'workspace_read', arguments: { documentId, version: 1, offset: 0 } };
      } else {
        calls.push('request');
        call = {
          name: 'workspace_request_access',
          arguments: {
            sourceConversationId: source,
            documentId,
            version: 1,
            purpose: 'compare options',
          },
        };
      }
      const item = call
        ? {
            type: 'function_call',
            call_id: 'call-' + calls.length,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          }
        : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
      emit({
        type: 'response.completed',
        response: { output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } },
      });
      res.end();
    });
    try {
      const url = await listen(server),
        providerUrl = await listen(provider);
      async function request(path: string, method = 'GET', body?: unknown, actor = cookie) {
        return fetch(url + '/api' + path, {
          method,
          headers: { 'Content-Type': 'application/json', cookie: actor },
          body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        });
      }
      async function json(path: string, method = 'GET', body?: unknown) {
        const r = await request(path, method, body);
        const result = await r.json();
        assert.ok(r.ok, JSON.stringify({ path, status: r.status, result }));
        return result;
      }
      async function drained(cid: string): Promise<Message[]> {
        const stream = await request('/conversations/' + cid + '/events');
        assert.ok(stream.ok);
        await stream.text();
        return (await json('/conversations/' + cid)).messages;
      }
      const registration = await request('/auth/register', 'POST', {
        email: 'harness-admin@example.test',
        displayName: 'Harness',
        password: 'test',
      });
      assert.equal(registration.status, 201);
      cookie = registration.headers.get('set-cookie')!.split(';')[0];
      const user = (await registration.json()).user;
      await json('/features/memory', 'PATCH', { enabled: false });
      const legacyMemoryCalls: string[] = [];
      const legacyPrivateText = 'fixture-private-legacy-memory-for-another-conversation';
      const unregisterLegacyProvider = app.kernel.ctx.extensions.registerMemoryProvider({
        async prepare() {
          legacyMemoryCalls.push('prepare');
          return {
            operationId: null,
            strategyId: 'fixture',
            strategyVersion: '1',
            status: 'ready',
            blocks: [
              {
                memoryId: randomUUID(),
                scope: 'user',
                reason: 'legacy fixture',
                content: legacyPrivateText,
                version: 1,
              },
            ],
            durationMs: 0,
            error: null,
            omittedIds: [],
          };
        },
        async complete() {
          legacyMemoryCalls.push('complete');
        },
        async invalidate() {},
        async removeScope() {},
      });
      const p = await json('/admin/providers', 'POST', {
        name: 'Local test',
        apiMode: 'responses',
        baseUrl: providerUrl,
        apiKey: 'fixture',
      });
      const model = await json('/admin/models', 'POST', {
        providerId: p.id,
        name: 'harness-model',
        label: 'Harness',
        toolCalling: true,
      });
      await json('/admin/models/' + model.id, 'PATCH', {
        label: 'Harness',
        enabled: true,
        vision: false,
        userIds: [user.id],
      });
      const group = await json('/conversation-groups', 'POST', { name: 'Harness' });
      async function chat() {
        return (await json('/conversations', 'POST', { groupId: group.id })).id as string;
      }
      source = await chat();
      const b = await chat(),
        c = await chat();
      const sourcePath = '/conversations/' + source,
        target = '/conversations/' + b,
        third = '/conversations/' + c;
      const doc = await json(sourcePath + '/workspace/documents', 'POST', {
        name: '内部方案.md',
        content: firstVersion,
      });
      documentId = doc.id;
      const requestId = randomUUID();
      await json(target + '/messages', 'POST', {
        modelId: model.id,
        requestId,
        content: '请获取指定资料，比较两个方案。',
      });
      const initial = await drained(b);
      assert.equal(initial.find((m) => m.id === requestId)?.status, 'complete');
      const pending = (
        (await json(sourcePath + '/workspace/requests')) as WorkspaceApproval[]
      ).find((a) => a.taskId === requestId)!;
      assert.equal(pending.status, 'pending');
      assert.deepEqual(calls, ['request', 'waiting']);
      assert.equal(
        (await request(target + '/workspace/documents/' + doc.id + '?version=1')).status,
        404,
      );
      await json(sourcePath + '/workspace/documents/' + doc.id, 'PATCH', {
        baseVersion: 1,
        content: privateVersion,
      });
      const approval = {
        modelId: model.id,
        requestId: randomUUID(),
        content: '同意申请 ' + pending.id,
      };
      const approve = () =>
        entry === 'chat'
          ? json(sourcePath + '/messages', 'POST', approval)
          : json(sourcePath + '/workspace/grants', 'POST', {
              targetConversationId: b,
              taskId: requestId,
              documentId,
              version: 1,
              purpose: 'compare options',
            });
      await approve();
      const finished = await drained(b);
      const resumed = finished.find((m) => m.id === pending.id);
      assert.equal(resumed?.status, 'complete', resumed?.error ?? 'completion expected');
      assert.match(resumed!.content, /only-approved-revision/);
      assert.deepEqual(calls, ['request', 'waiting', 'read', 'answer']);
      assert.equal(finished.filter((m) => m.id === requestId && m.role === 'assistant').length, 1);
      const access = ((await json(target + '/workspace/requests')) as WorkspaceApproval[]).find(
        (a) => a.id === pending.id,
      )!;
      assert.equal(access.taskId, requestId);
      assert.equal(access.status, 'approved');
      assert.deepEqual(await json(target + '/workspace/documents/' + doc.id + '/versions'), [1]);
      assert.equal(
        (await request(third + '/workspace/documents/' + doc.id + '?version=1')).status,
        404,
      );
      assert.equal(
        (await request(target + '/workspace/documents/' + doc.id + '?version=2')).status,
        404,
      );
      assert.equal(
        prompts.some((p) => p.includes(privateVersion)),
        false,
      );
      assert.equal(
        prompts.slice(0, 2).some((p) => p.includes(firstVersion)),
        false,
      );
      await approve();
      await json(target + '/approvals/' + pending.id + '/continue', 'POST');
      await json(target + '/approvals/' + pending.id + '/continue', 'POST');
      assert.equal(
        (await request(third + '/approvals/' + pending.id + '/continue', 'POST')).status,
        404,
      );
      assert.equal((await drained(b)).length, finished.length);
      assert.equal(calls.length, 4);
      // A direct share has no task or approval to resume, even when the target has active grants.
      const directDoc = await json(sourcePath + '/workspace/documents', 'POST', {
        name: '直接分享.md',
        content: 'shared version one',
      });
      await json(sourcePath + '/workspace/documents/' + directDoc.id, 'PATCH', {
        baseVersion: 1,
        content: 'project version two',
      });
      const priorRequests = (await json(target + '/workspace/requests')).length;
      const directShare = { targetConversationId: b, documentId: directDoc.id, version: 1 };
      await json(sourcePath + '/workspace/shares', 'POST', directShare);
      await json(sourcePath + '/workspace/shares', 'POST', directShare);
      assert.equal(
        (await json(target + '/workspace/documents/' + directDoc.id)).content,
        'shared version one',
      );
      assert.equal((await request(third + '/workspace/documents/' + directDoc.id)).status, 404);
      assert.equal(
        (await request(target + '/workspace/documents/' + directDoc.id + '?version=2')).status,
        404,
      );
      assert.equal((await json(target + '/workspace/requests')).length, priorRequests);
      assert.equal((await drained(b)).length, finished.length);
      await json(sourcePath + '/workspace/publish', 'POST', {
        documentId: directDoc.id,
        version: 2,
      });
      assert.equal((await json(target + '/workspace/documents/' + directDoc.id)).version, 2);
      const directory = await json(target + '/workspace');
      assert.equal(
        directory.documents.find((d: { id: string }) => d.id === directDoc.id).version,
        2,
      );
      assert.deepEqual(
        await json(target + '/workspace/documents/' + directDoc.id + '/versions'),
        [2, 1],
      );
      assert.deepEqual(
        await json(third + '/workspace/documents/' + directDoc.id + '/versions'),
        [2],
      );
      await json(sourcePath + '/messages', 'POST', {
        modelId: model.id,
        requestId: randomUUID(),
        content: `分享「直接分享.md」v1给「${b}」`,
      });
      assert.equal(calls.length, 4);
      const legacy = randomUUID();
      app.kernel.ctx.db.run(
        "INSERT INTO conversations(id,user_id,title,updated_at) VALUES(?,?,'legacy','now')",
        legacy,
        user.id,
      );
      assert.equal((await json('/conversations/' + legacy)).harness, false);
      assert.equal((await request('/conversations/' + legacy + '/workspace')).status, 404);
      assert.equal(
        (
          await request('/conversations/' + legacy + '/messages', 'POST', {
            content: 'another question',
            modelId: model.id,
            requestId: randomUUID(),
          })
        ).status,
        409,
      );
      assert.equal(calls.length, 4);
      assert.deepEqual(legacyMemoryCalls, []);
      assert.ok(prompts.every((prompt) => !prompt.includes(legacyPrivateText)));
      unregisterLegacyProvider();
    } finally {
      await app.kernel.stop();
      await close(server);
      await close(provider);
      await rm(dir, { recursive: true, force: true });
    }
  });
