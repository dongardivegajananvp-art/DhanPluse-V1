import {createSharedTokenReader} from './token-reader.js';
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require=createRequire(import.meta.url);
const {fyersDataSocket}=require('fyers-api-v3');
const app=express();
app.disable('x-powered-by');
app.use(helmet({contentSecurityPolicy:false}));
app.use(express.json({limit:'32kb'}));
app.use(cors({origin:(origin,cb)=>cb(null,!origin||origin===process.env.APP_ORIGIN)}));
app.use(express.static(new URL('./public',import.meta.url).pathname));

const appId=(process.env.FYERS_APP_ID||'').trim();
const appSecret=(process.env.FYERS_APP_SECRET||'').trim();
const redirectUri=(process.env.FYERS_REDIRECT_URI||'').trim();
const tokenReader=createSharedTokenReader({databaseUrl:process.env.DATABASE_URL,encryptionKey:process.env.FYERS_TOKEN_ENCRYPTION_KEY});
let accessToken='';
let socket=null;
let connected=false;
let selectedSymbol='';
let lastTicks=new Map();
let socketGeneration=0;
const pendingOrders=new Map();

function authReady(){return Boolean(appId&&accessToken);}
function ensureSocket(){
  if(!authReady()||socket)return;
  const owned=fyersDataSocket.getInstance(`${appId}:${accessToken}`,'',false);
  socket=owned; socketGeneration++;
  owned.on('connect',()=>{if(socket!==owned)return;connected=true;try{owned.mode(owned.FullMode);owned.subscribe(['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX',...(selectedSymbol?[selectedSymbol]:[])]);}catch(e){console.error('subscribe failed',e.message);}});
  owned.on('message',raw=>{if(socket!==owned)return;let msg=raw;try{if(typeof raw==='string')msg=JSON.parse(raw);else if(Buffer.isBuffer(raw))msg=JSON.parse(raw.toString('utf8'));}catch{return;}const rows=Array.isArray(msg)?msg:[msg];for(const row of rows){if(!row||typeof row!=='object')continue;const symbol=row.symbol||row.n||row.s;const price=Number(row.ltp??row.lp??row.v?.lp);const stamp=Number(row.exch_feed_time??row.last_traded_time??row.ltt??row.tt??row.ft??row.timestamp??row.v?.exch_feed_time??row.v?.ltt??row.v?.ft);if(!symbol||!Number.isFinite(price)||price<=0||!Number.isFinite(stamp)||stamp<=0)continue;lastTicks.set(symbol,{symbol,price,exchangeTime:stamp,receivedAt:Date.now()});}});
  owned.on('error',e=>{connected=false;console.error('FYERS socket error',String(e?.message||e));});
  owned.on('close',()=>{if(socket!==owned)return;connected=false;});
  const reconnect=typeof owned.autoreconnect==='function'?owned.autoreconnect.bind(owned):typeof owned.autoReconnect==='function'?owned.autoReconnect.bind(owned):null;
  if(!reconnect)throw new Error('FYERS SDK auto-reconnect unavailable');
  reconnect(50);owned.connect();
}
app.get('/api/health',(_req,res)=>res.json({ok:true,authenticated:authReady(),socketConnected:connected,marketData:'exchange-timestamp-required',orderMode:process.env.LIVE_ORDERS_ENABLED==='true'?'LIVE':'DISABLED'}));
app.get('/api/market',(_req,res)=>res.json({connected,quotes:[...lastTicks.values()]}));
app.post('/api/select-symbol',(req,res)=>{const symbol=String(req.body?.symbol||'');if(!/^NSE:[A-Z0-9&_-]+-(EQ|INDEX)$/.test(symbol))return res.status(400).json({error:'Invalid NSE cash/index symbol'});selectedSymbol=symbol;if(socket&&connected)socket.subscribe([symbol]);res.json({selectedSymbol,historyFetch:'on-demand-only'});});
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
app.post('/api/order',async(req,res)=>{if(process.env.LIVE_ORDERS_ENABLED!=='true')return res.status(423).json({error:'Live orders are disabled until broker authentication, risk controls and order tests are complete'});if(!authReady())return res.status(401).json({error:'Connect FYERS first'});const {symbol,side,qty,type,productType,limitPrice,stopLoss,takeProfit,confirm}=req.body||{};if(confirm!==true)return res.status(400).json({error:'Explicit order confirmation required'});if(!/^NSE:[A-Z0-9&_-]+(CE|PE)$/.test(String(symbol))||!['BUY','SELL'].includes(side)||!Number.isInteger(Number(qty))||Number(qty)<1||Number(qty)>Number(process.env.MAX_ORDER_QTY||1))return res.status(400).json({error:'Order validation failed'});return res.status(501).json({error:'Broker order adapter is not enabled in this build; no order was sent'});});
app.get('/api/positions',(_req,res)=>res.json({positions:[],orders:[],source:'FYERS order/position adapter pending'}));
const server=app.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('GV2VPD Live Workstation listening'));\nasync function restoreSharedFyersSession(){if(!tokenReader){console.warn('Shared encrypted FYERS token reader is not configured; market stream remains disconnected.');return;}try{const saved=await tokenReader.read();if(!saved){console.warn('No encrypted FYERS session found in shared token store.');return;}accessToken=saved.accessToken;console.log('Existing encrypted FYERS session restored read-only; authenticatedAt='+saved.authenticatedAt);ensureSocket();}catch(error){console.error('Could not restore shared FYERS session:',String(error?.message||error).slice(0,160));}}\nvoid restoreSharedFyersSession();\nserver.on('error',error=>console.error('Workstation HTTP server error:',error.message));
