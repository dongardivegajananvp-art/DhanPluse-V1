const API_BASE = window.DHANPULSE_API_BASE || "https://dhanpulse-clean-test.onrender.com";
const panel = document.querySelector("#panel");
const sessionKey = "dhanpulseGapSession";
let sessionToken = sessionStorage.getItem(sessionKey) || "";
let candleRefreshTimer = null;
const pages = {
 dashboard:["Dashboard","Verified FYERS streaming quotes are displayed for NIFTY and BANKNIFTY when exchange timestamps are fresh. Historical FYERS candlesticks and gap analysis are available. Full NSE F&O coverage and complete breakout, momentum, and Zero-to-Hero scanners are still incomplete; missing or stale data must block signals."],
 explorer:["Stock Explorer","Loads the current NSE F&O equity universe from FYERS symbol masters and shows only fresh, verified FYERS quotes. Missing or stale symbols are omitted."],
 nifty:["NIFTY","Verified FYERS index quotes and historical candlestick charts are supported. Live tick candles are available only while fresh FYERS ticks are received; stale data blocks the chart."],
 banknifty:["BANKNIFTY","Verified FYERS index quotes and historical candlestick charts are supported. Live tick candles are available only while fresh FYERS ticks are received; stale data blocks the chart."],
 gap:["Gap-Up / Gap-Down","Load verified FYERS daily candles and calculate descriptive historical gap-fill statistics."],
 options:["Option Chain & OI","Read-only FYERS option-chain viewer for supported indices and stocks. Missing OI or volume blocks analysis; no trade signal is generated."],
 scanners:["Scanners","Scanners remain blocked until quotes, candles, and option data are verified."],
 journal:["Paper Journal","Paper trading only. Record entry, stop, target, rule adherence, and outcome."],
 activity:["Market Activity","Market-wide activity feed is not implemented yet. No unverified activity is displayed."],
 charts:["Charts & Patterns","Historical FYERS candlestick charts are available for supported symbols and intervals. Pattern detection is still blocked pending validation."],
 movers:["Gainers & Losers","Ranks the current NSE F&O equity universe only when fresh FYERS quotes are available. Missing or stale symbols are excluded."],
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
 form.addEventListener("submit",ev=>{ev.preventDefault();const side=form.elements.side.value.trim().toUpperCase();const entry=Number(form.elements.entry.value),stop=Number(form.elements.stop.value),target=Number(form.elements.target.value),exitValue=form.elements.exit.value===""?null:Number(form.elements.exit.value);if(!["LONG","SHORT"].includes(side)||![entry,stop,target].every(x=>Number.isFinite(x)&&x>0)||entry===stop||(side==="LONG"&&(stop>=entry||target<=entry))||(side==="SHORT"&&(stop<=entry||target>=entry))||(exitValue!==null&&(!Number.isFinite(exitValue)||exitValue<=0))){out.replaceChildren(el("p","Invalid setup. Use LONG/SHORT with a stop and target on the correct sides of entry.","risk-note"));return;}const plannedRR=Math.abs(target-entry)/Math.abs(entry-stop);const trade={id:Date.now(),createdAt:new Date().toISOString(),symbol:form.elements.symbol.value.trim()||"Unspecified",side,entry,stop,target,plannedRR,exit:exitValue,followed:form.elements.followed.value,notes:form.elements.notes.value.trim()};const rows=readPaperTrades();rows.unshift(trade);try{localStorage.setItem("dhanpulsePaperTrades",JSON.stringify(rows));form.reset();renderJournal();}catch{out.replaceChildren(el("p","Could not save locally. Check browser storage settings.","risk-note"));}});
 panel.append(form,out,el("h3","Saved paper trades"));
 const rows=readPaperTrades();if(!rows.length)panel.append(el("p","No paper trades recorded yet."));else{const list=el("div",undefined,"gap-result");for(const t of rows.slice(0,100)){const box=el("article",undefined,"journal-item");box.append(el("h3",t.symbol+" · "+t.side),el("p","Entry ₹"+t.entry+" · SL ₹"+t.stop+" · Target ₹"+t.target+" · Planned R:R 1:"+((Number.isFinite(Number(t.plannedRR))?Number(t.plannedRR):Math.abs(Number(t.target)-Number(t.entry))/Math.abs(Number(t.entry)-Number(t.stop))).toFixed(2))+(t.exit===null?"":" · Exit ₹"+t.exit)),el("p","Rule adherence: "+t.followed+" · "+new Date(t.createdAt).toLocaleString()),el("p",t.notes||"No notes"));const del=el("button","Delete record");del.type="button";del.addEventListener("click",()=>{localStorage.setItem("dhanpulsePaperTrades",JSON.stringify(readPaperTrades().filter(x=>x.id!==t.id)));renderJournal();});box.append(del);list.append(box);}panel.append(list);}
}
function renderJournalRules(){
 panel.replaceChildren(el("h2","Trade Journal & Rule Review"),el("p","Review uses only paper trades saved in this browser on this device. Results are descriptive, not a prediction; fees, slippage, and position size are not included."));
 const rows=readPaperTrades();
 if(!rows.length){panel.append(el("p","No saved paper trades yet. Record paper trades in Paper Journal first; this page will summarize them."));const b=el("button","Open Paper Journal");b.type="button";b.addEventListener("click",()=>document.querySelector('[data-tab="journal"]').click());panel.append(b);return;}
 const completed=rows.filter(t=>Number.isFinite(Number(t.exit))&&Number(t.exit)>0);
 const followed=rows.filter(t=>t.followed==="yes").length;
 const notFollowed=rows.filter(t=>t.followed==="no"||t.followed==="partial");
 const belowTwoR=rows.filter(t=>Number(t.entry)>0&&Number(t.stop)>0&&Number(t.target)>0&&Math.abs(Number(t.entry)-Number(t.stop))>0&&Math.abs(Number(t.target)-Number(t.entry))/Math.abs(Number(t.entry)-Number(t.stop))<2);
 const stats=el("div",undefined,"gap-result");
 stats.append(el("p","Paper trades recorded: "+rows.length));
 stats.append(el("p","Trades marked rules followed: "+followed+" / "+rows.length+" ("+(100*followed/rows.length).toFixed(1)+"%)"));
 stats.append(el("p","Planned setups below 1:2 risk/reward: "+belowTwoR.length+" / "+rows.length+" · review these before repeating the setup."));
 stats.append(el("p","Trades with an exit recorded: "+completed.length+" / "+rows.length));
 if(completed.length){let totalR=0,wins=0;for(const t of completed){const risk=Math.abs(Number(t.entry)-Number(t.stop));const pnl=(t.side==="LONG"?Number(t.exit)-Number(t.entry):Number(t.entry)-Number(t.exit));const r=risk>0?pnl/risk:0;totalR+=r;if(pnl>0)wins++;}stats.append(el("p","Recorded outcomes: "+wins+" positive of "+completed.length+" closed trades; average result "+(totalR/completed.length).toFixed(2)+"R (before costs)."));}
 panel.append(stats,el("h3","Rule-review flags"));
 if(belowTwoR.length){const rrList=el("div",undefined,"gap-result");for(const t of belowTwoR.slice(0,100)){const rr=Math.abs(Number(t.target)-Number(t.entry))/Math.abs(Number(t.entry)-Number(t.stop));const item=el("article",undefined,"journal-item");item.append(el("h3",t.symbol+" · Planned R:R 1:"+rr.toFixed(2)),el("p","Entry ₹"+t.entry+" · SL ₹"+t.stop+" · Target ₹"+t.target),el("p","Below the preferred 1:2 minimum. Review the plan; this is a journal flag, not a prediction."));rrList.append(item);}panel.append(rrList);}
 if(!notFollowed.length)panel.append(el("p","No trades are currently marked No or Partly. Keep recording honestly; this is not proof that every rule was followed."));
 else{const list=el("div",undefined,"gap-result");for(const t of notFollowed.slice(0,100)){const item=el("article",undefined,"journal-item");item.append(el("h3",t.symbol+" · "+t.side+" · "+t.followed.toUpperCase()),el("p","Entry ₹"+t.entry+" · SL ₹"+t.stop+" · Target ₹"+t.target),el("p",t.notes||"No note was recorded; add a reason in your next journal entry."));list.append(item);}panel.append(list);}
 panel.append(el("p","Limitations: this summary cannot establish strategy profitability from a small sample and does not include brokerage, taxes, slippage, quantity, or market context."));
}
async function renderOptionChain(){
 panel.replaceChildren(el("h2","Option Chain & Open Interest"),el("p","Read-only FYERS option-chain data. Missing OI/volume blocks analysis; this page does not create trade signals or place orders."));
 const form=el("form",undefined,"gap-form");
 const symbols=[["NSE:NIFTY50-INDEX","NIFTY"],["NSE:NIFTYBANK-INDEX","BANKNIFTY"],["NSE:RELIANCE-EQ","RELIANCE"],["NSE:TCS-EQ","TCS"],["NSE:INFY-EQ","INFY"],["NSE:HDFCBANK-EQ","HDFCBANK"],["NSE:ICICIBANK-EQ","ICICIBANK"],["NSE:SBIN-EQ","SBIN"],["NSE:ITC-EQ","ITC"],["NSE:LT-EQ","LT"],["NSE:AXISBANK-EQ","AXISBANK"],["NSE:BAJFINANCE-EQ","BAJFINANCE"]];
 const symbolLabel=el("label","Underlying");
 const symbol=document.createElement("select");symbol.name="symbol";
 for(const [value,title] of symbols){const option=el("option",title);option.value=value;symbol.append(option);}
 symbolLabel.append(symbol);form.append(symbolLabel);
 const countLabel=el("label","Strikes each side of ATM");
 const count=document.createElement("select");count.name="strikecount";
 for(const n of [5,10,15,20,25,50]){const option=el("option",String(n));option.value=String(n);if(n===10)option.selected=true;count.append(option);}
 countLabel.append(count);form.append(countLabel);
 const expiryLabel=el("label","Expiry");
 const expiry=document.createElement("select");expiry.name="timestamp";
 const nearest=el("option","Nearest available expiry");nearest.value="";expiry.append(nearest);
 expiryLabel.append(expiry);form.append(expiryLabel);
 const submit=el("button","Load verified option chain");submit.type="submit";form.append(submit);
 const status=el("p","Connect FYERS to load option-chain data.");
 const summary=el("div",undefined,"gap-result");
 const host=el("div",undefined,"option-chain-table-wrap");
 form.addEventListener("submit",async event=>{
  event.preventDefault();
  if(!sessionToken){status.textContent="Connect FYERS first. No demo option data is shown.";host.replaceChildren();summary.replaceChildren();return;}
  submit.disabled=true;status.textContent="Requesting option chain from FYERS…";host.replaceChildren();summary.replaceChildren();
  const q=new URLSearchParams({symbol:symbol.value,strikecount:count.value,greeks:"1"});
  if(expiry.value)q.set("timestamp",expiry.value);
  try{
   const r=await fetch(API_BASE+"/api/fyers/options-chain?"+q.toString(),{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}});
   const result=await r.json();
   if(r.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);throw new Error("FYERS dashboard session expired. Connect FYERS again.");}
   if(!r.ok||!result.ok||!Array.isArray(result.data)||!result.data.length)throw new Error(result.detail||result.error||"Verified option-chain data unavailable.");
   const prior=expiry.value;
   expiry.replaceChildren();const exps=Array.isArray(result.expiryData)?result.expiryData:[];
   for(const item of exps){if(!item||!/^\d{10}$/.test(String(item.expiry))||typeof item.date!=="string")continue;const option=el("option",item.date);option.value=String(item.expiry);expiry.append(option);}
   if(!expiry.options.length){const option=el("option","Expiry unavailable");option.value="";expiry.append(option);}
   if(prior&&Array.from(expiry.options).some(o=>o.value===prior))expiry.value=prior;
   else if(!prior&&expiry.options.length>1)expiry.value=expiry.options[1].value;
   summary.append(el("h3",result.symbol+" · Underlying ₹"+Number(result.underlyingLtp).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})));
   summary.append(el("p","Source: "+result.source+" · Retrieved: "+new Date(result.fetchedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})));
   summary.append(el("p","Total call OI: "+(result.callOi===null?"Unavailable":Number(result.callOi).toLocaleString("en-IN"))+" · Total put OI: "+(result.putOi===null?"Unavailable":Number(result.putOi).toLocaleString("en-IN"))));
   summary.append(el("p",result.dataComplete?"OI and volume fields passed completeness checks, but exchange-time freshness and liquidity are not independently validated. Signals remain blocked.":"Data incomplete: "+result.warning+" Trade analysis must remain blocked.","risk-note"));
   const byStrike=new Map();
   for(const leg of result.data){if(leg.verified!==true||!Number.isFinite(Number(leg.strike))||!["CE","PE"].includes(leg.type))continue;const row=byStrike.get(Number(leg.strike))||{};row[leg.type]=leg;byStrike.set(Number(leg.strike),row);}
   const table=document.createElement("table");table.className="option-chain-table";
   const head=document.createElement("thead"),hr=document.createElement("tr");
   for(const title of ["Strike","CE LTP","CE OI","CE OI Δ","CE Volume","PE LTP","PE OI","PE OI Δ","PE Volume"]){hr.append(el("th",title));}
   head.append(hr);table.append(head);
   const body=document.createElement("tbody");
   const fmt=v=>v===null||v===undefined||!Number.isFinite(Number(v))?"—":Number(v).toLocaleString("en-IN",{maximumFractionDigits:2});
   for(const [strike,pair] of [...byStrike.entries()].sort((a,b)=>a[0]-b[0])){
    const tr=document.createElement("tr");tr.append(el("td",fmt(strike)));
    for(const type of ["CE","PE"]){const leg=pair[type];for(const field of ["ltp","oi","oiChange","volume"]){tr.append(el("td",leg?fmt(leg[field]):"—"));}}
    body.append(tr);
   }
   table.append(body);host.append(table);
   status.textContent="FYERS option chain loaded · "+byStrike.size+" strikes · "+(result.dataComplete?"OI/volume present; signals blocked pending freshness validation":"incomplete data — analysis blocked");
  }catch(error){status.textContent=String(error?.message||"Option-chain data unavailable.")+" No placeholder option data is displayed.";host.replaceChildren();summary.replaceChildren();}
  finally{submit.disabled=false;}
 });
 symbol.addEventListener("change",()=>{expiry.value="";if(sessionToken)form.requestSubmit();});
 count.addEventListener("change",()=>{if(sessionToken)form.requestSubmit();});
 expiry.addEventListener("change",()=>{if(sessionToken&&expiry.value)form.requestSubmit();});
 panel.append(form,status,summary,host);
 if(sessionToken)form.requestSubmit();
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
  if(r.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);throw new Error("FYERS dashboard session expired. Connect FYERS again.");}
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
   const ageMs=time?Date.now()-time.getTime():Infinity;
   if(!Number.isFinite(price)||price<=0||!time||Number.isNaN(time.getTime())||ageMs < -30000||ageMs > 120000)continue;
   const card=el("article",undefined,"quote-card");
   card.append(el("span",label),el("strong","₹"+price.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})),el("small","Exchange time: "+time.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})));
   const chp=Number(item.v?.chp);
   if(Number.isFinite(chp))card.append(el("small",(chp>=0?"+":"")+chp.toFixed(2)+"% (FYERS reported change)"));
   target.append(card);
  }
  const validCards=target.querySelectorAll(".quote-card").length;
  if(validCards!==wanted.length)throw new Error("Only "+validCards+" of "+wanted.length+" required index quote(s) passed price and 120-second exchange-timestamp validation.");
 }catch(error){
  target.append(el("p",String(error?.message||"Verified quotes unavailable.")+" No placeholder price is displayed."));
 }
}
async function renderStockExplorer(){
 const box=el("section",undefined,"stock-explorer");
 box.append(el("p","Loading the current NSE F&O equity universe and fresh FYERS quotes…"));
 panel.append(box);
 if(!sessionToken){box.replaceChildren(el("p","Connect FYERS to load verified stock quotes. No sample prices are shown."));return;}
 const refresh=el("button","Refresh verified quotes");refresh.type="button";
 const sortLabel=el("label","Rank quotes by ");
 const sort=document.createElement("select");sort.setAttribute("aria-label","Rank verified F&O quotes");
 for(const [v,t] of [["gainers","Top gainers (% change)"],["losers","Top losers (% change)"],["movement","Largest absolute move (%)"]]){const o=el("option",t);o.value=v;sort.append(o);}
 sortLabel.append(sort);
 const status=el("p","Quotes must have exchange timestamps within 120 seconds.");
 const tableHost=el("div",undefined,"option-chain-table-wrap");
 const table=document.createElement("table");table.className="option-chain-table";
 const head=document.createElement("thead"),hr=document.createElement("tr");
 for(const name of ["Symbol","LTP (₹)","Change (₹)","Change %","Exchange time (IST)"]){const th=el("th",name);hr.append(th);}
 head.append(hr);table.append(head);const tbody=document.createElement("tbody");table.append(tbody);tableHost.append(table);
 box.replaceChildren(el("h3","Verified NSE F&O equity quotes"),el("p","Universe source: current FYERS NSE_FO + NSE_CM symbol masters. Only quotes with valid exchange timestamps within 120 seconds are displayed. If FYERS rate-limits a batch, partial rankings are discarded."),sortLabel,refresh,status,tableHost);
 let verifiedRows=[];
 function paintRows(){
  tbody.replaceChildren();
  const rows=verifiedRows.slice().sort((x,y)=>sort.value==="losers"?Number(x.v.chp)-Number(y.v.chp):sort.value==="movement"?Math.abs(Number(y.v.chp))-Math.abs(Number(x.v.chp)):Number(y.v.chp)-Number(x.v.chp));
  for(const item of rows){
    const tr=document.createElement("tr");
    const symbol=item.n.replace("NSE:","").replace("-EQ","");
    const stamp=new Date(Number(item.v.tt)*1000);
    const change=safeNumber(item.v.ch);
    const vals=[symbol,Number(item.v.lp).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}),change===null?"—":change.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}),(Number(item.v.chp)>=0?"+":"")+Number(item.v.chp).toFixed(2)+"%",stamp.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})];
    vals.forEach((v,i)=>{const td=el("td",v);if(i===3)td.style.color=Number(item.v.chp)>=0?"#63f0cb":"#ff718c";tr.append(td);});
    tbody.append(tr);
  }
 }
 async function load(){
  refresh.disabled=true;status.textContent="Requesting fresh FYERS quotes…";tbody.replaceChildren();
  try{
   const r=await fetch(API_BASE+"/api/market/stock-quotes",{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}});
   const data=await r.json();
   if(r.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);throw new Error("FYERS session expired. Connect FYERS again.");}
   if(!r.ok||!Array.isArray(data.data))throw new Error([data.error,data.detail,data.retryAfterSeconds?("Retry in "+data.retryAfterSeconds+" seconds."):null].filter(Boolean).join(" · ")||"Fresh verified quotes unavailable.");
   const nowMs=Date.now();
   verifiedRows=data.data.filter(item=>{
    if(!item||item.verified!==true||!item.v)return false;
    const lp=Number(item.v.lp),ch=Number(item.v.ch),chp=Number(item.v.chp),stamp=Number(item.v.tt)*1000;
    const age=nowMs-stamp;
    return Number.isFinite(lp)&&lp>0&&Number.isFinite(ch)&&Number.isFinite(chp)&&stamp>0&&age>=-30000&&age<=120000;
   });
   if(!verifiedRows.length)throw new Error("FYERS returned no quotes that passed the client-side 120-second freshness check. Wait for fresh data; no stale prices are shown.");
   paintRows();
   status.textContent="Source: FYERS quotes API · "+verifiedRows.length+" fresh verified quote(s) of "+(data.universeCount||verifiedRows.length)+" F&O symbols · sorted by "+sort.options[sort.selectedIndex].text+" · fetched "+new Date(data.fetchedAt).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"})+" IST · client-side freshness checked · missing/stale symbols omitted.";
  }catch(err){verifiedRows=[];tbody.replaceChildren();status.textContent=String(err?.message||"Verified quotes unavailable.")+" No stale or placeholder prices are shown.";}
  finally{refresh.disabled=false;}
 }
 sort.addEventListener("change",paintRows);
 refresh.addEventListener("click",load);await load();
}
function renderTechnicalIndicators(){
 panel.replaceChildren(el("h2","Technical Indicators"),el("p","Indicators are calculated locally from verified FYERS historical candles only. This is descriptive analysis, not a trade signal. Missing or invalid candles block results."));
 if(!sessionToken){panel.append(el("p","Connect FYERS first to calculate indicators from authenticated historical candles."));return;}
 const form=el("form",undefined,"gap-form");
 const symbolLabel=el("label","Symbol"),symbol=document.createElement("select");symbol.name="symbol";
 for(const [value,title] of [["NSE:NIFTY50-INDEX","NIFTY"],["NSE:NIFTYBANK-INDEX","BANKNIFTY"],["NSE:RELIANCE-EQ","RELIANCE"],["NSE:TCS-EQ","TCS"],["NSE:INFY-EQ","INFY"],["NSE:HDFCBANK-EQ","HDFCBANK"],["NSE:ICICIBANK-EQ","ICICIBANK"],["NSE:SBIN-EQ","SBIN"],["NSE:ITC-EQ","ITC"],["NSE:LT-EQ","LT"],["NSE:AXISBANK-EQ","AXISBANK"],["NSE:BAJFINANCE-EQ","BAJFINANCE"]]){const o=el("option",title);o.value=value;symbol.append(o);}
 symbolLabel.append(symbol);form.append(symbolLabel);
 const intervalLabel=el("label","Candle interval"),interval=document.createElement("select");interval.name="resolution";
 for(const [v,t] of [["5","5 minutes"],["15","15 minutes"],["30","30 minutes"],["60","1 hour"],["D","Daily"]]){const o=el("option",t);o.value=v;interval.append(o);}
 intervalLabel.append(interval);form.append(intervalLabel);
 const btn=el("button","Calculate verified indicators");btn.type="submit";form.append(btn);
 const status=el("p","Ready to request verified candles."),out=el("div",undefined,"gap-result");out.setAttribute("aria-live","polite");
 form.addEventListener("submit",async ev=>{
  ev.preventDefault();btn.disabled=true;status.textContent="Loading verified FYERS candles…";out.replaceChildren();
  const today=istDateString(new Date()),days=interval.value==="D"?120:14,from=istDateString(new Date(Date.now()-days*86400000));
  const q=new URLSearchParams({symbol:symbol.value,resolution:interval.value,from,to:today});
  try{
   const r=await fetch(API_BASE+"/api/market/candles?"+q,{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}});
   const d=await r.json();if(r.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);throw new Error("Session expired. Connect FYERS again.");}
   if(!r.ok||!d.ok||!Array.isArray(d.data))throw new Error(d.error||d.detail||"Verified candles unavailable.");
   const rows=d.data.filter(c=>c.verified===true&&c.source==="FYERS"&&Number.isFinite(Date.parse(c.timestamp))&&[c.open,c.high,c.low,c.close].every(v=>Number.isFinite(Number(v))&&Number(v)>0)&&Number(c.high)>=Math.max(Number(c.open),Number(c.close),Number(c.low))&&Number(c.low)<=Math.min(Number(c.open),Number(c.close),Number(c.high))).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
   const closes=rows.map(c=>Number(c.close));
   if(closes.length<20)throw new Error("Only "+closes.length+" valid candles; at least 20 are required. Indicators blocked.");
   const sma20=closes.slice(-20).reduce((a,b)=>a+b,0)/20;
   const changes=closes.slice(1).map((v,i)=>v-closes[i]);
   const recent=changes.slice(-14),gains=recent.reduce((a,v)=>a+Math.max(v,0),0)/14,losses=recent.reduce((a,v)=>a+Math.max(-v,0),0)/14;
   const rsi=losses===0?(gains===0?50:100):100-(100/(1+gains/losses));
   const last=closes[closes.length-1],previous=closes[closes.length-2];
   out.append(el("h3",symbol.options[symbol.selectedIndex].text+" · Verified indicator snapshot"));
   out.append(el("p","Last candle close: ₹"+last.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})+" · Candle time: "+new Date(rows[rows.length-1].timestamp).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})));
   out.append(el("p","SMA 20: "+sma20.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})+" · Close is "+(last>sma20?"above":last<sma20?"below":"at")+" SMA 20."));
   out.append(el("p","RSI 14 (simple average gain/loss): "+rsi.toFixed(2)+(rsi>=70?" · traditionally overbought zone":rsi<=30?" · traditionally oversold zone":" · between 30 and 70")));
   out.append(el("p","Latest candle close change: "+(last-previous>=0?"+":"")+(last-previous).toFixed(2)));
   out.append(el("p","Source: "+d.source+" · Valid candles used: "+rows.length+" · Fetched: "+new Date(d.fetchedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})+". RSI uses a simple 14-period average, not Wilder smoothing; this is not a buy/sell recommendation."));
   status.textContent="Indicators calculated from verified historical candles.";
  }catch(err){status.textContent=String(err.message||err);out.replaceChildren(el("p","No indicator result shown because the data check failed.","risk-note"));}
  finally{btn.disabled=false;}
 });
 panel.append(form,status,out);
 form.requestSubmit();
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


