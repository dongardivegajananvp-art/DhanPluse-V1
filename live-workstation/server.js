import crypto from 'node:crypto';
import { getNseMarketSession } from './nse-market-session.js';
import {createSharedTokenReader} from './token-reader.js';
import { createFyersDataApiBudget } from './fyers-rest-budget.js';
import { socketRecoveryDelayMs } from './socket-recovery-policy.js';
import { shouldRestartSilentIndexFeed } from './socket-feed-watchdog.js';
import { STRATEGY_SCAN_INTERVAL_MS, FNO_ROTATION_INTERVAL_MS, estimateScannerRestRequestsPerMinute } from './scanner-schedule.js';
import { evaluateThreeCandleBreakout, getCompletedCandleWindow, isHistoryCacheFresh } from './public/chart-safety.js';
import { historyRetryDelayMs, shouldAttemptHistoryRetry } from './history-retry-policy.js';
import { acceptExchangeTick, exchangeTickFreshness, getScannerRuntimeState, summarizeFeedFreshness } from './market-data-integrity.js';
import { parseFyersQuoteTicks } from './fyers-quote-recovery.js';
import { sameStrategyConfirmation, validateOptionCandles, validateOptionContractIdentity, validateOptionPremiumTick } from './strategy-candidate-guard.js';
import { mcxFutureRoot, listMxcOptionContracts, pickMxcOptionCandidates } from './mcx-options.js';
import { parseFyersMarginPreflight, classifyFyersOrder } from './order-safety.js';
import { buildFnoUniverse, buildLiveFnoMovers, selectFairSubscriptionBatch, summarizeFnoCoverage } from './fno-universe.js';
import { createStrategyPlanStore, evaluateActivePlanLifecycle } from './strategy-plan-store.js';
import { detectNineStrategySetup, evaluateNineStrategies } from './strategy-engine.js';
import { selectNearestOptionContract, completedDailyCandles, strategyCandidateKey } from './strategy-scanner.js';
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const {fyersDataSocket}=require('fyers-api-v3');
const app=express();
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'32kb'}));
app.use(cors({origin:(origin,cb)=>cb(null,!origin||origin===process.env.APP_ORIGIN),credentials:false}));
function workstationBasicAuth(req,res,next){
  if(req.method==='OPTIONS'||req.path==='/api/fyers/auth/callback')return next();
  const expected=String(process.env.WORKSTATION_ACCESS_PASSWORD||'');
  if(expected.length<24)return res.status(503).send('Workstation access password is not configured.');
  const header=String(req.headers.authorization||'');
  const match=header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if(match){
    let decoded='';
    try{decoded=Buffer.from(match[1],'base64').toString('utf8');}catch{}
    const split=decoded.indexOf(':');
    const username=split>=0?decoded.slice(0,split):'';
    const password=split>=0?decoded.slice(split+1):'';
    const supplied=Buffer.from(password,'utf8'),wanted=Buffer.from(expected,'utf8');
    const passwordOk=supplied.length===wanted.length&&crypto.timingSafeEqual(supplied,wanted);
    if(username==='gv2vpd'&&passwordOk)return next();
  }
  res.set('WWW-Authenticate','Basic realm="GV2VPD Live Workstation", charset="UTF-8"');
  return res.status(401).send('Authentication required.');
}
app.use(workstationBasicAuth);
app.use(express.static(new URL('./public',import.meta.url).pathname));

const appId=(process.env.FYERS_APP_ID||'').trim();
const appSecret=(process.env.FYERS_APP_SECRET||'').trim();
const redirectUri=(process.env.FYERS_REDIRECT_URI||'').trim();
const pendingAuthStates=new Map();
const AUTH_STATE_TTL_MS=10*60*1000;
const tokenReader=createSharedTokenReader({databaseUrl:process.env.DATABASE_URL,encryptionKey:process.env.FYERS_TOKEN_ENCRYPTION_KEY});
let accessToken='';
let socket=null;
let connected=false;
let socketConnectCount=0;
let lastSocketConnectAt=null;
let lastSocketMessageAt=null;
let lastAcceptedTickAt=null;
let lastSocketError='';
let lastSocketConnectAttemptAt=null;
let lastSocketRecoveryAt=null;
let socketRecoveryAttempts=0;
let socketRecoveryTimer=null;
let indexFeedStaleSince=0;
let lastFreshIndexTickAt=null;
let socketPayloadDiagnostics=0;
let lastTickDiagnosticAt=new Map();
const indexTickGapSamples=new Map();
const mcxTickGapSamples=new Map();
let lastSubscriptionRecoveryAt=0;
let lastMcxSubscriptionRecoveryAt=0;
let lastRestQuoteRecoveryAt=0;
let selectedSymbol='';
let selectedOptionSymbol='';
async function restoreSelectedMcxInstrument(){
  if(!orderRequestPool||!(await fyersCooldownStoreReady))return false;
  try{
    const result=await orderRequestPool.query('SELECT state_value FROM gv2vpd_runtime_state WHERE state_key=$1',['gv2vpd-live-workstation-selected-mcx-instrument']);
    let saved=result.rows?.[0]?.state_value??null;
    if(typeof saved==='string'){try{saved=JSON.parse(saved);}catch{saved=null;}}
    const symbol=String(saved?.symbol||'').trim().toUpperCase();
    if(!mcxFutureRoot(symbol))return false;
    selectedSymbol=symbol;
    console.info('Persisted MCX instrument restored before WebSocket startup.',JSON.stringify({selectedSymbol,restoredAt:new Date().toISOString()}));
    return true;
  }catch(error){
    console.error('Persisted MCX instrument restore failed; MCX selection remains unset.',String(error?.message||error).slice(0,160));
    return false;
  }
}
async function persistSelectedMcxInstrument(symbol){
  if(!orderRequestPool||!(await fyersCooldownStoreReady))throw new Error('Durable MCX selection store unavailable; instrument selection was not activated');
  if(mcxFutureRoot(symbol)){
    await orderRequestPool.query(
      `INSERT INTO gv2vpd_runtime_state (state_key,state_value,updated_at) VALUES ($1,$2::jsonb,NOW())
       ON CONFLICT (state_key) DO UPDATE SET state_value=EXCLUDED.state_value,updated_at=NOW()`,
      ['gv2vpd-live-workstation-selected-mcx-instrument',JSON.stringify({symbol,updatedAt:new Date().toISOString()})]
    );
  }else{
    await orderRequestPool.query('DELETE FROM gv2vpd_runtime_state WHERE state_key=$1',['gv2vpd-live-workstation-selected-mcx-instrument']);
  }
}
let lastTicks=new Map();
const nseTicks=new Map(),mcxTicks=new Map();
const usedOrderRequestIds=new Set();
const {Pool}=require('pg');
const databaseUrl=String(process.env.DATABASE_URL||'').trim();
const strategyPlanStore=createStrategyPlanStore({databaseUrl});
const orderRequestPool=databaseUrl.startsWith('postgres://')||databaseUrl.startsWith('postgresql://')?new Pool({connectionString:databaseUrl,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:10000,application_name:'gv2vpd-order-idempotency'}):null;
const orderRequestStoreReady=orderRequestPool?orderRequestPool.query("CREATE TABLE IF NOT EXISTS gv2vpd_order_requests (request_id VARCHAR(64) PRIMARY KEY, request_hash CHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, broker_order_id VARCHAR(128), response_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())").then(()=>true).catch(error=>{console.error('Order idempotency store unavailable; order route will remain fail-closed.',String(error?.message||error).slice(0,160));return false;}):Promise.resolve(false);
const fyersCooldownStoreReady=orderRequestPool?orderRequestPool.query("CREATE TABLE IF NOT EXISTS gv2vpd_runtime_state (state_key TEXT PRIMARY KEY, state_value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())").then(()=>true).catch(error=>{console.error('FYERS cooldown persistence table unavailable; REST will remain fail-closed.',String(error?.message||error).slice(0,160));return false;}):Promise.resolve(false);
let fyersRestBudgetReady=false;
let startupState='STARTING';
let startupError='';
let sharedSessionRestored=false;
let restRecoveryProbeInFlight=false;
let lastRestRecoveryProbeAt=0;

const optionChains=new Map();
const mcxOptionChains=new Map();
const mcxOptionHistoryCache=new Map();
let mcxComMaster=null,mcxComMasterFetchedAt=0,mcxComMasterPromise=null;
let mcxOptionCandidateSymbols=[];
let mcxScanPromise=null,mcxScanSymbol='';
let nseFoMaster=null,nseFoMasterFetchedAt=0,nseFoMasterPromise=null;
let bseFoMaster=null,bseFoMasterFetchedAt=0,bseFoMasterPromise=null;
let fnoMoversCache={rows:[],updatedAt:0,expiresAt:0,error:'Not loaded'};
let fnoMoversPromise=null,screenerConfigCache=null,screenerConfigFetchedAt=0,screenerConfigPromise=null;
let accountSnapshot=null,accountSnapshotFetchedAt=0,accountFetchPromise=null,accountRetryAfter=0,accountFailureCount=0;
const subscribedSymbols=new Set();
const strategyOptionSymbols=new Set();
const strategyPendingCandidates=new Map();
const strategyScanLastAttempt=new Map();
const strategyDailyHistoryCache=new Map();
let strategyScanCursor=0;
let strategyScanBusy=false;
let strategyScanLastAt=null;
let strategyScanLastSymbol='';
let strategyScanLastError='';
let strategyScanLastResults=[];
let strategyActivePlans=[];
let strategyActivePlansLoadedAt=0;
let strategyLedgerRuntimeReady=false;
const FYERS_DATA_SYMBOL_LIMIT=80; // Keep 20 account-wide slots free for other active FYERS API connections and transition overlap.
let subscriptionTransitionTimer=null;
let fnoUniverseRows=[],fnoUniverseFetchedAt=0,fnoUniversePromise=null,fnoUniverseCursor=0,fnoScanSubscriptionSymbols=[],fnoUniverseError='Not loaded',lastFnoRotationAt=null,fnoRotationCount=0;
const BASE_SUBSCRIPTIONS=['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'];
function syncSocketSubscriptions({force=false,reason='state_change'}={}){
  if(!socket||!connected)return {subscribed:0,removed:0};
  let subscriptionError='';
  let pendingFnoCursor=null;
  // When an MCX future is selected, isolate the live socket to that MCX future
  // and its verified option candidates. NSE indices/F&O rotation are irrelevant
  // to the MCX workstation view and can consume the Standard-plan symbol budget.
  const mcxOnlyMode=Boolean(mcxFutureRoot(selectedSymbol));
  const nseSessionActive=isNseSubscriptionSession();
  const nseClosedIdleMode=!mcxOnlyMode&&!nseSessionActive;
  if(!mcxOnlyMode&&nseSessionActive&&fnoUniverseRows.length){
    const pinned=[selectedSymbol,selectedOptionSymbol,...strategyOptionSymbols,...mcxOptionCandidateSymbols,...fnoMoversCache.rows.flatMap(x=>[x.symbol,x.underlyingSymbol])].filter(Boolean);
    try{
      const batch=selectFairSubscriptionBatch({baseSymbols:BASE_SUBSCRIPTIONS,pinnedSymbols:pinned,universeSymbols:fnoUniverseRows.map(x=>x.futureSymbol),cursor:fnoUniverseCursor,limit:FYERS_DATA_SYMBOL_LIMIT});
      fnoScanSubscriptionSymbols=batch.fnoSymbols;
      if(reason==='scheduled_rotation'||reason==='universe_loaded')pendingFnoCursor=batch.nextCursor;
    }catch(error){
      fnoScanSubscriptionSymbols=[];
      fnoUniverseError='F&O subscription window unavailable: '+String(error?.message||error).slice(0,140);
      return{subscribed:0,removed:0,error:fnoUniverseError};
    }
  }else if(mcxOnlyMode){
    fnoScanSubscriptionSymbols=[];
  }
  const wanted=mcxOnlyMode
    ?new Set([selectedSymbol,selectedOptionSymbol,...mcxOptionCandidateSymbols].filter(Boolean))
    :nseClosedIdleMode?new Set()
    :new Set([...BASE_SUBSCRIPTIONS,...(selectedSymbol?[selectedSymbol]:[]),...(selectedOptionSymbol?[selectedOptionSymbol]:[]),...strategyOptionSymbols,...mcxOptionCandidateSymbols,...fnoMoversCache.rows.flatMap(x=>[x.symbol,x.underlyingSymbol]).filter(Boolean),...fnoScanSubscriptionSymbols]);
  if(wanted.size>FYERS_DATA_SYMBOL_LIMIT){
    fnoScanSubscriptionSymbols=[];
    fnoUniverseError='FYERS account-wide subscription reserve exceeded; F&O scan window held fail-closed';
    return{subscribed:0,removed:0,error:fnoUniverseError};
  }
  const add=[...wanted].filter(x=>force||!subscribedSymbols.has(x));
  const remove=[...subscribedSymbols].filter(x=>!wanted.has(x));
  if(remove.length){
    if(typeof socket.unsubscribe!=='function')subscriptionError='FYERS socket unsubscribe is unavailable; rotation cannot be confirmed safely';
    else try{
      socket.unsubscribe(remove);
      for(const symbol of remove)subscribedSymbols.delete(symbol);
      if(pendingFnoCursor!==null)fnoUniverseCursor=pendingFnoCursor;
      console.info('FYERS subscription rotation releasing old window before adding next.',JSON.stringify({removed:remove.length,delayedAddCount:add.length,delayMs:2500,reason}));
      if(subscriptionTransitionTimer)clearTimeout(subscriptionTransitionTimer);
      subscriptionTransitionTimer=setTimeout(()=>{
        subscriptionTransitionTimer=null;
        syncSocketSubscriptions({reason:'post_unsubscribe_settle'});
      },2500);
      return{subscribed:0,removed:remove.length,pending:add.length>0};
    }catch(e){subscriptionError='FYERS unsubscribe failed: '+String(e?.message||e).slice(0,140);console.error(subscriptionError);}
  }
  if(subscriptionTransitionTimer&&reason!=='post_unsubscribe_settle')return{subscribed:0,removed:0,pending:true};
  if(!subscriptionError&&add.length){
    try{
      socket.mode(socket.FullMode);
      socket.subscribe(add);
      for(const symbol of add)subscribedSymbols.add(symbol);
      console.info('FYERS market subscriptions requested.',JSON.stringify({reason,marketMode:mcxOnlyMode?'MCX_ONLY':nseClosedIdleMode?'NSE_CLOSED_IDLE':'NSE_FNO',count:add.length,totalWanted:wanted.size,accountWideReserve:FYERS_DATA_SYMBOL_LIMIT,symbols:add}));
    }catch(e){subscriptionError='FYERS subscribe failed: '+String(e?.message||e).slice(0,140);console.error(subscriptionError);}
  }
  if(subscriptionError){fnoScanSubscriptionSymbols=[];fnoUniverseError=subscriptionError;return{subscribed:0,removed:remove.length,error:subscriptionError};}
  if(pendingFnoCursor!==null)fnoUniverseCursor=pendingFnoCursor;
  if(reason==='scheduled_rotation'||reason==='universe_loaded'){lastFnoRotationAt=new Date().toISOString();fnoRotationCount+=1;}
  if(!fnoUniverseError.startsWith('BSE F&O master unavailable'))fnoUniverseError='';
  return {subscribed:add.length,removed:remove.length};
}
const FYERS_DATA='https://api-t1.fyers.in/data';
const FYERS_API='https://api-t1.fyers.in/api/v3';
const freshTick=(tick,maxAgeMs=10000)=>Boolean(tick&&Date.now()-tick.receivedAt>=0&&Date.now()-tick.receivedAt<=maxAgeMs&&Date.now()/1000-Number(tick.exchangeTime)<=10&&Date.now()/1000-Number(tick.exchangeTime)>=-3);
// One shared FYERS API budget covers every api-t1 endpoint (Data + v3).
// Cooldown state is durable in PostgreSQL and restored before REST traffic is allowed.
const FYERS_REST_MIN_INTERVAL_MS=4000;
const FYERS_REST_MAX_COOLDOWN_MS=60*60*1000;
function fyersRetryAfterMs(response){const raw=String(response.headers?.get?.('retry-after')||'').trim();if(!raw)return 0;const seconds=Number(raw);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;const date=Date.parse(raw);return Number.isFinite(date)?Math.max(0,date-Date.now()):0;}
const fetchWithFyersBudget=createFyersDataApiBudget({
  allApiPaths:true,maxRequestsPerMinute:15,minIntervalMs:FYERS_REST_MIN_INTERVAL_MS,maxQueuedRequests:24,
  onCooldownChange:async state=>{
    if(!orderRequestPool||!(await fyersCooldownStoreReady)||!fyersRestBudgetReady)return false;
    if(state.cooldownUntil>Date.now()){
      const value={...state,blockedUntil:new Date(state.cooldownUntil).toISOString()};
      await orderRequestPool.query(
        `INSERT INTO gv2vpd_runtime_state (state_key,state_value,updated_at) VALUES ($1,$2::jsonb,NOW())
         ON CONFLICT (state_key) DO UPDATE SET state_value=EXCLUDED.state_value,updated_at=NOW()`,
        ['gv2vpd-live-workstation-fyers-rest-cooldown',JSON.stringify(value)]
      );
    }else{
      await orderRequestPool.query('DELETE FROM gv2vpd_runtime_state WHERE state_key=$1',['gv2vpd-live-workstation-fyers-rest-cooldown']);
    }
    return true;
  }
});
async function initializeFyersRestBudget(){
  try{
    if(!orderRequestPool||!(await fyersCooldownStoreReady))throw new Error('Durable PostgreSQL cooldown store is unavailable');
    const result=await orderRequestPool.query('SELECT state_value FROM gv2vpd_runtime_state WHERE state_key=$1',['gv2vpd-live-workstation-fyers-rest-cooldown']);
    let saved=result.rows?.[0]?.state_value??null;
    if(typeof saved==='string'){try{saved=JSON.parse(saved);}catch{saved=null;}}
    if(saved&&fetchWithFyersBudget.restoreStatus(saved)){
      console.warn('FYERS REST cooldown restored from PostgreSQL; all API endpoints remain paused.',JSON.stringify(fetchWithFyersBudget.getStatus()));
    }else{
      if(saved)await orderRequestPool.query('DELETE FROM gv2vpd_runtime_state WHERE state_key=$1',['gv2vpd-live-workstation-fyers-rest-cooldown']);
      // One-time deployment bridge: preserve a known active provider block across
      // the first restart onto the durable-cooldown release. Never probe FYERS
      // during the provider's Retry-After window just because the old process
      // held its cooldown only in memory.
      const startupUntil=Date.parse(String(process.env.FYERS_REST_STARTUP_COOLDOWN_UNTIL||''));
      if(Number.isFinite(startupUntil)&&startupUntil>Date.now()&&startupUntil-Date.now()<=FYERS_REST_MAX_COOLDOWN_MS){
        const seed={blockedUntil:new Date(startupUntil).toISOString(),cooldownUntil:startupUntil,cooldownReason:'CLOUDFLARE_1015',cooldownPathname:'/data/quotes',cooldownGeneration:1,consecutiveCloudflareBlocks:1,consecutiveRateLimitBlocks:0};
        if(fetchWithFyersBudget.restoreStatus(seed)){
          await orderRequestPool.query(
            `INSERT INTO gv2vpd_runtime_state (state_key,state_value,updated_at) VALUES ($1,$2::jsonb,NOW())
             ON CONFLICT (state_key) DO UPDATE SET state_value=EXCLUDED.state_value,updated_at=NOW()`,
            ['gv2vpd-live-workstation-fyers-rest-cooldown',JSON.stringify(seed)]
          );
          console.warn('FYERS REST startup cooldown seeded and persisted before deployment recovery.',JSON.stringify(fetchWithFyersBudget.getStatus()));
        }
      }
    }
    fyersRestBudgetReady=true;
    console.info('FYERS REST budget ready.',JSON.stringify({allApiPaths:true,minIntervalMs:FYERS_REST_MIN_INTERVAL_MS,maxRequestsPerMinute:15,maxQueuedRequests:24,persistence:'POSTGRESQL',restoredCooldown:Boolean(saved&&fetchWithFyersBudget.getStatus().cooldownActive)}));
    return true;
  }catch(error){
    fyersRestBudgetReady=false;
    console.error('FYERS REST budget initialization failed; authenticated REST is blocked fail-closed.',String(error?.message||error).slice(0,180));
    return false;
  }
}
async function fyersRestFetch(url,init={}){
  const target=new URL(url);
  if(target.hostname!=='api-t1.fyers.in')return fetch(url,init);
  if(!fyersRestBudgetReady)return new Response(JSON.stringify({s:'error',message:'FYERS REST budget is not ready; no upstream request was sent.'}),{status:503,headers:{'content-type':'application/json','x-fyers-budget':'not-ready'}});
  return fetchWithFyersBudget(url,init);
}

