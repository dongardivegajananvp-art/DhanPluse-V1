import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrategyPlanStore, evaluateActivePlanLifecycle } from './strategy-plan-store.js';

class FakePool {
  constructor() { this.plans = []; this.closed = false; }
  async query(sql, values = []) {
    if (sql.includes('CREATE TABLE') || sql.includes('CREATE UNIQUE INDEX') || sql.includes('CREATE INDEX') || sql.includes('ALTER TABLE')) return { rows: [] };
    if (sql.includes('SELECT COUNT(*)')) return { rows: [{ count: this.plans.filter(p => p.status === 'ACTIVE').length }] };
    if (sql.includes('SELECT plan_id FROM')) {
      const found = this.plans.filter(p => p.status === 'ACTIVE' && (p.underlying === values[0] || p.contract === values[1]));
      return { rows: found.map(p => ({ plan_id: p.planId })) };
    }
    if (sql.includes('INSERT INTO gv2vpd_strategy_plans')) {
      const [planId,strategy,underlying,contract,optionSide,expiry,strike,premium,tickSize,entry,stopLoss,target,rr,underlyingExchangeTime,optionExchangeTime,underlyingReceivedAt,optionReceivedAt,entryHitAt,entryHitPrice,underlyingCandleTime,optionCandleTime] = values;
      if (this.plans.some(p => p.status === 'ACTIVE' && (p.underlying === underlying || p.contract === contract))) {
        const error = new Error('duplicate active plan'); error.code = '23505'; throw error;
      }
      this.plans.push({ planId,strategy,underlying,contract,optionSide,expiry,strike,premium,tickSize,entry,stopLoss,target,rr,underlyingExchangeTime,optionExchangeTime,underlyingReceivedAt,optionReceivedAt,entryHitAt,entryHitPrice,underlyingCandleTime,optionCandleTime,status:'ACTIVE' });
      return { rows: [] };
    }
    if (sql.includes('SELECT plan_id,strategy') && sql.includes('status IN')) return { rows: this.plans.filter(p => ['STOP_LOSS_HIT','TARGET_HIT','EXPIRED','CLOSED','CANCELLED'].includes(p.status)).slice(0,20).map(p => ({ ...p, stop_loss:p.stopLoss, option_side:p.optionSide, tick_size:p.tickSize, underlying_exchange_time:p.underlyingExchangeTime, option_exchange_time:p.optionExchangeTime, underlying_received_at:p.underlyingReceivedAt, option_received_at:p.optionReceivedAt, entry_hit_at:p.entryHitAt, entry_hit_price:p.entryHitPrice, underlying_candle_time:p.underlyingCandleTime, option_candle_time:p.optionCandleTime })) };
    if (sql.includes('SELECT plan_id,strategy')) return { rows: this.plans.filter(p => p.status === 'ACTIVE').slice(0,2).map(p => ({ ...p, stop_loss:p.stopLoss, option_side:p.optionSide, tick_size:p.tickSize, underlying_exchange_time:p.underlyingExchangeTime, option_exchange_time:p.optionExchangeTime, underlying_received_at:p.underlyingReceivedAt, option_received_at:p.optionReceivedAt, underlying_candle_time:p.underlyingCandleTime, option_candle_time:p.optionCandleTime })) };
    if (sql.includes('UPDATE gv2vpd_strategy_plans') && sql.includes('entry_hit_at')) { const p=this.plans.find(x=>x.planId===values[0]&&x.status==='ACTIVE'&&!x.entryHitAt); if(!p)return{rows:[]}; p.entryHitAt=values[1];p.entryHitPrice=values[2];return{rows:[{plan_id:p.planId,entry_hit_at:p.entryHitAt,entry_hit_price:p.entryHitPrice}]}; }
    if (sql.includes('SELECT plan_id,entry_hit_at')) { const p=this.plans.find(x=>x.planId===values[0]&&x.status==='ACTIVE'&&x.entryHitAt);return{rows:p?[{plan_id:p.planId,entry_hit_at:p.entryHitAt,entry_hit_price:p.entryHitPrice}]:[]}; }
    if (sql.includes('UPDATE gv2vpd_strategy_plans')) {
      const p = this.plans.find(x => x.planId === values[0] && x.status === 'ACTIVE');
      if (!p) return { rows: [] };
      p.status = values[1]; return { rows: [{ plan_id:p.planId,status:p.status }] };
    }
    return { rows: [] };
  }
  async connect() {
    return { query: (sql,values) => this.query(sql,values), release() {} };
  }
  async end() { this.closed = true; }
}

