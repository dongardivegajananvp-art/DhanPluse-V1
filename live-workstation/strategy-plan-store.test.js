import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrategyPlanStore, evaluateActivePlanLifecycle } from './strategy-plan-store.js';

class FakePool {
  constructor() { this.plans = []; this.closed = false; this.schemaSql = ''; }
  async query(sql, values = []) {
    if (sql.includes('CREATE TABLE') || sql.includes('CREATE UNIQUE INDEX') || sql.includes('CREATE INDEX') || sql.includes('ALTER TABLE')) { this.schemaSql = sql; return { rows: [] }; }
    if (sql.includes('SELECT COUNT(*)::int AS count')) return { rows: [{ count: this.plans.filter(p => p.status === 'ACTIVE').length }] };
    if (sql.includes('SELECT plan_id FROM')) {
      const found = this.plans.filter(p => p.status === 'ACTIVE' && (p.underlying === values[0] || p.contract === values[1]));
      return { rows: found.map(p => ({ plan_id: p.planId })) };
    }
    if (sql.includes('INSERT INTO gv2vpd_strategy_plans')) {
      const [planId,strategy,underlying,contract,optionSide,expiry,strike,premium,tickSize,entry,stopLoss,target,rr,underlyingExchangeTime,optionExchangeTime,underlyingReceivedAt,optionReceivedAt,underlyingCandleTime,optionCandleTime,maxFavorablePrice,maxAdversePrice,riskModelVersion,targetHitRate,targetConfidenceLower,targetSampleSize,marketRegime,riskResearch,entryHitAt,entryHitPrice] = values;
      if (this.plans.some(p => p.status === 'ACTIVE' && (p.underlying === underlying || p.contract === contract))) {
        const error = new Error('duplicate active plan'); error.code = '23505'; throw error;
      }
      this.plans.push({ planId,strategy,underlying,contract,optionSide,expiry,strike,premium,tickSize,entry,stopLoss,target,rr,underlyingExchangeTime,optionExchangeTime,underlyingReceivedAt,optionReceivedAt,underlyingCandleTime,optionCandleTime,maxFavorablePrice,maxAdversePrice,riskModelVersion,targetHitRate,targetConfidenceLower,targetSampleSize,marketRegime,riskResearch:JSON.parse(riskResearch),entryHitAt,entryHitPrice,observedTicks:1,status:'ACTIVE' });
      return { rows: [] };
    }
    if (sql.includes('COUNT(*) FILTER')) {
      const [strategy,side,targetRr]=values;
      const rows=this.plans.filter(p=>p.underlying?.startsWith('NSE:')&&p.strategy===strategy&&p.optionSide===side&&p.riskModelVersion==='GV2VPD_NSE_PRO_RISK_V1'&&Math.abs(Number(p.rr)-Number(targetRr))<=0.25);
      return {rows:[{wins:rows.filter(p=>p.status==='TARGET_HIT').length,losses:rows.filter(p=>p.status==='STOP_LOSS_HIT').length}]};
    }
    if (sql.includes('UPDATE gv2vpd_strategy_plans') && sql.includes('max_favorable_price')) {
      const [id,price]=values;const p=this.plans.find(x=>x.planId===id&&x.status==='ACTIVE');
      if(p){p.maxFavorablePrice=Math.max(Number(p.maxFavorablePrice??price),price);p.maxAdversePrice=Math.min(Number(p.maxAdversePrice??price),price);p.observedTicks=(p.observedTicks||0)+1;}
      return{rows:p?[{plan_id:id}]:[]};
    }
    if (sql.includes('SELECT plan_id,strategy') && sql.includes('status IN')) return { rows: this.plans.filter(p => ['STOP_LOSS_HIT','TARGET_HIT','EXPIRED','CLOSED','CANCELLED'].includes(p.status)).slice(0,20).map(p => ({ ...p, stop_loss:p.stopLoss, option_side:p.optionSide, tick_size:p.tickSize, underlying_exchange_time:p.underlyingExchangeTime, option_exchange_time:p.optionExchangeTime, underlying_received_at:p.underlyingReceivedAt, option_received_at:p.optionReceivedAt, entry_hit_at:p.entryHitAt, entry_hit_price:p.entryHitPrice, underlying_candle_time:p.underlyingCandleTime, option_candle_time:p.optionCandleTime })) };
    if (sql.includes('SELECT plan_id,strategy')) return { rows: this.plans.filter(p => p.status === 'ACTIVE').slice(0,2).map(p => ({ ...p, stop_loss:p.stopLoss, option_side:p.optionSide, tick_size:p.tickSize, underlying_exchange_time:p.underlyingExchangeTime, option_exchange_time:p.optionExchangeTime, underlying_received_at:p.underlyingReceivedAt, option_received_at:p.optionReceivedAt, entry_hit_at:p.entryHitAt, entry_hit_price:p.entryHitPrice, underlying_candle_time:p.underlyingCandleTime, option_candle_time:p.optionCandleTime })) };
    if (sql.includes('UPDATE gv2vpd_strategy_plans') && sql.includes('entry_hit_at')) {
      const [id,at,price]=values;const p=this.plans.find(x=>x.planId===id&&x.status==='ACTIVE'&&!x.entryHitAt);
      if(!p)return{rows:[]};p.entryHitAt=at;p.entryHitPrice=price;
      return{rows:[{plan_id:id,entry_hit_at:at,entry_hit_price:price}]};
    }
    if (sql.includes('SELECT plan_id,entry_hit_at')) {
      const p=this.plans.find(x=>x.planId===values[0]&&x.status==='ACTIVE'&&x.entryHitAt);
      return{rows:p?[{plan_id:p.planId,entry_hit_at:p.entryHitAt,entry_hit_price:p.entryHitPrice}]:[]};
    }
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
    riskResearch:{model:'GV2VPD_NSE_PRO_RISK_V1',probability:{}},
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
  assert.equal(listed.plans[0].entry_hit_at,null);
  assert.equal(listed.plans[0].entry_hit_price,null);
  assert.equal(evaluateActivePlanLifecycle({...listed.plans[0],entry_hit_at:null},{price:100,receivedAt:now,exchangeTime:now/1000},now).status,'WAITING_FOR_ENTRY');
  assert.ok(listed.plans[0].underlying_received_at);
  assert.ok(listed.plans[0].option_received_at);
  assert.equal(typeof store.updatePlan, 'undefined');
  await store.close();
});

