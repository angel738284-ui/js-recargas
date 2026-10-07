'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CLIENT_ID = String(process.env.SPOTIFY_CLIENT_ID || '');
const REDIRECT_URI = String(process.env.SPOTIFY_REDIRECT_URI || 'https://js-live-voice.onrender.com/spotify/callback');
const CONTROLLER_KEY = String(process.env.CONTROLLER_KEY || '');
const SPOTIFY_SETUP_KEY = String(process.env.SPOTIFY_SETUP_KEY || '');
const LIVE_TOKEN = String(process.env.LIVE_TOKEN || '');
const TOKEN_FILE = String(process.env.SPOTIFY_TOKEN_FILE || path.join(os.tmpdir(), 'js-live-spotify-token.json'));

const authStates = new Map();
let token = {
  access_token: '',
  refresh_token: String(process.env.SPOTIFY_REFRESH_TOKEN || ''),
  expires_at: 0
};

try {
  if (fs.existsSync(TOKEN_FILE)) {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    token.access_token = String(saved.access_token || '');
    token.refresh_token = String(saved.refresh_token || token.refresh_token || '');
    token.expires_at = Number(saved.expires_at || 0);
  }
} catch {}

function saveToken() {
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(token), { mode: 0o600 }); } catch {}
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
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
    if (raw.length > 10000) throw new Error('body_too_large');
  }
  return raw ? JSON.parse(raw) : {};
}

function authorized(req) {
  const auth = String(req.headers.authorization || '');
  return (CONTROLLER_KEY && auth === 'Bearer ' + CONTROLLER_KEY) ||
    (SPOTIFY_SETUP_KEY && auth === 'Bearer ' + SPOTIFY_SETUP_KEY) ||
    (LIVE_TOKEN && auth === 'Bearer ' + LIVE_TOKEN);
}

function setupAuthorized(req) {
  const auth = String(req.headers.authorization || '');
  return Boolean(SPOTIFY_SETUP_KEY) && auth === 'Bearer ' + SPOTIFY_SETUP_KEY;
}

function configured() {
  return Boolean(CLIENT_ID && REDIRECT_URI);
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: verifier
  });
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body,
    signal: AbortSignal.timeout(20000)
  });
  const data = await r.json().catch(function(){ return {}; });
  if (!r.ok) throw new Error('spotify_token_' + r.status + ': ' + String(data.error_description || data.error || 'error'));
  token.access_token = String(data.access_token || '');
  if (data.refresh_token) token.refresh_token = String(data.refresh_token);
  token.expires_at = Date.now() + Number(data.expires_in || 3600) * 1000;
  saveToken();
}

async function refreshAccessToken() {
  if (!token.refresh_token) throw new Error('spotify_not_connected');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: CLIENT_ID
  });
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body,
    signal: AbortSignal.timeout(20000)
  });
  const data = await r.json().catch(function(){ return {}; });
  if (!r.ok) throw new Error('spotify_refresh_' + r.status + ': ' + String(data.error_description || data.error || 'error'));
  token.access_token = String(data.access_token || '');
  if (data.refresh_token) token.refresh_token = String(data.refresh_token);
  token.expires_at = Date.now() + Number(data.expires_in || 3600) * 1000;
  saveToken();
  return token.access_token;
}

async function accessToken() {
  if (token.access_token && Date.now() < token.expires_at - 30000) return token.access_token;
  return refreshAccessToken();
}

async function spotifyFetch(url, options) {
  options = options || {};
  const t = await accessToken();
  const headers = Object.assign({}, options.headers || {}, { authorization: 'Bearer ' + t });
  let r = await fetch(url, Object.assign({}, options, { headers: headers, signal: AbortSignal.timeout(15000) }));
  if (r.status === 401 && token.refresh_token) {
    const fresh = await refreshAccessToken();
    headers.authorization = 'Bearer ' + fresh;
    r = await fetch(url, Object.assign({}, options, { headers: headers, signal: AbortSignal.timeout(15000) }));
  }
  return r;
}

