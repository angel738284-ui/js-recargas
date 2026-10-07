'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function createVerityAvatar({broadcast, controllerKey, isAuthorized, readJson}) {
  const assets = {
    'normal-v3': path.join(__dirname, 'verity-normal-v3.webp'),
    'talk-v2': path.join(__dirname, 'verity-talk-v2.webp'),
    'grin-v2': path.join(__dirname, 'verity-grin-v2.webp'),
    'crazy-v2': path.join(__dirname, 'verity-crazy-v2.webp')
  };
  const state = {visible:true, mood:'normal', autoMood:true, side:'left', size:165};
  const snapshot = () => ({...state});
  const write = (res,status,obj) => {
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    res.end(JSON.stringify(obj));
  };
  const html = (res,s) => {
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'});
    res.end(s);
  };
  function publish(){broadcast({type:'verity_avatar_state',...snapshot(),at:Date.now()});}

  function avatarPage(){return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mini Verity</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent!important}
#actor{position:fixed;bottom:0;left:0;width:165px;max-width:100vw;pointer-events:none;transform-origin:bottom center}
#actor.right{left:auto;right:0}
#verityImg{display:block;width:100%;height:auto;user-select:none;-webkit-user-drag:none}
#actor.talking{animation:talkBounce .42s cubic-bezier(.35,.05,.2,1) infinite}
@keyframes talkBounce{0%,100%{transform:translateY(0) scale(1)}48%{transform:translateY(-7px) scale(1.015)}72%{transform:translateY(-2px) scale(.995)}}
</style></head><body>
<div id="actor"><img id="verityImg" src="/verity-image/normal-v3.webp" alt="Mini Verity"></div>
<audio id="verityAudio" playsinline preload="auto"></audio>
<script>
const actor=document.getElementById('actor');
const img=document.getElementById('verityImg');
const audio=document.getElementById('verityAudio');
let state={visible:true,mood:'normal',autoMood:true,side:'left',size:165};
let reactionUntil=0,reactionMood='normal',lastSrc='';
let queue=[],current=null,jsBlocks=0,pausedByJs=false;
let speaking=false,demoUntil=0;

const srcs={
 normal:'/verity-image/normal-v3.webp',
 talk:'/verity-image/talk-v2.webp',
 grin:'/verity-image/grin-v2.webp',
 crazy:'/verity-image/crazy-v2.webp'
};
function safeMood(m){return ['normal','grin','crazy'].includes(m)?m:'normal';}
function update(s){
 if(!s)return;
 state={...state,...s};
 actor.style.display=state.visible?'block':'none';
 actor.style.width=Math.max(90,Math.min(320,Number(state.size)||165))+'px';
 actor.classList.toggle('right',state.side==='right');
 render();
}
function setImage(name){
 const next=srcs[name]||srcs.normal;
 if(next===lastSrc)return;
 lastSrc=next;img.src=next;
}
function detectMood(m){
 const text=String((m&&m.spoken_text)||(m&&m.text)||(m&&m.comment)||'').toLowerCase();
 if(/(loc[oa]|wtf|demencia|caos|😡|🤬|malvad|miedo|terror)/i.test(text))return 'crazy';
 if(/(jaj|jeje|jiji|xd|😂|🤣|💀|lol)/i.test(text))return 'grin';
 return 'normal';
}
function render(){
 const now=Date.now();
 const talking=(speaking&&jsBlocks===0)||now<demoUntil;
 actor.classList.toggle('talking',talking);
 if(talking){setImage('talk');return;}
 if(state.autoMood&&now<reactionUntil)setImage(reactionMood);
 else setImage(safeMood(state.mood));
}
function finishComment(showReaction=true){
 speaking=false;
 if(showReaction)reactionUntil=Date.now()+(reactionMood==='normal'?500:2300);
 const finished=current;
 current=null;
 render();
 if(finished||queue.length)setTimeout(playNext,20);
}
async function playNext(){
 if(current||jsBlocks>0||!queue.length)return;
 current=queue.shift();
 reactionMood=detectMood(current);
 audio.onended=null;
 audio.onerror=null;
 audio.src=current.url;
 audio.muted=false;
 speaking=true;
 render();
 try{
   await audio.play();
   audio.onended=()=>finishComment(true);
   audio.onerror=()=>finishComment(false);
 }catch{
   const failed=current;
   current=null;
   speaking=false;
   render();
   if(failed)queue.unshift(failed);
   setTimeout(playNext,800);
 }
}
function releaseJsBlock(){
 jsBlocks=Math.max(0,jsBlocks-1);
 if(jsBlocks>0)return;
 if(current&&pausedByJs){
   pausedByJs=false;
   speaking=true;
   render();
   audio.play().catch(()=>setTimeout(()=>audio.play().catch(()=>{}),500));
 }else{
   playNext();
 }
}
function pauseForJs(msg){
 jsBlocks+=1;
 if(current&&!audio.paused){
   pausedByJs=true;
   speaking=false;
   try{audio.pause();}catch{}
   render();
 }
 const probe=new Audio();
 probe.muted=true;
 probe.playsInline=true;
 probe.preload='auto';
 probe.src=msg.url;
 let released=false,timer=0;
 const done=()=>{
   if(released)return;
   released=true;
   if(timer)clearTimeout(timer);
   try{probe.pause();}catch{}
   releaseJsBlock();
 };
 probe.onended=done;
 probe.onerror=()=>{if(!timer)timer=setTimeout(done,1600);};
 probe.onloadedmetadata=()=>{
   if(Number.isFinite(probe.duration)&&probe.duration>0){
     timer=setTimeout(done,Math.min(65000,probe.duration*1000+500));
   }
 };
 probe.play().catch(()=>{if(!timer)timer=setTimeout(done,5000);});
}
function enqueueComment(msg){
 if(!msg||!msg.url)return;
 queue.push(msg);
 playNext();
}
setInterval(render,90);

