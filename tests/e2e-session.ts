import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';

// Only the temporary server on port 3210 writes this fixture; never a real user session.
export const fixtureSessionPath = join(tmpdir(), 'drift-space-e2e-3210-session.json');
export async function useFixtureSession(page: Page) {
  await page.context().addCookies(JSON.parse(await readFile(fixtureSessionPath, 'utf8')));
}