function compactPlayback(data) {
  const item = data && data.item;
  const artists = item && Array.isArray(item.artists) ? item.artists.map(function(a){ return a.name; }).filter(Boolean) : [];
  const images = item && item.album && Array.isArray(item.album.images) ? item.album.images : [];
  return {
    configured: configured(),
    connected: Boolean(token.refresh_token || token.access_token),
    active: Boolean(data && data.device),
    playing: Boolean(data && data.is_playing),
    progress_ms: Number(data && data.progress_ms || 0),
    duration_ms: Number(item && item.duration_ms || 0),
    track: item ? {
      id: String(item.id || ''),
      uri: String(item.uri || ''),
      name: String(item.name || ''),
      artist: artists.join(', '),
      album: String(item.album && item.album.name || ''),
      cover: String(images[0] && images[0].url || '')
    } : null,
    device: data && data.device ? {
      id: String(data.device.id || ''),
      name: String(data.device.name || ''),
      type: String(data.device.type || ''),
      volume_percent: Number(data.device.volume_percent == null ? 0 : data.device.volume_percent)
    } : null
  };
}

async function playbackState() {
  if (!configured()) return { configured:false, connected:false, active:false, playing:false, track:null };
  if (!token.refresh_token && !token.access_token) return { configured:true, connected:false, active:false, playing:false, track:null };
  try {
    const r = await spotifyFetch('https://api.spotify.com/v1/me/player');
    if (r.status === 204) return { configured:true, connected:true, active:false, playing:false, track:null };
    const data = await r.json().catch(function(){ return {}; });
    if (!r.ok) throw new Error('spotify_player_' + r.status);
    return compactPlayback(data);
  } catch (e) {
    return {
      configured: configured(),
      connected: Boolean(token.refresh_token || token.access_token),
      active: false,
      playing: false,
      track: null,
      error: String(e && e.message || e)
    };
  }
}

async function searchTracks(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const url = 'https://api.spotify.com/v1/search?type=track&limit=10&q=' + encodeURIComponent(q);
  const r = await spotifyFetch(url);
  const data = await r.json().catch(function(){ return {}; });
  if (!r.ok) throw new Error('spotify_search_' + r.status);
  const items = data && data.tracks && Array.isArray(data.tracks.items) ? data.tracks.items : [];
  return items.map(function(item) {
    const artists = Array.isArray(item.artists) ? item.artists.map(function(a){ return a.name; }).filter(Boolean) : [];
    const images = item.album && Array.isArray(item.album.images) ? item.album.images : [];
    return {
      id: String(item.id || ''),
      uri: String(item.uri || ''),
      name: String(item.name || ''),
      artist: artists.join(', '),
      album: String(item.album && item.album.name || ''),
      cover: String(images[1] && images[1].url || images[0] && images[0].url || ''),
      duration_ms: Number(item.duration_ms || 0),
      explicit: Boolean(item.explicit)
    };
  });
}

function html(res, body) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer'
  });
  res.end(body);
}

