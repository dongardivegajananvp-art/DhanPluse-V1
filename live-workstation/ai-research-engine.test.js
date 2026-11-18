import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSetupResearch } from './ai-research-engine.js';

function candles(count,{start=Date.UTC(2026,10,16,3,45)/1000,step=300,trend=1,volume=100}={}) {
  return Array.from({length:count},(_,i)=>{
    const close=100+i*trend*0.2;
    const time=step===300?start+Math.floor(i/75)*86400+(i%75)*300:start+i*step;
    return {time,open:close-0.05,high:close+0.2,low:close-0.2,close,volume:volume*(i===count-1?2:1)};
  });
}
function tick(now,price=112) { return {price,receivedAt:now,exchangeTime:now/1000}; }

test('scores a multi-timeframe aligned long setup with transparent evidence',()=>{
  const now=Date.UTC(2026,10,18,10,0),intraday=candles(180),daily=candles(60,{step:86400,trend:1});
  const result=analyzeSetupResearch({candles:intraday,dailyCandles:daily,tick:tick(now),setup:{side:'LONG',strategy:'TOP_GAINER_MOMENTUM_BREAKOUT',breakoutLevel:111.7},marketRegime:{state:'BULLISH',direction:'BULLISH',evaluatedAt:new Date(now).toISOString()},now});
  assert.equal(result.status,'COMPLETE');
  assert.ok(result.qualityScore>=85);
  assert.equal(result.grade,'A+');
  assert.ok(result.evidence.includes('Daily trend alignment'));
  assert.equal(result.scoreMeaning,'Research quality score out of 100; not a win probability');
});

test('penalizes opposing daily and index regime context',()=>{
  const now=Date.UTC(2026,10,18,10,0),intraday=candles(180),daily=candles(60,{step:86400,trend:-1});
  const aligned=analyzeSetupResearch({candles:intraday,dailyCandles:candles(60,{step:86400}),tick:tick(now),setup:{side:'LONG',breakoutLevel:111.7},marketRegime:{direction:'BULLISH',evaluatedAt:new Date(now).toISOString()},now});
  const opposed=analyzeSetupResearch({candles:intraday,dailyCandles:daily,tick:tick(now),setup:{side:'LONG',breakoutLevel:111.7},marketRegime:{direction:'BEARISH',evaluatedAt:new Date(now).toISOString()},now});
  assert.ok(opposed.qualityScore<aligned.qualityScore);
  assert.ok(opposed.riskFlags.length>=2);
});

test('fails research closed when contiguous candle or daily history is insufficient',()=>{
  const now=Date.UTC(2026,10,18,10,0);
  const short=candles(30),daily=candles(60,{step:86400});
  const result=analyzeSetupResearch({candles:short,dailyCandles:daily,tick:tick(now),setup:{side:'LONG',breakoutLevel:100},now});
  assert.equal(result.status,'INCOMPLETE');
  assert.equal(result.qualityScore,null);
});

test('treats a neutral index regime as neutral evidence, not a conflict',()=>{
  const now=Date.UTC(2026,10,18,10,0);
  const result=analyzeSetupResearch({candles:candles(180),dailyCandles:candles(60,{step:86400}),tick:tick(now),setup:{side:'LONG',breakoutLevel:111.7},marketRegime:{direction:'NEUTRAL',evaluatedAt:new Date(now).toISOString()},now});
  const regime=result.components.find(item=>item.key==='marketRegime');
  assert.equal(regime.points,5);
  assert.ok(!result.riskFlags.some(flag=>flag.includes('conflicts with the index regime')));
});

test('does not score stale index regime as current confluence',()=>{
  const now=Date.UTC(2026,10,18,10,0);
  const result=analyzeSetupResearch({candles:candles(180),dailyCandles:candles(60,{step:86400}),tick:tick(now),setup:{side:'LONG',breakoutLevel:111.7},marketRegime:{direction:'BULLISH',evaluatedAt:new Date(now-30000).toISOString()},now});
  const regime=result.components.find(item=>item.key==='marketRegime');
  assert.equal(regime.points,5);
  assert.ok(result.missingEvidence.some(reason=>reason.includes('stale')));
});
