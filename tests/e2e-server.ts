import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app';
import { mockProvider } from './mock-provider';
import { hashPassword } from '../src/kernel/crypto';
import { randomUUID } from 'node:crypto';
import { layoutConversation, layoutReply } from './layout-fixture';
import { fixtureSessionPath } from './e2e-session';
import { syntaxConversation, syntaxReply } from './syntax-fixture';
const dir = await mkdtemp(join(tmpdir(), 'kh-e2e-'));
const mock = await mockProvider(3211);
const { app, kernel } = await createApp({
  dataDir: dir,
  secret: 'local-browser-test-secret-minimum-32-characters',
  port: 3210,
  host: '127.0.0.1',
  secureCookies: false,
  trustProxy: 0,
  clientDir: 'dist/client',
});
const server = app.listen(3210, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const registered = await fetch('http://127.0.0.1:3210/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'admin@example.test',
    displayName: '管理员',
    password: 'Browser-test-password-123',
  }),
});
if (!registered.ok) throw new Error('Unable to create E2E fixture administrator');
const cookie = registered.headers.get('set-cookie')!.split(';')[0];
await writeFile(
  fixtureSessionPath,
  JSON.stringify([
    {
      name: 'kh_session',
      value: cookie.slice(cookie.indexOf('=') + 1),
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    },
  ]),
  { mode: 0o600 },
);
console.log('E2E fixture: http://127.0.0.1:3210');
for (const device of ['desktop', 'mobile']) {
  kernel.ctx.db.run(
    'INSERT INTO users(id,username,display_name,password_hash,role) VALUES(?,?,?,?,?)',
    randomUUID(),
    `old-${device}`,
    `迁移测试 ${device}`,
    await hashPassword('Browser-test-password-123'),
    'user',
  );
}
const owner = kernel.ctx.db.get<{ id: string }>(
  'SELECT id FROM users WHERE email=?',
  'admin@example.test',
)!;
kernel.ctx.db.run(
  'INSERT INTO conversations(id,user_id,title,updated_at) VALUES(?,?,?,?)',
  syntaxConversation,
  owner.id,
  '代码主题检查',
  new Date().toISOString(),
);
for (const role of ['user', 'assistant'])
  kernel.ctx.db.run(
    'INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)',
    randomUUID(),
    syntaxConversation,
    role,
    role === 'user' ? '请解释网格 DFS。' : syntaxReply,
    new Date().toISOString(),
  );
for (const device of ['desktop', 'mobile']) {
  const id = layoutConversation(device);
  const now = new Date().toISOString();
  kernel.ctx.db.run(
    'INSERT INTO conversations(id,user_id,title,updated_at) VALUES(?,?,?,?)',
    id,
    owner.id,
    '长对话排版检查',
    now,
  );
  for (let question = 1; question <= 12; question++) {
    for (const role of ['user', 'assistant'])
      kernel.ctx.db.run(
        'INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)',
        randomUUID(),
        id,
        role,
        role === 'user' ? `第 ${question} 个问题：请说明字号和对话导航的使用方法。` : layoutReply,
        now,
      );
  }
}
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await kernel.stop();
    await mock.close();
    await rm(fixtureSessionPath, { force: true });
    await rm(dir, { recursive: true, force: true });
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
