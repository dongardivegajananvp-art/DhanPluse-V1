import { evaluateThreeCandleBreakout, getCompletedCandleWindow, isFreshExchangeTick, isHistoryCacheFresh } from './chart-safety.js';
import { rememberChartPlan, getRetainedChartPlan } from './chart-plan-cache.js';
import { boundedRetryDelayMs } from './request-retry.js';
const $=id=>document.getElementById(id);
const fmt=n=>Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});
const rememberedMcxSymbol=(()=>{try{const value=localStorage.getItem('gv2vpd.selectedMcxInstrument')||'';return /^MCX:(?:CRUDEOIL|NATURALGAS)\d{2}[A-Z]{3}FUT$/.test(value)?value:''}catch{return ''}})();
let selected='NSE:NIFTY50-INDEX',orderMode='DISABLED',selectedOption=null,optionContracts=[],marketSnapshot=[];
const historyCache=new Map();
let activeChartCandles=[],activeChartSymbol='',lastChartTickStamp=0,chartVisibleCandles=50,chartHasTickGap=false;
let chartLoading=false,chartReady=false,chartLiveOnly=false,serverSelectionApplied=false,accountBusy=false,lastAccountAt=0,accountRetryAt=0,accountFailures=0,accountForcePending=false,chartAttemptedFor='',optionsAttemptedFor='',optionsAttemptedAt=0,chartSelectionId=0;
const chartRetryBySymbol=new Map();
const chartConfirmedPlans=new Map();
let gainerScanResults=[],latestGainers=[],latestGainerError='',lastGainerScanAt=0,gainerScanBusy=false;
let mcxScanBusy=false,mcxScanTimer=null,mcxPickerRequest=0;
let strategyScanBusy=false,lastStrategyScanAt=0;
const indexNames={'NSE:NIFTY50-INDEX':'NIFTY 50','NSE:NIFTYBANK-INDEX':'BANK NIFTY','BSE:SENSEX-INDEX':'SENSEX'};
async function api(path,opts={}){const r=await fetch(path,{headers:{'content-type':'application/json'},...opts});const body=await r.text();let j={};if(body.trim()){try{j=JSON.parse(body)}catch{const error=Error('Invalid JSON response (HTTP '+r.status+')');error.status=r.status;error.retryAfterMs=Number(r.headers.get('retry-after'))*1000||0;throw error}}else if(r.ok){const error=Error('Empty response (HTTP '+r.status+')');error.status=r.status;error.retryAfterMs=Number(r.headers.get('retry-after'))*1000||0;throw error}if(!r.ok){const error=Error(j.detail||j.error||'Request failed (HTTP '+r.status+')');error.status=r.status;error.retryAfterMs=Number(j.retryAfterMs)||Number(r.headers.get('retry-after'))*1000||0;throw error}return j}
function startFyersConnect(){const button=$('fyersConnect');button.disabled=true;button.textContent='OPENING FYERS…';$('feedState').textContent='OPENING FYERS AUTHORIZATION';window.location.assign('/api/fyers/auth/redirect')}
const authUrl=new URL(window.location.href);if(authUrl.searchParams.get('fyers_connected')==='1'){authUrl.searchParams.delete('fyers_connected');history.replaceState({},'',authUrl.pathname+authUrl.search+authUrl.hash);$('feedState').textContent='FYERS LOGIN COMPLETE · VERIFYING FEED';$('fyersConnect').textContent='FYERS CONNECTED · CHECK FEED'}
$('fyersConnect').addEventListener('click',()=>void startFyersConnect());
function rememberedMcxInstrument(){try{const value=localStorage.getItem('gv2vpd.selectedMcxInstrument')||'';return /^MCX:(?:CRUDEOIL|NATURALGAS)\d{2}[A-Z]{3}FUT$/.test(value)?value:''}catch{return ''}}
function updateModeButtons(symbol){const mcx=String(symbol||'').startsWith('MCX:');const nseButton=$('nseMode'),mcxButton=$('mcxMode');if(!nseButton||!mcxButton)return;document.body.classList.toggle('mode-mcx',mcx);document.body.classList.toggle('mode-nse',!mcx);nseButton.textContent=mcx?'NSE MODE OFF':'NSE MODE ON';mcxButton.textContent=mcx?'MCX MODE ON':'MCX MODE OFF';nseButton.classList.toggle('active',!mcx);mcxButton.classList.toggle('active',mcx);nseButton.setAttribute('aria-pressed',String(!mcx));mcxButton.setAttribute('aria-pressed',String(mcx))}
$('nseMode').addEventListener('click',()=>{if(selected!=='NSE:NIFTY50-INDEX')void selectInstrument('NSE:NIFTY50-INDEX','NIFTY 50')});
$('mcxMode').addEventListener('click',()=>{const symbol=selected.startsWith('MCX:')?selected:rememberedMcxInstrument();if(symbol){const label=symbol.startsWith('MCX:CRUDEOIL')?'CRUDE OIL · MCX':'NATURAL GAS · MCX';void selectInstrument(symbol,label)}else{void chooseMcxProduct('CRUDEOIL','CRUDE OIL','chooseCrudeOil',true)}});
const INDEX_TICK_FRESHNESS_MS=40000;function tickAge(t,maxAgeMs=10000){return isFreshExchangeTick(t,Date.now(),maxAgeMs)?'Fresh exchange tick':'Stale · orders blocked'}
function renderIndices(q){const cards=$('indices').querySelectorAll('article');for(let i=0;i<3;i++){const key=Object.keys(indexNames)[i],v=q.find(x=>x.symbol===key),small=cards[i].querySelector('small');if(selected.startsWith('MCX:')){cards[i].querySelector('strong').textContent='—';small.textContent='Paused · MCX-only mode';small.className='index-change unavailable';continue;}cards[i].querySelector('strong').textContent=v?fmt(v.price):'—';const previousClose=Number(v?.previousClose),price=Number(v?.price),valid=Number.isFinite(previousClose)&&previousClose>0&&Number.isFinite(price)&&price>0;if(valid){const change=price-previousClose,pct=change/previousClose*100,sign=change>0?'+':'',status=tickAge(v,INDEX_TICK_FRESHNESS_MS);small.textContent=sign+fmt(change)+' ('+sign+pct.toFixed(2)+'%) · '+status;small.className=change>0?'index-change up':change<0?'index-change down':'index-change flat';}else{small.textContent=(v?tickAge(v)+' · ':'')+'Change % unavailable';small.className='index-change unavailable';}}}
function renderMcxQuote(){const panel=$('mcxQuote'),scanPanel=$('mcxScanPanel');if(!selected.startsWith('MCX:')){panel.hidden=true;scanPanel.hidden=true;return}panel.hidden=false;scanPanel.hidden=false;$('mcxSymbolLabel').textContent=selected;const tick=marketSnapshot.find(x=>x.symbol===selected);if(!tick){$('mcxLtp').textContent='—';$('mcxDailyChange').textContent='Waiting for FYERS MCX tick';$('mcxDailyChange').className='mcx-change unavailable';return}const price=Number(tick.price),previousClose=Number(tick.previousClose);$('mcxLtp').textContent=Number.isFinite(price)&&price>0?fmt(price):'—';const freshness=tickAge(tick);if(Number.isFinite(previousClose)&&previousClose>0&&Number.isFinite(price)&&price>0){const change=price-previousClose,pct=change/previousClose*100,sign=change>0?'+':'';$('mcxDailyChange').textContent=sign+fmt(change)+' ('+sign+pct.toFixed(2)+'%) · '+freshness;$('mcxDailyChange').className='mcx-change '+(change>0?'up':change<0?'down':'flat')}else{$('mcxDailyChange').textContent='Change % unavailable · '+freshness;$('mcxDailyChange').className='mcx-change unavailable'}}
function renderGainers(rows,error){
 const root=$('gainers');root.replaceChildren();const liveRows=(rows||[]).filter(r=>r.fresh===true);
 if(!liveRows.length){const span=document.createElement('span');span.textContent=error||((rows||[]).length?'Waiting for fresh FYERS futures ticks':'No verified F&O gainer data');root.append(span);return}
 for(const [rank,r] of liveRows.entries()){
  const card=document.createElement('button');card.type='button';card.className='gainer-card gainer-rank-'+(rank+1);
  const name=String(r.underlying||r.symbol).replace(/^NSE:/,'').replace(/-EQ$/,'').replace(/\d{2}[A-Z0-9]+FUT$/,'');
  const scan=gainerScanResults.find(x=>x.underlying===r.underlying);let label='BREAKOUT SCAN PENDING';
  if(scan?.status==='SETUP_CONFIRMED')label='UNDERLYING '+scan.side+' WATCH · E '+fmt(scan.entry)+' · SL '+fmt(scan.stopLoss)+' · T '+fmt(scan.target);
  else if(scan?.status==='WAIT')label='WAIT · NO CONFIRMED BREAKOUT';
  else if(scan?.status)label=scan.status.replaceAll('_',' ');
  card.textContent=name+' · '+fmt(r.price)+' · '+(r.change>=0?'+':'')+Number(r.change).toFixed(2)+'% · LIVE TICK · '+label;
  card.title=scan?.reason||'Underlying cash-equity breakout watch only; not an option-entry confirmation. The 9-strategy scanner must independently verify the exact option contract, fresh premium and 1:2 risk plan.';
  card.addEventListener('click',()=>{const chartSymbol=r.underlying||r.symbol;const chartSelect=$('symbol');let option=[...chartSelect.options].find(o=>o.value===chartSymbol);if(!option){option=new Option(name,chartSymbol);chartSelect.add(option)}chartSelect.value=chartSymbol;void selectInstrument(chartSymbol,name,r.underlying||'')});
  root.append(card);
 }
}
async function refreshGainerScan(){
 if(gainerScanBusy||Date.now()-lastGainerScanAt<60000||!latestGainers.some(r=>r.fresh===true))return;
 gainerScanBusy=true;lastGainerScanAt=Date.now();
 try{const data=await api('/api/gainer-scan');gainerScanResults=data.results||[];renderGainers(latestGainers,latestGainerError)}
 catch(e){gainerScanResults=latestGainers.filter(r=>r.fresh===true).map(r=>({underlying:r.underlying,status:'DATA_UNAVAILABLE_NO_TRADE',reason:e.message}));renderGainers(latestGainers,latestGainerError)}
 finally{gainerScanBusy=false}
}
function render(q){renderIndices(q);renderMcxQuote();updateChartQuote();updatePremium();updateLiveChartFromTick();if(chartReady&&activeChartSymbol===selected)updateChartPlan();const mcxMode=selected.startsWith('MCX:'),required=mcxMode?[selected]:Object.keys(indexNames),freshCount=required.filter(symbol=>isFreshExchangeTick(q.find(x=>x.symbol===symbol),Date.now(),mcxMode?10000:INDEX_TICK_FRESHNESS_MS)).length;$('feedState').textContent=mcxMode?'FYERS MCX FEED · '+freshCount+'/1 FRESH':'FYERS INDEX FEED · '+freshCount+'/3 FRESH';$('dot').style.background=freshCount===required.length?'#42d6a0':'#d69b39'}
async function refreshAccount({force=false}={}){const now=Date.now();if(accountBusy){if(force)accountForcePending=true;return}if(now<accountRetryAt||(!force&&now-lastAccountAt<60000))return;accountBusy=true;lastAccountAt=now;try{const a=await api('/api/account'+(force?'?refresh=1':''));const open=(a.positions||[]).filter(p=>Number(p.netQty)!==0);$('openCount').textContent=String(open.length);$('pnl').textContent=fmt(Number(a.overall?.pl_total??open.reduce((n,p)=>n+Number(p.pl||0),0)));const statusNames={1:'CANCELLED',2:'FILLED',4:'IN TRANSIT',5:'REJECTED',6:'PENDING',7:'EXPIRED'};$('orderState').textContent=(a.orders||[]).slice(0,1).map(o=>statusNames[Number(o.status)]||o.message||'ORDER BOOK UPDATED').join('')||'NO OPEN ORDER';$('brokerUpdate').textContent=(a.stale?'STALE · ':'')+new Date(a.updatedAt).toLocaleTimeString('en-IN');if(a.stale){accountFailures=Math.min(accountFailures+1,5);accountRetryAt=Date.now()+boundedRetryDelayMs({attempt:accountFailures,retryAfterMs:a.retryAfterMs,baseMs:10000,maxMs:300000});$('orderState').textContent='BROKER DATA STALE · LAST VERIFIED SNAPSHOT'}else{accountFailures=0;accountRetryAt=0}const rows=$('positionRows');rows.replaceChildren();if(!open.length){rows.textContent='No open FYERS positions.'}else for(const p of open){const line=document.createElement('div');line.className='position-row';line.textContent=[p.symbol,'Qty '+p.netQty,'Avg '+fmt(p.netAvg||p.avgPrice||0),'LTP '+fmt(p.ltp||0),'P&L '+fmt(p.pl||0)].join(' · ');rows.append(line)}}catch(e){accountFailures=Math.min(accountFailures+1,5);accountRetryAt=Date.now()+boundedRetryDelayMs({attempt:accountFailures,retryAfterMs:e.retryAfterMs,baseMs:10000,maxMs:300000});$('orderState').textContent='BROKER SYNC ERROR · RETRY '+Math.ceil((accountRetryAt-Date.now())/1000)+'s';$('positionRows').textContent=e.message}finally{accountBusy=false;if(accountForcePending){accountForcePending=false;void refreshAccount({force:true})}}}

