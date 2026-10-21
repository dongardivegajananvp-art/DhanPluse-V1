const API_BASE = window.DHANPULSE_API_BASE || "https://dhanpulse-clean-test.onrender.com";
const panel = document.querySelector("#panel");
const sessionKey = "dhanpulseGapSession";
let sessionToken = sessionStorage.getItem(sessionKey) || "";
const pages = {
 dashboard:["Dashboard","Gap analysis now supports authenticated FYERS daily candles on this branch. Live streaming, full Stock Explorer, and scanners are not implemented here."],
 explorer:["Stock Explorer","The complete F&O quote universe is not connected in this branch. No prices are fabricated."],
 nifty:["NIFTY","Historical gap analysis supports NSE:NIFTY50-INDEX. Live streaming and candlestick charting are not yet connected."],
 banknifty:["BANKNIFTY","Historical gap analysis supports NSE:NSE:NIFTYBANK-INDEX. Live streaming and candlestick charting are not yet connected."],
 gap:["Gap-Up / Gap-Down","Load verified FYERS daily candles and calculate descriptive historical gap-fill statistics."],
 options:["Option Chain & OI","Option-chain data is not connected in this branch. Do not use this page for trade decisions."],
 scanners:["Scanners","Scanners remain blocked until quotes, candles, and option data are verified."],
 journal:["Paper Journal","Paper trading only. Record entry, stop, target, rule adherence, and outcome."]
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
function renderPage(key){
 const [title,description]=pages[key];panel.replaceChildren();
 if(key==="gap"){renderGap();return;}
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