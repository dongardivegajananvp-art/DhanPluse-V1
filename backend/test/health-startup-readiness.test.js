import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('health endpoint responds while FYERS PostgreSQL token restore is pending', { timeout: 8000 }, async t => {
  const port = await reservePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: 'postgresql://unavailable:unavailable@127.0.0.1:1/dhanpulse_startup_test',
      FYERS_TOKEN_ENCRYPTION_KEY: 'a'.repeat(64),
      FYERS_APP_ID: 'startup-test-app',
      FYERS_APP_SECRET: 'startup-test-secret',
      FYERS_REDIRECT_URI: 'https://example.invalid/site/'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });

  let childStderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { childStderr += chunk; });

  t.after(() => {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  });

  let response = null;
  let lastError = null;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Backend exited before health response (code ${child.exitCode}). ${childStderr.slice(-4000)}`);
    }
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500)
      });
      break;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  assert.ok(response, `Health endpoint did not respond before token-store connection timeout: ${lastError?.message || 'unknown error'}`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.fyersConfigured, true);
  assert.equal(health.orderPlacementEnabled, false);
});
