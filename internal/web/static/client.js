var LS={get:function(k){try{return localStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
function rel(iso){var s=(Date.now()-new Date(iso).getTime())/1000,d=new Date(iso);
 var hm=d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/London'});
 var day=function(x){return x.toLocaleDateString('en-GB',{timeZone:'Europe/London'})};
 if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+' min ago';if(s<21600)return Math.floor(s/3600)+'h ago';
 if(day(d)===day(new Date()))return hm;if(day(d)===day(new Date(Date.now()-864e5)))return 'Yesterday '+hm;
 return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'Europe/London'})+' '+hm}
function until(iso){var s=(new Date(iso).getTime()-Date.now())/1000;if(s<=0)return s>-9000?'Live now':'Finished';
 var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d>0?'in '+d+'d '+h+'h':h>0?'in '+h+'h '+m+'m':'in '+m+' min'}
function tick(){document.querySelectorAll('time.rel').forEach(function(t){t.textContent=rel(t.getAttribute('datetime'))});
 document.querySelectorAll('[data-kickoff]').forEach(function(t){t.textContent=until(t.getAttribute('data-kickoff'))})}
setInterval(tick,60000);
function shortsBadge(){var n=document.getElementById('shorts-n'),a=document.getElementById('shorts-link'),s={},any=false;if(!n)return;
 try{JSON.parse(LS.get('wire.shorts.seen')||'[]').forEach(function(i){s[i]=1;any=true})}catch(e){}
 if(!any)return;
 fetch('/api/shorts').then(function(r){return r.ok?r.json():[]}).then(function(l){var c=l.filter(function(v){return!s[v.id]}).length;
  if(c){n.textContent=c>99?'99+':String(c);n.hidden=false;a.setAttribute('aria-label','Shorts, '+c+' unseen')}}).catch(function(){})}
function initWire(lastRun,storyCount){
 (window.requestIdleCallback||function(f){setTimeout(f,1200)})(shortsBadge);
 var chips=[].slice.call(document.querySelectorAll('.chip')),stories=[].slice.call(document.querySelectorAll('.story'));
 function apply(g){chips.forEach(function(c){c.setAttribute('aria-pressed',String(c.dataset.filter===g))});var shown=0;
  stories.forEach(function(s){var on=g==='all'||s.dataset.group===g;s.hidden=!on;if(on)shown++});
  document.querySelectorAll('.day').forEach(function(d){d.hidden=!d.querySelector('.story:not([hidden])')});
  var ef=document.getElementById('empty-filter');if(ef)ef.hidden=shown>0||!stories.length;LS.set('wire:filter',g)}
 chips.forEach(function(c){c.addEventListener('click',function(){apply(c.dataset.filter)})});
 var saved=LS.get('wire:filter');if(saved&&chips.some(function(c){return c.dataset.filter===saved}))apply(saved);
 var seen=LS.get('wire:seen'),n=0;
 if(seen){stories.forEach(function(s){if(s.dataset.fetched>seen){var b=s.querySelector('.new-badge');if(b){b.hidden=false;n++}}})}
 var nl=document.getElementById('newline');if(n&&nl){nl.textContent=n+' new since '+new Date(seen).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/London'});nl.hidden=false}
 var mark=function(){if(document.visibilityState==='visible')LS.set('wire:seen',new Date().toISOString())};
 setTimeout(mark,4000);document.addEventListener('visibilitychange',function(){if(document.visibilityState==='hidden')mark()});
 var toast=document.getElementById('toast');document.getElementById('toast-btn').addEventListener('click',function(){location.reload()});
 setInterval(function(){fetch('/api/version',{cache:'no-store'}).then(function(r){return r.json()}).then(function(v){
  if(v.lastRun&&v.lastRun!==lastRun&&v.stories>storyCount)toast.hidden=false}).catch(function(){})},120000);
}
function initFiltered(){var q=document.getElementById('q'),qn=document.getElementById('qn'),rows=[].slice.call(document.querySelectorAll('.row')),
 bs=[].slice.call(document.querySelectorAll('.bucket')),active='';
 function apply(){var t=(q.value||'').trim().toLowerCase(),n=0;rows.forEach(function(r){var on=(!t||r.dataset.text.indexOf(t)>-1)&&(!active||r.dataset.bucket===active);r.hidden=!on;if(on)n++});
  document.querySelectorAll('.row-day').forEach(function(d){var x=d.nextElementSibling,any=false;while(x&&!x.classList.contains('row-day')){if(!x.hidden)any=true;x=x.nextElementSibling}d.hidden=!any});
  qn.textContent=(t||active)?n+' match'+(n===1?'':'es'):''}
 q.addEventListener('input',apply);
 bs.forEach(function(b){b.addEventListener('click',function(){active=active===b.dataset.bucket?'':b.dataset.bucket;bs.forEach(function(x){x.setAttribute('aria-pressed',String(x.dataset.bucket===active))});apply()})})}