function overlayPage() {
  return [
'<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JS Spotify Overlay</title>',
'<style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}#wrap{position:absolute;left:3.5vw;bottom:4vh;width:min(82vw,520px);display:grid;grid-template-columns:72px 1fr;gap:13px;align-items:center;padding:10px 14px 10px 10px;border:1px solid rgba(255,255,255,.13);border-radius:22px;background:linear-gradient(120deg,rgba(7,10,14,.94),rgba(16,21,28,.88));box-shadow:0 16px 45px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.05);backdrop-filter:blur(16px);transform:translateY(130%);opacity:0;transition:.42s cubic-bezier(.2,.8,.2,1)}#wrap.show{transform:translateY(0);opacity:1}#coverbox{position:relative;width:72px;height:72px}#cover{width:72px;height:72px;border-radius:16px;object-fit:cover;background:#171a20;box-shadow:0 6px 18px rgba(0,0,0,.4)}#pulse{position:absolute;right:-3px;bottom:-3px;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:#1ed760;border:3px solid #0b0f14;box-shadow:0 0 18px rgba(30,215,96,.35)}#bars{display:flex;gap:2px;align-items:end;height:9px}#bars i{width:2px;background:#07120a;border-radius:3px;animation:b 1s infinite ease-in-out}#bars i:nth-child(2){height:9px;animation-delay:.15s}#bars i:nth-child(1),#bars i:nth-child(3){height:5px}#wrap.pause #bars i{animation:none;height:3px}@keyframes b{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}#meta{min-width:0}.brand{display:flex;align-items:center;gap:8px;margin-bottom:3px;font-size:10px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#1ed760}.dot{width:5px;height:5px;border-radius:50%;background:#1ed760;box-shadow:0 0 10px #1ed760}.title{font-size:19px;line-height:1.15;font-weight:900;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.artist{font-size:13px;font-weight:650;color:#aeb8c7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.progressrow{display:grid;grid-template-columns:1fr auto;gap:9px;align-items:center;margin-top:9px}.bar{height:4px;background:rgba(255,255,255,.16);border-radius:999px;overflow:hidden}.progress{height:100%;width:0;background:linear-gradient(90deg,#1ed760,#67f39a);border-radius:999px;transition:width .75s linear}.time{font-size:10px;font-weight:700;color:#778393;min-width:34px;text-align:right}</style></head><body>',
'<div id="wrap"><div id="coverbox"><img id="cover" alt=""><div id="pulse"><span id="bars"><i></i><i></i><i></i></span></div></div><div id="meta"><div class="brand"><span class="dot"></span>JS FF · Now Playing</div><div id="title" class="title">—</div><div id="artist" class="artist">—</div><div class="progressrow"><div class="bar"><div id="progress" class="progress"></div></div><div id="time" class="time">0:00</div></div></div></div>',
'<script>var w=document.getElementById("wrap"),c=document.getElementById("cover"),t=document.getElementById("title"),a=document.getElementById("artist"),p=document.getElementById("progress"),tm=document.getElementById("time");function fmt(ms){var s=Math.max(0,Math.floor((ms||0)/1000));return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")}async function tick(){try{var r=await fetch("/api/spotify/public-state",{cache:"no-store"}),s=await r.json();if(s&&s.track){c.src=s.track.cover||"";t.textContent=s.track.name||"";a.textContent=s.track.artist||"";p.style.width=(s.duration_ms?Math.max(0,Math.min(100,s.progress_ms/s.duration_ms*100)):0)+"%";tm.textContent=fmt(s.progress_ms);w.classList.toggle("pause",!s.playing);w.classList.add("show")}else w.classList.remove("show")}catch(e){}}tick();setInterval(tick,1800);</script></body></html>'
  ].join('');
}

