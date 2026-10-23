function initSquad(){
 var el=document.getElementById('sq-data');if(!el)return;var D=JSON.parse(el.textContent);
 var tip=document.createElement('div');tip.className='tip';tip.hidden=true;document.body.appendChild(tip);
 function f(v,s){if(v==null)return '';if(s.u==='pct')return Math.round(v)+'%';var t=Math.abs(v)>=10?v.toFixed(1):v.toFixed(2);return (s.k==='finishing'||s.k==='prevented')&&v>0?'+'+t:t}
 function ord(n){var t=n%100,u=n%10;return n+(t>=11&&t<=13?'th':u===1?'st':u===2?'nd':u===3?'rd':'th')}
 var NS='http://www.w3.org/2000/svg';
 function mk(tag,a){var e=document.createElementNS(NS,tag);for(var k in a)e.setAttribute(k,a[k]);return e}
 function draw(box,pos,pid){
  var stats=D.stats[pos],pool=D.pools[pos]||[],me=D.mine[pid];if(!me)return;box.innerHTML='';
  stats.forEach(function(s,i){
   var vals=pool.map(function(p){return p.v[i]}).filter(function(v){return v!=null}).sort(function(a,b){return a-b});
   var mv=me.v[i];if(!vals.length&&mv==null)return;
   var lo=vals.length?vals[Math.floor(vals.length*0.02)]:mv,hi=vals.length?vals[Math.ceil(vals.length*0.98)-1]:mv;
   if(mv!=null){lo=Math.min(lo,mv);hi=Math.max(hi,mv)}if(hi===lo){hi=lo+1}
   var W=Math.max(200,box.clientWidth||320),H=34,pad=8,flip=s.b==='low';
   function x(v){var c=Math.max(lo,Math.min(hi,v)),t=(c-lo)/(hi-lo);return pad+(flip?1-t:t)*(W-2*pad)}
   var wrap=document.createElement('div');wrap.className='strip';
   var h=document.createElement('div');h.className='strip-h';
   var rank=me.r&&mv!=null?vals.filter(function(v){return flip?v<mv-1e-9:v>mv+1e-9}).length+1:null;
   var ties=rank!=null?vals.filter(function(v){return Math.abs(v-mv)<=1e-9}).length:0;
   h.innerHTML='<span>'+s.l+(s.u==='p90'?' per 90':'')+'</span><span><b>'+f(mv,s)+'</b>'+(rank!=null?' · '+(ties>1?'joint ':'')+ord(rank)+' of '+vals.length:' · not ranked')+'</span>';
   var svg=mk('svg',{viewBox:'0 0 '+W+' '+(H+12),width:W,height:H+12,role:'img','aria-label':s.l+': '+me.n+' '+f(mv,s)+(me.p[i]!=null?', '+ord(me.p[i])+' percentile':'')});
   var med=vals.length?vals[Math.floor(vals.length/2)]:null;
   if(med!=null)svg.appendChild(mk('line',{'class':'med',x1:x(med),x2:x(med),y1:4,y2:H-4}));
   [[lo,flip?'end':'start'],[hi,flip?'start':'end']].forEach(function(e){var t=mk('text',{x:x(e[0]),y:H+10,'class':'ax','text-anchor':e[1]});t.textContent=f(e[0],s);svg.appendChild(t)});
   var pts=[];
   pool.forEach(function(p,j){var v=p.v[i];if(v==null)return;var mate=p.t===D.club;var y=6+((j*7919)%97)/97*(H-12);
    var c=mk('circle',{cx:x(v),cy:y,r:mate?3.2:2.6,'class':mate?'dot mate':'dot'});svg.appendChild(c);pts.push({x:x(v),y:y,n:p.n,t:p.t,v:v})});
   if(mv!=null)svg.appendChild(mk('circle',{cx:x(mv),cy:H/2,r:6,'class':'me'}));
   function show(e){var r=svg.getBoundingClientRect(),sx=W/r.width,sy=(H+12)/r.height,px=(e.clientX-r.left)*sx,py=(e.clientY-r.top)*sy,best=null,bd=1e9;
    pts.forEach(function(p){var d=Math.pow((p.x-px)/sx,2)+Math.pow((p.y-py)/sy,2);if(d<bd){bd=d;best=p}});
    if(!best||bd>18*18){tip.hidden=true;return}
    tip.textContent=best.n+' ('+best.t+') '+f(best.v,s);tip.hidden=false;
    var tx=Math.min(window.innerWidth-tip.offsetWidth-8,Math.max(8,e.clientX-tip.offsetWidth/2));tip.style.left=tx+'px';tip.style.top=(e.clientY-40)+'px'}
   svg.addEventListener('pointermove',show);svg.addEventListener('pointerdown',show);svg.addEventListener('pointerleave',function(){tip.hidden=true});
   wrap.appendChild(h);wrap.appendChild(svg);box.appendChild(wrap)});
 }
 document.querySelectorAll('details.pr').forEach(function(d){d.addEventListener('toggle',function(){if(d.open){var b=d.querySelector('.pr-x');if(!b.firstChild)draw(b,d.dataset.pos,d.dataset.pid)}})});
 document.addEventListener('scroll',function(){tip.hidden=true},{passive:true});
}
