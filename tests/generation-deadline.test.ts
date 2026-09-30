import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { generationDeadline } from '../src/features/chat/generation-deadline';

test('ongoing output refreshes idle deadline, but a later stall records the actual reason', async () => {
  const deadline = generationDeadline(new AbortController().signal, undefined, 400, 2_000);
  try {
    await delay(80);
    deadline.touch();
    await delay(80);
    assert.equal(deadline.signal.aborted, false);
    await delay(450);
    assert.equal(deadline.signal.aborted, true);
    assert.match(deadline.signal.reason.message, /长时间没有新输出/);
  } finally {
    deadline.close();
  }
});

test('total deadline and explicit cancellation remain distinct', async () => {
  const deadline = generationDeadline(new AbortController().signal, undefined, 500, 50);
  try {
    await delay(90);
    assert.match(deadline.signal.reason.message, /最长生成时间/);
  } finally {
    deadline.close();
  }
  const cancel = new AbortController();
  const stopped = generationDeadline(cancel.signal, undefined, 500, 500);
  try {
    cancel.abort();
    assert.equal(stopped.signal.aborted, true);
    assert.equal(stopped.signal.reason.name, 'AbortError');
  } finally {
    stopped.close();
  }
});
