const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 10000;
const LIVE_TOKEN = String(process.env.LIVE_TOKEN || '');
const CONTROLLER_KEY = String(process.env.CONTROLLER_KEY || '');
const VOICE_MCP = 'https://media-pipeline-8suq.onrender.com/mcp';
const FISH_API_KEY = String(process.env.FISH_API_KEY || '');
const FISH_REFERENCE_ID = String(process.env.FISH_REFERENCE_ID || 'f79707580f1f4574bb3668d16936b897');
const clients = new Set();
const generatedAudio = new Map();
let lastTestAt = 0;
let lastBrowserSayAt = 0;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) throw new Error('body_too_large');
  }
  return raw ? JSON.parse(raw) : {};
}

function isAuthorized(req) {
  return Boolean(LIVE_TOKEN) &&
    String(req.headers.authorization || '') === 'Bearer ' + LIVE_TOKEN;
}

function isControllerAuthorized(req) {
  const auth = String(req.headers.authorization || '');
  return (Boolean(CONTROLLER_KEY) && auth === 'Bearer ' + CONTROLLER_KEY) ||
    (Boolean(LIVE_TOKEN) && auth === 'Bearer ' + LIVE_TOKEN);
}

function broadcast(message) {
  const frame = 'data: ' + JSON.stringify(message) + '\n\n';
  for (const res of [...clients]) {
    try { res.write(frame); }
    catch { clients.delete(res); }
  }
}

async function makeVoice(text) {
  if (FISH_API_KEY) {
    const r = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + FISH_API_KEY,
        'Content-Type': 'application/json',
        'model': 's2.1-pro-free'
      },
      body: JSON.stringify({
        text,
        reference_id: FISH_REFERENCE_ID,
        format: 'mp3'
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) throw new Error('fish_http_' + r.status + ': ' + (await r.text()).slice(0,300));
    const buf = Buffer.from(await r.arrayBuffer());
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,8);
    generatedAudio.set(id, { buf, expires: Date.now() + 10 * 60 * 1000 });
    return '/audio/' + id + '.mp3';
  }

  const payload = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: 'generate_voice',
      arguments: { text }
    }
  };

  const r = await fetch(VOICE_MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000)
  });

  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('voice_bad_json'); }

  const audioUrl = data?.result?.structuredContent?.audio_url;
  if (!r.ok || !audioUrl) {
    throw new Error(data?.result?.content?.[0]?.text || ('voice_http_' + r.status));
  }
  return audioUrl;
}

const prismPage = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;background:transparent;overflow:hidden;font-family:system-ui}
#panel{position:fixed;left:10px;bottom:10px;background:rgba(0,0,0,.68);color:#fff;
border-radius:12px;padding:8px 10px;font-size:13px}
#unlock,#test,#talk{border:0;border-radius:9px;padding:9px 12px;font-weight:700;margin-left:4px}\n#test,#talk{display:none}\n#talk{font-size:16px;touch-action:none;user-select:none;-webkit-user-select:none}\n#transcript{margin-top:8px;max-width:320px;white-space:normal;line-height:1.25}
</style>
</head>
<body>
<audio id="audio" playsinline></audio>
<div id="panel">
  <span id="status">Conectando voz IA…</span>
  <button id="unlock">Activar audio</button>
  <button id="test">Probar voz</button>
  <button id="talk">🎙️ Mantener para hablar</button>
  <div id="transcript"></div>
</div>
<script>
const audio=document.getElementById('audio');
const statusEl=document.getElementById('status');
const unlockBtn=document.getElementById('unlock');
const testBtn=document.getElementById('test');
const talkBtn=document.getElementById('talk');
const transcriptEl=document.getElementById('transcript');
let unlocked=false;
let recognition=null;
let currentText='';
let sending=false;

async function unlockAudio(){
  try{
    audio.muted=true;
    audio.src='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    await audio.play();
    audio.pause();
    audio.muted=false;
    unlocked=true;
    unlockBtn.style.display='none';
    statusEl.textContent='Voz IA lista';
  }catch{
    statusEl.textContent='Tocá Activar audio';
  }
}
unlockBtn.onclick=unlockAudio;
testBtn.onclick=async()=>{
  await unlockAudio();
  statusEl.textContent='Generando prueba…';
  try{
    const r=await fetch('/api/test',{method:'POST'});
    const j=await r.json();
    if(!r.ok) throw new Error(j.error||'test_failed');
    statusEl.textContent='Audio enviado…';
  }catch(e){
    statusEl.textContent='Error en prueba';
  }
};

const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;

