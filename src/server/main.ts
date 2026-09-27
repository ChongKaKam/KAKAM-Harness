import { readConfig } from './config';
import { createApp } from './app';
const config = readConfig();
const { app, kernel } = await createApp(config);
const server = app.listen(config.port, config.host, () =>
  console.log(`Drift Space listening on http://${config.host}:${config.port}`),
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 15_000);
  timer.unref();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  await kernel.stop();
  await closed;
  clearTimeout(timer);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