const supportedStockSymbols = [
 ["NSE:RELIANCE-EQ","RELIANCE"],["NSE:TCS-EQ","TCS"],["NSE:INFY-EQ","INFY"],
 ["NSE:HDFCBANK-EQ","HDFCBANK"],["NSE:ICICIBANK-EQ","ICICIBANK"],["NSE:SBIN-EQ","SBIN"],
 ["NSE:ITC-EQ","ITC"],["NSE:LT-EQ","LT"],["NSE:AXISBANK-EQ","AXISBANK"],["NSE:BAJFINANCE-EQ","BAJFINANCE"]
];
function safeNumber(value){const n=Number(value);return Number.isFinite(n)?n:null;}
function verifiedQuoteRows(data){
 const now=Date.now();
 if(!data||data.ok!==true||!Array.isArray(data.data))return [];
 return data.data.filter(item=>{
  const v=item?.v, price=safeNumber(v?.lp), stamp=safeNumber(v?.tt);
  return item.verified===true&&price!==null&&price>0&&stamp!==null&&stamp>0&&Math.abs(now-stamp*1000)<=120000&&safeNumber(v?.chp)!==null;
 });
}
async function fetchStockQuotes(){
 if(!sessionToken)throw new Error("Connect FYERS first. No sample prices are displayed.");
 const r=await fetch(API_BASE+"/api/market/stock-quotes",{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}});
 const data=await r.json();
 if(r.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);throw new Error("FYERS session expired. Connect FYERS again.");}
 if(r.status===429)throw new Error(data.error||"FYERS rate limit reached. Wait before retrying.");
 if(!r.ok)throw new Error(data.detail||data.error||"Verified stock quotes unavailable.");
 const rows=verifiedQuoteRows(data);
 if(!rows.length)throw new Error("No supported stock quote has a fresh exchange timestamp. Results blocked.");
 return {rows, fetchedAt:data.fetchedAt, universeCount:Number.isFinite(Number(data.universeCount))?Number(data.universeCount):data.data.length, missingSymbols:Array.isArray(data.missingSymbols)?data.missingSymbols:[]};
}
function renderMovers(){
  panel.replaceChildren(el("h2","Verified NSE F&O Gainers & Losers"),el("p","Ranks current NSE F&O equities using the FYERS symbol master and fresh quotes. Quotes older than 120 seconds are rejected; rate-limited partial batches are not ranked."));
  const controls=el("div",undefined,"gap-form");
  const rankLabel=el("label","Rank by ");
  const rank=document.createElement("select");rank.setAttribute("aria-label","Rank F&O movers");
  for(const [value,label] of [["gainers","Top gainers (% change)"],["losers","Top losers (% change)"],["movement","Largest absolute move (%)"]]){const option=el("option",label);option.value=value;rank.append(option);}
  rankLabel.append(rank);controls.append(rankLabel);
  const btn=el("button","Refresh verified movers");btn.type="button";
  const status=el("p","Connect FYERS to load current quotes."),host=el("div",undefined,"option-chain-table-wrap");
  btn.addEventListener("click",load);rank.addEventListener("change",paint);panel.append(controls,btn,status,host);
  let currentRows=[],currentMeta=null;
  function paint(){
   host.replaceChildren();
   if(!currentRows.length)return;
   const rows=currentRows.slice().sort((a,b)=>{
    const av=Number(a.v.chp),bv=Number(b.v.chp);
    if(rank.value==="losers")return av-bv;
    if(rank.value==="movement")return Math.abs(bv)-Math.abs(av);
    return bv-av;
   });
   const table=document.createElement("table");table.className="option-chain-table";
   const thead=document.createElement("thead"),hr=document.createElement("tr");
   ["Rank","Symbol","LTP (₹)","Change (₹)","Change %","Exchange time (IST)"].forEach(x=>hr.append(el("th",x)));thead.append(hr);table.append(thead);
   const body=document.createElement("tbody");
   rows.forEach((item,i)=>{
    const tr=document.createElement("tr"),stamp=new Date(Number(item.v.tt)*1000),symbol=item.n.replace("NSE:","").replace("-EQ","");
    const change=safeNumber(item.v.ch),pct=Number(item.v.chp);
    [String(i+1),symbol,Number(item.v.lp).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}),change===null?"—":change.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}),(pct>=0?"+":"")+pct.toFixed(2)+"%",stamp.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})].forEach((v,j)=>{const td=el("td",v);if(j===4)td.style.color=pct>=0?"#63f0cb":"#ff718c";tr.append(td);});
    body.append(tr);
   });
   table.append(body);host.append(table);
   status.textContent="FYERS F&O universe · "+rows.length+" fresh verified quote(s) of "+(currentMeta.universeCount||rows.length)+" symbols · sorted by "+rank.options[rank.selectedIndex].text+" · fetched "+new Date(currentMeta.fetchedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})+" · missing/stale symbols omitted.";
  }
  async function load(){
   btn.disabled=true;status.textContent="Requesting fresh FYERS quotes…";host.replaceChildren();currentRows=[];
   try{currentMeta=await fetchStockQuotes();currentRows=currentMeta.rows;paint();}
   catch(e){status.textContent=String(e.message||e)+" No stale prices shown.";}
   finally{btn.disabled=false;}
  }
  if(sessionToken)load();
}
 function renderWatchlist(){
 panel.replaceChildren(el("h2","Watchlist"),el("p","Your personal watchlist is stored only in this browser. Prices are requested from FYERS and shown only when exchange timestamps are fresh."));
 const key="dhanpulseWatchlist";let selected;
 try{selected=JSON.parse(localStorage.getItem(key)||"[\"NSE:RELIANCE-EQ\",\"NSE:TCS-EQ\",\"NSE:INFY-EQ\",\"NSE:HDFCBANK-EQ\",\"NSE:SBIN-EQ\"]");if(!Array.isArray(selected))selected=[];}catch{selected=[];}
 const chooser=el("div",undefined,"gap-form"),status=el("p","Connect FYERS to load verified quotes."),host=el("div",undefined,"option-chain-table-wrap");
 const label=el("label","Add supported symbol");const select=document.createElement("select");
 supportedStockSymbols.forEach(([symbol,name])=>{const opt=el("option",name);opt.value=symbol;select.append(opt);});label.append(select);
 const add=el("button","Add to watchlist");add.type="button";add.addEventListener("click",()=>{if(!selected.includes(select.value))selected.push(select.value);localStorage.setItem(key,JSON.stringify(selected));load();});
 const refresh=el("button","Refresh quotes");refresh.type="button";refresh.addEventListener("click",load);chooser.append(label,add,refresh);panel.append(chooser,status,host);
 async function load(){status.textContent="Loading verified quotes…";host.replaceChildren();try{
  const result=await fetchStockQuotes(),wanted=result.rows.filter(row=>selected.includes(row.n));
  const table=document.createElement("table");table.className="option-chain-table";const h=document.createElement("thead"),hr=document.createElement("tr");
  ["Symbol","LTP (₹)","Change %","Exchange time","Action"].forEach(x=>hr.append(el("th",x)));h.append(hr);table.append(h);const body=document.createElement("tbody");
  for(const row of wanted){const tr=document.createElement("tr"),symbol=row.n.replace("NSE:","").replace("-EQ",""),stamp=new Date(Number(row.v.tt)*1000);
   [symbol,Number(row.v.lp).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2}),(Number(row.v.chp)>=0?"+":"")+Number(row.v.chp).toFixed(2)+"%",stamp.toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})].forEach(v=>tr.append(el("td",v)));
   const td=document.createElement("td"),remove=el("button","Remove");remove.type="button";remove.addEventListener("click",()=>{selected=selected.filter(s=>s!==row.n);localStorage.setItem(key,JSON.stringify(selected));load();});td.append(remove);tr.append(td);body.append(tr);
  }
  table.append(body);host.append(table);status.textContent=wanted.length+" of "+selected.length+" selected symbols have fresh verified quotes. Universe limited to 10 supported stocks; not full F&O.";
 }catch(e){status.textContent=String(e.message||e)+" No stale prices shown.";} }
 if(sessionToken)load();
}
function renderScanner(key){
 const titles={breakout:"Breakout Scanner · Supported Symbol Study",momentum:"Momentum Scanner · Supported Symbol Study",zerohero:"Zero-to-Hero · Movement Watchlist"};
 panel.replaceChildren(el("h2",titles[key]||"Verified Scanner"),el("p","This is a single-symbol, historical-candle study for the supported list—not a full-market scanner or guaranteed option setup. It blocks when verified candles are missing, malformed, or stale."));
 const form=el("form",undefined,"gap-form"),symLabel=el("label","Underlying");
 const sym=document.createElement("select");supportedStockSymbols.forEach(([v,n])=>{const o=el("option",n);o.value=v;sym.append(o);});symLabel.append(sym);form.append(symLabel);
 const resLabel=el("label","Interval"),resolution=document.createElement("select");
 [["5","5 minutes"],["15","15 minutes"],["30","30 minutes"]].forEach(([v,n])=>{const o=el("option",n);o.value=v;resolution.append(o);});resLabel.append(resolution);form.append(resLabel);
 const run=el("button",key==="zerohero"?"Review price movement":"Run verified study");run.type="submit";form.append(run);
 const status=el("p","Connect FYERS to run a verified study."),out=el("div",undefined,"gap-result");form.addEventListener("submit",async ev=>{ev.preventDefault();if(!sessionToken){status.textContent="Connect FYERS first.";return;}
  run.disabled=true;status.textContent="Requesting verified FYERS candles…";out.replaceChildren();
  const now=new Date(),from=new Date(Date.now()-7*86400000),fmt=d=>{const z=new Date(d.getTime()-d.getTimezoneOffset()*60000);return z.toISOString().slice(0,10);};
  const q=new URLSearchParams({symbol:sym.value,resolution:resolution.value,from:fmt(from),to:fmt(now)});
  try{const r=await fetch(API_BASE+"/api/market/candles?"+q.toString(),{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}}),data=await r.json();
   if(r.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);}
   if(r.status===429)throw new Error("FYERS historical-data rate limit/cooldown. Wait before retrying; do not repeatedly refresh.");
   if(!r.ok||data.ok!==true||!Array.isArray(data.data))throw new Error(data.detail||data.error||"Verified candle request failed.");
   const bars=data.data.filter(c=>c.verified===true&&c.source==="FYERS"&&Number.isFinite(Date.parse(c.timestamp))&&[c.open,c.high,c.low,c.close].every(v=>safeNumber(v)>0)&&Number(c.high)>=Math.max(Number(c.open),Number(c.low),Number(c.close))&&Number(c.low)<=Math.min(Number(c.open),Number(c.high),Number(c.close))).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
   if(bars.length<22)throw new Error("Need at least 22 valid FYERS candles; only "+bars.length+" passed validation.");
   const latest=bars[bars.length-1],prior=bars.slice(-21,-1),priorHigh=Math.max(...prior.map(c=>Number(c.high))),priorLow=Math.min(...prior.map(c=>Number(c.low)));
   const close=Number(latest.close),first=Number(bars[bars.length-6].close),move=(close/first-1)*100;
   const gains=[],losses=[];for(let i=bars.length-14;i<bars.length;i++){const delta=Number(bars[i].close)-Number(bars[i-1].close);if(delta>=0)gains.push(delta);else losses.push(-delta);}
   const avgGain=gains.reduce((a,b)=>a+b,0)/14,avgLoss=losses.reduce((a,b)=>a+b,0)/14,rsi=avgLoss===0?100:100-(100/(1+avgGain/avgLoss));
   const breakoutUp=close>priorHigh,breakoutDown=close<priorLow;
   out.append(el("h3",sym.options[sym.selectedIndex].text+" · ₹"+close.toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})));
   out.append(el("p","Last candle: "+new Date(latest.timestamp).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})+" · Source: "+data.source+" · Valid candles: "+bars.length));
   if(key==="breakout"){out.append(el("p",breakoutUp?"Possible upside range break: last close is above the previous 20-candle high.":breakoutDown?"Possible downside range break: last close is below the previous 20-candle low.":"No 20-candle range break on the last close."));out.append(el("p","Previous 20-candle high ₹"+priorHigh.toFixed(2)+" · low ₹"+priorLow.toFixed(2)));}
   else if(key==="momentum"){out.append(el("p","Last 5-candle close change: "+(move>=0?"+":"")+move.toFixed(2)+"% · Simple 14-period RSI: "+rsi.toFixed(1)));out.append(el("p",move>0&&rsi>=55?"Positive price momentum in this sample; not an entry signal.":move<0&&rsi<=45?"Negative price momentum in this sample; not an entry signal.":"Momentum is mixed/neutral; no directional claim."));}
   else{out.append(el("p","5-candle close change: "+(move>=0?"+":"")+move.toFixed(2)+"%. This page ranks only one selected underlying at a time; it cannot verify option premium, traded quantity, or a zero-to-hero contract."));}
   out.append(el("p","No option entry, stop, target, or trade recommendation is generated. Historical candles alone do not validate live execution, liquidity, or a 1:2 setup.","risk-note"));
   status.textContent="Study complete · verified FYERS historical candles only.";
  }catch(e){status.textContent=String(e.message||e)+" Signals remain blocked.";out.replaceChildren();}finally{run.disabled=false;}
 });panel.append(form,status,out);
}


