const nav = document.querySelector('#nav');
const title = document.querySelector('#pageTitle');
const panelTitle = document.querySelector('#panelTitle');
const featureTitle = document.querySelector('#featureTitle');
const featureDesc = document.querySelector('#featureDesc');
const featureContent = document.querySelector('#featureContent');
const descriptions = {
 'Dashboard':['Market overview','Your workspace at a glance. Only verified API responses should populate market values.'],
 'NIFTY':['NIFTY 50 workspace','Live index quote and chart will appear after FYERS connection is validated.'],
 'BANKNIFTY':['BANKNIFTY workspace','Live index quote and chart will appear after FYERS connection is validated.'],
 'Watchlist':['Watchlist','Watchlist persistence and real quote updates need a connected backend.'],
 'Option Chain':['Option chain & OI','Option contracts and open interest must be retrieved from supported, verified market data.'],
 'AI Signals':['Technical analysis & signals','Signals should be calculated from timestamped candles; this starter does not fabricate signal values.'],
 'Holdings':['Holdings & positions','Account holdings and positions require authenticated account endpoints.'],
 'FYERS Settings':['FYERS connection settings','Set the backend URL and test backend health. A health check does not prove FYERS authentication.'],
 'Logs':['System logs','No events recorded yet. Connection and API events should be added here as the backend is wired.']
};
function render(tab){title.textContent=tab;panelTitle.textContent=descriptions[tab][0];featureTitle.textContent=tab==='Dashboard'?'Your tools':tab;featureDesc.textContent=descriptions[tab][1];nav.querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));featureContent.replaceChildren();const items=tab==='Dashboard'?['Technical indicators','Watchlist','Option chain & OI','Holdings & positions','Price alerts']:tab==='FYERS Settings'?['Backend URL','Test backend','FYERS login flow']:tab==='Option Chain'?['Calls','Puts','Open interest','Strike prices']:tab==='Holdings'?['Positions unavailable until authenticated']:tab==='Watchlist'?['No symbols loaded']:tab==='Logs'?['No logs yet']:['Live data not connected','No verified prices'];items.forEach(item=>{const span=document.createElement('span');span.className='chip';span.textContent=item;featureContent.append(span)});if(tab==='FYERS Settings'){const input=document.createElement('input');input.type='url';input.placeholder='https://your-backend.example.com';input.id='backendUrl';input.className='urlinput';const save=document.createElement('button');save.className='primary';save.textContent='Save & test backend';save.onclick=testBackend;featureContent.append(input,save);const stored=sessionStorage.getItem('dp_backend_url');if(stored)input.value=stored;}}
async function testBackend(){const input=document.querySelector('#backendUrl');const url=input?.value.trim().replace(/\/$/,'');if(!url){alert('Enter your backend HTTPS URL first.');return}sessionStorage.setItem('dp_backend_url',url);const status=document.querySelector('#backendStatus');status.textContent='CHECKING…';try{const res=await fetch(url+'/health',{headers:{Accept:'application/json'}});if(!res.ok)throw new Error('HTTP '+res.status);const data=await res.json();status.textContent=data.ok?'ONLINE':'CHECK RESPONSE';document.querySelector('#connectionValue').textContent=data.ok?'Backend online':'Unverified';alert('Backend health response received. This does not mean FYERS is authenticated or live data is connected.');}catch(e){status.textContent='UNREACHABLE';alert('Backend test failed: '+e.message)}}
nav.addEventListener('click',e=>{const btn=e.target.closest('button[data-tab]');if(btn)render(btn.dataset.tab)});
document.querySelector('#settingsBtn').addEventListener('click',()=>render('FYERS Settings'));
render('Dashboard');
