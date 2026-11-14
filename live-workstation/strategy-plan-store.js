import { Pool } from 'pg';

const ACTIVE_LIMIT = 2;
const FRESH_MS = 10_000;

function positive(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
}

function validatePlan(plan, now) {
  if (!plan || typeof plan !== 'object') return 'Confirmed strategy plan is required';
  for (const key of ['planId','strategy','underlying','contract','optionSide','expiry','underlyingCandleTime','optionCandleTime']) {
    if (typeof plan[key] !== 'string' || !plan[key].trim()) return key + ' is required';
  }
  if (!['CE','PE'].includes(plan.optionSide)) return 'Option side must be CE or PE';
  for (const key of ['strike','entry','stopLoss','target','rr','underlyingExchangeTime','optionExchangeTime','underlyingReceivedAt','optionReceivedAt']) {
    if (!positive(plan[key])) return key + ' must be a positive verified value';
  }
  if (!(Number(plan.entry) > Number(plan.stopLoss) && Number(plan.target) > Number(plan.entry))) return 'Entry, stop loss and target are not a valid long-option risk plan';
  if (Number(plan.rr) < 2) return 'Fixed reward/risk must be at least 1:2';
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
      entry NUMERIC(18,6) NOT NULL CHECK (entry > 0),
      stop_loss NUMERIC(18,6) NOT NULL CHECK (stop_loss > 0),
      target NUMERIC(18,6) NOT NULL CHECK (target > entry),
      rr NUMERIC(8,4) NOT NULL CHECK (rr >= 2),
      underlying_exchange_time DOUBLE PRECISION NOT NULL,
      option_exchange_time DOUBLE PRECISION NOT NULL,
      underlying_candle_time VARCHAR(40) NOT NULL,
      option_candle_time VARCHAR(40) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED','CANCELLED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    );
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
            plan_id,strategy,underlying,contract,option_side,expiry,strike,entry,stop_loss,target,rr,
            underlying_exchange_time,option_exchange_time,underlying_candle_time,option_candle_time
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `, [
          plan.planId,plan.strategy,plan.underlying,plan.contract,plan.optionSide,plan.expiry,
          Number(plan.strike),Number(plan.entry),Number(plan.stopLoss),Number(plan.target),Number(plan.rr),
          Number(plan.underlyingExchangeTime),Number(plan.optionExchangeTime),
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
        const result = await pool.query("SELECT plan_id,strategy,underlying,contract,option_side,expiry,strike,entry,stop_loss,target,rr,underlying_exchange_time,option_exchange_time,underlying_candle_time,option_candle_time,created_at FROM gv2vpd_strategy_plans WHERE status='ACTIVE' ORDER BY created_at ASC LIMIT 2");
        return { ok: true, plans: result.rows || [] };
      } catch (error) {
        console.error('Strategy plan read failed; new entries remain blocked.', String(error?.message || error).slice(0, 160));
        return { ok: false, status: 'DATA_UNAVAILABLE_NO_TRADE', plans: [] };
      }
    },
    async closePlan(planId, status = 'CLOSED') {
      if (!['CLOSED','CANCELLED'].includes(status)) return { ok: false, reason: 'Only CLOSED or CANCELLED transitions are allowed' };
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