function controlPage(key) {
  const encodedKey = JSON.stringify(String(key || ''));
  return [
'<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JS Spotify</title>',
'<style>*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#162118 0,#0b0e12 38%,#080a0d 100%);color:#fff;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;padding:16px}.shell{max-width:720px;margin:auto}.top{display:flex;align-items:center;justify-content:space-between;margin:4px 2px 14px}.logo{font-size:23px;font-weight:950;letter-spacing:-.02em}.logo b{color:#1ed760}.badge{font-size:11px;font-weight:850;color:#95a09d;background:rgba(255,255,255,.06);padding:7px 10px;border:1px solid rgba(255,255,255,.08);border-radius:999px}.card{background:rgba(20,25,31,.92);border:1px solid rgba(255,255,255,.08);border-radius:24px;box-shadow:0 18px 50px rgba(0,0,0,.34);backdrop-filter:blur(16px);overflow:hidden}.player{padding:16px}.now{display:grid;grid-template-columns:92px 1fr;gap:14px;align-items:center}.cover{width:92px;height:92px;border-radius:18px;object-fit:cover;background:#242a31;box-shadow:0 10px 28px rgba(0,0,0,.42)}.eyebrow{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#1ed760;font-weight:900;margin-bottom:5px}.name{font-size:20px;font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.artist{color:#aeb7c4;font-size:14px;font-weight:650;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.device{color:#74808f;font-size:11px;margin-top:7px}.trackbar{height:4px;background:#2d343e;border-radius:999px;overflow:hidden;margin-top:14px}.trackbar i{display:block;height:100%;width:0;background:#1ed760;border-radius:999px}.controls{display:grid;grid-template-columns:54px 1fr 54px;gap:9px;margin-top:13px}.btn,button{border:0;border-radius:15px;background:#252c35;color:#fff;font-weight:900;font-size:15px;padding:13px;cursor:pointer}.primary{background:#1ed760;color:#07110a}.volume{display:grid;grid-template-columns:auto 1fr auto;gap:9px;align-items:center;margin-top:13px;color:#9aa5b3;font-size:12px}input[type=range]{width:100%;accent-color:#1ed760}.searchCard{margin-top:14px;padding:14px}.searchTitle{font-size:17px;font-weight:950;margin-bottom:10px}.searchbox{display:grid;grid-template-columns:1fr auto;gap:8px}.searchbox input{min-width:0;border:1px solid rgba(255,255,255,.08);background:#0d1116;color:#fff;border-radius:15px;padding:14px;font-size:15px;outline:none}.searchbox input:focus{border-color:rgba(30,215,96,.55);box-shadow:0 0 0 3px rgba(30,215,96,.08)}.results{display:grid;gap:8px;margin-top:12px}.result{display:grid;grid-template-columns:58px 1fr auto;gap:10px;align-items:center;padding:8px;border-radius:16px;background:#10151b;border:1px solid rgba(255,255,255,.055)}.result img{width:58px;height:58px;border-radius:11px;object-fit:cover;background:#222}.rmeta{min-width:0}.rname{font-weight:850;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rartist{font-size:12px;color:#8f9baa;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;gap:6px}.icon{width:38px;height:38px;padding:0;border-radius:12px;display:grid;place-items:center}.playi{background:#1ed760;color:#07110a}.queue{background:#252c35}.status{margin-top:10px;padding:10px 12px;border-radius:13px;background:#0c1116;color:#8794a3;font-size:12px}.tools{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.linkbtn{display:block;text-align:center;text-decoration:none;border-radius:14px;padding:11px 12px;background:#171d24;color:#dbe2ea;font-weight:800;font-size:12px;border:1px solid rgba(255,255,255,.06)}.connect{margin-bottom:12px}.connect a{display:block;text-align:center;text-decoration:none;background:#1ed760;color:#07110a;border-radius:14px;padding:13px;font-weight:900}.empty{padding:16px 8px;text-align:center;color:#788493;font-size:13px}.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(30px);opacity:0;background:#1ed760;color:#07110a;font-weight:900;border-radius:999px;padding:10px 16px;transition:.25s;z-index:9}.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}@media(max-width:430px){body{padding:11px}.now{grid-template-columns:78px 1fr}.cover{width:78px;height:78px}.name{font-size:18px}.result{grid-template-columns:52px 1fr auto}.result img{width:52px;height:52px}.queue{display:none}}</style></head><body>',
'<div class="shell"><div class="top"><div class="logo">JS <b>Spotify</b></div><div class="badge">PRISM LIVE CONTROL</div></div><div id="connect" class="connect"></div>',
'<div class="card player"><div class="now"><img id="cover" class="cover" alt=""><div><div class="eyebrow">Ahora suena</div><div id="name" class="name">Sin reproducción</div><div id="artist" class="artist">Abrí Spotify y reproducí una canción.</div><div id="device" class="device">—</div></div></div><div class="trackbar"><i id="progress"></i></div><div class="controls"><button onclick="prev()">⏮</button><button id="play" class="primary" onclick="toggle()">▶ Reproducir</button><button onclick="nxt()">⏭</button></div><div class="volume"><span>🔈</span><input id="vol" type="range" min="0" max="100" value="50"><span id="vnum">50%</span></div><div id="status" class="status">Comprobando Spotify…</div><div class="tools"><a class="linkbtn" href="/spotify-overlay" target="_blank">👁 Ver overlay</a><button class="linkbtn" onclick="copyOverlay()">📋 Copiar URL PRISM</button></div></div>',
'<div class="card searchCard"><div class="searchTitle">🔎 Buscar música</div><div class="searchbox"><input id="q" placeholder="Canción o artista…" autocomplete="off"><button class="primary" onclick="search()">Buscar</button></div><div id="results" class="results"><div class="empty">Buscá una canción y tocá ▶ para reproducirla.</div></div></div></div><div id="toast" class="toast">Listo</div>',
'<script>var KEY='+encodedKey+',state={},timer;function auth(){return {"authorization":"Bearer "+KEY,"content-type":"application/json"}}function esc(s){return String(s||"").replace(/[&<>]/g,function(c){return({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])})}function toast(t){var e=document.getElementById("toast");e.textContent=t;e.classList.add("show");clearTimeout(timer);timer=setTimeout(function(){e.classList.remove("show")},1600)}function fmt(ms){var s=Math.floor((ms||0)/1000);return Math.floor(s/60)+":"+String(s%60).padStart(2,"0")}async function refresh(){try{var r=await fetch("/api/spotify/state",{headers:auth(),cache:"no-store"}),s=await r.json();state=s;var c=document.getElementById("connect");if(!s.configured)c.innerHTML="<div class=\\"status\\">Falta configurar Spotify.</div>";else if(!s.connected)c.innerHTML="<a href=\\"/spotify/login?key="+encodeURIComponent(KEY)+"\\">Conectar Spotify</a>";else c.innerHTML="";if(s.track){document.getElementById("cover").src=s.track.cover||"";document.getElementById("name").textContent=s.track.name||"";document.getElementById("artist").textContent=s.track.artist||"";document.getElementById("progress").style.width=(s.duration_ms?Math.max(0,Math.min(100,s.progress_ms/s.duration_ms*100)):0)+"%"}else{document.getElementById("cover").removeAttribute("src");document.getElementById("name").textContent="Sin reproducción";document.getElementById("artist").textContent=s.connected?"Abrí Spotify una vez si no hay dispositivo activo.":"Conectá tu cuenta de Spotify.";document.getElementById("progress").style.width="0%"}document.getElementById("play").textContent=s.playing?"⏸ Pausar":"▶ Reproducir";if(s.device){document.getElementById("vol").value=s.device.volume_percent;document.getElementById("vnum").textContent=s.device.volume_percent+"%";document.getElementById("device").textContent="📱 "+s.device.name+" · "+s.device.type}else document.getElementById("device").textContent="Sin dispositivo activo";document.getElementById("status").textContent=s.error?"Error: "+s.error:(s.connected?"Spotify conectado":"Spotify sin conectar")}catch(e){document.getElementById("status").textContent="No pude consultar Spotify."}}async function act(action,extra){extra=extra||{};var r=await fetch("/api/spotify/control",{method:"POST",headers:auth(),body:JSON.stringify(Object.assign({action:action},extra))});var d=await r.json().catch(function(){return{}});if(!r.ok||d.ok===false){toast("No se pudo");return false}setTimeout(refresh,350);return true}function toggle(){act(state.playing?"pause":"play")}function prev(){act("previous")}function nxt(){act("next")}var vt;document.getElementById("vol").addEventListener("input",function(e){document.getElementById("vnum").textContent=e.target.value+"%";clearTimeout(vt);vt=setTimeout(function(){act("volume",{volume:Number(e.target.value)})},160)});document.getElementById("q").addEventListener("keydown",function(e){if(e.key==="Enter")search()});async function search(){var q=document.getElementById("q").value.trim(),box=document.getElementById("results");if(!q)return;box.innerHTML="<div class=\\"empty\\">Buscando…</div>";try{var r=await fetch("/api/spotify/search?q="+encodeURIComponent(q),{headers:auth(),cache:"no-store"}),d=await r.json();if(!r.ok)throw 0;var arr=d.results||[];if(!arr.length){box.innerHTML="<div class=\\"empty\\">No encontré resultados.</div>";return}box.innerHTML=arr.map(function(x){return "<div class=\\"result\\"><img src=\\""+esc(x.cover)+"\\" alt=\\"\\"><div class=\\"rmeta\\"><div class=\\"rname\\">"+esc(x.name)+(x.explicit?" 🅴":"")+"</div><div class=\\"rartist\\">"+esc(x.artist)+"</div></div><div class=\\"actions\\"><button class=\\"icon queue\\" onclick=\\"queueTrack(&quot;"+esc(x.uri)+"&quot;)\\">＋</button><button class=\\"icon playi\\" onclick=\\"playTrack(&quot;"+esc(x.uri)+"&quot;)\\">▶</button></div></div>"}).join("")}catch(e){box.innerHTML="<div class=\\"empty\\">No pude buscar ahora.</div>"}}async function playTrack(uri){if(await act("play_track",{uri:uri}))toast("Reproduciendo")}async function queueTrack(uri){if(await act("queue_track",{uri:uri}))toast("Agregada a la cola")}function copyOverlay(){var u=location.origin+"/spotify-overlay";navigator.clipboard&&navigator.clipboard.writeText(u);toast("URL copiada")}refresh();setInterval(refresh,2500);</script></body></html>'
  ].join('');
}