test('ledger persists the first verified Entry-hit timestamp and price exactly once', async () => {
  const now=Date.parse('2026-11-16T04:00:00Z');
  const store=createStrategyPlanStore({databaseUrl:'postgres://test',PoolClass:FakePool});
  const saved=await store.saveConfirmedPlan(fixture(now),now);
  const first=await store.markEntryHit(saved.planId,100.10,now+1000);
  assert.equal(first.ok,true);
  assert.equal(first.entryHitPrice,100.10);
  const second=await store.markEntryHit(saved.planId,100.15,now+2000);
  assert.equal(second.ok,true);
  assert.equal(second.alreadyRecorded,true);
  assert.equal(second.entryHitPrice,100.10);
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
  assert.match((await store.saveConfirmedPlan(fixture(now,{rr:1.99}),now)).reason,/minimum 1:2 reward\/risk/i);
  assert.match((await store.saveConfirmedPlan(fixture(now,{entry:98,target:103}),now)).reason,/valid long-option risk plan/);
  await store.close();
});


test('ledger independently rejects chase beyond 0.5R, inconsistent adaptive RR math and off-tick prices', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  assert.match((await store.saveConfirmedPlan(fixture(now,{premium:100.85}),now)).reason,/0.5R chase/i);
  assert.equal((await store.saveConfirmedPlan(fixture(now,{planId:'adaptive-target',underlying:'NSE:SBIN26NOVFUT',contract:'NSE:SBIN26NOV1000CE',target:103.20,rr:Number(((103.20-100.05)/(100.05-98.5)).toFixed(2))}),now)).status,'PLAN_PERSISTED');
  assert.match((await store.saveConfirmedPlan(fixture(now,{target:104,rr:3}),now)).reason,/match persisted levels/i);
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

test('NSE outcome calibration excludes MCX and only counts comparable target/stop outcomes',async()=>{
 const now=Date.parse('2026-11-16T04:00:00Z');
 const store=createStrategyPlanStore({databaseUrl:'postgres://test',PoolClass:FakePool});
 const a=fixture(now,{planId:'nse-win',underlying:'NSE:INFY26NOVFUT',contract:'NSE:INFY26NOV1600CE'});
 const b=fixture(now,{planId:'mcx-win',underlying:'MCX:CRUDEOIL26NOVFUT',contract:'MCX:CRUDEOIL26NOV7500CE'});
 await store.saveConfirmedPlan(a,now);await store.saveConfirmedPlan(b,now);
 await store.closePlan('nse-win','TARGET_HIT');await store.closePlan('mcx-win','TARGET_HIT');
 const stats=await store.getNseOutcomeStats({strategy:a.strategy,optionSide:'CE',targetRr:2});
 assert.deepEqual([stats.wins,stats.losses,stats.samples],[1,0,1]);
 await store.close();
});

test('NSE plan observation records favourable/adverse option excursion without touching MCX plans',async()=>{
 const now=Date.parse('2026-11-16T04:00:00Z');
 const store=createStrategyPlanStore({databaseUrl:'postgres://test',PoolClass:FakePool});
 const plan=fixture(now);await store.saveConfirmedPlan(plan,now);
 const observed=await store.recordPlanObservation(plan.planId,101,now+1000);
 assert.equal(observed.ok,true);
 const [active]= (await store.listActivePlans()).plans;
 assert.equal(active.max_favorable_price,undefined);
 assert.equal(active.maxFavorablePrice,101);
 assert.equal(active.maxAdversePrice,100.05);
 assert.equal(active.observedTicks,2);
 await store.close();
});


test('ledger migration SQL separates ALTER statements with real newlines', async()=>{
  let captured;
  class CapturingPool extends FakePool { constructor(){ super(); captured=this; } }
  const store=createStrategyPlanStore({databaseUrl:'postgres://test',PoolClass:CapturingPool});
  await store.ready;
  assert.ok(captured.schemaSql);
  assert.doesNotMatch(captured.schemaSql,/\\n\s+ALTER TABLE/);
  assert.match(captured.schemaSql,/\n\s+ALTER TABLE/);
  await store.close();
});

test('ledger accepts valid compact YYYYMMDD option expiry from FYERS instruments', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  const saved = await store.saveConfirmedPlan(fixture(now, { expiry: '20261126' }), now);
  assert.equal(saved.status, 'PLAN_PERSISTED');
  await store.close();
});

