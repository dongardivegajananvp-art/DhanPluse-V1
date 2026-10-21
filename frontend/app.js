const API_BASE = window.DHANPULSE_API_BASE || "http://localhost:10000";
const panel = document.querySelector("#panel");
const pages = {
 dashboard:["Dashboard","Waiting for a verified market-data provider. No prices are being invented."],
 explorer:["Stock Explorer","Stock universe will appear only after verified quote batching is connected."],
 nifty:["NIFTY","Candlestick view will load only from validated FYERS OHLC candles."],
 banknifty:["BANKNIFTY","Candlestick view will load only from validated FYERS OHLC candles."],
 gap:["Gap-Up / Gap-Down","Analyze the opening gap using the previous close, current open, volume context, and event risk. This manual analyzer is not a live FYERS feed."],
 options:["Option Chain & OI","Option-chain data must be fresh and validated before it can support a signal."],
 scanners:["Scanners","Scanners remain blocked until underlying quotes, candles, and required option data are verified."],
 journal:["Paper Journal","Paper trades only. Record entry, stop, target, rule adherence, and outcome."]
};
function renderGap(){
 panel.replaceChildren();
 const h=document.createElement("h2"); h.textContent="Gap-Up / Gap-Down Analysis";
 const intro=document.createElement("p"); intro.textContent="Gap % = (today’s open − previous close) ÷ previous close × 100. Enter verified values manually for now; live FYERS integration is not connected on this branch.";
 panel.append(h,intro);
 const form=document.createElement("form");form.className="gap-form";
 const fields=[
  ["prevClose","Previous close (₹)","number","required"],
  ["todayOpen","Today’s open (₹)","number","required"],
  ["relativeVolume","Opening volume ÷ average (e.g. 1.5)","number","optional"]
 ];
 for(const [id,label,type,req] of fields){
  const wrap=document.createElement("label");wrap.textContent=label;
  const input=document.createElement("input");input.id=id;input.name=id;input.type=type;input.min="0";input.step="any";if(req==="required")input.required=true;
  if(id==="relativeVolume")input.placeholder="Leave blank if unknown";
  wrap.append(input);form.append(wrap);
 }
 const eventLabel=document.createElement("label");eventLabel.className="check-label";
 const event=document.createElement("input");event.type="checkbox";event.id="majorEvent";
 eventLabel.append(event,document.createTextNode(" Major event / company result / policy day"));
 form.append(eventLabel);
 const submit=document.createElement("button");submit.type="submit";submit.textContent="Analyze gap";form.append(submit);
 const result=document.createElement("div");result.className="gap-result";result.setAttribute("aria-live","polite");
 form.addEventListener("submit",ev=>{
  ev.preventDefault();
  const close=Number(form.elements.prevClose.value),open=Number(form.elements.todayOpen.value);
  const rv=form.elements.relativeVolume.value.trim()===""?null:Number(form.elements.relativeVolume.value);
  result.replaceChildren();
  if(!(close>0&&open>0)){result.textContent="Enter valid positive prices.";return;}
  const gap=(open-close)/close*100;
  const direction=gap>0?"Gap Up":gap<0?"Gap Down":"Flat Open";
  const size=Math.abs(gap)<0.3?"Tiny":Math.abs(gap)<0.8?"Small":Math.abs(gap)<1.2?"Moderate":"Large";
  const highVolume=rv!==null&&Number.isFinite(rv)&&rv>=1.5;
  const eventRisk=event.checked;
  const h3=document.createElement("h3");h3.textContent=direction+" · "+(gap>0?"+":"")+gap.toFixed(2)+"%";
  const p=document.createElement("p");p.textContent="Gap size: "+size+". "+(highVolume?"Entered relative volume suggests elevated volume (≥1.5× average).":rv===null?"Volume context unknown; no volume-based conclusion.":rv>0?"Entered relative volume: "+rv.toFixed(2)+"× average.":"Relative volume input is invalid.");
  const note=document.createElement("p");
  note.textContent=eventRisk?"Event risk flagged: avoid assuming gap-fill or continuation; wait for price action and spreads to settle.":Math.abs(gap)>=1.2&&highVolume?"Large gap + elevated entered volume: continuation is possible, but not confirmed. Wait for opening-range structure and risk/reward.":Math.abs(gap)<0.8&&!highVolume?"Small gap / no confirmed volume expansion: gap fill is possible, not guaranteed. Wait for price action rather than fading automatically.":"Mixed conditions: direction is not enough to create a trade. Confirm trend, volume, levels, and stop distance.";
  const guard=document.createElement("p");guard.className="risk-note";guard.textContent="No prediction or trade signal generated. Gap-fill percentages and claims about FII/DII/operator intent require verified historical testing; price gaps alone cannot identify who caused them.";
  result.append(h3,p,note,guard);
 });
 panel.append(form,result);
}
function renderPage(key){
 const [title,description]=pages[key];
 panel.replaceChildren();
 if(key==="gap"){renderGap();return;}
 const h=document.createElement("h2");h.textContent=title;
 const p=document.createElement("p");p.textContent=description;
 panel.append(h,p);
}
document.querySelector("#tabs").addEventListener("click", e => {
 const b=e.target.closest("button[data-tab]"); if(!b)return;
 document.querySelectorAll("#tabs button").forEach(x=>x.classList.toggle("active",x===b));
 renderPage(b.dataset.tab);
});
async function refreshStatus(){
 try{
  const r=await fetch(API_BASE+"/api/status",{cache:"no-store"});
  if(!r.ok)throw new Error("Backend status HTTP "+r.status);
  const s=await r.json();
  document.querySelector("#backendStatus").textContent=s.backend||"Unknown";
  document.querySelector("#fyersStatus").textContent=s.fyers||"Not verified";
  document.querySelector("#feedStatus").textContent=s.liveData||"Waiting";
  document.querySelector("#connection").textContent=s.liveData==="streaming"?"Feed status reported streaming; tick freshness still must be checked":"No verified live tick";
 }catch{
  document.querySelector("#backendStatus").textContent="Unreachable";
  document.querySelector("#fyersStatus").textContent="Not verified";
  document.querySelector("#feedStatus").textContent="Unavailable";
  document.querySelector("#connection").textContent="Backend unavailable";
 }
}
refreshStatus();setInterval(refreshStatus,10000);
