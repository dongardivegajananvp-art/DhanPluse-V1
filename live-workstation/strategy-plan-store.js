import { Pool } from 'pg';

const ACTIVE_LIMIT = 2;
const FRESH_MS = 10_000;
const MAX_CANDLE_AGE_SECONDS = 900;
const STRATEGIES = new Set([
  'EMA20_EMA50_TREND','TOP_GAINER_MOMENTUM_BREAKOUT','DAILY_TREND_5M_PULLBACK',
  'DAY_HIGH_LOW_BREAK_RETEST','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','BULLISH_CONTINUATION',
  'BEARISH_CONTINUATION','FLAG_BREAKOUT_VOLUME','OPENING_RANGE_BREAKOUT'
]);

function positive(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
}
function epochSeconds(value) {
  if (value === null || value === undefined || value === '') return 0;
  const raw = String(value).trim();
  const compact = /^(\\d{4})(\\d{2})(\\d{2})$/.exec(raw);
  const dateOnly = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(raw);
  const match = compact || dateOnly;
  if (match) {
    const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
    const date=new Date(Date.UTC(year,month-1,day));
    if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return 0;
    return Date.UTC(year,month-1,day,10,0,0)/1000;
  }
  const numeric=Number(value);
  if(Number.isFinite(numeric)&&numeric>0){
    const stamp=numeric>1e12?numeric/1000:numeric;
    const date=new Date(stamp*1000);
    if(date.getUTCHours()===0&&date.getUTCMinutes()===0&&date.getUTCSeconds()===0)
      return Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate(),10,0,0)/1000;
    return stamp;
  }
  const parsed=Date.parse(raw);
  return Number.isFinite(parsed)&&parsed>0?parsed/1000:0;
}
function tickAligned(value, tickSize) {
  const price=Number(value),step=Number(tickSize);
  if(!positive(price)||!positive(step))return false;
  return Math.abs(price/step-Math.round(price/step))<=1e-6;
}
function validatePlan(plan, now) {
  if (!plan || typeof plan !== 'object') return 'Confirmed strategy plan is required';
  for (const key of ['planId','strategy','underlying','contract','optionSide','expiry','underlyingCandleTime','optionCandleTime']) {
    if (typeof plan[key] !== 'string' || !plan[key].trim()) return key + ' is required';
  }
  if (!STRATEGIES.has(plan.strategy)) return 'Strategy identifier is not in the fixed nine-strategy allowlist';
  if (!['CE','PE'].includes(plan.optionSide)) return 'Option side must be CE or PE';
  for (const key of ['strike','premium','tickSize','entry','stopLoss','target','rr','underlyingExchangeTime','optionExchangeTime','underlyingReceivedAt','optionReceivedAt']) {
    if (!positive(plan[key])) return key + ' must be a positive verified value';
  }
  const expiry=epochSeconds(plan.expiry);
  if(!expiry||expiry*1000<=now)return 'Option contract expiry is missing, malformed or expired';
  const candleTimes=['underlyingCandleTime','optionCandleTime'].map(key=>epochSeconds(plan[key]));
  if(candleTimes.some(time=>!time||time*1000>now+3000||now/1000-time>MAX_CANDLE_AGE_SECONDS))
    return 'Underlying and option confirmation candles must be recent, completed timestamps';
  if(Number(plan.underlyingExchangeTime)<candleTimes[0]+300-3||Number(plan.optionExchangeTime)<candleTimes[1]+300-3)
    return 'Underlying and option exchange ticks must follow the completed confirmation candles';
  const entry=Number(plan.entry),stop=Number(plan.stopLoss),target=Number(plan.target);
  if (!(entry > stop && target > entry)) return 'Entry, stop loss and target are not a valid long-option risk plan';
  const risk=entry-stop,reward=target-entry,expectedTarget=entry+2*risk;
  const tolerance=Math.max(Number(plan.tickSize)*1e-6,1e-8);
  if(Math.abs(target-expectedTarget)>tolerance)return 'Target must remain exactly two times the fixed Entry-to-SL risk';
  const calculatedRr=reward/risk;
  if(Number(plan.rr)<2||Math.abs(Number(plan.rr)-calculatedRr)>1e-4)return 'Fixed reward/risk must match the persisted Entry, SL and Target at 1:2';
  if(Number(plan.premium)<entry-tolerance||Number(plan.premium)>entry+0.5*risk+tolerance)
    return 'Verified option premium must be at Entry or within the maximum 0.5R chase allowance';
  for(const key of ['premium','entry','stopLoss','target'])if(!tickAligned(plan[key],plan.tickSize))
    return key+' does not align with the official option tick size';
  for (const key of ['underlyingReceivedAt','optionReceivedAt']) {
    const age = now - Number(plan[key]);
    if (age < 0 || age > FRESH_MS) return 'Both underlying and option ticks must be fresh within 10 seconds';
  }
  for (const key of ['underlyingExchangeTime','optionExchangeTime']) {
    const age = now / 1000 - Number(plan[key]);
    if (age < -3 || age > 10) return 'Both exchange timestamps must be fresh and current';
  }
  return null;
}