function renderStrategyScanner(data){
 const coverage=$('strategyCoverage'),results=$('strategyResults'),active=$('activeStrategyPlans');
 const session=data.marketSession||'UNKNOWN';
 const regime=data.marketRegime||{};
 const mood='MARKET MOOD '+String(regime.state||'UNAVAILABLE')+(regime.reason?' · '+String(regime.reason).slice(0,72):'');
 coverage.textContent=mood+' · '+(data.marketPhaseLabel||('SESSION '+session))+' · F&O UNIVERSE '+Number(data.universeCount||0)+' · CURRENT FUTURES WINDOW '+Number(data.activeFutureSubscriptions||0)+'/'+Number(data.subscriptionLimit||100)+' · PENDING OPTION CHECKS '+Number(data.pendingOptionChecks||0)+' · PREWARMED OPTIONS '+Number(data.prewarmedOptionSubscriptions||0)+' · ACTIVE PLANS '+(data.activePlans||[]).length+'/2'+(data.lastScannedFuture?' · LAST '+data.lastScannedFuture:'')+(data.lastError?' · '+data.lastError:'');
 results.replaceChildren();
 const rows=Array.isArray(data.topSetups)?data.topSetups:[];
 if(!rows.length){const card=document.createElement('article');card.className='strategy-result';card.textContent=session==='OPEN'?'No confirmed setup yet. Waiting for verified futures ticks, completed candles and option confirmation.':session==='PRE-OPEN'?'PRE-OPEN · Indicative market data only. Nine-strategy scan and live orders are disabled until 09:15.':'MARKET CLOSED · Live scan paused. Last-known prices cannot create a live signal.';results.append(card)}
 for(let index=0;index<rows.length;index++){
  const item=rows[index];
  const card=document.createElement('article');card.className='strategy-result';
  const title=document.createElement('b');title.textContent=(index===0&&item.status==='PLAN_CONFIRMED_READ_ONLY'?'#1 BEST SETUP · ':'#'+(index+1)+' · ')+(item.strategy||'STRATEGY CHECK').replaceAll('_',' ')+' · '+String(item.status||'WAIT').replaceAll('_',' ');
  const detail=document.createElement('span');
  const contract=item.contract?item.contract+' · '+(item.optionSide||'')+' · '+(item.expiry||'')+' · STRIKE '+(item.strike??'—'):'';
  const levels=item.entry!==undefined?'PREMIUM '+fmt(item.premium)+' · ENTRY '+fmt(item.entry)+' · SL '+fmt(item.stopLoss)+' · TARGET '+fmt(item.target)+' · RR '+item.rr+(item.verifiedAt?' · '+new Date(item.verifiedAt).toLocaleTimeString('en-IN'):''):'';
  detail.textContent=[item.underlying||item.futureSymbol||'',contract,levels,item.reason||''].filter(Boolean).join(' | ');
  card.append(title,detail);results.append(card);
 }
 active.replaceChildren();
 const plans=Array.isArray(data.activePlans)?data.activePlans:[];
 if(!plans.length){const card=document.createElement('article');card.className='strategy-result';card.textContent='No active persisted strategy plan.';active.append(card)}
 for(const plan of plans){
  const card=document.createElement('article');card.className='strategy-result';
  const title=document.createElement('b');title.textContent=String(plan.strategy||'STRATEGY').replaceAll('_',' ')+' · '+(plan.underlying||'');
  const detail=document.createElement('span');detail.textContent=[plan.lifecycleState||'ACTIVE',plan.lifecycleReason,plan.contract,plan.option_side,plan.expiry,'STRIKE '+plan.strike,'PREMIUM '+fmt(plan.premium),'ENTRY '+fmt(plan.entry),'SL '+fmt(plan.stop_loss),'TARGET '+fmt(plan.target),'RR '+plan.rr].filter(Boolean).join(' | ');
  card.append(title,detail);active.append(card);
 }
 const terminal=Array.isArray(data.terminalPlans)?data.terminalPlans:[];
 for(const plan of terminal){
  const card=document.createElement('article');card.className='strategy-result';
  const title=document.createElement('b');title.textContent='HISTORY · '+String(plan.status||'CLOSED').replaceAll('_',' ')+' · '+(plan.underlying||'');
  const detail=document.createElement('span');detail.textContent=[plan.strategy,plan.contract,plan.option_side,plan.expiry,'STRIKE '+plan.strike,'ENTRY '+fmt(plan.entry),'SL '+fmt(plan.stop_loss),'TARGET '+fmt(plan.target),'RR '+plan.rr,plan.hitPrice?'HIT PRICE '+fmt(plan.hitPrice):'',plan.closed_at?'AT '+new Date(plan.closed_at).toLocaleString('en-IN'):''].filter(Boolean).join(' | ');
  card.append(title,detail);active.append(card);
 }
}
async function refreshStrategyScanner(){
 if(strategyScanBusy||Date.now()-lastStrategyScanAt<10000)return;
 strategyScanBusy=true;lastStrategyScanAt=Date.now();
 try{const data=await api('/api/strategy-scan');renderStrategyScanner(data)}
 catch(error){const root=$('strategyCoverage');if(root)root.textContent='SCANNER STATUS UNAVAILABLE · '+error.message}
 finally{strategyScanBusy=false}
}