function renderAlerts(){
 const storageKey="dhanpulsePriceAlerts";let rules=[];
 try{rules=JSON.parse(localStorage.getItem(storageKey)||"[]");if(!Array.isArray(rules))rules=[];}catch{rules=[];}
 panel.replaceChildren(el("h2","Price Alerts"),el("p","Create browser-local price or daily-change thresholds for the supported stock subset. Alert checks are manual when you press Check now; this page does not run in the background or send notifications when closed."));
 const form=el("form",undefined,"gap-form"),symbolLabel=el("label","Supported symbol"),symbol=document.createElement("select");
 supportedStockSymbols.forEach(([v,n])=>{const o=el("option",n);o.value=v;symbol.append(o);});symbolLabel.append(symbol);form.append(symbolLabel);
 const typeLabel=el("label","Alert type"),type=document.createElement("select");
 [["priceAbove","Price rises above (₹)"],["priceBelow","Price falls below (₹)"],["changeAbove","Change % above"],["changeBelow","Change % below"]].forEach(([v,n])=>{const o=el("option",n);o.value=v;type.append(o);});typeLabel.append(type);form.append(typeLabel);
 const valueLabel=el("label","Threshold"),value=document.createElement("input");value.type="number";value.min="0.01";value.step="any";value.required=true;valueLabel.append(value);form.append(valueLabel);
 const add=el("button","Save alert rule");add.type="submit";form.append(add);
 const check=el("button","Check alerts against fresh FYERS quotes");check.type="button";
 const status=el("p","Rules are stored only in this browser."),host=el("div",undefined,"gap-result");
 function renderRules(){host.replaceChildren();if(!rules.length){host.append(el("p","No alert rules saved."));return;}rules.forEach(rule=>{const row=el("article",undefined,"quote-card"),name=supportedStockSymbols.find(x=>x[0]===rule.symbol)?.[1]||rule.symbol;row.append(el("strong",name),el("p",rule.label+" "+rule.value+(rule.type.startsWith("change")?"%":" ₹")),el("small",rule.lastStatus||"Not checked yet"));const del=el("button","Delete");del.type="button";del.addEventListener("click",()=>{rules=rules.filter(x=>x.id!==rule.id);localStorage.setItem(storageKey,JSON.stringify(rules));renderRules();});row.append(del);host.append(row);});}
 form.addEventListener("submit",ev=>{ev.preventDefault();const n=Number(value.value);if(!Number.isFinite(n)||n<=0){status.textContent="Enter a positive threshold.";return;}const labels={priceAbove:"Price rises above",priceBelow:"Price falls below",changeAbove:"Change % above",changeBelow:"Change % below"};rules.push({id:Date.now().toString(36)+Math.random().toString(36).slice(2,7),symbol:symbol.value,type:type.value,value:n,label:labels[type.value],createdAt:new Date().toISOString()});localStorage.setItem(storageKey,JSON.stringify(rules));status.textContent="Alert rule saved locally.";renderRules();});
 check.addEventListener("click",async()=>{check.disabled=true;status.textContent="Checking current FYERS quotes…";try{const result=await fetchStockQuotes();let fired=0;rules=rules.map(rule=>{const row=result.rows.find(x=>x.n===rule.symbol);if(!row)return {...rule,lastStatus:"No fresh quote; not evaluated."};const price=Number(row.v.lp),change=Number(row.v.chp);const hit=rule.type==="priceAbove"?price>=rule.value:rule.type==="priceBelow"?price<=rule.value:rule.type==="changeAbove"?change>=rule.value:change<=-rule.value;if(hit)fired++;return {...rule,lastStatus:(hit?"TRIGGERED":"Not triggered")+" · LTP ₹"+price.toFixed(2)+" · change "+change.toFixed(2)+"% · "+new Date(Number(row.v.tt)*1000).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})};});localStorage.setItem(storageKey,JSON.stringify(rules));status.textContent=fired+" rule(s) triggered from "+result.rows.length+" fresh verified quote(s). This is an on-screen check only.";renderRules();}catch(e){status.textContent=String(e.message||e)+" Alerts were not evaluated on stale data.";}finally{check.disabled=false;}});
 panel.append(form,check,status,host);renderRules();
}
function renderBacktest(){
 panel.replaceChildren(el("h2","Historical Breakout Backtest"),el("p","A transparent educational backtest on one supported symbol using verified historical FYERS candles. This is not the full scanner or proof of future performance. Uses close above the prior 20-bar high, next-bar open entry, 1% stop and 2% target; if stop and target are both touched in one candle, stop is assumed first."));
 const form=el("form",undefined,"gap-form"),symLabel=el("label","Underlying"),sym=document.createElement("select");
 supportedStockSymbols.forEach(([v,n])=>{const o=el("option",n);o.value=v;sym.append(o);});symLabel.append(sym);form.append(symLabel);
 const resLabel=el("label","Interval"),res=document.createElement("select");[["5","5 minutes"],["15","15 minutes"],["30","30 minutes"],["D","Daily"]].forEach(([v,n])=>{const o=el("option",n);o.value=v;res.append(o);});resLabel.append(res);form.append(resLabel);
 const run=el("button","Run historical backtest");run.type="submit";form.append(run);
 const status=el("p","Connect FYERS to run the backtest."),out=el("div",undefined,"gap-result");
 form.addEventListener("submit",async ev=>{ev.preventDefault();if(!sessionToken){status.textContent="Connect FYERS first.";return;}run.disabled=true;status.textContent="Loading historical candles from FYERS…";out.replaceChildren();
  const now=new Date(),days=res.value==="D"?350:25,from=new Date(Date.now()-days*86400000),fmt=d=>{const z=new Date(d.getTime()-d.getTimezoneOffset()*60000);return z.toISOString().slice(0,10);};
  const q=new URLSearchParams({symbol:sym.value,resolution:res.value,from:fmt(from),to:fmt(now)});
  try{const response=await fetch(API_BASE+"/api/market/candles?"+q.toString(),{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}}),data=await response.json();if(response.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);}if(response.status===429)throw new Error("FYERS historical-data cooldown active. Wait before retrying.");if(!response.ok||data.ok!==true||!Array.isArray(data.data))throw new Error(data.detail||data.error||"Historical data unavailable.");
   const bars=data.data.filter(c=>c.verified===true&&c.source==="FYERS"&&Number.isFinite(Date.parse(c.timestamp))&&[c.open,c.high,c.low,c.close].every(v=>safeNumber(v)>0)&&Number(c.high)>=Math.max(Number(c.open),Number(c.low),Number(c.close))&&Number(c.low)<=Math.min(Number(c.open),Number(c.high),Number(c.close))).sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
   if(bars.length<25)throw new Error("At least 25 valid candles are required; "+bars.length+" passed validation.");
   let trades=[],position=null;
   for(let i=20;i<bars.length;i++){const b=bars[i],close=Number(b.close),high20=Math.max(...bars.slice(i-20,i).map(x=>Number(x.high)));
    if(position){const hi=Number(b.high),lo=Number(b.low);let exit=null,reason="";if(lo<=position.stop){exit=position.stop;reason="stop (conservative intrabar assumption)";}else if(hi>=position.target){exit=position.target;reason="target";}else if(i-position.entryIndex>=5){exit=close;reason="time exit";}if(exit!==null){trades.push({entry:position.entry,exit,ret:(exit/position.entry-1)*100,reason});position=null;}}
    if(!position&&close>high20&&i+1<bars.length){const entry=Number(bars[i+1].open);if(entry>0)position={entry,stop:entry*.99,target:entry*1.02,entryIndex:i+1};}
   }
   if(position){const exit=Number(bars[bars.length-1].close);trades.push({entry:position.entry,exit,ret:(exit/position.entry-1)*100,reason:"end of sample"});}
   const wins=trades.filter(t=>t.ret>0).length,losses=trades.filter(t=>t.ret<=0).length,net=trades.reduce((sum,t)=>sum+t.ret,0),grossWin=trades.filter(t=>t.ret>0).reduce((sum,t)=>sum+t.ret,0),grossLoss=Math.abs(trades.filter(t=>t.ret<0).reduce((sum,t)=>sum+t.ret,0));
   out.append(el("h3",sym.options[sym.selectedIndex].text+" · "+trades.length+" closed sample trade(s)"));
   out.append(el("p","Verified candles: "+bars.length+" · Source: "+data.source+" · Range: "+fmt(new Date(bars[0].timestamp))+" to "+fmt(new Date(bars[bars.length-1].timestamp))));
   out.append(el("p","Wins: "+wins+" · Losses/breakeven: "+losses+" · Win rate: "+(trades.length?(wins/trades.length*100).toFixed(1)+"%":"—")));
   out.append(el("p","Sum of individual trade returns (not compounded): "+(net>=0?"+":"")+net.toFixed(2)+"% · Gross profit factor: "+(grossLoss? (grossWin/grossLoss).toFixed(2):grossWin?"No losing trades in sample":"—")));
   const table=document.createElement("table");table.className="option-chain-table";const thead=document.createElement("thead"),hr=document.createElement("tr");["#","Entry","Exit","Return %","Exit reason"].forEach(x=>hr.append(el("th",x)));thead.append(hr);table.append(thead);const body=document.createElement("tbody");
   trades.slice(-30).forEach((t,i)=>{const tr=document.createElement("tr");[String(Math.max(0,trades.length-30)+i+1),t.entry.toFixed(2),t.exit.toFixed(2),(t.ret>=0?"+":"")+t.ret.toFixed(2),t.reason].forEach(x=>tr.append(el("td",x)));body.append(tr);});table.append(body);out.append(table);
   out.append(el("p","Limitations: no brokerage/taxes/slippage, gaps, liquidity, option premiums, intrabar path certainty, or parameter optimization. This simple long-only rule is a research baseline, not a trading recommendation.","risk-note"));status.textContent="Backtest completed on verified historical candles; interpret cautiously.";
  }catch(e){status.textContent=String(e.message||e)+" No simulated candles or results were used.";out.replaceChildren();}finally{run.disabled=false;}
 });panel.append(form,status,out);
}


