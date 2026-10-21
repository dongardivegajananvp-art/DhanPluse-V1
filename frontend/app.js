const API_BASE = window.DHANPULSE_API_BASE || "https://dhanpulse-clean-test.onrender.com";
const panel = document.querySelector("#panel");
const sessionKey = "dhanpulseGapSession";
let sessionToken = sessionStorage.getItem(sessionKey) || "";
const pages = {
 dashboard:["Dashboard","Gap analysis now supports authenticated FYERS daily candles on this branch. Live streaming, full Stock Explorer, and scanners are not implemented here."],
 explorer:["Stock Explorer","The complete F&O quote universe is not connected in this branch. No prices are fabricated."],
 nifty:["NIFTY","Historical gap analysis supports NSE:NIFTY50-INDEX. Live streaming and candlestick charting are not yet connected."],
 banknifty:["BANKNIFTY","Historical gap analysis supports NSE:NIFTYBANK-INDEX. Live streaming and candlestick charting are not yet connected."],
 gap:["Gap-Up / Gap-Down","Load verified FYERS daily candles and calculate descriptive historical gap-fill statistics."],
 options:["Option Chain & OI","Option-chain data is not connected in this branch. Do not use this page for trade decisions."],
 scanners:["Scanners","Scanners remain blocked until quotes, candles, and option data are verified."],
 journal:["Paper Journal","Paper trading only. Record entry, stop, target, rule adherence, and outcome."],
 activity:["Market Activity","Market-wide activity feed is not implemented yet. No unverified activity is displayed."],
 charts:["Charts & Patterns","Candlestick charting and pattern detection are not implemented in this clean test build."],
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
 capital:["Capital Protection","Risk calculator module is not yet implemented in this clean test build."],
 backtest:["Backtesting","Backtesting beyond historical opening-gap statistics is not implemented yet."],
 settings:["FYERS Settings","FYERS authorization status is shown above. Credentials stay server-side; order placement remains disabled."],
 logs:["Logs","Operational logs are available through the service dashboard; in-app log viewer is not implemented yet."],
 journalRules:["Trade Journal & Rule Review","Paper-only journaling and rule-adherence analytics are not yet implemented."],
 supplyDemand:["Supply & Demand Zones","Supply/demand zones require verified intraday candles and are not implemented yet."]
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
function renderPage(key){
 const [title,description]=pages[key]||["Module","Status unavailable."];
 panel.replaceChildren();
 if(key==="gap"){renderGap();return;}
 if(key==="capital"){renderCapital();return;}
 if(key==="journal"){renderJournal();return;}
 panel.append(el("h2",title),el("p",description));
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
  document.querySelector("#connection").textContent=s.fyers==="connected"?"FYERS authenticated · historical API only":s.backend==="online"?"Backend online · FYERS not connected":"Backend status unavailable";
 }catch{
  document.querySelector("#backendStatus").textContent="Unreachable";document.querySelector("#fyersStatus").textContent="Not verified";document.querySelector("#feedStatus").textContent="Unavailable";document.querySelector("#connection").textContent="Backend unavailable";
 }
}
(async()=>{await handleAuthCallback();await refreshStatus();renderPage("dashboard");setInterval(refreshStatus,10000);})();