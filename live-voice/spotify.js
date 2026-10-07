
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CLIENT_ID = String(process.env.SPOTIFY_CLIENT_ID || '');
const REDIRECT_URI = String(process.env.SPOTIFY_REDIRECT_URI || 'https://js-live-voice.onrender.com/spotify/callback');
const CONTROLLER_KEY = String(process.env.CONTROLLER_KEY || '');
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
    (LIVE_TOKEN && auth === 'Bearer ' + LIVE_TOKEN);
}

function configured() {
  return Boolean(CLIENT_ID && REDIRECT_URI);
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({ grant_type:'authorization_code', code:code, redirect_uri:REDIRECT_URI, client_id:CLIENT_ID, code_verifier:verifier });
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method:'POST',
    headers:{
      'content-type':'application/x-www-form-urlencoded'
    },
    body:body,
    signal:AbortSignal.timeout(20000)
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
  const body = new URLSearchParams({ grant_type:'refresh_token', refresh_token:token.refresh_token, client_id:CLIENT_ID });
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method:'POST',
    headers:{
      'content-type':'application/x-www-form-urlencoded'
    },
    body:body,
    signal:AbortSignal.timeout(20000)
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
  const headers = Object.assign({}, options.headers || {}, { authorization:'Bearer ' + t });
  let r = await fetch(url, Object.assign({}, options, { headers:headers, signal:AbortSignal.timeout(15000) }));
  if (r.status === 401 && token.refresh_token) {
    const fresh = await refreshAccessToken();
    headers.authorization = 'Bearer ' + fresh;
    r = await fetch(url, Object.assign({}, options, { headers:headers, signal:AbortSignal.timeout(15000) }));
  }
  return r;
}

