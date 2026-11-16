import test from 'node:test';
import assert from 'node:assert/strict';
import { getNseMarketSession } from './nse-market-session.js';

const ist = (hour, minute, day = '2026-11-16') =>
  new Date(`${day}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00+05:30`);

test('NSE pre-open order entry is shown from 09:00 through 09:07', () => {
  assert.equal(getNseMarketSession(ist(9,0)).phase, 'PRE_OPEN_ORDER_ENTRY');
  assert.equal(getNseMarketSession(ist(9,7)).phase, 'PRE_OPEN_ORDER_ENTRY');
});

test('NSE matching phase is shown from 09:08 through 09:11', () => {
  assert.equal(getNseMarketSession(ist(9,8)).phase, 'PRE_OPEN_MATCHING');
  assert.equal(getNseMarketSession(ist(9,11)).phase, 'PRE_OPEN_MATCHING');
});

test('NSE pre-open buffer is shown from 09:12 through 09:14', () => {
  assert.equal(getNseMarketSession(ist(9,12)).phase, 'PRE_OPEN_BUFFER');
  assert.equal(getNseMarketSession(ist(9,14)).phase, 'PRE_OPEN_BUFFER');
});

test('NSE regular session starts at 09:15 and ends at 15:30', () => {
  assert.equal(getNseMarketSession(ist(9,15)).phase, 'REGULAR');
  assert.equal(getNseMarketSession(ist(15,29)).phase, 'REGULAR');
  assert.equal(getNseMarketSession(ist(15,30)).phase, 'CLOSED');
});

test('NSE is closed before pre-open and on weekends', () => {
  assert.equal(getNseMarketSession(ist(8,59)).phase, 'CLOSED');
  assert.equal(getNseMarketSession(ist(9,0,'2026-11-15')).phase, 'CLOSED');
});
