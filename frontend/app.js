const API_BASE = window.DHANPULSE_API_BASE || "https://dhanpulse-clean-test.onrender.com";
const panel = document.querySelector("#panel");
const sessionKey = "dhanpulseGapSession";
let sessionToken = sessionStorage.getItem(sessionKey) || "";
let candleRefreshTimer = null;
const pages = {
 dashboard:["Dashboard","Verified FYERS streaming quotes are displayed for NIFTY and BANKNIFTY. Historical gap analysis is available; full Stock Explorer, candlesticks, and scanners remain incomplete."],
 explorer:["Stock Explorer","The complete F&O quote universe is not connected in this branch. No prices are fabricated."],
 nifty:["NIFTY","Verified FYERS index quotes and historical candlestick charts are supported. Live tick candles are available only while fresh FYERS ticks are received; stale data blocks the chart."],
 banknifty:["BANKNIFTY","Verified FYERS index quotes and historical candlestick charts are supported. Live tick candles are available only while fresh FYERS ticks are received; stale data blocks the chart."],
 gap:["Gap-Up / Gap-Down","Load verified FYERS daily candles and calculate descriptive historical gap-fill statistics."],
 options:["Option Chain & OI","Option-chain data is not connected in this branch. Do not use this page for trade decisions."],
 scanners:["Scanners","Scanners remain blocked until quotes, candles, and option data are verified."],
 journal:["Paper Journal","Paper trading only. Record entry, stop, target, rule adherence, and outcome."],
 activity:["Market Activity","Market-wide activity feed is not implemented yet. No unverified activity is displayed."],
 charts:["Charts & Patterns","Historical FYERS candlestick charts are available for supported symbols and intervals. Pattern detection is still blocked pending validation."],
 movers:["Gainers & Losers","Verified all-F&O gainers and losers are not connected yet."],
 technical:["Technical Indicators","Technical indicators are blocked until verified intraday candles are available."],
 signals:["Sureshot CE/PE","No trade signal is generated in this build. Entry, stop-loss, target and minimum 1:2 risk/reward require verified data."],
 breakout:["Breakout Scanner","Breakout scanning is not implemented yet; no candidates will be fabricated."],
 momentum:["Momentum Scanner","Momentum scanning is not implemented yet; verified live quotes and candles are required."],
 zerohero:["Zero-to-Hero","Zero-to-Hero scanner is not implemented yet."],
 fii:["FII/DII Flow","Verified FII/DII flow data is not connected in this build."],
 watchlist:["Watchlist","Watchlist quotes are not connected yet. Prices will not be simulated."],
 alerts:["Price Alerts","Price alerts are not active in this build."],
 holdings:["Holdings & Positions","Broker holdings and positions are not connected in this build."],
 capital:["Capital Protection","Position-sizing calculator is available for manually entered planned prices. It is not a live signal or broker order."],
 backtest:["Backtesting","Backtesting beyond historical opening-gap statistics is not implemented yet."],
 settings:["FYERS Settings","FYERS authorization status is shown above. Credentials stay server-side; order placement remains disabled."],
 logs:["Logs","Operational logs are available through the service dashboard; in-app log viewer is not implemented yet."],
 journalRules:["Trade Journal & Rule Review","Review paper-trade rule adherence, outcomes, and recurring mistakes from records saved in this browser."],
 supplyDemand:["Supply & Demand Zones","Historical pivot-based supply and demand areas are visual study aids, not validated trading signals. They require verified FYERS candles and do not update from live ticks yet."]
};
function el(tag, text, cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
async function connectFyers(){
 try{
  const r=await fetch(API_BASE+"/api/fyers/auth/start",{cache:"no-store"});
  const data=await r.json();
  if(!r.ok||!data.authorizationUrl)throw new Error(data.error||"Could not start FYERS login.");
  window.location.assign(data.authorizationUrl);
 }catch(e){document.querySelector("#connection").textContent=String(e.message||e);}
}
async function handleAuthCallback(){
 const params=new URLSearchParams(window.location.search);
 const code=params.get("auth_code")||params.get("code");
 const state=params.get("state");
 if(!code&&!state)return;
 history.replaceState({},document.title,window.location.pathname);
 if(!code||!state){document.querySelector("#connection").textContent="FYERS callback incomplete";return;}
 document.querySelector("#connection").textContent="Verifying FYERS login…";
 try{
  const r=await fetch(API_BASE+"/api/fyers/auth/exchange",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code,state})});
  const data=await r.json();
  if(!r.ok||!data.dashboardSessionToken)throw new Error(data.error||"FYERS login verification failed.");
  sessionToken=data.dashboardSessionToken;sessionStorage.setItem(sessionKey,sessionToken);
  document.querySelector("#connection").textContent="FYERS connected";
  await refreshStatus();
 }catch(e){document.querySelector("#connection").textContent=String(e.message||e);}
}
function renderGap(){
 panel.replaceChildren();
 panel.append(el("h2","Gap-Up / Gap-Down Analysis"));
 panel.append(el("p","Authenticated FYERS daily candles only. Historical fill rate describes the selected sample; it is not a prediction and does not identify FII/DII/operator intent."));
 if(!sessionToken){
  const note=el("p","Connect FYERS first to request verified historical candles.");
  const btn=el("button","Connect FYERS");btn.type="button";btn.addEventListener("click",connectFyers);
  panel.append(note,btn);return;
 }
 const form=el("form",undefined,"gap-form");
 const symbolLabel=el("label","Underlying symbol");
 const symbol=document.createElement("select");symbol.name="symbol";
 for(const [value,label] of [["NSE:NIFTY50-INDEX","NIFTY Index"],["NSE:NIFTYBANK-INDEX","BANKNIFTY Index"],["NSE:RELIANCE-EQ","RELIANCE"],["NSE:TCS-EQ","TCS"],["NSE:INFY-EQ","INFY"]]){const option=el("option",label);option.value=value;symbol.append(option);}
 symbolLabel.append(symbol);form.append(symbolLabel);
 const today=new Date();const fmt=d=>{const x=new Date(d.getTime()-d.getTimezoneOffset()*60000);return x.toISOString().slice(0,10);};
 const end=fmt(today);const startDate=new Date(today);startDate.setDate(startDate.getDate()-350);const start=fmt(startDate);
 for(const [name,label,value] of [["from","From date",start],["to","To date",end],["minGapPct","Minimum absolute gap (%)","0.3"]]){
  const wrap=el("label",label);const input=document.createElement("input");input.name=name;input.type=name==="minGapPct"?"number":"date";input.value=value;input.required=true;
  if(name==="minGapPct"){input.min="0";input.max="20";input.step="0.1";}
  wrap.append(input);form.append(wrap);
 }
 const submit=el("button","Run verified historical analysis");submit.type="submit";form.append(submit);
 const output=el("div",undefined,"gap-result");output.setAttribute("aria-live","polite");
 form.addEventListener("submit",async ev=>{
  ev.preventDefault();submit.disabled=true;submit.textContent="Loading verified FYERS candles…";output.replaceChildren(el("p","Requesting historical daily candles from FYERS…"));
  const q=new URLSearchParams({symbol:symbol.value,from:form.elements.from.value,to:form.elements.to.value,minGapPct:form.elements.minGapPct.value});
  try{
   const r=await fetch(API_BASE+"/api/gap-analysis/history?"+q.toString(),{headers:{Authorization:"Bearer "+sessionToken},cache:"no-store"});
   const data=await r.json();
   if(r.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);throw new Error(data.error||"FYERS session expired. Connect again.");}
   if(!r.ok||!data.ok)throw new Error((data.error||"Gap analysis failed.")+(data.detail?" "+data.detail:""));
   output.replaceChildren();
   const latest=data.latestSession, gap=latest.gap;
   output.append(el("h3",gap.direction.toUpperCase()+" · "+(gap.gapPct>0?"+":"")+gap.gapPct.toFixed(2)+"%"));
   output.append(el("p","Latest candle: "+latest.timestamp.slice(0,10)+" · Previous close ₹"+latest.previousClose+" · Open ₹"+latest.open+" · High ₹"+latest.high+" · Low ₹"+latest.low+" · Close ₹"+latest.close));
   output.append(el("p","Daily candles received: "+data.candleCount+" · Completed sessions used: "+data.completedCandleCount+" · Gaps in backtest sample: "+data.historical.sampleSize+" · Filled: "+data.historical.filledCount+" · Not filled: "+data.historical.unfilledCount));
   output.append(el("p",data.historical.fillRatePct===null?"No gaps matched the selected threshold.":"Historical gap-fill rate: "+data.historical.fillRatePct.toFixed(2)+"% (descriptive sample only)"));
   output.append(el("p","Data source: "+data.source+" · fetched "+data.fetchedAt));
   output.append(el("p",data.warning,"risk-note"));
   if(data.historical.sampleSize===0)output.append(el("p","Increase the date range or lower the minimum gap threshold; no qualifying observations were found."));
  }catch(e){output.replaceChildren(el("p",String(e.message||e),"risk-note"));}
  finally{submit.disabled=false;submit.textContent="Run verified historical analysis";}
 });
 panel.append(form,output);
}
function renderCapital(){
 panel.replaceChildren(el("h2","Capital Protection Calculator"),el("p","Risk-sizing calculator only. Enter your own planned prices; these are not live market quotes or trade recommendations."));
 const form=el("form",undefined,"gap-form");
 const fields=[
  ["capital","Trading capital (₹)","1000","number"],
  ["riskPct","Maximum risk per trade (%)","1","number"],
  ["entry","Planned entry price (₹)","","number"],
  ["stop","Planned stop-loss price (₹)","","number"],
  ["target","Planned target price (₹)","","number"]
 ];
 for(const [name,label,value,type] of fields){const wrap=el("label",label);const input=document.createElement("input");input.name=name;input.type=type;input.value=value;input.required=true;input.min="0";input.step="any";if(name==="riskPct"){input.min="0.1";input.max="2";input.step="0.1";}wrap.append(input);form.append(wrap);}
 const btn=el("button","Calculate position size");btn.type="submit";form.append(btn);
 const out=el("div",undefined,"gap-result");out.setAttribute("aria-live","polite");
 form.addEventListener("submit",ev=>{ev.preventDefault();const v=Object.fromEntries(fields.map(([n])=>[n,Number(form.elements[n].value)]));out.replaceChildren();if(!Object.values(v).every(Number.isFinite)||v.capital<=0||v.riskPct<=0||v.entry<=0||v.stop<=0||v.target<=0||v.entry===v.stop||((v.target-v.entry)*(v.entry-v.stop)<=0)){out.append(el("p","Check inputs: for a long plan target must be above entry and stop below entry; for a short plan target must be below entry and stop above entry.","risk-note"));return;}
 const riskPerUnit=Math.abs(v.entry-v.stop),rewardPerUnit=Math.abs(v.target-v.entry),riskCash=v.capital*v.riskPct/100,qty=Math.floor(riskCash/riskPerUnit),rr=rewardPerUnit/riskPerUnit;
 out.append(el("h3","Planned position sizing"),el("p","Max planned risk: ₹"+riskCash.toFixed(2)),el("p","Risk per unit: ₹"+riskPerUnit.toFixed(2)),el("p","Maximum quantity by risk: "+qty),el("p","Estimated target reward at that quantity: ₹"+(rewardPerUnit*qty).toFixed(2)),el("p","Planned risk/reward: 1:"+rr.toFixed(2)),el("p","This excludes brokerage, taxes, slippage, lot-size constraints and gaps. Verify all prices independently before use.","risk-note"));if(qty<1)out.append(el("p","Risk budget is smaller than the risk on one unit. Skip or reduce risk; do not force a trade.","risk-note"));if(rr<2)out.append(el("p","This plan is below the preferred minimum 1:2 risk/reward threshold.","risk-note"));
 });
 panel.append(form,out);
}
function readPaperTrades(){try{return JSON.parse(localStorage.getItem("dhanpulsePaperTrades")||"[]");}catch{return [];}}
function renderJournal(){
 panel.replaceChildren(el("h2","Paper Journal"),el("p","Paper trades only. Records stay in this browser on this device; they are not sent to FYERS."));
 const form=el("form",undefined,"gap-form");
 const fields=[["symbol","Symbol / setup","NIFTY"],["side","Side","LONG"],["entry","Entry price",""],["stop","Stop-loss price",""],["target","Target price",""],["exit","Exit price (optional)",""],["notes","Rule adherence / notes",""]];
 for(const [name,label,value] of fields){const wrap=el("label",label);const input=name==="notes"?document.createElement("textarea"):document.createElement("input");input.name=name;input.value=value;input.required=!["exit","notes"].includes(name);if(name==="side"){input.type="text";input.value="LONG";input.placeholder="LONG or SHORT";}else if(name!=="notes"){input.type="number";input.min="0";input.step="any";}wrap.append(input);form.append(wrap);}
 const ruleWrap=el("label","Did you follow your written rules?");const rule=document.createElement("select");rule.name="followed";for(const [v,t] of [["yes","Yes"],["no","No"],["partial","Partly"]]){const o=el("option",t);o.value=v;rule.append(o);}ruleWrap.append(rule);form.append(ruleWrap);
 const btn=el("button","Save paper trade");btn.type="submit";form.append(btn);
 const out=el("div",undefined,"gap-result");
 form.addEventListener("submit",ev=>{ev.preventDefault();const side=form.elements.side.value.trim().toUpperCase();const entry=Number(form.elements.entry.value),stop=Number(form.elements.stop.value),target=Number(form.elements.target.value),exitValue=form.elements.exit.value===""?null:Number(form.elements.exit.value);if(!["LONG","SHORT"].includes(side)||![entry,stop,target].every(x=>Number.isFinite(x)&&x>0)||entry===stop||(side==="LONG"&&(stop>=entry||target<=entry))||(side==="SHORT"&&(stop<=entry||target>=entry))||(exitValue!==null&&(!Number.isFinite(exitValue)||exitValue<=0))){out.replaceChildren(el("p","Invalid setup. Use LONG/SHORT with a stop and target on the correct sides of entry.","risk-note"));return;}const trade={id:Date.now(),createdAt:new Date().toISOString(),symbol:form.elements.symbol.value.trim()||"Unspecified",side,entry,stop,target,exit:exitValue,followed:form.elements.followed.value,notes:form.elements.notes.value.trim()};const rows=readPaperTrades();rows.unshift(trade);try{localStorage.setItem("dhanpulsePaperTrades",JSON.stringify(rows));form.reset();renderJournal();}catch{out.replaceChildren(el("p","Could not save locally. Check browser storage settings.","risk-note"));}});
 panel.append(form,out,el("h3","Saved paper trades"));
 const rows=readPaperTrades();if(!rows.length)panel.append(el("p","No paper trades recorded yet."));else{const list=el("div",undefined,"gap-result");for(const t of rows.slice(0,100)){const box=el("article",undefined,"journal-item");box.append(el("h3",t.symbol+" · "+t.side),el("p","Entry ₹"+t.entry+" · SL ₹"+t.stop+" · Target ₹"+t.target+(t.exit===null?"":" · Exit ₹"+t.exit)),el("p","Rule adherence: "+t.followed+" · "+new Date(t.createdAt).toLocaleString()),el("p",t.notes||"No notes"));const del=el("button","Delete record");del.type="button";del.addEventListener("click",()=>{localStorage.setItem("dhanpulsePaperTrades",JSON.stringify(readPaperTrades().filter(x=>x.id!==t.id)));renderJournal();});box.append(del);list.append(box);}panel.append(list);}
}
function renderJournalRules(){
 panel.replaceChildren(el("h2","Trade Journal & Rule Review"),el("p","Review uses only paper trades saved in this browser on this device. Results are descriptive, not a prediction; fees, slippage, and position size are not included."));
 const rows=readPaperTrades();
 if(!rows.length){panel.append(el("p","No saved paper trades yet. Record paper trades in Paper Journal first; this page will summarize them."));const b=el("button","Open Paper Journal");b.type="button";b.addEventListener("click",()=>document.querySelector('[data-tab="journal"]').click());panel.append(b);return;}
 const completed=rows.filter(t=>Number.isFinite(Number(t.exit))&&Number(t.exit)>0);
 const followed=rows.filter(t=>t.followed==="yes").length;
 const notFollowed=rows.filter(t=>t.followed==="no"||t.followed==="partial");
 const stats=el("div",undefined,"gap-result");
 stats.append(el("p","Paper trades recorded: "+rows.length));
 stats.append(el("p","Trades marked rules followed: "+followed+" / "+rows.length+" ("+(100*followed/rows.length).toFixed(1)+"%)"));
 stats.append(el("p","Trades with an exit recorded: "+completed.length+" / "+rows.length));
 if(completed.length){let totalR=0,wins=0;for(const t of completed){const risk=Math.abs(Number(t.entry)-Number(t.stop));const pnl=(t.side==="LONG"?Number(t.exit)-Number(t.entry):Number(t.entry)-Number(t.exit));const r=risk>0?pnl/risk:0;totalR+=r;if(pnl>0)wins++;}stats.append(el("p","Recorded outcomes: "+wins+" positive of "+completed.length+" closed trades; average result "+(totalR/completed.length).toFixed(2)+"R (before costs)."));}
 panel.append(stats,el("h3","Rule-review flags"));
 if(!notFollowed.length)panel.append(el("p","No trades are currently marked No or Partly. Keep recording honestly; this is not proof that every rule was followed."));
 else{const list=el("div",undefined,"gap-result");for(const t of notFollowed.slice(0,100)){const item=el("article",undefined,"journal-item");item.append(el("h3",t.symbol+" · "+t.side+" · "+t.followed.toUpperCase()),el("p","Entry ₹"+t.entry+" · SL ₹"+t.stop+" · Target ₹"+t.target),el("p",t.notes||"No note was recorded; add a reason in your next journal entry."));list.append(item);}panel.append(list);}
 panel.append(el("p","Limitations: this summary cannot establish strategy profitability from a small sample and does not include brokerage, taxes, slippage, quantity, or market context."));
}
async function renderLiveQuotes(key){
 const target=document.querySelector("#liveQuotePanel");
 if(!target)return;
 target.replaceChildren(el("h3","Verified index quotes"));
 if(!sessionToken){
  target.append(el("p","Connect FYERS to load authenticated live quotes."));
  return;
 }
 try{
  const r=await fetch(API_BASE+"/api/market/quotes",{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}});
  const data=await r.json();
  if(!r.ok||!Array.isArray(data.data))throw new Error(data.detail||data.error||"Fresh verified quotes are not available.");
  const wanted=key==="nifty"?["NSE:NIFTY50-INDEX"]:key==="banknifty"?["NSE:NIFTYBANK-INDEX"]:["NSE:NIFTY50-INDEX","NSE:NIFTYBANK-INDEX"];
  const rows=data.data.filter(item=>wanted.includes(item.n));
  if(rows.length!==wanted.length)throw new Error("Required index quote is missing; no price shown.");
  for(const item of rows){
   const symbol=item.n;
   const label=symbol==="NSE:NIFTY50-INDEX"?"NIFTY":"BANKNIFTY";
   const price=Number(item.v?.lp);
   const stamp=Number(item.v?.tt);
   const time=stamp>0?new Date(stamp*1000):null;
   if(!Number.isFinite(price)||price<=0||!time||Number.isNaN(time.getTime()))continue;
   const card=el("article",undefined,"quote-card");
   card.append(el("span",label),el("strong","₹"+price.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})),el("small","Exchange time: "+time.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})));
   const chp=Number(item.v?.chp);
   if(Number.isFinite(chp))card.append(el("small",(chp>=0?"+":"")+chp.toFixed(2)+"% (FYERS reported change)"));
   target.append(card);
  }
  if(target.children.length===1)throw new Error("Quote values or exchange timestamps failed validation.");
 }catch(error){
  target.append(el("p",String(error?.message||"Verified quotes unavailable.")+" No placeholder price is displayed."));
 }
}
function renderQuotePanel(key){
 const box=el("section",undefined,"live-quotes");
 box.id="liveQuotePanel";
 panel.append(box);
 void renderLiveQuotes(key);
}

