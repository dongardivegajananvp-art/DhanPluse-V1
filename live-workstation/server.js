import crypto from 'node:crypto';
import {createSharedTokenReader} from './token-reader.js';
import { getCompletedCandleWindow, isHistoryCacheFresh } from './public/chart-safety.js';
import { mcxFutureRoot, listMxcOptionContracts, pickMxcOptionCandidates, evaluateMxcTrendPullback } from './mcx-options.js';
import { parseFyersMarginPreflight, classifyFyersOrder } from './order-safety.js';
import { buildFnoUniverse, selectSubscriptionBatch } from './fno-universe.js';
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
let socketPayloadDiagnostics=0;
let lastTickDiagnosticAt=new Map();
let lastSubscriptionRecoveryAt=0;
let selectedSymbol='';
let selectedOptionSymbol='';
let lastTicks=new Map();
const nseTicks=new Map(),mcxTicks=new Map();
const usedOrderRequestIds=new Set();
const {Pool}=require('pg');
const databaseUrl=String(process.env.DATABASE_URL||'').trim();
const orderRequestPool=databaseUrl.startsWith('postgres://')||databaseUrl.startsWith('postgresql://')?new Pool({connectionString:databaseUrl,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:10000,application_name:'gv2vpd-order-idempotency'}):null;
const orderRequestStoreReady=orderRequestPool?orderRequestPool.query("CREATE TABLE IF NOT EXISTS gv2vpd_order_requests (request_id VARCHAR(64) PRIMARY KEY, request_hash CHAR(64) NOT NULL, status VARCHAR(32) NOT NULL, broker_order_id VARCHAR(128), response_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())").then(()=>true).catch(error=>{console.error('Order idempotency store unavailable; order route will remain fail-closed.',String(error?.message||error).slice(0,160));return false;}):Promise.resolve(false);

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
const FYERS_DATA_SYMBOL_LIMIT=100;
let fnoUniverseRows=[],fnoUniverseFetchedAt=0,fnoUniversePromise=null,fnoUniverseCursor=0,fnoScanSubscriptionSymbols=[],fnoUniverseError='Not loaded';
const BASE_SUBSCRIPTIONS=['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'];
function syncSocketSubscriptions({force=false,reason='state_change'}={}){
  if(!socket||!connected)return {subscribed:0,removed:0};
  const wanted=new Set([...BASE_SUBSCRIPTIONS,...(selectedSymbol?[selectedSymbol]:[]),...(selectedOptionSymbol?[selectedOptionSymbol]:[]),...mcxOptionCandidateSymbols,...fnoMoversCache.rows.flatMap(x=>[x.symbol,x.underlyingSymbol]).filter(Boolean),...fnoScanSubscriptionSymbols]);
  const add=[...wanted].filter(x=>force||!subscribedSymbols.has(x));
  const remove=[...subscribedSymbols].filter(x=>!wanted.has(x));
  if(remove.length&&typeof socket.unsubscribe==='function'){
    try{socket.unsubscribe(remove);for(const symbol of remove)subscribedSymbols.delete(symbol);}
    catch(e){console.error('FYERS unsubscribe failed',String(e?.message||e).slice(0,160));}
  }
  if(add.length){
    try{
      socket.mode(socket.FullMode);
      socket.subscribe(add);
      for(const symbol of add)subscribedSymbols.add(symbol);
      console.info('FYERS market subscriptions applied.',JSON.stringify({reason,count:add.length,symbols:add}));
    }catch(e){console.error('FYERS subscribe failed.',JSON.stringify({reason,message:String(e?.message||e).slice(0,180),count:add.length}));}
  }
  return {subscribed:add.length,removed:remove.length};
}
const FYERS_DATA='https://api-t1.fyers.in/data';
const FYERS_API='https://api-t1.fyers.in/api/v3';
const freshTick=(tick,maxAgeMs=10000)=>Boolean(tick&&Date.now()-tick.receivedAt>=0&&Date.now()-tick.receivedAt<=maxAgeMs&&Date.now()/1000-Number(tick.exchangeTime)<=10&&Date.now()/1000-Number(tick.exchangeTime)>=-3);
// Serialize FYERS REST reads and open a local circuit breaker after HTTP 429.
// WebSocket market ticks remain independent; no automatic retry is sent into a provider cooldown.
let fyersRestQueue=Promise.resolve();
let fyersRestLastRequestAt=0;
let fyersRestCooldownUntil=0;
let fyersRestCooldownReason='';
let fyersRestCooldownPath='';
let fyersRest429Count=0;
const FYERS_REST_MIN_INTERVAL_MS=1500;
const FYERS_REST_MAX_COOLDOWN_MS=60*60*1000;
function fyersRetryAfterMs(response){const raw=String(response.headers?.get?.('retry-after')||'').trim();if(!raw)return 0;const seconds=Number(raw);if(Number.isFinite(seconds)&&seconds>=0)return seconds*1000;const date=Date.parse(raw);return Number.isFinite(date)?Math.max(0,date-Date.now()):0;}
function fyersCooldownResponse(){const retryAfterMs=Math.max(1,fyersRestCooldownUntil-Date.now()),retryAfterSeconds=Math.max(1,Math.ceil(retryAfterMs/1000));return new Response(JSON.stringify({s:'error',message:'FYERS REST cooldown active; no upstream request was sent.',retryAfterSeconds,cooldownReason:fyersRestCooldownReason}),{status:429,headers:{'content-type':'application/json','retry-after':String(retryAfterSeconds),'x-gv2vpd-fyers-cooldown':'active'}});}
async function fyersRestFetch(url,init={}){
  const target=new URL(url);
  if(target.hostname!=='api-t1.fyers.in')return fetch(url,init);
  const {timeoutMs=12000,signal:callerSignal,...fetchInit}=init;
  const execute=async()=>{
    if(fyersRestCooldownUntil>Date.now())return fyersCooldownResponse();
    const waitMs=Math.max(0,fyersRestLastRequestAt+FYERS_REST_MIN_INTERVAL_MS-Date.now());
    if(waitMs)await new Promise(resolve=>setTimeout(resolve,waitMs));
    if(fyersRestCooldownUntil>Date.now())return fyersCooldownResponse();
    const timeoutSignal=AbortSignal.timeout(Math.max(1,Number(timeoutMs)||12000));
    const signal=callerSignal?AbortSignal.any([callerSignal,timeoutSignal]):timeoutSignal;
    fyersRestLastRequestAt=Date.now();
    const response=await fetch(url,{...fetchInit,signal});
    if(response.status===429){
      const body=await response.clone().text().catch(()=>''),server=String(response.headers?.get?.('server')||''),cfRay=String(response.headers?.get?.('cf-ray')||'');
      const cloudflare=/error\s*1015|cloudflare.{0,120}1015|1015.{0,120}cloudflare/i.test(body)||(/cloudflare/i.test(server)&&Boolean(cfRay));
      fyersRest429Count+=1;
      const normalBackoff=[60000,120000,300000][Math.min(fyersRest429Count-1,2)];
      const retryMs=fyersRetryAfterMs(response);
      const backoffMs=cloudflare?FYERS_REST_MAX_COOLDOWN_MS:Math.max(normalBackoff,retryMs);
      fyersRestCooldownUntil=Math.max(fyersRestCooldownUntil,Date.now()+Math.min(FYERS_REST_MAX_COOLDOWN_MS,backoffMs));
      fyersRestCooldownReason=cloudflare?'CLOUDFLARE_1015':'HTTP_429';
      fyersRestCooldownPath=target.pathname;
      console.error('FYERS REST rate limit; circuit opened.',JSON.stringify({path:target.pathname,status:429,reason:fyersRestCooldownReason,consecutive429:fyersRest429Count,retryAfterSeconds:Math.ceil((fyersRestCooldownUntil-Date.now())/1000),upstreamRequestSent:true}));
    }else if(response.ok&&fyersRestCooldownUntil&&Date.now()>=fyersRestCooldownUntil&&target.pathname===fyersRestCooldownPath){
      console.info('FYERS REST cooldown cleared after a successful endpoint probe.',JSON.stringify({path:target.pathname,clearedAt:new Date().toISOString()}));
      fyersRest429Count=0;fyersRestCooldownUntil=0;fyersRestCooldownReason='';fyersRestCooldownPath='';
    }
    return response;
  };
  const pending=fyersRestQueue.then(execute,execute);
  fyersRestQueue=pending.then(()=>undefined,()=>undefined);
  return pending;
}