function fixture(now, overrides = {}) {
  return {
    planId: 'plan-' + (overrides.planId || 'one'),
    strategy: 'EMA20_EMA50_TREND',
    underlying: 'NSE:RELIANCE26NOVFUT',
    contract: 'NSE:RELIANCE26NOV1500CE',
    optionSide: 'CE',
    expiry: '2026-11-26',
    strike: 1500,
    tickSize: 0.05,
    entry: 100.05,
    stopLoss: 98.5,
    target: 103.15,
    rr: 2,
    underlyingExchangeTime: now / 1000,
    optionExchangeTime: now / 1000,
    underlyingReceivedAt: now,
    optionReceivedAt: now,
    underlyingCandleTime: String(now / 1000 - 300),
    optionCandleTime: String(now / 1000 - 300),
    premium:100.05,
    ...overrides
  };
}

test('strategy plan store is unavailable without a PostgreSQL URL', () => {
  assert.equal(createStrategyPlanStore({ databaseUrl: '' }), null);
});

test('ledger refuses stale underlying or option ticks', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  assert.equal((await store.saveConfirmedPlan(fixture(now, { optionReceivedAt: now - 11_000 }), now)).status, 'DATA_UNAVAILABLE_NO_TRADE');
  assert.equal((await store.saveConfirmedPlan(fixture(now, { underlyingExchangeTime: now / 1000 - 11 }), now)).status, 'DATA_UNAVAILABLE_NO_TRADE');
  await store.close();
});

test('ledger persists fixed Entry/SL/Target once and lists the same immutable plan', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  const plan = fixture(now);
  const saved = await store.saveConfirmedPlan(plan, now);
  assert.equal(saved.status, 'PLAN_PERSISTED');
  assert.deepEqual([saved.entry,saved.stopLoss,saved.target,saved.rr],[100.05,98.5,103.15,2]);
  const listed = await store.listActivePlans();
  assert.equal(listed.plans.length,1);
  assert.deepEqual([Number(listed.plans[0].premium),Number(listed.plans[0].entry),Number(listed.plans[0].stop_loss),Number(listed.plans[0].target)],[100.05,100.05,98.5,103.15]);
  assert.equal(Number(listed.plans[0].tickSize),0.05);
  assert.ok(listed.plans[0].underlying_received_at);
  assert.ok(listed.plans[0].option_received_at);
  assert.equal(typeof store.updatePlan, 'undefined');
  await store.close();
});

test('ledger allows at most two active plans and rejects duplicate underlying or contract', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  assert.equal((await store.saveConfirmedPlan(fixture(now),now)).ok,true);
  assert.match((await store.saveConfirmedPlan(fixture(now,{planId:'duplicate',contract:'NSE:RELIANCE26NOV1550CE'}),now)).reason,/Duplicate underlying/);
  assert.equal((await store.saveConfirmedPlan(fixture(now,{planId:'two',underlying:'NSE:TCS26NOVFUT',contract:'NSE:TCS26NOV3500PE',optionSide:'PE'}),now)).ok,true);
  assert.match((await store.saveConfirmedPlan(fixture(now,{planId:'three',underlying:'NSE:INFY26NOVFUT',contract:'NSE:INFY26NOV1600CE'}),now)).reason,/Maximum of two/);
  await store.close();
});

test('SL/Target hit terminal status releases active slot but permanently retains fixed Entry/SL/Target/RR', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  const plan=fixture(now);
  await store.saveConfirmedPlan(plan,now);
  const closed = await store.closePlan('plan-one','STOP_LOSS_HIT');
  assert.equal(closed.ok,true);
  const active = await store.listActivePlans();
  assert.equal(active.plans.length,0);
  const history=await store.listRecentTerminalPlans();
  assert.equal(history.plans.length,1);
  assert.equal(history.plans[0].status,'STOP_LOSS_HIT');
  assert.deepEqual([history.plans[0].entry,history.plans[0].stopLoss,history.plans[0].target,history.plans[0].rr],[100.05,98.5,103.15,2]);
  assert.equal((await store.closePlan('plan-one','ACTIVE')).ok,false);
  await store.close();
});

test('ledger rejects plans below fixed 1:2 or with inverted Entry/SL/Target', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  assert.match((await store.saveConfirmedPlan(fixture(now,{rr:1.99}),now)).reason,/reward\/risk.*1:2/i);
  assert.match((await store.saveConfirmedPlan(fixture(now,{entry:98,target:103}),now)).reason,/valid long-option risk plan/);
  await store.close();
});