test('ledger rejects invalid compact YYYYMMDD option expiry', async () => {
  const now = Date.parse('2026-11-16T04:00:00Z');
  const store = createStrategyPlanStore({ databaseUrl: 'postgres://test', PoolClass: FakePool });
  const saved = await store.saveConfirmedPlan(fixture(now, { expiry: '20261131' }), now);
  assert.equal(saved.status, 'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(saved.reason, /malformed or expired/i);
  await store.close();
});

test('outcome calibration is isolated for every one of the nine strategies',async()=>{
 const now=Date.parse('2026-11-16T04:00:00Z');
 const store=createStrategyPlanStore({databaseUrl:'postgres://test',PoolClass:FakePool});
 const strategies=[
  'EMA20_EMA50_TREND','TOP_GAINER_MOMENTUM_BREAKOUT','DAILY_TREND_5M_PULLBACK',
  'DAY_HIGH_LOW_BREAK_RETEST','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','BULLISH_CONTINUATION',
  'BEARISH_CONTINUATION','FLAG_BREAKOUT_VOLUME','OPENING_RANGE_BREAKOUT'
 ];
 for(let i=0;i<strategies.length;i++){
  const strategy=strategies[i],plan=fixture(now,{
   planId:'strategy-'+i,strategy,underlying:'NSE:TEST'+i+'26NOVFUT',
   contract:'NSE:TEST'+i+'26NOV100CE',optionSide:i%2?'PE':'CE'
  });
  assert.equal((await store.saveConfirmedPlan(plan,now)).ok,true,strategy);
  assert.equal((await store.closePlan(plan.planId,'TARGET_HIT')).ok,true,strategy);
 }
 for(let i=0;i<strategies.length;i++){
  const stats=await store.getNseOutcomeStats({strategy:strategies[i],optionSide:i%2?'PE':'CE',targetRr:2});
  assert.deepEqual([stats.wins,stats.losses,stats.samples],[1,0,1],strategies[i]);
 }
 const wrongSide=await store.getNseOutcomeStats({strategy:'EMA20_EMA50_TREND',optionSide:'PE',targetRr:2});
 assert.deepEqual([wrongSide.wins,wrongSide.losses,wrongSide.samples],[0,0,0]);
 await store.close();
});
