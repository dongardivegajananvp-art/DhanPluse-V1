const $=id=>document.getElementById(id);
const fmt=n=>Number(n).toLocaleString('en-IN',{maximumFractionDigits:2});
let selected='NSE:NIFTY50-INDEX';
const historyCache=new Map();
const indexNames={'NSE:NIFTY50-INDEX':'NIFTY 50','NSE:NIFTYBANK-INDEX':'BANK NIFTY','BSE:SENSEX-INDEX':'SENSEX'};
async function api(path,opts={}){const r=await fetch(path,{headers:{'content-type':'application/json'},...opts});const j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j}
function render(q){const el=$('indices'),cards=el.querySelectorAll('article');for(let i=0;i<3;i++){const key=Object.keys(indexNames)[i],v=q.find(x=>x.symbol===key);cards[i].querySelector('strong').textContent=v?fmt(v.price):'—';cards[i].querySelector('small').textContent=v?tickAge(v):'Waiting for exchange tick'}$('feedState').textContent='FYERS STREAM · '+(q.length?'TICKS RECEIVED':'WAITING');$('dot').style.background=q.length?'#42d6a0':'#d69b39';}
function tickAge(t){const ms=Number(t.exchangeTime)*1000;const age=Date.now()-ms;return Number.isFinite(ms)&&age>=-3000&&age<15000?'Fresh exchange tick': 'Last tick · stale / order blocked'}
async function poll(){try{const j=await api('/api/market');render(j.quotes||[])}catch(e){$('feedState').textContent='BACKEND DISCONNECTED';$('dot').style.background='#e45d68'}$('clock').textContent=new Date().toLocaleTimeString('en-IN')}
function drawCandles(candles){const el=$('chart');if(!Array.isArray(candles)||!candles.length){el.textContent='No verified candles returned by FYERS.';return}
const w=Math.max(600,el.clientWidth||800),h=360,pad=24,plotH=h-2*pad,plotW=w-2*pad;
const lo=Math.min(...candles.map(c=>c.low)),hi=Math.max(...candles.map(c=>c.high)),range=Math.max(hi-lo,0.01),step=plotW/candles.length,body=Math.max(2,Math.min(12,step*.62));
const y=v=>pad+(hi-v)/range*plotH;
let svg='<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="FYERS five minute candlestick chart">';
for(let i=0;i<5;i++){const yy=pad+i*plotH/4,val=hi-i*range/4;svg+='<line x1="'+pad+'" y1="'+yy+'" x2="'+(w-pad)+'" y2="'+yy+'" stroke="#263449"/><text x="4" y="'+(yy+4)+'" fill="#8ea0b8" font-size="10">'+fmt(val)+'</text>'}
candles.forEach((c,i)=>{const x=pad+i*step+step/2,up=c.close>=c.open,col=up?'#35c995':'#ef6672',top=y(Math.max(c.open,c.close)),bh=Math.max(1,Math.abs(y(c.open)-y(c.close)));svg+='<line x1="'+x+'" y1="'+y(c.high)+'" x2="'+x+'" y2="'+y(c.low)+'" stroke="'+col+'" stroke-width="1.2"/><rect x="'+(x-body/2)+'" y="'+top+'" width="'+body+'" height="'+bh+'" fill="'+col+'"/>'});
svg+='</svg>';el.innerHTML=svg;}
async function selectInstrument(symbol){selected=symbol;$('chartTitle').textContent='CHART · '+$('symbol').selectedOptions[0].text;$('chart').textContent='Loading FYERS 5-minute history…';try{await api('/api/select-symbol',{method:'POST',body:JSON.stringify({symbol})});let data=historyCache.get(symbol);if(!data){data=await api('/api/history?symbol='+encodeURIComponent(symbol));historyCache.set(symbol,data)}drawCandles(data.candles)}catch(err){$('chart').textContent=err.message}}
$('symbol').addEventListener('change',e=>selectInstrument(e.target.value));
setInterval(poll,1000);poll();selectInstrument(selected);
