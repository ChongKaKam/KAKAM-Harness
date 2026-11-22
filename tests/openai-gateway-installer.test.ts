import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createCodexInstaller } from '../src/features/openai-gateway/codex-installer';

const origin = 'https://drift.example.test:8443';
const key = 'dsk_' + 'a'.repeat(43);
const nextKey = 'dsk_' + 'b'.repeat(43);

function machine(t: TestContext) {
  const userDir = mkdtempSync(join(tmpdir(), 'drift codex setup-'));
  t.after(() => rmSync(userDir, { force: true, recursive: true }));
  const bin = join(userDir, '.local/bin');
  mkdirSync(bin, { recursive: true });
  const env = { HOME: userDir, PATH: bin + ':' + process.env.PATH };
  function install(script: string) {
    return spawnSync('bash', [], { input: script, env, encoding: 'utf8' });
  }
  return { userDir, bin, env, install };
}

test('download installs a private isolated connection and forwards CLI arguments after rotation', (t) => {
  const { userDir, bin, env, install } = machine(t);
  mkdirSync(join(userDir, '.codex'));
  const regularConfig = join(userDir, '.codex/config.toml');
  writeFileSync(regularConfig, 'model = "regular"\n');
  const connectionDir = join(userDir, '.codex-drift');
  const connection = join(connectionDir, 'connection');
  const entry = join(bin, 'codex-drift');
  const stub = `#!/usr/bin/env node
console.log(JSON.stringify({
  home: process.env.CODEX_HOME, expectedKey: process.env.DRIFT_CODEX_KEY === process.env.TEST_DEVICE_KEY,
  args: process.argv.slice(2)
}));`;
  writeFileSync(join(bin, 'codex'), stub, { mode: 0o700 });

  for (const [instance, deviceKey] of [
    [origin, key],
    ['https://drift2.example.test', nextKey],
  ]) {
    const installed = install(createCodexInstaller(instance, deviceKey));
    assert.equal(installed.status, 0, installed.stderr);
    assert.ok(!(installed.stdout + installed.stderr).includes(deviceKey));
    assert.equal(readFileSync(connection, 'utf8'), `${deviceKey}\n${instance}/api/openai/v1\n`);
    assert.equal(statSync(connectionDir).mode & 0o777, 0o700);
    assert.equal(statSync(connection).mode & 0o777, 0o600);
    assert.equal(statSync(entry).mode & 0o777, 0o700);
    assert.ok(!readFileSync(entry, 'utf8').includes(deviceKey));
    const userArgs = ['exec', '-m', 'chosen-model', '包含 空格 $HOME'];
    const result = spawnSync(entry, userArgs, {
      env: { ...env, TEST_DEVICE_KEY: deviceKey, CODEX_HOME: join(userDir, '.codex') },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const run = JSON.parse(result.stdout);
    assert.equal(run.home, connectionDir);
    assert.equal(run.expectedKey, true);
    assert.deepEqual(run.args.slice(-userArgs.length), userArgs);
    assert.ok(run.args.includes(`model_providers.drift.base_url="${instance}/api/openai/v1"`));
    assert.ok(run.args.includes('model_providers.drift.env_key="DRIFT_CODEX_KEY"'));
    assert.ok(!run.args.join(' ').includes(deviceKey));
  }
  assert.equal(readFileSync(regularConfig, 'utf8'), 'model = "regular"\n');
});

test('paste installer reads a hidden key from the terminal and rejects unsafe interpolation', () => {
  const pasted = createCodexInstaller('http://[::1]:3210');
  assert.ok(!pasted.includes(key));
  assert.ok(pasted.includes('read -r -s'));
  assert.ok(pasted.includes('</dev/tty'));
  const check = spawnSync('bash', ['-n'], { input: pasted, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  for (const unsafe of [
    'https://drift.example.test/a',
    "https://bad'host.test",
    'https://user:secret@example.test',
    'file:///example',
  ]) {
    assert.throws(() => createCodexInstaller(unsafe));
  }
  assert.throws(() => createCodexInstaller(origin, key + '\nexit 0'));
});

test('installer preserves an unrelated executable and refuses a linked private directory', (t) => {
  const { userDir, bin, install } = machine(t);
  const entry = join(bin, 'codex-drift');
  writeFileSync(entry, 'user-owned', { mode: 0o700 });
  const script = createCodexInstaller(origin, key);
  assert.notEqual(install(script).status, 0);
  assert.equal(readFileSync(entry, 'utf8'), 'user-owned');
  rmSync(entry);
  const other = join(userDir, '.codex');
  mkdirSync(other);
  writeFileSync(join(other, 'connection'), 'untouched');
  symlinkSync(other, join(userDir, '.codex-drift'));
  assert.notEqual(install(script).status, 0);
  assert.equal(readFileSync(join(other, 'connection'), 'utf8'), 'untouched');
});
