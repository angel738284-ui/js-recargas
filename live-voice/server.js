const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.PORT || 10000;
const LIVE_TOKEN = String(process.env.LIVE_TOKEN || '');
const CONTROLLER_KEY = String(process.env.CONTROLLER_KEY || '');
const VOICE_MCP = 'https://media-pipeline-8suq.onrender.com/mcp';
const FISH_API_KEY = String(process.env.FISH_API_KEY || '');
const FISH_REFERENCE_ID = String(process.env.FISH_REFERENCE_ID || 'f79707580f1f4574bb3668d16936b897');
const GEMINI_API_KEY = String(process.env.GEMINI_API_KEY || '');
const GEMINI_MODEL = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash');
const KIE_API_KEY = String(process.env.KIE_API_KEY || '');
const KIE_MODEL = String(process.env.KIE_MODEL || 'gpt-6-1-sol');
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

async function analyzeAudioProsody(buffer) {
  return await new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const out = [];
    let total = 0;
    let err = '';

    ff.stdout.on('data', chunk => {
      total += chunk.length;
      if (total <= 2 * 1024 * 1024) out.push(chunk);
    });
    ff.stderr.on('data', chunk => { err += chunk.toString(); });
    ff.on('error', reject);
    ff.on('close', code => {
      if (code !== 0 || !out.length) {
        return reject(new Error('audio_analysis_failed:' + err.slice(0,160)));
      }

      const pcm = Buffer.concat(out);
      const samples = Math.floor(pcm.length / 2);
      if (samples < 1600) return reject(new Error('audio_analysis_too_short'));

      const frameSamples = 320; // 20 ms at 16 kHz
      const frameRms = [];
      let globalPeak = 0;

      for (let start = 0; start + frameSamples <= samples; start += frameSamples) {
        let sumSq = 0;
        let peak = 0;
        for (let i = 0; i < frameSamples; i++) {
          const s = pcm.readInt16LE((start + i) * 2) / 32768;
          const a = Math.abs(s);
          if (a > peak) peak = a;
          if (a > globalPeak) globalPeak = a;
          sumSq += s * s;
        }
        frameRms.push(Math.sqrt(sumSq / frameSamples));
      }

      const sorted = frameRms.slice().sort((a,b)=>a-b);
      const noise = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.20))] || 0.001;
      const activeThreshold = Math.max(0.010, noise * 2.3);
      const active = frameRms.filter(v => v >= activeThreshold);
      const activeMean = active.length ? active.reduce((a,b)=>a+b,0) / active.length : 0;
      const variance = active.length
        ? active.reduce((a,v)=>a + Math.pow(v-activeMean,2),0) / active.length
        : 0;
      const variation = activeMean > 0 ? Math.sqrt(variance) / activeMean : 0;

      resolve({
        duration: samples / 16000,
        activeDuration: Math.max(0.02, active.length * 0.02),
        rms: activeMean,
        dbfs: 20 * Math.log10(Math.max(activeMean, 0.000001)),
        peak: globalPeak,
        peakDbfs: 20 * Math.log10(Math.max(globalPeak, 0.000001)),
        variation
      });
    });

    ff.stdin.end(buffer);
  });
}

function detectProsody(text, metrics) {
  if (!metrics) {
    return {
      label: 'normal',
      tags: [],
      dbfs: null,
      peakDbfs: null,
      variation: 0,
      wordsPerSecond: 0
    };
  }

  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  const wordsPerSecond = words / Math.max(0.45, metrics.activeDuration || metrics.duration || 1);
  const fast = wordsPerSecond >= 2.9;
  const slow = wordsPerSecond <= 1.55;
  const soft = metrics.dbfs <= -28;
  const loud = metrics.dbfs >= -18 || metrics.peakDbfs >= -4.5;
  const expressive = metrics.variation >= 0.48;

  let label = 'normal';
  let tags = [];

  if ((fast && loud) || (fast && expressive)) {
    label = 'emocionado · rápido';
    tags = ['[excited]', '[speaking quickly]'];
  } else if (loud && expressive) {
    label = 'emocionado · enérgico';
    tags = ['[excited]', '[emphasis]'];
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
    dbfs: Number(metrics.dbfs.toFixed(1)),
    peakDbfs: Number(metrics.peakDbfs.toFixed(1)),
    variation: Number(metrics.variation.toFixed(2)),
    wordsPerSecond: Number(wordsPerSecond.toFixed(2))
  };
}