async function renderSettings(){
 panel.replaceChildren(el("h2","FYERS Settings & Diagnostics"),el("p","Read-only connection diagnostics. Credentials are never displayed here; order placement stays disabled."));
 const btn=el("button","Refresh connection diagnostics");btn.type="button";
 const status=el("p","Checking backend status…"),host=el("div",undefined,"gap-result");
 btn.addEventListener("click",load);panel.append(btn,status,host);
 async function load(){btn.disabled=true;status.textContent="Checking backend…";host.replaceChildren();try{
  const r=await fetch(API_BASE+"/api/status",{cache:"no-store"}),s=await r.json();if(!r.ok)throw new Error("Status request failed (HTTP "+r.status+").");
  const counts=s.acceptedTickCounts||{},times=s.lastAcceptedTickAtBySymbol||{};
  const rows=[
   ["Backend",s.backend||"unknown"],["FYERS authentication",s.fyers||"not connected"],["Market socket",s.marketSocketConnected?"connected":"not connected"],
   ["Live data",s.liveData||"waiting"],["Order placement",s.orderPlacement||"disabled"],
   ["NIFTY accepted fresh ticks",String(counts["NSE:NIFTY50-INDEX"]||0)],["NIFTY last accepted tick",times["NSE:NIFTY50-INDEX"]||"none in current process"],
   ["BANKNIFTY accepted fresh ticks",String(counts["NSE:NIFTYBANK-INDEX"]||0)],["BANKNIFTY last accepted tick",times["NSE:NIFTYBANK-INDEX"]||"none in current process"],
   ["Authenticated at",s.authenticatedAt||"not authenticated"],["Last complete live snapshot",s.lastTickAt||"unavailable"]
  ];
  const table=document.createElement("table");table.className="option-chain-table";const body=document.createElement("tbody");
  rows.forEach(([k,v])=>{const tr=document.createElement("tr");tr.append(el("th",k),el("td",v));body.append(tr);});table.append(body);host.append(table);
  host.append(el("p","A connected socket is not proof of fresh data. Tick counters increase only after valid prices and fresh exchange timestamps pass backend checks.","risk-note"));
  status.textContent="Status retrieved "+new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})+".";
 }catch(e){status.textContent=String(e.message||e);}finally{btn.disabled=false;}}
 load();
}
function renderLogs(){
 panel.replaceChildren(el("h2","DhanPulse Operational Logs"),el("p","Recent sanitized diagnostics from this backend process. Logs reset on backend redeploy; this is not a permanent audit trail."));
 const btn=el("button","Refresh diagnostics");btn.type="button";
 const status=el("p","Connect FYERS to view authenticated diagnostics."),host=el("div",undefined,"option-chain-table-wrap");
 btn.addEventListener("click",load);panel.append(btn,status,host);
 async function load(){if(!sessionToken){status.textContent="Connect FYERS first to view diagnostics.";return;}btn.disabled=true;status.textContent="Loading diagnostics…";host.replaceChildren();try{
  const r=await fetch(API_BASE+"/api/diagnostics",{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}}),data=await r.json();
  if(r.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);throw new Error("FYERS session expired. Connect again.");}
  if(!r.ok||data.ok!==true||!Array.isArray(data.entries))throw new Error(data.error||"Diagnostics unavailable.");
  if(!data.entries.length){status.textContent="No diagnostics recorded in this backend process yet. Reconnect FYERS to create fresh stream events.";return;}
  const table=document.createElement("table");table.className="option-chain-table";const head=document.createElement("thead"),hr=document.createElement("tr");
  ["Time (IST)","Level","Event","Details"].forEach(x=>hr.append(el("th",x)));head.append(hr);table.append(head);const body=document.createElement("tbody");
  data.entries.forEach(item=>{const tr=document.createElement("tr");const detail=Object.entries(item).filter(([k])=>!["timestamp","level","event"].includes(k)).map(([k,v])=>k+": "+(typeof v==="object"?JSON.stringify(v):String(v))).join(" · ");[item.timestamp?new Date(item.timestamp).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}):"—",item.level||"info",item.event||"event",detail||"—"].forEach(v=>tr.append(el("td",v)));body.append(tr);});
  table.append(body);host.append(table);status.textContent=data.entries.length+" recent diagnostic event(s) · fetched "+new Date(data.fetchedAt).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})+".";
 }catch(e){status.textContent=String(e.message||e)+" No fabricated logs displayed.";}finally{btn.disabled=false;}}
 if(sessionToken)load();
}


