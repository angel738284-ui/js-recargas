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

async function readBuffer(req, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('audio_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

async function transcribeVoice(buffer, contentType) {
  if (!FISH_API_KEY) throw new Error('fish_api_key_missing');

  const form = new FormData();
  form.append(
    'audio',
    new Blob([buffer], { type: contentType || 'audio/webm' }),
    'speech.webm'
  );
  form.append('language', 'es');
  form.append('ignore_timestamps', 'true');
  form.append('tag_audio_events', 'false');

  const r = await fetch('https://api.fish.audio/v1/asr', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + FISH_API_KEY,
      'model': 'transcribe-1-pro'
    },
    body: form,
    signal: AbortSignal.timeout(60000)
  });

  const raw = await r.text();
  let data;
  try { data = JSON.parse(raw); }
  catch { throw new Error('asr_bad_json'); }

  if (!r.ok) {
    throw new Error('asr_http_' + r.status + ': ' + String(data?.message || raw).slice(0,300));
  }

  return {
    text: String(data?.text || '').trim(),
    language_code: String(data?.language_code || '').toLowerCase(),
    language: String(data?.language || '')
  };
}

function detectProsody(text, u) {
  if (!u.searchParams.has('avg')) {
    return {
      label: 'normal',
      tags: [],
      levelRatio: 0,
      peakRatio: 0,
      variation: 0,
      wordsPerSecond: 0
    };
  }

  const num = (name, fallback) => {
    const v = Number(u.searchParams.get(name));
    return Number.isFinite(v) ? v : fallback;
  };

  const avg = Math.max(0, num('avg', 0));
  const peak = Math.max(0, num('peak', 0));
  const variation = Math.max(0, num('variation', 0));
  const noise = Math.max(0.001, num('noise', 0.006));
  const duration = Math.min(20, Math.max(0.35, num('duration', 1)));

  const levelRatio = Math.min(20, avg / noise);
  const peakRatio = Math.min(40, peak / noise);
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const speakingSeconds = Math.max(0.45, duration - 0.72);
  const wordsPerSecond = words / speakingSeconds;

  const fast = wordsPerSecond >= 3.0;
  const slow = wordsPerSecond <= 1.65;
  const soft = levelRatio < 2.7 && peakRatio < 5.5;
  const loud = levelRatio >= 5.5 || peakRatio >= 10;
  const expressive = variation >= 0.55;

  let label = 'normal';
  let tags = [];

  if ((fast && loud) || (fast && expressive && levelRatio >= 3.2)) {
    label = 'emocionado · rápido';
    tags = ['[excited]', '[speaking quickly]'];
  } else if (loud) {
    label = 'fuerte · enérgico';
    tags = ['[loud voice]', '[emphasis]'];
  } else if (soft && slow) {
    label = 'suave · despacio';
    tags = ['[soft voice]', '[speaking slowly]'];
  } else if (soft) {
    label = 'suave';
    tags = ['[soft voice]'];
  } else if (slow) {
    label = 'despacio';
    tags = ['[speaking slowly]'];
  } else if (fast) {
    label = 'rápido';
    tags = ['[speaking quickly]'];
  } else if (expressive) {
    label = 'expresivo';
    tags = ['[emphasis]'];
  }

  return {
    label,
    tags,
    levelRatio: Number(levelRatio.toFixed(2)),
    peakRatio: Number(peakRatio.toFixed(2)),
    variation: Number(variation.toFixed(2)),
    wordsPerSecond: Number(wordsPerSecond.toFixed(2))
  };
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
  <div>Fish escucha tu audio directamente. Al terminar una frase, la transcribe y la reproduce con la voz de JS.</div>
  <button id="start">🟢 Iniciar micrófono AUTO</button>
  <button id="stop">🔴 Detener</button>
  <div id="status">Detenido</div>
  <div id="heard"></div>
  <div class="small">El micrófono se pausa mientras habla JS para evitar eco.</div>
</div>
<audio id="audio" playsinline></audio>
<script>
const KEY=${JSON.stringify(key)};
const startBtn=document.getElementById('start');
const stopBtn=document.getElementById('stop');
const statusEl=document.getElementById('status');
const heardEl=document.getElementById('heard');
const audio=document.getElementById('audio');

let stream=null;
let ctx=null;
let analyser=null;
let dataArray=null;
let raf=0;
let recorder=null;
let chunks=[];
let autoMode=false;
let speechActive=false;
let busy=false;
let silenceSince=0;
let phraseStarted=0;
let threshold=0.026;
let noiseFloor=0.008;
let calibratingUntil=0;

async function unlockAudio(){
  try{
    audio.muted=true;
    audio.src='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    await audio.play();
    audio.pause();
    audio.muted=false;
  }catch{}
}

function rmsLevel(){
  analyser.getByteTimeDomainData(dataArray);
  let sum=0;
  for(let i=0;i<dataArray.length;i++){
    const v=(dataArray[i]-128)/128;
    sum+=v*v;
  }
  return Math.sqrt(sum/dataArray.length);
}

function bestMime(){
  const types=[
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4'
  ];
  for(const t of types){
    if(window.MediaRecorder && MediaRecorder.isTypeSupported(t))return t;
  }
  return '';
}

function beginPhrase(){
  if(!autoMode||busy||speechActive||!stream)return;
  chunks=[];
  const mime=bestMime();
  try{
    recorder=mime ? new MediaRecorder(stream,{mimeType:mime}) : new MediaRecorder(stream);
  }catch{
    recorder=new MediaRecorder(stream);
  }
  recorder.ondataavailable=e=>{
    if(e.data&&e.data.size)chunks.push(e.data);
  };
  recorder.onstop=sendRecordedPhrase;
  recorder.start(120);
  speechActive=true;
  silenceSince=0;
  phraseStarted=Date.now();
  statusEl.textContent='🎙️ Escuchando tu frase…';
}

function finishPhrase(){
  if(!speechActive)return;
  speechActive=false;
  silenceSince=0;
  try{
    if(recorder&&recorder.state!=='inactive')recorder.stop();
  }catch{}
}

async function sendRecordedPhrase(){
  if(!autoMode||!chunks.length){
    chunks=[];
    return;
  }
  const type=(chunks[0]&&chunks[0].type)||'audio/webm';
  const blob=new Blob(chunks,{type});
  chunks=[];
  if(blob.size<900){
    statusEl.textContent='🎙️ Escuchando…';
    return;
  }

  busy=true;
  statusEl.textContent='📝 Fish transcribiendo…';
  heardEl.textContent='';

  try{
    const r=await fetch('/api/asr-say',{
      method:'POST',
      headers:{
        'content-type':blob.type||'audio/webm',
        'authorization':'Bearer '+KEY
      },
      body:blob
    });
    const j=await r.json();
    if(!r.ok){
      if(j.error==='non_spanish_detected'){
        busy=false;
        statusEl.textContent='🎙️ Escuchando…';
        heardEl.textContent='No lo detecté claramente en español. Repetí la frase.';
        return;
      }
      throw new Error(j.error||'asr_failed');
    }
    heardEl.textContent='Entendí: “'+j.text+'”';
    statusEl.textContent='🔊 Esperando voz JS…';
  }catch(e){
    busy=false;
    statusEl.textContent='Error de transcripción';
    heardEl.textContent=String(e.message||e);
  }
}

function vadLoop(){
  if(!autoMode||!analyser)return;

  const rms=rmsLevel();
  const now=Date.now();

  if(now<calibratingUntil && !speechActive){
    noiseFloor=noiseFloor*0.9+rms*0.1;
    threshold=Math.max(0.012,noiseFloor*2.0);
  }

  if(!busy){
    if(!speechActive){
      if(now>=calibratingUntil && rms>threshold){
        beginPhrase();
      }
    }else{
      if(rms>threshold*0.82){
        silenceSince=0;
      }else{
        if(!silenceSince)silenceSince=now;
        if(now-silenceSince>850)finishPhrase();
      }

      if(now-phraseStarted>14000)finishPhrase();
    }
  }

  raf=requestAnimationFrame(vadLoop);
}

async function startAuto(){
  if(autoMode)return;
  await unlockAudio();

  try{
    stream=await navigator.mediaDevices.getUserMedia({
      audio:{
        echoCancellation:true,
        noiseSuppression:true,
        autoGainControl:true
      }
    });
  }catch(e){
    statusEl.textContent='Permití el micrófono en Chrome';
    return;
  }

  ctx=new (window.AudioContext||window.webkitAudioContext)();
  await ctx.resume();
  const source=ctx.createMediaStreamSource(stream);
  analyser=ctx.createAnalyser();
  analyser.fftSize=1024;
  analyser.smoothingTimeConstant=0.15;
  source.connect(analyser);
  dataArray=new Uint8Array(analyser.fftSize);

  chunks=[];
  autoMode=true;
  busy=false;
  speechActive=false;
  noiseFloor=0.006;
  threshold=0.016;
  calibratingUntil=Date.now()+700;
  statusEl.textContent='🎙️ Calibrando ruido… hablá en un segundo';
  vadLoop();
}

function stopAuto(){
  autoMode=false;
  busy=false;
  if(raf)cancelAnimationFrame(raf);
  raf=0;
  if(speechActive)finishPhrase();
  speechActive=false;
  recorder=null;
  chunks=[];
  if(stream){
    for(const t of stream.getTracks())t.stop();
  }
  stream=null;
  if(ctx){
    try{ctx.close();}catch{}
  }
  ctx=null;
  analyser=null;
  statusEl.textContent='Detenido';
}

startBtn.onclick=startAuto;
stopBtn.onclick=stopAuto;

const events=new EventSource('/events');
events.onmessage=async(ev)=>{
  try{
    const msg=JSON.parse(ev.data);
    if(msg.type==='audio'&&msg.url){
      if(speechActive)finishPhrase();
      busy=true;
      audio.src=msg.url;
      audio.muted=false;
      statusEl.textContent='🔊 JS hablando…';
      await audio.play();
      audio.onended=()=>{
        busy=false;
        statusEl.textContent=autoMode?'🎙️ Escuchando…':'Detenido';
      };
    }
  }catch{
    busy=false;
    if(autoMode)statusEl.textContent='🎙️ Escuchando…';
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

  if (req.method === 'POST' && u.pathname === '/api/asr-say') {
    if (!isControllerAuthorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

    try {
      const audio = await readBuffer(req);
      if (audio.length < 800) return json(res, 400, { ok: false, error: 'audio_too_short' });

      const contentType = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const tx = await transcribeVoice(audio, contentType);
      const text = tx.text;

      if (!text) return json(res, 422, { ok: false, error: 'no_speech_detected' });
      if (tx.language_code && tx.language_code !== 'es') {
        return json(res, 422, {
          ok: false,
          error: 'non_spanish_detected',
          language_code: tx.language_code
        });
      }
      if (text.length > 500) return json(res, 400, { ok: false, error: 'transcript_too_long' });

      const prosody = detectProsody(text, u);
      const styledText = (prosody.tags.length ? prosody.tags.join(' ') + ' ' : '') + text;
      const audioUrl = await makeVoice(styledText);
      broadcast({
        type: 'audio',
        url: audioUrl,
        text,
        style: prosody.label,
        at: Date.now(),
        asr: 'fish'
      });

      return json(res, 200, {
        ok: true,
        text,
        style_label: prosody.label,
        style_metrics: {
          level_ratio: prosody.levelRatio,
          peak_ratio: prosody.peakRatio,
          variation: prosody.variation,
          words_per_second: prosody.wordsPerSecond
        },
        language_code: tx.language_code || 'es',
        audio_url: audioUrl,
        connected_players: clients.size
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
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
