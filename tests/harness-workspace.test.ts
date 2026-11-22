import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { KHKernel } from '../src/kernel';
import { HttpError } from '../src/kernel/http';
import * as ws from '../src/features/harness/workspace';

let dir: string,
  kernel: KHKernel,
  owner: string,
  other: string,
  group: string,
  a: string,
  b: string,
  c: string,
  task: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kh-harness-workspace-'));
  kernel = new KHKernel(dir);
  owner = addUser();
  other = addUser();
  group = randomUUID();
  kernel.ctx.db.run(
    "INSERT INTO conversation_groups(id,user_id,name,created_at) VALUES(?,?,'Project','now')",
    group,
    owner,
  );
  a = chat('A');
  b = chat('B');
  c = chat('C');
  task = run(b);
});
afterEach(async () => {
  await kernel.stop();
  await rm(dir, { recursive: true, force: true });
});
function addUser() {
  const id = randomUUID();
  kernel.ctx.db.run(
    "INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,'fixture','user')",
    id,
    id,
    id,
  );
  return id;
}
function chat(title: string, user = owner, groupId: string | null = group, fresh = true) {
  const id = randomUUID();
  kernel.ctx.db.transaction(() => {
    kernel.ctx.db.run(
      "INSERT INTO conversations(id,user_id,group_id,title,updated_at) VALUES(?,?,?,?,'now')",
      id,
      user,
      groupId,
      title,
    );
    if (fresh) ws.initializeWorkspace(kernel.ctx, user, id);
  });
  return id;
}
function run(cid: string) {
  const id = randomUUID();
  kernel.ctx.db.run(
    "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,'assistant','test','now')",
    id,
    cid,
  );
  return id;
}
function denied(action: () => unknown, status = 404) {
  assert.throws(action, (e) => e instanceof HttpError && e.status === status);
}
function draft(name = '方案.md', kind: 'document' | 'handoff' = 'document') {
  return ws.createWorkspaceDocument(kernel.ctx, owner, a, { name, content: 'private-v1', kind });
}
test('fresh workspaces ignore legacy chats and private documents; project rules follow current membership', () => {
  const ctx = kernel.ctx;
  const legacy = chat('old', owner, group, false);
  const foreign = chat('other', other, null);
  assert.equal(ws.isHarnessConversation(ctx, owner, legacy), false);
  denied(() => ws.workspaceView(ctx, owner, legacy));
  assert.deepEqual(
    ws
      .listWorkspaceSources(ctx, owner, b)
      .map((r) => r.title)
      .sort(),
    ['A', 'C'],
  );
  assert.equal(ws.listWorkspaceDocuments(ctx, owner, a).length, 3);
  const mem = ws.listWorkspaceDocuments(ctx, owner, a).find((d) => d.kind === 'memory')!;
  ws.updateWorkspaceDocument(ctx, owner, a, mem.id, {
    baseVersion: 1,
    content: 'private decision',
  });
  assert.match(ws.loadWorkspaceContext(ctx, owner, a), /private decision/);
  assert.doesNotMatch(ws.loadWorkspaceContext(ctx, owner, b), /private decision/);
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, mem.id));
  denied(() => ws.readWorkspaceDocument(ctx, other, a, mem.id));
  denied(() => ws.workspaceView(ctx, owner, foreign));
  const project = ws.listWorkspaceDocuments(ctx, owner, a).find((d) => d.scope === 'project')!;
  denied(() =>
    ws.updateWorkspaceDocument(ctx, owner, a, project.id, {
      baseVersion: 1,
      content: 'model write',
    }),
  );
  ws.updateWorkspaceDocument(
    ctx,
    owner,
    a,
    project.id,
    { baseVersion: 1, content: 'group rules' },
    true,
  );
  assert.match(ws.loadWorkspaceContext(ctx, owner, b), /group rules/);
  ctx.db.run('UPDATE conversations SET group_id=NULL WHERE id=?', b);
  assert.doesNotMatch(ws.loadWorkspaceContext(ctx, owner, b), /group rules/);
});
test('publication atomically saves edited handoff and selected references; project snapshot survives source moves/deletion', () => {
  const ctx = kernel.ctx,
    handoff = draft('交接.md', 'handoff'),
    source = draft(),
    secret = draft('私人想法.md');
  const next = ws.updateWorkspaceDocument(ctx, owner, a, source.id, {
    baseVersion: 1,
    content: 'v2',
  });
  denied(
    () =>
      ws.updateWorkspaceDocument(ctx, owner, a, source.id, { baseVersion: 1, content: 'stale' }),
    409,
  );
  const publication = {
    documentId: handoff.id,
    version: 1,
    content: 'approved text',
    references: [{ documentId: source.id, version: 2 }],
  };
  denied(() =>
    ws.publishWorkspaceDocument(ctx, owner, a, {
      ...publication,
      references: [...publication.references, { documentId: secret.id, version: 21 }],
    }),
  );
  assert.equal(ws.readWorkspaceDocument(ctx, owner, a, handoff.id).version, 1);
  const published = ws.publishWorkspaceDocument(ctx, owner, a, publication);
  assert.equal(published.version, 2);
  assert.equal(ws.publishWorkspaceDocument(ctx, owner, a, publication).version, 2);
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, handoff.id).content, 'approved text');
  assert.deepEqual(ws.workspaceVersions(ctx, owner, b, source.id), [2]);
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, source.id, 1));
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, secret.id));
  ws.updateWorkspaceDocument(ctx, owner, a, source.id, {
    baseVersion: next.version,
    content: 'private v3',
  });
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, source.id).content, 'v2');
  ctx.db.run('UPDATE conversations SET group_id=NULL WHERE id=?', a);
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, source.id).content, 'v2');
  ctx.db.run('DELETE FROM conversations WHERE id=?', a);
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, source.id).content, 'v2');
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, handoff.id).sourceConversationId, null);
  ctx.db.run('DELETE FROM conversation_groups WHERE id=?', group);
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, handoff.id));
});
test('approval binds source, target, purpose and immutable version; persisted rejection and grants survive restart', async () => {
  let ctx = kernel.ctx;
  const doc = draft();
  const input = { taskId: task, sourceConversationId: a, purpose: 'compare' };
  const request = ws.requestWorkspaceAccess(ctx, owner, b, input);
  assert.equal(request.status, 'pending');
  assert.equal(ws.requestWorkspaceAccess(ctx, owner, b, input).id, request.id);
  denied(() => ws.readWorkspaceApproval(ctx, owner, c, request.id));
  denied(
    () =>
      ws.decideWorkspaceAccess(ctx, owner, b, request.id, {
        decision: 'approve',
        documentId: doc.id,
        version: 1,
      }),
    409,
  );
  assert.equal(ws.applyWorkspaceCommand(ctx, owner, a, '继续'), undefined);
  assert.match(ws.applyWorkspaceCommand(ctx, owner, a, '同意')!, /选择/);
  let notifications = 0;
  assert.match(
    ws.applyWorkspaceCommand(
      ctx,
      owner,
      a,
      `批准申请 ${request.id}，读取「${doc.name}」v1`,
      () => notifications++,
    )!,
    /已批准/,
  );
  ws.applyWorkspaceCommand(ctx, owner, a, `批准申请 ${request.id}`, () => notifications++);
  assert.equal(notifications, 1);
  ws.updateWorkspaceDocument(ctx, owner, a, doc.id, { baseVersion: 1, content: 'private2' });
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, doc.id).version, 1);
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, doc.id, 2));
  denied(() => ws.readWorkspaceDocument(ctx, owner, c, doc.id));
  const req2 = ws.requestWorkspaceAccess(ctx, owner, b, { ...input, purpose: 'other purpose' });
  ws.decideWorkspaceAccess(ctx, owner, a, req2.id, { decision: 'reject' });
  await kernel.stop();
  kernel = new KHKernel(dir);
  ctx = kernel.ctx;
  assert.equal(
    ws.requestWorkspaceAccess(ctx, owner, b, { ...input, purpose: 'other purpose' }).status,
    'rejected',
  );
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, doc.id, 1).content, 'private-v1');
  ctx.db.run('UPDATE conversations SET group_id=NULL WHERE id=?', a);
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, doc.id));
  denied(() => ws.readWorkspaceApproval(ctx, owner, b, request.id));
});
test('specific advance consent is consumed by matching request, respects expiration, ambiguity and task owner', () => {
  const ctx = kernel.ctx,
    doc = draft();
  const input = { taskId: task, sourceConversationId: a, purpose: 'compare' };
  const command = `授权「B」的任务「下一次」读取「${doc.name}」v1，用途：compare`;
  assert.match(ws.applyWorkspaceCommand(ctx, owner, a, command)!, /已授权/);
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, doc.id));
  denied(() => ws.requestWorkspaceAccess(ctx, owner, c, input));
  const different = ws.requestWorkspaceAccess(ctx, owner, b, {
    ...input,
    purpose: 'wrong purpose',
  });
  assert.equal(different.status, 'pending');
  assert.equal(ws.requestWorkspaceAccess(ctx, owner, b, input).status, 'approved');
  assert.deepEqual(ws.workspaceVersions(ctx, owner, b, doc.id), [1]);
  const expired = draft('过期授权.md');
  const grant = ws.preauthorizeWorkspaceAccess(ctx, owner, a, {
    taskId: task,
    targetConversationId: b,
    documentId: expired.id,
    version: 1,
    purpose: 'expired',
  });
  ctx.db.run("UPDATE harness_access SET expires_at='2000-01-01' WHERE id=?", grant.id);
  assert.equal(
    ws.requestWorkspaceAccess(ctx, owner, b, {
      ...input,
      purpose: 'expired',
      documentId: expired.id,
      version: 1,
    }).status,
    'pending',
  );
  assert.match(ws.applyWorkspaceCommand(ctx, owner, b, '批准')!, /多项/);
});
test('only explicit admission injects a preference, and corrections or withdrawal take effect in every conversation', () => {
  const ctx = kernel.ctx;
  const row = ws.createWorkspacePreference(ctx, owner, { content: 'metric units' });
  assert.doesNotMatch(ws.loadWorkspaceContext(ctx, owner, b), /metric units/);
  const admitted = ws.decideWorkspacePreference(ctx, owner, row.id, {
    version: 1,
    decision: 'admit',
  });
  assert.ok(admitted.admittedAt);
  assert.match(ws.loadWorkspaceContext(ctx, owner, b), /metric units/);
  const corrected = ws.editWorkspacePreference(ctx, owner, row.id, {
    version: admitted.version,
    content: 'imperial units',
  });
  assert.equal(corrected.status, 'pending');
  assert.doesNotMatch(ws.loadWorkspaceContext(ctx, owner, a), /metric units|imperial units/);
  denied(() =>
    ws.decideWorkspacePreference(ctx, other, row.id, {
      version: corrected.version,
      decision: 'admit',
    }),
  );
  denied(
    () =>
      ws.decideWorkspacePreference(ctx, owner, row.id, {
        version: admitted.version,
        decision: 'admit',
      }),
    409,
  );
  const admittedAgain = ws.decideWorkspacePreference(ctx, owner, row.id, {
    version: corrected.version,
    decision: 'admit',
  });
  ws.decideWorkspacePreference(ctx, owner, row.id, {
    version: admittedAgain.version,
    decision: 'withdraw',
  });
  assert.doesNotMatch(ws.loadWorkspaceContext(ctx, owner, b), /imperial units/);
});