function toEpochSeconds(value){if(value===null||value===undefined||value==='')return 0;const n=Number(value);if(Number.isFinite(n)&&n>0)return n>1e12?n/1000:n;const parsed=Date.parse(String(value));return Number.isFinite(parsed)&&parsed>0?parsed/1000:0;}
async function fyersGet(url,{priority}={}){const r=await fyersRestFetch(url,{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:12000,priority});const raw=await r.text();let j={};try{j=raw?JSON.parse(raw):{};}catch{throw new Error('FYERS returned non-JSON response (HTTP '+r.status+')');}if(!r.ok||j.s==='error'){const error=new Error('FYERS HTTP '+r.status+' · '+String(j.message||j.code||j.data?.error||'request rejected').replace(/\\s+/g,' ').slice(0,180));error.statusCode=r.status;error.retryAfterMs=Number(j.retryAfterSeconds)*1000||fyersRetryAfterMs(r);throw error;}return j;}
async function fyersPost(url,body){const r=await fyersRestFetch(url,{method:'POST',headers:{Authorization:appId+':'+accessToken,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body),timeoutMs:12000});const j=await r.json().catch(()=>({}));if(!r.ok||j.s!=='ok'){const error=new Error(String(j.message||j.code||'FYERS order request failed'));error.statusCode=r.status;error.retryAfterMs=Number(j.retryAfterSeconds)*1000||fyersRetryAfterMs(r);throw error;}return j;}
async function loadNseFoMaster(){if(nseFoMaster&&Date.now()-nseFoMasterFetchedAt<86400000)return nseFoMaster;if(nseFoMasterPromise)return nseFoMasterPromise;nseFoMasterPromise=(async()=>{const r=await fetch('https://public.fyers.in/sym_details/NSE_FO_sym_master.json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('FYERS NSE F&O symbol master unavailable');const master=await r.json();if(!master||typeof master!=='object'||Array.isArray(master))throw new Error('Invalid FYERS symbol master');nseFoMaster=master;nseFoMasterFetchedAt=Date.now();return master;})().finally(()=>{nseFoMasterPromise=null});return nseFoMasterPromise;}
async function loadBseFoMaster(){if(bseFoMaster&&Date.now()-bseFoMasterFetchedAt<86400000)return bseFoMaster;if(bseFoMasterPromise)return bseFoMasterPromise;bseFoMasterPromise=(async()=>{const r=await fetch('https://public.fyers.in/sym_details/BSE_FO_sym_master.json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('FYERS BSE F&O symbol master unavailable');const master=await r.json();if(!master||typeof master!=='object'||Array.isArray(master))throw new Error('Invalid FYERS BSE F&O symbol master');bseFoMaster=master;bseFoMasterFetchedAt=Date.now();return master;})().finally(()=>{bseFoMasterPromise=null});return bseFoMasterPromise;}
async function loadMcxComMaster(){if(mcxComMaster&&Date.now()-mcxComMasterFetchedAt<86400000)return mcxComMaster;if(mcxComMasterPromise)return mcxComMasterPromise;mcxComMasterPromise=(async()=>{const r=await fetch('https://public.fyers.in/sym_details/MCX_COM_sym_master.json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('FYERS MCX commodity Symbol Master unavailable');const master=await r.json();if(!master||typeof master!=='object'||Array.isArray(master))throw new Error('Invalid FYERS MCX commodity Symbol Master');mcxComMaster=master;mcxComMasterFetchedAt=Date.now();return mcxComMaster;})().finally(()=>{mcxComMasterPromise=null});return mcxComMasterPromise;}
function optionMeta(symbol,master){const x=master?.[symbol];if(!x||Number(x.tradeStatus)!==1||!['CE','PE'].includes(String(x.optType||'').toUpperCase()))return null;const lotSize=Number(x.minLotSize),tickSize=Number(x.tickSize),strike=Number(x.strikePrice);if(!Number.isInteger(lotSize)||lotSize<1||!Number.isFinite(tickSize)||tickSize<=0||!Number.isFinite(strike)||strike<=0)return null;return{symbol,side:String(x.optType).toUpperCase(),strike,lotSize,tickSize,expiryDate:String(x.expiryDate||'')};}



async function loadScreenerConfig(){if(screenerConfigCache&&Date.now()-screenerConfigFetchedAt<86400000)return screenerConfigCache;if(screenerConfigPromise)return screenerConfigPromise;screenerConfigPromise=fyersGet(FYERS_API+'/screeners/config').then(x=>{screenerConfigCache=x;screenerConfigFetchedAt=Date.now();return x;}).finally(()=>{screenerConfigPromise=null});return screenerConfigPromise;}
function screenerIds(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:String(item?.id||'')).filter(Boolean):[];}
async function loadFnoMovers(){if(fnoMoversCache.expiresAt>Date.now())return fnoMoversCache;if(fnoMoversPromise)return fnoMoversPromise;const live=buildLiveFnoMovers({universeRows:fnoUniverseRows,tickBySymbol:lastTicks,now:Date.now(),maxAgeMs:10000});if(live.rows.length){fnoMoversCache={rows:live.rows,updatedAt:live.updatedAt,expiresAt:Date.now()+5000,error:'',source:'FYERS WebSocket live futures ticks',coverage:{freshTickCount:live.freshUniverseTickCount,universeCount:live.universeCount}};syncSocketSubscriptions();return fnoMoversCache;}if(fetchWithFyersBudget.getStatus().cooldownActive){fnoMoversCache={rows:[],updatedAt:0,expiresAt:Date.now()+5000,error:'FYERS REST cooldown active; waiting for fresh WebSocket futures ticks'};return fnoMoversCache;}fnoMoversPromise=(async()=>{try{const config=await loadScreenerConfig(),data=config.data||{};const screeners=Array.isArray(data.screeners_standard)?data.screeners_standard:[];const candidates=screeners.filter(x=>String(x.category||'').toLowerCase().includes('futures')&&/(gain|gainer)/i.test(String(x.id||'')+' '+String(x.name||'')));const screener=candidates.find(x=>{const allowed=new Set(x.supported_params||[]);const universeIds=screenerIds(data.universe_groups?.[x.universe_group]);const columnIds=screenerIds(data.column_groups?.[x.column_group]);return allowed.has('universe')&&allowed.has('fields')&&universeIds.includes('fw002')&&['t0_close_ltp','t0_per_change'].every(id=>columnIds.includes(id));});if(!screener){const summary=candidates.map(x=>({id:x.id,category:x.category,universe_group:x.universe_group,column_group:x.column_group,supported_params:x.supported_params}));throw new Error('No FYERS Futures Scan gainer screener accepts fw002 + live price/change fields. Candidates: '+JSON.stringify(summary).slice(0,260));}const allowed=new Set(screener.supported_params||[]),params=new URLSearchParams({screener_id:screener.id});params.set('universe','fw002');params.set('fields','t0_close_ltp,t0_per_change');if(allowed.has('order_by'))params.set('order_by','t0_per_change');if(allowed.has('order'))params.set('order','desc');if(allowed.has('timeframe')&&(x=>x.includes('t0'))(screener.allowed_timeframes||[]))params.set('timeframe','t0');const result=await fyersGet(FYERS_API+'/screeners/standard?'+params.toString());const d=result.data||{},header=Array.isArray(d.header)?d.header:[],idx=Object.fromEntries(header.map((item,i)=>[item.unique_key,i]));if(!Number.isInteger(idx.symbolticker)||!Number.isInteger(idx.t0_close_ltp)||!Number.isInteger(idx.t0_per_change))throw new Error('FYERS screener response missing symbolticker / t0_close_ltp / t0_per_change columns');const master=await loadNseFoMaster();const byUnderlying=new Map();for(const row of (Array.isArray(d.body)?d.body:[])){const symbol=String(row[idx.symbolticker]||''),price=Number(row[idx.t0_close_ltp]),change=Number(row[idx.t0_per_change]);if(!/^NSE:.+FUT$/.test(symbol)||!Number.isFinite(price)||price<=0||!Number.isFinite(change)||1+change/100<=0)continue;const expiry=toEpochSeconds(master?.[symbol]?.expiryDate);if(!expiry||expiry*1000<Date.now())continue;const underlying=symbol.replace(/\d{2}[A-Z]{3}FUT$/,'');if(underlying===symbol)continue;const optionUnderlying=underlying==='NSE:NIFTY50'?'NSE:NIFTY50-INDEX':underlying==='NSE:BANKNIFTY'?'NSE:NIFTYBANK-INDEX':underlying+'-EQ';const candidate={symbol,underlying,underlyingSymbol:optionUnderlying,expiry,basePrice:price/(1+change/100),price,change,exchangeTime:Number(d.last_update_time||d.fetch_time||0),source:'FYERS Standard Screener'};const previous=byUnderlying.get(underlying);if(!previous||candidate.expiry<previous.expiry)byUnderlying.set(underlying,candidate);}const rows=[...byUnderlying.values()].sort((a,b)=>b.change-a.change).slice(0,5);if(!rows.length)throw new Error('FYERS stock-futures gainer screener returned no valid NSE futures rows');const updatedAt=Number(d.last_update_time||d.fetch_time||0)*1000;if(!Number.isFinite(updatedAt)||updatedAt<=0)throw new Error('FYERS screener response did not include a valid exchange refresh timestamp');fnoMoversCache={rows,updatedAt,expiresAt:Date.now()+60*1000,error:''};syncSocketSubscriptions();console.info('FYERS stock-futures gainers loaded.',JSON.stringify({screenerId:screener.id,count:rows.length,updatedAt:new Date(updatedAt).toISOString()}));return fnoMoversCache;}catch(e){const message=String(e?.message||e).replace(/\\s+/g,' ').slice(0,260);console.error('FYERS stock-futures gainers unavailable.',JSON.stringify({message,statusCode:e?.statusCode||null,retryAfterMs:e?.retryAfterMs||0}));const retryDelay=Math.max(15000,Math.min(FYERS_REST_MAX_COOLDOWN_MS,Number(e?.retryAfterMs)||30000));fnoMoversCache={rows:[],updatedAt:0,expiresAt:Date.now()+retryDelay,error:message};syncSocketSubscriptions();return fnoMoversCache;}})().finally(()=>{fnoMoversPromise=null});return fnoMoversPromise;}

async function refreshFnoUniverse(force=false){
  if(!force&&fnoUniverseRows.length&&Date.now()-fnoUniverseFetchedAt<6*60*60*1000)return fnoUniverseRows;
  if(fnoUniversePromise)return fnoUniversePromise;
  fnoUniversePromise=(async()=>{
    const [nseResult,bseResult]=await Promise.allSettled([loadNseFoMaster(),loadBseFoMaster()]);
    if(nseResult.status!=='fulfilled')throw nseResult.reason;
    const bseMaster=bseResult.status==='fulfilled'?bseResult.value:{};
    const rows=buildFnoUniverse({nseMaster:nseResult.value,bseMaster,now:Date.now()});
    if(!rows.length)throw new Error('Official FYERS Symbol Masters returned no active, unexpired F&O futures');
    fnoUniverseRows=rows;
    fnoUniverseFetchedAt=Date.now();
    fnoUniverseError=bseResult.status==='rejected'?'BSE F&O master unavailable; NSE universe only: '+String(bseResult.reason?.message||bseResult.reason).slice(0,120):'';
    console.info('Verified FYERS F&O universe loaded.',JSON.stringify({underlyings:rows.length,nse:rows.filter(x=>x.exchange==='NSE').length,bse:rows.filter(x=>x.exchange==='BSE').length,loadedAt:new Date(fnoUniverseFetchedAt).toISOString()}));
    return rows;
  })().finally(()=>{fnoUniversePromise=null;});
  return fnoUniversePromise;
}
function rotateFnoUniverseSubscriptions(reason='scheduled_rotation'){
  if(!fnoUniverseRows.length)return{symbols:0,universe:0,limit:FYERS_DATA_SYMBOL_LIMIT};
  const result=syncSocketSubscriptions({reason});
  console.info('FYERS F&O rotating subscription window updated.',JSON.stringify({reason,activeFutureSymbols:fnoScanSubscriptionSymbols.length,universeCount:fnoUniverseRows.length,symbolLimit:FYERS_DATA_SYMBOL_LIMIT,nextCursor:fnoUniverseCursor,subscribed:result.subscribed,removed:result.removed,error:result.error||null}));
  return{symbols:fnoScanSubscriptionSymbols.length,universe:fnoUniverseRows.length,limit:FYERS_DATA_SYMBOL_LIMIT,nextCursor:fnoUniverseCursor,error:result.error||null};
}
function authReady(){return Boolean(appId&&accessToken);}
function scheduleSocketRecovery(reason='socket_unavailable'){
  if(!authReady()||connected||socketRecoveryTimer)return;
  const delayMs=socketRecoveryDelayMs(socketRecoveryAttempts+1);
  socketRecoveryAttempts+=1;
  console.warn('FYERS socket recovery scheduled.',JSON.stringify({reason,attempt:socketRecoveryAttempts,delayMs,scheduledAt:new Date().toISOString()}));
  socketRecoveryTimer=setTimeout(()=>{
    socketRecoveryTimer=null;
    if(!authReady()||connected)return;
    const previous=socket;
    socket=null;
    connected=false;
    subscribedSymbols.clear();
    try{if(previous&&typeof previous.close==='function')previous.close();}catch{}
    lastSocketRecoveryAt=new Date().toISOString();
    console.warn('FYERS socket recovery restarting connection owner.',JSON.stringify({attempt:socketRecoveryAttempts,recoveryAt:lastSocketRecoveryAt,reason}));
    ensureSocket();
  },delayMs);
  socketRecoveryTimer.unref?.();
}
function ensureSocket(){
  if(!authReady()||socket)return;
  let owned=null;
  try{
    owned=fyersDataSocket.getInstance(`${appId}:${accessToken}`,'',false);
    socket=owned;
    lastSocketConnectAttemptAt=new Date().toISOString();
    console.info('FYERS WebSocket owner created.',JSON.stringify({at:new Date().toISOString(),tokenRestored:true}));
    owned.on('connect',()=>{
      if(socket!==owned)return;
      connected=true;
      if(socketRecoveryTimer){clearTimeout(socketRecoveryTimer);socketRecoveryTimer=null;}
      socketConnectCount+=1;
      lastSocketConnectAt=new Date().toISOString();
      lastSocketError='';
      subscribedSymbols.clear();
      console.info('FYERS WebSocket CONNECTED.',JSON.stringify({connectionNumber:socketConnectCount,connectedAt:lastSocketConnectAt}));
      try{
        owned.mode(owned.FullMode);
        syncSocketSubscriptions({force:true,reason:'socket_connect'});
        if(!mcxFutureRoot(selectedSymbol)&&isNseSubscriptionSession()){
          void refreshFnoUniverse().then(()=>rotateFnoUniverseSubscriptions('universe_loaded')).catch(error=>console.warn('FYERS F&O universe unavailable; scanner remains fail-closed.',String(error?.message||error).slice(0,180)));
        }else if(!mcxFutureRoot(selectedSymbol)){
          console.info('NSE subscriptions and F&O master refresh held while NSE is closed; awaiting MCX selection or next NSE session.');
        }
      }catch(e){console.error('FYERS initial subscription restore failed.',String(e?.message||e).slice(0,180));}
    });
    owned.on('message',raw=>{
      if(socket!==owned)return;
      lastSocketMessageAt=new Date().toISOString();
      let msg=raw;
      try{
        if(typeof raw==='string')msg=JSON.parse(raw);
        else if(Buffer.isBuffer(raw))msg=JSON.parse(raw.toString('utf8'));
        else if(raw instanceof ArrayBuffer)msg=JSON.parse(Buffer.from(raw).toString('utf8'));
        else if(ArrayBuffer.isView(raw))msg=JSON.parse(Buffer.from(raw.buffer,raw.byteOffset,raw.byteLength).toString('utf8'));
      }catch{
        if(socketPayloadDiagnostics<3){console.warn('FYERS socket non-JSON frame received.',JSON.stringify({rawType:Buffer.isBuffer(raw)?'Buffer':typeof raw}));socketPayloadDiagnostics++;}
        return;
      }
      const rows=Array.isArray(msg)?msg:Array.isArray(msg?.data)?msg.data:[msg];
      if(socketPayloadDiagnostics<3){
        const first=rows.find(x=>x&&typeof x==='object')||{};
        console.info('FYERS socket payload shape.',JSON.stringify({frameCount:rows.length,keys:Object.keys(first).slice(0,18),nestedKeys:first.v&&typeof first.v==='object'?Object.keys(first.v).slice(0,12):[]}));
        socketPayloadDiagnostics++;
      }
      let accepted=0;
      for(const row of rows){
        if(!row||typeof row!=='object')continue;
        const value=row.v&&typeof row.v==='object'?row.v:{};
        const symbol=String(row.symbol||row.n||value.symbol||'');
        const price=Number(row.ltp??row.lp??value.lp??value.ltp);
        const stamp=toEpochSeconds(row.exch_feed_time??row.last_traded_time??row.ltt??row.tt??value.exch_feed_time??value.last_traded_time??value.ltt??value.tt);
        if(!symbol||!Number.isFinite(price)||price<=0||!Number.isFinite(stamp)||stamp<=0)continue;
        const previousCloseRaw=row.prev_close_price??row.prevClose??row.prev_close??value.prev_close_price??value.prevClose??value.prev_close;const previousClose=Number(previousCloseRaw);const tick={symbol,price,previousClose:Number.isFinite(previousClose)&&previousClose>0?previousClose:null,exchangeTime:stamp,receivedAt:Date.now()};
        const tickAcceptance=acceptExchangeTick(lastTicks.get(symbol),tick);
        if(!tickAcceptance.accepted){if(tickAcceptance.reason==='OUT_OF_ORDER_EXCHANGE_TIMESTAMP'||tickAcceptance.reason==='FUTURE_EXCHANGE_TIMESTAMP'){console.warn('FYERS tick rejected by monotonic timestamp guard.',JSON.stringify({symbol,reason:tickAcceptance.reason,exchangeTimestamp:new Date(stamp*1000).toISOString()}));}continue;}
        lastTicks.set(symbol,tick);
        if(BASE_SUBSCRIPTIONS.includes(symbol)){
          const previousGaps=indexTickGapSamples.get(symbol)||{lastReceivedAt:0,samples:[]};
          const receiveGapMs=previousGaps.lastReceivedAt?tick.receivedAt-previousGaps.lastReceivedAt:null;
          const samples=receiveGapMs!==null&&receiveGapMs>=0?[...previousGaps.samples,receiveGapMs].slice(-20):previousGaps.samples;
          indexTickGapSamples.set(symbol,{lastReceivedAt:tick.receivedAt,samples});
        }
        if(BASE_SUBSCRIPTIONS.every(indexSymbol=>freshTick(lastTicks.get(indexSymbol),10000))){
          indexFeedStaleSince=0;
          lastFreshIndexTickAt=new Date().toISOString();
          socketRecoveryAttempts=0;
        }
        if(symbol.startsWith('MCX:')){
          mcxTicks.set(symbol,tick);
          const previousGaps=mcxTickGapSamples.get(symbol)||{lastReceivedAt:0,samples:[]};
          const receiveGapMs=previousGaps.lastReceivedAt?tick.receivedAt-previousGaps.lastReceivedAt:null;
          const samples=receiveGapMs!==null&&receiveGapMs>=0?[...previousGaps.samples,receiveGapMs].slice(-20):previousGaps.samples;
          mcxTickGapSamples.set(symbol,{lastReceivedAt:tick.receivedAt,samples});
        }else if(symbol.startsWith('NSE:')||symbol.startsWith('BSE:'))nseTicks.set(symbol,tick);
        accepted++;
        const lastLog=lastTickDiagnosticAt.get(symbol)||0;
        if(Date.now()-lastLog>=30000){
          const ageSeconds=Number((Date.now()/1000-stamp).toFixed(1));
          const gapStats=BASE_SUBSCRIPTIONS.includes(symbol)?(indexTickGapSamples.get(symbol)||{samples:[]}):symbol.startsWith('MCX:')?(mcxTickGapSamples.get(symbol)||{samples:[]}):{samples:[]};
          const gaps=gapStats.samples;
          const avgReceiveGapSeconds=gaps.length?Number((gaps.reduce((sum,value)=>sum+value,0)/gaps.length/1000).toFixed(2)):null;
          const maxReceiveGapSeconds=gaps.length?Number((Math.max(...gaps)/1000).toFixed(2)):null;
          console.info('FYERS exchange tick accepted.',JSON.stringify({symbol,exchangeTimestamp:new Date(stamp*1000).toISOString(),exchangeAgeSeconds:ageSeconds,freshness:ageSeconds>=0&&ageSeconds<=10?'FRESH':'STALE',receiveGapSampleCount:gaps.length,avgReceiveGapSeconds,maxReceiveGapSeconds}));
          lastTickDiagnosticAt.set(symbol,Date.now());
        }
      }
      if(accepted>0)lastAcceptedTickAt=new Date().toISOString();
    });
    owned.on('error',error=>{
      if(socket!==owned)return;
      lastSocketError=String(error?.message||error||'Unknown FYERS socket error').replace(/\s+/g,' ').slice(0,180);
      let sdkConnected=null;
      try{if(typeof owned.isConnected==='function')sdkConnected=Boolean(owned.isConnected());}catch{}
      if(sdkConnected===false)connected=false;
      console.warn('FYERS WebSocket error event.',JSON.stringify({message:lastSocketError,transportConnected:connected,sdkConnected}));
      if(sdkConnected===false)scheduleSocketRecovery('socket_error_disconnected');
    });
    owned.on('close',(code,reason)=>{
      if(socket!==owned)return;
      connected=false;
      if(subscriptionTransitionTimer){clearTimeout(subscriptionTransitionTimer);subscriptionTransitionTimer=null;}
      subscribedSymbols.clear();
      lastSocketConnectAttemptAt=null;
      console.warn('FYERS WebSocket CLOSED.',JSON.stringify({code:code??null,reason:reason==null?null:String(reason).slice(0,140),closedAt:new Date().toISOString()}));
      scheduleSocketRecovery('socket_closed');
    });
    const reconnect=typeof owned.autoreconnect==='function'?owned.autoreconnect.bind(owned):typeof owned.autoReconnect==='function'?owned.autoReconnect.bind(owned):null;
    if(!reconnect)throw new Error('FYERS SDK auto-reconnect unavailable');
    reconnect(50);
    console.info('FYERS SDK auto-reconnect enabled.',JSON.stringify({retries:50,method:typeof owned.autoreconnect==='function'?'autoreconnect':'autoReconnect'}));
    owned.connect();
    console.info('FYERS WebSocket connect() invoked.');
  }catch(e){
    connected=false;
    lastSocketError=String(e?.message||e).slice(0,180);
    if(socket===owned)socket=null;
    console.error('FYERS WebSocket startup failed.',lastSocketError);
    scheduleSocketRecovery('socket_startup_failed');
    throw e;
  }
}
function isNseSubscriptionSession(){
  const phase=String(getNseMarketSession().phase||'CLOSED');
  return phase==='REGULAR'||phase.startsWith('PRE_OPEN_');
}
function isNseRegularSession(){
  return getNseMarketSession().phase==='REGULAR';
}
function isMcxScheduledSession(now=new Date()){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Kolkata',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  const minutes=Number(values.hour)*60+Number(values.minute);
  return !['Sat','Sun'].includes(values.weekday)&&minutes>=540&&minutes<1435;
}
async function recoverStaleSubscriptionsViaQuotes(staleSymbols) {
  const restStatus = fetchWithFyersBudget.getStatus();
  const quoteRecoveryProbe = restStatus.recoveryProbeRequired && restStatus.recoveryProbePathname === '/data/quotes';
  if (!authReady() || (!quoteRecoveryProbe && !isNseRegularSession()) || (restStatus.cooldownActive && !quoteRecoveryProbe)) return;
  if (restStatus.recoveryProbeRequired && !quoteRecoveryProbe) return;
  if (Date.now() - lastRestQuoteRecoveryAt < 30000) return;
  lastRestQuoteRecoveryAt = Date.now();
  // After a persisted quote-path block expires, probe only the original endpoint
  // with the three required indexes; never fan out the whole stale F&O window.
  const quoteProbeSymbols=mcxFutureRoot(selectedSymbol)?[selectedSymbol]:BASE_SUBSCRIPTIONS;
  const unique = [...new Set(quoteRecoveryProbe ? quoteProbeSymbols : staleSymbols)].filter(Boolean);
  let accepted = 0, rejected = 0;
  for (let i = 0; i < unique.length; i += 50) {
    const currentRestStatus = fetchWithFyersBudget.getStatus();
    if (currentRestStatus.cooldownActive &&
        !(currentRestStatus.recoveryProbeRequired && currentRestStatus.recoveryProbePathname === '/data/quotes')) break;
    const batch = unique.slice(i, i + 50);
    try {
      const url = FYERS_DATA + '/quotes?symbols=' + encodeURIComponent(batch.join(','));
      const response = await fyersRestFetch(url, {
        headers: { Authorization: appId + ':' + accessToken, Accept: 'application/json' },
        timeoutMs: 12000
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.s !== 'ok') {
        console.warn('FYERS REST quote recovery did not return a valid response.', JSON.stringify({
          status: response.status, retryAfterSeconds: Number(payload.retryAfterSeconds) || null,
          requested: batch.length, message: String(payload.message || 'quote response rejected').slice(0, 120)
        }));
        if (response.status === 429) break;
        continue;
      }
      const ticks = parseFyersQuoteTicks(payload, batch, Date.now());
      let monotonicRejected = 0;
      for (const tick of ticks) {
        const decision = acceptExchangeTick(lastTicks.get(tick.symbol), tick);
        if (!decision.accepted) { monotonicRejected++; continue; }
        lastTicks.set(tick.symbol, tick);
        if (tick.symbol.startsWith('MCX:')) mcxTicks.set(tick.symbol, tick);
        else if (tick.symbol.startsWith('NSE:') || tick.symbol.startsWith('BSE:')) nseTicks.set(tick.symbol, tick);
        accepted++;
      }
      rejected += batch.length - ticks.length + monotonicRejected;
    } catch (error) {
      console.warn('FYERS REST quote recovery failed safely.', String(error?.message || error).slice(0, 160));
      if (fetchWithFyersBudget.getStatus().cooldownActive) break;
    }
  }
  if (accepted) lastAcceptedTickAt = new Date().toISOString();
  console.info('FYERS REST quote recovery completed.', JSON.stringify({
    requested: unique.length, acceptedFreshExchangeTicks: accepted, rejectedOrStale: rejected,
    at: new Date().toISOString(), cooldownActive: fetchWithFyersBudget.getStatus().cooldownActive
  }));
}
async function recoverFyersRestEndpoint(pathname){
  if(!authReady()||!fyersRestBudgetReady||!pathname||restRecoveryProbeInFlight||Date.now()-lastRestRecoveryProbeAt<30000)return;
  if(pathname==='/data/quotes'){
    lastRestRecoveryProbeAt=Date.now();
    await recoverStaleSubscriptionsViaQuotes(BASE_SUBSCRIPTIONS);
    return;
  }
  let url='';
  const now=Math.floor(Date.now()/1000);
  if(pathname==='/data/history'){
    const probeSymbol=mcxFutureRoot(selectedSymbol)?selectedSymbol:'NSE:NIFTY50-INDEX';
    const params=new URLSearchParams({symbol:probeSymbol,resolution:'5',date_format:'0',range_from:String(now-2*86400),range_to:String(now-300),cont_flag:'1'});
    url=FYERS_DATA+'/history?'+params.toString();
  }else if(pathname==='/data/options-chain-v3'){
    const params=new URLSearchParams({symbol:'NSE:NIFTY50-INDEX',strikecount:'1',greeks:'0'});
    url=FYERS_DATA+'/options-chain-v3?'+params.toString();
  }else if(pathname==='/api/v3/screeners/config'){
    url=FYERS_API+'/screeners/config';
  }else if(pathname==='/api/v3/screeners/standard'){
    const status=fetchWithFyersBudget.getStatus();
    if(status.recoveryProbeUrl)url=status.recoveryProbeUrl;
  }else if(pathname==='/api/v3/positions'){
    url=FYERS_API+'/positions';
  }else{
    console.warn('FYERS REST recovery endpoint has no safe automatic probe; circuit remains closed.',JSON.stringify({pathname,at:new Date().toISOString()}));
    return;
  }
  if(!url){
    console.warn('FYERS REST recovery URL was not safely persisted; circuit remains closed.',JSON.stringify({pathname,at:new Date().toISOString()}));
    return;
  }
  restRecoveryProbeInFlight=true;
  lastRestRecoveryProbeAt=Date.now();
  try{
    const response=await fyersRestFetch(url,{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:12000});
    const payload=await response.clone().json().catch(()=>null);
    const valid=pathname==='/data/history'
      ? Boolean(payload?.s==='ok'&&Array.isArray(payload.candles)&&payload.candles.length)
      : pathname==='/data/options-chain-v3'
        ? Boolean(payload?.s==='ok'&&Array.isArray(payload?.data?.optionsChain)&&payload.data.optionsChain.length)
        : Boolean(payload?.s==='ok');
    console.info('FYERS endpoint recovery probe completed.',JSON.stringify({pathname,httpStatus:response.status,validProviderPayload:valid,circuit:fetchWithFyersBudget.getStatus().cooldownActive?'CLOSED':'OPEN',at:new Date().toISOString()}));
  }catch(error){
    console.warn('FYERS endpoint recovery probe failed safely.',JSON.stringify({pathname,message:String(error?.message||error).slice(0,140)}));
  }finally{restRecoveryProbeInFlight=false;}
}
const socketFeedWatchdog=setInterval(()=>{
  if(!authReady())return;
  // FYERS REST recovery is exchange-session independent: MCX can be active while NSE is closed.
  const restStatus=fetchWithFyersBudget.getStatus();
  if(restStatus.recoveryProbeRequired){
    void recoverFyersRestEndpoint(restStatus.recoveryProbePathname);
  }
  if(socket&&!connected&&lastSocketConnectAttemptAt&&Date.now()-Date.parse(lastSocketConnectAttemptAt)>30000){
    scheduleSocketRecovery('socket_connect_timeout');
    return;
  }
  if(mcxFutureRoot(selectedSymbol)){
    if(!isMcxScheduledSession()){lastMcxSubscriptionRecoveryAt=0;return;}
    if(freshTick(lastTicks.get(selectedSymbol),10000)){lastMcxSubscriptionRecoveryAt=0;return;}
    if(socket&&connected&&Date.now()-lastMcxSubscriptionRecoveryAt>=30000){
      lastMcxSubscriptionRecoveryAt=Date.now();
      const result=syncSocketSubscriptions({force:true,reason:'mcx_fresh_tick_watchdog'});
      console.warn('MCX selected-future tick heartbeat missed; reapplying only the selected MCX WebSocket subscription.',JSON.stringify({selectedSymbol,subscriptionError:result.error||null,recoveryAt:new Date().toISOString()}));
    }
    return;
  }
  if(!isNseRegularSession())return;
  const monitored=[...new Set([...BASE_SUBSCRIPTIONS,...fnoScanSubscriptionSymbols,...strategyOptionSymbols,...(selectedOptionSymbol?[selectedOptionSymbol]:[])])];
  const staleSymbols=monitored.filter(symbol=>!freshTick(lastTicks.get(symbol),10000));
  const freshIndexes=BASE_SUBSCRIPTIONS.filter(symbol=>freshTick(lastTicks.get(symbol),10000));
  if(socket&&connected){
    if(freshIndexes.length<BASE_SUBSCRIPTIONS.length){
      if(!indexFeedStaleSince)indexFeedStaleSince=Date.now();
      if(shouldRestartSilentIndexFeed({marketOpen:true,socketConnected:true,freshIndexCount:freshIndexes.length,requiredIndexCount:BASE_SUBSCRIPTIONS.length,staleSince:indexFeedStaleSince,now:Date.now()})){
        const previous=socket;
        socket=null;
        connected=false;
        subscribedSymbols.clear();
        if(subscriptionTransitionTimer){clearTimeout(subscriptionTransitionTimer);subscriptionTransitionTimer=null;}
        try{if(previous&&typeof previous.close==='function')previous.close();}catch{}
        console.warn('FYERS connected socket had no fresh index heartbeat; supervised socket restart requested.',JSON.stringify({freshIndexCount:freshIndexes.length,requiredIndexCount:BASE_SUBSCRIPTIONS.length,staleDurationMs:Date.now()-indexFeedStaleSince,at:new Date().toISOString()}));
        scheduleSocketRecovery('silent_index_feed');
        return;
      }
      if(Date.now()-lastSubscriptionRecoveryAt>=30000){
        lastSubscriptionRecoveryAt=Date.now();
        console.warn('FYERS index tick heartbeat missed; reapplying subscriptions before socket restart threshold.',JSON.stringify({freshIndexCount:freshIndexes.length,requiredIndexCount:BASE_SUBSCRIPTIONS.length,recoveryAt:new Date().toISOString()}));
        syncSocketSubscriptions({force:true,reason:'fresh_tick_watchdog'});
      }
    }else indexFeedStaleSince=0;
    // Never fan out REST quote recovery while the WebSocket transport is connected.
    return;
  }
  if(!staleSymbols.length||Date.now()-lastSubscriptionRecoveryAt<30000)return;
  lastSubscriptionRecoveryAt=Date.now();
  // Disconnected fallback is deliberately narrow: indexes plus the selected chart
  // instrument only. The old 50-symbol batches caused Cloudflare 1015 rate limits.
  const recoverySymbols=[...new Set([...BASE_SUBSCRIPTIONS,...(selectedSymbol?[selectedSymbol]:[])])]
    .filter(symbol=>staleSymbols.includes(symbol)).slice(0,4);
  if(recoverySymbols.length)void recoverStaleSubscriptionsViaQuotes(recoverySymbols);
},5000);
socketFeedWatchdog.unref?.();
const automaticStrategyScanTimer=setInterval(()=>{void runAutomaticStrategyScan();},STRATEGY_SCAN_INTERVAL_MS);
automaticStrategyScanTimer.unref?.();
let lastNseSubscriptionSessionActive=isNseSubscriptionSession();
const nseSubscriptionSessionMonitor=setInterval(()=>{
  const sessionActive=isNseSubscriptionSession();
  if(sessionActive===lastNseSubscriptionSessionActive)return;
  lastNseSubscriptionSessionActive=sessionActive;
  if(mcxFutureRoot(selectedSymbol))return;
  if(!socket||!connected){
    console.info('NSE session transition detected while FYERS socket is disconnected; reconnect handler will apply the current session.',JSON.stringify({sessionActive,phase:getNseMarketSession().phase}));
    return;
  }
  if(!sessionActive){
    const result=syncSocketSubscriptions({reason:'nse_session_closed'});
    console.info('NSE session closed; NSE subscriptions released without REST requests.',JSON.stringify({phase:getNseMarketSession().phase,removed:result.removed,error:result.error||null}));
    return;
  }
  console.info('NSE pre-open/regular session opened on an existing FYERS socket; restoring subscriptions.',JSON.stringify({phase:getNseMarketSession().phase}));
  syncSocketSubscriptions({reason:'nse_session_open'});
  void refreshFnoUniverse().then(()=>rotateFnoUniverseSubscriptions('nse_session_open_universe_loaded')).catch(error=>console.warn('NSE session-open F&O universe refresh failed; scanner remains fail-closed.',String(error?.message||error).slice(0,180)));
},5000);
nseSubscriptionSessionMonitor.unref?.();
const fnoUniverseRotationTimer=setInterval(()=>{
  if(!socket||!connected||!isNseRegularSession()||!fnoUniverseRows.length)return;
  rotateFnoUniverseSubscriptions('scheduled_rotation');
},FNO_ROTATION_INTERVAL_MS);
fnoUniverseRotationTimer.unref?.();
function startUpErrorSafe(value){return String(value||'').slice(0,180);}
app.get('/api/health',async(_req,res)=>{
  const now=Date.now();
  const indexFeed=summarizeFeedFreshness(BASE_SUBSCRIPTIONS,lastTicks,now);
  const fnoFeed=summarizeFeedFreshness(fnoScanSubscriptionSymbols,lastTicks,now);
  const fnoUniverseCoverage=summarizeFnoCoverage(fnoUniverseRows.map(row=>row.futureSymbol),fnoScanSubscriptionSymbols,fnoUniverseRows.filter(row=>freshTick(lastTicks.get(row.futureSymbol))).map(row=>row.futureSymbol));
  const strategyLedgerReady=strategyPlanStore?await strategyPlanStore.ready:false;
  const latestExchangeTime=[...lastTicks.values()].reduce((latest,tick)=>Math.max(latest,Number(tick.exchangeTime)||0),0);
  const mcxRequiredSymbols=[...new Set([...(mcxFutureRoot(selectedSymbol)?[selectedSymbol]:[]),...mcxOptionCandidateSymbols])];
  const mcxFeed=summarizeFeedFreshness(mcxRequiredSymbols,lastTicks,now);
  const selectedMcxFuture=mcxFutureRoot(selectedSymbol)?selectedSymbol:null;
  const selectedMcxFutureFreshness=exchangeTickFreshness(selectedMcxFuture?lastTicks.get(selectedMcxFuture):null,now);
  const mcxFeedDetails=mcxRequiredSymbols.map(symbol=>{const tick=lastTicks.get(symbol);const freshness=exchangeTickFreshness(tick,now);const gaps=mcxTickGapSamples.get(symbol)?.samples||[];return{symbol,status:freshness.status,subscribed:subscribedSymbols.has(symbol),exchangeTimestamp:tick?.exchangeTime?new Date(tick.exchangeTime*1000).toISOString():null,receiveGapSampleCount:gaps.length,avgReceiveGapSeconds:gaps.length?Number((gaps.reduce((a,b)=>a+b,0)/gaps.length/1000).toFixed(2)):null,maxReceiveGapSeconds:gaps.length?Number((Math.max(...gaps)/1000).toFixed(2)):null};});
  res.set('Cache-Control','no-store').json({ok:true,selectedSymbol:selectedSymbol||null,startupState,startupError:startUpErrorSafe(startupError),restBudgetReady:fyersRestBudgetReady,sharedSessionRestored,authenticated:authReady(),socketConnected:connected,websocketState:connected?'CONNECTED':socket?'CONNECTING_OR_RECOVERING':'DISCONNECTED',socketConnectCount,lastSocketConnectAt,lastSocketConnectAttemptAt,lastSocketRecoveryAt,socketRecoveryAttempts,socketRecoveryPending:Boolean(socketRecoveryTimer),indexFeedStaleSince:indexFeedStaleSince?new Date(indexFeedStaleSince).toISOString():null,lastFreshIndexTickAt,lastSocketMessageAt,lastAcceptedTickAt,lastSocketError:lastSocketError||null,freshIndexTickCount:indexFeed.freshCount,requiredIndexTickCount:BASE_SUBSCRIPTIONS.length,indexFeed,latestExchangeTimestamp:latestExchangeTime?new Date(latestExchangeTime*1000).toISOString():null,marketData:indexFeed.freshCount===BASE_SUBSCRIPTIONS.length?'FRESH_EXCHANGE_TICKS':'WAITING_FOR_FRESH_EXCHANGE_TICKS',mcxFeed:{state:!selectedMcxFuture?'NOT_SELECTED':selectedMcxFutureFreshness.status==='FRESH'?'FUTURE_FRESH':selectedMcxFutureFreshness.status==='STALE'?'FUTURE_STALE':selectedMcxFutureFreshness.status==='MISSING'?'WAITING_FOR_FUTURE_TICK':'INVALID_FUTURE_TICK',selectedFuture:selectedMcxFuture,selectedFutureStatus:selectedMcxFutureFreshness.status,selectedFutureSubscribed:selectedMcxFuture?subscribedSymbols.has(selectedMcxFuture):false,requiredCount:mcxFeed.requiredCount,freshCount:mcxFeed.freshCount,staleCount:mcxFeed.staleCount,missingCount:mcxFeed.missingCount,coveragePercent:mcxFeed.coveragePercent,symbols:mcxFeedDetails},fnoScanner:{universeCount:fnoUniverseRows.length,activeFutureSubscriptions:fnoScanSubscriptionSymbols.length,requestedFutureSubscriptions:fnoScanSubscriptionSymbols.length,symbolLimit:FYERS_DATA_SYMBOL_LIMIT,rotationCursor:fnoUniverseCursor,universeUpdatedAt:fnoUniverseFetchedAt?new Date(fnoUniverseFetchedAt).toISOString():null,freshActiveFutureTicks:fnoFeed.freshCount,staleActiveFutureTicks:fnoFeed.staleCount,missingActiveFutureTicks:fnoFeed.missingCount,activeWindowFreshnessPercent:fnoFeed.coveragePercent,windowCoveragePercent:fnoUniverseCoverage.requestedCoveragePercent,freshUniverseCoveragePercent:fnoUniverseCoverage.freshUniverseCoveragePercent,notRequestedFutureCount:fnoUniverseCoverage.notRequestedCount,freshUniverseFutureCount:fnoUniverseCoverage.freshUniverseCount,coverage:fnoUniverseCoverage,lastRotationAt:lastFnoRotationAt,rotationCount:fnoRotationCount,feed:fnoFeed,error:fnoUniverseError||null},strategyPlanLedger:{configured:Boolean(strategyPlanStore),ready:strategyLedgerReady,entryGate:'READ_ONLY_PLAN_ONLY'},strategyScanner:strategyScanSnapshot(),fyersRestCooldown:(()=>{const status=fetchWithFyersBudget.getStatus();return{active:status.cooldownActive,reason:status.cooldownReason||null,retryAfterSeconds:status.retryAfterSeconds,blockedUntil:status.blockedUntil,recoveryProbeRequired:status.recoveryProbeRequired,recoveryProbePathname:status.recoveryProbePathname||null,blockedPathname:status.blockedPathname||null,recoveryProbeUrlAvailable:Boolean(status.recoveryProbeUrl),recoveryProbeInFlight:restRecoveryProbeInFlight,lastRecoveryProbeAt:lastRestRecoveryProbeAt?new Date(lastRestRecoveryProbeAt).toISOString():null,consecutive429:status.consecutiveCloudflareBlocks+status.consecutiveRateLimitBlocks,persistenceReady:fyersRestBudgetReady,persistenceHealthy:status.cooldownPersistenceHealthy,queuedRequests:status.queuedRequests};})(),orderMode:'DISABLED'});
});
app.get('/api/strategy-scan',async(_req,res)=>{res.set('Cache-Control','no-store');if(!authReady())return res.status(401).json({error:'FYERS session unavailable',...strategyScanSnapshot()});await refreshStrategyActivePlans();res.json(strategyScanSnapshot());});
app.get('/api/market',async(_req,res)=>{res.set('Cache-Control','no-store');if(!authReady())return res.json({connected:false,quotes:[],nse:[],mcx:[],gainers:[],error:'FYERS session unavailable'});const movers=await loadFnoMovers();const gainers=movers.rows.map(row=>{const tick=lastTicks.get(row.symbol),tickFresh=freshTick(tick);return{symbol:row.symbol,underlying:row.underlyingSymbol,price:tickFresh?tick.price:row.price,change:tickFresh?(tick.price/row.basePrice-1)*100:row.change,exchangeTime:tickFresh?tick.exchangeTime:movers.updatedAt/1000,fresh:tickFresh,source:row.source};}).sort((a,b)=>b.change-a.change).slice(0,5);res.json({connected,quotes:[...lastTicks.values()],nse:[...nseTicks.values()],mcx:[...mcxTicks.values()],gainers,gainersUpdatedAt:movers.updatedAt,error:movers.error});});
app.post('/api/select-symbol',async(req,res)=>{
  const symbol=String(req.body?.symbol||'').trim().toUpperCase();
  if(!/^(NSE|BSE):[A-Z0-9&_.-]{2,48}(?:-(EQ|INDEX)|[0-9]{2}[A-Z0-9]+FUT)$/.test(symbol)&&!/^MCX:[A-Z0-9&_.-]{3,48}$/.test(symbol))return res.status(400).json({error:'Invalid FYERS NSE/BSE cash-index or MCX contract symbol'});
  const previousSymbol=selectedSymbol;
  try{
    await persistSelectedMcxInstrument(symbol);
  }catch(error){
    return res.status(503).json({error:String(error?.message||error).slice(0,180),selectedSymbol:previousSymbol||null});
  }
  const instrumentChanged=symbol!==selectedSymbol;
  selectedSymbol=symbol;
  if(instrumentChanged){selectedOptionSymbol='';mcxOptionCandidateSymbols=[];}
  const subscription=syncSocketSubscriptions();
  if(subscription.error)return res.status(503).json({error:subscription.error,selectedSymbol});
  console.info('GV2VPD chart instrument selected and MCX mode persisted.',JSON.stringify({selectedSymbol,marketMode:mcxFutureRoot(selectedSymbol)?'MCX_ONLY':'NSE_FNO',persisted:mcxFutureRoot(selectedSymbol),at:new Date().toISOString()}));
  res.json({selectedSymbol,exchange:symbol.split(':')[0],historyFetch:'on-demand-only',marketMode:mcxFutureRoot(selectedSymbol)?'MCX_ONLY':'NSE_FNO'});
});
const historyCache=new Map();
const gainerHistoryCache=new Map();
const gainerHistoryRetry=new Map();
const gainerHistoryFailures=new Map();
app.get('/api/history',async(req,res)=>{
  const symbol=String(req.query.symbol||'');
  if(symbol!==selectedSymbol)return res.status(409).json({error:'Select symbol before requesting history'});
  if(!authReady())return res.status(401).json({error:'Connect FYERS first'});
  const cachedHistory=historyCache.get(symbol);
  if(cachedHistory&&isHistoryCacheFresh(cachedHistory.fetchedAt))return res.json({...cachedHistory,cached:true});
  try{
    const now=Math.floor(Date.now()/1000),to=now-300,from=to-5*24*60*60;
    const params=new URLSearchParams({symbol,resolution:'5',date_format:'0',range_from:String(from),range_to:String(to),cont_flag:'1'});
    const response=await fyersRestFetch('https://api-t1.fyers.in/data/history?'+params.toString(),{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:15000,priority:95});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||payload.s!=='ok'||!Array.isArray(payload.candles))return res.status(response.ok?502:(response.status||502)).json({error:'FYERS did not return verified completed 5-minute candles',detail:String(payload.message||payload.code||'Invalid candle payload'),retryAfterMs:Number(payload.retryAfterSeconds)*1000||fyersRetryAfterMs(response)});
    const candles=payload.candles.filter(c=>Array.isArray(c)&&c.length>=5&&c.slice(0,5).every(v=>Number.isFinite(Number(v)))&&Number(c[2])>=Math.max(Number(c[1]),Number(c[4]))&&Number(c[3])<=Math.min(Number(c[1]),Number(c[4]))&&Number(c[3])>0).map(c=>({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]||0)}));
    if(!candles.length)return res.status(502).json({error:'No valid completed 5-minute candles received',retryAfterMs:30000});
    const result={symbol,resolution:'5',candles,source:'FYERS Data API',fetchedAt:new Date().toISOString()};
    historyCache.set(symbol,result);res.set('Cache-Control','no-store').json(result);
  }catch(e){res.status(Number(e?.statusCode)||502).json({error:'FYERS history request failed',detail:String(e?.message||e).slice(0,180),retryAfterMs:Number(e?.retryAfterMs)||0});}
});


// MCX option discovery uses the official MCX_COM Symbol Master, not the NSE/BSE option-chain endpoint.
// Candidate contracts are subscribed first; a setup is published only after both futures and option candles/ticks pass freshness checks.
async function loadMxcHistory(symbol){
  const cached=mcxOptionHistoryCache.get(symbol);
  if(cached&&isHistoryCacheFresh(cached.fetchedAt))return cached;
  const now=Math.floor(Date.now()/1000),to=now-300,from=to-5*24*60*60;
  const params=new URLSearchParams({symbol,resolution:'5',date_format:'0',range_from:String(from),range_to:String(to),cont_flag:'1'});
  const response=await fyersRestFetch('https://api-t1.fyers.in/data/history?'+params.toString(),{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:15000,priority:85});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok||payload.s!=='ok'||!Array.isArray(payload.candles))throw Object.assign(new Error(String(payload.message||payload.code||'FYERS MCX option history unavailable')),{statusCode:response.status||502});
  const candles=payload.candles.filter(c=>Array.isArray(c)&&c.length>=5&&c.slice(0,5).every(v=>Number.isFinite(Number(v)))&&Number(c[2])>=Math.max(Number(c[1]),Number(c[4]))&&Number(c[3])<=Math.min(Number(c[1]),Number(c[4]))&&Number(c[3])>0).map(c=>({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]||0)}));
  if(!candles.length)throw new Error('FYERS returned no valid completed MCX 5-minute candles');
  const result={symbol,candles,fetchedAt:Date.now(),source:'FYERS Data API MCX history'};
  mcxOptionHistoryCache.set(symbol,result);
  return result;
}
app.get('/api/mcx/contracts',async(req,res)=>{
  const product=String(req.query.product||'').trim().toUpperCase();
  if(!['CRUDEOIL','NATURALGAS'].includes(product))return res.status(400).json({error:'Choose Crude Oil or Natural Gas'});
  try{
    const master=await loadMcxComMaster();
    const now=Date.now();
    const pattern=new RegExp('^MCX:'+product+'[0-9]{2}[A-Z]{3}FUT');
    const contracts=Object.entries(master).filter(([symbol,row])=>pattern.test(symbol)&&symbol.length===('MCX:'+product).length+8&&symbol.endsWith('FUT')&&row&&Number(row.tradeStatus)===1)
      .map(([symbol,row])=>({symbol,expiry:toEpochSeconds(row.expiryDate)}))
      .filter(row=>row.expiry&&row.expiry*1000>now)
      .sort((a,b)=>a.expiry-b.expiry||a.symbol.localeCompare(b.symbol))
      .map(row=>({symbol:row.symbol,expiryDate:new Date(row.expiry*1000).toISOString().slice(0,10)}));
    if(!contracts.length)return res.status(404).json({error:'No active '+product+' futures contract found in the official FYERS MCX Symbol Master'});
    res.set('Cache-Control','no-store').json({product,contracts:contracts.slice(0,12),source:'Official FYERS MCX Symbol Master'});
  }catch(error){
    res.status(502).json({error:'Could not load verified FYERS MCX futures contracts',detail:String(error?.message||error).slice(0,160)});
  }
});
app.get('/api/mcx/scan',async(req,res)=>{
  const future=String(req.query.symbol||'').trim().toUpperCase();
  if(!mcxFutureRoot(future))return res.status(400).json({status:'NO_TRADE',reason:'Only exact MCX Crude Oil or Natural Gas FUT contracts are supported'});
  if(future!==selectedSymbol)return res.status(409).json({status:'NO_TRADE',reason:'Select this exact MCX futures contract in the chart first'});
  if(!authReady())return res.status(401).json({status:'DATA_UNAVAILABLE_NO_TRADE',reason:'FYERS session unavailable'});
  if(mcxScanPromise){if(mcxScanSymbol!==future)return res.status(409).json({status:'WAITING_FOR_OPTION_TICKS',reason:'Previous MCX contract scan is finishing; retry shortly'});try{return res.json(await mcxScanPromise)}catch(error){return res.status(502).json({status:'DATA_UNAVAILABLE_NO_TRADE',reason:String(error?.message||error).slice(0,180)})}}
  mcxScanSymbol=future;
  mcxScanPromise=(async()=>{
    const futureTick=lastTicks.get(future);
    if(!freshTick(futureTick))return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Fresh MCX futures exchange tick is required',feedState:subscribedSymbols.has(future)?'SUBSCRIBED_WAITING_FOR_TICK':'FUTURE_NOT_SUBSCRIBED'};
    const underlyingHistory=historyCache.get(future)&&isHistoryCacheFresh(historyCache.get(future).fetchedAt)?historyCache.get(future):await loadMxcHistory(future);
    const dailyHistory=await loadStrategyDailyHistory(future,{priority:10}).catch(error=>({ok:false,candles:[],reason:String(error?.message||error).slice(0,120)}));
    const dailyCandles=dailyHistory?.ok?dailyHistory.candles:[];
    const now=Date.now();
    const underlyingSetup=detectNineStrategySetup({
      underlyingCandles:underlyingHistory.candles,underlyingTick:futureTick,dailyCandles,isTopGainer:false,now,
      sessionStartMinute:540,sessionCloseMinute:1435
    });
    if(underlyingSetup.status!=='UNDERLYING_SETUP_CONFIRMED')return{...underlyingSetup,source:'FYERS MCX futures tick + completed 5-minute candles',dailyHistoryStatus:dailyHistory?.ok?'VERIFIED':'UNAVAILABLE'};
    const master=await loadMcxComMaster();
    if(selectedSymbol!==future)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX instrument changed during scan; stale result discarded'};
    const futureMeta=master?.[future];
    if(!futureMeta||Number(futureMeta.tradeStatus)!==1||!toEpochSeconds(futureMeta.expiryDate)||toEpochSeconds(futureMeta.expiryDate)*1000<=Date.now())
      return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Exact MCX futures contract/expiry is not active in the official FYERS Symbol Master'};
    const contracts=listMxcOptionContracts(master,future);
    const candidates=pickMxcOptionCandidates(contracts,futureTick.price,underlyingSetup.side,3).map(contract=>({...contract,underlyingPrice:futureTick.price}));
    if(!candidates.length)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'No active FYERS MCX option contracts for the nearest expiry'};
    if(selectedSymbol!==future)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX instrument changed during scan; stale candidates discarded'};
    mcxOptionChains.set(future,{contracts:candidates,fetchedAt:Date.now()});
    mcxOptionCandidateSymbols=candidates.map(contract=>contract.symbol);
    const subscription=syncSocketSubscriptions({reason:'mcx_option_candidate_scan'});
    if(subscription.error)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:subscription.error};
    const freshCandidates=candidates.filter(contract=>freshTick(lastTicks.get(contract.symbol)));
    if(freshCandidates.length!==candidates.length)return{status:'WAITING_FOR_OPTION_TICKS',reason:'Fresh option exchange ticks '+freshCandidates.length+'/'+candidates.length+'; waiting to compare every nearest-strike candidate',side:underlyingSetup.side,strategy:underlyingSetup.strategy,candidates:candidates.map(({symbol,side,strike,expiryDate})=>({symbol,side,strike,expiry:expiryDate,subscribed:subscribedSymbols.has(symbol)}))};
    const valid=[];
    const rejected=[];
    for(const contract of freshCandidates){
      try{
        const history=await loadMxcHistory(contract.symbol);
        if(selectedSymbol!==future)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX instrument changed during option history check'};
        const optionTick=lastTicks.get(contract.symbol);
        if(!freshTick(optionTick)){rejected.push({symbol:contract.symbol,reason:'Option tick became stale during candle verification'});continue;}
        const evaluated=evaluateNineStrategies({
          underlyingCandles:underlyingHistory.candles,underlyingTick:lastTicks.get(future),
          optionCandles:history.candles,optionTick,contract,dailyCandles,isTopGainer:false,now:Date.now(),
          sessionStartMinute:540,sessionCloseMinute:1435
        });
        if(evaluated.status==='SETUP_CONFIRMED')valid.push({...evaluated,contract});
        else rejected.push({symbol:contract.symbol,reason:evaluated.reason||evaluated.status,strategy:evaluated.strategy||underlyingSetup.strategy});
      }catch(error){
        if(Number(error?.statusCode)===429)throw error;
        rejected.push({symbol:contract.symbol,reason:String(error?.message||error).slice(0,120)});
      }
    }
    if(selectedSymbol!==future)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX instrument changed before setup confirmation'};
    if(!freshTick(lastTicks.get(future)))return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX futures tick became stale during option verification'};
    if(!valid.length)return{status:'NO_TRADE',reason:rejected.length?'No candidate passed the nine-strategy underlying confirmation, fresh option-candle confirmation and 1:2 risk/reward checks':'Waiting for verified option history',side:underlyingSetup.side,strategy:underlyingSetup.strategy,rejected};
    valid.sort((a,b)=>b.rr-a.rr||a.contract.strikeDistance-b.contract.strikeDistance);
    const best=valid[0];
    selectedOptionSymbol=best.contract.symbol;
    syncSocketSubscriptions({reason:'mcx_best_option_selected'});
    return{
      status:'SETUP_CONFIRMED',
      label:'MCX · NINE-STRATEGY ENGINE · VERIFIED RULE-MATCH · READ-ONLY',
      underlying:future,
      underlyingSide:underlyingSetup.side,
      contract:{symbol:best.contract.symbol,side:best.contract.side,strike:best.contract.strike,expiry:best.contract.expiryDate,lotSize:best.contract.lotSize,tickSize:best.contract.tickSize},
      premium:lastTicks.get(best.contract.symbol).price,entry:best.entry,stopLoss:best.stopLoss,target:best.target,rr:best.rr,strategy:best.strategy,
      source:'FYERS MCX Symbol Master + fresh futures/option ticks + completed 5-minute candles + nine-strategy engine',
      verifiedAt:new Date().toISOString()
    };
  })();
  try{
    const result=await mcxScanPromise;
    res.set('Cache-Control','no-store').json(result);
  }catch(error){
    res.status(Number(error?.statusCode)===429?429:502).json({status:'DATA_UNAVAILABLE_NO_TRADE',reason:String(error?.message||error).slice(0,180)});
  }finally{mcxScanPromise=null;mcxScanSymbol='';}
});


async function loadStrategyDailyHistory(symbol,{priority=10}={}){
 const cached=strategyDailyHistoryCache.get(symbol);
 if(cached&&Date.now()-cached.cachedAt<6*60*60*1000)return cached;
 const now=Math.floor(Date.now()/1000),params=new URLSearchParams({symbol,resolution:'D',date_format:'0',range_from:String(now-365*86400),range_to:String(now),cont_flag:'1'});
 const response=await fyersRestFetch('https://api-t1.fyers.in/data/history?'+params.toString(),{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:15000,priority});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok||payload.s!=='ok'||!Array.isArray(payload.candles)){const error=new Error('FYERS daily history unavailable');error.statusCode=response.status;throw error;}
 const candles=payload.candles.filter(c=>Array.isArray(c)&&c.length>=5&&c.slice(0,5).every(v=>Number.isFinite(Number(v)))&&Number(c[0])>0&&Number(c[1])>0&&Number(c[2])>=Math.max(Number(c[1]),Number(c[4]),Number(c[3]))&&Number(c[3])<=Math.min(Number(c[1]),Number(c[4]))).map(c=>({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]||0)}));
 const verified=completedDailyCandles(candles,Date.now());
 const result={symbol,candles:verified.candles,ok:verified.ok,reason:verified.reason,cachedAt:Date.now(),source:'FYERS Data API daily candles'};
 strategyDailyHistoryCache.set(symbol,result);return result;
}
async function loadStrategyOptionContracts(underlying){
 const cached=optionChains.get(underlying);
 if(cached&&Date.now()-cached.fetchedAt<300000)return cached.contracts;
 const url=new URL(FYERS_DATA+'/options-chain-v3');url.searchParams.set('symbol',underlying);url.searchParams.set('strikecount','10');url.searchParams.set('greeks','0');
 const response=await fyersGet(url,{priority:80}),data=response.data;
 if(!data||!Array.isArray(data.optionsChain)||!data.optionsChain.length)throw new Error('FYERS option chain is empty');
 const master=underlying.startsWith('BSE:')?await loadBseFoMaster():await loadNseFoMaster();
 const contracts=data.optionsChain.filter(x=>['CE','PE'].includes(String(x.option_type||'').toUpperCase())&&typeof x.symbol==='string').map(x=>{
  const meta=optionMeta(x.symbol,master);
  return meta&&meta.side===String(x.option_type).toUpperCase()?{symbol:x.symbol,side:meta.side,strike:meta.strike,expiry:meta.expiryDate,lotSize:meta.lotSize,tickSize:meta.tickSize}:null;
 }).filter(Boolean);
 if(!contracts.length)throw new Error('No active option contracts matched the official FYERS Symbol Master');
 optionChains.set(underlying,{underlying,contracts,expiries:data.expiryData||[],fetchedAt:Date.now(),source:'FYERS option chain + official Symbol Master'});
 return contracts;
}
function setStrategyScanResult(item){
 const key=item.underlying||item.futureSymbol||'scanner';
 strategyScanLastResults=[item,...strategyScanLastResults.filter(x=>(x.underlying||x.futureSymbol)!==key)].sort((a,b)=>Number(b.status==='PLAN_CONFIRMED_READ_ONLY')-Number(a.status==='PLAN_CONFIRMED_READ_ONLY')||Number(b.rr||0)-Number(a.rr||0)||String(b.verifiedAt||b.updatedAt||'').localeCompare(String(a.verifiedAt||a.updatedAt||''))).slice(0,3);
}
async function refreshStrategyActivePlans(force=false){
 if(!strategyPlanStore){strategyLedgerRuntimeReady=false;return{ok:false,plans:[]};}
 if(!force&&Date.now()-strategyActivePlansLoadedAt<10000)return{ok:true,plans:strategyActivePlans};
 const result=await strategyPlanStore.listActivePlans();
 strategyLedgerRuntimeReady=Boolean(result.ok);
 if(!result.ok)return result;
 const reconciled=[];
 for(const plan of (result.plans||[])){
  const lifecycle=evaluateActivePlanLifecycle(plan,lastTicks.get(plan.contract),Date.now());
  if(['EXPIRED','STOP_LOSS_HIT','TARGET_HIT'].includes(lifecycle.status)){
   const closed=await strategyPlanStore.closePlan(plan.plan_id||plan.planId,'CLOSED');
   if(closed.ok){
    const status='PLAN_CLOSED_'+lifecycle.status;
    console.info('GV2VPD strategy plan lifecycle closed.',JSON.stringify({planId:plan.plan_id||plan.planId,underlying:plan.underlying,contract:plan.contract,status,reason:lifecycle.reason,price:lifecycle.price||null}));
    setStrategyScanResult({underlying:plan.underlying,futureSymbol:plan.underlying,status,reason:lifecycle.reason,contract:plan.contract,updatedAt:new Date().toISOString()});
    continue;
   }
   reconciled.push({...plan,lifecycleState:'CLOSE_PENDING',lifecycleReason:closed.reason||'Persistent close transition failed; plan remains active'});
   continue;
  }
  reconciled.push({...plan,lifecycleState:lifecycle.status,lifecycleReason:lifecycle.reason});
 }
 strategyActivePlans=reconciled;strategyActivePlansLoadedAt=Date.now();
 const restored=new Set(strategyActivePlans.map(x=>x.contract).filter(Boolean));
 const pendingSymbols=new Set([...strategyPendingCandidates.values()].map(x=>x.contract.symbol));
 for(const symbol of [...strategyOptionSymbols])if(!pendingSymbols.has(symbol)&&!restored.has(symbol))strategyOptionSymbols.delete(symbol);
 for(const plan of strategyActivePlans)if(plan.contract)strategyOptionSymbols.add(plan.contract);
 return result;
}
async function processPendingStrategyCandidate(candidate){
 const optionTick=lastTicks.get(candidate.contract.symbol),underlyingTick=lastTicks.get(candidate.futureSymbol);
 if(!freshTick(optionTick)||!freshTick(underlyingTick))return false;
 try{
  const officialMaster=candidate.underlyingSymbol.startsWith('BSE:')?await loadBseFoMaster():await loadNseFoMaster();
  const officialContract=optionMeta(candidate.contract.symbol,officialMaster);
  const identity=validateOptionContractIdentity(candidate.contract,officialContract,Date.now());
  if(!identity.ok){
   setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:'NO_TRADE',reason:identity.reason,strategy:candidate.setup.strategy});
   strategyPendingCandidates.delete(candidate.key);strategyOptionSymbols.delete(candidate.contract.symbol);syncSocketSubscriptions({reason:'strategy_contract_rejected'});return true;
  }
  const [underlyingHistory,optionHistory]=await Promise.all([
   loadGainerHistory(candidate.futureSymbol,{priority:75}),
   loadGainerHistory(candidate.contract.symbol,{priority:75})
  ]);
  const currentOptionTick=lastTicks.get(candidate.contract.symbol),currentUnderlyingTick=lastTicks.get(candidate.futureSymbol);
  if(!freshTick(currentOptionTick)||!freshTick(currentUnderlyingTick))return false;
  if(underlyingHistory.symbol!==candidate.futureSymbol||optionHistory.symbol!==candidate.contract.symbol){
   setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:'DATA_UNAVAILABLE_NO_TRADE',reason:'FYERS history response symbol identity does not match the requested underlying/option contract',strategy:candidate.setup.strategy});
   strategyPendingCandidates.delete(candidate.key);strategyOptionSymbols.delete(candidate.contract.symbol);syncSocketSubscriptions({reason:'strategy_history_identity_failed'});return true;
  }
  const premiumCheck=validateOptionPremiumTick(currentOptionTick,candidate.contract,Date.now());
  if(!premiumCheck.ok){
   setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:'DATA_UNAVAILABLE_NO_TRADE',reason:premiumCheck.reason,strategy:candidate.setup.strategy});
   strategyPendingCandidates.delete(candidate.key);strategyOptionSymbols.delete(candidate.contract.symbol);syncSocketSubscriptions({reason:'strategy_option_tick_rejected'});return true;
  }
  const candleCheck=validateOptionCandles(optionHistory.candles,currentOptionTick,candidate.contract,Date.now());
  if(!candleCheck.ok){
   setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:'DATA_UNAVAILABLE_NO_TRADE',reason:candleCheck.reason,strategy:candidate.setup.strategy});
   strategyPendingCandidates.delete(candidate.key);strategyOptionSymbols.delete(candidate.contract.symbol);syncSocketSubscriptions({reason:'strategy_option_candles_rejected'});return true;
  }
  const refreshedSetup=detectNineStrategySetup({underlyingCandles:underlyingHistory.candles,underlyingTick:currentUnderlyingTick,dailyCandles:candidate.dailyCandles,isTopGainer:candidate.isTopGainer,now:Date.now()});
  if(refreshedSetup.status!=='UNDERLYING_SETUP_CONFIRMED'||!sameStrategyConfirmation(candidate.setup,refreshedSetup)){
   setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:'NO_TRADE',reason:'Underlying strategy confirmation changed or expired while waiting for the option tick',strategy:candidate.setup.strategy});
   strategyPendingCandidates.delete(candidate.key);strategyOptionSymbols.delete(candidate.contract.symbol);syncSocketSubscriptions({reason:'strategy_underlying_recheck_failed'});return true;
  }
  const evaluated=evaluateNineStrategies({underlyingCandles:underlyingHistory.candles,underlyingTick:currentUnderlyingTick,optionCandles:optionHistory.candles,optionTick:currentOptionTick,contract:candidate.contract,dailyCandles:candidate.dailyCandles,isTopGainer:candidate.isTopGainer,now:Date.now()});
  if(evaluated.status!=='SETUP_CONFIRMED'){
   setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:evaluated.status,reason:evaluated.reason||'Option premium confirmation did not pass',strategy:candidate.setup.strategy,updatedAt:new Date().toISOString()});
   strategyPendingCandidates.delete(candidate.key);strategyOptionSymbols.delete(candidate.contract.symbol);syncSocketSubscriptions({reason:'strategy_candidate_rejected'});return true;
  }
  const finalOptionTick=lastTicks.get(candidate.contract.symbol),finalUnderlyingTick=lastTicks.get(candidate.futureSymbol);
  const finalIdentity=validateOptionContractIdentity(candidate.contract,officialContract,Date.now());
  const finalPremiumCheck=validateOptionPremiumTick(finalOptionTick,candidate.contract,Date.now());
  if(!finalIdentity.ok||!freshTick(finalUnderlyingTick)||!finalPremiumCheck.ok){
   const reason=!finalIdentity.ok?finalIdentity.reason:!freshTick(finalUnderlyingTick)?'Underlying exchange tick became stale before plan persistence':finalPremiumCheck.reason;
   setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:'DATA_UNAVAILABLE_NO_TRADE',reason,strategy:candidate.setup.strategy});
   strategyPendingCandidates.delete(candidate.key);strategyOptionSymbols.delete(candidate.contract.symbol);syncSocketSubscriptions({reason:'strategy_final_tick_recheck_failed'});return true;
  }
  const planId=crypto.createHash('sha256').update([candidate.underlyingSymbol,candidate.contract.symbol,candidate.setup.confirmedAt,evaluated.optionCandleTime].join('|')).digest('hex').slice(0,48);
  const saved=await strategyPlanStore.saveConfirmedPlan({planId,strategy:evaluated.strategy,underlying:candidate.underlyingSymbol,contract:candidate.contract.symbol,optionSide:candidate.contract.side,expiry:candidate.contract.expiry,strike:candidate.contract.strike,premium:finalOptionTick.price,tickSize:candidate.contract.tickSize,entry:evaluated.entry,stopLoss:evaluated.stopLoss,target:evaluated.target,rr:evaluated.rr,underlyingExchangeTime:finalUnderlyingTick.exchangeTime,optionExchangeTime:finalOptionTick.exchangeTime,underlyingReceivedAt:finalUnderlyingTick.receivedAt,optionReceivedAt:finalOptionTick.receivedAt,underlyingCandleTime:String(evaluated.confirmedAt),optionCandleTime:String(evaluated.optionCandleTime)});
  if(saved.ok){
   await refreshStrategyActivePlans(true);
   setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:'PLAN_CONFIRMED_READ_ONLY',strategy:evaluated.strategy,optionSide:candidate.contract.side,contract:candidate.contract.symbol,expiry:candidate.contract.expiry,strike:candidate.contract.strike,premium:finalOptionTick.price,entry:saved.entry,stopLoss:saved.stopLoss,target:saved.target,rr:saved.rr,planId:saved.planId,verifiedAt:new Date().toISOString()});
  }else setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:saved.status||'NO_TRADE',reason:saved.reason,strategy:evaluated.strategy});
  strategyPendingCandidates.delete(candidate.key);if(!strategyActivePlans.some(plan=>plan.contract===candidate.contract.symbol))strategyOptionSymbols.delete(candidate.contract.symbol);syncSocketSubscriptions({reason:'strategy_candidate_processed'});return true;
 }catch(error){
  if(Number(error?.statusCode)===429){strategyScanLastError='FYERS REST cooldown; scanner paused without another upstream request';return false;}
  setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:'DATA_UNAVAILABLE_NO_TRADE',reason:String(error?.message||error).slice(0,160),strategy:candidate.setup.strategy});
  strategyPendingCandidates.delete(candidate.key);strategyOptionSymbols.delete(candidate.contract.symbol);syncSocketSubscriptions({reason:'strategy_candidate_error'});return true;
 }
}
async function runAutomaticStrategyScan(){
 if(strategyScanBusy||!authReady()||!connected||!isNseRegularSession())return;
 strategyScanBusy=true;
 try{
  await refreshStrategyActivePlans();
  const restStatus=fetchWithFyersBudget.getStatus();
  if(!fyersRestBudgetReady||restStatus.cooldownActive){
   strategyScanLastError=restStatus.cooldownActive?'FYERS REST cooldown active; scanner paused locally without queuing more history requests':'FYERS REST budget is not ready; scanner paused fail-closed';
   return;
  }
  let expired=false;
  for(const candidate of strategyPendingCandidates.values()){
   if(Date.now()-candidate.createdAt>120000){strategyPendingCandidates.delete(candidate.key);strategyOptionSymbols.delete(candidate.contract.symbol);setStrategyScanResult({underlying:candidate.underlyingSymbol,futureSymbol:candidate.futureSymbol,status:'NO_TRADE',reason:'Option tick did not become fresh within 120 seconds',strategy:candidate.setup.strategy});expired=true;continue;}
   if(freshTick(lastTicks.get(candidate.contract.symbol))){await processPendingStrategyCandidate(candidate);return;}
  }
  if(expired)syncSocketSubscriptions({reason:'strategy_candidate_timeout'});
  const symbols=fnoScanSubscriptionSymbols.slice();if(!symbols.length)return;
  if(strategyActivePlans.length+strategyPendingCandidates.size>=2)return;
  for(let attempt=0;attempt<symbols.length;attempt++){
   const index=strategyScanCursor%symbols.length;strategyScanCursor=(index+1)%symbols.length;
   const futureSymbol=symbols[index],row=fnoUniverseRows.find(x=>x.futureSymbol===futureSymbol);if(!row)continue;
   if(Date.now()-(strategyScanLastAttempt.get(futureSymbol)||0)<45000)continue;
   const futureTick=lastTicks.get(futureSymbol);if(!freshTick(futureTick))continue;
   strategyScanLastAttempt.set(futureSymbol,Date.now());strategyScanLastAt=new Date().toISOString();strategyScanLastSymbol=futureSymbol;
   const [history,daily]=await Promise.all([loadGainerHistory(futureSymbol,{priority:10}),loadStrategyDailyHistory(futureSymbol,{priority:10}).catch(error=>({ok:false,candles:[],reason:String(error?.message||error).slice(0,120)}))]);
   const currentTick=lastTicks.get(futureSymbol);
   if(!freshTick(currentTick)){setStrategyScanResult({underlying:row.underlyingSymbol,futureSymbol,status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Futures tick became stale during candle verification'});return;}
   strategyScanLastError='';
   const isTopGainer=fnoMoversCache.updatedAt>0&&Date.now()-fnoMoversCache.updatedAt<60*1000&&fnoMoversCache.rows.some(mover=>mover.underlyingSymbol===row.underlyingSymbol);
   const setup=detectNineStrategySetup({underlyingCandles:history.candles,underlyingTick:currentTick,dailyCandles:daily.ok?daily.candles:[],isTopGainer,now:Date.now()});
   if(setup.status!=='UNDERLYING_SETUP_CONFIRMED'){
    if(setup.status==='DATA_UNAVAILABLE_NO_TRADE')setStrategyScanResult({underlying:row.underlyingSymbol,futureSymbol,status:setup.status,reason:setup.reason,dailyDataStatus:daily.reason||'verified'});
    return;
   }
   if(strategyActivePlans.length+strategyPendingCandidates.size>=2){setStrategyScanResult({underlying:row.underlyingSymbol,futureSymbol,status:'NO_TRADE',reason:'Maximum of two active or pending strategy plans reached',strategy:setup.strategy});return;}
   const contracts=await loadStrategyOptionContracts(row.underlyingSymbol);
   const optionSide=setup.side==='LONG'?'CE':'PE';
   const contract=selectNearestOptionContract(contracts,optionSide,currentTick.price,Date.now());
   if(!contract){setStrategyScanResult({underlying:row.underlyingSymbol,futureSymbol,status:'DATA_UNAVAILABLE_NO_TRADE',reason:'No active nearest-expiry ATM option contract passed FYERS Symbol Master validation',strategy:setup.strategy});return;}
   const key=strategyCandidateKey(row.underlyingSymbol,contract.symbol);
   if(strategyPendingCandidates.has(key))return;
   strategyPendingCandidates.set(key,{key,futureSymbol,underlyingSymbol:row.underlyingSymbol,setup,contract,underlyingCandles:history.candles,dailyCandles:daily.ok?daily.candles:[],isTopGainer,createdAt:Date.now()});
   strategyOptionSymbols.add(contract.symbol);syncSocketSubscriptions({reason:'strategy_option_candidate'});
   setStrategyScanResult({underlying:row.underlyingSymbol,futureSymbol,status:'WAITING_FOR_FRESH_OPTION_TICK',strategy:setup.strategy,optionSide,contract:contract.symbol,expiry:contract.expiry,strike:contract.strike,reason:'Underlying setup verified; waiting for fresh option exchange tick and completed option candles'});
   return;
  }
 }catch(error){strategyScanLastError=String(error?.message||error).slice(0,180);if(Number(error?.statusCode)!==429)console.warn('Automatic nine-strategy scan paused safely.',strategyScanLastError);}
 finally{strategyScanBusy=false;}
}
function strategyScanSnapshot(){
 const marketClock=getNseMarketSession();
 const marketSession=marketClock.phase==='REGULAR'?'OPEN':marketClock.phase.startsWith('PRE_OPEN')?'PRE-OPEN':'CLOSED';
 const freshFutureTicks=fnoScanSubscriptionSymbols.filter(symbol=>freshTick(lastTicks.get(symbol))).length;
 const runtime=getScannerRuntimeState({authenticated:authReady(),socketConnected:connected,marketOpen:isNseRegularSession(),ledgerReady:strategyLedgerRuntimeReady,universeCount:fnoUniverseRows.length,activeSubscriptions:fnoScanSubscriptionSymbols.length,freshFutureTicks});
 return{enabled:true,mode:'AUTOMATIC_READ_ONLY',scanIntervalMs:STRATEGY_SCAN_INTERVAL_MS,rotationIntervalMs:FNO_ROTATION_INTERVAL_MS,estimatedScannerHistoryRequestsPerMinute:estimateScannerRestRequestsPerMinute(),runtimeState:runtime.state,blocker:runtime.blocker,marketSession,marketPhase:marketClock.phase,marketPhaseLabel:marketClock.label,lastScanAt:strategyScanLastAt,lastScannedFuture:strategyScanLastSymbol,lastError:strategyScanLastError||null,universeCount:fnoUniverseRows.length,activeFutureSubscriptions:fnoScanSubscriptionSymbols.length,freshActiveFutureTicks:freshFutureTicks,subscriptionLimit:FYERS_DATA_SYMBOL_LIMIT,coverage:'ROTATING_FYERS_STANDARD_WINDOW',pendingOptionChecks:strategyPendingCandidates.size,activePlans:strategyActivePlans,topSetups:strategyScanLastResults.slice(0,3),orderMode:'DISABLED'};
}

async function loadGainerHistory(symbol,{force=false,priority=20}={}){
 const nowMs=Date.now(),cached=gainerHistoryCache.get(symbol);
 if(!force&&cached&&nowMs-cached.cachedAt<300000)return cached;
 const retry=gainerHistoryRetry.get(symbol);
 if(!force&&retry&&!shouldAttemptHistoryRetry(retry.retryAt,nowMs)){
  const error=new Error(retry.reason+'; symbol history retry deferred');
  error.statusCode=retry.statusCode||503;error.retryAfterMs=retry.retryAt-nowMs;throw error;
 }
 const now=Math.floor(nowMs/1000),to=now-300,from=to-5*24*60*60;
 const params=new URLSearchParams({symbol,resolution:'5',date_format:'0',range_from:String(from),range_to:String(to),cont_flag:'1'});
 let response,payload;
 try{
  response=await fyersRestFetch('https://api-t1.fyers.in/data/history?'+params.toString(),{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:15000,priority});
  payload=await response.json().catch(()=>({}));
  if(!response.ok||payload.s!=='ok'||!Array.isArray(payload.candles)){
   const error=new Error('FYERS 5-minute history unavailable ('+(response.status||'invalid payload')+'): '+String(payload.message||payload.code||'invalid candle response').slice(0,120));
   error.statusCode=response.status||502;error.retryAfterMs=Number(payload.retryAfterSeconds)*1000||fyersRetryAfterMs(response);throw error;
  }
  const candles=payload.candles.filter(c=>Array.isArray(c)&&c.length>=5&&c.slice(0,5).every(v=>Number.isFinite(Number(v)))&&Number(c[2])>=Math.max(Number(c[1]),Number(c[4]))&&Number(c[3])<=Math.min(Number(c[1]),Number(c[4]))&&Number(c[3])>0).map(c=>({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]||0)}));
  if(!candles.length)throw Object.assign(new Error('FYERS returned no valid 5-minute OHLC rows'),{statusCode:502});
  const result={symbol,candles,source:'FYERS Data API',cachedAt:Date.now(),fetchedAt:new Date().toISOString()};
  gainerHistoryCache.set(symbol,result);gainerHistoryRetry.delete(symbol);gainerHistoryFailures.delete(symbol);return result;
 }catch(error){
  const attempts=(gainerHistoryFailures.get(symbol)||0)+1;gainerHistoryFailures.set(symbol,attempts);
  const delay=historyRetryDelayMs({statusCode:error.statusCode,retryAfterMs:error.retryAfterMs,attempt:attempts});
  gainerHistoryRetry.set(symbol,{retryAt:Date.now()+delay,statusCode:error.statusCode||502,reason:String(error.message||error).slice(0,160)});
  throw error;
 }
}
function evaluateGainerBreakout(candles,tick){
 if(!freshTick(tick))return{status:'WAITING_FOR_FRESH_TICK',reason:'Underlying exchange tick is not fresh'};
 const {completed,fresh,contiguous}=getCompletedCandleWindow(candles,tick.exchangeTime,600,3);
 if(!fresh)return{status:'STALE_CANDLES',reason:'Latest completed 5-minute candle is stale'};
 if(completed.length<3)return{status:'WAITING_FOR_THREE_COMPLETED_CANDLES',reason:'Need reference, breakout and one completed confirmation candle'};
 if(!contiguous)return{status:'INCOMPLETE_CANDLE_WINDOW',reason:'Latest three breakout confirmation candles contain a missing 5-minute interval'};
 const plan=evaluateThreeCandleBreakout(completed,tick.price);
 return plan.status==='SETUP_CONFIRMED'?{...plan,underlyingPrice:Number(tick.price)}:{status:plan.status==='NO_TRADE'?'NO_TRADE':'WAIT',reason:plan.reason};
}
app.get('/api/gainer-scan',async(_req,res)=>{
 res.set('Cache-Control','no-store');if(!authReady())return res.status(401).json({error:'FYERS session unavailable',results:[]});
 const movers=await loadFnoMovers();
 if(!isNseRegularSession())return res.json({results:movers.rows.map(row=>({symbol:row.symbol,underlying:row.underlyingSymbol,status:'MARKET_CLOSED',reason:'Live breakout scan is disabled outside NSE regular session'})),source:'FYERS only'});
 const results=[];
 for(const row of movers.rows){
  const tick=lastTicks.get(row.underlyingSymbol);
  if(!freshTick(tick)){results.push({symbol:row.symbol,underlying:row.underlyingSymbol,status:'WAITING_FOR_FRESH_TICK',reason:'Waiting for fresh cash-equity exchange tick'});continue;}
  try{const history=await loadGainerHistory(row.underlyingSymbol),setup=evaluateGainerBreakout(history.candles,tick);results.push({symbol:row.symbol,underlying:row.underlyingSymbol,price:tick.price,exchangeTime:tick.exchangeTime,candleTime:setup.candleTime||null,...setup});}
  catch(error){results.push({symbol:row.symbol,underlying:row.underlyingSymbol,status:'DATA_UNAVAILABLE_NO_TRADE',reason:String(error?.message||error).slice(0,150)});if(Number(error?.statusCode)===429){for(const skipped of movers.rows.slice(results.length))results.push({symbol:skipped.symbol,underlying:skipped.underlyingSymbol,status:'DATA_UNAVAILABLE_NO_TRADE',reason:'FYERS REST cooldown; no further upstream request was sent'});break;}}
 }
 console.info('FYERS top-five breakout scan completed.',JSON.stringify({count:results.length,setups:results.filter(x=>x.status==='SETUP_CONFIRMED').length,waiting:results.filter(x=>x.status!=='SETUP_CONFIRMED').length}));
 res.json({results,source:'FYERS exchange ticks + FYERS 5-minute OHLC',scannedAt:new Date().toISOString()});
});

app.get('/api/options',async(req,res)=>{const underlying=String(req.query.symbol||'');if(!/^(NSE|BSE):[A-Z0-9&.-]+-EQ$/.test(underlying)&&!['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'].includes(underlying))return res.status(400).json({error:'Select a valid NSE/BSE underlying'});if(!authReady())return res.status(401).json({error:'FYERS session unavailable'});const cached=optionChains.get(underlying);if(cached&&Date.now()-cached.fetchedAt<300000)return res.json(cached);try{const url=new URL(FYERS_DATA+'/options-chain-v3');url.searchParams.set('symbol',underlying);url.searchParams.set('strikecount','10');url.searchParams.set('greeks','0');const response=await fyersGet(url);const data=response.data;if(!data||!Array.isArray(data.optionsChain)||!data.optionsChain.length)throw new Error('FYERS option chain is empty');const master=underlying.startsWith('BSE:')?await loadBseFoMaster():await loadNseFoMaster();const contracts=data.optionsChain.filter(x=>['CE','PE'].includes(String(x.option_type||'').toUpperCase())&&typeof x.symbol==='string').map(x=>{const meta=optionMeta(x.symbol,master);return meta?{symbol:x.symbol,side:meta.side,strike:meta.strike,expiry:meta.expiryDate,lotSize:meta.lotSize,tickSize:meta.tickSize}:null;}).filter(Boolean);if(!contracts.length){const chainSymbols=data.optionsChain.slice(0,4).map(x=>String(x.symbol||'')).filter(Boolean);throw new Error('No active option contracts matched the FYERS Symbol Master; chainRows='+data.optionsChain.length+', masterRows='+Object.keys(master).length+', sample='+chainSymbols.join(','));}const result={underlying,contracts,expiries:data.expiryData||[],fetchedAt:Date.now(),source:'FYERS option chain + official NSE F&O Symbol Master'};optionChains.set(underlying,result);console.info('FYERS option-chain contracts verified.',JSON.stringify({underlying,contractCount:contracts.length,expiryCount:(data.expiryData||[]).length,fetchedAt:new Date(result.fetchedAt).toISOString(),cache:'MISS'}));res.json(result);}catch(e){console.error('FYERS option-chain refresh failed.',JSON.stringify({underlying,statusCode:e?.statusCode||null,retryAfterMs:e?.retryAfterMs||0,message:String(e.message||e).slice(0,180)}));res.status(e?.statusCode===429?429:502).json({error:'Option contract discovery failed closed',detail:String(e.message||e).slice(0,180),retryAfterMs:e?.retryAfterMs||0});}});
app.post('/api/select-option',(req,res)=>{const symbol=String(req.body?.symbol||'');const validNse=[...optionChains.values()].some(chain=>Date.now()-chain.fetchedAt<300000&&chain.contracts.some(c=>c.symbol===symbol));const validMcx=[...mcxOptionChains.values()].some(chain=>Date.now()-chain.fetchedAt<300000&&chain.contracts.some(c=>c.symbol===symbol));if(!validNse&&!validMcx)return res.status(400).json({error:'Option is not in a recently verified FYERS option source'});selectedOptionSymbol=symbol;syncSocketSubscriptions();const tick=lastTicks.get(symbol),tickFresh=freshTick(tick);console.info('FYERS option contract selected.',JSON.stringify({symbol,websocketConnected:connected,tickStatus:tickFresh?'FRESH':tick?'STALE':'WAITING_FOR_TICK',exchangeTimestamp:tick?.exchangeTime?new Date(tick.exchangeTime*1000).toISOString():null}));res.json({selectedSymbol:symbol,subscribed:Boolean(socket&&connected),premiumStatus:tickFresh?'FRESH':tick?'STALE':'WAITING_FOR_TICK'});});
app.get('/api/account',async(req,res)=>{
  res.set('Cache-Control','no-store');
  const forceRefresh=String(req.query.refresh||'')==='1';
  if(!authReady())return res.status(401).json({error:'FYERS session unavailable'});
  const now=Date.now();
  if(!forceRefresh&&accountSnapshot&&now-accountSnapshotFetchedAt<60000)return res.json({...accountSnapshot,cached:true});
  if(accountFetchPromise){try{return res.json(await accountFetchPromise);}catch(e){return res.status(502).json({error:'FYERS account reconciliation unavailable',detail:String(e.message||e).slice(0,160)});}}
  if(now<accountRetryAfter){
    if(accountSnapshot)return res.json({...accountSnapshot,cached:true,stale:true,error:'FYERS account API rate limit; showing last verified account snapshot',retryAfterMs:Math.max(0,accountRetryAfter-now)});
    return res.status(429).json({error:'FYERS account API rate limit; retry deferred',retryAfterMs:accountRetryAfter-now});
  }
  accountFetchPromise=(async()=>{
    try{
      const [positions,orders]=await Promise.all([fyersGet(FYERS_API+'/positions'),fyersGet(FYERS_API+'/orders')]);
      accountSnapshot={positions:positions.netPositions||[],overall:positions.overall||{},orders:orders.orderBook||orders.orderbook||[],updatedAt:new Date().toISOString(),source:'FYERS authenticated account APIs'};
      accountSnapshotFetchedAt=Date.now();
      accountFailureCount=0;
      accountRetryAfter=0;
      console.info('FYERS broker snapshot refreshed.',JSON.stringify({positionsCount:accountSnapshot.positions.length,ordersCount:accountSnapshot.orders.length,updatedAt:accountSnapshot.updatedAt,cacheTtlMs:60000}));
      return accountSnapshot;
    }catch(e){
      const message=String(e.message||e).slice(0,160);
      console.error('FYERS broker snapshot refresh failed.',JSON.stringify({statusCode:e?.statusCode||null,retryAfterMs:e?.retryAfterMs||0,hasLastVerifiedSnapshot:Boolean(accountSnapshot),message}));
      if(/HTTP 429/i.test(message)){
        accountFailureCount=Math.min(accountFailureCount+1,5);
        accountRetryAfter=Date.now()+Math.max(Number(e?.retryAfterMs)||0,Math.min(300000,30000*Math.pow(2,accountFailureCount-1)));
      }else{
        accountRetryAfter=Date.now()+10000;
      }
      if(accountSnapshot)return {...accountSnapshot,cached:true,stale:true,error:'FYERS account refresh deferred: '+message};
      throw e;
    }finally{accountFetchPromise=null;}
  })();
  try{return res.json(await accountFetchPromise);}
  catch(e){const message=String(e.message||e).slice(0,160);return res.status(/HTTP 429/i.test(message)?429:502).json({error:'FYERS account reconciliation unavailable',detail:message,retryAfterMs:Math.max(0,accountRetryAfter-Date.now())});}
});


app.post('/api/order',async(req,res)=>{
  if(process.env.LIVE_ORDERS_ENABLED!=='true'||!/200$/.test(appId)||process.env.FYERS_STATIC_IP_CONFIRMED!=='true'||!Number.isFinite(Number(process.env.MAX_ORDER_RISK_INR))||Number(process.env.MAX_ORDER_RISK_INR)<=0)
    return res.status(423).json({error:'Live orders require explicit enablement, Trading App ID, static-IP allowlisting and a positive MAX_ORDER_RISK_INR limit'});
  if(!authReady()||!connected)return res.status(503).json({error:'FYERS authenticated socket is not connected'});
  if(!orderRequestPool||!await orderRequestStoreReady)return res.status(503).json({error:'Durable order idempotency store unavailable; order blocked'});
  const {symbol,side,qty,productType,stopLoss,takeProfit,confirm,requestId}=req.body||{};
  if(confirm!==true||typeof requestId!=='string'||!/^[a-f0-9-]{24,40}$/i.test(requestId))
    return res.status(400).json({error:'Explicit confirmation and unique requestId required'});
  let chain=null,meta=null,isMcx=false,mcxFuture='';
  if(String(symbol||'').startsWith('MCX:')){
    isMcx=true;
    const match=String(symbol).match(/^MCX:(CRUDEOIL|NATURALGAS)([0-9]{2}[A-Z]{3})[0-9]+(?:[.][0-9]+)?(CE|PE)$/);
    if(!match)return res.status(400).json({error:'MCX contract symbol is malformed; order blocked'});
    mcxFuture='MCX:'+match[1]+match[2]+'FUT';
    chain=mcxOptionChains.get(mcxFuture);
    if(mcxFuture!==selectedSymbol||!chain||Date.now()-chain.fetchedAt>=60000||!chain.contracts.some(c=>c.symbol===symbol))
      return res.status(400).json({error:'Exact MCX futures/option contract is not present in the fresh selected-contract scan'});
    const master=await loadMcxComMaster().catch(()=>null);
    meta=master?listMxcOptionContracts(master,mcxFuture).find(c=>c.symbol===symbol):null;
  }else{
    chain=[...optionChains.values()].find(x=>Date.now()-x.fetchedAt<60000&&x.contracts.some(c=>c.symbol===symbol));
    if(!chain)return res.status(400).json({error:'Contract identity/expiry is not verified by a fresh option chain'});
    const master=await (symbol.startsWith('BSE:')?loadBseFoMaster():loadNseFoMaster()).catch(()=>null);
    meta=optionMeta(symbol,master);
  }
  if(!meta)return res.status(400).json({error:'Official contract lot/tick metadata is unavailable'});
  const quantity=Number(qty),sl=Number(stopLoss),tp=Number(takeProfit),maxQty=Number(process.env.MAX_ORDER_QTY||meta.lotSize*5),maxRisk=Number(process.env.MAX_ORDER_RISK_INR);
  if(!Number.isInteger(maxQty)||maxQty<meta.lotSize||!Number.isInteger(quantity)||quantity<meta.lotSize||quantity%meta.lotSize!==0||quantity>maxQty)
    return res.status(400).json({error:'Quantity must be a valid lot multiple within configured maximum'});
  if(!['BUY','SELL'].includes(side)||!['INTRADAY','MARGIN'].includes(productType)||(isMcx&&(side!=='BUY'||productType!=='MARGIN'))||!Number.isFinite(sl)||!Number.isFinite(tp)||sl<=0||tp<=0||Math.abs(sl/meta.tickSize-Math.round(sl/meta.tickSize))>1e-7||Math.abs(tp/meta.tickSize-Math.round(tp/meta.tickSize))>1e-7)
    return res.status(400).json({error:'Side/product/MCX buy-only policy or stop-loss/target tick-size validation failed'});
  const tick=lastTicks.get(symbol);
  if(!freshTick(tick))return res.status(409).json({error:'Option premium is stale or missing; order blocked'});
  const {validateRiskReward}=await import('./order-safety.js');
  const rr=validateRiskReward({side,premium:Number(tick.price),stopLoss:sl,takeProfit:tp});
  if(!rr.ok)return res.status(400).json({error:rr.reason||'Minimum reward-to-risk ratio 1:2 is required',riskReward:rr.rr??null});
  const riskInr=rr.risk*quantity;
  if(!Number.isFinite(riskInr)||riskInr<=0||riskInr>maxRisk)return res.status(400).json({error:'Estimated stop-loss risk exceeds the configured per-order INR risk limit'});
  // FYERS margin preflight is mandatory for every live order, including MCX commodity options.
  let marginCheck;
  try{
    const margin=await fyersPost(FYERS_API+'/multiorder/margin',{data:[{symbol,qty:quantity,side:side==='BUY'?1:-1,type:2,productType,limitPrice:0,stopPrice:0,stopLoss:sl,takeProfit:tp}]});
    const checked=parseFyersMarginPreflight(margin);
    if(!checked.ok){
      const insufficient=checked.reason==='Insufficient FYERS available margin';
      return res.status(insufficient?409:503).json({error:checked.reason+'; order blocked',requiredMargin:checked.required??null,availableMargin:checked.available??null});
    }
    marginCheck={required:checked.required,available:checked.available};
  }catch(error){
    return res.status(503).json({error:'FYERS margin preflight unavailable; live order blocked',detail:String(error?.message||error).slice(0,140)});
  }
  const body={symbol,qty:quantity,type:2,side:side==='BUY'?1:-1,productType,limitPrice:0,stopPrice:0,validity:'DAY',stopLoss:sl,takeProfit:tp,disclosedQty:0,offlineOrder:false,isSliceOrder:false,orderTag:'GV2VPDWS'};
  const requestHash=crypto.createHash('sha256').update(JSON.stringify({symbol,side,qty:quantity,productType,stopLoss:sl,takeProfit:tp})).digest('hex');
  try{
    await orderRequestPool.query('INSERT INTO gv2vpd_order_requests (request_id,request_hash,status) VALUES ($1,$2,$3)',[requestId,requestHash,'SUBMITTING']);
  }catch(error){
    if(error?.code==='23505')return res.status(409).json({error:'Request ID already exists in durable order history; check FYERS orderbook. Duplicate submission blocked.'});
    console.error('Durable order request reservation failed.',String(error?.message||error).slice(0,160));
    return res.status(503).json({error:'Could not reserve durable order request ID; order blocked'});
  }
  const finalTick=lastTicks.get(symbol);
  if(!freshTick(finalTick)){
    await orderRequestPool.query("UPDATE gv2vpd_order_requests SET status='BLOCKED_STALE_PREMIUM',updated_at=NOW() WHERE request_id=$1",[requestId]).catch(()=>{});
    return res.status(409).json({error:'Option premium became stale during validation; order blocked'});
  }
  const finalRr=validateRiskReward({side,premium:Number(finalTick.price),stopLoss:sl,takeProfit:tp});
  if(!finalRr.ok||finalRr.risk*quantity>maxRisk){
    await orderRequestPool.query("UPDATE gv2vpd_order_requests SET status='BLOCKED_PRICE_MOVED',updated_at=NOW() WHERE request_id=$1",[requestId]).catch(()=>{});
    return res.status(409).json({error:'Live premium moved; 1:2 reward/risk or risk-cap check no longer passes. Order blocked'});
  }
  try{
    const result=await fyersPost(FYERS_API+'/orders/sync',body);
    const orderId=result.id||null;
    let orderState={status:'ACK_UNVERIFIED',filledQty:null,remainingQty:null};
    let rejectionReason='';
    if(orderId){
      try{
        const book=await fyersGet(FYERS_API+'/orders?id='+encodeURIComponent(orderId));
        const rows=book.orderBook||book.orderbook||book.orders||[];
        const found=Array.isArray(rows)?rows.find(row=>String(row.id||row.orderNum||'')===String(orderId)):null;
        if(found){
          orderState=classifyFyersOrder(found);
          rejectionReason=String(found.message||found.rejectionReason||'').slice(0,240);
        }
      }catch(reconcileError){
        console.error('FYERS orderbook reconciliation deferred.',JSON.stringify({orderId,message:String(reconcileError?.message||reconcileError).slice(0,140)}));
      }
    }
    const stateMessage=orderState.status==='PARTIAL_FILL'
      ? 'Partial fill detected; remaining quantity requires immediate manual reconciliation. No automatic retry.'
      : orderState.status==='ACK_UNVERIFIED'
        ? 'Order acknowledgement received but execution state is not verified. Check FYERS orderbook; do not retry.'
        : 'FYERS orderbook state: '+orderState.status;
    await orderRequestPool.query("UPDATE gv2vpd_order_requests SET status=$2,broker_order_id=$3,response_message=$4,updated_at=NOW() WHERE request_id=$1",[requestId,orderState.status,orderId,(String(result.message||'FYERS accepted order request')+' · '+stateMessage+' · margin='+marginCheck.required+'/'+marginCheck.available).slice(0,500)]);
    const executionConfirmed=orderState.status==='FILLED';
    const requiresManualReconciliation=['PARTIAL_FILL','PENDING','TRANSIT','ACK_UNVERIFIED'].includes(orderState.status);
    return res.status(202).json({accepted:true,submissionAccepted:true,executionConfirmed,requiresManualReconciliation,orderId,message:result.message||'FYERS accepted order request',status:orderState.status,filledQty:orderState.filledQty,remainingQty:orderState.remainingQty,rejectionReason,margin:marginCheck,source:'FYERS sync order API + margin preflight + orderbook status'});
  }catch(error){
    await orderRequestPool.query("UPDATE gv2vpd_order_requests SET status='UNCERTAIN_NO_RETRY',response_message=$2,updated_at=NOW() WHERE request_id=$1",[requestId,String(error?.message||error).slice(0,500)]).catch(dbError=>console.error('Could not persist uncertain order result.',String(dbError?.message||dbError).slice(0,120)));
    return res.status(502).json({error:'FYERS order result uncertain/failed; durable request lock retained. Do not retry. Check broker orderbook.',detail:String(error?.message||error).slice(0,160)});
  }
});
function createFyersAuthorizationUrl(){
  if(!appId||!appSecret||!redirectUri||!tokenReader){const error=new Error('FYERS reconnect is not configured on this workstation.');error.status=503;error.detail={hasAppId:Boolean(appId),hasAppSecret:Boolean(appSecret),hasRedirect:Boolean(redirectUri),secureTokenStore:Boolean(tokenReader)};throw error;}
  const external=String(process.env.RENDER_EXTERNAL_URL||'').replace(/\/$/,'');
  const expectedCallback=external+'/api/fyers/auth/callback';
  if(!external||redirectUri!==expectedCallback){const error=new Error('FYERS callback URL is not configured for this GV2VPD workstation.');error.status=503;error.detail='Set FYERS_REDIRECT_URI to '+expectedCallback+' and register the exact same URL in the FYERS Developer App.';throw error;}
  const now=Date.now();for(const [key,value] of pendingAuthStates){if(now-value.createdAt>AUTH_STATE_TTL_MS)pendingAuthStates.delete(key);}
  const state=crypto.randomBytes(24).toString('hex');pendingAuthStates.set(state,{createdAt:now});
  const url=new URL('https://api-t1.fyers.in/api/v3/generate-authcode');url.searchParams.set('client_id',appId);url.searchParams.set('redirect_uri',redirectUri);url.searchParams.set('response_type','code');url.searchParams.set('state',state);
  return url.toString();
}
app.get('/api/fyers/auth/redirect',(req,res)=>{
  try{res.set('Cache-Control','no-store').redirect(302,createFyersAuthorizationUrl());}
  catch(error){res.status(error.status||503).json({error:error.message,detail:error.detail||null});}
});
app.get('/api/fyers/auth/start',(req,res)=>{
  try{res.set('Cache-Control','no-store').json({authorizationUrl:createFyersAuthorizationUrl()});}
  catch(error){res.status(error.status||503).json({error:error.message,detail:error.detail||null});}
});

app.get('/api/fyers/auth/callback',async(req,res)=>{
  const code=typeof req.query.auth_code==='string'?req.query.auth_code.trim():'';const state=typeof req.query.state==='string'?req.query.state.trim():'';const pending=pendingAuthStates.get(state);
  if(!code||code.length>4096||!state||!pending||Date.now()-pending.createdAt>AUTH_STATE_TTL_MS){if(state)pendingAuthStates.delete(state);return res.status(400).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>GV2VPD FYERS login</title><h2>FYERS login could not be verified</h2><p>The authorization code or one-time state is missing or expired. Return to GV2VPD and tap Connect / Reconnect FYERS again.</p><a href="/">Return to GV2VPD</a>');}
  pendingAuthStates.delete(state);
  if(!appId||!appSecret||!redirectUri||!tokenReader)return res.status(503).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>GV2VPD FYERS login</title><h2>Secure FYERS storage is unavailable</h2><p>Connection was not activated. Check the existing workstation configuration.</p><a href="/">Return to GV2VPD</a>');
  try{
    const appIdHash=crypto.createHash('sha256').update(appId+':'+appSecret).digest('hex');
    const response=await fyersRestFetch('https://api-t1.fyers.in/api/v3/validate-authcode',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({grant_type:'authorization_code',appIdHash,code}),timeoutMs:12000});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.s!=='ok'||typeof data.access_token!=='string'||!data.access_token){console.warn('FYERS OAuth validation rejected.',JSON.stringify({httpStatus:response.status,providerMessage:String(data.message||data.error||'').slice(0,140)}));return res.status(401).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>GV2VPD FYERS login</title><h2>FYERS authentication failed</h2><p>FYERS did not accept the authorization code. Return to GV2VPD and reconnect.</p><a href="/">Return to GV2VPD</a>');}
    const authenticatedAt=new Date().toISOString();
    try{await tokenReader.save(data.access_token,authenticatedAt);}catch(error){console.error('FYERS token issued but encrypted persistence failed; session not activated.',String(error?.message||error).slice(0,160));return res.status(503).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>GV2VPD FYERS login</title><h2>Secure save failed</h2><p>FYERS issued a token, but GV2VPD could not securely save it. The session was not activated.</p><a href="/">Return to GV2VPD</a>');}
    try{if(socket&&typeof socket.close==='function')socket.close();}catch{}
    socket=null;connected=false;accessToken=data.access_token;lastTicks.clear();nseTicks.clear();mcxTicks.clear();subscribedSymbols.clear();ensureSocket();
    console.info('FYERS OAuth session securely saved and market socket restart requested.',JSON.stringify({authenticatedAt,tokenPersisted:true}));return res.redirect(303,'/?fyers_connected=1');
  }catch(error){console.error('FYERS OAuth callback failed.',String(error?.message||error).slice(0,160));return res.status(502).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>GV2VPD FYERS login</title><h2>Could not complete FYERS login</h2><p>FYERS authentication service could not be reached. No session was activated.</p><a href="/">Return to GV2VPD</a>');}
});
const server=app.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('GV2VPD Live Workstation listening'));
async function restoreSharedFyersSession(){
  if(!tokenReader){console.warn('Shared encrypted FYERS token reader is not configured; market stream remains disconnected.');return false;}
  try{
    const saved=await tokenReader.read();
    if(!saved){console.warn('No encrypted FYERS session found in shared token store.');return false;}
    accessToken=saved.accessToken;
    console.log('Existing encrypted FYERS session restored read-only; authenticatedAt='+saved.authenticatedAt);
    ensureSocket();sharedSessionRestored=true;return true;
  }catch(error){
    console.error('Could not restore shared FYERS session:',String(error?.message||error).slice(0,160));return false;
  }
}
async function startWorkstation(){
  startupState='STARTING';
  const restReady=await initializeFyersRestBudget();
  await restoreSelectedMcxInstrument();
  const sessionReady=await restoreSharedFyersSession();
  try{
    await refreshStrategyActivePlans(true);
    if(strategyOptionSymbols.size)syncSocketSubscriptions({reason:'strategy_plans_restored'});
  }catch(error){console.warn('Strategy plan restore unavailable; new entries remain blocked.',String(error?.message||error).slice(0,160));}
  startupState=restReady&&sessionReady&&strategyLedgerRuntimeReady?'INITIALIZED':'DEGRADED';
  startupError=[!restReady?'REST_BUDGET_NOT_READY':'',!sessionReady?'FYERS_SESSION_NOT_RESTORED':'',!strategyLedgerRuntimeReady?'STRATEGY_LEDGER_NOT_READY':''].filter(Boolean).join(',');
  console.info('GV2VPD startup readiness resolved.',JSON.stringify({startupState,restBudgetReady:restReady,sharedSessionRestored:sessionReady,authenticated:authReady(),socketConnected:connected,at:new Date().toISOString()}));
}
void startWorkstation();
server.on('error',error=>console.error('Workstation HTTP server error:',error.message));