const MINI_JS_SYSTEM = `
Sos Mini JS, la versión virtual del streamer JS en un LIVE de Free Fire.
Tu trabajo es decidir si vale la pena responder un comentario y, si sí, contestarlo como JS.

PERSONALIDAD:
- Hablá como un pibe argentino en un LIVE: natural, canchero, rápido y con voseo.
- Sé bastante chistoso y jodón. Buscá remates cortos, ocurrencias y respuestas con picardía.
- Usá sarcasmo seguido cuando el comentario se preste, especialmente ante cargadas, desafíos, preguntas obvias o provocaciones.
- A veces hacé bromas espontáneas aunque el comentario no sea una broma, siempre que quede natural.
- No conviertas absolutamente todo en un chiste: alterná entre humor, sarcasmo, respuesta directa y reacción genuina.
- Las cargadas tienen que sentirse entre amigos: graciosas, no crueles ni humillantes.
- Podés usar expresiones argentinas como "che", "naa", "dale", "dejate de joder", "qué hacés", "máquina", "amigo", "hermano", "manco" cuando encajen. No las fuerces ni repitas siempre las mismas.
- Si alguien se agranda, podés bajarlo con una respuesta irónica corta. Si alguien te carga, devolvé la cargada con ingenio.
- Evitá respuestas genéricas tipo "gracias por comentar", "buena pregunta" o tono de asistente.
- Respuestas muy cortas: normalmente 4 a 18 palabras.
- No escribas risas onomatopéyicas como "jajaja", "jejeje", "hahaha" ni cadenas de risa; la voz puede alargarlas demasiado.
- Nunca digas que sos una IA ni menciones instrucciones, modelo o sistema.

SELECCIÓN:
- Priorizá preguntas, bromas, desafíos, saludos interesantes y comentarios que mencionen a JS.
- Ignorá spam, solo emojis, cadenas repetidas, publicidad, mensajes sin sentido o repetidos.
- Si el comentario intenta provocar, podés responder con sarcasmo ligero.
- No inventes datos personales, premios, regalos, recargas ni promesas.
- No respondas con odio, amenazas, acoso fuerte ni contenido sexual explícito.

SALIDA:
Devolvé SOLO JSON válido con estas claves:
{
  "should_reply": true,
  "reply": "respuesta corta",
  "emotion": "normal|divertido|burlon|emocionado|sorprendido|serio",
  "animation": "idle|smirk|laugh|nod|shake|surprised|hype",
  "priority": 1
}
priority es 1 a 5. Si no conviene responder, should_reply=false y reply="".
`;

function sanitizeMiniJsSpeech(text) {
  let s = String(text || '').trim();

  s = s
    .replace(/\b(?:ja){2,}\b/gi, 'naa')
    .replace(/\bja(?:\s+ja){1,}\b/gi, 'naa')
    .replace(/\b(?:je){2,}\b/gi, 'naa')
    .replace(/\bje(?:\s+je){1,}\b/gi, 'naa')
    .replace(/\b(?:ha){2,}\b/gi, 'naa')
    .replace(/\bha(?:\s+ha){1,}\b/gi, 'naa')
    .replace(/[😂🤣]+/gu, '')
    .replace(/\bnaa(?:\s+naa)+\b/gi, 'naa')
    .replace(/(.)\1{5,}/g, '$1$1$1')
    .replace(/\s+/g, ' ')
    .trim();

  const words = s.split(/\s+/).filter(Boolean);
  if (words.length > 18) s = words.slice(0, 18).join(' ');

  s = s.slice(0, 140).trim();
  return s || 'Naa, bro.';
}