export function evaluateActivePlanLifecycle(plan, tick, now = Date.now()) {
  if (!plan || typeof plan !== 'object') return { status: 'REVALIDATION_REQUIRED', reason: 'Persisted plan is unavailable' };
  const expiry = epochSeconds(plan.expiry);
  if (!expiry) return { status: 'REVALIDATION_REQUIRED', reason: 'Contract expiry cannot be verified' };
  if (expiry * 1000 <= now) return { status: 'EXPIRED', reason: 'Option contract expiry has passed' };

  const receivedAt = Number(tick?.receivedAt);
  const exchangeTime = Number(tick?.exchangeTime);
  const price = Number(tick?.price);
  const receivedAge = now - receivedAt;
  const exchangeAge = now / 1000 - exchangeTime;
  if (!tick || !Number.isFinite(price) || price <= 0 ||
      !Number.isFinite(receivedAge) || receivedAge < 0 || receivedAge > FRESH_MS ||
      !Number.isFinite(exchangeAge) || exchangeAge < -3 || exchangeAge > 10) {
    return { status: 'STALE_REVALIDATION_REQUIRED', reason: 'Fresh exchange tick for the exact option contract is required before lifecycle revalidation' };
  }

  const stopLoss = Number(plan.stop_loss ?? plan.stopLoss);
  const target = Number(plan.target);
  if (!positive(stopLoss) || !positive(target) || target <= stopLoss) {
    return { status: 'REVALIDATION_REQUIRED', reason: 'Persisted Entry/SL/Target values are invalid; plan remains active and blocked' };
  }
  if (price <= stopLoss) return { status: 'STOP_LOSS_HIT', reason: 'Fresh option premium is at or below the fixed stop loss', price };
  if (price >= target) return { status: 'TARGET_HIT', reason: 'Fresh option premium is at or above the fixed target', price };
  return { status: 'ACTIVE', reason: 'Fresh option premium remains between fixed stop loss and target', price };
}

