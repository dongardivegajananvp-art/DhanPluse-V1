import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProRiskPlan, estimateTargetHitConfidence, wilsonLowerBound } from './pro-risk-engine.js';

function optionFixture(){
  const rows=[];
  for(let i=0;i<30;i++){
    const base=100+i*0.3;
    rows.push({time:1760000000+i*300,open:base,high:base+1,low:base-1,close:base+0.5,volume:1000});
  }
  rows[20]={...rows[20],open:108.8,high:110,low:108,close:109.4};
  rows[21]={...rows[21],open:109,high:110.5,low:108.2,close:109.7};
  rows[22]={...rows[22],open:109,high:110,low:107.5,close:109.3};
  rows[23]={...rows[23],open:109.2,high:111,low:108.1,close:110.2};
  rows[24]={...rows[24],open:110,high:112,low:108.8,close:111};
  rows[25]={...rows[25],open:111,high:114,low:110,close:112.5};
  rows[26]={...rows[26],open:112,high:117.5,low:111,close:113};
  rows[27]={...rows[27],open:112,high:114,low:110,close:111.5};
  rows[28]={...rows[28],open:111,high:113,low:109,close:110.5};
  rows[29]={...rows[29],open:110,high:112,low:109,close:110.4};
  return rows;
}

test('Wilson lower confidence bound is conservative and bounded',()=>{
  assert.equal(wilsonLowerBound(0,0),null);
  assert.ok(wilsonLowerBound(20,10)>0&&wilsonLowerBound(20,10)<20/30);
  assert.ok(wilsonLowerBound(30,0)<1);
});

test('target hit probability remains uncalibrated below 30 comparable outcomes',()=>{
  const result=estimateTargetHitConfidence({wins:18,losses:11});
  assert.equal(result.status,'UNCALIBRATED');
  assert.equal(result.hitRate,null);
  assert.equal(result.samples,29);
});

test('target hit probability requires conservative lower confidence bound after 30 outcomes',()=>{
  const weak=estimateTargetHitConfidence({wins:12,losses:18});
  const strong=estimateTargetHitConfidence({wins:25,losses:5});
  assert.equal(weak.status,'LOW_CONFIDENCE');
  assert.equal(strong.status,'CALIBRATED');
  assert.ok(strong.lowerBound>35);
});

test('Pro risk plan uses structural stop, resistance-aware target and preserves at least 1:2 RR',()=>{
  const rows=optionFixture();
  rows[26].high=130;
  const result=buildProRiskPlan({candles:rows,entry:110,tickSize:0.05,livePremium:110.1,side:'LONG',outcomeStats:{wins:0,losses:0}});
  assert.equal(result.status,'SETUP_CONFIRMED',JSON.stringify(result));
  assert.ok(result.stopLoss<result.entry);
  assert.ok(result.target>result.entry);
  assert.ok(result.rr>=2);
  assert.equal(result.riskResearch.model,'GV2VPD_NSE_PRO_RISK_V1');
  assert.equal(result.riskResearch.targetSource,'NEAREST_VERIFIED_OPTION_SUPPLY_PIVOT');
  assert.equal(result.riskResearch.probability.status,'UNCALIBRATED');
  assert.equal(result.riskResearch.tradePermission,'READ_ONLY_RESEARCH_ONLY_UNCALIBRATED');
});

test('Pro risk plan rejects a chase beyond the ATR-based entry limit',()=>{
  const result=buildProRiskPlan({candles:optionFixture(),entry:110,tickSize:0.05,livePremium:115,side:'LONG'});
  assert.equal(result.status,'NO_TRADE');
  assert.match(result.reason,/chase limit/);
});

test('Pro risk plan rejects a nearby resistance that cannot offer minimum 1:2 RR',()=>{
  const rows=optionFixture();
  rows[26].high=112;
  const result=buildProRiskPlan({candles:rows,entry:110,tickSize:0.05,livePremium:110.1});
  assert.equal(result.status,'NO_TRADE');
  assert.match(result.reason,/supply pivot is inside/);
});

test('calibrated target model reports break-even rate and observed/conservative expectancy in R',()=>{
  const result=estimateTargetHitConfidence({wins:25,losses:5},2.25);
  assert.equal(result.status,'CALIBRATED');
  assert.equal(result.breakEvenHitRate,30.8);
  assert.ok(result.expectedValueR>0);
  assert.ok(result.conservativeExpectedValueR>0);
});

test('uncalibrated model never emits a fabricated hit rate or expectancy',()=>{
  const result=estimateTargetHitConfidence({wins:18,losses:11},2);
  assert.equal(result.status,'UNCALIBRATED');
  assert.equal(result.hitRate,null);
  assert.equal(result.lowerBound,null);
  assert.equal(result.expectedValueR,null);
  assert.equal(result.conservativeExpectedValueR,null);
});

test('invalid or sub-2R calibration target cannot produce expectancy',()=>{
  const result=estimateTargetHitConfidence({wins:25,losses:5},1.5);
  assert.equal(result.status,'INVALID_RR');
  assert.equal(result.expectedValueR,null);
});