function toEpochSeconds(value){if(value===null||value===undefined||value==='')return 0;const n=Number(value);if(Number.isFinite(n)&&n>0)return n>1e12?n/1000:n;const parsed=Date.parse(String(value));return Number.isFinite(parsed)&&parsed>0?parsed/1000:0;}
async function fyersGet(url){const r=await fyersRestFetch(url,{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:12000});const raw=await r.text();let j={};try{j=raw?JSON.parse(raw):{};}catch{throw new Error('FYERS returned non-JSON response (HTTP '+r.status+')');}if(!r.ok||j.s==='error'){const error=new Error('FYERS HTTP '+r.status+' · '+String(j.message||j.code||j.data?.error||'request rejected').replace(/\\s+/g,' ').slice(0,180));error.statusCode=r.status;error.retryAfterMs=Number(j.retryAfterSeconds)*1000||fyersRetryAfterMs(r);throw error;}return j;}
async function fyersPost(url,body){const r=await fyersRestFetch(url,{method:'POST',headers:{Authorization:appId+':'+accessToken,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body),timeoutMs:12000});const j=await r.json().catch(()=>({}));if(!r.ok||j.s!=='ok'){const error=new Error(String(j.message||j.code||'FYERS order request failed'));error.statusCode=r.status;error.retryAfterMs=Number(j.retryAfterSeconds)*1000||fyersRetryAfterMs(r);throw error;}return j;}
async function loadNseFoMaster(){if(nseFoMaster&&Date.now()-nseFoMasterFetchedAt<86400000)return nseFoMaster;if(nseFoMasterPromise)return nseFoMasterPromise;nseFoMasterPromise=(async()=>{const r=await fetch('https://public.fyers.in/sym_details/NSE_FO_sym_master.json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('FYERS NSE F&O symbol master unavailable');const master=await r.json();if(!master||typeof master!=='object'||Array.isArray(master))throw new Error('Invalid FYERS symbol master');nseFoMaster=master;nseFoMasterFetchedAt=Date.now();return master;})().finally(()=>{nseFoMasterPromise=null});return nseFoMasterPromise;}
async function loadBseFoMaster(){if(bseFoMaster&&Date.now()-bseFoMasterFetchedAt<86400000)return bseFoMaster;if(bseFoMasterPromise)return bseFoMasterPromise;bseFoMasterPromise=(async()=>{const r=await fetch('https://public.fyers.in/sym_details/BSE_FO_sym_master.json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('FYERS BSE F&O symbol master unavailable');const master=await r.json();if(!master||typeof master!=='object'||Array.isArray(master))throw new Error('Invalid FYERS BSE F&O symbol master');bseFoMaster=master;bseFoMasterFetchedAt=Date.now();return master;})().finally(()=>{bseFoMasterPromise=null});return bseFoMasterPromise;}
async function loadMcxComMaster(){if(mcxComMaster&&Date.now()-mcxComMasterFetchedAt<86400000)return mcxComMaster;if(mcxComMasterPromise)return mcxComMasterPromise;mcxComMasterPromise=(async()=>{const r=await fetch('https://public.fyers.in/sym_details/MCX_COM_sym_master.json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('FYERS MCX commodity Symbol Master unavailable');const master=await r.json();if(!master||typeof master!=='object'||Array.isArray(master))throw new Error('Invalid FYERS MCX commodity Symbol Master');mcxComMaster=master;mcxComMasterFetchedAt=Date.now();return mcxComMaster;})().finally(()=>{mcxComMasterPromise=null});return mcxComMasterPromise;}
function optionMeta(symbol,master){const x=master?.[symbol];if(!x||Number(x.tradeStatus)!==1||!['CE','PE'].includes(String(x.optType||'').toUpperCase()))return null;const lotSize=Number(x.minLotSize),tickSize=Number(x.tickSize),strike=Number(x.strikePrice);if(!Number.isInteger(lotSize)||lotSize<1||!Number.isFinite(tickSize)||tickSize<=0||!Number.isFinite(strike)||strike<=0)return null;return{symbol,side:String(x.optType).toUpperCase(),strike,lotSize,tickSize,expiryDate:String(x.expiryDate||'')};}



async function loadScreenerConfig(){if(screenerConfigCache&&Date.now()-screenerConfigFetchedAt<86400000)return screenerConfigCache;if(screenerConfigPromise)return screenerConfigPromise;screenerConfigPromise=fyersGet(FYERS_API+'/screeners/config').then(x=>{screenerConfigCache=x;screenerConfigFetchedAt=Date.now();return x;}).finally(()=>{screenerConfigPromise=null});return screenerConfigPromise;}
function screenerIds(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:String(item?.id||'')).filter(Boolean):[];}
async function loadFnoMovers(){if(fnoMoversCache.expiresAt>Date.now())return fnoMoversCache;if(fnoMoversPromise)return fnoMoversPromise;fnoMoversPromise=(async()=>{try{const config=await loadScreenerConfig(),data=config.data||{};const screeners=Array.isArray(data.screeners_standard)?data.screeners_standard:[];const candidates=screeners.filter(x=>String(x.category||'').toLowerCase().includes('futures')&&/(gain|gainer)/i.test(String(x.id||'')+' '+String(x.name||'')));const screener=candidates.find(x=>{const allowed=new Set(x.supported_params||[]);const universeIds=screenerIds(data.universe_groups?.[x.universe_group]);const columnIds=screenerIds(data.column_groups?.[x.column_group]);return allowed.has('universe')&&allowed.has('fields')&&universeIds.includes('fw002')&&['t0_close_ltp','t0_per_change'].every(id=>columnIds.includes(id));});if(!screener){const summary=candidates.map(x=>({id:x.id,category:x.category,universe_group:x.universe_group,column_group:x.column_group,supported_params:x.supported_params}));throw new Error('No FYERS Futures Scan gainer screener accepts fw002 + live price/change fields. Candidates: '+JSON.stringify(summary).slice(0,260));}const allowed=new Set(screener.supported_params||[]),params=new URLSearchParams({screener_id:screener.id});params.set('universe','fw002');params.set('fields','t0_close_ltp,t0_per_change');if(allowed.has('order_by'))params.set('order_by','t0_per_change');if(allowed.has('order'))params.set('order','desc');if(allowed.has('timeframe')&&(x=>x.includes('t0'))(screener.allowed_timeframes||[]))params.set('timeframe','t0');const result=await fyersGet(FYERS_API+'/screeners/standard?'+params.toString());const d=result.data||{},header=Array.isArray(d.header)?d.header:[],idx=Object.fromEntries(header.map((item,i)=>[item.unique_key,i]));if(!Number.isInteger(idx.symbolticker)||!Number.isInteger(idx.t0_close_ltp)||!Number.isInteger(idx.t0_per_change))throw new Error('FYERS screener response missing symbolticker / t0_close_ltp / t0_per_change columns');const master=await loadNseFoMaster();const byUnderlying=new Map();for(const row of (Array.isArray(d.body)?d.body:[])){const symbol=String(row[idx.symbolticker]||''),price=Number(row[idx.t0_close_ltp]),change=Number(row[idx.t0_per_change]);if(!/^NSE:.+FUT$/.test(symbol)||!Number.isFinite(price)||price<=0||!Number.isFinite(change)||1+change/100<=0)continue;const expiry=toEpochSeconds(master?.[symbol]?.expiryDate);if(!expiry||expiry*1000<Date.now())continue;const underlying=symbol.replace(/\d{2}[A-Z]{3}FUT$/,'');if(underlying===symbol)continue;const optionUnderlying=underlying==='NSE:NIFTY50'?'NSE:NIFTY50-INDEX':underlying==='NSE:BANKNIFTY'?'NSE:NIFTYBANK-INDEX':underlying+'-EQ';const candidate={symbol,underlying,underlyingSymbol:optionUnderlying,expiry,basePrice:price/(1+change/100),price,change,exchangeTime:Number(d.last_update_time||d.fetch_time||0),source:'FYERS Standard Screener'};const previous=byUnderlying.get(underlying);if(!previous||candidate.expiry<previous.expiry)byUnderlying.set(underlying,candidate);}const rows=[...byUnderlying.values()].sort((a,b)=>b.change-a.change).slice(0,5);if(!rows.length)throw new Error('FYERS stock-futures gainer screener returned no valid NSE futures rows');const updatedAt=Number(d.last_update_time||d.fetch_time||0)*1000;if(!Number.isFinite(updatedAt)||updatedAt<=0)throw new Error('FYERS screener response did not include a valid exchange refresh timestamp');fnoMoversCache={rows,updatedAt,expiresAt:Date.now()+15*60*1000,error:''};syncSocketSubscriptions();console.info('FYERS stock-futures gainers loaded.',JSON.stringify({screenerId:screener.id,count:rows.length,updatedAt:new Date(updatedAt).toISOString()}));return fnoMoversCache;}catch(e){const message=String(e?.message||e).replace(/\\s+/g,' ').slice(0,260);console.error('FYERS stock-futures gainers unavailable.',JSON.stringify({message,statusCode:e?.statusCode||null,retryAfterMs:e?.retryAfterMs||0}));const retryDelay=Math.max(15000,Math.min(FYERS_REST_MAX_COOLDOWN_MS,Number(e?.retryAfterMs)||30000));fnoMoversCache={rows:[],updatedAt:0,expiresAt:Date.now()+retryDelay,error:message};syncSocketSubscriptions();return fnoMoversCache;}})().finally(()=>{fnoMoversPromise=null});return fnoMoversPromise;}

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
  const pinned=[selectedSymbol,selectedOptionSymbol,...mcxOptionCandidateSymbols,...fnoMoversCache.rows.flatMap(x=>[x.symbol,x.underlyingSymbol])].filter(Boolean);
  const batch=selectSubscriptionBatch({baseSymbols:BASE_SUBSCRIPTIONS,pinnedSymbols:pinned,universeSymbols:fnoUniverseRows.map(x=>x.futureSymbol),cursor:fnoUniverseCursor,limit:FYERS_DATA_SYMBOL_LIMIT});
  fnoUniverseCursor=batch.nextCursor;
  const universeSet=new Set(fnoUniverseRows.map(x=>x.futureSymbol));
  fnoScanSubscriptionSymbols=batch.symbols.filter(symbol=>universeSet.has(symbol));
  const result=syncSocketSubscriptions({reason});
  console.info('FYERS F&O rotating subscription window updated.',JSON.stringify({reason,activeFutureSymbols:fnoScanSubscriptionSymbols.length,universeCount:fnoUniverseRows.length,symbolLimit:FYERS_DATA_SYMBOL_LIMIT,nextCursor:fnoUniverseCursor,subscribed:result.subscribed,removed:result.removed}));
  return{symbols:fnoScanSubscriptionSymbols.length,universe:fnoUniverseRows.length,limit:FYERS_DATA_SYMBOL_LIMIT,nextCursor:fnoUniverseCursor};
}
function authReady(){return Boolean(appId&&accessToken);}
function ensureSocket(){
  if(!authReady()||socket)return;
  let owned=null;
  try{
    owned=fyersDataSocket.getInstance(`${appId}:${accessToken}`,'',false);
    socket=owned;
    console.info('FYERS WebSocket owner created.',JSON.stringify({at:new Date().toISOString(),tokenRestored:true}));
    owned.on('connect',()=>{
      if(socket!==owned)return;
      connected=true;
      socketConnectCount+=1;
      lastSocketConnectAt=new Date().toISOString();
      lastSocketError='';
      subscribedSymbols.clear();
      console.info('FYERS WebSocket CONNECTED.',JSON.stringify({connectionNumber:socketConnectCount,connectedAt:lastSocketConnectAt}));
      try{
        owned.mode(owned.FullMode);
        syncSocketSubscriptions({force:true,reason:'socket_connect'});
        void refreshFnoUniverse().then(()=>rotateFnoUniverseSubscriptions('universe_loaded')).catch(error=>console.warn('FYERS F&O universe unavailable; scanner remains fail-closed.',String(error?.message||error).slice(0,180)));
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
        lastTicks.set(symbol,tick);
        if(symbol.startsWith('MCX:'))mcxTicks.set(symbol,tick);
        else if(symbol.startsWith('NSE:')||symbol.startsWith('BSE:'))nseTicks.set(symbol,tick);
        accepted++;
        const lastLog=lastTickDiagnosticAt.get(symbol)||0;
        if(Date.now()-lastLog>=30000){
          const ageSeconds=Number((Date.now()/1000-stamp).toFixed(1));
          console.info('FYERS exchange tick accepted.',JSON.stringify({symbol,exchangeTimestamp:new Date(stamp*1000).toISOString(),exchangeAgeSeconds:ageSeconds,freshness:ageSeconds>=0&&ageSeconds<=10?'FRESH':'STALE'}));
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
    });
    owned.on('close',(code,reason)=>{
      if(socket!==owned)return;
      connected=false;
      subscribedSymbols.clear();
      console.warn('FYERS WebSocket CLOSED.',JSON.stringify({code:code??null,reason:reason==null?null:String(reason).slice(0,140),closedAt:new Date().toISOString()}));
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
    throw e;
  }
}
function isNseRegularSession(){
  const parts=new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());
  const values=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const minute=Number(values.hour)*60+Number(values.minute);
  return ['Mon','Tue','Wed','Thu','Fri'].includes(values.weekday)&&minute>=555&&minute<930;
}
const socketFeedWatchdog=setInterval(()=>{
  if(!socket||!connected||!isNseRegularSession())return;
  const freshIndexes=BASE_SUBSCRIPTIONS.filter(symbol=>freshTick(lastTicks.get(symbol),15000));
  if(freshIndexes.length===BASE_SUBSCRIPTIONS.length)return;
  if(Date.now()-lastSubscriptionRecoveryAt<30000)return;
  lastSubscriptionRecoveryAt=Date.now();
  console.warn('FYERS index tick heartbeat missed; reapplying subscriptions on existing socket.',JSON.stringify({freshIndexCount:freshIndexes.length,requiredIndexCount:BASE_SUBSCRIPTIONS.length,recoveryAt:new Date().toISOString()}));
  syncSocketSubscriptions({force:true,reason:'fresh_tick_watchdog'});
},5000);
socketFeedWatchdog.unref?.();
const fnoUniverseRotationTimer=setInterval(()=>{
  if(!socket||!connected||!isNseRegularSession()||!fnoUniverseRows.length)return;
  rotateFnoUniverseSubscriptions('scheduled_rotation');
},60000);
fnoUniverseRotationTimer.unref?.();
app.get('/api/health',(_req,res)=>{
  const freshIndexes=BASE_SUBSCRIPTIONS.filter(symbol=>freshTick(lastTicks.get(symbol),15000));
  const latestExchangeTime=[...lastTicks.values()].reduce((latest,tick)=>Math.max(latest,Number(tick.exchangeTime)||0),0);
  res.set('Cache-Control','no-store').json({ok:true,authenticated:authReady(),socketConnected:connected,websocketState:connected?'CONNECTED':socket?'CONNECTING_OR_RECOVERING':'DISCONNECTED',socketConnectCount,lastSocketConnectAt,lastSocketMessageAt,lastAcceptedTickAt,lastSocketError:lastSocketError||null,freshIndexTickCount:freshIndexes.length,requiredIndexTickCount:BASE_SUBSCRIPTIONS.length,latestExchangeTimestamp:latestExchangeTime?new Date(latestExchangeTime*1000).toISOString():null,marketData: freshIndexes.length===BASE_SUBSCRIPTIONS.length?'FRESH_EXCHANGE_TICKS':'WAITING_FOR_FRESH_EXCHANGE_TICKS',fnoScanner:{universeCount:fnoUniverseRows.length,activeFutureSubscriptions:fnoScanSubscriptionSymbols.length,symbolLimit:FYERS_DATA_SYMBOL_LIMIT,rotationCursor:fnoUniverseCursor,universeUpdatedAt:fnoUniverseFetchedAt?new Date(fnoUniverseFetchedAt).toISOString():null,error:fnoUniverseError||null},fyersRestCooldown:{active:fyersRestCooldownUntil>Date.now(),reason:fyersRestCooldownReason||null,retryAfterSeconds:fyersRestCooldownUntil>Date.now()?Math.ceil((fyersRestCooldownUntil-Date.now())/1000):0,consecutive429:fyersRest429Count},orderMode:'DISABLED'});
});
app.get('/api/market',async(_req,res)=>{res.set('Cache-Control','no-store');if(!authReady())return res.json({connected:false,quotes:[],nse:[],mcx:[],gainers:[],error:'FYERS session unavailable'});const movers=await loadFnoMovers();const gainers=movers.rows.map(row=>{const tick=lastTicks.get(row.symbol),tickFresh=freshTick(tick);return{symbol:row.symbol,underlying:row.underlyingSymbol,price:tickFresh?tick.price:row.price,change:tickFresh?(tick.price/row.basePrice-1)*100:row.change,exchangeTime:tickFresh?tick.exchangeTime:movers.updatedAt/1000,fresh:tickFresh,source:row.source};}).sort((a,b)=>b.change-a.change).slice(0,5);res.json({connected,quotes:[...lastTicks.values()],nse:[...nseTicks.values()],mcx:[...mcxTicks.values()],gainers,gainersUpdatedAt:movers.updatedAt,error:movers.error});});
app.post('/api/select-symbol',(req,res)=>{const symbol=String(req.body?.symbol||'').trim();if(!/^(NSE|BSE):[A-Z0-9&_.-]{2,48}(?:-(EQ|INDEX)|[0-9]{2}[A-Z0-9]+FUT)$/.test(symbol)&&!/^MCX:[A-Z0-9&_.-]{3,48}$/.test(symbol))return res.status(400).json({error:'Invalid FYERS NSE/BSE cash-index or MCX contract symbol'});const instrumentChanged=symbol!==selectedSymbol;selectedSymbol=symbol;if(instrumentChanged){selectedOptionSymbol='';mcxOptionCandidateSymbols=[];}syncSocketSubscriptions();res.json({selectedSymbol,exchange:symbol.split(':')[0],historyFetch:'on-demand-only'});});
const historyCache=new Map();
const gainerHistoryCache=new Map();
app.get('/api/history',async(req,res)=>{
  const symbol=String(req.query.symbol||'');
  if(symbol!==selectedSymbol)return res.status(409).json({error:'Select symbol before requesting history'});
  if(!authReady())return res.status(401).json({error:'Connect FYERS first'});
  const cachedHistory=historyCache.get(symbol);
  if(cachedHistory&&isHistoryCacheFresh(cachedHistory.fetchedAt))return res.json({...cachedHistory,cached:true});
  try{
    const now=Math.floor(Date.now()/1000),to=now-300,from=to-5*24*60*60;
    const params=new URLSearchParams({symbol,resolution:'5',date_format:'0',range_from:String(from),range_to:String(to),cont_flag:'1'});
    const response=await fyersRestFetch('https://api-t1.fyers.in/data/history?'+params.toString(),{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:15000});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||payload.s!=='ok'||!Array.isArray(payload.candles))return res.status(response.status||502).json({error:'FYERS did not return verified completed 5-minute candles',detail:String(payload.message||payload.code||'Invalid candle payload')});
    const candles=payload.candles.filter(c=>Array.isArray(c)&&c.length>=5&&c.slice(0,5).every(v=>Number.isFinite(Number(v)))&&Number(c[2])>=Math.max(Number(c[1]),Number(c[4]))&&Number(c[3])<=Math.min(Number(c[1]),Number(c[4]))&&Number(c[3])>0).map(c=>({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]||0)}));
    if(!candles.length)return res.status(502).json({error:'No valid completed 5-minute candles received'});
    const result={symbol,resolution:'5',candles,source:'FYERS Data API',fetchedAt:new Date().toISOString()};
    historyCache.set(symbol,result);res.set('Cache-Control','no-store').json(result);
  }catch(e){res.status(502).json({error:'FYERS history request failed',detail:String(e?.message||e).slice(0,180)});}
});


// MCX option discovery uses the official MCX_COM Symbol Master, not the NSE/BSE option-chain endpoint.
// Candidate contracts are subscribed first; a setup is published only after both futures and option candles/ticks pass freshness checks.
async function loadMxcHistory(symbol){
  const cached=mcxOptionHistoryCache.get(symbol);
  if(cached&&isHistoryCacheFresh(cached.fetchedAt))return cached;
  const now=Math.floor(Date.now()/1000),to=now-300,from=to-5*24*60*60;
  const params=new URLSearchParams({symbol,resolution:'5',date_format:'0',range_from:String(from),range_to:String(to),cont_flag:'1'});
  const response=await fyersRestFetch('https://api-t1.fyers.in/data/history?'+params.toString(),{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:15000});
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
    if(!freshTick(futureTick))return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Fresh MCX futures exchange tick is required'};
    const underlyingHistory=historyCache.get(future)&&isHistoryCacheFresh(historyCache.get(future).fetchedAt)?historyCache.get(future):await loadMxcHistory(future);
    const underlyingSetup=evaluateMxcTrendPullback(underlyingHistory.candles,futureTick);
    if(underlyingSetup.status!=='SETUP_CONFIRMED')return{...underlyingSetup,source:'FYERS MCX futures tick + completed 5-minute candles'};
    const master=await loadMcxComMaster();
    if(selectedSymbol!==future)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX instrument changed during scan; stale result discarded'};
    const futureMeta=master?.[future];
    if(!futureMeta||Number(futureMeta.tradeStatus)!==1)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Exact MCX futures contract is not active in the official FYERS Symbol Master'};
    const contracts=listMxcOptionContracts(master,future);
    const candidates=pickMxcOptionCandidates(contracts,futureTick.price,underlyingSetup.side,3).map(contract=>({...contract,underlyingPrice:futureTick.price}));
    if(!candidates.length)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'No active FYERS MCX option contracts for the nearest expiry'};
    if(selectedSymbol!==future)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX instrument changed during scan; stale candidates discarded'};
    mcxOptionChains.set(future,{contracts:candidates,fetchedAt:Date.now()});
    mcxOptionCandidateSymbols=candidates.map(contract=>contract.symbol);
    syncSocketSubscriptions({reason:'mcx_option_candidate_scan'});
    const freshCandidates=candidates.filter(contract=>freshTick(lastTicks.get(contract.symbol)));
    if(freshCandidates.length!==candidates.length)return{status:'WAITING_FOR_OPTION_TICKS',reason:'Fresh option exchange ticks '+freshCandidates.length+'/'+candidates.length+'; waiting to compare every nearest-strike candidate',side:underlyingSetup.side,candidates:candidates.map(({symbol,side,strike,expiryDate})=>({symbol,side,strike,expiry:expiryDate}))};
    const valid=[];
    const rejected=[];
    for(const contract of freshCandidates){
      try{
        const history=await loadMxcHistory(contract.symbol);
        if(selectedSymbol!==future)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX instrument changed during option history check'};
        const optionTick=lastTicks.get(contract.symbol);
        if(!freshTick(optionTick)){rejected.push({symbol:contract.symbol,reason:'Option tick became stale during candle verification'});continue;}
        const setup=evaluateMxcTrendPullback(history.candles,optionTick,contract);
        if(setup.status==='SETUP_CONFIRMED')valid.push({...setup,contract});
        else rejected.push({symbol:contract.symbol,reason:setup.reason});
      }catch(error){
        if(Number(error?.statusCode)===429)throw error;
        rejected.push({symbol:contract.symbol,reason:String(error?.message||error).slice(0,120)});
      }
    }
    if(selectedSymbol!==future)return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX instrument changed before setup confirmation'};
    if(!freshTick(lastTicks.get(future)))return{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'MCX futures tick became stale during option verification'};
    if(!valid.length)return{status:'NO_TRADE',reason:rejected.length?'No candidate passed fresh option-candle breakout and 1:2 risk/reward checks':'Waiting for verified option history',side:underlyingSetup.side,rejected};
    valid.sort((a,b)=>b.score-a.score||a.contract.strikeDistance-b.contract.strikeDistance);
    const best=valid[0];
    selectedOptionSymbol=best.symbol;
    syncSocketSubscriptions({reason:'mcx_best_option_selected'});
    return{
      status:'SETUP_CONFIRMED',
      label:'B · EMA20/EMA50 TREND-PULLBACK · VERIFIED RULE-MATCH · NOT A PROBABILITY GUARANTEE',
      underlying:future,
      underlyingSide:underlyingSetup.side,
      contract:{symbol:best.symbol,side:best.side,strike:best.strike,expiry:best.expiry,lotSize:best.lotSize,tickSize:best.tickSize},
      premium:best.premium??best.entry,entry:best.entry,stopLoss:best.stopLoss,target:best.target,rr:best.rr,strategy:best.strategy||'B_EMA20_EMA50_TREND_PULLBACK',
      source:'FYERS MCX Symbol Master + fresh futures/option ticks + completed 5-minute candles',
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


async function loadGainerHistory(symbol){
 const cached=gainerHistoryCache.get(symbol);if(cached&&Date.now()-cached.cachedAt<300000)return cached;
 const now=Math.floor(Date.now()/1000),to=now-300,from=to-5*24*60*60;
 const params=new URLSearchParams({symbol,resolution:'5',date_format:'0',range_from:String(from),range_to:String(to),cont_flag:'1'});
 const response=await fyersRestFetch('https://api-t1.fyers.in/data/history?'+params.toString(),{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},timeoutMs:15000});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok||payload.s!=='ok'||!Array.isArray(payload.candles)){const error=new Error('FYERS did not return verified 5-minute candles for top gainer');error.statusCode=response.status;error.retryAfterMs=Number(payload.retryAfterSeconds)*1000||fyersRetryAfterMs(response);throw error;}
 const candles=payload.candles.filter(c=>Array.isArray(c)&&c.length>=5&&c.slice(0,5).every(v=>Number.isFinite(Number(v)))&&Number(c[2])>=Math.max(Number(c[1]),Number(c[4]))&&Number(c[3])<=Math.min(Number(c[1]),Number(c[4]))&&Number(c[3])>0).map(c=>({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]||0)}));
 if(!candles.length)throw new Error('No valid FYERS 5-minute candles for top gainer');
 const result={symbol,candles,source:'FYERS Data API',cachedAt:Date.now(),fetchedAt:new Date().toISOString()};gainerHistoryCache.set(symbol,result);return result;
}
function evaluateGainerBreakout(candles,tick){
 if(!freshTick(tick))return{status:'WAITING_FOR_FRESH_TICK',reason:'Underlying exchange tick is not fresh'};
 const {completed,lastClosed,fresh,contiguous}=getCompletedCandleWindow(candles,tick.exchangeTime);
 if(completed.length<21)return{status:'WAITING_FOR_21_COMPLETED_CANDLES',reason:'Need at least 21 completed FYERS 5-minute candles'};
 if(!fresh)return{status:'STALE_CANDLES',reason:'Latest completed 5-minute candle is stale'};
 if(!contiguous)return{status:'INCOMPLETE_CANDLE_WINDOW',reason:'Breakout window contains missing 5-minute candles'};
 const prior=completed.slice(-21,-1),swing=completed.slice(-5),resistance=Math.max(...prior.map(c=>c.high)),support=Math.min(...prior.map(c=>c.low));
 let plan=null;
 if(lastClosed.close>resistance&&Number(tick.price)>=lastClosed.close){const sl=Math.min(...swing.map(c=>c.low)),risk=lastClosed.close-sl;if(risk>0)plan={side:'LONG',entry:lastClosed.close,stopLoss:sl,target:lastClosed.close+2*risk,rr:'1:2'};}
 else if(lastClosed.close<support&&Number(tick.price)<=lastClosed.close){const sl=Math.max(...swing.map(c=>c.high)),risk=sl-lastClosed.close;if(risk>0)plan={side:'SHORT',entry:lastClosed.close,stopLoss:sl,target:lastClosed.close-2*risk,rr:'1:2'};}
 return plan?{status:'SETUP_CONFIRMED',...plan,candleTime:lastClosed.time,underlyingPrice:Number(tick.price)}:{status:'WAIT',reason:'No confirmed 20-candle breakout'};
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
app.get('/api/account',async(_req,res)=>{
  res.set('Cache-Control','no-store');
  if(!authReady())return res.status(401).json({error:'FYERS session unavailable'});
  const now=Date.now();
  if(accountSnapshot&&now-accountSnapshotFetchedAt<60000)return res.json({...accountSnapshot,cached:true});
  if(accountFetchPromise){try{return res.json(await accountFetchPromise);}catch(e){return res.status(502).json({error:'FYERS account reconciliation unavailable',detail:String(e.message||e).slice(0,160)});}}
  if(now<accountRetryAfter){
    if(accountSnapshot)return res.json({...accountSnapshot,cached:true,stale:true,error:'FYERS account API rate limit; showing last verified account snapshot'});
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
    const response=await fetch('https://api-t1.fyers.in/api/v3/validate-authcode',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({grant_type:'authorization_code',appIdHash,code}),signal:AbortSignal.timeout(12000)});
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
async function restoreSharedFyersSession(){if(!tokenReader){console.warn('Shared encrypted FYERS token reader is not configured; market stream remains disconnected.');return;}try{const saved=await tokenReader.read();if(!saved){console.warn('No encrypted FYERS session found in shared token store.');return;}accessToken=saved.accessToken;console.log('Existing encrypted FYERS session restored read-only; authenticatedAt='+saved.authenticatedAt);ensureSocket();}catch(error){console.error('Could not restore shared FYERS session:',String(error?.message||error).slice(0,160));}}
void restoreSharedFyersSession();
server.on('error',error=>console.error('Workstation HTTP server error:',error.message));