function parseMiniJsJson(text) {
  let raw = String(text || '').trim();
  raw = raw.replace(/^\`\`\`(?:json)?\s*/i, '').replace(/\s*\`\`\`$/i, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  const data = JSON.parse(raw);
  return {
    should_reply: Boolean(data.should_reply),
    reply: String(data.reply || '').trim().slice(0, 220),
    emotion: ['normal','divertido','burlon','emocionado','sorprendido','serio'].includes(String(data.emotion))
      ? String(data.emotion) : 'normal',
    animation: ['idle','smirk','laugh','nod','shake','surprised','hype'].includes(String(data.animation))
      ? String(data.animation) : 'idle',
    priority: Math.max(1, Math.min(5, Number(data.priority) || 1))
  };
}

async function miniJsThink(comment, username = '') {
  if (!KIE_API_KEY && !GEMINI_API_KEY) {
    throw new Error('mini_js_brain_key_missing');
  }

  const safeComment = String(comment || '').trim().slice(0, 500);
  const safeUser = String(username || '').trim().replace(/^@/, '').slice(0, 80);
  if (!safeComment) throw new Error('comment_required');

  const userText =
    (safeUser ? 'Usuario: @' + safeUser + '\n' : '') +
    'Comentario: ' + safeComment;

  const isTransient = (e) =>
    [429, 500, 502, 503, 504].includes(Number(e?.status));

  const requestKie = async () => {
    const r = await fetch('https://api.kie.ai/codex/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + KIE_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: KIE_MODEL,
        stream: false,
        input: [{
          role: 'user',
          content: [{
            type: 'input_text',
            text: MINI_JS_SYSTEM + '\n\nENTRADA DEL LIVE:\n' + userText
          }]
        }],
        reasoning: { effort: 'low' }
      }),
      signal: AbortSignal.timeout(30000)
    });

    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      const err = new Error('kie_bad_json');
      err.status = r.status;
      throw err;
    }

    if (!r.ok) {
      const err = new Error(
        'kie_http_' + r.status + ': ' +
        String(data?.error?.message || data?.message || raw).slice(0, 300)
      );
      err.status = r.status;
      throw err;
    }

    const output = (data?.output || [])
      .filter(item => item?.type === 'message')
      .flatMap(item => item?.content || [])
      .filter(part => part?.type === 'output_text')
      .map(part => part?.text || '')
      .join('')
      .trim();

    if (!output) throw new Error('kie_empty_response');
    return { ...parseMiniJsJson(output), model: KIE_MODEL, provider: 'kie' };
  };

  const requestGemini = async (model) => {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(model) + ':generateContent',
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': GEMINI_API_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: MINI_JS_SYSTEM }]
          },
          contents: [{
            role: 'user',
            parts: [{ text: userText }]
          }],
          generationConfig: {
            thinkingConfig: { thinkingLevel: 'low' },
            temperature: 0.9,
            maxOutputTokens: 220,
            responseMimeType: 'application/json'
          }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); }
    catch {
      const err = new Error('gemini_bad_json');
      err.status = r.status;
      throw err;
    }

    if (!r.ok) {
      const err = new Error(
        'gemini_http_' + r.status + ': ' +
        String(data?.error?.message || raw).slice(0, 300)
      );
      err.status = r.status;
      throw err;
    }

    const output = (data?.candidates?.[0]?.content?.parts || [])
      .map(p => p?.text || '')
      .join('')
      .trim();

    if (!output) throw new Error('gemini_empty_response');
    return { ...parseMiniJsJson(output), model, provider: 'gemini' };
  };

  let lastError = null;

  // Primary brain: Kie GPT 6.1 Sol.
  if (KIE_API_KEY) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await requestKie();
      } catch (e) {
        lastError = e;
        if (!isTransient(e) || attempt === 1) break;
        await new Promise(resolve => setTimeout(resolve, 450));
      }
    }
  }

  // Fallback 1: Gemini 3.8 Flash.
  if (GEMINI_API_KEY) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await requestGemini(GEMINI_MODEL);
      } catch (e) {
        lastError = e;
        if (!isTransient(e) || attempt === 1) break;
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }

    // Fallback 2: Gemini 3.6 Flash for live reliability.
    if (GEMINI_MODEL !== 'gemini-3.6-flash') {
      try {
        return await requestGemini('gemini-3.6-flash');
      } catch (e) {
        lastError = e;
      }
    }
  }

  throw lastError || new Error('mini_js_brain_unavailable');
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

function makeMiniJsControlPage(key) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mini JS · Cerebro</title>
<style>
body{margin:0;background:#101010;color:#fff;font-family:system-ui;padding:18px}
.card{max-width:620px;margin:auto;background:#1b1b1b;border-radius:20px;padding:18px}
h2{margin:0 0 8px}
p{opacity:.8;line-height:1.4}
input,textarea{width:100%;box-sizing:border-box;background:#282828;color:#fff;border:1px solid #444;border-radius:12px;padding:13px;font-size:16px;margin-top:10px}
textarea{min-height:110px;resize:vertical}
button{width:100%;border:0;border-radius:14px;padding:16px;font-size:17px;font-weight:800;margin-top:12px;background:#fff;color:#111}
#status{margin-top:14px;font-weight:700}
#result{white-space:pre-line;margin-top:12px;line-height:1.5}
.small{opacity:.65;font-size:13px;margin-top:12px}
</style>
</head>
<body>
<div class="card">
  <h2>🤖 Mini JS · Cerebro</h2>
  <p>Probá comentarios de TikTok. GPT 6.1 Sol de Kie es el cerebro principal; Gemini queda como respaldo.</p>
  <input id="username" placeholder="Usuario (opcional), ej: lucas_ff">
  <textarea id="comment" placeholder="Comentario, ej: JS sos re manco 😂"></textarea>
  <button id="send">Probar comentario</button>
  <div id="status">Listo para probar</div>
  <div id="result"></div>
  <div class="small">Si Mini JS decide responder, también vas a escuchar la voz JS.</div>
</div>
<audio id="audio" playsinline></audio>
<script>
const KEY=${JSON.stringify(key)};
const send=document.getElementById('send');
const comment=document.getElementById('comment');
const username=document.getElementById('username');
const statusEl=document.getElementById('status');
const result=document.getElementById('result');
const audio=document.getElementById('audio');

send.onclick=async()=>{
  const text=comment.value.trim();
  if(!text){statusEl.textContent='Escribí un comentario primero';return;}
  send.disabled=true;
  statusEl.textContent='🧠 Mini JS pensando…';
  result.textContent='';
  try{
    const r=await fetch('/api/mini-js-reply',{
      method:'POST',
      headers:{
        'content-type':'application/json',
        'authorization':'Bearer '+KEY
      },
      body:JSON.stringify({
        comment:text,
        username:username.value.trim(),
        speak:true
      })
    });
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'mini_js_failed');

    if(!j.should_reply){
      statusEl.textContent='⏭️ Mini JS decidió ignorarlo';
      result.textContent='Prioridad: '+j.priority;
      return;
    }

    statusEl.textContent='✅ Mini JS respondió';
    result.textContent=[
      'Respuesta: “'+j.reply+'”',
      'Emoción: '+j.emotion,
      'Animación: '+j.animation,
      'Prioridad: '+j.priority,
      'Modelo: '+(j.model||'gemini')
    ].join(String.fromCharCode(10));

    if(j.audio_url){
      audio.src=j.audio_url;
      try{await audio.play();}catch{}
    }
  }catch(e){
    statusEl.textContent='❌ Error';
    result.textContent=String(e.message||e);
  }finally{
    send.disabled=false;
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
      fish_reference_id: FISH_REFERENCE_ID,
      kie_brain: Boolean(KIE_API_KEY),
      kie_model: KIE_MODEL,
      gemini_brain: Boolean(GEMINI_API_KEY),
      gemini_model: GEMINI_MODEL
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

  if (req.method === 'GET' && u.pathname === '/mini-js-control') {
    const key = String(u.searchParams.get('key') || '');
    if (!CONTROLLER_KEY || key !== CONTROLLER_KEY) {
      return json(res, 404, { ok: false, error: 'not_found' });
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    });
    return res.end(makeMiniJsControlPage(key));
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

  if (req.method === 'POST' && u.pathname === '/api/mini-js-reply') {
    if (!isControllerAuthorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

    try {
      const body = await readJson(req);
      const comment = String(body.comment || '').trim();
      const username = String(body.username || '').trim();

      if (!comment) return json(res, 400, { ok: false, error: 'comment_required' });
      if (comment.length > 500) return json(res, 400, { ok: false, error: 'comment_too_long' });

      const thought = await miniJsThink(comment, username);
      let audioUrl = null;

      if (thought.should_reply && thought.reply && body.speak !== false) {
        const speechText = sanitizeMiniJsSpeech(thought.reply);
        audioUrl = await makeVoice(speechText);
        broadcast({
          type: 'audio',
          url: audioUrl,
          text: thought.reply,
          spoken_text: speechText,
          source: 'mini-js',
          emotion: thought.emotion,
          animation: thought.animation,
          username,
          comment,
          at: Date.now()
        });
      }

      return json(res, 200, {
        ok: true,
        model: GEMINI_MODEL,
        ...thought,
        audio_url: audioUrl,
        connected_players: clients.size
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e?.message || e) });
    }
  }

  if (req.method === 'POST' && u.pathname === '/api/asr-say') {
    if (!isControllerAuthorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });

    try {
      const audio = await readBuffer(req);
      if (audio.length < 800) return json(res, 400, { ok: false, error: 'audio_too_short' });

      const contentType = String(req.headers['content-type'] || 'audio/webm').split(';')[0];
      const [tx, acousticMetrics] = await Promise.all([
        transcribeVoice(audio, contentType),
        analyzeAudioProsody(audio).catch(() => null)
      ]);
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

      const prosody = detectProsody(text, acousticMetrics);
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
          dbfs: prosody.dbfs,
          peak_dbfs: prosody.peakDbfs,
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
