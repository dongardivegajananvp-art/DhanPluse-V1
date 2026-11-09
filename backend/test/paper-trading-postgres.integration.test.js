import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createPaperTradingStore } from '../src/paper-trading-store.js';

const databaseUrl = process.env.PAPER_TEST_DATABASE_URL;

test('PostgreSQL Paper Mode ledger survives restart and serializes BUY/exit races', {
  skip: !databaseUrl ? 'PAPER_TEST_DATABASE_URL is not configured' : false
}, async t => {
  const { Pool } = pg;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  let store = createPaperTradingStore({ databaseUrl });
  const table = 'gv2vpd_paper_positions';

  const reset = async () => {
    await admin.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    await store.initialize();
  };
  const makeInput = (key, symbol, now, overrides = {}) => ({
    idempotencyKey: `paper:test:${key}`,
    source: 'FYERS_VERIFIED',
    exchangeTimestamp: new Date(now - 1000).toISOString(),
    symbol,
    side: 'CE',
    expiry: '2026-11-26',
    strike: 3000,
    plan: { entryPrice: 100, stopLoss: 70, target1: 150, target2: 250, quantity: 50 },
    ...overrides
  });

  t.after(async () => {
    await store.close().catch(() => {});
    await admin.query(`DROP TABLE IF EXISTS ${table} CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  });

  await reset();
  const now = Date.now();

  await t.test('idempotency, stale tick rejection, target processing and durable restart', async () => {
    const input = makeInput('idempotent-001', 'NSE:RELIANCE26NOV3000CE', now);
    const first = await store.createPaperBuy(input, now);
    const duplicate = await store.createPaperBuy(input, now);
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(String(first.position.id), String(duplicate.position.id));

    const stale = await store.processVerifiedQuote({
      symbol: input.symbol, price: 160,
      exchangeTimestamp: new Date(now - 20_000).toISOString(), source: 'FYERS_VERIFIED'
    }, now);
    assert.equal(stale.processed, false);

    const target1 = await store.processVerifiedQuote({
      symbol: input.symbol, price: 150,
      exchangeTimestamp: new Date(now - 500).toISOString(), source: 'FYERS_VERIFIED'
    }, now);
    assert.equal(target1.updates.length, 1);
    assert.ok(target1.updates[0].target1_touched_at);
    assert.equal(target1.updates[0].state, 'OPEN');

    await store.close();
    store = createPaperTradingStore({ databaseUrl });
    await store.initialize();
    const restored = await store.listOpenPositions();
    assert.equal(restored.length, 1);
    assert.equal(String(restored[0].id), String(first.position.id));

    const autoExitAt = now + 1000;
    const manualExitAt = now + 1500;
    const outcomes = await Promise.allSettled([
      store.processVerifiedQuote({
        symbol: input.symbol, price: 250,
        exchangeTimestamp: new Date(autoExitAt - 100).toISOString(), source: 'FYERS_VERIFIED'
      }, autoExitAt),
      store.manualExit({
        id: first.position.id, confirmed: true, price: 120,
        exchangeTimestamp: new Date(manualExitAt - 100).toISOString(), source: 'FYERS_VERIFIED'
      }, manualExitAt)
    ]);
    assert.ok(outcomes.some(result => result.status === 'fulfilled'));
    const rows = await store.listPositions({ date: new Date(now).toISOString().slice(0, 10) });
    const closed = rows.find(row => String(row.id) === String(first.position.id));
    assert.equal(closed.state, 'CLOSED');
    assert.ok(['TARGET_2', 'MANUAL_EXIT'].includes(closed.exit_reason));

    const laterDay = now + 10 * 24 * 60 * 60 * 1000;
    const olderHistory = await store.createPaperBuy(
      makeInput('history-closed-0001', 'NSE:WIPRO26NOV500CE', laterDay), laterDay
    );
    await store.manualExit({
      id: olderHistory.position.id, confirmed: true, price: 110,
      exchangeTimestamp: new Date(laterDay + 500).toISOString(), source: 'FYERS_VERIFIED'
    }, laterDay + 1000);
    const completeHistory = await store.listPositions({ date: new Date(now).toISOString().slice(0, 10) });
    assert.ok(completeHistory.some(row => String(row.id) === String(olderHistory.position.id) && row.state === 'CLOSED'),
      'Position API must include closed history from prior trading dates');
  });

  await t.test('concurrent BUYs cannot create two open rows for the same contract', async () => {
    const day = now + 24 * 60 * 60 * 1000;
    const symbol = 'NSE:TCS26NOV3500CE';
    const results = await Promise.allSettled([
      store.createPaperBuy(makeInput('race-a-0001', symbol, day), day),
      store.createPaperBuy(makeInput('race-b-0002', symbol, day), day)
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.created).length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const open = await store.listOpenPositions();
    assert.equal(open.filter(row => row.symbol === symbol).length, 1);
    for (const row of open) {
      await store.manualExit({
        id: row.id, confirmed: true, price: 100,
        exchangeTimestamp: new Date(day + 500).toISOString(), source: 'FYERS_VERIFIED'
      }, day + 1000);
    }
  });

  await t.test('two-position cap and ₹5,000 daily loss lock are enforced in PostgreSQL', async () => {
    const day = now + 2 * 24 * 60 * 60 * 1000;
    const first = await store.createPaperBuy(makeInput('cap-a-000001', 'NSE:INFY26NOV1500CE', day), day);
    const second = await store.createPaperBuy(makeInput('cap-b-000002', 'NSE:SBIN26NOV900CE', day), day);
    await assert.rejects(
      store.createPaperBuy(makeInput('cap-c-000003', 'NSE:ICICI26NOV1400CE', day), day),
      /Maximum two open/
    );
    for (const position of [first.position, second.position]) {
      await store.manualExit({
        id: position.id, confirmed: true, price: 100,
        exchangeTimestamp: new Date(day + 500).toISOString(), source: 'FYERS_VERIFIED'
      }, day + 1000);
    }

    const lossDay = now + 3 * 24 * 60 * 60 * 1000;
    for (let index = 0; index < 4; index += 1) {
      const at = lossDay + index * 20_000;
      const symbol = `NSE:LOSS${index}26NOV100CE`;
      const position = await store.createPaperBuy(makeInput(`loss-${index}-00001`, symbol, at), at);
      const exit = await store.processVerifiedQuote({
        symbol, price: 70,
        exchangeTimestamp: new Date(at - 500).toISOString(), source: 'FYERS_VERIFIED'
      }, at);
      assert.equal(exit.updates[0].exit_reason, 'STOP_LOSS');
      assert.equal(Number(exit.updates[0].realized_pnl), -1500);
      assert.equal(position.created, true);
    }
    const blockedAt = lossDay + 4 * 20_000;
    await assert.rejects(
      store.createPaperBuy(makeInput('loss-lock-00001', 'NSE:LOCK26NOV100CE', blockedAt), blockedAt),
      /Daily paper loss limit/
    );
  });
});
