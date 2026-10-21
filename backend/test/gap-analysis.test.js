import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOpeningGap, summarizeHistoricalGaps } from '../src/gap-analysis.js';

test('opening gap direction and percent are calculated', () => { const x = analyzeOpeningGap({previousClose:100,todayOpen:102,relativeVolume:2}); assert.equal(x.direction,'gap-up'); assert.equal(x.gapPct,2); assert.equal(x.size,'large'); assert.equal(x.elevatedVolume,true); assert.equal(x.tradeSignal,null); });
test('event risk is a caution, not a trade signal', () => { const x=analyzeOpeningGap({previousClose:100,todayOpen:99,majorEvent:true}); assert.equal(x.context,'event-risk'); assert.equal(x.tradeSignal,null); });
test('invalid source prices are rejected', () => { assert.throws(()=>analyzeOpeningGap({previousClose:0,todayOpen:100})); });
test('historical gap fill rate uses verified daily bars', () => { const bars=[{timestamp:'2026-01-01T00:00:00Z',open:100,high:105,low:95,close:100,verified:true},{timestamp:'2026-01-02T00:00:00Z',open:102,high:104,low:99,close:101,verified:true},{timestamp:'2026-01-03T00:00:00Z',open:98,high:101,low:97,close:99,verified:true}]; const x=summarizeHistoricalGaps(bars); assert.equal(x.sampleSize,2); assert.equal(x.filledCount,2); assert.equal(x.fillRatePct,100); });
test('historical statistics reject unverified bars', () => { assert.throws(()=>summarizeHistoricalGaps([{timestamp:'2026-01-01T00:00:00Z',close:100,verified:false},{timestamp:'2026-01-02T00:00:00Z',open:101,high:103,low:99,close:102,verified:true}])); });
