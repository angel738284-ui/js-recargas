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
@keyframes breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.012)}}
</style></head><body>
<div id="actor"><canvas id="face" width="512" height="512"></canvas></div>
<script>
const actor=document.getElementById('actor');
const canvas=document.getElementById('face');
const ctx=canvas.getContext('2d',{alpha:true});
const atlas=new Image();atlas.src='/avatar-image.webp?v=hd2';
let state={visible:true,mood:'normal',side:'right',size:220};
let talkingAt=0,talkingUntil=0,lastFrame='',blinkAt=0,nextBlink=Date.now()+3500,speechId=0;
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
 if(now>=talkingAt&&now<talkingUntil){
   const n=Math.floor((now-talkingAt)/180)%4;
   frame(n===0?'talk1':n===1?'talk2':n===2?'talk1':'idle');
 } else {
   if(now>nextBlink){blinkAt=now;nextBlink=now+3300+Math.random()*2300;}
   frame(now-blinkAt<180?'blink':state.mood==='smirk'?'smirk':'idle');
 }
}
atlas.onload=()=>{lastFrame='';tick();};
setInterval(tick,120);
function voice(m){
 const now=Date.now(), id=++speechId;
 const txt=String(m.text||'');
 talkingAt=now+170;
 talkingUntil=now+Math.max(1300,Math.min(24000,Math.round(txt.length*88)+750));
 const probe=new Audio();probe.preload='metadata';
 probe.onloadedmetadata=()=>{
   if(id!==speechId||!Number.isFinite(probe.duration)||probe.duration<=0)return;
   talkingUntil=Math.max(talkingAt+500,now+Math.min(60000,probe.duration*1000+500));
 };
 probe.src=m.url;
}
const events=new EventSource('/events');
events.onmessage=(e)=>{
 try{
   const m=JSON.parse(e.data);
   if(m.type==='avatar_state')update(m);
   else if(m.type==='avatar_demo'){talkingAt=Date.now();talkingUntil=talkingAt+5000;}
   else if(m.type==='audio'&&m.url&&m.source!=='tiktok-comment-reader')voice(m);
 }catch{}
};
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
<div class="row"><button id="normal">😐 Normal</button><button id="smirk">😏 Sarcástico</button></div>
<div class="row"><button id="left">⬅️ Izquierda</button><button id="right">➡️ Derecha</button></div>
<p>Tamaño: <b id="label">220px</b></p><input id="size" type="range" min="110" max="360" step="10" value="220">
<p>En PRISM agregá la fuente web <b>https://js-live-voice.onrender.com/avatar</b>. Es visual: la voz sigue saliendo por /prism.</p>
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
        else{write(res,400,{ok:false,error:'unknown_action'});return true;}
        if(action!=='demo')publish();write(res,200,{ok:true,...snapshot()});
      }catch(e){write(res,400,{ok:false,error:String(e.message||e)});}
      return true;
    }
    return false;
  }
  return {handle};
};