async function control(action, body) {
  if (action === 'play') return spotifyFetch('https://api.spotify.com/v1/me/player/play', { method:'PUT' });
  if (action === 'pause') return spotifyFetch('https://api.spotify.com/v1/me/player/pause', { method:'PUT' });
  if (action === 'next') return spotifyFetch('https://api.spotify.com/v1/me/player/next', { method:'POST' });
  if (action === 'previous') return spotifyFetch('https://api.spotify.com/v1/me/player/previous', { method:'POST' });
  if (action === 'volume') {
    const volume = Math.max(0, Math.min(100, Number(body.volume) || 0));
    return spotifyFetch('https://api.spotify.com/v1/me/player/volume?volume_percent=' + encodeURIComponent(volume), { method:'PUT' });
  }
  if (action === 'play_track') {
    const uri = String(body.uri || '');
    if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) throw new Error('invalid_track_uri');
    return spotifyFetch('https://api.spotify.com/v1/me/player/play', {
      method:'PUT',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ uris:[uri] })
    });
  }
  if (action === 'queue_track') {
    const uri = String(body.uri || '');
    if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) throw new Error('invalid_track_uri');
    return spotifyFetch('https://api.spotify.com/v1/me/player/queue?uri=' + encodeURIComponent(uri), { method:'POST' });
  }
  throw new Error('unknown_spotify_action');
}

