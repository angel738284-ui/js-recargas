'use strict';

module.exports = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>JS FF · Chat en pantalla</title>
<style>
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}
body{font-family:system-ui,"Segoe UI",Arial,sans-serif;color:#fff}
#wrap{position:fixed;left:3%;bottom:22%;width:min(88%,570px);display:flex;flex-direction:column;gap:10px;pointer-events:none}
#chat{display:flex;flex-direction:column;gap:9px;align-items:flex-start}
.msg{display:block;width:fit-content;max-width:100%;min-width:120px;background:linear-gradient(120deg,rgba(14,15,26,.9),rgba(28,20,38,.88));padding:10px 16px 12px;border:1px solid rgba(240,65,94,.45);border-left:5px solid #fb526d;border-radius:7px 15px 15px 15px;box-shadow:0 4px 18px rgba(0,0,0,.42);animation:enter .38s cubic-bezier(.15,.7,.2,1) both;overflow-wrap:anywhere}
.name{font-weight:850;font-size:clamp(13px,3.4vw,19px);color:#ff8b9d;line-height:1.25;letter-spacing:.1px}
.body{font-weight:650;font-size:clamp(15px,3.7vw,21px);line-height:1.34;white-space:pre-wrap;margin-top:4px;color:#fff;text-shadow:0 1px 3px #000}
.msg.exiting{animation:exit .4s ease-in forwards}
@keyframes enter{from{opacity:0;transform:translateY(22px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes exit{to{opacity:0;transform:translateX(-14px) scale(.96)}}
@media(min-width:750px){#wrap{left:22px;bottom:20%;width:560px}}
</style>
</head>
<body>
<div id="wrap"><div id="chat" role="log" aria-live="off"></div></div>
<script>
const chat=document.getElementById('chat');
let latestShown=0;
function removeCard(el){
  if(!el||!el.isConnected)return;
  el.classList.add('exiting');
  setTimeout(()=>el.remove(),420);
}
function showComment(name,comment){
  name=String(name||'Espectador').trim().slice(0,50);
  comment=String(comment||'').trim().slice(0,250);
  if(!comment)return;
  const el=document.createElement('div');
  el.className='msg';
  const nameEl=document.createElement('div');
  nameEl.className='name';
  nameEl.textContent=name;
  const bodyEl=document.createElement('div');
  bodyEl.className='body';
  bodyEl.textContent=comment;
  el.append(nameEl,bodyEl);
  chat.appendChild(el);
  latestShown++;
  const visible=[...chat.children].filter(x=>!x.classList.contains('exiting'));
  while(visible.length>4)removeCard(visible.shift());
  setTimeout(()=>removeCard(el),16000);
}
const events=new EventSource('/events');
events.onmessage=(event)=>{
  try{
    const msg=JSON.parse(event.data);
    if(msg.type==='tiktok_chat_display')showComment(msg.name,msg.comment);
  }catch{}
};
if(new URLSearchParams(location.search).has('demo')){
  showComment('Lucas_FF','JS, ¿cuándo jugamos clasificatoria?');
  setTimeout(()=>showComment('Valentina','¡Qué buen outfit!'),700);
  setTimeout(()=>showComment('Espectador','Saludame, JS 😎'),1300);
}
setInterval(()=>fetch('/keepalive',{cache:'no-store'}).catch(()=>{}),120000);
fetch('/keepalive',{cache:'no-store'}).catch(()=>{});
</script>
</body>
</html>`;
