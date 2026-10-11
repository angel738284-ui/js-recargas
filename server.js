import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { Server as SocketServer } from 'socket.io';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import accountRouter from './accounts.js';
import directCallRouter,{configureDirectRooms,directRoomAllowed} from './direct-calls.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express(), httpServer = http.createServer(app);
const io = new SocketServer(httpServer, {cors:{origin:false}});
const rooms = new Map(), LIMIT = 12, TWO_HOURS = 7200000;
const url = process.env.LIVEKIT_URL || '';
const ready = Boolean(url && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
const voice = ready ? new RoomServiceClient(url.replace(/^wss:/,'https:').replace(/^ws:/,'http:'),process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET) : null;
const clean = s => String(s||'').trim().slice(0,24).replace(/[<>]/g,'') || 'Invitado';
const AVATARS=new Set(['🎮','🥷','🔥','💎','🐉','🐺','🎧','🌸','👑','🦊','⚡','🐼','🦅','💜']);
const avatarFor=v=>AVATARS.has(v)?v:'🎮';
const CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rid=()=>{
  let id;
  do { id=Array.from(randomBytes(8), n=>CODE_CHARS[n % CODE_CHARS.length]).join(''); }
  while(rooms.has(id));
  return id;
};
const mode = v => ['open','password','private'].includes(v)?v:'open';
const hashPassword = (password,salt) => scryptSync(password,salt,32);
const verifyPassword = (room,candidate) => {
  if(!room.passwordHash||!room.passwordSalt||typeof candidate!=='string')return false;
  if(candidate.length>64)return false;
  return timingSafeEqual(hashPassword(candidate,room.passwordSalt),room.passwordHash);
};
const info = r => ({id:r.id,name:r.name,mode:r.mode,locked:r.locked,
  listed:r.listed, passwordProtected:r.mode==='password',count:r.users.size,capacity:LIMIT});
const publicRoom = r=>({...info(r),createdAt:r.createdAt});

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression({threshold:1024}));
app.use(express.json({limit:'14kb'}));
app.use('/api/account',accountRouter);
app.use('/api/direct',directCallRouter);
app.get('/.well-known/assetlinks.json',(_req,res)=>{
  res.type('application/json');
  res.set('Cache-Control','public, max-age=3600');
  res.sendFile(path.join(root,'public/.well-known/assetlinks.json'));
});
app.use(express.static(path.join(root,'public'),{maxAge:'10m',setHeaders:(res,p)=>{if(p.endsWith('index.html'))res.setHeader('Cache-Control','no-cache')}}));
app.get('/vendor/livekit.min.js',(_q,res)=>res.sendFile(path.join(root,'node_modules/livekit-client/dist/livekit-client.umd.js'),{maxAge:'7d'}));
app.get('/health',(_q,res)=>res.json({ok:true,voiceConfigured:ready,activeRooms:rooms.size}));
app.get('/s/:id',(_q,res)=>res.sendFile(path.join(root,'public/index.html')));
app.get('/api/rooms',(req,res)=>{
  res.set('Cache-Control','no-store');
  const now=Date.now();
  const visible=[...rooms.values()].filter(r=>r.listed && (r.users.size>0 || now-r.createdAt<600000))
    .sort((a,b)=>b.createdAt-a.createdAt).slice(0,50).map(publicRoom);
  res.json({rooms:visible});
});
app.get('/api/rooms/:id',(req,res)=>{
  const r=rooms.get(req.params.id);
  if(!r) return res.status(404).json({error:'Sala no encontrada'});
  res.json({...info(r),voiceConfigured:ready});
});
app.post('/api/rooms',(req,res)=>{
  const access=mode(req.body?.mode);
  const password=req.body?.password;
  if(access==='password' && (typeof password!=='string'||password.length<6||password.length>64))
    return res.status(400).json({error:'La contraseña debe tener entre 6 y 64 caracteres'});
  const id=rid(), hostKey=randomBytes(32).toString('base64url'), now=Date.now();
  const salt=access==='password'?randomBytes(16):null;
  const r={id,name:clean(req.body?.roomName || 'Sala de amigos'),mode:access,
    hostKey,locked:false,listed:req.body?.listed===undefined?access!=='private':req.body.listed===true,
    passwordSalt:salt,passwordHash:salt?hashPassword(password,salt):null,
    users:new Map(),waiting:new Map(),last:now,createdAt:now,prepared:false,preparing:null};
  rooms.set(id,r);
  res.status(201).json({...info(r),hostKey,invite:`${req.protocol}://${req.get('host')}/s/${id}`});
});
configureDirectRooms(({caller,recipient,calleeName})=>{
  const id=rid(),hostKey=randomBytes(32).toString('base64url'),now=Date.now();
  const r={id,name:clean('Llamada con '+calleeName),mode:'open',hostKey,locked:false,listed:false,
    directCaller:caller,directRecipient:recipient,users:new Map(),waiting:new Map(),last:now,
    createdAt:now,prepared:false,preparing:null};
  rooms.set(id,r);
  return {id,hostKey};
});
function publish(r){
  r.last=Date.now();
  io.to(r.id).emit('room-state',{...info(r),members:[...r.users.entries()].map(([sid,u])=>({socketId:sid,name:u.name,identity:u.identity,host:u.host,moderatorMuted:Boolean(u.moderatorMuted),avatar:u.avatar||'🎮'}))});
  for(const [sid,u] of r.users) if(u.host)
    io.to(sid).emit('waiting-state',[...r.waiting.entries()].map(([socketId,p])=>({socketId,name:p.name})));
}
async function prepare(r){
  if(r.prepared)return;
  if(!r.preparing) r.preparing=voice.createRoom({name:'jsvoice-'+r.id,maxParticipants:LIMIT,emptyTimeout:300})
    .then(()=>{r.prepared=true}).finally(()=>{r.preparing=null});
  await r.preparing;
}
async function admit(r,s,name,host=false,avatar='🎮'){
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
    r.users.set(s.id,{identity,name,host,moderatorMuted:false,avatar:avatarFor(avatar)});
    s.data.room=r.id;s.data.role=host?'host':'guest';s.join(r.id);
    s.emit('join-approved',{token:jwt,livekitUrl:url,identity,name,host});
    publish(r);
  }catch(e){console.error('LiveKit:',e?.message);s.emit('join-error','No se pudo conectar al servidor de voz');}
}
io.on('connection',s=>{
  s.on('join-room',async({roomId,name,hostKey,password,avatar,accountSession}={})=>{
    if(s.data.room)return s.emit('join-error','Ya estás en una sala');
    const r=rooms.get(String(roomId||''));
    if(!r)return s.emit('join-error','La sala ya no existe');
    if(r.directCaller){
      let allowed=false;
      try{allowed=await directRoomAllowed(r,accountSession)}catch(e){console.error('Access check failed:',e.message)}
      if(!allowed)return s.emit('join-error','Debés aceptar la llamada con tu cuenta de Google');
    }
    const owner=Boolean(hostKey&&hostKey===r.hostKey);
    if(r.locked&&!owner)return s.emit('join-error','La sala está bloqueada');
    if(r.users.size>=LIMIT)return s.emit('join-error','La sala está llena');
    if(r.mode==='password'&&!owner){
      const now=Date.now();
      if(!s.data.passwordWindow || now-s.data.passwordWindow>60000){
        s.data.passwordWindow=now;s.data.passwordAttempts=0;
      }
      if(s.data.passwordAttempts>=6)return s.emit('join-error','Demasiados intentos. Probá más tarde.');
      if(!verifyPassword(r,password)){
        s.data.passwordAttempts++;
        return s.emit('join-error','Contraseña incorrecta');
      }
      s.data.passwordAttempts=0;
    }
    if(r.mode==='private'&&!owner){
      if(r.waiting.size>=20)return s.emit('join-error','Demasiadas solicitudes');
      r.waiting.set(s.id,{name:clean(name),avatar:avatarFor(avatar)});s.data.room=r.id;s.data.role='waiting';s.join(r.id);
      s.emit('join-pending');publish(r);return;
    }
    await admit(r,s,clean(name),owner,avatarFor(avatar));
  });
  s.on('waiting-decision',async({socketId,approved}={})=>{
    if(s.data.role!=='host')return;
    const r=rooms.get(s.data.room),p=r?.waiting.get(socketId),target=io.sockets.sockets.get(socketId);
    if(!p||!target)return;
    if(!approved){r.waiting.delete(socketId);target.emit('join-error','Solicitud rechazada');target.disconnect(true);publish(r);return;}
    target.data.role=null;await admit(r,target,p.name,false,p.avatar);publish(r);
  });
  s.on('set-mode',v=>{
    if(s.data.role!=='host')return;
    const r=rooms.get(s.data.room);
    if(!r)return;
    const next=mode(v);
    if(next==='password'&&!r.passwordHash)return s.emit('room-settings-error','Primero configurá una contraseña');
    r.mode=next;publish(r);
  });
  s.on('set-listed',listed=>{
    if(s.data.role!=='host'||typeof listed!=='boolean')return;
    const r=rooms.get(s.data.room);
    if(r){r.listed=listed;publish(r)}
  });
  s.on('set-password',pass=>{
    if(s.data.role!=='host')return;
    const r=rooms.get(s.data.room);
    if(!r)return;
    if(typeof pass!=='string'||pass.length<6||pass.length>64)
      return s.emit('room-settings-error','Contraseña de 6 a 64 caracteres');
    const salt=randomBytes(16);
    r.passwordHash=hashPassword(pass,salt);r.passwordSalt=salt;
    r.mode='password';publish(r);
  });
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
