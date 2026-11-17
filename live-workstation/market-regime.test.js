import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIndexMarketRegime } from './market-regime.js';

const symbols=['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'];
function fixture(now,directions=['BULLISH','BULLISH','NEUTRAL']){
 const start=Date.parse('2026-11-17T03:45:00Z')/1000;
 const candles={},ticks={};
 symbols.forEach((symbol,index)=>{
  const side=directions[index];
  candles[symbol]=Array.from({length:50},(_,i)=>{
   const close=side==='BULLISH'?100+i:side==='BEARISH'?200-i:150;
   return {time:start+i*300,open:close-0.2,high:close+0.4,low:close-0.4,close,volume:100};
  });
  ticks[symbol]={price:candles[symbol].at(-1).close,exchangeTime:now/1000,receivedAt:now};
 });
 return {candles,ticks};
}
test('index market regime confirms bullish when at least two of three fresh indexes align',()=>{
 const now=Date.parse('2026-11-17T07:55:30Z');
 const result=evaluateIndexMarketRegime({...fixture(now),now});
 assert.equal(result.state,'BULLISH');
 assert.equal(result.confirmedIndexes.length,3);
});
test('index market regime confirms bearish when at least two of three fresh indexes align',()=>{
 const now=Date.parse('2026-11-17T07:55:30Z');
 const result=evaluateIndexMarketRegime({...fixture(now,['BEARISH','BEARISH','NEUTRAL']),now});
 assert.equal(result.state,'BEARISH');
});
test('index market regime stays unavailable when any index tick is stale',()=>{
 const now=Date.parse('2026-11-17T07:55:30Z');
 const data=fixture(now);data.ticks[symbols[2]].receivedAt=now-11000;
 const result=evaluateIndexMarketRegime({...data,now});
 assert.equal(result.state,'UNAVAILABLE');
});
test('index market regime stays unavailable when latest completed candle window has a gap',()=>{
 const now=Date.parse('2026-11-17T07:55:30Z');
 const data=fixture(now);data.candles[symbols[0]][20].time+=300;
 const result=evaluateIndexMarketRegime({...data,now});
 assert.equal(result.state,'UNAVAILABLE');
});
test('index market regime does not classify an unaligned three-index tape as bullish or bearish',()=>{
 const now=Date.parse('2026-11-17T07:55:30Z');
 const result=evaluateIndexMarketRegime({...fixture(now,['BULLISH','BEARISH','NEUTRAL']),now});
 assert.equal(result.state,'NEUTRAL');
});