const events=new EventSource('/events');
events.onmessage=e=>{
 try{
   const m=JSON.parse(e.data);
   if(m.type==='verity_avatar_state')update(m);
   else if(m.type==='verity_demo'){
     const now=Date.now();
     reactionMood=safeMood(m.mood||state.mood);
     demoUntil=now+4300;
     reactionUntil=demoUntil+1800;
     render();
   }else if(m.type==='audio'&&m.url){
     if(m.source==='tiktok-comment-reader')enqueueComment(m);
     else pauseForJs(m);
   }
 }catch{}
};

document.body.addEventListener('pointerdown',()=>{
 if(current&&audio.paused&&jsBlocks===0){
   speaking=true;render();audio.play().catch(()=>{});
 }
},{once:true});

setInterval(()=>fetch('/keepalive',{cache:'no-store'}).catch(()=>{}),120000);
fetch('/keepalive',{cache:'no-store'}).catch(()=>{});
fetch('/api/verity/state',{cache:'no-store'}).then(r=>r.json()).then(update).catch(()=>{});
</script></body></html>`;}

  function controlPage(key){return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mini Verity · Control</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:14px;background:#111;color:#fff;font-family:system-ui}
.card{max-width:620px;margin:0 auto 12px;background:#1b1b1b;border-radius:18px;padding:16px}
h2{margin:0 0 8px}p{color:#ccc;font-size:14px;line-height:1.45}
#prev{height:250px;border-radius:14px;overflow:hidden;background:repeating-conic-gradient(#2c2c2c 0 25%,#363636 0 50%) 50%/22px 22px}
iframe{border:0;width:100%;height:100%}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}
button{border:0;border-radius:12px;padding:13px 8px;font-weight:800;font-size:14px;background:#eee;color:#111}
button.on{background:#ffe65e;color:#221d00}input[type=range]{width:100%}
#status{font-size:14px;color:#bde9c2}
</style></head><body>
<div class="card">
<h2>🟡 Mini Verity</h2>
<p>Quieto queda apoyado en el piso. Cuando habla Verity cambia a la boca abierta y rebota. Después puede reaccionar con sonrisa grande o modo loco.</p>
<div id="prev"><iframe src="/verity" title="Mini Verity"></iframe></div>
<p id="status">Conectando…</p>
<div class="row"><button id="show">🙈 Ocultar</button><button id="demo">🗣️ Probar habla</button></div>
<div class="row"><button id="normal">🙂 Normal</button><button id="grin">😁 Sonrisa</button></div>
<div class="row"><button id="crazy">🤪 Loco</button><button id="auto">✨ Caras AUTO: ON</button></div>
<div class="row"><button id="left">⬅️ Izquierda</button><button id="right">➡️ Derecha</button></div>
<p>Tamaño: <b id="label">165px</b></p><input id="size" type="range" min="90" max="320" step="5" value="165">
<button id="copy" style="width:100%">📋 Copiar URL /verity para PRISM</button>
</div>
<script>
const KEY=${JSON.stringify(key)};
let state={visible:true,mood:'normal',autoMood:true,side:'left',size:165};
const status=document.getElementById('status'),size=document.getElementById('size'),auto=document.getElementById('auto');
function paint(j){
 state={...state,...j};
 document.getElementById('show').textContent=state.visible?'🙈 Ocultar':'👀 Mostrar';
 document.getElementById('label').textContent=state.size+'px';size.value=state.size;
 auto.textContent='✨ Caras AUTO: '+(state.autoMood?'ON':'OFF');auto.classList.toggle('on',Boolean(state.autoMood));
 status.textContent='Verity '+(state.visible?'visible':'oculta')+' · '+state.mood+' · '+state.side;
}
async function send(action,more={}){
 try{
  const r=await fetch('/api/verity/control',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+KEY},body:JSON.stringify({action,...more})});
  const j=await r.json();if(!r.ok)throw Error(j.error||'error');paint(j);
 }catch(e){status.textContent='Error: '+String(e.message||e);}
}
document.getElementById('show').onclick=()=>send('visible',{visible:!state.visible});
document.getElementById('demo').onclick=()=>send('demo',{mood:state.mood});
document.getElementById('normal').onclick=()=>send('mood',{mood:'normal'});
document.getElementById('grin').onclick=()=>send('mood',{mood:'grin'});
document.getElementById('crazy').onclick=()=>send('mood',{mood:'crazy'});
auto.onclick=()=>send('auto',{enabled:!state.autoMood});
document.getElementById('left').onclick=()=>send('side',{side:'left'});
document.getElementById('right').onclick=()=>send('side',{side:'right'});
size.oninput=()=>document.getElementById('label').textContent=size.value+'px';
size.onchange=()=>send('size',{size:Number(size.value)});
document.getElementById('copy').onclick=()=>navigator.clipboard.writeText(location.origin+'/verity');
fetch('/api/verity/state').then(r=>r.json()).then(paint).catch(()=>{});
new EventSource('/events').onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='verity_avatar_state')paint(m)}catch{}};
</script></body></html>`;}

  async function handle(req,res,u){
    if(req.method==='GET'&&u.pathname==='/verity'){html(res,avatarPage());return true;}
    if(req.method==='GET'&&u.pathname.startsWith('/verity-image/')){
      const key=path.basename(u.pathname).replace(/\.webp$/,'');
      const file=assets[key];
      if(!file||!fs.existsSync(file)){res.writeHead(404);res.end();return true;}
      const info=fs.statSync(file);
      res.writeHead(200,{'content-type':'image/webp','cache-control':'public, max-age=86400','content-length':info.size});
      fs.createReadStream(file).pipe(res);return true;
    }
    if(req.method==='GET'&&u.pathname==='/api/verity/state'){write(res,200,{ok:true,...snapshot()});return true;}
    if(req.method==='GET'&&u.pathname==='/verity-control'){
      const key=String(u.searchParams.get('key')||'');
      if(!controllerKey||key!==controllerKey){write(res,404,{ok:false,error:'not_found'});return true;}
      html(res,controlPage(key));return true;
    }
    if(req.method==='POST'&&u.pathname==='/api/verity/control'){
      if(!isAuthorized(req)){write(res,401,{ok:false,error:'unauthorized'});return true;}
      try{
        const body=await readJson(req),action=String(body.action||'');
        if(action==='visible')state.visible=Boolean(body.visible);
        else if(action==='size')state.size=Math.max(90,Math.min(320,Math.round(Number(body.size)||165)));
        else if(action==='side')state.side=body.side==='right'?'right':'left';
        else if(action==='mood')state.mood=['grin','crazy'].includes(body.mood)?body.mood:'normal';
        else if(action==='auto')state.autoMood=Boolean(body.enabled);
        else if(action==='demo')broadcast({type:'verity_demo',mood:['grin','crazy'].includes(body.mood)?body.mood:'normal',at:Date.now()});
        else{write(res,400,{ok:false,error:'unknown_action'});return true;}
        if(action!=='demo')publish();
        write(res,200,{ok:true,...snapshot()});
      }catch(e){write(res,400,{ok:false,error:String(e.message||e)});}
      return true;
    }
    return false;
  }
  return {handle};
};