function istDateString(date){
 return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
}
function svgNode(name,attrs={}){
 const node=document.createElementNS("http://www.w3.org/2000/svg",name);
 for(const [key,value] of Object.entries(attrs))node.setAttribute(key,String(value));
 return node;
}
function renderCandleChart(key){
 const wrap=el("section",undefined,"candle-tool");
 wrap.append(el("h3",key==="charts"?"Verified candlestick chart":"Candlestick chart · FYERS history"));
 wrap.append(el("p","Historical mode uses verified FYERS OHLC. Live mode aggregates received FYERS ticks into provisional OHLC bars; it does not reconstruct missed ticks or supply volume. Supply/demand bands are historical pivot-based study areas, not trade signals."));
 const form=el("form",undefined,"gap-form");
 const symbols=[
  ["NSE:NIFTY50-INDEX","NIFTY"],["NSE:NIFTYBANK-INDEX","BANKNIFTY"],
  ["NSE:RELIANCE-EQ","RELIANCE"],["NSE:TCS-EQ","TCS"],["NSE:INFY-EQ","INFY"],
  ["NSE:HDFCBANK-EQ","HDFCBANK"],["NSE:ICICIBANK-EQ","ICICIBANK"],["NSE:SBIN-EQ","SBIN"],
  ["NSE:ITC-EQ","ITC"],["NSE:LT-EQ","LT"],["NSE:AXISBANK-EQ","AXISBANK"],["NSE:BAJFINANCE-EQ","BAJFINANCE"]
 ];
 const fixedSymbol=key==="nifty"?"NSE:NIFTY50-INDEX":key==="banknifty"?"NSE:NIFTYBANK-INDEX":null;
 if(!fixedSymbol){
  const label=el("label","Symbol");
  const select=document.createElement("select");select.name="symbol";
  for(const [value,title] of symbols){const option=el("option",title);option.value=value;select.append(option);}
  label.append(select);form.append(label);
 }
 const sourceLabel=el("label","Data source");
 const sourceSelect=document.createElement("select");sourceSelect.name="source";
 for(const [value,title] of [["history","Historical FYERS OHLC"],["live","Live candles from FYERS ticks"]]){const option=el("option",title);option.value=value;sourceSelect.append(option);}
 sourceLabel.append(sourceSelect);form.append(sourceLabel);
 const resolutionLabel=el("label","Candle interval");
 const resolution=document.createElement("select");resolution.name="resolution";
 for(const [value,title] of [["5","5 minutes"],["15","15 minutes"],["30","30 minutes"],["60","1 hour"],["D","Daily"]]){const option=el("option",title);option.value=value;resolution.append(option);}
 resolutionLabel.append(resolution);form.append(resolutionLabel);
 const today=istDateString(new Date());
 const fromDefault=istDateString(new Date(Date.now()-7*86400000));
 for(const [name,labelText,value] of [["from","From date",fromDefault],["to","To date",today]]){
  const label=el("label",labelText);const input=document.createElement("input");input.name=name;input.type="date";input.value=value;input.required=true;label.append(input);form.append(label);
 }
 const submit=el("button","Load verified candles");submit.type="submit";form.append(submit);
 const status=el("p","Choose an interval and load historical candles.");
 const chartHost=el("div",undefined,"candle-chart-host");
 const details=el("p",undefined,"candle-details");
 sourceSelect.addEventListener("change",()=>{if(candleRefreshTimer){clearInterval(candleRefreshTimer);candleRefreshTimer=null;}if(sourceSelect.value==="live"){if(fixedSymbol===null){status.textContent="Live tick candles are supported on NIFTY/BANKNIFTY tabs only.";return;}if(resolution.value==="D")resolution.value="5";if(sessionToken){form.requestSubmit();candleRefreshTimer=setInterval(()=>{if(document.body.contains(wrap)&&sourceSelect.value==="live"&&!submit.disabled)form.requestSubmit();},15000);}}else if(sessionToken)form.requestSubmit();});
 resolution.addEventListener("change",()=>{
  const daily=resolution.value==="D";
  form.elements.from.value=istDateString(new Date(Date.now()-(daily?60:7)*86400000));
  if(sessionToken)form.requestSubmit();
 });
 for(const control of form.querySelectorAll("select,input[type=date]")){
  if(control!==resolution)control.addEventListener("change",()=>{if(sessionToken)form.requestSubmit();});
 }
 form.addEventListener("submit",async event=>{
  event.preventDefault();
  const symbol=fixedSymbol||form.elements.symbol.value;
  const interval=resolution.value;
  const source=sourceSelect.value;
  const from=form.elements.from.value,to=form.elements.to.value;
  if(source==="live"&&(!fixedSymbol||interval==="D")){status.textContent="Live tick candles are supported on NIFTY/BANKNIFTY with intraday intervals only.";chartHost.replaceChildren();details.textContent="";return;}
  if(!sessionToken){status.textContent="Connect FYERS first. No candle data is shown without an authenticated session.";chartHost.replaceChildren();details.textContent="";return;}
  if(!from||!to||from>to){status.textContent="Choose a valid date range.";return;}
  submit.disabled=true;status.textContent="Requesting verified FYERS candles…";chartHost.replaceChildren();details.textContent="";
  const query=new URLSearchParams({symbol,resolution:interval});
  if(source==="history"){query.set("from",from);query.set("to",to);}
  const endpoint=source==="live"?"/api/market/live-candles":"/api/market/candles";
  try{
   const response=await fetch(API_BASE+endpoint+"?"+query.toString(),{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}});
   const result=await response.json();
   if(response.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);}
   if(!response.ok||!result.ok||!Array.isArray(result.data)||!result.data.length)throw new Error(result.detail||result.error||"No verified candles returned.");
   const expectedSource=source==="live"?"FYERS websocket ticks":"FYERS";
   const candles=result.data.filter(c=>c.verified===true&&c.source===expectedSource&&Number.isFinite(Date.parse(c.timestamp))&&[c.open,c.high,c.low,c.close].every(v=>Number.isFinite(Number(v))&&Number(v)>0)&&Number(c.high)>=Math.max(Number(c.open),Number(c.close),Number(c.low))&&Number(c.low)<=Math.min(Number(c.open),Number(c.close),Number(c.high)));
   if(!candles.length)throw new Error("Returned candles failed OHLC/source validation; chart blocked.");
   const shown=candles.slice(-100);
   const width=900,height=360,left=64,right=20,top=20,bottom=48,plotW=width-left-right,plotH=height-top-bottom;
   const lows=shown.map(c=>Number(c.low)),highs=shown.map(c=>Number(c.high));
   let min=Math.min(...lows),max=Math.max(...highs);
   if(!Number.isFinite(min)||!Number.isFinite(max)||max<=0)throw new Error("Invalid chart price range.");
   if(max===min){max+=1;min=Math.max(0,min-1);}
   const y=value=>top+(max-value)/(max-min)*plotH;
   const svg=svgNode("svg",{viewBox:"0 0 "+width+" "+height,role:"img","aria-label":symbol+" verified FYERS candlestick chart, "+shown.length+" candles"});
   for(let i=0;i<5;i++){
    const val=max-(max-min)*i/4,yy=y(val);
    svg.append(svgNode("line",{x1:left,y1:yy,x2:width-right,y2:yy,class:"chart-grid"}));
    const label=svgNode("text",{x:left-8,y:yy+4,"text-anchor":"end",class:"chart-axis"});
    label.textContent=val.toLocaleString("en-IN",{maximumFractionDigits:2});svg.append(label);
   }
   const step=plotW/shown.length,bodyW=Math.max(2,Math.min(9,step*.62));
   // Historical pivot bands are study aids only, not validated trade signals.
   const supply=[],demand=[];
   for(let i=2;i<shown.length-2;i++){
    const hi=Number(shown[i].high),lo=Number(shown[i].low);
    const leftHigh=Math.max(...shown.slice(i-2,i).map(c=>Number(c.high)));
    const rightHigh=Math.max(...shown.slice(i+1,i+3).map(c=>Number(c.high)));
    const leftLow=Math.min(...shown.slice(i-2,i).map(c=>Number(c.low)));
    const rightLow=Math.min(...shown.slice(i+1,i+3).map(c=>Number(c.low)));
    if(hi>leftHigh&&hi>rightHigh)supply.push({top:hi,bottom:Math.max(Number(shown[i].open),Number(shown[i].close))});
    if(lo<leftLow&&lo<rightLow)demand.push({top:Math.min(Number(shown[i].open),Number(shown[i].close)),bottom:lo});
   }
   for(const zone of supply.slice(-3)){
    const yTop=y(zone.top),yBottom=y(zone.bottom);
    if(yBottom>=top&&yTop<=top+plotH)svg.append(svgNode("rect",{x:left,y:Math.max(top,yTop),width:plotW,height:Math.max(2,Math.min(top+plotH,yBottom)-Math.max(top,yTop)),class:"zone-supply"}));
   }
   for(const zone of demand.slice(-3)){
    const yTop=y(zone.top),yBottom=y(zone.bottom);
    if(yBottom>=top&&yTop<=top+plotH)svg.append(svgNode("rect",{x:left,y:Math.max(top,yTop),width:plotW,height:Math.max(2,Math.min(top+plotH,yBottom)-Math.max(top,yTop)),class:"zone-demand"}));
   }
   shown.forEach((c,i)=>{
    const x=left+step*(i+.5),o=Number(c.open),cl=Number(c.close),hi=Number(c.high),lo=Number(c.low),up=cl>=o;
    svg.append(svgNode("line",{x1:x,y1:y(hi),x2:x,y2:y(lo),class:up?"candle-up":"candle-down","stroke-width":1.2}));
    const bodyTop=Math.min(y(o),y(cl)),bodyHeight=Math.max(1,Math.abs(y(o)-y(cl)));
    svg.append(svgNode("rect",{x:x-bodyW/2,y:bodyTop,width:bodyW,height:bodyHeight,rx:.4,class:up?"candle-up":"candle-down"}));
   });
   for(const i of [0,Math.floor((shown.length-1)/2),shown.length-1]){
    const x=left+(i+.5)*step;const d=new Date(shown[i].timestamp);
    const label=svgNode("text",{x,y:height-18,"text-anchor":"middle",class:"chart-axis"});
    label.textContent=interval==="D"?d.toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short"}):d.toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});
    svg.append(label);
   }
   chartHost.append(svg);
   const last=shown[shown.length-1];
   details.textContent="Source: "+result.source+" · "+candles.length+" valid candles returned; showing latest "+shown.length+" · Last candle close ₹"+Number(last.close).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})+" · Candle time "+new Date(last.timestamp).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})+" · Fetched "+new Date(result.fetchedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})+(source==="live"?" · Volume unavailable (not fabricated).":".");
   status.textContent=symbol+" · "+(interval==="D"?"daily":interval+"-minute")+" candles · "+(source==="live"?"Live FYERS tick aggregation":"Verified FYERS historical data");
  }catch(error){status.textContent=String(error?.message||"Verified candles unavailable.")+" No placeholder candles are displayed.";chartHost.replaceChildren();details.textContent="";}
  finally{submit.disabled=false;}
 });
 wrap.append(form,status,chartHost,details,el("p","Zone legend: Supply = historical swing-high area · Demand = historical swing-low area. Not live-updating or trade recommendations."));
 panel.append(wrap);
 if(sessionToken){
  status.textContent="Loading verified FYERS candles automatically…";
  form.requestSubmit();
 }else{
  status.textContent="Connect FYERS to automatically load verified historical candles. No placeholder data is shown.";
 }
}

