import { spawn } from 'node:child_process';

const DEV_SERVER_URL = 'http://127.0.0.1:5173';

function run(command, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(command, args, {
    stdio: 'inherit',
    env
  });
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Vite dev server at ${url}`);
}

const tsc = run('bun', ['run', 'build:electron']);
const tscCode = await new Promise((resolve) => tsc.on('exit', resolve));
if (tscCode !== 0) {
  process.exit(tscCode ?? 1);
}

const vite = run('bunx', ['vite']);

let electron;
const shutdown = () => {
  if (electron && !electron.killed) electron.kill();
  if (!vite.killed) vite.kill();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await waitForServer(DEV_SERVER_URL);
  electron = run('bunx', ['electron', '.', ...process.argv.slice(2)], {
    VITE_DEV_SERVER_URL: DEV_SERVER_URL
  });
  electron.on('exit', (code) => {
    if (!vite.killed) vite.kill();
    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(error);
  shutdown();
  process.exit(1);
}