async function sendRecognized(text){
  text=String(text||'').trim();
  if(!text||sending)return;
  sending=true;
  transcriptEl.textContent='Entendí: “'+text+'”';
  statusEl.textContent='Generando voz IA…';
  try{
    const r=await fetch('/api/browser-say',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({text})
    });
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'say_failed');
    statusEl.textContent='Audio enviado…';
  }catch(e){
    statusEl.textContent='Error: '+String(e.message||e);
  }finally{
    sending=false;
  }
}

function setupRecognition(){
  if(!SpeechRecognition){
    talkBtn.disabled=true;
    talkBtn.textContent='🎙️ Usá Chrome para hablar';
    transcriptEl.textContent='Este navegador no ofrece reconocimiento de voz.';
    return;
  }
  recognition=new SpeechRecognition();
  recognition.lang='es-AR';
  recognition.interimResults=true;
  recognition.continuous=false;
  recognition.maxAlternatives=1;

  recognition.onstart=()=>{
    currentText='';
    statusEl.textContent='🎙️ Te escucho… hablá y soltá';
    transcriptEl.textContent='';
    talkBtn.textContent='🔴 Escuchando… soltá para enviar';
  };

  recognition.onresult=(event)=>{
    let text='';
    for(let i=0;i<event.results.length;i++){
      text+=event.results[i][0].transcript+' ';
    }
    currentText=text.trim();
    transcriptEl.textContent=currentText ? 'Escuchando: “'+currentText+'”' : '';
  };

  recognition.onerror=(event)=>{
    const e=String(event.error||'error');
    if(e==='not-allowed'||e==='service-not-allowed'){
      statusEl.textContent='Permití el micrófono en el navegador';
    }else if(e!=='aborted'){
      statusEl.textContent='No pude escuchar: '+e;
    }
  };

  recognition.onend=()=>{
    talkBtn.textContent='🎙️ Mantener para hablar';
    const text=currentText.trim();
    currentText='';
    if(text)sendRecognized(text);
  };
}

setupRecognition();

talkBtn.onpointerdown=(e)=>{
  e.preventDefault();
  if(sending||!recognition)return;
  unlockAudio();
  try{recognition.start();}catch{}
};

function stopTalking(e){
  if(e)e.preventDefault();
  if(!recognition)return;
  try{recognition.stop();}catch{}
}
talkBtn.onpointerup=stopTalking;
talkBtn.onpointercancel=stopTalking;
talkBtn.onpointerleave=(e)=>{if(e.buttons)stopTalking(e);};

document.body.addEventListener('pointerdown',()=>{if(!unlocked)unlockAudio()},{once:true});

const events=new EventSource('/events');
events.onopen=()=>{
  statusEl.textContent=unlocked ? 'Voz IA lista' : 'Conectado · activá audio una vez';
};
events.onerror=()=>{statusEl.textContent='Reconectando…';};
events.onmessage=async(ev)=>{
  try{
    const msg=JSON.parse(ev.data);
    if(msg.type==='audio' && msg.url){
      audio.src=msg.url;
      audio.muted=false;
      await audio.play();
      statusEl.textContent='Hablando…';
      audio.onended=()=>{statusEl.textContent='Voz IA lista';};
    }
  }catch{
    statusEl.textContent='Audio bloqueado · tocá Activar audio';
  }
};