test('ledger independently rejects chase beyond 0.5R, inconsistent 2R math and off-tick prices', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  assert.match((await store.saveConfirmedPlan(fixture(now,{premium:100.85}),now)).reason,/0.5R chase/i);
  assert.match((await store.saveConfirmedPlan(fixture(now,{target:103.20}),now)).reason,/exactly two times/i);
  assert.match((await store.saveConfirmedPlan(fixture(now,{rr:3}),now)).reason,/match the persisted/i);
  assert.match((await store.saveConfirmedPlan(fixture(now,{premium:100.06}),now)).reason,/tick size/i);
  await store.close();
});

test('ledger rejects expired contracts, unknown strategies and stale confirmation candles', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  assert.match((await store.saveConfirmedPlan(fixture(now,{expiry:'2026-11-13'}),now)).reason,/expired/i);
  assert.match((await store.saveConfirmedPlan(fixture(now,{strategy:'UNVERIFIED_STRATEGY'}),now)).reason,/allowlist/i);
  assert.match((await store.saveConfirmedPlan(fixture(now,{optionCandleTime:String(now/1000-1200)}),now)).reason,/recent, completed/i);
  await store.close();
});

test('active plan lifecycle remains pending on stale or missing option ticks', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const plan = { expiry: '2026-11-26', entry:100.05, stop_loss: 98.5, target: 103.15 };
  assert.equal(evaluateActivePlanLifecycle(plan, null, now).status, 'STALE_REVALIDATION_REQUIRED');
  assert.equal(evaluateActivePlanLifecycle(plan, { price: 97, receivedAt: now - 11_000, exchangeTime: now / 1000 }, now).status, 'STALE_REVALIDATION_REQUIRED');
});

test('active plan lifecycle closes only on a fresh exact-contract stop or target quote', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const plan = { expiry: '2026-11-26', entry:100.05, stop_loss: 98.5, target: 103.15, entry_hit_at: new Date(now).toISOString() };
  const tick = price => ({ price, receivedAt: now, exchangeTime: now / 1000 });
  assert.equal(evaluateActivePlanLifecycle(plan, tick(98.5), now).status, 'STOP_LOSS_HIT');
  assert.equal(evaluateActivePlanLifecycle(plan, tick(103.2), now).status, 'TARGET_HIT');
  assert.equal(evaluateActivePlanLifecycle(plan, tick(101), now).status, 'ENTRY_HIT');
  assert.equal(evaluateActivePlanLifecycle({...plan,entry_hit_at:null}, tick(100), now).status, 'WAITING_FOR_ENTRY');
  assert.equal(evaluateActivePlanLifecycle({...plan,entry_hit_at:null}, tick(100.05), now).status, 'ENTRY_HIT');
});

test('active plan lifecycle closes expired contracts even without a live quote', () => {
  const now = Date.parse('2026-11-27T04:00:00Z');
  const plan = { expiry: '2026-11-26', stop_loss: 98.5, target: 103.15 };
  assert.equal(evaluateActivePlanLifecycle(plan, null, now).status, 'EXPIRED');
});

test('active plan lifecycle fails closed when persisted risk values are malformed', () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const plan = { expiry: '2026-11-26', stop_loss: 0, target: 103.15 };
  assert.equal(evaluateActivePlanLifecycle(plan, { price: 100, receivedAt: now, exchangeTime: now / 1000 }, now).status, 'REVALIDATION_REQUIRED');
});

test('ledger persists a verified MCX option plan with fixed 1:2 risk values', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  const plan = fixture(now, {
    underlying:'MCX:CRUDEOIL26NOVFUT',
    contract:'MCX:CRUDEOIL26NOV7500CE',
    optionSide:'CE',
    expiry:'2026-11-26',
    strike:7500
  });
  const saved = await store.saveConfirmedPlan(plan, now);
  assert.equal(saved.status,'PLAN_PERSISTED');
  const listed = await store.listActivePlans();
  assert.equal(listed.plans[0].underlying,'MCX:CRUDEOIL26NOVFUT');
  assert.equal(listed.plans[0].contract,'MCX:CRUDEOIL26NOV7500CE');
  assert.deepEqual([saved.entry,saved.stopLoss,saved.target,saved.rr],[100.05,98.5,103.15,2]);
  await store.close();
});