function compactPlayback(data) {
  const item = data && data.item;
  const artists = item && Array.isArray(item.artists) ? item.artists.map(function(a){ return a.name; }).filter(Boolean) : [];
  const images = item && item.album && Array.isArray(item.album.images) ? item.album.images : [];
  return {
    configured:configured(),
    connected:Boolean(token.refresh_token || token.access_token),
    active:Boolean(data && data.device),
    playing:Boolean(data && data.is_playing),
    progress_ms:Number(data && data.progress_ms || 0),
    duration_ms:Number(item && item.duration_ms || 0),
    track:item ? {
      id:String(item.id || ''),
      name:String(item.name || ''),
      artist:artists.join(', '),
      album:String(item.album && item.album.name || ''),
      cover:String(images[0] && images[0].url || '')
    } : null,
    device:data && data.device ? {
      name:String(data.device.name || ''),
      type:String(data.device.type || ''),
      volume_percent:Number(data.device.volume_percent == null ? 0 : data.device.volume_percent)
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
    return { configured:configured(), connected:Boolean(token.refresh_token || token.access_token), active:false, playing:false, track:null, error:String(e && e.message || e) };
  }
}

function html(res, body) {
  res.writeHead(200, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', 'referrer-policy':'no-referrer' });
  res.end(body);
}

function overlayPage() {
  return [
'<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JS Spotify Overlay</title>',
'<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}#w{position:absolute;left:4vw;bottom:5vh;width:min(78vw,620px);display:flex;align-items:center;gap:14px;padding:12px 16px 12px 12px;border-radius:22px;background:linear-gradient(120deg,rgba(6,8,12,.92),rgba(20,24,32,.86));box-shadow:0 12px 34px rgba(0,0,0,.42);backdrop-filter:blur(12px);transform:translateY(130%);opacity:0;transition:.45s cubic-bezier(.2,.8,.2,1)}#w.show{transform:translateY(0);opacity:1}#c{width:72px;height:72px;border-radius:14px;object-fit:cover;background:#171a20;flex:0 0 auto}#m{min-width:0;flex:1}#l{font-size:12px;font-weight:800;letter-spacing:.12em;color:#1ed760;text-transform:uppercase;margin-bottom:4px}#t{font-size:20px;font-weight:900;color:white;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#a{font-size:14px;font-weight:650;color:#cbd1dc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}#b{height:4px;background:rgba(255,255,255,.18);border-radius:999px;overflow:hidden;margin-top:9px}#p{height:100%;width:0;background:#1ed760;border-radius:999px;transition:width .8s linear}</style></head><body>',
'<div id="w"><img id="c" alt=""><div id="m"><div id="l">Spotify · Ahora suena</div><div id="t">—</div><div id="a">—</div><div id="b"><div id="p"></div></div></div></div>',
'<script>var w=document.getElementById("w"),c=document.getElementById("c"),t=document.getElementById("t"),a=document.getElementById("a"),p=document.getElementById("p");async function tick(){try{var r=await fetch("/api/spotify/public-state",{cache:"no-store"}),s=await r.json();if(s&&s.track){c.src=s.track.cover||"";t.textContent=s.track.name||"";a.textContent=s.track.artist||"";p.style.width=(s.duration_ms?Math.max(0,Math.min(100,s.progress_ms/s.duration_ms*100)):0)+"%";w.classList.add("show")}else w.classList.remove("show")}catch(e){}}tick();setInterval(tick,2200);</script></body></html>'
  ].join('');
}

function controlPage(key) {
  const encodedKey = JSON.stringify(String(key || ''));
  return [
'<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JS Spotify</title>',
'<style>*{box-sizing:border-box}body{margin:0;background:#0c0f14;color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:18px}.card{max-width:650px;margin:auto;background:#151a22;border:1px solid #2b3442;border-radius:24px;padding:18px;box-shadow:0 18px 45px rgba(0,0,0,.32)}h1{font-size:24px;margin:0 0 6px}.sub{color:#9da8b8;font-size:14px;margin-bottom:18px}.now{display:flex;gap:14px;align-items:center;background:#0d1118;border-radius:18px;padding:12px;margin:14px 0}#cover{width:86px;height:86px;border-radius:15px;object-fit:cover;background:#222}.meta{min-width:0}.name{font-size:19px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.artist{color:#aeb8c7;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}button,a.btn{border:0;border-radius:14px;padding:13px 16px;font-weight:850;font-size:15px;text-decoration:none;text-align:center;cursor:pointer}button{background:#252d39;color:#fff}button.primary,a.btn{background:#1ed760;color:#07120a}.wide{flex:1}.status{margin-top:14px;padding:11px 13px;border-radius:14px;background:#0d1118;color:#b8c2d0;font-size:13px}input[type=range]{width:100%;margin-top:12px}.note{font-size:12px;line-height:1.45;color:#8390a2;margin-top:14px}</style></head><body>',
'<div class="card"><h1>🎵 JS Spotify</h1><div class="sub">Control de tu Spotify Premium + overlay visual para PRISM</div><div id="connect"></div><div class="now"><img id="cover" alt=""><div class="meta"><div id="name" class="name">Sin reproducción</div><div id="artist" class="artist">Abrí Spotify y reproducí una canción.</div></div></div><div class="row"><button onclick="prev()">⏮</button><button id="play" class="primary wide" onclick="toggle()">▶ Reproducir</button><button onclick="nxt()">⏭</button></div><div style="margin-top:14px">Volumen</div><input id="vol" type="range" min="0" max="100" value="50"><div id="status" class="status">Comprobando Spotify…</div><div class="note">Esta integración controla tu reproducción y muestra la canción. No retransmite el audio de Spotify dentro del LIVE.</div></div>',
'<script>var KEY='+encodedKey+',state={};function auth(){return {"authorization":"Bearer "+KEY,"content-type":"application/json"}}async function refresh(){try{var r=await fetch("/api/spotify/state",{headers:auth(),cache:"no-store"}),s=await r.json();state=s;var x=document.getElementById("connect");if(!s.configured)x.innerHTML="<div class=\\"status\\">Falta configurar Spotify en el servidor.</div>";else if(!s.connected)x.innerHTML="<a class=\\"btn\\" href=\\"/spotify/login?key="+encodeURIComponent(KEY)+"\\">Conectar Spotify</a>";else x.innerHTML="";if(s.track){document.getElementById("cover").src=s.track.cover||"";document.getElementById("name").textContent=s.track.name||"";document.getElementById("artist").textContent=s.track.artist||""}else{document.getElementById("cover").removeAttribute("src");document.getElementById("name").textContent="Sin reproducción";document.getElementById("artist").textContent=s.connected?"Abrí Spotify y reproducí una canción.":"Conectá tu cuenta de Spotify."}document.getElementById("play").textContent=s.playing?"⏸ Pausar":"▶ Reproducir";if(s.device)document.getElementById("vol").value=s.device.volume_percent;document.getElementById("status").textContent=s.error?"Error: "+s.error:(s.device?"Dispositivo: "+s.device.name:(s.connected?"Conectado · sin dispositivo activo":"Spotify sin conectar"))}catch(e){document.getElementById("status").textContent="No pude consultar Spotify."}}async function act(action,extra){extra=extra||{};await fetch("/api/spotify/control",{method:"POST",headers:auth(),body:JSON.stringify(Object.assign({action:action},extra))});setTimeout(refresh,450)}function toggle(){act(state.playing?"pause":"play")}function prev(){act("previous")}function nxt(){act("next")}var vt;document.getElementById("vol").addEventListener("input",function(e){clearTimeout(vt);vt=setTimeout(function(){act("volume",{volume:Number(e.target.value)})},180)});refresh();setInterval(refresh,3000);</script></body></html>'
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
  throw new Error('unknown_spotify_action');
}

async function handle(req, res, u) {
  if (!u.pathname.startsWith('/spotify') && !u.pathname.startsWith('/api/spotify')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin':'*', 'access-control-allow-headers':'content-type, authorization', 'access-control-allow-methods':'GET,POST,OPTIONS' });
    res.end();
    return true;
  }

  if (req.method === 'GET' && (u.pathname === '/spotify' || u.pathname === '/spotify-overlay')) {
    html(res, overlayPage());
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/spotify-control') {
    const key = String(u.searchParams.get('key') || '');
    if (!CONTROLLER_KEY || key !== CONTROLLER_KEY) {
      sendJson(res, 404, { ok:false, error:'not_found' });
      return true;
    }
    html(res, controlPage(key));
    return true;
  }

  if (req.method === 'GET' && u.pathname === '/spotify/login') {
    const key = String(u.searchParams.get('key') || '');
    if (!CONTROLLER_KEY || key !== CONTROLLER_KEY) {
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
    const q = new URLSearchParams({ response_type:'code', client_id:CLIENT_ID, scope:'user-read-playback-state user-modify-playback-state', redirect_uri:REDIRECT_URI, state:state, code_challenge_method:'S256', code_challenge:challenge });
    res.writeHead(302, { location:'https://accounts.spotify.com/authorize?' + q.toString(), 'cache-control':'no-store' });
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
      res.writeHead(302, { location:'/spotify-control?key=' + encodeURIComponent(item.key), 'cache-control':'no-store' });
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