export function createStrategyPlanStore({ databaseUrl, PoolClass = Pool } = {}) {
  const url = String(databaseUrl || '').trim();
  if (!/^postgres(?:ql)?:\/\//i.test(url)) return null;
  const pool = new PoolClass({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'gv2vpd-strategy-plan-ledger'
  });

  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS gv2vpd_strategy_plans (
      plan_id VARCHAR(96) PRIMARY KEY,
      strategy VARCHAR(64) NOT NULL,
      underlying VARCHAR(128) NOT NULL,
      contract VARCHAR(160) NOT NULL,
      option_side VARCHAR(2) NOT NULL CHECK (option_side IN ('CE','PE')),
      expiry VARCHAR(32) NOT NULL,
      strike NUMERIC(18,6) NOT NULL CHECK (strike > 0),
      premium NUMERIC(18,6),
      tick_size NUMERIC(18,6),
      entry NUMERIC(18,6) NOT NULL CHECK (entry > 0),
      stop_loss NUMERIC(18,6) NOT NULL CHECK (stop_loss > 0),
      target NUMERIC(18,6) NOT NULL CHECK (target > entry),
      rr NUMERIC(8,4) NOT NULL CHECK (rr >= 2),
      underlying_exchange_time DOUBLE PRECISION NOT NULL,
      option_exchange_time DOUBLE PRECISION NOT NULL,
      underlying_received_at TIMESTAMPTZ,
      option_received_at TIMESTAMPTZ,
      underlying_candle_time VARCHAR(40) NOT NULL,
      option_candle_time VARCHAR(40) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED','CANCELLED','STOP_LOSS_HIT','TARGET_HIT','EXPIRED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    );
    ALTER TABLE gv2vpd_strategy_plans DROP CONSTRAINT IF EXISTS gv2vpd_strategy_plans_status_check;
    ALTER TABLE gv2vpd_strategy_plans ADD CONSTRAINT gv2vpd_strategy_plans_status_check CHECK (status IN ('ACTIVE','CLOSED','CANCELLED','STOP_LOSS_HIT','TARGET_HIT','EXPIRED'));
    ALTER TABLE gv2vpd_strategy_plans ADD COLUMN IF NOT EXISTS premium NUMERIC(18,6);
    ALTER TABLE gv2vpd_strategy_plans ADD COLUMN IF NOT EXISTS tick_size NUMERIC(18,6);
    ALTER TABLE gv2vpd_strategy_plans ADD COLUMN IF NOT EXISTS underlying_received_at TIMESTAMPTZ;
    ALTER TABLE gv2vpd_strategy_plans ADD COLUMN IF NOT EXISTS option_received_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS gv2vpd_strategy_active_underlying
      ON gv2vpd_strategy_plans (underlying) WHERE status = 'ACTIVE';
    CREATE UNIQUE INDEX IF NOT EXISTS gv2vpd_strategy_active_contract
      ON gv2vpd_strategy_plans (contract) WHERE status = 'ACTIVE';
    CREATE INDEX IF NOT EXISTS gv2vpd_strategy_plan_status_created
      ON gv2vpd_strategy_plans (status, created_at DESC);
  `).then(() => true).catch(error => {
    console.error('Strategy plan ledger unavailable; strategy entries remain blocked.', String(error?.message || error).slice(0, 160));
    return false;
  });

  return {
    ready,
    async saveConfirmedPlan(plan, now = Date.now()) {
      const invalid = validatePlan(plan, now);
      if (invalid) return { ok: false, status: 'DATA_UNAVAILABLE_NO_TRADE', reason: invalid };
      if (!await ready) return { ok: false, status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Persistent strategy plan ledger is unavailable' };
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT pg_advisory_xact_lock(hashtext('gv2vpd_strategy_active_plans'))");
        const count = await client.query("SELECT COUNT(*)::int AS count FROM gv2vpd_strategy_plans WHERE status='ACTIVE'");
        if (Number(count.rows?.[0]?.count || 0) >= ACTIVE_LIMIT) {
          await client.query('ROLLBACK');
          return { ok: false, status: 'NO_TRADE', reason: 'Maximum of two simultaneous strategy plans reached' };
        }
        const duplicate = await client.query("SELECT plan_id FROM gv2vpd_strategy_plans WHERE status='ACTIVE' AND (underlying=$1 OR contract=$2) LIMIT 1", [plan.underlying, plan.contract]);
        if (duplicate.rows?.length) {
          await client.query('ROLLBACK');
          return { ok: false, status: 'NO_TRADE', reason: 'Duplicate underlying or option contract already has an active plan' };
        }
        await client.query(`
          INSERT INTO gv2vpd_strategy_plans (
            plan_id,strategy,underlying,contract,option_side,expiry,strike,premium,tick_size,entry,stop_loss,target,rr,
            underlying_exchange_time,option_exchange_time,underlying_received_at,option_received_at,underlying_candle_time,option_candle_time
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        `, [
          plan.planId,plan.strategy,plan.underlying,plan.contract,plan.optionSide,plan.expiry,
          Number(plan.strike),Number(plan.premium),Number(plan.tickSize),Number(plan.entry),Number(plan.stopLoss),Number(plan.target),Number(plan.rr),
          Number(plan.underlyingExchangeTime),Number(plan.optionExchangeTime),
          new Date(Number(plan.underlyingReceivedAt)).toISOString(),new Date(Number(plan.optionReceivedAt)).toISOString(),
          plan.underlyingCandleTime,plan.optionCandleTime
        ]);
        await client.query('COMMIT');
        return { ok: true, status: 'PLAN_PERSISTED', planId: plan.planId, entry: Number(plan.entry), stopLoss: Number(plan.stopLoss), target: Number(plan.target), rr: Number(plan.rr) };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error?.code === '23505') return { ok: false, status: 'NO_TRADE', reason: 'An active plan already exists for this underlying or option contract' };
        console.error('Strategy plan persistence failed; no entry accepted.', String(error?.message || error).slice(0, 160));
        return { ok: false, status: 'DATA_UNAVAILABLE_NO_TRADE', reason: 'Persistent strategy plan write failed' };
      } finally {
        client.release();
      }
    },
    async listActivePlans() {
      if (!await ready) return { ok: false, status: 'DATA_UNAVAILABLE_NO_TRADE', plans: [] };
      try {
        const result = await pool.query("SELECT plan_id,strategy,underlying,contract,option_side,expiry,strike,premium,tick_size,entry,stop_loss,target,rr,underlying_exchange_time,option_exchange_time,underlying_received_at,option_received_at,underlying_candle_time,option_candle_time,created_at FROM gv2vpd_strategy_plans WHERE status='ACTIVE' ORDER BY created_at ASC LIMIT 2");
        return { ok: true, plans: result.rows || [] };
      } catch (error) {
        console.error('Strategy plan read failed; new entries remain blocked.', String(error?.message || error).slice(0, 160));
        return { ok: false, status: 'DATA_UNAVAILABLE_NO_TRADE', plans: [] };
      }
    },
    async listRecentTerminalPlans(limit = 20) {
      if (!await ready) return { ok: false, plans: [] };
      try {
        const safeLimit=Math.max(1,Math.min(50,Math.trunc(Number(limit)||20)));
        const result=await pool.query("SELECT plan_id,strategy,underlying,contract,option_side,expiry,strike,premium,tick_size,entry,stop_loss,target,rr,underlying_exchange_time,option_exchange_time,underlying_received_at,option_received_at,underlying_candle_time,option_candle_time,status,created_at,closed_at FROM gv2vpd_strategy_plans WHERE status IN ('STOP_LOSS_HIT','TARGET_HIT','EXPIRED','CLOSED','CANCELLED') ORDER BY closed_at DESC NULLS LAST,created_at DESC LIMIT $1",[safeLimit]);
        return { ok:true, plans:result.rows||[] };
      } catch(error) {
        console.error('Terminal strategy plan history read failed.',String(error?.message||error).slice(0,160));
        return { ok:false, plans:[] };
      }
    },
    async closePlan(planId, status = 'CLOSED') {
      if (!['CLOSED','CANCELLED','STOP_LOSS_HIT','TARGET_HIT','EXPIRED'].includes(status)) return { ok: false, reason: 'Unsupported terminal plan status' };
      if (!await ready) return { ok: false, reason: 'Persistent strategy plan ledger is unavailable' };
      try {
        const result = await pool.query("UPDATE gv2vpd_strategy_plans SET status=$2,closed_at=NOW() WHERE plan_id=$1 AND status='ACTIVE' RETURNING plan_id,status", [planId,status]);
        return { ok: Boolean(result.rows?.length), plan: result.rows?.[0] || null };
      } catch (error) {
        console.error('Strategy plan close failed.', String(error?.message || error).slice(0, 160));
        return { ok: false, reason: 'Persistent strategy plan update failed' };
      }
    },
    async close() { await pool.end(); }
  };
}