test('user can update the sole formal draft to the project; ambiguous drafts require selection and private notes stay private', () => {
  const ctx = kernel.ctx;
  assert.match(ws.applyWorkspaceCommand(ctx, owner, a, '更新到项目')!, /没有待发布/);
  const file = draft('选型.md'),
    note = draft('交接.md', 'handoff');
  const mem = ws.listWorkspaceDocuments(ctx, owner, a).find((d) => d.kind === 'memory')!;
  ws.updateWorkspaceDocument(ctx, owner, a, mem.id, {
    baseVersion: 1,
    content: 'keep this private',
  });
  ws.updateWorkspaceDocument(ctx, owner, a, file.id, { baseVersion: 1, content: 'revision two' });
  const ask = ws.applyWorkspaceCommand(ctx, owner, a, '更新到项目')!;
  assert.match(ask, /「选型.md」v2/);
  assert.match(ask, /「交接.md」v1/);
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, file.id));
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, note.id));
  assert.match(ws.applyWorkspaceCommand(ctx, owner, a, '更新『选型.md』v2到项目')!, /已将/);
  assert.match(ws.applyWorkspaceCommand(ctx, owner, a, '更新到项目')!, /「交接.md」v1/);
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, file.id).content, 'revision two');
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, note.id).version, 1);
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, mem.id));
  assert.match(ws.applyWorkspaceCommand(ctx, owner, a, '更新到项目')!, /没有待发布/);
  ws.updateWorkspaceDocument(ctx, owner, a, file.id, { baseVersion: 2, content: 'third draft' });
  ws.updateWorkspaceDocument(ctx, owner, a, file.id, { baseVersion: 3, content: 'fourth draft' });
  assert.match(
    ws.applyWorkspaceCommand(ctx, owner, a, '更新『选型.md』v3到项目')!,
    /「选型.md」v3/,
  );
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, file.id).version, 3);
  denied(() => ws.readWorkspaceDocument(ctx, owner, b, file.id, 4));
  assert.match(ws.applyWorkspaceCommand(ctx, owner, a, '更新到项目')!, /「选型.md」v4/);
  assert.equal(ws.readWorkspaceDocument(ctx, owner, b, file.id).version, 4);
});