async function handle(req, res, u) {
  if (!u.pathname.startsWith('/spotify') && !u.pathname.startsWith('/api/spotify')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin':'*',
      'access-control-allow-headers':'content-type, authorization',
      'access-control-allow-methods':'GET,POST,OPTIONS'
    });
    res.end();
    return true;
  }

  if (req.method === 'GET' && (u.pathname === '/spotify' || u.pathname === '/spotify-overlay')) {
    html(res, overlayPage());
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/spotify-control') {
    const key = String(u.searchParams.get('key') || '');
    if (!((CONTROLLER_KEY && key === CONTROLLER_KEY) || (SPOTIFY_SETUP_KEY && key === SPOTIFY_SETUP_KEY))) {
      sendJson(res, 404, { ok:false, error:'not_found' });
      return true;
    }
    html(res, controlPage(key));
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/spotify/login') {
    const key = String(u.searchParams.get('key') || '');
    if (!((CONTROLLER_KEY && key === CONTROLLER_KEY) || (SPOTIFY_SETUP_KEY && key === SPOTIFY_SETUP_KEY))) {
      sendJson(res, 404, { ok:false, error:'not_found' });
      return true;
    }
    if (!configured()) {
      sendJson(res, 503, { ok:false, error:'spotify_not_configured' });
      return true;
    }
    const state = crypto.randomBytes(18).toString('hex');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = pkceChallenge(verifier);
    authStates.set(state, { key:key, verifier:verifier, expires:Date.now() + 10 * 60 * 1000 });
    const q = new URLSearchParams({
      response_type:'code',
      client_id:CLIENT_ID,
      scope:'user-read-playback-state user-modify-playback-state',
      redirect_uri:REDIRECT_URI,
      state:state,
      code_challenge_method:'S256',
      code_challenge:challenge
    });
    res.writeHead(302, {
      location:'https://accounts.spotify.com/authorize?' + q.toString(),
      'cache-control':'no-store'
    });
    res.end();
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/spotify/callback') {
    const state = String(u.searchParams.get('state') || '');
    const item = authStates.get(state);
    authStates.delete(state);
    if (!item || item.expires < Date.now()) {
      sendJson(res, 400, { ok:false, error:'spotify_state_mismatch' });
      return true;
    }
    if (u.searchParams.get('error')) {
      res.writeHead(302, { location:'/spotify-control?key=' + encodeURIComponent(item.key) });
      res.end();
      return true;
    }
    try {
      await exchangeCode(String(u.searchParams.get('code') || ''), item.verifier);
      res.writeHead(302, {
        location:'/spotify-control?key=' + encodeURIComponent(item.key),
        'cache-control':'no-store'
      });
      res.end();
    } catch (e) {
      sendJson(res, 500, { ok:false, error:String(e && e.message || e) });
    }
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/api/spotify/public-state') {
    sendJson(res, 200, await playbackState());
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/api/spotify/state') {
    if (!authorized(req)) {
      sendJson(res, 401, { ok:false, error:'unauthorized' });
      return true;
    }
    sendJson(res, 200, await playbackState());
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/api/spotify/search') {
    if (!authorized(req)) {
      sendJson(res, 401, { ok:false, error:'unauthorized' });
      return true;
    }
    try {
      const results = await searchTracks(u.searchParams.get('q') || '');
      sendJson(res, 200, { ok:true, results:results });
    } catch (e) {
      sendJson(res, 500, { ok:false, error:String(e && e.message || e) });
    }
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/api/spotify/admin-refresh') {
    if (!setupAuthorized(req)) {
      sendJson(res, 401, { ok:false, error:'unauthorized' });
      return true;
    }
    sendJson(res, 200, { ok:true, refresh_token:String(token.refresh_token || '') });
    return true;
  }

  if (req.method === 'POST' && u.pathname === '/api/spotify/control') {
    if (!authorized(req)) {
      sendJson(res, 401, { ok:false, error:'unauthorized' });
      return true;
    }
    try {
      const body = await readJson(req);
      const r = await control(String(body.action || ''), body);
      if (!r.ok && r.status !== 204) {
        const raw = await r.text().catch(function(){ return ''; });
        throw new Error('spotify_control_' + r.status + (raw ? ': ' + raw.slice(0,180) : ''));
      }
      sendJson(res, 200, { ok:true });
    } catch (e) {
      sendJson(res, 500, { ok:false, error:String(e && e.message || e) });
    }
    return true;
  }

  sendJson(res, 404, { ok:false, error:'not_found' });
  return true;
}

setInterval(function(){
  const now = Date.now();
  for (const pair of authStates) if (pair[1].expires < now) authStates.delete(pair[0]);
}, 60000).unref();

module.exports = { handle:handle };