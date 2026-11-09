import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;
const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS gv2vpd_paper_positions (
  id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trade_date DATE NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('CE','PE')),
  expiry TEXT NOT NULL,
  strike NUMERIC NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  entry_price NUMERIC NOT NULL CHECK (entry_price > 0),
  stop_loss NUMERIC NOT NULL CHECK (stop_loss > 0),
  target1 NUMERIC NOT NULL CHECK (target1 > 0),
  target2 NUMERIC NOT NULL CHECK (target2 > 0),
  last_price NUMERIC,
  state TEXT NOT NULL CHECK (state IN ('OPEN','CLOSED')),
  target1_touched_at TIMESTAMPTZ,
  exit_price NUMERIC,
  exit_reason TEXT,
  realized_pnl NUMERIC,
  source_timestamp TIMESTAMPTZ NOT NULL,
  last_quote_timestamp TIMESTAMPTZ,
  source TEXT NOT NULL CHECK (source = 'FYERS_VERIFIED'),
  plan JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS gv2vpd_paper_positions_day_state
  ON gv2vpd_paper_positions (trade_date, state);
ALTER TABLE gv2vpd_paper_positions ADD COLUMN IF NOT EXISTS last_quote_timestamp TIMESTAMPTZ;
UPDATE gv2vpd_paper_positions SET last_quote_timestamp=source_timestamp WHERE last_quote_timestamp IS NULL;
`;

const asNumber = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};
const isoDate = value => new Date(value).toISOString().slice(0, 10);

export function validatePaperPlan(input, now = Date.now()) {
  const plan = input?.plan;
  const entry = asNumber(plan?.entryPrice);
  const sl = asNumber(plan?.stopLoss);
  const t1 = asNumber(plan?.target1 ?? plan?.target);
  const t2 = asNumber(plan?.target2);
  const quantity = asNumber(plan?.quantity ?? plan?.lotSize);
  const timestamp = Date.parse(input?.exchangeTimestamp || '');
  if (input?.source !== 'FYERS_VERIFIED') throw new Error('Paper BUY requires a verified FYERS setup.');
  if (!Number.isFinite(timestamp) || timestamp > now + 5000 || now - timestamp > 10_000) {
    throw new Error('FYERS exchange timestamp is missing, future-dated or older than 10 seconds.');
  }
  if (!plan || !Number.isFinite(entry) || !Number.isFinite(sl) || !Number.isFinite(t1) ||
      !Number.isFinite(t2) || !Number.isInteger(quantity) || quantity <= 0 ||
      !(sl < entry && entry < t1 && t1 < t2)) {
    throw new Error('Immutable entry, SL, T1, T2 and verified lot quantity are required.');
  }
  const rr = (t2 - entry) / (entry - sl);
  if (!Number.isFinite(rr) || rr < 2) throw new Error('Paper plan fails the minimum 1:2 T2 reward/risk gate.');
  const symbol = String(input.symbol || '').trim();
  const expiry = String(input.expiry || '').trim();
  const side = String(input.side || '').toUpperCase();
  const strike = asNumber(input.strike);
  if (!symbol || !expiry || !['CE','PE'].includes(side) || !Number.isFinite(strike) || strike <= 0) {
    throw new Error('Verified option contract identity is incomplete.');
  }
  return { plan, entry, sl, t1, t2, quantity, timestamp, symbol, expiry, side, strike };
}

export function createPaperTradingStore({ databaseUrl }) {
  const configured = /^postgres(?:ql)?:\/\//i.test(String(databaseUrl || '').trim());
  const pool = configured ? new Pool({
    connectionString: String(databaseUrl).trim(),
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    application_name: 'gv2vpd-paper-trading'
  }) : null;

  async function initialize() {
    if (!pool) throw new Error('PostgreSQL is required for durable Paper Mode.');
    await pool.query(TABLE_SQL);
  }

  async function createPaperBuy(input, now = Date.now()) {
    if (!pool) throw new Error('Durable Paper Mode is unavailable: DATABASE_URL is not configured.');
    const v = validatePaperPlan(input, now);
    const idempotencyKey = String(input.idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9:_-]{16,128}$/.test(idempotencyKey)) throw new Error('A valid idempotency key is required.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(716202611)');
      const existing = await client.query('SELECT * FROM gv2vpd_paper_positions WHERE idempotency_key=$1', [idempotencyKey]);
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return { created: false, position: existing.rows[0] };
      }
      const tradeDate = isoDate(now);
      const risk = (v.entry - v.sl) * v.quantity;
      const day = await client.query(
        `SELECT
          COALESCE(SUM(CASE WHEN state='CLOSED' THEN realized_pnl ELSE 0 END),0) AS realized,
          COALESCE(SUM(CASE WHEN state='OPEN' THEN (COALESCE(last_price,entry_price)-entry_price)*quantity ELSE 0 END),0) AS unrealized
         FROM gv2vpd_paper_positions WHERE trade_date=$1 OR state='OPEN'`, [tradeDate]
      );
      const dailyPnl = Number(day.rows[0].realized) + Number(day.rows[0].unrealized);
      if (dailyPnl <= -5000) throw new Error('Daily paper loss limit of ₹5,000 reached. BUY locked for today.');
      const open = await client.query(
        "SELECT COUNT(*)::int AS count FROM gv2vpd_paper_positions WHERE state='OPEN'"
      );
      if (open.rows[0].count >= 2) throw new Error('Maximum two open Paper positions allowed.');
      if (v.entry * v.quantity > 5000) throw new Error('Paper BUY blocked: premium outlay exceeds configured ₹5,000 test capital.');
      const id = crypto.randomUUID();
      const inserted = await client.query(
        `INSERT INTO gv2vpd_paper_positions
         (id,idempotency_key,trade_date,symbol,side,expiry,strike,quantity,entry_price,stop_loss,target1,target2,last_price,state,source_timestamp,last_quote_timestamp,source,plan)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9,'OPEN',$13,$13,'FYERS_VERIFIED',$14::jsonb)
         RETURNING *`,
        [id,idempotencyKey,tradeDate,v.symbol,v.side,v.expiry,v.strike,v.quantity,v.entry,v.sl,v.t1,v.t2,new Date(v.timestamp).toISOString(),JSON.stringify(v.plan)]
      );
      await client.query('COMMIT');
      return { created: true, position: inserted.rows[0], riskAmount: Number(risk.toFixed(2)), mode: 'PAPER_SIMULATION' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function listPositions({ date = isoDate(Date.now()) } = {}) {
    if (!pool) throw new Error('Durable Paper Mode is unavailable.');
    const result = await pool.query('SELECT * FROM gv2vpd_paper_positions WHERE trade_date=$1 ORDER BY created_at DESC', [date]);
    return result.rows;
  }

  async function listOpenPositions() {
    if (!pool) throw new Error('Durable Paper Mode is unavailable.');
    const result = await pool.query("SELECT * FROM gv2vpd_paper_positions WHERE state='OPEN' ORDER BY created_at ASC");
    return result.rows;
  }

  async function processVerifiedQuote({ symbol, price, exchangeTimestamp, source }, now = Date.now()) {
    if (!pool) throw new Error('Durable Paper Mode is unavailable.');
    const ltp = asNumber(price);
    const timestamp = Date.parse(exchangeTimestamp || '');
    if (source !== 'FYERS_VERIFIED' || !Number.isFinite(ltp) || ltp <= 0 ||
        !Number.isFinite(timestamp) || timestamp > now + 5000 || now - timestamp > 10_000) {
      return { processed: false, reason: 'Quote is not a fresh exchange-timestamped FYERS tick.' };
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(716202611)');
      const result = await client.query("SELECT * FROM gv2vpd_paper_positions WHERE state='OPEN' AND symbol=$1 FOR UPDATE", [symbol]);
      const updates = [];
      for (const row of result.rows) {
        const entry = Number(row.entry_price), sl = Number(row.stop_loss);
        const t1 = Number(row.target1), t2 = Number(row.target2), qty = Number(row.quantity);
        const lastQuoteAt = Date.parse(row.last_quote_timestamp || row.source_timestamp);
        if (Number.isFinite(lastQuoteAt) && timestamp * 1 > lastQuoteAt) {
          // Only strictly newer exchange ticks may advance a paper position.
        } else {
          continue;
        }
        let state = 'OPEN', exitReason = null, exitPrice = null, t1At = row.target1_touched_at;
        if (ltp <= sl) { state='CLOSED'; exitReason='STOP_LOSS'; exitPrice=sl; }
        else if (ltp >= t2) { state='CLOSED'; exitReason='TARGET_2'; exitPrice=t2; }
        else if (ltp >= t1 && !t1At) t1At = new Date(timestamp).toISOString();
        const pnl = state === 'CLOSED' ? (exitPrice - entry) * qty : null;
        const saved = await client.query(
          `UPDATE gv2vpd_paper_positions SET last_price=$2,state=$3,target1_touched_at=$4,
           exit_price=$5,exit_reason=$6,realized_pnl=$7,last_quote_timestamp=$8,updated_at=NOW()
           WHERE id=$1 RETURNING *`,
          [row.id,ltp,state,t1At,exitPrice,exitReason,pnl,new Date(timestamp).toISOString()]
        );
        updates.push(saved.rows[0]);
      }
      await client.query('COMMIT');
      return { processed: true, updates };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function manualExit({ id, confirmed, price, exchangeTimestamp, source }, now = Date.now()) {
    if (!pool) throw new Error('Durable Paper Mode is unavailable.');
    if (confirmed !== true) throw new Error('Manual exit requires explicit confirmation.');
    const ltp = asNumber(price), timestamp = Date.parse(exchangeTimestamp || '');
    if (source !== 'FYERS_VERIFIED' || !Number.isFinite(ltp) || ltp <= 0 ||
        !Number.isFinite(timestamp) || timestamp > now + 5000 || now - timestamp > 10_000) {
      throw new Error('Manual exit requires a fresh verified FYERS quote.');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(716202611)');
      const result = await client.query(
        `UPDATE gv2vpd_paper_positions SET state='CLOSED',last_price=$2,exit_price=$2,
         exit_reason='MANUAL_EXIT',realized_pnl=($2-entry_price)*quantity,last_quote_timestamp=$3,updated_at=NOW()
         WHERE id=$1 AND state='OPEN' AND (last_quote_timestamp IS NULL OR last_quote_timestamp < $3) RETURNING *`,
        [id,ltp,new Date(timestamp).toISOString()]
      );
      if (!result.rows[0]) throw new Error('Paper position is not open or was already exited.');
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function close() { if (pool) await pool.end(); }
  return { configured, initialize, createPaperBuy, listPositions, listOpenPositions, processVerifiedQuote, manualExit, close };
}
