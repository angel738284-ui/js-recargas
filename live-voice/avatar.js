'use strict';
const fs = require('fs');
const path = require('path');

module.exports = function createAvatar({broadcast, controllerKey, isAuthorized, readJson}) {
  const asset = path.join(__dirname, 'avatar.webp');
  const state = {visible:true, mood:'normal', side:'right', size:220};
  const snapshot = () => ({...state});
  const write = (res,status,obj) => {
    res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
    res.end(JSON.stringify(obj));
  };
  const html = (res,s) => {
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer'});
    res.end(s);
  };
  function publish(){ broadcast({type:'avatar_state',...snapshot(),at:Date.now()}); }

  function avatarPage(){return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avatar JS 2D</title><style>
html,body{background:transparent!important;margin:0;width:100%;height:100%;overflow:hidden}
#actor{position:fixed;bottom:0;right:0;width:220px;max-width:100vw;pointer-events:none;transform-origin:bottom center;animation:breathe 3.7s ease-in-out infinite}
#face{display:block;width:100%;height:auto}
#giftFx{position:fixed;bottom:116px;right:188px;z-index:20;display:flex;align-items:center;gap:7px;opacity:0;pointer-events:none;filter:drop-shadow(0 3px 6px rgba(0,0,0,.45))}
#giftFx.left{right:auto;left:188px}
#giftIcon{width:62px;height:62px;object-fit:contain;display:none}
#giftEmoji{font-size:58px;line-height:1;display:block}
#giftNote{position:fixed;bottom:245px;right:10px;z-index:21;max-width:260px;padding:9px 12px;border-radius:13px;background:rgba(0,0,0,.72);color:#fff;font:700 14px/1.25 system-ui,-apple-system,sans-serif;text-shadow:0 1px 2px #000;opacity:0;pointer-events:none;text-align:center}
#giftNote.left{right:auto;left:10px}
#giftFx.show{animation:giftFlyRight 2.6s cubic-bezier(.22,.8,.25,1) both}
#giftFx.show.left{animation-name:giftFlyLeft}
#giftNote.show{animation:giftNote 2.8s ease both}
#actor.gift-react{animation:giftReact .78s ease-in-out 2}
@keyframes breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.012)}}
@keyframes giftFlyRight{0%{transform:translate(170px,-90px) scale(.45) rotate(15deg);opacity:0}14%{opacity:1}62%{transform:translate(0,0) scale(1.12) rotate(-5deg);opacity:1}82%{transform:translate(18px,28px) scale(.88) rotate(0);opacity:1}100%{transform:translate(18px,28px) scale(.65);opacity:0}}
@keyframes giftFlyLeft{0%{transform:translate(-170px,-90px) scale(.45) rotate(-15deg);opacity:0}14%{opacity:1}62%{transform:translate(0,0) scale(1.12) rotate(5deg);opacity:1}82%{transform:translate(-18px,28px) scale(.88) rotate(0);opacity:1}100%{transform:translate(-18px,28px) scale(.65);opacity:0}}
@keyframes giftNote{0%,8%{opacity:0;transform:translateY(8px)}18%,76%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-7px)}}
@keyframes giftReact{0%,100%{transform:translateY(0) scale(1)}35%{transform:translateY(-8px) scale(1.025)}65%{transform:translateY(-2px) scale(.995)}}
</style></head><body>
<div id="actor"><canvas id="face" width="512" height="512"></canvas></div>
<div id="giftFx" aria-hidden="true"><img id="giftIcon" alt=""><span id="giftEmoji">🌹</span></div>
<div id="giftNote" aria-live="polite"></div>
<audio id="jsAudio" playsinline preload="auto"></audio>
<script>
const actor=document.getElementById('actor');
const audio=document.getElementById('jsAudio');
const giftFx=document.getElementById('giftFx');
const giftIcon=document.getElementById('giftIcon');
const giftEmoji=document.getElementById('giftEmoji');
const giftNote=document.getElementById('giftNote');
const canvas=document.getElementById('face');
const ctx=canvas.getContext('2d',{alpha:true});
const atlas=new Image();atlas.src='/avatar-image.webp?v=hd2';
let state={visible:true,mood:'normal',side:'right',size:220};
let talkingAt=0,lastFrame='',blinkAt=0,nextBlink=Date.now()+3500;
let speaking=false,demoUntil=0,audioQueue=[],currentAudio=null;
const giftQueue=[];let giftBusy=false;
const patches={
 talk1:{s:[0,512,110,63],d:[238,157,110,63]},
 talk2:{s:[114,512,110,63],d:[238,157,110,63]},
 blink:{s:[228,512,152,60],d:[220,88,152,60]},
 smirk:{s:[384,512,110,63],d:[238,157,110,63]}
};
function update(s){
 if(!s)return;state={...state,...s};
 actor.style.display=state.visible?'block':'none';
 actor.style.width=Math.max(100,Math.min(360,Number(state.size)||220))+'px';
 actor.style.left=state.side==='left'?'0':'auto';
 actor.style.right=state.side==='left'?'auto':'0';
 giftFx.classList.toggle('left',state.side==='left');
 giftNote.classList.toggle('left',state.side==='left');
}
function frame(name){
 if(!atlas.complete||!atlas.naturalWidth||name===lastFrame)return;
 lastFrame=name;ctx.clearRect(0,0,512,512);
 ctx.drawImage(atlas,0,0,512,512,0,0,512,512);
 if(patches[name]){
   const p=patches[name],s=p.s,d=p.d;
   ctx.drawImage(atlas,s[0],s[1],s[2],s[3],d[0],d[1],d[2],d[3]);
 }
}
function tick(){
 const now=Date.now();
 if(speaking||now<demoUntil){
   if(!talkingAt)talkingAt=now;
   const n=Math.floor((now-talkingAt)/180)%4;
   frame(n===0?'talk1':n===1?'talk2':n===2?'talk1':'idle');
 } else {
   talkingAt=0;
   if(now>nextBlink){blinkAt=now;nextBlink=now+3300+Math.random()*2300;}
   frame(now-blinkAt<180?'blink':state.mood==='smirk'?'smirk':'idle');
 }
}
atlas.onload=()=>{lastFrame='';tick();};
setInterval(tick,120);
async function playNextAudio(){
 if(currentAudio||!audioQueue.length)return;
 currentAudio=audioQueue.shift();
 audio.onended=null;
 audio.onerror=null;
 audio.src=currentAudio.url;
 audio.muted=false;
 speaking=true;
 talkingAt=Date.now();
 try{
   await audio.play();
   audio.onended=()=>{
     speaking=false;
     currentAudio=null;
     playNextAudio();
   };
   audio.onerror=()=>{
     speaking=false;
     currentAudio=null;
     playNextAudio();
   };
 }catch{
   const failed=currentAudio;
   currentAudio=null;
   speaking=false;
   if(failed)audioQueue.unshift(failed);
   setTimeout(playNextAudio,800);
 }
}
function voice(m){
 if(!m||!m.url)return;
 audioQueue.push(m);
 if(audioQueue.length>20)audioQueue.splice(0,audioQueue.length-20);
 playNextAudio();
}
function cleanGiftName(v){return String(v||'Regalo').replace(/[<>]/g,'').trim().slice(0,40)||'Regalo';}
function cleanGiftUser(v){return String(v||'Alguien').replace(/^@/,'').replace(/[<>]/g,'').trim().slice(0,32)||'Alguien';}
function enqueueGift(m){giftQueue.push(m||{});if(giftQueue.length>12)giftQueue.splice(0,giftQueue.length-12);runGiftQueue();}
function runGiftQueue(){
 if(giftBusy||!giftQueue.length)return;
 giftBusy=true;
 const m=giftQueue.shift();
 const giftName=cleanGiftName(m.giftName||m.gift_name);
 const user=cleanGiftUser(m.displayName||m.username||m.uniqueId);
 const count=Math.max(1,Math.min(999,Number(m.repeatCount)||1));
 const picture=String(m.giftPictureUrl||'').trim();
 const isRose=/\b(rose|rosa)\b/i.test(giftName);
 giftEmoji.textContent=isRose?'🌹':'🎁';
 giftEmoji.style.display=picture?'none':'block';
 giftIcon.style.display=picture?'block':'none';
 if(picture){giftIcon.src=picture;giftIcon.alt=giftName;}else{giftIcon.removeAttribute('src');giftIcon.alt='';}
 giftNote.textContent='@'+user+' envió '+giftName+(count>1?' ×'+count:'');
 giftFx.classList.remove('show');giftNote.classList.remove('show');actor.classList.remove('gift-react');
 void giftFx.offsetWidth;
 giftFx.classList.add('show');giftNote.classList.add('show');actor.classList.add('gift-react');
 setTimeout(()=>{
   giftFx.classList.remove('show');giftNote.classList.remove('show');actor.classList.remove('gift-react');
   giftBusy=false;runGiftQueue();
 },2900);
}
const events=new EventSource('/events');
events.onmessage=(e)=>{
 try{
   const m=JSON.parse(e.data);
   if(m.type==='avatar_state')update(m);
   else if(m.type==='avatar_demo'){demoUntil=Date.now()+5000;}
   else if(m.type==='tiktok_gift')enqueueGift(m);
   else if(m.type==='audio'&&m.url&&m.source!=='tiktok-comment-reader')voice(m);
 }catch{}
};
document.body.addEventListener('pointerdown',()=>{
 if(currentAudio&&audio.paused){
   speaking=true;
   talkingAt=Date.now();
   audio.play().catch(()=>{});
 }
},{once:true});
setInterval(()=>fetch('/keepalive',{cache:'no-store'}).catch(()=>{}),120000);
fetch('/keepalive',{cache:'no-store'}).catch(()=>{});
fetch('/api/avatar/state',{cache:'no-store'}).then(r=>r.json()).then(update).catch(()=>{});
</script></body></html>`;}

  function controlPage(key){return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JS Avatar · Control</title>
<style>
*{box-sizing:border-box}body{background:#111;color:#fff;font-family:system-ui;padding:14px;margin:0}
.card{background:#1c1c1c;border-radius:16px;padding:16px;max-width:620px;margin:0 auto 12px}
h2{margin:0 0 8px}p{color:#ccc;font-size:14px;line-height:1.5}
button{background:#eee;color:#111;border:0;border-radius:12px;padding:13px 9px;font-size:15px;font-weight:800;cursor:pointer}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:9px 0}
input[type=range]{width:100%}#prev{height:255px;border-radius:12px;overflow:hidden;background:repeating-conic-gradient(#303030 0 25%,#383838 0 50%) 50%/22px 22px}
iframe{border:0;width:100%;height:100%}#status{color:#9eedae;font-size:14px}
</style></head><body>
<div class="card"><h2>🎭 JS Avatar · 456</h2>
<p>Se mueve automáticamente al reproducirse la voz clonada de JS en el directo.</p>
<div id="prev"><iframe src="/avatar" title="Vista previa"></iframe></div>
<p id="status">Conectando...</p>
<div class="row"><button id="show">🙈 Ocultar</button><button id="demo">🗣️ Probar boca</button></div>
<div class="row"><button id="giftDemo">🌹 Probar rosa</button><button id="normal">😐 Normal</button></div>
<div class="row"><button id="smirk">😏 Sarcástico</button><button id="left">⬅️ Izquierda</button></div>
<button style="width:100%;margin-top:8px" id="right">➡️ Poner a la derecha</button>
<p>Tamaño: <b id="label">220px</b></p><input id="size" type="range" min="110" max="360" step="10" value="220">
<p>En PRISM usá una sola fuente: <b>https://js-live-voice.onrender.com/avatar</b>. Ahora incluye el avatar 2D + la voz principal JS.</p>
<button style="width:100%" id="copy">Copiar URL para PRISM</button>
</div>
<script>
const KEY=${JSON.stringify(key)};
let state={visible:true,mood:'normal',side:'right',size:220};
const status=document.getElementById('status'),size=document.getElementById('size');
function paint(j){state={...state,...j};document.getElementById('show').textContent=state.visible?'🙈 Ocultar':'👀 Mostrar';
 document.getElementById('label').textContent=state.size+'px';size.value=state.size;
 status.textContent='Avatar '+(state.visible?'activo':'oculto')+' · '+state.mood+' · '+state.side;}
async function send(action,more={}){
 try{
  const r=await fetch('/api/avatar/control',{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+KEY},body:JSON.stringify({action,...more})});
  const j=await r.json();if(!r.ok)throw Error(j.error||'error');paint(j);
 }catch(e){status.textContent='Error: '+String(e.message||e);}
}
document.getElementById('show').onclick=()=>send('visible',{visible:!state.visible});
document.getElementById('demo').onclick=()=>send('demo');
document.getElementById('giftDemo').onclick=()=>send('gift-demo');
document.getElementById('normal').onclick=()=>send('mood',{mood:'normal'});
document.getElementById('smirk').onclick=()=>send('mood',{mood:'smirk'});
document.getElementById('left').onclick=()=>send('side',{side:'left'});
document.getElementById('right').onclick=()=>send('side',{side:'right'});
size.oninput=()=>{document.getElementById('label').textContent=size.value+'px';};
size.onchange=()=>send('size',{size:Number(size.value)});
document.getElementById('copy').onclick=()=>navigator.clipboard.writeText(location.origin+'/avatar');
fetch('/api/avatar/state').then(r=>r.json()).then(paint).catch(()=>{});
new EventSource('/events').onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='avatar_state')paint(m)}catch{}};
</script></body></html>`;}

  async function handle(req,res,u){
    if(req.method==='GET'&&u.pathname==='/avatar'){html(res,avatarPage());return true;}
    if(req.method==='GET'&&u.pathname==='/avatar-image.webp'){
      if(!fs.existsSync(asset)){write(res,404,{ok:false,error:'avatar_not_installed'});return true;}
      const info=fs.statSync(asset);res.writeHead(200,{'content-type':'image/webp','cache-control':'public, max-age=86400','content-length':info.size});
      fs.createReadStream(asset).pipe(res);return true;
    }
    if(req.method==='GET'&&u.pathname==='/api/avatar/state'){write(res,200,{ok:true,...snapshot()});return true;}
    if(req.method==='GET'&&u.pathname==='/avatar-control'){
      const key=String(u.searchParams.get('key')||'');
      if(!controllerKey||key!==controllerKey){write(res,404,{ok:false,error:'not_found'});return true;}
      html(res,controlPage(key));return true;
    }
    if(req.method==='POST'&&u.pathname==='/api/avatar/control'){
      if(!isAuthorized(req)){write(res,401,{ok:false,error:'unauthorized'});return true;}
      try{
        const body=await readJson(req),action=String(body.action||'');
        if(action==='visible')state.visible=Boolean(body.visible);
        else if(action==='size')state.size=Math.max(110,Math.min(360,Math.round(Number(body.size)||220)));
        else if(action==='side')state.side=body.side==='left'?'left':'right';
        else if(action==='mood')state.mood=body.mood==='smirk'?'smirk':'normal';
        else if(action==='demo')broadcast({type:'avatar_demo',at:Date.now()});
        else if(action==='gift-demo')broadcast({type:'tiktok_gift',username:'prueba_js',displayName:'Prueba JS',giftName:'Rosa',repeatCount:1,giftPictureUrl:'',giftId:'demo-rose',test:true,at:Date.now()});
        else{write(res,400,{ok:false,error:'unknown_action'});return true;}
        if(action!=='demo'&&action!=='gift-demo')publish();write(res,200,{ok:true,...snapshot()});
      }catch(e){write(res,400,{ok:false,error:String(e.message||e)});}
      return true;
    }
    return false;
  }
  return {handle};
};