function renderPage(key){
 if(candleRefreshTimer){clearInterval(candleRefreshTimer);candleRefreshTimer=null;}
 const [title,description]=pages[key]||["Module","Status unavailable."];
 panel.replaceChildren();
 if(key==="gap"){renderGap();return;}
 if(key==="capital"){renderCapital();return;}
 if(key==="journal"){renderJournal();return;}
 if(key==="journalRules"){renderJournalRules();return;}
 panel.append(el("h2",title),el("p",description));
 if(key==="charts"){renderCandleChart(key);return;}
 if(["dashboard","nifty","banknifty"].includes(key))renderQuotePanel(key);
 if(["nifty","banknifty"].includes(key))renderCandleChart(key);
 if(key==="dashboard"){const b=el("button","Open Gap-Up / Gap-Down Analysis");b.addEventListener("click",()=>{document.querySelector('[data-tab="gap"]').click();});panel.append(b);}
}
document.querySelector("#tabs").addEventListener("click",e=>{const b=e.target.closest("button[data-tab]");if(!b)return;document.querySelectorAll("#tabs button").forEach(x=>x.classList.toggle("active",x===b));renderPage(b.dataset.tab);});
const connectButton=el("button","Connect FYERS");connectButton.id="connectFyers";connectButton.addEventListener("click",connectFyers);document.querySelector("header").append(connectButton);
async function refreshStatus(){
 try{
  const r=await fetch(API_BASE+"/api/status",{cache:"no-store"});if(!r.ok)throw new Error("Backend status HTTP "+r.status);
  const s=await r.json();
  document.querySelector("#backendStatus").textContent=s.backend||"Unknown";
  document.querySelector("#fyersStatus").textContent=s.fyers||"Not verified";
  document.querySelector("#feedStatus").textContent=s.liveData||"Waiting";
  document.querySelector("#connection").textContent=s.fyers==="connected"?(s.liveData==="streaming"?"FYERS authenticated · verified feed streaming":"FYERS authenticated · waiting for fresh verified ticks"):s.backend==="online"?"Backend online · FYERS not connected":"Backend status unavailable";
  const active=document.querySelector("#tabs button.active")?.dataset.tab;
  if(["dashboard","nifty","banknifty"].includes(active)&&document.querySelector("#liveQuotePanel"))void renderLiveQuotes(active);
 }catch{
  document.querySelector("#backendStatus").textContent="Unreachable";document.querySelector("#fyersStatus").textContent="Not verified";document.querySelector("#feedStatus").textContent="Unavailable";document.querySelector("#connection").textContent="Backend unavailable";
 }
}
(async()=>{await handleAuthCallback();await refreshStatus();renderPage("dashboard");setInterval(refreshStatus,10000);})();