function renderSignalGate(){
 panel.replaceChildren(el("h2","Sureshot CE/PE · No-Trade Gate"),el("p","This module deliberately does not call a setup “Sureshot.” It checks readiness and blocks trade candidates until every required live-data and risk condition is verifiable."));
 const form=el("form",undefined,"gap-form"),label=el("label","Underlying"),symbol=document.createElement("select");
 [["NSE:NIFTY50-INDEX","NIFTY"],["NSE:NIFTYBANK-INDEX","BANKNIFTY"],...supportedStockSymbols].forEach(([v,n])=>{const o=el("option",n);o.value=v;symbol.append(o);});label.append(symbol);form.append(label);
 const run=el("button","Validate setup prerequisites");run.type="submit";form.append(run);
 const status=el("p","Connect FYERS before validating prerequisites."),out=el("div",undefined,"gap-result");
 const gates=[
  ["Fresh underlying quote","A verified, exchange-timestamped quote must be available."],
  ["Verified candles","At least 22 valid FYERS candles for context."],
  ["Verified option chain","Selected expiry, CE/PE premium, volume and OI must be present and fresh."],
  ["Supply/demand context","Historical zones are study aids only; levels require independent validation."],
  ["Risk/reward","Planned reward must be at least twice planned risk after entry/stop/target are defined."],
  ["No-trade filters","Reject stale data, missing quotes, cooldown, poor liquidity and unclear stop placement."]
 ];
 function renderGates(results){out.replaceChildren();gates.forEach(([name,desc],i)=>{const row=el("article",undefined,"quote-card");row.append(el("strong",(results?.[i]?"✓ ":"⛔ ")+name),el("p",desc),el("small",results?.[i]?"Prerequisite check passed.":"Not verified — candidate blocked."));out.append(row);});out.append(el("p","No entry, target, stop-loss, option strike recommendation or trade signal is emitted by this gate. A checklist pass alone is not a trade recommendation.","risk-note"));}
 form.addEventListener("submit",async ev=>{ev.preventDefault();run.disabled=true;status.textContent="Checking fresh quote and candle availability…";renderGates(null);
  if(!sessionToken){status.textContent="Connect FYERS first; setup remains blocked.";run.disabled=false;return;}
  let quoteOK=false,candleOK=false;
  try{
   const quoteEndpoint=symbol.value.startsWith("NSE:NIFTY")||symbol.value==="NSE:NIFTYBANK-INDEX"?"/api/market/quotes":"/api/market/stock-quotes";
   const q=await fetch(API_BASE+quoteEndpoint,{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}}),qd=await q.json();
   if(q.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);throw new Error("FYERS session expired. Reconnect.");}
   const selectedQuote=(qd.data||[]).find(x=>x.n===symbol.value);
   const quoteTime=Number(selectedQuote?.v?.tt)*1000;
   quoteOK=q.ok&&qd.ok===true&&selectedQuote?.verified===true&&Number(selectedQuote?.v?.lp)>0&&quoteTime>0&&Math.abs(Date.now()-quoteTime)<=120000;
   const now=new Date(),from=new Date(Date.now()-7*86400000),fmt=d=>{const z=new Date(d.getTime()-d.getTimezoneOffset()*60000);return z.toISOString().slice(0,10);};
   const params=new URLSearchParams({symbol:symbol.value,resolution:"5",from:fmt(from),to:fmt(now)});
   const cr=await fetch(API_BASE+"/api/market/candles?"+params,{cache:"no-store",headers:{Authorization:"Bearer "+sessionToken}}),cd=await cr.json();
   if(cr.status===401){sessionToken="";sessionStorage.removeItem(sessionKey);throw new Error("FYERS session expired. Reconnect.");}
   candleOK=cr.ok&&cd.ok===true&&Array.isArray(cd.data)&&cd.data.filter(x=>x.verified===true&&x.source==="FYERS"&&Number.isFinite(Date.parse(x.timestamp))&&[x.open,x.high,x.low,x.close].every(v=>Number.isFinite(Number(v))&&Number(v)>0)).length>=22;
   renderGates([quoteOK,candleOK,false,false,false,false]);
   status.textContent="Prerequisite check finished. "+(quoteOK&&candleOK?"Underlying quote and candle history are available; option/risk checks still block a signal.":"Required live quote or candles missing/stale; no-trade gate remains active.");
  }catch(e){status.textContent=String(e.message||e)+" No trade signal generated.";renderGates(null);}finally{run.disabled=false;}
 });
 panel.append(form,status,out);renderGates(null);
}
function renderUnconnectedDataModule(key,title,description){
 panel.replaceChildren(el("h2",title),el("p",description));
 const state=el("article",undefined,"quote-card");
 state.append(el("strong","Data integration not verified"),el("p","This tab will not display guessed numbers or claim a broker/source connection that is not configured and tested."));
 const next=key==="fii"?"FII/DII flow requires a reliable official/exchange data source and publication timestamp.":key==="activity"?"Market activity requires verified breadth/volume data across a sufficiently broad symbol universe.":"Broker holdings and positions require a verified broker portfolio endpoint and authenticated read-only permissions.";
 state.append(el("p",next));panel.append(state);
 const actions=el("div",undefined,"gap-form");
 const links=key==="holdings"?[["Open Paper Journal","journal"],["Open Capital Protection","capital"]]:key==="fii"?[["Open verified charts","charts"],["Open Option Chain","options"]]:[["Open Stock Explorer","explorer"],["Open Gainers & Losers","movers"]];
 links.forEach(([label,target])=>{const b=el("button",label);b.type="button";b.addEventListener("click",()=>document.querySelector('[data-tab="'+target+'"]')?.click());actions.append(b);});
 panel.append(actions);
}

