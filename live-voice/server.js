const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 10000;
const LIVE_TOKEN = String(process.env.LIVE_TOKEN || '');
const VOICE_MCP = 'https://media-pipeline-8suq.onrender.com/mcp';
const clients = new Set();
let lastTestAt = 0;

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

function broadcast(message) {
  const frame = 'data: ' + JSON.stringify(message) + '\n\n';
  for (const res of [...clients]) {
    try { res.write(frame); }
    catch { clients.delete(res); }
  }
}

async function makeVoice(text) {
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
#unlock,#test{border:0;border-radius:9px;padding:7px 10px;font-weight:700;margin-left:4px}
</style>
</head>
<body>
<audio id="audio" playsinline></audio>
<div id="panel">
  <span id="status">Conectando voz IA…</span>
  <button id="unlock">Activar audio</button>
  <button id="test">Probar voz</button>
</div>
<script>
const audio=document.getElementById('audio');
const statusEl=document.getElementById('status');
const unlockBtn=document.getElementById('unlock');
const testBtn=document.getElementById('test');
let unlocked=false;

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
      voice_mcp: true
    });
  }

  if (req.method === 'GET' && u.pathname === '/keepalive') {
    return json(res, 200, { ok: true, now: Date.now() });
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

  if (req.method === 'POST' && u.pathname === '/api/test') {
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
}, 25000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('JS Live Voice listening on', PORT);
});
