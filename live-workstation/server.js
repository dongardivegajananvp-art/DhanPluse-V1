import crypto from 'node:crypto';
import {createSharedTokenReader} from './token-reader.js';
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
  if(req.method==='OPTIONS')return next();
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

const optionChains=new Map();
let nseFoMaster=null,nseFoMasterFetchedAt=0,nseFoMasterPromise=null;
let bseFoMaster=null,bseFoMasterFetchedAt=0,bseFoMasterPromise=null;
let fnoMoversCache={rows:[],updatedAt:0,expiresAt:0,error:'Not loaded'};
let fnoMoversPromise=null,screenerConfigCache=null,screenerConfigFetchedAt=0,screenerConfigPromise=null;
let accountSnapshot=null,accountSnapshotFetchedAt=0,accountFetchPromise=null,accountRetryAfter=0,accountFailureCount=0;
const subscribedSymbols=new Set();
const BASE_SUBSCRIPTIONS=['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'];
function syncSocketSubscriptions({force=false,reason='state_change'}={}){
  if(!socket||!connected)return {subscribed:0,removed:0};
  const wanted=new Set([...BASE_SUBSCRIPTIONS,...(selectedSymbol?[selectedSymbol]:[]),...(selectedOptionSymbol?[selectedOptionSymbol]:[]),...fnoMoversCache.rows.map(x=>x.symbol)]);
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
function toEpochSeconds(value){if(value===null||value===undefined||value==='')return 0;const n=Number(value);if(Number.isFinite(n)&&n>0)return n>1e12?n/1000:n;const parsed=Date.parse(String(value));return Number.isFinite(parsed)&&parsed>0?parsed/1000:0;}
async function fyersGet(url){const r=await fetch(url,{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},signal:AbortSignal.timeout(12000)});const raw=await r.text();let j={};try{j=raw?JSON.parse(raw):{};}catch{throw new Error('FYERS returned non-JSON response (HTTP '+r.status+')');}if(!r.ok||j.s==='error')throw new Error('FYERS HTTP '+r.status+' · '+String(j.message||j.code||j.data?.error||'request rejected').replace(/\\s+/g,' ').slice(0,180));return j;}
async function fyersPost(url,body){const r=await fetch(url,{method:'POST',headers:{Authorization:appId+':'+accessToken,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});const j=await r.json().catch(()=>({}));if(!r.ok||j.s!=='ok')throw new Error(String(j.message||j.code||'FYERS order request failed'));return j;}
async function loadNseFoMaster(){if(nseFoMaster&&Date.now()-nseFoMasterFetchedAt<86400000)return nseFoMaster;if(nseFoMasterPromise)return nseFoMasterPromise;nseFoMasterPromise=(async()=>{const r=await fetch('https://public.fyers.in/sym_details/NSE_FO_sym_master.json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('FYERS NSE F&O symbol master unavailable');const master=await r.json();if(!master||typeof master!=='object'||Array.isArray(master))throw new Error('Invalid FYERS symbol master');nseFoMaster=master;nseFoMasterFetchedAt=Date.now();return master;})().finally(()=>{nseFoMasterPromise=null});return nseFoMasterPromise;}
async function loadBseFoMaster(){if(bseFoMaster&&Date.now()-bseFoMasterFetchedAt<86400000)return bseFoMaster;if(bseFoMasterPromise)return bseFoMasterPromise;bseFoMasterPromise=(async()=>{const r=await fetch('https://public.fyers.in/sym_details/BSE_FO_sym_master.json',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error('FYERS BSE F&O symbol master unavailable');const master=await r.json();if(!master||typeof master!=='object'||Array.isArray(master))throw new Error('Invalid FYERS BSE F&O symbol master');bseFoMaster=master;bseFoMasterFetchedAt=Date.now();return master;})().finally(()=>{bseFoMasterPromise=null});return bseFoMasterPromise;}
function optionMeta(symbol,master){const x=master?.[symbol];if(!x||Number(x.tradeStatus)!==1||!['CE','PE'].includes(String(x.optType||'').toUpperCase()))return null;const lotSize=Number(x.minLotSize),tickSize=Number(x.tickSize),strike=Number(x.strikePrice);if(!Number.isInteger(lotSize)||lotSize<1||!Number.isFinite(tickSize)||tickSize<=0||!Number.isFinite(strike)||strike<=0)return null;return{symbol,side:String(x.optType).toUpperCase(),strike,lotSize,tickSize,expiryDate:String(x.expiryDate||'')};}



async function loadScreenerConfig(){if(screenerConfigCache&&Date.now()-screenerConfigFetchedAt<86400000)return screenerConfigCache;if(screenerConfigPromise)return screenerConfigPromise;screenerConfigPromise=fyersGet(FYERS_API+'/screeners/config').then(x=>{screenerConfigCache=x;screenerConfigFetchedAt=Date.now();return x;}).finally(()=>{screenerConfigPromise=null});return screenerConfigPromise;}
function screenerIds(value){return Array.isArray(value)?value.map(item=>typeof item==='string'?item:String(item?.id||'')).filter(Boolean):[];}
async function loadFnoMovers(){if(fnoMoversCache.expiresAt>Date.now())return fnoMoversCache;if(fnoMoversPromise)return fnoMoversPromise;fnoMoversPromise=(async()=>{try{const config=await loadScreenerConfig(),data=config.data||{};const screeners=Array.isArray(data.screeners_standard)?data.screeners_standard:[];const candidates=screeners.filter(x=>String(x.category||'').toLowerCase().includes('futures')&&/(gain|gainer)/i.test(String(x.id||'')+' '+String(x.name||'')));const screener=candidates.find(x=>{const allowed=new Set(x.supported_params||[]);const universeIds=screenerIds(data.universe_groups?.[x.universe_group]);const columnIds=screenerIds(data.column_groups?.[x.column_group]);return allowed.has('universe')&&allowed.has('fields')&&universeIds.includes('fw002')&&['t0_close_ltp','t0_per_change'].every(id=>columnIds.includes(id));});if(!screener){const summary=candidates.map(x=>({id:x.id,category:x.category,universe_group:x.universe_group,column_group:x.column_group,supported_params:x.supported_params}));throw new Error('No FYERS Futures Scan gainer screener accepts fw002 + live price/change fields. Candidates: '+JSON.stringify(summary).slice(0,260));}const allowed=new Set(screener.supported_params||[]),params=new URLSearchParams({screener_id:screener.id});params.set('universe','fw002');params.set('fields','t0_close_ltp,t0_per_change');if(allowed.has('order_by'))params.set('order_by','t0_per_change');if(allowed.has('order'))params.set('order','desc');if(allowed.has('timeframe')&&(x=>x.includes('t0'))(screener.allowed_timeframes||[]))params.set('timeframe','t0');const result=await fyersGet(FYERS_API+'/screeners/standard?'+params.toString());const d=result.data||{},header=Array.isArray(d.header)?d.header:[],idx=Object.fromEntries(header.map((item,i)=>[item.unique_key,i]));if(!Number.isInteger(idx.symbolticker)||!Number.isInteger(idx.t0_close_ltp)||!Number.isInteger(idx.t0_per_change))throw new Error('FYERS screener response missing symbolticker / t0_close_ltp / t0_per_change columns');const master=await loadNseFoMaster();const byUnderlying=new Map();for(const row of (Array.isArray(d.body)?d.body:[])){const symbol=String(row[idx.symbolticker]||''),price=Number(row[idx.t0_close_ltp]),change=Number(row[idx.t0_per_change]);if(!/^NSE:.+FUT$/.test(symbol)||!Number.isFinite(price)||price<=0||!Number.isFinite(change)||1+change/100<=0)continue;const expiry=toEpochSeconds(master?.[symbol]?.expiryDate);if(!expiry||expiry*1000<Date.now())continue;const underlying=symbol.replace(/\\d{2}[A-Z]{3}FUT$/,'');if(underlying===symbol)continue;const candidate={symbol,underlying,expiry,basePrice:price/(1+change/100),price,change,exchangeTime:Number(d.last_update_time||d.fetch_time||0),source:'FYERS Standard Screener'};const previous=byUnderlying.get(underlying);if(!previous||candidate.expiry<previous.expiry)byUnderlying.set(underlying,candidate);}const rows=[...byUnderlying.values()].sort((a,b)=>b.change-a.change).slice(0,5);if(!rows.length)throw new Error('FYERS stock-futures gainer screener returned no valid NSE futures rows');const updatedAt=Number(d.last_update_time||d.fetch_time||0)*1000;if(!Number.isFinite(updatedAt)||updatedAt<=0)throw new Error('FYERS screener response did not include a valid exchange refresh timestamp');fnoMoversCache={rows,updatedAt,expiresAt:Date.now()+15*60*1000,error:''};syncSocketSubscriptions();console.info('FYERS stock-futures gainers loaded.',JSON.stringify({screenerId:screener.id,count:rows.length,updatedAt:new Date(updatedAt).toISOString()}));return fnoMoversCache;}catch(e){const message=String(e?.message||e).replace(/\\s+/g,' ').slice(0,260);console.error('FYERS stock-futures gainers unavailable.',message);fnoMoversCache={rows:[],updatedAt:0,expiresAt:Date.now()+15*60*1000,error:message};syncSocketSubscriptions();return fnoMoversCache;}})().finally(()=>{fnoMoversPromise=null});return fnoMoversPromise;}

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
        const tick={symbol,price,exchangeTime:stamp,receivedAt:Date.now()};
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
app.get('/api/health',(_req,res)=>{
  const freshIndexes=BASE_SUBSCRIPTIONS.filter(symbol=>freshTick(lastTicks.get(symbol),15000));
  const latestExchangeTime=[...lastTicks.values()].reduce((latest,tick)=>Math.max(latest,Number(tick.exchangeTime)||0),0);
  res.set('Cache-Control','no-store').json({ok:true,authenticated:authReady(),socketConnected:connected,websocketState:connected?'CONNECTED':socket?'CONNECTING_OR_RECOVERING':'DISCONNECTED',socketConnectCount,lastSocketConnectAt,lastSocketMessageAt,lastAcceptedTickAt,lastSocketError:lastSocketError||null,freshIndexTickCount:freshIndexes.length,requiredIndexTickCount:BASE_SUBSCRIPTIONS.length,latestExchangeTimestamp:latestExchangeTime?new Date(latestExchangeTime*1000).toISOString():null,marketData: freshIndexes.length===BASE_SUBSCRIPTIONS.length?'FRESH_EXCHANGE_TICKS':'WAITING_FOR_FRESH_EXCHANGE_TICKS',orderMode:'DISABLED'});
});
app.get('/api/market',async(_req,res)=>{res.set('Cache-Control','no-store');if(!authReady())return res.json({connected:false,quotes:[],nse:[],mcx:[],gainers:[],error:'FYERS session unavailable'});const movers=await loadFnoMovers();const gainers=movers.rows.map(row=>{const tick=lastTicks.get(row.symbol),tickFresh=freshTick(tick);return{symbol:row.symbol,price:tickFresh?tick.price:row.price,change:tickFresh?(tick.price/row.basePrice-1)*100:row.change,exchangeTime:tickFresh?tick.exchangeTime:movers.updatedAt/1000,fresh:tickFresh,source:row.source};}).sort((a,b)=>b.change-a.change).slice(0,5);res.json({connected,quotes:[...lastTicks.values()],nse:[...nseTicks.values()],mcx:[...mcxTicks.values()],gainers,gainersUpdatedAt:movers.updatedAt,error:movers.error});});
app.post('/api/select-symbol',(req,res)=>{const symbol=String(req.body?.symbol||'').trim();if(!/^(NSE|BSE):[A-Z0-9&_.-]{2,48}(?:-(EQ|INDEX)|[0-9]{2}[A-Z0-9]+FUT)$/.test(symbol)&&!/^MCX:[A-Z0-9&_.-]{3,48}$/.test(symbol))return res.status(400).json({error:'Invalid FYERS NSE/BSE cash-index or MCX contract symbol'});selectedSymbol=symbol;syncSocketSubscriptions();res.json({selectedSymbol,exchange:symbol.split(':')[0],historyFetch:'on-demand-only'});});
const historyCache=new Map();
app.get('/api/history',async(req,res)=>{
  const symbol=String(req.query.symbol||'');
  if(symbol!==selectedSymbol)return res.status(409).json({error:'Select symbol before requesting history'});
  if(!authReady())return res.status(401).json({error:'Connect FYERS first'});
  if(historyCache.has(symbol))return res.json({...historyCache.get(symbol),cached:true});
  try{
    const now=Math.floor(Date.now()/1000),to=now-300,from=to-5*24*60*60;
    const params=new URLSearchParams({symbol,resolution:'5',date_format:'0',range_from:String(from),range_to:String(to),cont_flag:'1'});
    const response=await fetch('https://api-t1.fyers.in/data/history?'+params.toString(),{headers:{Authorization:appId+':'+accessToken,Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||payload.s!=='ok'||!Array.isArray(payload.candles))return res.status(response.status||502).json({error:'FYERS did not return verified completed 5-minute candles',detail:String(payload.message||payload.code||'Invalid candle payload')});
    const candles=payload.candles.filter(c=>Array.isArray(c)&&c.length>=5&&c.slice(0,5).every(v=>Number.isFinite(Number(v)))&&Number(c[2])>=Math.max(Number(c[1]),Number(c[4]))&&Number(c[3])<=Math.min(Number(c[1]),Number(c[4]))&&Number(c[3])>0).map(c=>({time:Number(c[0]),open:Number(c[1]),high:Number(c[2]),low:Number(c[3]),close:Number(c[4]),volume:Number(c[5]||0)}));
    if(!candles.length)return res.status(502).json({error:'No valid completed 5-minute candles received'});
    const result={symbol,resolution:'5',candles,source:'FYERS Data API',fetchedAt:new Date().toISOString()};
    historyCache.set(symbol,result);res.set('Cache-Control','no-store').json(result);
  }catch(e){res.status(502).json({error:'FYERS history request failed',detail:String(e?.message||e).slice(0,180)});}
});

app.get('/api/options',async(req,res)=>{const underlying=String(req.query.symbol||'');if(!/^(NSE|BSE):[A-Z0-9&.-]+-EQ$/.test(underlying)&&!['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'].includes(underlying))return res.status(400).json({error:'Select a valid NSE/BSE underlying'});if(!authReady())return res.status(401).json({error:'FYERS session unavailable'});const cached=optionChains.get(underlying);if(cached&&Date.now()-cached.fetchedAt<300000)return res.json(cached);try{const url=new URL(FYERS_DATA+'/options-chain-v3');url.searchParams.set('symbol',underlying);url.searchParams.set('strikecount','10');url.searchParams.set('greeks','0');const response=await fyersGet(url);const data=response.data;if(!data||!Array.isArray(data.optionsChain)||!data.optionsChain.length)throw new Error('FYERS option chain is empty');const master=underlying.startsWith('BSE:')?await loadBseFoMaster():await loadNseFoMaster();const contracts=data.optionsChain.filter(x=>['CE','PE'].includes(String(x.option_type||'').toUpperCase())&&typeof x.symbol==='string').map(x=>{const meta=optionMeta(x.symbol,master);return meta?{symbol:x.symbol,side:meta.side,strike:meta.strike,expiry:meta.expiryDate,lotSize:meta.lotSize,tickSize:meta.tickSize}:null;}).filter(Boolean);if(!contracts.length){const chainSymbols=data.optionsChain.slice(0,4).map(x=>String(x.symbol||'')).filter(Boolean);throw new Error('No active option contracts matched the FYERS Symbol Master; chainRows='+data.optionsChain.length+', masterRows='+Object.keys(master).length+', sample='+chainSymbols.join(','));}const result={underlying,contracts,expiries:data.expiryData||[],fetchedAt:Date.now(),source:'FYERS option chain + official NSE F&O Symbol Master'};optionChains.set(underlying,result);res.json(result);}catch(e){res.status(502).json({error:'Option contract discovery failed closed',detail:String(e.message||e).slice(0,180)});}});
app.post('/api/select-option',(req,res)=>{const symbol=String(req.body?.symbol||'');const valid=[...optionChains.values()].some(chain=>Date.now()-chain.fetchedAt<300000&&chain.contracts.some(c=>c.symbol===symbol));if(!valid)return res.status(400).json({error:'Option is not in a recently verified FYERS option chain'});selectedOptionSymbol=symbol;syncSocketSubscriptions();res.json({selectedSymbol:symbol,subscribed:Boolean(socket&&connected)});});
app.get('/api/account',async(_req,res)=>{
  res.set('Cache-Control','no-store');
  if(!authReady())return res.status(401).json({error:'FYERS session unavailable'});
  const now=Date.now();
  if(accountSnapshot&&now-accountSnapshotFetchedAt<20000)return res.json({...accountSnapshot,cached:true});
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
      return accountSnapshot;
    }catch(e){
      const message=String(e.message||e).slice(0,160);
      if(/HTTP 429/i.test(message)){
        accountFailureCount=Math.min(accountFailureCount+1,5);
        accountRetryAfter=Date.now()+Math.min(300000,30000*Math.pow(2,accountFailureCount-1));
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


app.post('/api/order',async(req,res)=>{if(process.env.LIVE_ORDERS_ENABLED!=='true'||!/200$/.test(appId)||process.env.FYERS_STATIC_IP_CONFIRMED!=='true'||!Number.isFinite(Number(process.env.MAX_ORDER_RISK_INR))||Number(process.env.MAX_ORDER_RISK_INR)<=0)return res.status(423).json({error:'Live orders require explicit enablement, Trading App ID, static-IP allowlisting and a positive MAX_ORDER_RISK_INR limit'});if(!authReady()||!connected)return res.status(503).json({error:'FYERS authenticated socket is not connected'});const {symbol,side,qty,productType,stopLoss,takeProfit,confirm,requestId}=req.body||{};if(confirm!==true||typeof requestId!=='string'||!/^[a-f0-9-]{24,40}$/i.test(requestId))return res.status(400).json({error:'Explicit confirmation and unique requestId required'});if(usedOrderRequestIds.has(requestId))return res.status(409).json({error:'This order request ID has already been used; check FYERS orderbook before any new attempt'});const chain=[...optionChains.values()].find(x=>Date.now()-x.fetchedAt<60000&&x.contracts.some(c=>c.symbol===symbol));if(!chain)return res.status(400).json({error:'Contract identity/expiry is not verified by a fresh option chain'});const tick=lastTicks.get(symbol);if(!freshTick(tick))return res.status(409).json({error:'Option premium is stale or missing; order blocked'});const master=await (symbol.startsWith('BSE:')?loadBseFoMaster():loadNseFoMaster()).catch(()=>null),meta=optionMeta(symbol,master);if(!meta)return res.status(400).json({error:'Official contract lot/tick metadata is unavailable'});const quantity=Number(qty),sl=Number(stopLoss),tp=Number(takeProfit),maxQty=Number(process.env.MAX_ORDER_QTY||meta.lotSize*5),maxRisk=Number(process.env.MAX_ORDER_RISK_INR),riskInr=Math.abs(tick.price-sl)*quantity;if(!Number.isInteger(maxQty)||maxQty<meta.lotSize||!Number.isInteger(quantity)||quantity<meta.lotSize||quantity%meta.lotSize!==0||quantity>maxQty)return res.status(400).json({error:'Quantity must be a valid lot multiple within configured maximum'});if(!['BUY','SELL'].includes(side)||!['INTRADAY','MARGIN'].includes(productType)||!Number.isFinite(sl)||!Number.isFinite(tp)||sl<=0||tp<=0||Math.abs(sl/meta.tickSize-Math.round(sl/meta.tickSize))>1e-7||Math.abs(tp/meta.tickSize-Math.round(tp/meta.tickSize))>1e-7)return res.status(400).json({error:'Side, product, stop-loss or target tick-size validation failed'});if((side==='BUY'&&!(sl<tick.price&&tp>tick.price))||(side==='SELL'&&!(tp<tick.price&&sl>tick.price)))return res.status(400).json({error:'Stop-loss and target must be on the correct side of the verified live premium'});if(!Number.isFinite(riskInr)||riskInr<=0||riskInr>maxRisk)return res.status(400).json({error:'Estimated stop-loss risk exceeds the configured per-order INR risk limit'});const body={symbol,qty:quantity,type:2,side:side==='BUY'?1:-1,productType,limitPrice:0,stopPrice:0,validity:'DAY',stopLoss:sl,takeProfit:tp,disclosedQty:0,offlineOrder:false,isSliceOrder:false,orderTag:'GV2VPDWS'};usedOrderRequestIds.add(requestId);if(usedOrderRequestIds.size>500)usedOrderRequestIds.delete(usedOrderRequestIds.values().next().value);const task=fyersPost(FYERS_API+'/orders/sync',body);try{const result=await task;res.status(202).json({accepted:true,orderId:result.id||null,message:result.message||'FYERS accepted order request',source:'FYERS sync order API'});}catch(e){res.status(502).json({error:'FYERS order result uncertain/failed; do not retry blindly. Check broker orderbook.',detail:String(e.message||e).slice(0,160)});}});

const server=app.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('GV2VPD Live Workstation listening'));
async function restoreSharedFyersSession(){if(!tokenReader){console.warn('Shared encrypted FYERS token reader is not configured; market stream remains disconnected.');return;}try{const saved=await tokenReader.read();if(!saved){console.warn('No encrypted FYERS session found in shared token store.');return;}accessToken=saved.accessToken;console.log('Existing encrypted FYERS session restored read-only; authenticatedAt='+saved.authenticatedAt);ensureSocket();}catch(error){console.error('Could not restore shared FYERS session:',String(error?.message||error).slice(0,160));}}
void restoreSharedFyersSession();
server.on('error',error=>console.error('Workstation HTTP server error:',error.message));
