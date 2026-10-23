(function(){
var K_SEEN='wire.shorts.seen',K_SOUND='wire.shorts.sound',K_TIP='wire.shorts.tip',tipOn=false,YT='https://www.youtube.com';
function lsGet(k){try{return localStorage.getItem(k)}catch(_){return null}}
function lsSet(k,v){try{localStorage.setItem(k,v)}catch(_){}}
var seen={};try{(JSON.parse(lsGet(K_SEEN)||'[]')||[]).forEach(function(id){seen[id]=1})}catch(_){}
function saveSeen(){lsSet(K_SEEN,JSON.stringify(Object.keys(seen).slice(-3000)))}
function $(id){return document.getElementById(id)}
var player=$('sh-player'),slot=$('sh-slot'),nEl=$('sh-n'),fill=$('sh-fill'),meter=$('sh-meter'),allBtn=$('sh-all'),undoBtn=$('sh-undo'),skipBtn=$('sh-skip'),seenBtn=$('sh-seen'),live=$('sh-live'),toast=$('sh-toast'),toastT=$('sh-toast-t');
var CHANNELS=player.getAttribute('data-channels')||'the channels';
var reduced=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
var ICON={up:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.2M3.6 7.4 8 3l4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',down:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9.8M3.6 8.6 8 13l4.4-4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',on:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 6.1v3.8h2.5L8 12.7V3.3L4.7 6.1Z" fill="currentColor"/><path d="M10.6 5.6a3.3 3.3 0 0 1 0 4.8M12.6 3.7a6 6 0 0 1 0 8.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',off:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 6.1v3.8h2.5L8 12.7V3.3L4.7 6.1Z" fill="currentColor"/><path d="m10.6 6.1 3.8 3.8m0-3.8-3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',play:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>',ext:'<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 6.5 9.5M11 9v4H3V5h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'};
var all=[],queue=[],done=0,hist=[],busy=false,sound=lsGet(K_SOUND)==='1',muted=true,playing=false,userPaused=false,frame=null,card=null,cur=null,loadedAt=0,toastTimer=0;

function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function btn(t,cls,f){var b=el('button',cls,t);b.type='button';b.addEventListener('click',f);return b}
function thumb(id){return 'https://i.ytimg.com/vi/'+encodeURIComponent(id)+'/hqdefault.jpg'}
function ago(iso){var s=(Date.now()-new Date(iso).getTime())/1000;if(s<3600)return Math.max(1,Math.floor(s/60))+' min ago';if(s<86400)return Math.floor(s/3600)+'h ago';var d=Math.floor(s/86400);return d===1?'Yesterday':d+' days ago'}
function plural(n,w){return n+' '+w+(n===1?'':'s')}
function announce(t){live.textContent='';setTimeout(function(){live.textContent=t},40)}
function buzz(){try{if(navigator.vibrate)navigator.vibrate(8)}catch(_){}}
function post(f,msg){try{if(f&&f.contentWindow)f.contentWindow.postMessage(JSON.stringify(msg),YT)}catch(_){}}
function cmd(fn,args){post(frame,{event:'command',func:fn,args:args||[]})}

function update(){var n=queue.length,t=done+n;
 nEl.textContent=n?n+' to watch':'';
 fill.style.width=(t?done/t*100:0)+'%';meter.setAttribute('aria-valuemax',String(t));meter.setAttribute('aria-valuenow',String(done));meter.setAttribute('aria-valuetext',done+' of '+t+' seen');
 allBtn.disabled=!n;seenBtn.disabled=!n;skipBtn.disabled=n<2;undoBtn.disabled=!hist.length;player.classList.toggle('is-empty',!n)}

function setMuted(m){muted=m;if(!card)return;var b=card.querySelector('.sh-mute');if(!b)return;b.innerHTML=m?ICON.off:ICON.on;b.setAttribute('aria-pressed',String(!m));b.setAttribute('aria-label',m?'Turn sound on':'Turn sound off')}
function setPlaying(p){playing=p;if(p)userPaused=false;if(card)card.classList.toggle('is-paused',!p&&userPaused)}
function setProg(x){if(!card)return;var s=card.querySelector('.sh-prog span');if(s)s.style.width=Math.max(0,Math.min(1,x))*100+'%'}
function flash(t){if(!card)return;var f=card.querySelector('.sh-flash');if(!f)return;f.textContent=t;f.classList.remove('show');void f.offsetWidth;f.classList.add('show')}
function toggleSound(){if(!cur)return;dismissTip();
 if(muted){cmd('unMute');cmd('playVideo');sound=true;lsSet(K_SOUND,'1');setMuted(false);flash('Sound on')}
 else{cmd('mute');sound=false;lsSet(K_SOUND,'0');setMuted(true);flash('Sound off')}}
function togglePlay(){if(!cur)return;if(playing){userPaused=true;cmd('pauseVideo');setPlaying(false)}else{cmd('playVideo');setPlaying(true)}}

function render(how){
 update();busy=false;frame=null;card=null;playing=false;userPaused=false;muted=true;
 if(!queue.length){cur=null;state('done');return}
 var v=queue[0];cur=v;slot.innerHTML='';
 card=el('div','sh-card'+(reduced?'':how==='up'?' sh-in-up':how==='down'||how==='undo'?' sh-in-down':''));
 var poster=el('img','sh-poster');poster.alt='';poster.decoding='async';poster.src=thumb(v.id);card.appendChild(poster);
 var f=document.createElement('iframe');frame=f;f.title=v.title;f.tabIndex=-1;f.allow='autoplay; encrypted-media; picture-in-picture';f.referrerPolicy='strict-origin-when-cross-origin';
 f.src=YT+'/embed/'+encodeURIComponent(v.id)+'?autoplay=1&mute=1&playsinline=1&loop=1&playlist='+encodeURIComponent(v.id)+'&rel=0&modestbranding=1&controls=0&disablekb=1&iv_load_policy=3&enablejsapi=1&origin='+encodeURIComponent(location.origin);
 f.addEventListener('load',function(){if(f!==frame)return;post(f,{event:'listening',id:1,channel:'widget'});cmd('addEventListener',['onStateChange'])});
 card.appendChild(f);
 var pad=el('div','sh-pad');pad.setAttribute('aria-hidden','true');card.appendChild(pad);
 var cu=el('div','sh-cue sh-cue-up');cu.innerHTML=ICON.up+'Seen';cu.setAttribute('aria-hidden','true');card.appendChild(cu);
 var cd=el('div','sh-cue sh-cue-down');cd.innerHTML=ICON.down+'Skip';cd.setAttribute('aria-hidden','true');card.appendChild(cd);
 var fl=el('div','sh-flash');fl.setAttribute('aria-hidden','true');card.appendChild(fl);
 var pz=el('div','sh-pz');pz.innerHTML=ICON.play;pz.setAttribute('aria-hidden','true');card.appendChild(pz);
 card.appendChild(btn('','sh-mute',toggleSound));
 var cap=el('div','sh-cap');cap.appendChild(el('p','sh-t',v.title));
 var m=el('p','sh-m');m.appendChild(el('span',null,v.channel+', '+ago(v.published)));
 var a=el('a','sh-yt');a.href=YT+'/shorts/'+encodeURIComponent(v.id);a.target='_blank';a.rel='noopener';a.innerHTML='YouTube'+ICON.ext;a.setAttribute('aria-label','Open on YouTube');m.appendChild(a);
 cap.appendChild(m);card.appendChild(cap);
 var pr=el('div','sh-prog');pr.setAttribute('aria-hidden','true');pr.appendChild(el('span'));card.appendChild(pr);
 slot.appendChild(card);setMuted(true);gestures(pad);
 if(queue[1]){var im=new Image();im.src=thumb(queue[1].id)}
 announce(v.title+', from '+v.channel);
}

function cues(d){if(!card)return;card.querySelector('.sh-cue-up').style.opacity=d<0?Math.min(1,-d/90):0;card.querySelector('.sh-cue-down').style.opacity=d>0&&queue.length>1?Math.min(1,d/90):0}
function gestures(pad){var st=null;
 pad.addEventListener('pointerdown',function(e){if(busy||e.button>0)return;st={y:e.clientY,t:Date.now()};card.style.transition='none';try{pad.setPointerCapture(e.pointerId)}catch(_){}});
 pad.addEventListener('pointermove',function(e){if(!st)return;var d=e.clientY-st.y;if(d>0&&queue.length<2)d=d*0.3;card.style.transform='translateY('+d+'px)';cues(d)});
 function end(e,cancel){if(!st)return;var d=e.clientY-st.y,dt=Math.max(1,Date.now()-st.t),vel=d/dt;st=null;card.style.transition='';cues(0);
  if(!cancel){
   if(Math.abs(d)<10&&dt<300){card.style.transform='';toggleSound();return}
   if(d<-90||(d<-30&&vel<-0.45)){act('seen');return}
   if(queue.length>1&&(d>90||(d>30&&vel>0.45))){act('skip');return}}
  card.style.transform=''}
 pad.addEventListener('pointerup',function(e){end(e,false)});pad.addEventListener('pointercancel',function(e){end(e,true)})}

function push(h){hist.push(h);if(hist.length>50)hist.shift()}
function act(k){if(busy||!cur)return;if(k==='skip'&&queue.length<2)return;busy=true;dismissTip();buzz();
 var v=queue[0],c=card;
 if(c&&!reduced){c.style.transition='';c.style.transform='translateY('+(k==='seen'?'-115%':'115%')+')';c.style.opacity='0'}
 setTimeout(function(){queue.shift();if(k==='seen'){seen[v.id]=1;saveSeen();done++}else queue.push(v);push({k:k,v:v});render(k==='seen'?'up':'down')},reduced?0:180)}
function undo(){if(busy||!hist.length)return;var h=hist.pop();hideToast();
 if(h.k==='seen'){delete seen[h.v.id];saveSeen();done=Math.max(0,done-1);queue.unshift(h.v)}
 else if(h.k==='skip'){var i=queue.lastIndexOf(h.v);if(i>0){queue.splice(i,1);queue.unshift(h.v)}}
 else if(h.k==='all'){h.vs.forEach(function(v){delete seen[v.id]});saveSeen();done=Math.max(0,done-h.vs.length);queue=h.vs.concat(queue.filter(function(v){return h.vs.indexOf(v)<0}))}
 else if(h.k==='reset'){h.ids.forEach(function(id){seen[id]=1});saveSeen();queue=queue.filter(function(v){return!seen[v.id]});done=h.done}
 render('undo');announce('Undone')}
function markAll(){if(busy||!queue.length)return;var vs=queue.slice();vs.forEach(function(v){seen[v.id]=1});saveSeen();done+=vs.length;queue=[];push({k:'all',vs:vs});buzz();render();toastMsg(plural(vs.length,'Short')+' marked as seen')}
function reset(){var ids=all.filter(function(v){return seen[v.id]}).map(function(v){return v.id});if(!ids.length)return;
 ids.forEach(function(id){delete seen[id]});saveSeen();push({k:'reset',ids:ids,done:done});done=0;
 var have={};queue.forEach(function(v){have[v.id]=1});queue=queue.concat(all.filter(function(v){return!have[v.id]&&!seen[v.id]}));
 render('up');toastMsg(plural(ids.length,'Short')+' back in the queue')}

function state(kind){slot.innerHTML='';update();var b=el('div','sh-state'),r=el('div','sh-row');
 if(kind==='done'){b.appendChild(el('h2',null,"You're up to date"));b.appendChild(el('p',null,'New Shorts from '+CHANNELS+' appear here as they post.'));
  r.appendChild(btn('Check for new','btn primary',function(e){refresh(true,e.currentTarget)}));
  if(all.some(function(v){return seen[v.id]}))r.appendChild(btn('Show seen Shorts','btn',reset))}
 else{b.appendChild(el('h2',null,"Couldn't load Shorts"));b.appendChild(el('p',null,"YouTube didn't respond. Check your connection, then try again."));r.appendChild(btn('Try again','btn primary',start))}
 b.appendChild(r);slot.appendChild(b)}
function fetchList(){return fetch('/api/shorts',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(l){if(!Array.isArray(l)||!l.length)throw new Error('empty');all=l;loadedAt=Date.now();return l})}
function start(){slot.innerHTML='';var s=el('div','sh-card sh-skel');s.setAttribute('aria-label','Loading Shorts');slot.appendChild(s);nEl.textContent='';
 fetchList().then(function(l){queue=l.filter(function(v){return!seen[v.id]});done=0;render();showTip()}).catch(function(){state('error')})}
function refresh(manual,b){if(b)b.disabled=true;
 fetchList().then(function(l){var have={};queue.forEach(function(v){have[v.id]=1});var fresh=l.filter(function(v){return!seen[v.id]&&!have[v.id]});
  if(fresh.length){if(queue.length){queue.splice.apply(queue,[1,0].concat(fresh));update()}else{queue=fresh;render('up')}toastMsg(plural(fresh.length,'new Short')+' added')}
  else{if(manual)toastMsg('No new Shorts yet');if(b)b.disabled=false}
 }).catch(function(){if(manual)toastMsg("Couldn't reach YouTube. Try again shortly.");if(b)b.disabled=false})}

function toastMsg(t,ms){tipOn=false;toastT.textContent=t;toast.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(hideToast,ms||4000)}
function hideToast(){toast.hidden=true;clearTimeout(toastTimer)}
function showTip(){if(!lsGet(K_TIP)&&window.matchMedia&&matchMedia('(pointer: coarse)').matches&&cur){toastMsg('Swipe up when seen, down to skip. Tap the video for sound.',9000);tipOn=true}}
function dismissTip(){if(tipOn){tipOn=false;lsSet(K_TIP,'1');hideToast()}}

window.addEventListener('message',function(e){if(!frame||e.source!==frame.contentWindow||e.origin!==YT)return;var d=e.data;
 if(typeof d==='string'){try{d=JSON.parse(d)}catch(_){return}}if(!d||typeof d!=='object')return;
 if(d.event==='onReady'){if(sound)cmd('unMute');cmd('playVideo')}
 if(d.event==='onStateChange'&&typeof d.info==='number')setPlaying(d.info===1);
 var i=(d.event==='infoDelivery'||d.event==='initialDelivery')?d.info:null;
 if(i&&typeof i==='object'){if(typeof i.muted==='boolean')setMuted(i.muted);if(typeof i.playerState==='number')setPlaying(i.playerState===1);if(typeof i.currentTime==='number'&&i.duration>0)setProg(i.currentTime/i.duration)}});
document.addEventListener('keydown',function(e){if(e.altKey||e.metaKey)return;var tag=(e.target&&e.target.tagName)||'';if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;var k=e.key;
 if(e.ctrlKey){if(k==='z'){e.preventDefault();undo()}return}
 if(k==='ArrowUp'||k==='k'){e.preventDefault();act('seen')}
 else if(k==='ArrowDown'||k==='j'){e.preventDefault();act('skip')}
 else if(k==='m'||k==='M'){toggleSound()}
 else if(k==='u'||k==='U'){undo()}
 else if(k===' '&&tag!=='BUTTON'&&tag!=='A'){e.preventDefault();togglePlay()}});
document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&loadedAt&&Date.now()-loadedAt>300000)refresh(false)});
seenBtn.addEventListener('click',function(){act('seen')});skipBtn.addEventListener('click',function(){act('skip')});undoBtn.addEventListener('click',undo);allBtn.addEventListener('click',markAll);
start();
})();
