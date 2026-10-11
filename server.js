import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { Server as SocketServer } from 'socket.io';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express(), httpServer = http.createServer(app);
const io = new SocketServer(httpServer, {cors:{origin:false}});
const rooms = new Map(), LIMIT = 12, TWO_HOURS = 7200000;
const url = process.env.LIVEKIT_URL || '';
const ready = Boolean(url && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
const voice = ready ? new RoomServiceClient(url.replace(/^wss:/,'https:').replace(/^ws:/,'http:'),process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET) : null;
const clean = s => String(s||'').trim().slice(0,24).replace(/[<>]/g,'') || 'Invitado';
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rid=()=>{
  let id;
  do { id=Array.from(randomBytes(8), n=>CODE_CHARS[n % CODE_CHARS.length]).join(''); }
  while(rooms.has(id));
  return id;
};
const mode = v => v==='private'?'private':'open';
const info = r => ({id:r.id,name:r.name,mode:r.mode,locked:r.locked,count:r.users.size,capacity:LIMIT});
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression({threshold:1024}));
app.use(express.json({limit:'8kb'}));
app.get('/.well-known/assetlinks.json',(_req,res)=>{
  res.type('application/json');
  res.set('Cache-Control','public, max-age=3600');
  res.sendFile(path.join(root,'public/.well-known/assetlinks.json'));
});
app.use(express.static(path.join(root,'public'),{maxAge:'10m',setHeaders:(res,p)=>{if(p.endsWith('index.html'))res.setHeader('Cache-Control','no-cache')}}));
app.get('/vendor/livekit.min.js',(_q,res)=>res.sendFile(path.join(root,'node_modules/livekit-client/dist/livekit-client.umd.js'),{maxAge:'7d'}));
app.get('/health',(_q,res)=>res.json({ok:true,voiceConfigured:ready,activeRooms:rooms.size}));
app.get('/s/:id',(_q,res)=>res.sendFile(path.join(root,'public/index.html')));
app.get('/api/rooms/:id',(req,res)=>{
  const r=rooms.get(req.params.id);
  if(!r) return res.status(404).json({error:'Sala no encontrada'});
  res.json({...info(r),voiceConfigured:ready});
});
app.post('/api/rooms',(req,res)=>{
  const id=rid(), hostKey=randomBytes(32).toString('base64url');
  const r={id,name:clean(req.body?.roomName || 'Sala de amigos'),mode:mode(req.body?.mode),
    hostKey,locked:false,users:new Map(),waiting:new Map(),last:Date.now(),prepared:false,preparing:null};
  rooms.set(id,r);
  res.status(201).json({...info(r),hostKey,invite:`${req.protocol}://${req.get('host')}/s/${id}`});
});
function publish(r){
  r.last=Date.now();
  io.to(r.id).emit('room-state',{...info(r),members:[...r.users.entries()].map(([sid,u])=>({socketId:sid,name:u.name,identity:u.identity,host:u.host,moderatorMuted:Boolean(u.moderatorMuted)}))});
  for(const [sid,u] of r.users) if(u.host)
    io.to(sid).emit('waiting-state',[...r.waiting.entries()].map(([socketId,p])=>({socketId,name:p.name})));
}
async function prepare(r){
  if(r.prepared)return;
  if(!r.preparing) r.preparing=voice.createRoom({name:'jsvoice-'+r.id,maxParticipants:LIMIT,emptyTimeout:300})
    .then(()=>{r.prepared=true}).finally(()=>{r.preparing=null});
  await r.preparing;
}
async function admit(r,s,name,host=false){
  if(r.locked&&!host)return s.emit('join-error','La sala está bloqueada');
  if(r.users.size>=LIMIT)return s.emit('join-error','La sala está llena');
  if(!ready)return s.emit('join-error','Falta configurar el servidor de voz LiveKit');
  try {
    await prepare(r);
    if(rooms.get(r.id)!==r)return s.emit('join-error','La sala finalizó');
    if(!s.connected)return;
    if(r.users.size>=LIMIT)return s.emit('join-error','La sala está llena');
    const identity='u-'+randomUUID();
    const tok=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity,name,ttl:'10m'});
    tok.addGrant({roomJoin:true,room:'jsvoice-'+r.id,canPublish:true,canSubscribe:true,canPublishData:false});
    const jwt=await tok.toJwt();
    r.waiting.delete(s.id);
    r.users.set(s.id,{identity,name,host,moderatorMuted:false});
    s.data.room=r.id;s.data.role=host?'host':'guest';s.join(r.id);
    s.emit('join-approved',{token:jwt,livekitUrl:url,identity,name,host});
    publish(r);
  }catch(e){console.error('LiveKit:',e?.message);s.emit('join-error','No se pudo conectar al servidor de voz');}
}
io.on('connection',s=>{
  s.on('join-room',async({roomId,name,hostKey}={})=>{
    if(s.data.room)return s.emit('join-error','Ya estás en una sala');
    const r=rooms.get(String(roomId||''));
    if(!r)return s.emit('join-error','La sala ya no existe');
    const owner=Boolean(hostKey&&hostKey===r.hostKey);
    if(r.locked&&!owner)return s.emit('join-error','La sala está bloqueada');
    if(r.users.size>=LIMIT)return s.emit('join-error','La sala está llena');
    if(r.mode==='private'&&!owner){
      if(r.waiting.size>=20)return s.emit('join-error','Demasiadas solicitudes');
      r.waiting.set(s.id,{name:clean(name)});s.data.room=r.id;s.data.role='waiting';s.join(r.id);
      s.emit('join-pending');publish(r);return;
    }
    await admit(r,s,clean(name),owner);
  });
  s.on('waiting-decision',async({socketId,approved}={})=>{
    if(s.data.role!=='host')return;
    const r=rooms.get(s.data.room),p=r?.waiting.get(socketId),target=io.sockets.sockets.get(socketId);
    if(!p||!target)return;
    if(!approved){r.waiting.delete(socketId);target.emit('join-error','Solicitud rechazada');target.disconnect(true);publish(r);return;}
    target.data.role=null;await admit(r,target,p.name);publish(r);
  });
  s.on('set-mode',v=>{if(s.data.role!=='host')return;const r=rooms.get(s.data.room);if(r){r.mode=mode(v);publish(r)}});
  s.on('set-lock',v=>{if(s.data.role!=='host')return;const r=rooms.get(s.data.room);if(r){r.locked=Boolean(v);publish(r)}});
  s.on('kick-user',async sid=>{
    if(s.data.role!=='host'||sid===s.id)return;
    const r=rooms.get(s.data.room),u=r?.users.get(sid),target=io.sockets.sockets.get(sid);
    if(!u||!target)return;
    try{await voice?.removeParticipant('jsvoice-'+r.id,u.identity)}catch(e){console.error(e?.message)}
    target.emit('kicked');target.disconnect(true);r.users.delete(sid);publish(r);
  });
  s.on('host-set-mute',async({socketId,muted}={})=>{
    if(s.data.role!=='host')return;
    const r=rooms.get(s.data.room);
    const target=r?.users.get(String(socketId||''));
    if(!target||target.host||socketId===s.id||typeof muted!=='boolean')return;
    if(target.moderatorMuted===muted)return publish(r);
    try{
      await voice.updateParticipant('jsvoice-'+r.id,target.identity,{
        permission:{canPublish:!muted,canSubscribe:true,canPublishData:false}
      });
      if(rooms.get(r.id)!==r||r.users.get(socketId)!==target)return;
      target.moderatorMuted=muted;
      io.to(socketId).emit('moderator-mute-changed',{muted});
      publish(r);
    }catch(e){console.error('Moderación de audio:',e?.message);s.emit('moderator-mute-error','No se pudo actualizar el micrófono. Reintentá.')}
  });
  s.on('end-room',async()=>{
    if(s.data.role!=='host')return;
    const r=rooms.get(s.data.room);if(!r)return;
    rooms.delete(r.id);io.to(r.id).emit('room-ended');
    if(voice&&r.prepared)try{await voice.deleteRoom('jsvoice-'+r.id)}catch(e){console.error(e?.message)}
    for(const client of await io.in(r.id).fetchSockets())client.disconnect(true);
  });
  s.on('disconnect',()=>{
    const r=rooms.get(s.data.room);if(!r)return;
    r.users.delete(s.id);r.waiting.delete(s.id);publish(r);
  });
});
setInterval(()=>{for(const [id,r] of rooms)if(!r.users.size&&!r.waiting.size&&Date.now()-r.last>TWO_HOURS)rooms.delete(id)},60000).unref();
const port=Number(process.env.PORT||3087);
const bindHost = process.env.HOST || '127.0.0.1';
httpServer.listen(port,bindHost,()=>console.log('JS VOICE en '+bindHost+':'+port+' | voz '+(ready?'configurada':'sin configurar')));
