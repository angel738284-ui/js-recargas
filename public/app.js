(()=>{'use strict';
const $=id=>document.getElementById(id);
const roomId=location.pathname.match(/^\/s\/([\w-]+)$/)?.[1]||null;
const hostStorageKey='jsvoice-host-'+roomId;
let socket=null,liveRoom=null,roomState=null,members=[],myId=null,joined=false,host=false,micOn=false;
let speakers=new Set(),audioTracks=new Map(),volumes=new Map(),personalMutes=new Set(),toastTimer, directoryLoading=false;
const show=name=>['home','lobby','call'].forEach(x=>$(x).classList.toggle('hidden',x!==name));
const toast=message=>{const t=$('toast');t.textContent=message;t.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.add('hidden'),4200)};
const invite=()=>location.origin+'/s/'+roomId;
const prettyCode=code=>code.length===8?code.slice(0,4)+' '+code.slice(4):code;
function setCallAudioSession(active){
  try {
    if('audioSession' in navigator) navigator.audioSession.type=active?'play-and-record':'auto';
  } catch(e){console.debug('AudioSession:',e.message)}
  if(!('mediaSession' in navigator))return;
  try{
    const ms=navigator.mediaSession;
    if(active){
      ms.metadata=new MediaMetadata({title:roomState?.name||'Llamada de voz',artist:'JS VOICE',album:'Llamada grupal'});
      ms.playbackState='playing';
      try{ms.setActionHandler('hangup',()=>leave())}catch{}
      try{ms.setActionHandler('togglemicrophone',()=>toggleMicrophone())}catch{}
    }else{
      ms.playbackState='none';
      ms.metadata=null;
      try{ms.setActionHandler('hangup',null)}catch{}
      try{ms.setActionHandler('togglemicrophone',null)}catch{}
    }
  }catch(e){console.debug('MediaSession:',e.message)}
}
async function toggleMicrophone(){
 if(!liveRoom)return;
 try{await liveRoom.localParticipant.setMicrophoneEnabled(!micOn);micOn=!micOn;updateMic()}
 catch(e){toast('Error al silenciar: '+e.message)}
}
async function api(path,options){const response=await fetch(path,options),json=await response.json();if(!response.ok)throw Error(json.error||'Error de servidor');return json}
function info(){
 if(!roomState)return;
 $('callTitle').textContent=roomState.name;
 $('callMeta').textContent=roomState.count+'/12 conectados · '+(roomState.locked?'Bloqueada':roomState.mode==='private'?'Con aprobación':roomState.mode==='password'?'Con contraseña':'Acceso directo');
 $('modeSelect').value=roomState.mode;$('lockBtn').textContent=roomState.locked?'Desbloquear':'Bloquear';$('listingBtn').textContent=roomState.listed?'Ocultar sala':'Mostrar sala';
 $('codeDisplay').textContent=prettyCode(roomId);
}
function people(){
 const box=$('participants');box.replaceChildren();
 if(!members.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Todavía no hay nadie conectado.';box.append(empty);return}
 for(const p of members){
   const el=document.createElement('div');el.className='participant'+(speakers.has(p.identity)?' talking':'');
   const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=p.name.substring(0,1).toUpperCase();
   const details=document.createElement('div');details.className='participant-info';
   const title=document.createElement('div');title.className='participant-name';title.textContent=p.name+(p.identity===myId?' (vos)':'');
   const meta=document.createElement('div');meta.className='participant-meta';meta.textContent=(p.host?'👑 Admin':'Invitado')+(p.moderatorMuted?' · 🔇 Silenciado para todos':speakers.has(p.identity)?' · Hablando':'');
   details.append(title,meta);el.append(avatar,details);
   if(p.identity!==myId){
     const vol=document.createElement('input');vol.className='vol';vol.type='range';vol.min=0;vol.max=100;vol.value=volumes.get(p.identity)??100;vol.setAttribute('aria-label','Volumen de '+p.name);
     vol.oninput=()=>{const n=Number(vol.value);volumes.set(p.identity,n);const a=audioTracks.get(p.identity);if(a)a.volume=n/100};
     el.append(vol);
     const personal=document.createElement('button');personal.className='kick';
     personal.textContent=personalMutes.has(p.identity)?'🔊 Escuchar':'🔇 Solo para mí';
     personal.onclick=()=>{
       if(personalMutes.has(p.identity))personalMutes.delete(p.identity);else personalMutes.add(p.identity);
       const a=audioTracks.get(p.identity);if(a)a.muted=personalMutes.has(p.identity);
       people();
     };
     el.append(personal);
     if(host){
       const muteAll=document.createElement('button');muteAll.className='kick';
       muteAll.textContent=p.moderatorMuted?'🎤 Habilitar para todos':'🔇 Silenciar para todos';
       muteAll.onclick=()=>{if(confirm('¿'+(p.moderatorMuted?'Habilitar':'Silenciar')+' a '+p.name+' para todos?'))socket?.emit('host-set-mute',{socketId:p.socketId,muted:!p.moderatorMuted})};
       el.append(muteAll);
       const kick=document.createElement('button');kick.className='kick';kick.textContent='Expulsar';kick.onclick=()=>{if(confirm('¿Expulsar a '+p.name+'?'))socket?.emit('kick-user',p.socketId)};el.append(kick)}
   }
   box.append(el);
 }
}
function waitlist(list){
 const box=$('waitingBox'),target=$('waitingList');box.classList.toggle('hidden',!list.length);target.replaceChildren();
 for(const p of list){const row=document.createElement('div');row.className='request';const nm=document.createElement('b');nm.textContent=p.name;
 const buttons=document.createElement('div');
 const yes=document.createElement('button');yes.textContent='Aceptar';yes.onclick=()=>socket?.emit('waiting-decision',{socketId:p.socketId,approved:true});
 const no=document.createElement('button');no.textContent='Rechazar';no.className='reject';no.onclick=()=>socket?.emit('waiting-decision',{socketId:p.socketId,approved:false});
 buttons.append(yes,no);row.append(nm,buttons);target.append(row)}
}
async function leave(){
 joined=false;const oldRoom=liveRoom,oldSocket=socket;liveRoom=null;socket=null;
 setCallAudioSession(false);
 try{await oldRoom?.disconnect()}catch{} oldSocket?.disconnect();
 audioTracks.clear();speakers.clear();personalMutes.clear();micOn=false;myId=null;host=false;members=[];$('remoteAudio').replaceChildren();
 if(roomId)await lobby();else show('home');
}
function attach(track,participant){
 const el=track.attach();el.autoplay=true;el.playsInline=true;el.volume=(volumes.get(participant.identity)??100)/100;el.muted=personalMutes.has(participant.identity);
 audioTracks.set(participant.identity,el);$('remoteAudio').append(el);
}
async function joinVoice(payload){
 myId=payload.identity;host=Boolean(payload.host);$('hostTools').classList.toggle('hidden',!host);
 if(!window.LivekitClient)throw Error('La biblioteca de audio no está disponible');
 const LK=window.LivekitClient;liveRoom=new LK.Room({adaptiveStream:true});
 liveRoom.on(LK.RoomEvent.TrackSubscribed,(track,_pub,person)=>{if(track.kind===LK.Track.Kind.Audio)attach(track,person)});
 liveRoom.on(LK.RoomEvent.TrackUnsubscribed,(track,_pub,person)=>{for(const el of track.detach())el.remove();audioTracks.delete(person.identity)});
 liveRoom.on(LK.RoomEvent.ActiveSpeakersChanged,all=>{speakers=new Set(all.map(x=>x.identity));people()});
 liveRoom.on(LK.RoomEvent.Disconnected,()=>{if(joined){toast('Se cortó la conexión de voz');leave()}});
 await liveRoom.connect(payload.livekitUrl,payload.token);
 joined=true;show('call');info();people();setCallAudioSession(true);
 try{await liveRoom.localParticipant.setMicrophoneEnabled(true);micOn=true}catch{micOn=false;toast('Autorizá el micrófono desde el navegador')}
 updateMic();
 try{await liveRoom.startAudio()}catch{toast('Si no escuchás, tocá Escuchar')}
}
function updateMic(){try{navigator.mediaSession?.setMicrophoneActive?.(micOn)}catch{}
 const b=$('micBtn');b.classList.toggle('active',!micOn);b.querySelector('.control-icon').textContent=micOn?'🎙️':'🔇';b.lastElementChild.textContent=micOn?'Micrófono':'Silenciado'}
async function lobby(){
 show('lobby');$('lobbyMessage').textContent='';$('joinBtn').disabled=false;
 try{roomState=await api('/api/rooms/'+roomId);
   $('lobbyTitle').textContent=roomState.name;
   $('lobbyMode').textContent=roomState.mode==='private'?'✋ CON APROBACIÓN':roomState.mode==='password'?'🔐 CON CONTRASEÑA':'🔗 SALA PÚBLICA';
   $('joinPasswordBox').classList.toggle('hidden',roomState.mode!=='password'||Boolean(localStorage.getItem(hostStorageKey)));
   $('lobbyInfo').textContent=roomState.count+'/12 conectados. '+(roomState.locked?'La sala está bloqueada.':'Escribí tu nombre para entrar.');
   $('joinBtn').disabled=(roomState.locked&&!localStorage.getItem(hostStorageKey))||!roomState.voiceConfigured;
   if(!roomState.voiceConfigured)$('lobbyMessage').textContent='Aún falta configurar LiveKit para activar las llamadas.';
 }catch(e){$('joinBtn').disabled=true;$('lobbyMessage').textContent=e.message}
}
async function create(){
 const button=$('createBtn');button.disabled=true;
 try{const selected=document.querySelector('input[name="mode"]:checked').value;
 const pass=$('createPassword').value;
 if(selected==='password' && (pass.length<6||pass.length>64))throw Error('Elegí una contraseña de 6 a 64 caracteres');
 const r=await api('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({roomName:$('roomName').value,mode:selected,password:selected==='password'?pass:undefined,listed:$('listedRoom').checked})});
 localStorage.setItem('jsvoice-host-'+r.id,r.hostKey);location.assign('/s/'+r.id)}
 catch(e){toast(e.message);button.disabled=false}
}
function requestJoin(){
 const name=$('nickname').value.trim();if(!name)return toast('Escribí tu nombre');
 if(typeof io!=='function'){return toast('No cargó el sistema de conexión. Actualizá la página')}
 if(socket){socket.disconnect();socket=null}
 localStorage.setItem('jsvoice-name',name);$('joinBtn').disabled=true;
 $('lobbyMessage').textContent='Conectando con la sala…';
 let timer=null,step='servidor',done=false;
 const cancelTimer=()=>{if(timer){clearTimeout(timer);timer=null}};
 const fail=(message)=>{if(done)return;cancelTimer();$('lobbyMessage').textContent=message;$('joinBtn').disabled=false;socket?.disconnect();socket=null};
 timer=setTimeout(()=>fail('No responde la conexión. Tocá Entrar para reintentar o recargá la página.'),13000);
 try{socket=io({transports:['websocket','polling'],tryAllTransports:true,reconnection:false,timeout:10000})}
 catch(e){fail('No se pudo iniciar la conexión: '+e.message);return}
 socket.on('connect',()=>{
   step='sala';cancelTimer();$('lobbyMessage').textContent='Verificando tu entrada…';
   timer=setTimeout(()=>fail('La sala no respondió. Tocá Entrar para reintentar.'),16000);
   socket.emit('join-room',{roomId,name,hostKey:localStorage.getItem(hostStorageKey)||'',password:$('joinPassword').value});
 });
 socket.on('join-pending',()=>{done=true;cancelTimer();$('lobbyMessage').textContent='⏳ Esperando aprobación del administrador…'});
 socket.on('join-error',msg=>{done=false;fail(String(msg||'No se pudo entrar'))});
 socket.on('room-state',state=>{roomState=state;members=state.members||[];info();if(joined){people();updateMic()}});
 socket.on('moderator-mute-changed',async ({muted}={})=>{
   if(muted){try{await liveRoom?.localParticipant.setMicrophoneEnabled(false)}catch{}micOn=false;updateMic()}
   toast(muted?'El administrador silenció tu micrófono':'El administrador habilitó tu micrófono');
 });
 socket.on('moderator-mute-error',msg=>toast(msg||'No se pudo modificar el micrófono'));
 socket.on('room-settings-error',msg=>{toast(msg||'No se pudo modificar la sala');info()});
 socket.on('waiting-state',waitlist);
 socket.on('join-approved',async payload=>{
   done=true;cancelTimer();$('lobbyMessage').textContent='Conectando audio…';
   try{await joinVoice(payload)}
   catch(e){toast('Error de audio: '+e.message);await leave()}
 });
 socket.on('kicked',async()=>{alert('El administrador te expulsó');await leave()});
 socket.on('room-ended',async()=>{alert('Se finalizó la llamada');await leave()});
 socket.on('disconnect',()=>{if(joined){toast('Se perdió la conexión');leave()}else if(socket){done=false;fail('Se desconectó el servidor. Intentá de nuevo.') }});
 socket.on('connect_error',e=>{fail('No conecta con el servidor ('+(e?.message||'error')+'). Reintentá.')});
}
document.addEventListener('visibilitychange',async()=>{
 if(document.visibilityState!=='visible'||!joined||!liveRoom)return;
 try{await liveRoom.startAudio()}catch{}
 for(const audio of audioTracks.values()){
   try{if(audio.paused)await audio.play()}catch{}
 }
 try{
   if(liveRoom.state==='disconnected')toast('La llamada se desconectó mientras estaba en segundo plano.');
 }catch{}
});
$('createBtn').onclick=create;$('joinBtn').onclick=requestJoin;
if($('joinCodeBtn')){
 const enterCode=()=>{
   const raw=$('joinCode').value.trim();
   const code=raw.replace(/[\s-]/g,'').toUpperCase();
   if(!/^[A-Z2-9]{8}$/.test(code)&&!/^[A-Za-z0-9_-]{8,80}$/.test(raw))return toast('Pegá un código de sala válido');
   location.assign('/s/'+(code.length===8?code:raw));
 };
 $('joinCodeBtn').onclick=enterCode;
 $('joinCode').onkeydown=e=>{if(e.key==='Enter')enterCode()};
}
if($('copyCodeBtn'))$('copyCodeBtn').onclick=async()=>{
 try{await navigator.clipboard.writeText(roomId);toast('Código copiado: '+roomId)}
 catch{prompt('Copiá el código:',roomId)}
};
$('nickname').onkeydown=e=>{if(e.key==='Enter'&&!$('joinBtn').disabled)requestJoin()};
$('micBtn').onclick=()=>{if(roomState?.members?.find(m=>m.identity===myId)?.moderatorMuted)return toast('El administrador silenció tu micrófono');toggleMicrophone()};
$('audioBtn').onclick=async()=>{try{await liveRoom?.startAudio();toast('Audio activado')}catch(e){toast(e.message)}};
$('shareBtn').onclick=async()=>{try{if(navigator.share)await navigator.share({title:'Entrá a JS VOICE',url:invite()});else if(navigator.clipboard){await navigator.clipboard.writeText(invite());toast('Enlace copiado')}else prompt('Copiá el enlace:',invite())}catch(e){if(e.name!=='AbortError')prompt('Copiá el enlace:',invite())}};
$('leaveBtn').onclick=leave;
$('modeSelect').onchange=()=>socket?.emit('set-mode',$('modeSelect').value);
$('listingBtn').onclick=()=>socket?.emit('set-listed',!roomState?.listed);
$('passwordBtn').onclick=()=>{
 const pass=prompt('Nueva contraseña de sala (mínimo 6 caracteres):');
 if(pass===null)return;
 if(pass.length<6||pass.length>64)return toast('La clave debe tener entre 6 y 64 caracteres');
 socket?.emit('set-password',pass);
};
$('lockBtn').onclick=()=>socket?.emit('set-lock',!roomState?.locked);
$('endBtn').onclick=()=>{if(confirm('¿Cerrar la sala para todos?'))socket?.emit('end-room')};
function refreshModeForm(){
 const selected=document.querySelector('input[name="mode"]:checked')?.value||'open';
 $('createPasswordBox').classList.toggle('hidden',selected!=='password');
 if(selected==='private' && !$('listedRoom').dataset.touched)$('listedRoom').checked=false;
 else if(selected!=='private' && !$('listedRoom').dataset.touched)$('listedRoom').checked=true;
}
document.querySelectorAll('input[name="mode"]').forEach(input=>input.onchange=refreshModeForm);
$('listedRoom').onchange=()=>{$('listedRoom').dataset.touched='1'};
refreshModeForm();
async function loadDirectory(){
 if(directoryLoading)return;directoryLoading=true;
 const list=$('roomDirectory');
 try {
   const data=await api('/api/rooms');
   list.replaceChildren();
   if(!data.rooms.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No hay salas visibles en este momento.';list.append(empty);return}
   for(const r of data.rooms){
     const el=document.createElement('div');el.className='participant';
     const details=document.createElement('div');details.className='participant-info';
     const heading=document.createElement('b');heading.textContent=(r.mode==='password'?'🔐 ':r.mode==='private'?'✋ ':'🎙️ ')+r.name;
     const sub=document.createElement('div');sub.className='participant-meta';sub.textContent=r.count+'/12 · '+(r.locked?'Bloqueada':r.mode==='password'?'Con contraseña':r.mode==='private'?'Con aprobación':'Pública');
     details.append(heading,sub);el.append(details);
     const btn=document.createElement('button');btn.className='secondary';btn.textContent=r.locked||r.count>=r.capacity?'No disponible':'Entrar';btn.disabled=r.locked||r.count>=r.capacity;
     btn.onclick=()=>location.assign('/s/'+encodeURIComponent(r.id));
     el.append(btn);list.append(el);
   }
 }catch(e){list.textContent='No se pudieron cargar las salas. Tocá Actualizar.'}
 finally{directoryLoading=false}
}
$('refreshRooms').onclick=loadDirectory;
if(roomId){$('nickname').value=localStorage.getItem('jsvoice-name')||'';lobby()}else{show('home');loadDirectory()}

})();