async function poll(){const [marketResult,healthResult]=await Promise.allSettled([api('/api/market'),api('/api/health')]);if(healthResult.status==='rejected'){$('feedState').textContent='BACKEND DISCONNECTED · '+healthResult.reason.message;$('dot').style.background='#e45d68'}else{const h=healthResult.value;updateModeButtons(h.selectedSymbol||selected);if(!serverSelectionApplied){serverSelectionApplied=true;const serverSymbol=String(h.selectedSymbol||'').trim().toUpperCase();if(/^MCX:(?:CRUDEOIL|NATURALGAS)\d{2}[A-Z]{3}FUT$/.test(serverSymbol)){const label=serverSymbol.startsWith('MCX:CRUDEOIL')?'CRUDE OIL · MCX':'NATURAL GAS · MCX';if(![...$('symbol').options].some(o=>o.value===serverSymbol))$('symbol').add(new Option(label,serverSymbol));$('symbol').value=serverSymbol;void selectInstrument(serverSymbol,label)}}orderMode=h.orderMode||'DISABLED';updateOrderGate();if(h.authenticated)void refreshStrategyScanner();const chartRetry=chartRetryBySymbol.get(selected);if(h.authenticated&&!chartReady&&!chartLoading&&chartAttemptedFor!==selected&&(!chartRetry||Date.now()>=chartRetry.retryAt))void selectInstrument(selected);if(h.authenticated&&!optionContracts.length&&(optionsAttemptedFor!==$('optionUnderlying').value||Date.now()-optionsAttemptedAt>=60000))void loadOptions($('optionUnderlying').value);if(h.authenticated)void refreshAccount()}if(marketResult.status==='fulfilled'){const j=marketResult.value;marketSnapshot=j.quotes||[];render(marketSnapshot);latestGainers=j.gainers||[];latestGainerError=j.error||'';renderGainers(latestGainers,latestGainerError);void refreshGainerScan()}else if(healthResult.status==='fulfilled'){$('feedState').textContent='BACKEND ONLINE · MARKET DATA UNAVAILABLE · '+marketResult.reason.message;$('dot').style.background='#d69b39'}if(healthResult.status==='fulfilled'&&!healthResult.value.socketConnected){const socketError=String(healthResult.value.lastSocketError||'');const expired=/expired token|failed to decode jwt/i.test(socketError);$('feedState').textContent=expired?'FYERS TOKEN EXPIRED · RECONNECT REQUIRED':'FYERS WEBSOCKET DISCONNECTED · '+(socketError||'WAITING FOR SOCKET');$('dot').style.background='#d69b39';if(expired){$('fyersConnect').disabled=false;$('fyersConnect').textContent='RECONNECT FYERS'}}$('clock').textContent=new Date().toLocaleTimeString('en-IN')}
function clearChartLevels(message){$('entryLine').textContent='—';$('slLine').textContent='—';$('targetLine').textContent='—';$('chartSignal').textContent=message;}
function updateChartQuote(){const tick=marketSnapshot.find(x=>x.symbol===selected),price=Number(tick?.price),valid=Number.isFinite(price)&&price>0,stamp=Number(tick?.exchangeTime),dateText=Number.isFinite(stamp)&&stamp>0?new Date(stamp*1000).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true}):'Exchange timestamp unavailable';$('chartInstrument').textContent=selected;$('chartLtp').textContent=valid?fmt(price):'LTP unavailable';$('chartLtpStatus').textContent=valid?tickAge(tick).toUpperCase():'NO VERIFIED FYERS TICK';$('chartLtpStatus').className='chart-quote-status '+(valid&&tickAge(tick)==='Fresh exchange tick'?'fresh':'stale');$('chartExchangeTime').textContent=valid?dateText:'No genuine last-known tick in current FYERS session';if(!activeChartCandles.length)$('chartReferenceClose').textContent='Waiting for verified candles';}
function isChartDataGap(previousTime,currentTime){
 const previous=Number(previousTime),current=Number(currentTime);
 if(!Number.isFinite(previous)||!Number.isFinite(current)||current-previous<=300)return false;
 // NSE/BSE overnight, weekend and exchange-closed periods are expected gaps, not missing intraday candles.
 if(!/^(NSE|BSE):/.test(activeChartSymbol))return true;
 const before=new Date(previous*1000),after=new Date(current*1000);
 if(before.toDateString()!==after.toDateString())return false;
 const weekday=before.getDay(),beforeMinute=before.getHours()*60+before.getMinutes(),afterMinute=after.getHours()*60+after.getMinutes();
 return weekday!==0&&weekday!==6&&beforeMinute>=555&&beforeMinute<=925&&afterMinute>=555&&afterMinute<=930;
}
function drawCandles(candles,plan=null){
 const el=$('chart');
 if(!Array.isArray(candles)||!candles.length){el.textContent='No verified candles returned by FYERS.';return}
 const levels=plan?[{label:'ENTRY',value:plan.entry},{label:'SL',value:plan.sl},{label:'TARGET',value:plan.target}]:[];
 const liveTick=marketSnapshot.find(x=>x.symbol===activeChartSymbol);
 const liveFresh=Boolean(liveTick&&tickAge(liveTick)==='Fresh exchange tick');
 const liveBucket=liveFresh?Math.floor(Number(liveTick.exchangeTime)/300)*300:0;
 const liveCandle=Boolean(liveFresh&&candles[candles.length-1].time===liveBucket);
 const completed=liveCandle?candles.slice(0,-1):candles;
 const visible=candles.slice(-chartVisibleCandles);
 const zoneSource=completed.slice(-20);
 const supplyCandle=zoneSource.length?zoneSource.reduce((a,b)=>b.high>a.high?b:a):null;
 const demandCandle=zoneSource.length?zoneSource.reduce((a,b)=>b.low<a.low?b:a):null;
 const supplyTop=supplyCandle?Number(supplyCandle.high):null;
 const supplyBottom=supplyCandle?Math.max(Number(supplyCandle.open),Number(supplyCandle.close)):null;
 const demandBottom=demandCandle?Number(demandCandle.low):null;
 const demandTop=demandCandle?Math.min(Number(demandCandle.open),Number(demandCandle.close)):null;
 const zoneValues=[supplyTop,supplyBottom,demandTop,demandBottom].filter(Number.isFinite);
 const pad=46,h=410,step=Math.max(8,Math.min(22,Math.floor(900/Math.max(visible.length,1)))),body=Math.max(4,Math.min(12,Math.floor(step*.55))),w=Math.max(640,pad*2+visible.length*step,el.clientWidth||800),plotH=h-pad*2-24,plotW=w-pad*2;
 const ltpTick=marketSnapshot.find(x=>x.symbol===activeChartSymbol),ltpValue=Number(ltpTick?.price),hasLtp=Number.isFinite(ltpValue)&&ltpValue>0;const lo=Math.min(...visible.map(c=>c.low),...levels.map(x=>x.value),...zoneValues,...(hasLtp?[ltpValue]:[]));
 const hi=Math.max(...visible.map(c=>c.high),...levels.map(x=>x.value),...zoneValues,...(hasLtp?[ltpValue]:[]));
 const range=Math.max(hi-lo,0.01),y=v=>pad+(hi-v)/range*plotH;
 el.style.display='block';el.style.overflowX='auto';el.style.overflowY='hidden';el.style.height=h+'px';el.style.minHeight=h+'px';
 let svg='<svg viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'" style="display:block;width:'+w+'px;height:'+h+'px;max-width:none" role="img" aria-label="FYERS five minute candlestick chart; latest 50 candles shown with horizontal scrolling"><defs><marker id="entry-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L9 4.5 L0 9 Z" fill="#3b82f6"/></marker><marker id="sl-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L9 4.5 L0 9 Z" fill="#ef4444"/></marker><marker id="target-arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L9 4.5 L0 9 Z" fill="#22c55e"/></marker></defs>';
 for(let i=0;i<5;i++){const yy=pad+i*plotH/4,val=hi-i*range/4;svg+='<line x1="'+pad+'" y1="'+yy+'" x2="'+(w-pad)+'" y2="'+yy+'" stroke="#263449"/><text x="4" y="'+(yy+4)+'" fill="#8ea0b8" font-size="10">'+fmt(val)+'</text>'}
 if(supplyCandle&&supplyTop>supplyBottom){const top=y(supplyTop),bottom=y(supplyBottom);svg+='<rect x="'+pad+'" y="'+top+'" width="'+plotW+'" height="'+Math.max(1,bottom-top)+'" fill="#ef6672" fill-opacity=".13" stroke="#ef6672" stroke-opacity=".75" stroke-dasharray="5 3"/><text x="'+(w-pad-5)+'" y="'+(top+12)+'" text-anchor="end" fill="#ef8a92" font-size="11">SUPPLY ZONE</text>'}
 if(demandCandle&&demandTop>demandBottom){const top=y(demandTop),bottom=y(demandBottom);svg+='<rect x="'+pad+'" y="'+top+'" width="'+plotW+'" height="'+Math.max(1,bottom-top)+'" fill="#35c995" fill-opacity=".13" stroke="#35c995" stroke-opacity=".75" stroke-dasharray="5 3"/><text x="'+(w-pad-5)+'" y="'+(bottom-4)+'" text-anchor="end" fill="#55d9a8" font-size="11">DEMAND ZONE</text>'}
 visible.forEach((c,i)=>{const x=pad+i*step+step/2,up=c.close>=c.open,col=up?'#35c995':'#ef6672',top=y(Math.max(c.open,c.close)),bh=Math.max(2,Math.abs(y(c.open)-y(c.close))),stamp=new Date(Number(c.time)*1000).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true});if(i>0&&isChartDataGap(visible[i-1].time,c.time)){const gapX=x-step/2;svg+='<line x1="'+gapX+'" y1="'+pad+'" x2="'+gapX+'" y2="'+(h-pad-24)+'" stroke="#e5ad55" stroke-width="1.5" stroke-dasharray="4 4"/><text x="'+(gapX-3)+'" y="'+(pad+14)+'" text-anchor="end" fill="#e5ad55" font-size="10">DATA GAP</text>'}svg+='<g><title>'+stamp+' · O '+fmt(c.open)+' · H '+fmt(c.high)+' · L '+fmt(c.low)+' · C '+fmt(c.close)+'</title><line x1="'+x+'" y1="'+y(c.high)+'" x2="'+x+'" y2="'+y(c.low)+'" stroke="'+col+'" stroke-width="2"/><rect x="'+(x-body/2)+'" y="'+top+'" width="'+body+'" height="'+bh+'" rx="1" fill="'+col+'"/></g>'});
 if(hasLtp){const yy=y(ltpValue),fresh=tickAge(ltpTick)==='Fresh exchange tick',color=fresh?'#45d6aa':'#e5ad55';svg+='<line x1="'+pad+'" y1="'+yy+'" x2="'+(w-pad)+'" y2="'+yy+'" stroke="'+color+'" stroke-width="1.5" stroke-dasharray="3 4"/><text x="'+(w-pad-4)+'" y="'+(yy-6)+'" text-anchor="end" fill="'+color+'" font-size="11" font-weight="bold">'+(fresh?'LIVE LTP ':'LAST LTP ')+fmt(ltpValue)+'</text>'}if(plan){for(const item of levels){const yy=y(item.value),color=item.label==='ENTRY'?'#3b82f6':item.label==='SL'?'#ef4444':'#22c55e',marker=item.label==='ENTRY'?'entry-arrow':item.label==='SL'?'sl-arrow':'target-arrow';const arrowEnd=w-pad-112;svg+='<line x1="'+pad+'" y1="'+yy+'" x2="'+arrowEnd+'" y2="'+yy+'" stroke="'+color+'" stroke-width="2.8" marker-end="url(#'+marker+')"/><rect x="'+(w-pad-104)+'" y="'+(yy-11)+'" width="104" height="22" rx="5" fill="'+color+'" fill-opacity=".16" stroke="'+color+'" stroke-opacity=".9"/><text x="'+(w-pad-52)+'" y="'+(yy+4)+'" text-anchor="middle" fill="'+color+'" font-size="11" font-weight="bold">'+item.label+' '+fmt(item.value)+'</text>'}}
 for(let i=0;i<Math.min(5,visible.length);i++){const index=Math.round(i*(visible.length-1)/Math.max(1,Math.min(5,visible.length)-1)),c=visible[index],x=pad+index*step+step/2,dt=new Date(Number(c.time)*1000),date=dt.toLocaleDateString('en-IN',{day:'2-digit',month:'short'}),time=dt.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true});svg+='<text x="'+x+'" y="'+(h-19)+'" text-anchor="middle" fill="#b3c1d2" font-size="11"><tspan x="'+x+'">'+date+'</tspan><tspan x="'+x+'" dy="13">'+time+'</tspan></text>'}
 if(liveCandle)svg+='<text x="'+(w-pad-4)+'" y="15" text-anchor="end" fill="#35c995" font-size="11" font-weight="bold">● LIVE 5M CANDLE</text>';
 else svg+='<text x="'+(w-pad-4)+'" y="15" text-anchor="end" fill="#8ea0b8" font-size="11">LAST VERIFIED CANDLES</text>';
 svg+='</svg>';el.innerHTML=svg;const last=visible[visible.length-1],lastStamp=last?new Date(Number(last.time)*1000).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}):'—';$('chartLastCandleTime').textContent='Last candle: '+lastStamp;$('chartZoomLevel').textContent=chartVisibleCandles+' candles';const referenceTick=marketSnapshot.find(x=>x.symbol===selected),referenceExchangeTime=Number(referenceTick?.exchangeTime),currentBucket=Number.isFinite(referenceExchangeTime)&&referenceExchangeTime>0?Math.floor(referenceExchangeTime/300)*300:null;const completedReference=currentBucket===null?candles.at(-1):candles.filter(c=>Number(c.time)<currentBucket).at(-1);const referenceStamp=completedReference?new Date(Number(completedReference.time)*1000).toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}):'';$('chartReferenceClose').textContent=completedReference?fmt(completedReference.close)+' · '+referenceStamp:'No verified completed candle close';
}
function renderRetainedChartPlan(plan,status){
 $('entryLine').textContent=fmt(plan.entry);$('slLine').textContent=fmt(plan.stopLoss);$('targetLine').textContent=fmt(plan.target);
 const confirmedAt=new Date(plan.confirmedAt).toLocaleTimeString('en-IN');
 $('chartSignal').textContent='LAST CONFIRMED '+plan.side+' SETUP · '+plan.confirmationType.replaceAll('_',' ')+' · '+confirmedAt+' · '+status+' · LEVELS RETAINED · NO NEW TRADE';
 drawCandles(activeChartCandles,{side:plan.side,entry:plan.entry,sl:plan.stopLoss,target:plan.target});
}
function retainOrClearChartPlan(status,fallback){
 const retained=getRetainedChartPlan(chartConfirmedPlans,activeChartSymbol,Date.now());
 if(retained){renderRetainedChartPlan(retained,status);return}
 clearChartLevels(fallback);drawCandles(activeChartCandles);
}
function updateChartPlan(){
 if(chartLiveOnly){clearChartLevels(chartHasTickGap?'NO TRADE · provisional live-only candles retained across FYERS tick gaps; missing intervals are not fabricated':'NO TRADE · REST history unavailable; live-only candles are provisional');drawCandles(activeChartCandles);return}
 if(!activeChartCandles.length||activeChartSymbol!==selected){clearChartLevels('Waiting for verified 5-minute candles');return}
 const tick=marketSnapshot.find(x=>x.symbol===activeChartSymbol);
 if(!tick||tickAge(tick)!=='Fresh exchange tick'){retainOrClearChartPlan('UNDERLYING TICK STALE · DISPLAY ONLY','NO TRADE · underlying exchange tick is not fresh');return}
 const {completed,fresh,contiguous}=getCompletedCandleWindow(activeChartCandles,tick.exchangeTime,600,2);
 if(!fresh){retainOrClearChartPlan('COMPLETED CANDLE STALE · DISPLAY ONLY','NO TRADE · latest completed 5-minute candle is stale');return}
 if(completed.length<2){retainOrClearChartPlan('WAITING FOR BREAKOUT CANDLE · DISPLAY ONLY','WAIT · need reference + one completed breakout candle');return}
 if(!contiguous){retainOrClearChartPlan('CANDLE GAP · DISPLAY ONLY','NO TRADE · latest two reference/breakout candles are not contiguous');return}
 const plan=evaluateThreeCandleBreakout(completed,Number(tick.price));
 if(plan.status!=='SETUP_CONFIRMED'||plan.target<=0){retainOrClearChartPlan('CURRENT BREAKOUT NOT RECONFIRMED · DISPLAY ONLY','WAIT · '+(plan.reason||'no one-candle breakout confirmation')+' · NO TRADE');return}
 const confirmed=rememberChartPlan(chartConfirmedPlans,activeChartSymbol,{side:plan.side,entry:plan.entry,stopLoss:plan.stopLoss,target:plan.target,confirmationType:plan.confirmationType},Date.now());
 $('entryLine').textContent=fmt(confirmed.entry);$('slLine').textContent=fmt(confirmed.stopLoss);$('targetLine').textContent=fmt(confirmed.target);
 $('chartSignal').textContent='FYERS 5-MIN '+confirmed.side+' '+confirmed.confirmationType.replaceAll('_',' ')+' · '+confirmed.confirmationType.replaceAll('_',' ')+' · RR 1:2 · CONFIRMED '+new Date(confirmed.confirmedAt).toLocaleTimeString('en-IN');
 drawCandles(activeChartCandles,{side:confirmed.side,entry:confirmed.entry,sl:confirmed.stopLoss,target:confirmed.target});
}
function updateLiveChartFromTick(){if(!chartReady||activeChartSymbol!==selected)return;const tick=marketSnapshot.find(x=>x.symbol===activeChartSymbol);if(!tick||tickAge(tick)!=='Fresh exchange tick'||Number(tick.exchangeTime)<=lastChartTickStamp)return;const stamp=Number(tick.exchangeTime),bucket=Math.floor(stamp/300)*300,price=Number(tick.price);if(!Number.isFinite(price)||price<=0)return;const receiveGap=lastChartTickStamp>0?stamp-lastChartTickStamp:0;if(chartLiveOnly&&receiveGap>10)chartHasTickGap=true;let last=activeChartCandles[activeChartCandles.length-1];if(!last){if(!chartLiveOnly)return;activeChartCandles=[{time:bucket,open:price,high:price,low:price,close:price,volume:0}];last=activeChartCandles[0]}if(bucket<last.time)return;if(bucket===last.time){last.high=Math.max(last.high,price);last.low=Math.min(last.low,price);last.close=price;}else{if(chartLiveOnly&&bucket>last.time+300)chartHasTickGap=true;activeChartCandles.push({time:bucket,open:price,high:price,low:price,close:price,volume:0});if(activeChartCandles.length>300)activeChartCandles.shift();}lastChartTickStamp=stamp;updateChartPlan();}
function clearOptionSelection(message='Select a supported NSE/BSE underlying first'){const underlying=$('optionUnderlying');if(underlying){if(![...underlying.options].some(o=>o.value===''))underlying.add(new Option('Not available for this instrument',''),0);underlying.value='';underlying.disabled=true}selectedOption=null;optionContracts=[];optionsAttemptedFor='';optionsAttemptedAt=0;const contract=$('contract');contract.replaceChildren(new Option(message,''));contract.disabled=true;$('premium').textContent='—';updateOrderGate()}
function inferredOptionUnderlying(symbol){if(symbol.startsWith('MCX:'))return '';if(['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'].includes(symbol))return symbol;if(/^(NSE|BSE):[A-Z0-9&_.-]+-EQ$/.test(symbol))return symbol;return ''}
function syncOptionUnderlying(underlying){if(!underlying){clearOptionSelection('MCX / unsupported instrument · NSE/BSE options blocked');return}const select=$('optionUnderlying');let option=[...select.options].find(o=>o.value===underlying);if(!option){const label=underlying.replace(/^NSE:/,'').replace(/^BSE:/,'').replace(/-EQ$/,'').replace('-INDEX','');option=new Option(label,underlying);select.add(option)}select.disabled=false;select.value=underlying;if(optionsAttemptedFor!==underlying||(!optionContracts.length&&Date.now()-optionsAttemptedAt>=60000))void loadOptions(underlying)}
async function selectInstrument(symbol,label,optionUnderlyingOverride){try{if(/^MCX:(?:CRUDEOIL|NATURALGAS)\d{2}[A-Z]{3}FUT$/.test(symbol))localStorage.setItem('gv2vpd.selectedMcxInstrument',symbol)}catch{}const selectionId=++chartSelectionId;chartLoading=true;const isMcx=symbol.startsWith('MCX:');chartReady=isMcx;selected=symbol;activeChartSymbol=symbol;activeChartCandles=[];lastChartTickStamp=0;chartHasTickGap=false;chartLiveOnly=isMcx;clearChartLevels('Loading verified FYERS 5-minute candles');chartAttemptedFor=symbol;syncOptionUnderlying(optionUnderlyingOverride===undefined?inferredOptionUnderlying(symbol):optionUnderlyingOverride);$('chartTitle').textContent='CHART · '+(label||$('symbol').selectedOptions[0]?.text||symbol);$('chartInstrument').textContent=symbol;$('chartLtp').textContent='Loading FYERS quote…';$('chartLtpStatus').textContent='VERIFYING';$('chartExchangeTime').textContent='Waiting for exchange timestamp';$('chartReferenceClose').textContent='Waiting for verified candles';chartVisibleCandles=50;$('chart').textContent=isMcx?'WAITING FOR FRESH FYERS MCX WEBSOCKET TICK · PROVISIONAL 5M · NO TRADE':'Loading FYERS 5-minute history…';if(isMcx){clearChartLevels('NO TRADE · provisional MCX candle requires a fresh exchange-timestamped WebSocket tick');updateLiveChartFromTick()}try{await api('/api/select-symbol',{method:'POST',body:JSON.stringify({symbol})});if(selectionId!==chartSelectionId)return;let data=historyCache.get(symbol);if(!data||!isHistoryCacheFresh(data.fetchedAt)){data=await api('/api/history?symbol='+encodeURIComponent(symbol));historyCache.set(symbol,data)}if(selectionId!==chartSelectionId)return;activeChartCandles=data.candles.map(c=>({...c}));chartLiveOnly=false;chartRetryBySymbol.delete(symbol);chartReady=true;updateLiveChartFromTick();updateChartPlan();if(symbol.startsWith('MCX:'))setTimeout(()=>scanMcxBestSetup(),1200);else{if(mcxScanTimer)clearTimeout(mcxScanTimer);mcxScanTimer=null;showMcxScanMessage('Select Crude Oil or Natural Gas to scan MCX options')}}catch(err){if(selectionId!==chartSelectionId)return;if(symbol.startsWith('MCX:')){chartLiveOnly=true;activeChartCandles=[];lastChartTickStamp=0;chartHasTickGap=false;chartReady=true;chartRetryBySymbol.delete(symbol);chartAttemptedFor=symbol;$('chart').textContent='FYERS REST HISTORY UNAVAILABLE · BUILDING PROVISIONAL LIVE-ONLY 5M CANDLE FROM EXCHANGE-TIMESTAMPED WEBSOCKET TICKS · NO TRADE';clearChartLevels('NO TRADE · REST history unavailable; waiting for fresh MCX WebSocket ticks');updateLiveChartFromTick()}else{const previous=chartRetryBySymbol.get(symbol),attempts=(previous?.attempts||0)+1,delay=boundedRetryDelayMs({attempt:attempts,retryAfterMs:err.retryAfterMs});chartRetryBySymbol.set(symbol,{attempts,retryAt:Date.now()+delay});chartAttemptedFor='';$('chart').textContent=err.message+' · retry in '+Math.ceil(delay/1000)+'s';clearChartLevels('NO TRADE · chart history unavailable; retry scheduled')}}finally{if(selectionId===chartSelectionId)chartLoading=false}}
function showMcxScanMessage(message){const root=$('mcxSetup');root.replaceChildren();const line=document.createElement('div');line.textContent=message;root.append(line)}
function renderMcxSetup(data){
 const root=$('mcxSetup');root.replaceChildren();
 const heading=document.createElement('b');heading.textContent=data.label||'STRONGEST VERIFIED MCX RULE-MATCH';root.append(heading);
 const rows=[
  ['Contract',data.contract.symbol],
  ['Direction',data.contract.side+' · '+data.underlyingSide],
  ['Expiry / Strike',data.contract.expiry+' · '+fmt(data.contract.strike)],
  ['Live premium',fmt(data.premium)],
  ['Entry',fmt(data.entry)],
  ['Stop loss',fmt(data.stopLoss)],
  ['Target',fmt(data.target)],
  ['Risk : Reward','1 : '+Number(data.rr).toFixed(2)]
 ];
 for(const [label,value] of rows){const line=document.createElement('div');line.className='mcx-setup-row';const key=document.createElement('span');key.textContent=label;const val=document.createElement('strong');val.textContent=value;line.append(key,val);root.append(line)}
 const note=document.createElement('small');note.textContent='FYERS verified nine-strategy setup · persistent read-only plan '+(data.planId||'')+' · order gate DISABLED';root.append(note);
 selectedOption={...data.contract,strategy:data.strategy||'B_EMA20_EMA50_TREND_PULLBACK'};optionContracts=[selectedOption];const contractSelect=$('contract');contractSelect.replaceChildren(new Option(data.contract.symbol+' · '+data.contract.side+' · '+fmt(data.contract.strike),data.contract.symbol));contractSelect.value=data.contract.symbol;contractSelect.disabled=true;$('qty').value=selectedOption.lotSize;$('qty').min=selectedOption.lotSize;$('qty').step=selectedOption.lotSize;$('sl').value=String(data.stopLoss);$('target').value=String(data.target);if([...$('product').options].some(o=>o.value==='MARGIN'))$('product').value='MARGIN';updatePremium();
}
async function scanMcxBestSetup(attempt=0){
 if(!selected.startsWith('MCX:')||mcxScanBusy)return;
 if(mcxScanTimer){clearTimeout(mcxScanTimer);mcxScanTimer=null}
 mcxScanBusy=true;
 if(attempt===0)showMcxScanMessage('Checking fresh MCX futures candles and CE/PE contracts…');
 try{
  const data=await api('/api/mcx/scan?symbol='+encodeURIComponent(selected));
  if(data.status==='WAITING_FOR_OPTION_TICKS'&&attempt<8){showMcxScanMessage(data.reason+' · rechecking fresh ticks');mcxScanTimer=setTimeout(()=>scanMcxBestSetup(attempt+1),2000);return}
  if(data.status==='SETUP_CONFIRMED'&&data.contract){renderMcxSetup(data);return}
  selectedOption=null;updatePremium();showMcxScanMessage((data.status||'NO_TRADE')+' · '+(data.reason||'No MCX contract passed every verification rule'));
 }catch(error){selectedOption=null;updatePremium();showMcxScanMessage('NO TRADE · '+error.message)}
 finally{mcxScanBusy=false}
}
async function loadOptions(underlying){if(!underlying||$('optionUnderlying').value!==underlying)return;optionsAttemptedFor=underlying;optionsAttemptedAt=Date.now();$('contract').replaceChildren(new Option('Loading verified contracts…',''));$('contract').disabled=true;selectedOption=null;optionContracts=[];$('premium').textContent='—';updateOrderGate();try{const data=await api('/api/options?symbol='+encodeURIComponent(underlying));if($('optionUnderlying').value!==underlying)return;optionContracts=data.contracts||[];$('contract').replaceChildren(new Option('Choose CE / PE contract',''));for(const c of optionContracts){const o=new Option(c.symbol+' · '+c.side+' · '+c.strike+' · lot '+c.lotSize,c.symbol);$('contract').add(o)}$('contract').disabled=!optionContracts.length;if(!optionContracts.length)$('contract').replaceChildren(new Option('No verified CE / PE contracts returned',''))}catch(e){if($('optionUnderlying').value!==underlying)return;$('contract').replaceChildren(new Option('Option chain unavailable · '+e.message,''));$('contract').disabled=true}}
function updatePremium(){const symbol=selectedOption?.symbol;if(!symbol){$('premium').textContent='—';updateOrderGate();return}const t=marketSnapshot.find(x=>x.symbol===symbol);$('premium').textContent=t?fmt(t.price)+' · '+tickAge(t):'Waiting for live option tick';updateOrderGate()}
async function chooseOption(symbol){selectedOption=optionContracts.find(x=>x.symbol===symbol)||null;if(!selectedOption){updatePremium();return}try{await api('/api/select-option',{method:'POST',body:JSON.stringify({symbol})});$('qty').value=selectedOption.lotSize;$('qty').min=selectedOption.lotSize;$('qty').step=selectedOption.lotSize;$('qty').title='Lot size '+selectedOption.lotSize;updatePremium()}catch(e){$('premium').textContent=e.message;selectedOption=null;updateOrderGate()}}
function updateOrderGate(){const t=selectedOption&&marketSnapshot.find(x=>x.symbol===selectedOption.symbol);const age=t?Date.now()-Number(t.receivedAt):Infinity,exchangeAge=t?Date.now()/1000-Number(t.exchangeTime):Infinity;const fresh=Boolean(t&&age>=0&&age<10000&&exchangeAge>=-3&&exchangeAge<=10);const isMcx=selected.startsWith('MCX:');const valid=orderMode==='LIVE'&&fresh&&selectedOption&&Number($('qty').value)>=selectedOption.lotSize&&Number($('qty').value)%selectedOption.lotSize===0&&Number($('sl').value)>0&&Number($('target').value)>0&&(!isMcx||$('product').value==='MARGIN');$('buy').disabled=!valid;$('sell').disabled=!valid||isMcx;$('buy').title=valid?'Submit explicitly confirmed FYERS order after server-side margin/risk checks':'Order gate closed: live flag, fresh tick, valid lot, MCX MARGIN, SL and target required';if(isMcx)$('sell').title='MCX option scanner supports verified long CE/PE BUY setups only'}
async function sendOrder(side){if(!selectedOption)return;const qty=Number($('qty').value),sl=Number($('sl').value),target=Number($('target').value),summary=side+' '+qty+' '+selectedOption.symbol+'\nLive premium: '+$('premium').textContent+'\nStop loss: '+sl+'\nTarget: '+target+'\n\nConfirm this order to FYERS?';if(!window.confirm(summary))return;try{$('orderState').textContent='SENDING TO FYERS…';const requestId=crypto.randomUUID();const r=await api('/api/order',{method:'POST',body:JSON.stringify({symbol:selectedOption.symbol,side,qty,productType:$('product').value,stopLoss:sl,takeProfit:target,confirm:true,requestId})});$('orderState').textContent='FYERS ACK · '+(r.orderId||'CHECK ORDER BOOK');await refreshAccount({force:true})}catch(e){$('orderState').textContent=e.message;await refreshAccount({force:true})}}
$('symbol').addEventListener('change',e=>selectInstrument(e.target.value));
$('chartZoomIn').addEventListener('click',()=>{chartVisibleCandles=Math.max(15,chartVisibleCandles-10);if(activeChartCandles.length)drawCandles(activeChartCandles);});
$('chartZoomOut').addEventListener('click',()=>{chartVisibleCandles=Math.min(150,chartVisibleCandles+10);if(activeChartCandles.length)drawCandles(activeChartCandles);});
$('chartZoomReset').addEventListener('click',()=>{chartVisibleCandles=50;if(activeChartCandles.length)drawCandles(activeChartCandles);});
$('scanMcxBest').addEventListener('click',()=>scanMcxBestSetup());
async function chooseMcxProduct(product,label,buttonId,allowModeSwitch=false){
 if(!allowModeSwitch&&!selected.startsWith('MCX:')){$('mcxContractHint').textContent='MCX requests are paused. Turn MCX MODE ON first.';return}
 const requestId=++mcxPickerRequest;
 $('chooseCrudeOil').setAttribute('aria-pressed',buttonId==='chooseCrudeOil'?'true':'false');
 $('chooseNaturalGas').setAttribute('aria-pressed',buttonId==='chooseNaturalGas'?'true':'false');
 const input=$('mcxSymbol');
 input.disabled=true;$('loadMcx').disabled=true;
 input.replaceChildren(new Option('Loading active FYERS contracts…',''));
 $('mcxContractLabel').textContent=label+' · ACTIVE FYERS FUTURES';
 $('mcxContractHint').textContent='Fetching active contracts from the official FYERS MCX Symbol Master…';
 $('mcxQuote').hidden=true;
 try{
  const data=await api('/api/mcx/contracts?product='+encodeURIComponent(product));
  if(requestId!==mcxPickerRequest)return;
  const contracts=Array.isArray(data.contracts)?data.contracts:[];
  if(!contracts.length)throw new Error('No active verified '+label+' futures contract is available');
  input.replaceChildren(...contracts.map(contract=>new Option(contract.symbol+' · EXP '+contract.expiryDate,contract.symbol)));
  input.disabled=false;$('loadMcx').disabled=false;
  $('mcxContractHint').textContent=label+' selected. Active FYERS contracts loaded; nearest expiry is preselected. Choose another expiry if needed, then load chart.';
  if(allowModeSwitch&&contracts[0])void selectInstrument(contracts[0].symbol,label+' · MCX');
 }catch(error){
  if(requestId!==mcxPickerRequest)return;
  input.replaceChildren(new Option('No verified active contract available',''));
  $('mcxContractHint').textContent='CONTRACT LIST UNAVAILABLE · '+error.message+' · NO TRADE';
 }
}
$('chooseCrudeOil').addEventListener('click',()=>void chooseMcxProduct('CRUDEOIL','CRUDE OIL','chooseCrudeOil'));
$('chooseNaturalGas').addEventListener('click',()=>void chooseMcxProduct('NATURALGAS','NATURAL GAS','chooseNaturalGas'));
$('loadMcx').addEventListener('click',()=>{const symbol=$('mcxSymbol').value.trim().toUpperCase();const root=symbol.startsWith('MCX:CRUDEOIL')?'CRUDEOIL':symbol.startsWith('MCX:NATURALGAS')?'NATURALGAS':'';const suffix=root?symbol.slice(('MCX:'+root).length):'';if(!root||suffix.length!==8||!/^[0-9]{2}[A-Z]{3}FUT/.test(suffix)){$('mcxContractHint').textContent='Invalid or unverified contract selection. Choose an active contract from the FYERS list.';return}const label=root==='CRUDEOIL'?'CRUDE OIL':'NATURAL GAS';selectInstrument(symbol,label+' · MCX')});
$('optionUnderlying').addEventListener('change',e=>{const underlying=e.target.value;if(!underlying){clearOptionSelection();return}const chartSelect=$('symbol');let option=[...chartSelect.options].find(o=>o.value===underlying);if(!option){option=new Option(underlying.replace(/^NSE:/,'').replace(/^BSE:/,'').replace(/-EQ$/,'').replace('-INDEX',''),underlying);chartSelect.add(option)}chartSelect.value=underlying;void selectInstrument(underlying,option.text,underlying)});
$('contract').addEventListener('change',e=>chooseOption(e.target.value));
$('buy').addEventListener('click',()=>sendOrder('BUY'));$('sell').addEventListener('click',()=>sendOrder('SELL'));
['qty','sl','target'].forEach(id=>$(id).addEventListener('input',updateOrderGate));
let resumeRefreshBusy=false,lastResumeRefreshAt=0;
async function refreshAfterResume(reason){
 if(resumeRefreshBusy||Date.now()-lastResumeRefreshAt<1500)return;
 resumeRefreshBusy=true;lastResumeRefreshAt=Date.now();
 try{
  $('feedState').textContent='CHECKING FYERS AFTER '+reason.toUpperCase();
  await poll();
  if(!document.hidden){
   const health=await api('/api/health');
   if(!health.socketConnected){$('feedState').textContent='FYERS RECONNECT REQUIRED · CHECKING FEED';$('dot').style.background='#d69b39';}
  }
 }catch(error){$('feedState').textContent='FEED RECHECK FAILED · '+String(error.message||error).slice(0,80);$('dot').style.background='#d69b39';}
 finally{resumeRefreshBusy=false;}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshAfterResume('APP RESUMED')});
window.addEventListener('pageshow',()=>void refreshAfterResume('PAGE SHOWN'));
window.addEventListener('focus',()=>void refreshAfterResume('FOCUS'));
window.addEventListener('online',()=>void refreshAfterResume('NETWORK RESTORED'));
window.addEventListener('offline',()=>{$('feedState').textContent='DEVICE OFFLINE · LIVE DATA PAUSED';$('dot').style.background='#d69b39'});
setInterval(poll,1000);poll();
