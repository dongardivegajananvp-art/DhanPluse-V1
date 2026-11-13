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
let accessToken='';
let socket=null;
let connected=false;
let selectedSymbol='';
let lastTicks=new Map();
let reconnectTimer=null;
let socketGeneration=0;
const pendingOrders=new Map();

function authReady(){return Boolean(appId&&appSecret&&redirectUri&&accessToken);}
function ensureSocket(){
  if(!authReady()||socket)return;
  const owned=fyersDataSocket.getInstance(`${appId}:${accessToken}`,'',false);
  socket=owned; socketGeneration++;
  owned.on('connect',()=>{if(socket!==owned)return;connected=true;try{owned.mode(owned.FullMode);owned.subscribe(['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX',...(selectedSymbol?[selectedSymbol]:[])]);}catch(e){console.error('subscribe failed',e.message);}});
  owned.on('message',msg=>{if(socket!==owned)return;const rows=Array.isArray(msg)?msg:[msg];for(const row of rows){const symbol=row?.symbol||row?.n||row?.s;if(!symbol)continue;const price=Number(row.lp??row.ltp??row.v?.lp);const stamp=Number(row.ft??row.timestamp??row.v?.ft);if(!Number.isFinite(price)||price<=0||!Number.isFinite(stamp))continue;lastTicks.set(symbol,{symbol,price,exchangeTime:stamp,receivedAt:Date.now()});}});
  owned.on('error',e=>{connected=false;console.error('FYERS socket error',String(e?.message||e));});
  owned.on('close',()=>{if(socket!==owned)return;connected=false;socket=null;clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>{reconnectTimer=null;ensureSocket();},5000);});
  const reconnect=typeof owned.autoreconnect==='function'?owned.autoreconnect.bind(owned):typeof owned.autoReconnect==='function'?owned.autoReconnect.bind(owned):null;
  if(!reconnect)throw new Error('FYERS SDK auto-reconnect unavailable');
  reconnect(20);owned.connect();
}
app.get('/api/health',(_req,res)=>res.json({ok:true,authenticated:authReady(),socketConnected:connected,marketData:'exchange-timestamp-required',orderMode:process.env.LIVE_ORDERS_ENABLED==='true'?'LIVE':'DISABLED'}));
app.get('/api/market',(_req,res)=>res.json({connected,quotes:[...lastTicks.values()]}));
app.post('/api/select-symbol',(req,res)=>{const symbol=String(req.body?.symbol||'');if(!/^NSE:[A-Z0-9&_-]+-(EQ|INDEX)$/.test(symbol))return res.status(400).json({error:'Invalid NSE cash/index symbol'});selectedSymbol=symbol;if(socket&&connected)socket.subscribe([symbol]);res.json({selectedSymbol,historyFetch:'on-demand-only'});});
app.get('/api/history',async(req,res)=>{const symbol=String(req.query.symbol||'');if(symbol!==selectedSymbol)return res.status(409).json({error:'Select symbol before requesting history'});if(!authReady())return res.status(401).json({error:'Connect FYERS first'});try{const {fyersData}=require('fyers-api-v3');const api=new fyersData();api.setAppId(appId);api.setRedirectUrl(redirectUri);api.setAccessToken(accessToken);const end=new Date(),start=new Date(end.getTime()-5*24*3600*1000);const result=await api.getHistory({symbol, resolution:'5', date_format:'1', range_from:start.toISOString().slice(0,10), range_to:end.toISOString().slice(0,10), cont_flag:'1'});res.json(result);}catch(e){res.status(502).json({error:'FYERS history request failed',detail:String(e?.message||e).slice(0,180)});}});
app.post('/api/order',async(req,res)=>{if(process.env.LIVE_ORDERS_ENABLED!=='true')return res.status(423).json({error:'Live orders are disabled until broker authentication, risk controls and order tests are complete'});if(!authReady())return res.status(401).json({error:'Connect FYERS first'});const {symbol,side,qty,type,productType,limitPrice,stopLoss,takeProfit,confirm}=req.body||{};if(confirm!==true)return res.status(400).json({error:'Explicit order confirmation required'});if(!/^NSE:[A-Z0-9&_-]+(CE|PE)$/.test(String(symbol))||!['BUY','SELL'].includes(side)||!Number.isInteger(Number(qty))||Number(qty)<1||Number(qty)>Number(process.env.MAX_ORDER_QTY||1))return res.status(400).json({error:'Order validation failed'});return res.status(501).json({error:'Broker order adapter is not enabled in this build; no order was sent'});});
app.get('/api/positions',(_req,res)=>res.json({positions:[],orders:[],source:'FYERS order/position adapter pending'}));
app.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('GV2VPD Live Workstation listening'));
