const API_BASE = window.DHANPULSE_API_BASE || "http://localhost:10000";
const panel = document.querySelector("#panel");
const pages = {
 dashboard:["Dashboard","Waiting for a verified market-data provider. No prices are being invented."],
 explorer:["Stock Explorer","Stock universe will appear only after verified quote batching is connected."],
 nifty:["NIFTY","Candlestick view will load only from validated FYERS OHLC candles."],
 banknifty:["BANKNIFTY","Candlestick view will load only from validated FYERS OHLC candles."],
 options:["Option Chain & OI","Option-chain data must be fresh and validated before it can support a signal."],
 scanners:["Scanners","Scanners remain blocked until underlying quotes, candles, and required option data are verified."],
 journal:["Paper Journal","Paper trades only. Record entry, stop, target, rule adherence, and outcome."]
};
document.querySelector("#tabs").addEventListener("click", e => {
 const b=e.target.closest("button[data-tab]"); if(!b)return;
 document.querySelectorAll("#tabs button").forEach(x=>x.classList.toggle("active",x===b));
 const [title,description]=pages[b.dataset.tab];
 panel.replaceChildren();
 const h=document.createElement("h2");h.textContent=title;
 const p=document.createElement("p");p.textContent=description;
 panel.append(h,p);
});
async function refreshStatus(){
 try{
  const r=await fetch(API_BASE+"/api/status",{cache:"no-store"});
  if(!r.ok)throw new Error("Backend status HTTP "+r.status);
  const s=await r.json();
  document.querySelector("#backendStatus").textContent=s.backend||"Unknown";
  document.querySelector("#fyersStatus").textContent=s.fyers||"Not verified";
  document.querySelector("#feedStatus").textContent=s.liveData||"Waiting";
  document.querySelector("#connection").textContent=s.liveData==="streaming"?"Live tick status: verify timestamp":"No verified live tick";
 }catch{
  document.querySelector("#backendStatus").textContent="Unreachable";
  document.querySelector("#fyersStatus").textContent="Not verified";
  document.querySelector("#feedStatus").textContent="Unavailable";
  document.querySelector("#connection").textContent="Backend unavailable";
 }
}
refreshStatus();setInterval(refreshStatus,10000);
