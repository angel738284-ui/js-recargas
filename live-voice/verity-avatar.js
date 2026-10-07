'use strict';

module.exports = function createVerityAvatar({broadcast, controllerKey, isAuthorized, readJson}) {
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
<title>Mini Verity 2D</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent!important}
#actor{position:fixed;bottom:0;left:0;width:165px;max-width:100vw;pointer-events:none;transform-origin:bottom center;animation:breathe 3.4s ease-in-out infinite;filter:drop-shadow(0 7px 9px rgba(0,0,0,.38))}
#actor.right{left:auto;right:0}
#card{position:relative;width:100%;aspect-ratio:1/1}
svg{display:block;width:100%;height:100%;overflow:visible}
#tag{position:absolute;left:50%;bottom:2px;transform:translateX(-50%);padding:3px 9px;border-radius:999px;background:rgba(16,10,29,.80);border:1px solid rgba(201,151,255,.55);color:#f2dcff;font:800 10px/1 system-ui;letter-spacing:.8px;white-space:nowrap}
.hairBack{fill:#21162e}.hair{fill:#332041}.hairHi{fill:#5a3670;opacity:.72}
.skin{fill:#f2c8ba}.neck{fill:#e9b7aa}.hood{fill:#29223b}.hoodHi{fill:#493560}
.eyeWhite{fill:#fff5fb}.iris{fill:#b868dd}.pupil{fill:#25142e}.eyeLine{stroke:#4b244f;stroke-width:8;stroke-linecap:round;fill:none}
.brow{stroke:#3b1f42;stroke-width:8;stroke-linecap:round;fill:none;transform-box:fill-box;transform-origin:center}
.cheek{fill:#ef8ea4;opacity:.25}.mouthLine{stroke:#7b3357;stroke-width:7;stroke-linecap:round;fill:none}
#mouthOpen{display:none;fill:#6f294c;stroke:#7b3357;stroke-width:5}.tongue{fill:#e887a8}
.fang{fill:#fff;display:none}.spark{opacity:0;fill:#f0b8ff}.crazyRing{opacity:0;fill:none;stroke:#ff89e8;stroke-width:4}
.eyeGroup{transform-box:fill-box;transform-origin:center}
#actor.blink .eyeGroup{transform:scaleY(.06)}
#actor.talking #mouthClosed{display:none}
#actor.talking #mouthOpen{display:block}
#actor[data-mood="bad"] .browL{transform:rotate(18deg) translateY(2px)}
#actor[data-mood="bad"] .browR{transform:rotate(-18deg) translateY(2px)}
#actor[data-mood="bad"] .eyeGroup{transform:scaleY(.72)}
#actor[data-mood="bad"] .iris{fill:#e6507a}
#actor[data-mood="bad"] #mouthClosed{d:path("M220 311 Q255 294 296 303")}
#actor[data-mood="bad"] .fang{display:block}
#actor[data-mood="crazy"]{animation:breathe 2.5s ease-in-out infinite,crazyShake .36s ease-in-out infinite alternate}
#actor[data-mood="crazy"] .iris{fill:#ff4fc9}
#actor[data-mood="crazy"] .pupil{transform-box:fill-box;transform-origin:center;animation:pupilPulse .55s ease-in-out infinite alternate}
#actor[data-mood="crazy"] .browL{transform:rotate(-16deg) translateY(-3px)}
#actor[data-mood="crazy"] .browR{transform:rotate(16deg) translateY(3px)}
#actor[data-mood="crazy"] .spark{opacity:.95;animation:spark 1s ease-in-out infinite alternate}
#actor[data-mood="crazy"] .crazyRing{opacity:.75;animation:ring 1.1s linear infinite}
#actor[data-mood="crazy"] #tag{border-color:#ff78dd;color:#ffd8f7}
@keyframes breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-3px) scale(1.012)}}
@keyframes crazyShake{0%{rotate:-.7deg}100%{rotate:.7deg}}
@keyframes pupilPulse{from{transform:scale(.85)}to{transform:scale(1.18)}}
@keyframes spark{from{opacity:.35}to{opacity:1}}
@keyframes ring{to{transform:rotate(360deg);transform-origin:256px 210px}}
</style></head><body>
<div id="actor" data-mood="normal">
  <div id="card">
  <svg viewBox="0 0 512 512" role="img" aria-label="Mini Verity">
    <path class="hood" d="M119 512c6-106 57-158 137-158s132 52 138 158H119z"/>
    <path class="hoodHi" d="M173 512c8-73 38-119 83-126 45 8 74 54 83 126h-166z"/>
    <path class="hairBack" d="M132 183c7-96 54-150 125-150 77 0 122 58 126 154l-13 198c-35 37-190 37-225-3l-13-199z"/>
    <path class="neck" d="M220 333h72v70c-20 20-53 20-72 0v-70z"/>
    <ellipse class="skin" cx="256" cy="229" rx="111" ry="135"/>
    <path class="hair" d="M143 190c4-100 53-153 118-153 70 0 117 51 120 146-44-48-84-60-130-70-24 35-58 59-108 77z"/>
    <path class="hair" d="M148 182c-12 72 1 161 33 209l24-9c-23-73-18-142-3-197l-54-3z"/>
    <path class="hair" d="M365 176c18 75 7 157-25 211l-25-9c25-70 23-137 4-194l46-8z"/>
    <path class="hairHi" d="M181 104c26-40 61-57 101-54-27 15-47 33-59 59-15 31-22 49-57 70 4-28 8-51 15-75z"/>
    <g class="eyeGroup eyeL">
      <ellipse class="eyeWhite" cx="211" cy="232" rx="38" ry="28"/>
      <ellipse class="iris" cx="216" cy="233" rx="16" ry="20"/>
      <ellipse class="pupil" cx="216" cy="234" rx="7" ry="11"/>
      <circle fill="#fff" cx="222" cy="225" r="5"/>
      <path class="eyeLine" d="M175 229Q211 204 247 228"/>
    </g>
    <g class="eyeGroup eyeR">
      <ellipse class="eyeWhite" cx="301" cy="232" rx="38" ry="28"/>
      <ellipse class="iris" cx="296" cy="233" rx="16" ry="20"/>
      <ellipse class="pupil" cx="296" cy="234" rx="7" ry="11"/>
      <circle fill="#fff" cx="302" cy="225" r="5"/>
      <path class="eyeLine" d="M265 228Q301 204 337 229"/>
    </g>
    <path class="brow browL" d="M177 191Q211 181 240 194"/>
    <path class="brow browR" d="M272 194Q302 181 337 192"/>
    <ellipse class="cheek" cx="191" cy="278" rx="27" ry="11"/>
    <ellipse class="cheek" cx="322" cy="278" rx="27" ry="11"/>
    <path id="mouthClosed" class="mouthLine" d="M222 302Q256 319 291 302"/>
    <g id="mouthOpen">
      <ellipse cx="256" cy="307" rx="33" ry="22"/>
      <path class="tongue" d="M229 315q27 19 54 0q-26-7-54 0z"/>
    </g>
    <path class="fang" d="M279 303l10 2-7 14z"/>
    <circle class="spark" cx="172" cy="151" r="7"/><circle class="spark" cx="348" cy="169" r="5"/>
    <circle class="crazyRing" cx="256" cy="210" r="151" stroke-dasharray="22 19"/>
  </svg>
  <div id="tag">MINI VERITY</div>
  </div>
</div>
<script>
const actor=document.getElementById('actor');
let state={visible:true,mood:'normal',autoMood:true,side:'left',size:165};
let talkingUntil=0,blinkUntil=0,nextBlink=Date.now()+2600,lastMood='normal',speechId=0;

function update(s){
 if(!s)return;
 state={...state,...s};
 actor.style.display=state.visible?'block':'none';
 actor.style.width=Math.max(90,Math.min(320,Number(state.size)||165))+'px';
 actor.classList.toggle('right',state.side==='right');
 if(Date.now()>=talkingUntil)setMood(state.mood);
}
function setMood(m){
 const mood=['normal','bad','crazy'].includes(m)?m:'normal';
 lastMood=mood;
 actor.dataset.mood=mood;
}
function autoMood(m){
 const text=String((m&&m.spoken_text)||(m&&m.text)||(m&&m.comment)||'').toLowerCase();
 if(/(jaj|jeje|jiji|xd|😂|🤣|💀|loc[oa]|wtf|demencia|caos)/i.test(text))return 'crazy';
 if(/(😡|🤬|enoj|malo|malvada|callate|cállate|odio|bronca|furia)/i.test(text))return 'bad';
 return 'normal';
}
function voice(m){
 if(!m||m.source!=='tiktok-comment-reader')return;
 const now=Date.now(),id=++speechId;
 const txt=String(m.spoken_text||m.text||'');
 talkingUntil=now+Math.max(1200,Math.min(26000,Math.round(txt.length*86)+800));
 if(state.autoMood)setMood(autoMood(m));else setMood(state.mood);
 const probe=new Audio();probe.preload='metadata';
 probe.onloadedmetadata=()=>{
   if(id!==speechId||!Number.isFinite(probe.duration)||probe.duration<=0)return;
   talkingUntil=Math.max(now+650,now+Math.min(60000,probe.duration*1000+450));
 };
 probe.src=m.url;
}
function tick(){
 const now=Date.now();
 actor.classList.toggle('talking',now<talkingUntil&&Math.floor(now/145)%2===0);
 if(now>nextBlink&&now>=talkingUntil){
   blinkUntil=now+145;nextBlink=now+2500+Math.random()*2600;
 }
 actor.classList.toggle('blink',now<blinkUntil);
 if(now>=talkingUntil&&lastMood!==state.mood)setMood(state.mood);
}
setInterval(tick,90);

const events=new EventSource('/events');
events.onmessage=e=>{
 try{
   const m=JSON.parse(e.data);
   if(m.type==='verity_avatar_state')update(m);
   else if(m.type==='verity_demo'){
     const now=Date.now();talkingUntil=now+4500;setMood(m.mood||state.mood);
   }else if(m.type==='audio'&&m.url&&m.source==='tiktok-comment-reader')voice(m);
 }catch{}
};
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
button.on{background:#dca8ff;color:#25102f}input[type=range]{width:100%}
#status{font-size:14px;color:#bde9c2}
</style></head><body>
<div class="card">
<h2>🎙️ Mini Verity</h2>
<p>Este avatar escucha solamente la voz Verity de los comentarios. Nunca reacciona a la voz principal JS.</p>
<div id="prev"><iframe src="/verity" title="Mini Verity"></iframe></div>
<p id="status">Conectando…</p>
<div class="row"><button id="show">🙈 Ocultar</button><button id="demo">🗣️ Probar boca</button></div>
<div class="row"><button id="normal">🙂 Normal</button><button id="bad">😈 Mala</button></div>
<div class="row"><button id="crazy">🤪 Loca</button><button id="auto">✨ Caras AUTO: ON</button></div>
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
document.getElementById('bad').onclick=()=>send('mood',{mood:'bad'});
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
        else if(action==='mood')state.mood=['bad','crazy'].includes(body.mood)?body.mood:'normal';
        else if(action==='auto')state.autoMood=Boolean(body.enabled);
        else if(action==='demo')broadcast({type:'verity_demo',mood:['bad','crazy'].includes(body.mood)?body.mood:'normal',at:Date.now()});
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