setInterval(()=>fetch('/keepalive',{cache:'no-store'}).catch(()=>{}),120000);
fetch('/keepalive',{cache:'no-store'}).catch(()=>{});
</script>
</body>
</html>`;

function makeControlPage(key) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JS Live Voice · AUTO</title>
<style>
body{margin:0;background:#111;color:#fff;font-family:system-ui;padding:18px}
.card{max-width:560px;margin:auto;background:#1b1b1b;border-radius:18px;padding:18px}
h2{margin:0 0 10px}
button{width:100%;border:0;border-radius:14px;padding:16px;font-size:18px;font-weight:800;margin-top:10px}
#start{background:#fff;color:#111}
#stop{background:#333;color:#fff}
#status{margin-top:14px;font-weight:700}
#heard{margin-top:12px;line-height:1.4;min-height:48px}
.small{opacity:.75;font-size:13px;margin-top:10px}
</style>
</head>
<body>
<div class="card">
  <h2>JS Live Voice · AUTO</h2>
  <div>Una pulsación y queda escuchando. Cuando terminás una frase, la manda sola a Fish.</div>
  <button id="start">🟢 Iniciar micrófono AUTO</button>
  <button id="stop">🔴 Detener</button>
  <div id="status">Detenido</div>
  <div id="heard"></div>
  <div class="small">Durante esta prueba el micrófono se pausa mientras habla JS para evitar eco.</div>
</div>
<audio id="audio" playsinline></audio>
<script>
const KEY=${JSON.stringify(key)};
const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
const startBtn=document.getElementById('start');
const stopBtn=document.getElementById('stop');
const statusEl=document.getElementById('status');
const heardEl=document.getElementById('heard');
const audio=document.getElementById('audio');

let rec=null;
let autoMode=false;
let listening=false;
let busy=false;
let pending='';
let restarting=false;
let phraseBuffer='';
let latestInterim='';
let silenceTimer=null;

function normWords(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9áéíóúüñ ]/gi,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function mergeTranscript(base, incoming){
  base=String(base||'').trim();
  incoming=String(incoming||'').trim();
  if(!base)return incoming;
  if(!incoming)return base;

  const nb=normWords(base);
  const ni=normWords(incoming);

  if(ni===nb)return base;
  if(ni.startsWith(nb+' '))return incoming;
  if(nb.startsWith(ni+' '))return base;

  const bw=base.split(/\s+/);
  const iw=incoming.split(/\s+/);
  const bn=bw.map(normWords);
  const inn=iw.map(normWords);
  let overlap=0;
  const max=Math.min(bn.length,inn.length);
  for(let k=max;k>=1;k--){
    let same=true;
    for(let j=0;j<k;j++){
      if(bn[bn.length-k+j]!==inn[j]){same=false;break;}
    }
    if(same){overlap=k;break;}
  }
  return (base+' '+iw.slice(overlap).join(' ')).replace(/\s+/g,' ').trim();
}

function schedulePhraseFlush(){
  if(silenceTimer)clearTimeout(silenceTimer);
  silenceTimer=setTimeout(()=>{
    silenceTimer=null;
    if(busy||!autoMode)return;
    const text=String(phraseBuffer||latestInterim||'').replace(/\s+/g,' ').trim();
    phraseBuffer='';
    latestInterim='';
    if(text){
      pending=text;
      heardEl.textContent='Entendí: “'+text+'”';
      sendPhrase(text);
    }
  },950);
}

async function unlockAudio(){
  try{
    audio.muted=true;
    audio.src='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    await audio.play();
    audio.pause();
    audio.muted=false;
  }catch{}
}

function buildRecognition(){
  rec=new SR();
  rec.lang='es-AR';
  rec.continuous=true;
  rec.interimResults=true;
  rec.maxAlternatives=1;

  rec.onstart=()=>{
    listening=true;
    restarting=false;
    statusEl.textContent='🎙️ Escuchando… hablá normal';
  };

  rec.onresult=(event)=>{
    let snapshot='';
    let interim='';

    for(let i=0;i<event.results.length;i++){
      const t=String(event.results[i][0].transcript||'').trim();
      if(!t)continue;
      snapshot=mergeTranscript(snapshot,t);
      if(!event.results[i].isFinal)interim=t;
    }

    phraseBuffer=snapshot.trim();
    latestInterim=interim.trim();

    if(phraseBuffer){
      heardEl.textContent='Escuchando: “'+phraseBuffer+'”';
      schedulePhraseFlush();
    }
  };

  rec.onerror=(e)=>{
    const err=String(e.error||'error');
    if(err==='not-allowed'||err==='service-not-allowed'){
      autoMode=false;
      statusEl.textContent='Permití el micrófono en Chrome';
    }else if(err!=='aborted'&&err!=='no-speech'){
      statusEl.textContent='Micrófono: '+err;
    }
  };

  rec.onend=()=>{
    listening=false;
    if(autoMode && !busy && !restarting){
      restarting=true;
      setTimeout(startListening,350);
    }
  };
}

function startListening(){
  if(!autoMode||busy||listening||!rec)return;
  try{rec.start();}catch{}
}

function stopListening(){
  if(!rec||!listening)return;
  try{rec.stop();}catch{}
}

async function sendPhrase(text){
  if(!text||busy)return;
  busy=true;
  stopListening();
  statusEl.textContent='📝 Transcripto · generando voz JS…';
  try{
    const r=await fetch('/api/browser-say',{
      method:'POST',
      headers:{
        'content-type':'application/json',
        'authorization':'Bearer '+KEY
      },
      body:JSON.stringify({text})
    });
    const j=await r.json();
    if(!r.ok) throw new Error(j.error||'voice_failed');
    statusEl.textContent='🔊 Esperando voz JS…';
  }catch(e){
    busy=false;
    statusEl.textContent='Error: '+String(e.message||e);
    if(autoMode)setTimeout(startListening,500);
  }
}

if(!SR){
  startBtn.disabled=true;
  statusEl.textContent='Abrí esta página en Chrome: este navegador no tiene reconocimiento de voz.';
}else{
  buildRecognition();
}

startBtn.onclick=async()=>{
  await unlockAudio();
  if(!SR)return;
  autoMode=true;
  busy=false;
  startListening();
};

stopBtn.onclick=()=>{
  autoMode=false;
  busy=false;
  stopListening();
  statusEl.textContent='Detenido';
};

const events=new EventSource('/events');
events.onmessage=async(ev)=>{
  try{
    const msg=JSON.parse(ev.data);
    if(msg.type==='audio'&&msg.url){
      stopListening();
      audio.src=msg.url;
      audio.muted=false;
      statusEl.textContent='🔊 JS hablando…';
      await audio.play();
      audio.onended=()=>{
        busy=false;
        pending='';
        statusEl.textContent=autoMode?'Reanudando micrófono…':'Detenido';
        if(autoMode)setTimeout(startListening,350);
      };
    }
  }catch{
    busy=false;
    if(autoMode)setTimeout(startListening,500);
  }
};
</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }

  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/health')) {
    return json(res, 200, {
      ok: true,
      service: 'js-live-voice',
      connected_players: clients.size,
      voice_mcp: true,
      fish_direct: Boolean(FISH_API_KEY),
      fish_reference_id: FISH_REFERENCE_ID
    });
  }

  if (req.method === 'GET' && u.pathname === '/keepalive') {
    return json(res, 200, { ok: true, now: Date.now() });
  }

  if (req.method === 'GET' && u.pathname.startsWith('/audio/')) {
    const id = u.pathname.replace('/audio/','').replace(/\.mp3$/,'');
    const item = generatedAudio.get(id);
    if (!item || item.expires < Date.now()) {
      generatedAudio.delete(id);
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'content-length': item.buf.length,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    });
    return res.end(item.buf);
  }

  if (req.method === 'GET' && u.pathname === '/control') {
    const key = String(u.searchParams.get('key') || '');
    if (!CONTROLLER_KEY || key !== CONTROLLER_KEY) {
      return json(res, 404, { ok: false, error: 'not_found' });
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    });
    return res.end(makeControlPage(key));
  }

  if (req.method === 'GET' && u.pathname === '/prism') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    return res.end(prismPage);
  }

  if (req.method === 'GET' && u.pathname === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*'
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && u.pathname === '/api/browser-say') {
    if (!isControllerAuthorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const now = Date.now();
      if (now - lastBrowserSayAt < 2500) {
        return json(res, 429, { ok: false, error: 'Esperá un momento antes de volver a hablar.' });
      }
      const body = await readJson(req);
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { ok: false, error: 'No entendí ninguna frase.' });
      if (text.length > 220) return json(res, 400, { ok: false, error: 'La frase es demasiado larga para esta prueba.' });

      lastBrowserSayAt = now;
      const audioUrl = await makeVoice(text);
      broadcast({ type: 'audio', url: audioUrl, text, at: now, browser: true });
      return json(res, 200, {
        ok: true,
        audio_url: audioUrl,
        connected_players: clients.size
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/test') {
    if (!isAuthorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
    try {
      const now = Date.now();
      if (now - lastTestAt < 10000) {
        return json(res, 429, { ok: false, error: 'Esperá unos segundos antes de otra prueba.' });
      }
      lastTestAt = now;
      const text = 'Prueba de voz en directo.';
      const audioUrl = await makeVoice(text);
      broadcast({ type: 'audio', url: audioUrl, text, at: now, test: true });
      return json(res, 200, { ok: true, audio_url: audioUrl, connected_players: clients.size });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/say') {
    if (!isAuthorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

    try {
      const body = await readJson(req);
      const text = String(body.text || '').trim();

      if (!text) return json(res, 400, { ok: false, error: 'text_required' });
      if (text.length > 500) return json(res, 400, { ok: false, error: 'text_too_long' });

      const audioUrl = await makeVoice(text);
      broadcast({ type: 'audio', url: audioUrl, text, at: Date.now() });

      return json(res, 200, {
        ok: true,
        audio_url: audioUrl,
        connected_players: clients.size
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  return json(res, 404, { ok: false, error: 'not_found' });
});

setInterval(() => {
  for (const res of [...clients]) {
    try { res.write(': ping ' + Date.now() + '\n\n'); }
    catch { clients.delete(res); }
  }
  for (const [id, item] of generatedAudio) {
    if (item.expires < Date.now()) generatedAudio.delete(id);
  }
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('JS Live Voice listening on', PORT);
});
