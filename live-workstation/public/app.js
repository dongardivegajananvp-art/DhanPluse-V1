import { getCompletedCandleWindow, isHistoryCacheFresh } from './chart-safety.js';
const $=id=>document.getElementById(id);
const fmt=n=>Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});
let selected='NSE:NIFTY50-INDEX',orderMode='DISABLED',selectedOption=null,optionContracts=[],marketSnapshot=[];
const historyCache=new Map();
let activeChartCandles=[],activeChartSymbol='',lastChartTickStamp=0;
let chartLoading=false,chartReady=false,accountBusy=false,lastAccountAt=0,chartAttemptedFor='',optionsAttemptedFor='',optionsAttemptedAt=0,chartSelectionId=0;
let gainerScanResults=[],latestGainers=[],latestGainerError='',lastGainerScanAt=0,gainerScanBusy=false;
let mcxScanBusy=false,mcxScanTimer=null,mcxPickerRequest=0;
const indexNames={'NSE:NIFTY50-INDEX':'NIFTY 50','NSE:NIFTYBANK-INDEX':'BANK NIFTY','BSE:SENSEX-INDEX':'SENSEX'};
async function api(path,opts={}){const r=await fetch(path,{headers:{'content-type':'application/json'},...opts});const j=await r.json();if(!r.ok)throw Error(j.detail||j.error||'Request failed');return j}
function startFyersConnect(){const button=$('fyersConnect');button.disabled=true;button.textContent='OPENING FYERS…';$('feedState').textContent='OPENING FYERS AUTHORIZATION';window.location.assign('/api/fyers/auth/redirect')}
const authUrl=new URL(window.location.href);if(authUrl.searchParams.get('fyers_connected')==='1'){authUrl.searchParams.delete('fyers_connected');history.replaceState({},'',authUrl.pathname+authUrl.search+authUrl.hash);$('feedState').textContent='FYERS LOGIN COMPLETE · VERIFYING FEED';$('fyersConnect').textContent='FYERS CONNECTED · CHECK FEED'}
$('fyersConnect').addEventListener('click',()=>void startFyersConnect());
function tickAge(t){const ms=Number(t.exchangeTime)*1000,age=Date.now()-ms;return Number.isFinite(ms)&&age>=-3000&&age<10000?'Fresh exchange tick':'Stale · orders blocked'}
function renderIndices(q){const cards=$('indices').querySelectorAll('article');for(let i=0;i<3;i++){const key=Object.keys(indexNames)[i],v=q.find(x=>x.symbol===key),small=cards[i].querySelector('small');cards[i].querySelector('strong').textContent=v?fmt(v.price):'—';const previousClose=Number(v?.previousClose),price=Number(v?.price),valid=Number.isFinite(previousClose)&&previousClose>0&&Number.isFinite(price)&&price>0; if(valid){const change=price-previousClose,pct=change/previousClose*100,sign=change>0?'+':'',status=tickAge(v);small.textContent=sign+fmt(change)+' ('+sign+pct.toFixed(2)+'%) · '+status;small.className=change>0?'index-change up':change<0?'index-change down':'index-change flat';}else{small.textContent=(v?tickAge(v)+' · ':'')+'Change % unavailable';small.className='index-change unavailable';}}}
function renderMcxQuote(){const panel=$('mcxQuote'),scanPanel=$('mcxScanPanel');if(!selected.startsWith('MCX:')){panel.hidden=true;scanPanel.hidden=true;return}panel.hidden=false;scanPanel.hidden=false;$('mcxSymbolLabel').textContent=selected;const tick=marketSnapshot.find(x=>x.symbol===selected);if(!tick){$('mcxLtp').textContent='—';$('mcxDailyChange').textContent='Waiting for FYERS MCX tick';$('mcxDailyChange').className='mcx-change unavailable';return}const price=Number(tick.price),previousClose=Number(tick.previousClose);$('mcxLtp').textContent=Number.isFinite(price)&&price>0?fmt(price):'—';const freshness=tickAge(tick);if(Number.isFinite(previousClose)&&previousClose>0&&Number.isFinite(price)&&price>0){const change=price-previousClose,pct=change/previousClose*100,sign=change>0?'+':'';$('mcxDailyChange').textContent=sign+fmt(change)+' ('+sign+pct.toFixed(2)+'%) · '+freshness;$('mcxDailyChange').className='mcx-change '+(change>0?'up':change<0?'down':'flat')}else{$('mcxDailyChange').textContent='Change % unavailable · '+freshness;$('mcxDailyChange').className='mcx-change unavailable'}}
function renderGainers(rows,error){
 const root=$('gainers');root.replaceChildren();const liveRows=(rows||[]).filter(r=>r.fresh===true);
 if(!liveRows.length){const span=document.createElement('span');span.textContent=error||((rows||[]).length?'Waiting for fresh FYERS futures ticks':'No verified F&O gainer data');root.append(span);return}
 for(const r of liveRows){
  const card=document.createElement('button');card.type='button';card.className='gainer-card';
  const name=String(r.underlying||r.symbol).replace(/^NSE:/,'').replace(/-EQ$/,'').replace(/\d{2}[A-Z0-9]+FUT$/,'');
  const scan=gainerScanResults.find(x=>x.underlying===r.underlying);let label='BREAKOUT SCAN PENDING';
  if(scan?.status==='SETUP_CONFIRMED')label=scan.side+' SETUP · E '+fmt(scan.entry)+' · SL '+fmt(scan.stopLoss)+' · T '+fmt(scan.target);
  else if(scan?.status==='WAIT')label='WAIT · NO CONFIRMED BREAKOUT';
  else if(scan?.status)label=scan.status.replaceAll('_',' ');
  card.textContent=name+' · '+fmt(r.price)+' · '+(r.change>=0?'+':'')+Number(r.change).toFixed(2)+'% · LIVE TICK · '+label;
  card.title=scan?.reason||'Fresh FYERS data required; levels are underlying reference prices';
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
function render(q){renderIndices(q);renderMcxQuote();updatePremium();updateLiveChartFromTick();const required=Object.keys(indexNames),freshCount=required.filter(symbol=>{const t=q.find(x=>x.symbol===symbol),age=t?Date.now()-Number(t.receivedAt):Infinity,exchangeAge=t?Date.now()/1000-Number(t.exchangeTime):Infinity;return age>=0&&age<10000&&exchangeAge>=-3&&exchangeAge<=10}).length;$('feedState').textContent='FYERS INDEX FEED · '+freshCount+'/3 FRESH';$('dot').style.background=freshCount===3?'#42d6a0':'#d69b39'}
async function refreshAccount(){if(accountBusy||Date.now()-lastAccountAt<60000)return;accountBusy=true;lastAccountAt=Date.now();try{const a=await api('/api/account');const open=(a.positions||[]).filter(p=>Number(p.netQty)!==0);$('openCount').textContent=String(open.length);$('pnl').textContent=fmt(Number(a.overall?.pl_total??open.reduce((n,p)=>n+Number(p.pl||0),0)));const statusNames={1:'CANCELLED',2:'FILLED',4:'IN TRANSIT',5:'REJECTED',6:'PENDING',7:'EXPIRED'};$('orderState').textContent=(a.orders||[]).slice(0,1).map(o=>statusNames[Number(o.status)]||o.message||'ORDER BOOK UPDATED').join('')||'NO OPEN ORDER';$('brokerUpdate').textContent=(a.stale?'STALE · ':'')+new Date(a.updatedAt).toLocaleTimeString('en-IN');if(a.stale)$('orderState').textContent='BROKER DATA STALE · LAST VERIFIED SNAPSHOT';const rows=$('positionRows');rows.replaceChildren();if(!open.length){rows.textContent='No open FYERS positions.'}else for(const p of open){const line=document.createElement('div');line.className='position-row';line.textContent=[p.symbol,'Qty '+p.netQty,'Avg '+fmt(p.netAvg||p.avgPrice||0),'LTP '+fmt(p.ltp||0),'P&L '+fmt(p.pl||0)].join(' · ');rows.append(line)}}catch(e){$('orderState').textContent='BROKER SYNC ERROR';$('positionRows').textContent=e.message}finally{accountBusy=false}}
async function poll(){try{const [j,h]=await Promise.all([api('/api/market'),api('/api/health')]);marketSnapshot=j.quotes||[];render(marketSnapshot);latestGainers=j.gainers||[];latestGainerError=j.error||'';renderGainers(latestGainers,latestGainerError);void refreshGainerScan();orderMode=h.orderMode||'DISABLED';updateOrderGate();if(h.authenticated&&!chartReady&&!chartLoading&&chartAttemptedFor!==selected)void selectInstrument(selected);if(h.authenticated&&!optionContracts.length&&(optionsAttemptedFor!==$('optionUnderlying').value||Date.now()-optionsAttemptedAt>=60000))void loadOptions($('optionUnderlying').value);if(h.authenticated)void refreshAccount()}catch(e){$('feedState').textContent='BACKEND DISCONNECTED';$('dot').style.background='#e45d68'}$('clock').textContent=new Date().toLocaleTimeString('en-IN')}
function clearChartLevels(message){$('entryLine').textContent='—';$('slLine').textContent='—';$('targetLine').textContent='—';$('chartSignal').textContent=message;}
function drawCandles(candles,plan=null){
 const el=$('chart');
 if(!Array.isArray(candles)||!candles.length){el.textContent='No verified candles returned by FYERS.';return}
 const levels=plan?[{label:'ENTRY',value:plan.entry},{label:'SL',value:plan.sl},{label:'TARGET',value:plan.target}]:[];
 const liveTick=marketSnapshot.find(x=>x.symbol===activeChartSymbol);
 const liveFresh=Boolean(liveTick&&tickAge(liveTick)==='Fresh exchange tick');
 const liveBucket=liveFresh?Math.floor(Number(liveTick.exchangeTime)/300)*300:0;
 const liveCandle=Boolean(liveFresh&&candles[candles.length-1].time===liveBucket);
 const completed=liveCandle?candles.slice(0,-1):candles;
 const visible=candles.slice(-50);
 const zoneSource=completed.slice(-20);
 const supplyCandle=zoneSource.length?zoneSource.reduce((a,b)=>b.high>a.high?b:a):null;
 const demandCandle=zoneSource.length?zoneSource.reduce((a,b)=>b.low<a.low?b:a):null;
 const supplyTop=supplyCandle?Number(supplyCandle.high):null;
 const supplyBottom=supplyCandle?Math.max(Number(supplyCandle.open),Number(supplyCandle.close)):null;
 const demandBottom=demandCandle?Number(demandCandle.low):null;
 const demandTop=demandCandle?Math.min(Number(demandCandle.open),Number(demandCandle.close)):null;
 const zoneValues=[supplyTop,supplyBottom,demandTop,demandBottom].filter(Number.isFinite);
 const pad=34,h=390,step=15,body=8,w=Math.max(640,pad*2+visible.length*step,el.clientWidth||800),plotH=h-pad*2-24,plotW=w-pad*2;
 const lo=Math.min(...visible.map(c=>c.low),...levels.map(x=>x.value),...zoneValues);
 const hi=Math.max(...visible.map(c=>c.high),...levels.map(x=>x.value),...zoneValues);
 const range=Math.max(hi-lo,0.01),y=v=>pad+(hi-v)/range*plotH;
 el.style.display='block';el.style.overflowX='auto';el.style.overflowY='hidden';el.style.height=h+'px';el.style.minHeight=h+'px';
 let svg='<svg viewBox="0 0 '+w+' '+h+'" width="'+w+'" height="'+h+'" style="display:block;width:'+w+'px;height:'+h+'px;max-width:none" role="img" aria-label="FYERS five minute candlestick chart; latest 50 candles shown with horizontal scrolling">';
 for(let i=0;i<5;i++){const yy=pad+i*plotH/4,val=hi-i*range/4;svg+='<line x1="'+pad+'" y1="'+yy+'" x2="'+(w-pad)+'" y2="'+yy+'" stroke="#263449"/><text x="4" y="'+(yy+4)+'" fill="#8ea0b8" font-size="10">'+fmt(val)+'</text>'}
 if(supplyCandle&&supplyTop>supplyBottom){const top=y(supplyTop),bottom=y(supplyBottom);svg+='<rect x="'+pad+'" y="'+top+'" width="'+plotW+'" height="'+Math.max(1,bottom-top)+'" fill="#ef6672" fill-opacity=".13" stroke="#ef6672" stroke-opacity=".75" stroke-dasharray="5 3"/><text x="'+(w-pad-5)+'" y="'+(top+12)+'" text-anchor="end" fill="#ef8a92" font-size="11">SUPPLY ZONE</text>'}
 if(demandCandle&&demandTop>demandBottom){const top=y(demandTop),bottom=y(demandBottom);svg+='<rect x="'+pad+'" y="'+top+'" width="'+plotW+'" height="'+Math.max(1,bottom-top)+'" fill="#35c995" fill-opacity=".13" stroke="#35c995" stroke-opacity=".75" stroke-dasharray="5 3"/><text x="'+(w-pad-5)+'" y="'+(bottom-4)+'" text-anchor="end" fill="#55d9a8" font-size="11">DEMAND ZONE</text>'}
 visible.forEach((c,i)=>{const x=pad+i*step+step/2,up=c.close>=c.open,col=up?'#35c995':'#ef6672',top=y(Math.max(c.open,c.close)),bh=Math.max(2,Math.abs(y(c.open)-y(c.close))),stamp=new Date(Number(c.time)*1000).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true});svg+='<g><title>'+stamp+' · O '+fmt(c.open)+' · H '+fmt(c.high)+' · L '+fmt(c.low)+' · C '+fmt(c.close)+'</title><line x1="'+x+'" y1="'+y(c.high)+'" x2="'+x+'" y2="'+y(c.low)+'" stroke="'+col+'" stroke-width="2"/><rect x="'+(x-body/2)+'" y="'+top+'" width="'+body+'" height="'+bh+'" rx="1" fill="'+col+'"/></g>'});
 if(plan){for(const item of levels){const yy=y(item.value),color=item.label==='ENTRY'?'#e9c46a':item.label==='SL'?'#ef6672':'#35c995';svg+='<line x1="'+pad+'" y1="'+yy+'" x2="'+(w-pad)+'" y2="'+yy+'" stroke="'+color+'" stroke-width="1.5" stroke-dasharray="6 4"/><text x="'+(w-pad-5)+'" y="'+(yy-4)+'" text-anchor="end" fill="'+color+'" font-size="11">'+item.label+' '+fmt(item.value)+'</text>'}}
 for(let i=0;i<5;i++){const index=Math.round(i*(visible.length-1)/4),c=visible[index],x=pad+index*step+step/2,label=new Date(Number(c.time)*1000).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',hour12:true});svg+='<text x="'+x+'" y="'+(h-5)+'" text-anchor="middle" fill="#8ea0b8" font-size="10">'+label+'</text>'}
 if(liveCandle)svg+='<text x="'+(w-pad-4)+'" y="15" text-anchor="end" fill="#35c995" font-size="11" font-weight="bold">● LIVE 5M CANDLE</text>';
 else svg+='<text x="'+(w-pad-4)+'" y="15" text-anchor="end" fill="#8ea0b8" font-size="11">LAST VERIFIED CANDLES</text>';
 svg+='</svg>';el.innerHTML=svg;
}
function updateChartPlan(){if(!activeChartCandles.length||activeChartSymbol!==selected){clearChartLevels('Waiting for verified 5-minute candles');return}const tick=marketSnapshot.find(x=>x.symbol===activeChartSymbol);if(!tick||tickAge(tick)!=='Fresh exchange tick'){clearChartLevels('NO TRADE · underlying exchange tick is not fresh');drawCandles(activeChartCandles);return}const {completed,lastClosed,fresh,contiguous}=getCompletedCandleWindow(activeChartCandles,tick.exchangeTime);if(!fresh){clearChartLevels('NO TRADE · latest completed 5-minute candle is stale');drawCandles(activeChartCandles);return}if(completed.length<21){clearChartLevels('WAIT · at least 21 completed 5-minute candles required');drawCandles(activeChartCandles);return}if(!contiguous){clearChartLevels('NO TRADE · missing 5-minute candles in breakout window');drawCandles(activeChartCandles);return}const prior=completed.slice(-21,-1),resistance=Math.max(...prior.map(c=>c.high)),support=Math.min(...prior.map(c=>c.low)),swing=completed.slice(-5);let plan=null;if(lastClosed.close>resistance&&Number(tick.price)>=lastClosed.close){const sl=Math.min(...swing.map(c=>c.low)),risk=lastClosed.close-sl;if(risk>0)plan={side:'LONG',entry:lastClosed.close,sl,target:lastClosed.close+2*risk}}else if(lastClosed.close<support&&Number(tick.price)<=lastClosed.close){const sl=Math.max(...swing.map(c=>c.high)),risk=sl-lastClosed.close;if(risk>0)plan={side:'SHORT',entry:lastClosed.close,sl,target:lastClosed.close-2*risk}}if(!plan||plan.target<=0){clearChartLevels('WAIT · no confirmed 20-candle breakout · NO TRADE');drawCandles(activeChartCandles);return}$('entryLine').textContent=fmt(plan.entry);$('slLine').textContent=fmt(plan.sl);$('targetLine').textContent=fmt(plan.target);$('chartSignal').textContent='FYERS 5-MIN '+plan.side+' BREAKOUT · REFERENCE RR 1:2 · underlying only';drawCandles(activeChartCandles,plan);}
function updateLiveChartFromTick(){if(!chartReady||activeChartSymbol!==selected)return;const tick=marketSnapshot.find(x=>x.symbol===activeChartSymbol);if(!tick||tickAge(tick)!=='Fresh exchange tick'||Number(tick.exchangeTime)<=lastChartTickStamp)return;const stamp=Number(tick.exchangeTime),bucket=Math.floor(stamp/300)*300,price=Number(tick.price);if(!Number.isFinite(price)||price<=0)return;const last=activeChartCandles[activeChartCandles.length-1];if(!last)return;if(bucket<last.time)return;if(bucket===last.time){last.high=Math.max(last.high,price);last.low=Math.min(last.low,price);last.close=price;}else{activeChartCandles.push({time:bucket,open:price,high:price,low:price,close:price,volume:0});if(activeChartCandles.length>300)activeChartCandles.shift();}lastChartTickStamp=stamp;updateChartPlan();}
function clearOptionSelection(message='Select a supported NSE/BSE underlying first'){const underlying=$('optionUnderlying');if(underlying){if(![...underlying.options].some(o=>o.value===''))underlying.add(new Option('Not available for this instrument',''),0);underlying.value='';underlying.disabled=true}selectedOption=null;optionContracts=[];optionsAttemptedFor='';optionsAttemptedAt=0;const contract=$('contract');contract.replaceChildren(new Option(message,''));contract.disabled=true;$('premium').textContent='—';updateOrderGate()}
function inferredOptionUnderlying(symbol){if(symbol.startsWith('MCX:'))return '';if(['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'].includes(symbol))return symbol;if(/^(NSE|BSE):[A-Z0-9&_.-]+-EQ$/.test(symbol))return symbol;return ''}
function syncOptionUnderlying(underlying){if(!underlying){clearOptionSelection('MCX / unsupported instrument · NSE/BSE options blocked');return}const select=$('optionUnderlying');let option=[...select.options].find(o=>o.value===underlying);if(!option){const label=underlying.replace(/^NSE:/,'').replace(/^BSE:/,'').replace(/-EQ$/,'').replace('-INDEX','');option=new Option(label,underlying);select.add(option)}select.disabled=false;select.value=underlying;if(optionsAttemptedFor!==underlying||(!optionContracts.length&&Date.now()-optionsAttemptedAt>=60000))void loadOptions(underlying)}
async function selectInstrument(symbol,label,optionUnderlyingOverride){const selectionId=++chartSelectionId;chartLoading=true;chartReady=false;selected=symbol;activeChartSymbol=symbol;activeChartCandles=[];lastChartTickStamp=0;clearChartLevels('Loading verified FYERS 5-minute candles');chartAttemptedFor=symbol;syncOptionUnderlying(optionUnderlyingOverride===undefined?inferredOptionUnderlying(symbol):optionUnderlyingOverride);$('chartTitle').textContent='CHART · '+(label||$('symbol').selectedOptions[0]?.text||symbol);$('chart').textContent='Loading FYERS 5-minute history…';try{await api('/api/select-symbol',{method:'POST',body:JSON.stringify({symbol})});if(selectionId!==chartSelectionId)return;let data=historyCache.get(symbol);if(!data||!isHistoryCacheFresh(data.fetchedAt)){data=await api('/api/history?symbol='+encodeURIComponent(symbol));historyCache.set(symbol,data)}if(selectionId!==chartSelectionId)return;activeChartCandles=data.candles.map(c=>({...c}));chartReady=true;updateLiveChartFromTick();updateChartPlan();if(symbol.startsWith('MCX:'))setTimeout(()=>scanMcxBestSetup(),1200);else{if(mcxScanTimer)clearTimeout(mcxScanTimer);mcxScanTimer=null;showMcxScanMessage('Select Crude Oil or Natural Gas to scan MCX options')}}catch(err){if(selectionId!==chartSelectionId)return;$('chart').textContent=err.message;clearChartLevels('NO TRADE · chart history unavailable')}finally{if(selectionId===chartSelectionId)chartLoading=false}}
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
 const note=document.createElement('small');note.textContent='FYERS verified B setup · Order gate requires production safety enablement';root.append(note);
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
async function sendOrder(side){if(!selectedOption)return;const qty=Number($('qty').value),sl=Number($('sl').value),target=Number($('target').value),summary=side+' '+qty+' '+selectedOption.symbol+'\nLive premium: '+$('premium').textContent+'\nStop loss: '+sl+'\nTarget: '+target+'\n\nConfirm this order to FYERS?';if(!window.confirm(summary))return;try{$('orderState').textContent='SENDING TO FYERS…';const requestId=crypto.randomUUID();const r=await api('/api/order',{method:'POST',body:JSON.stringify({symbol:selectedOption.symbol,side,qty,productType:$('product').value,stopLoss:sl,takeProfit:target,confirm:true,requestId})});$('orderState').textContent='FYERS ACK · '+(r.orderId||'CHECK ORDER BOOK');await refreshAccount()}catch(e){$('orderState').textContent=e.message;await refreshAccount()}}
$('symbol').addEventListener('change',e=>selectInstrument(e.target.value));
$('scanMcxBest').addEventListener('click',()=>scanMcxBestSetup());
async function chooseMcxProduct(product,label,buttonId){
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
setInterval(poll,1000);poll();