function renderPage(key){
 if(candleRefreshTimer){clearInterval(candleRefreshTimer);candleRefreshTimer=null;}
 const [title,description]=pages[key]||["Module","Status unavailable."];
 panel.replaceChildren();
 if(key==="gap"){renderGap();return;}
 if(key==="explorer"){renderStockExplorer();return;}
 if(key==="watchlist"){renderWatchlist();return;}
 if(key==="alerts"){renderAlerts();return;}
 if(key==="backtest"){renderBacktest();return;}
 if(key==="settings"){renderSettings();return;}
 if(key==="logs"){renderLogs();return;}
 if(key==="movers"){renderMovers();return;}
 if(["breakout","momentum","zerohero"].includes(key)){renderScanner(key);return;}
 if(key==="capital"){renderCapital();return;}
 if(key==="journal"){renderJournal();return;}
 if(key==="journalRules"){renderJournalRules();return;}
 if(key==="technical"){renderTechnicalIndicators();return;}
 if(key==="options"){renderOptionChain();return;}
 if(key==="signals"){renderSignalGate();return;}
 if(key==="fii"){renderUnconnectedDataModule(key,"FII/DII Flow",pages.fii[1]);return;}
 if(key==="activity"){renderUnconnectedDataModule(key,"Market Activity",pages.activity[1]);return;}
 if(key==="holdings"){renderUnconnectedDataModule(key,"Holdings & Positions",pages.holdings[1]);return;}
 if(key==="supplyDemand"){panel.append(el("h2","Supply & Demand Zones"),el("p","Historical pivot-based supply/demand overlays on verified candles; visual study only, not a signal."));renderCandleChart("charts");return;}
 panel.append(el("h2",title),el("p",description));
 if(key==="charts"){renderCandleChart(key);return;}
 if(["dashboard","nifty","banknifty"].includes(key))renderQuotePanel(key);
 if(key==="dashboard")renderCandleChart("charts");
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
  const session=s.marketSession;
  document.querySelector("#marketSessionStatus").textContent=session?(session.isRegularHours?"Scheduled NSE hours":"Outside scheduled NSE hours")+" · "+(session.localTime||"IST")+" IST · holiday calendar not checked":"Session status unavailable";
  const accepted=s.acceptedTickCounts||{};
  const tickTotal=Object.values(accepted).reduce((sum,value)=>sum+(Number(value)||0),0);
  const perIndex=["NSE:NIFTY50-INDEX","NSE:NIFTYBANK-INDEX"].map(symbol=>(symbol==="NSE:NIFTY50-INDEX"?"NIFTY":"BANKNIFTY")+" "+(Number(accepted[symbol])||0)).join(" · ");
  document.querySelector("#feedStatus").textContent=(s.liveData||"Waiting")+(tickTotal?" · accepted "+perIndex:"");
  document.querySelector("#connection").textContent=s.fyers==="connected"?(s.liveData==="streaming"?"FYERS authenticated · verified feed streaming":"FYERS authenticated · waiting for fresh verified ticks"):s.backend==="online"?"Backend online · FYERS not connected":"Backend status unavailable";
  const active=document.querySelector("#tabs button.active")?.dataset.tab;
  if(["dashboard","nifty","banknifty"].includes(active)&&document.querySelector("#liveQuotePanel"))void renderLiveQuotes(active);
 }catch{
  document.querySelector("#backendStatus").textContent="Unreachable";document.querySelector("#fyersStatus").textContent="Not verified";document.querySelector("#feedStatus").textContent="Unavailable";document.querySelector("#marketSessionStatus").textContent="Unavailable";document.querySelector("#connection").textContent="Backend unavailable";
 }
}
(async()=>{await handleAuthCallback();await refreshStatus();renderPage("dashboard");setInterval(refreshStatus,10000);})();