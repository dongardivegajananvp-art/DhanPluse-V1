import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('FYERS REST recovery probe runs independently of NSE regular-session watchdog', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('const socketFeedWatchdog=setInterval(()=>{');
  const end = source.indexOf('socketFeedWatchdog.unref?.();', start);
  assert.notEqual(start, -1, 'socket watchdog exists');
  assert.notEqual(end, -1, 'socket watchdog is closed');
  const watchdog = source.slice(start, end);
  const recovery = watchdog.indexOf('if(restStatus.recoveryProbeRequired)');
  const nseSessionGate = watchdog.indexOf('if(!isNseRegularSession())return;');
  assert.notEqual(recovery, -1, 'REST recovery probe is scheduled');
  assert.notEqual(nseSessionGate, -1, 'NSE-only watchdog gate exists');
  assert.ok(recovery < nseSessionGate, 'MCX REST recovery must not be blocked by the NSE-closed early return');
});
