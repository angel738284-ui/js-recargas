import {Router} from 'express';
import {randomBytes,createHash,randomUUID} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';
import pg from 'pg';

const clients = new OAuth2Client();
const clientId = process.env.GOOGLE_WEB_CLIENT_ID || '';
const database = process.env.JSVOICE_DATABASE_URL || '';
const pool = database ? new pg.Pool({connectionString:database,max:3,
  connectionTimeoutMillis:6500,idleTimeoutMillis:20000,
  ssl:database.includes('localhost')?undefined:{rejectUnauthorized:false}}):null;
const router=Router();
const schema = `
CREATE SCHEMA IF NOT EXISTS jsvoice;
CREATE TABLE IF NOT EXISTS jsvoice.accounts (
  id UUID PRIMARY KEY,google_sub TEXT NOT NULL UNIQUE,
  display_name VARCHAR(32) NOT NULL,google_name VARCHAR(120) NOT NULL DEFAULT '',
  email TEXT NOT NULL,google_photo TEXT,photo BYTEA,
  friend_code VARCHAR(10) NOT NULL UNIQUE,
  bio VARCHAR(160) NOT NULL DEFAULT '',
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE jsvoice.accounts ADD COLUMN IF NOT EXISTS banner BYTEA;
CREATE TABLE IF NOT EXISTS jsvoice.sessions (
  session_hash VARCHAR(64) PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES jsvoice.accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS jsvoice_sessions_account ON jsvoice.sessions(account_id);
CREATE TABLE IF NOT EXISTS jsvoice.friendships (
  sender UUID NOT NULL REFERENCES jsvoice.accounts(id) ON DELETE CASCADE,
  recipient UUID NOT NULL REFERENCES jsvoice.accounts(id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(sender,recipient),
  CHECK(sender<>recipient)
);
CREATE INDEX IF NOT EXISTS jsvoice_friendships_recipient ON jsvoice.friendships(recipient);
ALTER TABLE jsvoice.friendships ADD COLUMN IF NOT EXISTS intro_message VARCHAR(300);
CREATE TABLE IF NOT EXISTS jsvoice.direct_messages(
 id UUID PRIMARY KEY, sender UUID NOT NULL REFERENCES jsvoice.accounts(id) ON DELETE CASCADE,
 recipient UUID NOT NULL REFERENCES jsvoice.accounts(id) ON DELETE CASCADE,
 body VARCHAR(1000) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 read_at TIMESTAMPTZ, CHECK(sender<>recipient)
);
CREATE INDEX IF NOT EXISTS jsvoice_dm_sent ON jsvoice.direct_messages(sender,recipient,created_at DESC);
CREATE INDEX IF NOT EXISTS jsvoice_dm_received ON jsvoice.direct_messages(recipient,created_at DESC);
`;
let initialized=false;
async function ensureDatabase(){
  if(!pool)throw Object.assign(new Error('Falta conectar una base de datos permanente'),{status:503});
  if(initialized)return;
  await pool.query(schema);
  initialized=true;
}
const safeName=s=>String(s||'').trim().replace(/[<>\\\u0000-\u001f]/g,'').slice(0,32);
const AVATARS = new Set(['🎮','🥷','🔥','💎','🐉','🐺','🎧','🌸','👑','🦊','⚡','🐼','🦅','💜']);
const code=()=>randomBytes(6).toString('hex').slice(0,10).toUpperCase();
const hash=t=>createHash('sha256').update(t).digest('hex');
const portrait=a=>a.photo?'/api/account/accounts/'+a.id+'/photo':a.google_photo;
const publicAccount=a=>({id:a.id,name:a.display_name,avatar:a.settings?.avatar||'🎮',photo:portrait(a),banner:(a.banner||a.has_banner)?'/api/account/accounts/'+a.id+'/banner':null,bio:a.bio,friendCode:a.friend_code});
const selfAccount=a=>({...publicAccount(a),email:a.email,preferences:a.settings||{}});
const fail=(res,e)=>res.status(e.status||500).json({error:e.status?e.message:'Error del servidor'});
const run=fn=>async(req,res)=>{try{await fn(req,res)}catch(e){console.error('Cuentas JS VOICE:',e.message);fail(res,e)}};
router.get('/config',(_req,res)=>res.json({googleEnabled:Boolean(clientId&&pool),clientId:clientId||null,accountsEnabled:Boolean(pool)}));
async function auth(req,res,next){
  try{
    await ensureDatabase();
    const match=/^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(req.get('authorization')||'');
    if(!match)return res.status(401).json({error:'Iniciá sesión con Google'});
    const result=await pool.query(`SELECT a.* FROM jsvoice.sessions s
      JOIN jsvoice.accounts a ON a.id=s.account_id
      WHERE s.session_hash=$1 AND s.expires_at>now()`,[hash(match[1])]);
    if(!result.rowCount)return res.status(401).json({error:'Sesión vencida. Entrá con Google de nuevo'});
    req.account=result.rows[0];
    next();
  }catch(e){fail(res,e)}
}
router.post('/google',run(async(req,res)=>{
  await ensureDatabase();
  if(!clientId)return res.status(503).json({error:'Falta configurar Google en JS VOICE'});
  const idToken=req.body?.idToken;
  if(typeof idToken!=='string'||idToken.length>10000)return res.status(400).json({error:'Token inválido'});
  let payload;
  try{const ticket=await clients.verifyIdToken({idToken,audience:clientId});payload=ticket.getPayload()}
  catch{return res.status(401).json({error:'No se pudo verificar la cuenta de Google'})}
  if(!payload?.sub || !payload.email_verified)return res.status(401).json({error:'Cuenta de Google no verificada'});
  const display=safeName(payload.name)||'Usuario JS VOICE';
  const photo=typeof payload.picture==='string'&&payload.picture.startsWith('https://')?payload.picture:null;
  const newId=randomUUID();
  const inserted=await pool.query(`INSERT INTO jsvoice.accounts
    (id,google_sub,display_name,google_name,email,google_photo,friend_code)
    VALUES($1,$2,$3,$3,$4,$5,$6)
    ON CONFLICT(google_sub) DO UPDATE SET google_name=EXCLUDED.google_name,
    email=EXCLUDED.email,google_photo=EXCLUDED.google_photo,updated_at=now()
    RETURNING *`,[newId,payload.sub,display,payload.email,photo,code()]);
  const person=inserted.rows[0];
  const session=randomBytes(48).toString('base64url');
  await pool.query('INSERT INTO jsvoice.sessions(session_hash,account_id,expires_at) VALUES($1,$2,now()+interval \'30 days\')',[hash(session),person.id]);
  await pool.query('DELETE FROM jsvoice.sessions WHERE expires_at<now()');
  res.json({session,profile:selfAccount(person)});
}));
router.get('/me',auth,run(async(req,res)=>res.json({profile:selfAccount(req.account)})));
router.patch('/me',auth,run(async(req,res)=>{
 const name=safeName(req.body?.name);
 const bio=typeof req.body?.bio==='string'?req.body.bio.trim().slice(0,160):req.account.bio;
 const avatar=AVATARS.has(req.body?.avatar)?req.body.avatar:req.account.settings?.avatar||'🎮';
 const pref=req.body?.preferences||{};
 const allowed={avatar,
   dataSaver:typeof pref.dataSaver==='boolean'?pref.dataSaver:Boolean(req.account.settings?.dataSaver),
   floatingMic:typeof pref.floatingMic==='boolean'?pref.floatingMic:Boolean(req.account.settings?.floatingMic)};
 if(name.length<2)return res.status(400).json({error:'Apodo de 2 a 32 caracteres'});
 const result=await pool.query(`UPDATE jsvoice.accounts SET display_name=$2,bio=$3,
 settings=$4::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
 [req.account.id,name,bio,JSON.stringify(allowed)]);
 res.json({profile:selfAccount(result.rows[0])});
}));
router.post('/me/photo',auth,async(req,res)=>{
 try{
  let chunks=[],length=0;
  for await(const part of req){
   length+=part.length;if(length>98304)return res.status(413).json({error:'La foto debe pesar menos de 96 KB'});
   chunks.push(part);
  }
  const data=Buffer.concat(chunks);
  if(req.get('content-type')!=='image/jpeg'||data.length<100||
    data[0]!==0xff||data[1]!==0xd8||data[data.length-2]!==0xff||data[data.length-1]!==0xd9)
     return res.status(400).json({error:'Se necesita una foto JPEG comprimida'});
  const q=await pool.query('UPDATE jsvoice.accounts SET photo=$2,updated_at=now() WHERE id=$1 RETURNING *',[req.account.id,data]);
  res.json({profile:selfAccount(q.rows[0])});
 }catch(e){fail(res,e)}
});
router.post('/me/banner',auth,async(req,res)=>{
 try{
  let chunks=[],length=0;
  for await(const part of req){
   length+=part.length;
   if(length>225280)return res.status(413).json({error:'La portada debe pesar menos de 220 KB'});
   chunks.push(part);
  }
  const data=Buffer.concat(chunks);
  if(req.get('content-type')!=='image/jpeg'||data.length<100||
     data[0]!==0xff||data[1]!==0xd8||data[data.length-2]!==0xff||data[data.length-1]!==0xd9)
     return res.status(400).json({error:'Elegí una imagen válida para la portada'});
  const saved=await pool.query('UPDATE jsvoice.accounts SET banner=$2,updated_at=now() WHERE id=$1 RETURNING *',[req.account.id,data]);
  res.json({profile:selfAccount(saved.rows[0])});
 }catch(e){fail(res,e)}
});
router.get('/accounts/:id/banner',run(async(req,res)=>{
 await ensureDatabase();
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.sendStatus(404);
 const result=await pool.query('SELECT banner FROM jsvoice.accounts WHERE id=$1',[req.params.id]);
 if(!result.rowCount||!result.rows[0].banner)return res.sendStatus(404);
 res.set('Cache-Control','no-cache');
 res.type('jpeg').send(result.rows[0].banner);
}));
router.get('/accounts/:id/photo',run(async(req,res)=>{
 await ensureDatabase();
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.sendStatus(404);
 const result=await pool.query('SELECT photo FROM jsvoice.accounts WHERE id=$1',[req.params.id]);
 if(!result.rowCount||!result.rows[0].photo)return res.sendStatus(404);
 res.set('Cache-Control','public,max-age=120');
 res.type('jpeg').send(result.rows[0].photo);
}));
router.get('/friends/lookup/:code',auth,run(async(req,res)=>{
 const code=String(req.params.code||'').trim().toUpperCase();
 if(!/^[A-F0-9]{10}$/.test(code))return res.status(400).json({error:'El código debe tener 10 caracteres'});
 const q=await pool.query('SELECT id,display_name,friend_code,settings FROM jsvoice.accounts WHERE friend_code=$1',[code]);
 if(!q.rowCount||q.rows[0].id===req.account.id)return res.status(404).json({error:'No encontramos ese usuario'});
 const id=q.rows[0].id;
 const fs=await pool.query('SELECT sender,recipient,status FROM jsvoice.friendships WHERE (sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)',[req.account.id,id]);
 const f=fs.rows[0];
 const relation=!f?'none':f.status==='accepted'?'friends':f.status==='rejected'?'rejected':f.sender===req.account.id?'sent':'received';
 res.json({user:{id,name:q.rows[0].display_name,avatar:q.rows[0].settings?.avatar||'🎮',friendCode:code},relation});
}));
router.get('/friends',auth,run(async(req,res)=>{
 const q=await pool.query(`SELECT f.sender,f.recipient,f.status,a.id,a.display_name,a.google_photo,a.photo IS NOT NULL AS has_photo,a.banner IS NOT NULL AS has_banner,a.friend_code,a.bio,a.settings,f.intro_message
 FROM jsvoice.friendships f JOIN jsvoice.accounts a ON a.id=
 CASE WHEN f.sender=$1 THEN f.recipient ELSE f.sender END
 WHERE f.sender=$1 OR f.recipient=$1 ORDER BY f.created_at DESC LIMIT 150`,[req.account.id]);
 res.json({friends:q.rows.filter(x=>x.status==='accepted').map(x=>publicAccount({...x,photo:x.has_photo?true:null})),
 requests:q.rows.filter(x=>x.status==='pending'&&x.recipient===req.account.id)
 .map(x=>({...publicAccount({...x,photo:x.has_photo?true:null}),introMessage:x.intro_message||''})),
 sent:q.rows.filter(x=>x.status==='pending'&&x.sender===req.account.id)
 .map(x=>({...publicAccount({...x,photo:x.has_photo?true:null}),introMessage:x.intro_message||''}))});
}));
router.get('/friends/:id/profile',auth,run(async(req,res)=>{
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(400).json({error:'Perfil inválido'});
 const q=await pool.query(`SELECT a.id,a.display_name,a.google_photo,a.photo IS NOT NULL AS has_photo,
   a.banner IS NOT NULL AS has_banner,a.friend_code,a.bio,a.settings
   FROM jsvoice.accounts a WHERE a.id=$1 AND EXISTS(
   SELECT 1 FROM jsvoice.friendships f WHERE f.status='accepted' AND
   ((f.sender=$2 AND f.recipient=a.id) OR (f.recipient=$2 AND f.sender=a.id)))`,
   [req.params.id,req.account.id]);
 if(!q.rowCount)return res.status(404).json({error:'Este perfil no está en tu lista de amigos'});
 res.json({profile:publicAccount({...q.rows[0],photo:q.rows[0].has_photo?true:null})});
}));
router.post('/friends/request',auth,run(async(req,res)=>{
 const friendCode=String(req.body?.friendCode||'').trim().toUpperCase();
 const raw=req.body?.message, intro=typeof raw==='string'?raw.trim():'';
 if(!/^[A-F0-9]{10}$/.test(friendCode))return res.status(400).json({error:'Código de amigo inválido'});
 if(raw!==undefined && (typeof raw!=='string'||intro.length>300))
   return res.status(400).json({error:'Tu presentación debe tener máximo 300 caracteres'});
 const q=await pool.query('SELECT id FROM jsvoice.accounts WHERE friend_code=$1',[friendCode]);
 if(!q.rowCount||q.rows[0].id===req.account.id)return res.status(404).json({error:'No encontramos ese usuario'});
 const other=q.rows[0].id;
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const pair=[req.account.id,other].sort().join(':');
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[pair]);
  const existing=await client.query(`SELECT sender,recipient,status,intro_message
    FROM jsvoice.friendships WHERE (sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)
    FOR UPDATE`,[req.account.id,other]);
  if(existing.rowCount){
    const f=existing.rows[0];
    if(f.status==='pending'&&f.sender===req.account.id&&intro&&!f.intro_message){
      await client.query('UPDATE jsvoice.friendships SET intro_message=$3 WHERE sender=$1 AND recipient=$2',
        [req.account.id,other,intro]);
      await client.query('COMMIT');
      return res.json({ok:true,introSent:true});
    }
    await client.query('ROLLBACK');
    return res.status(409).json({error:f.status==='rejected'?'Esta persona rechazó tu solicitud. No podés enviar otra.':
      f.status==='accepted'?'Ya son amigos':'Ya existe una solicitud. Solo se permite un mensaje de presentación.'});
  }
  const count=await client.query(`SELECT count(*)::int AS n FROM jsvoice.friendships
    WHERE sender=$1 AND created_at>now()-interval '1 day'`,[req.account.id]);
  if(count.rows[0].n>=20){await client.query('ROLLBACK');return res.status(429).json({error:'Máximo de 20 solicitudes por día'})}
  await client.query('INSERT INTO jsvoice.friendships(sender,recipient,intro_message) VALUES($1,$2,$3)',
   [req.account.id,other,intro||null]);
  await client.query('COMMIT');
  res.status(201).json({ok:true,introSent:Boolean(intro)});
 }catch(e){try{await client.query('ROLLBACK')}catch{}throw e}
 finally{client.release()}
}));
router.post('/friends/:id/accept',auth,run(async(req,res)=>{
 const q=await pool.query(`UPDATE jsvoice.friendships SET status='accepted'
 WHERE sender=$1 AND recipient=$2 AND status='pending' RETURNING sender`,[req.params.id,req.account.id]);
 if(!q.rowCount)return res.sendStatus(404);
 res.json({ok:true});
}));
router.post('/friends/:id/reject',auth,run(async(req,res)=>{
 const q=await pool.query("UPDATE jsvoice.friendships SET status='rejected' WHERE sender=$1 AND recipient=$2 AND status='pending' RETURNING sender",
 [req.params.id,req.account.id]);
 if(!q.rowCount)return res.status(404).json({error:'Solicitud no encontrada'});
 res.json({ok:true});
}));
router.get('/messages/conversations',auth,run(async(req,res)=>{
 const q=await pool.query(`SELECT a.id,a.display_name,a.friend_code,a.settings,
  (SELECT m.body FROM jsvoice.direct_messages m WHERE (m.sender=a.id AND m.recipient=$1)
    OR (m.sender=$1 AND m.recipient=a.id) ORDER BY m.created_at DESC LIMIT 1) AS last_message,
  (SELECT count(*)::int FROM jsvoice.direct_messages m WHERE m.sender=a.id AND m.recipient=$1 AND m.read_at IS NULL) AS unread
  FROM jsvoice.friendships f JOIN jsvoice.accounts a ON a.id=CASE WHEN f.sender=$1 THEN f.recipient ELSE f.sender END
  WHERE f.status='accepted' AND (f.sender=$1 OR f.recipient=$1)
  ORDER BY a.display_name LIMIT 150`,[req.account.id]);
 res.json({conversations:q.rows.map(x=>({id:x.id,name:x.display_name,friendCode:x.friend_code,
 avatar:x.settings?.avatar||'🎮',lastMessage:x.last_message||'',unread:x.unread}))});
}));
router.get('/messages/:id',auth,run(async(req,res)=>{
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(400).json({error:'Usuario inválido'});
 const allowed=await pool.query(`SELECT 1 FROM jsvoice.friendships WHERE status='accepted'
   AND ((sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)) LIMIT 1`,
 [req.account.id,req.params.id]);
 if(!allowed.rowCount)return res.status(403).json({error:'Solo podés chatear con tus amigos'});
 const q=await pool.query(`SELECT * FROM (SELECT id,sender,recipient,body,created_at
   FROM jsvoice.direct_messages WHERE (sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)
   ORDER BY created_at DESC LIMIT 100) v ORDER BY created_at ASC`,
 [req.account.id,req.params.id]);
 await pool.query('UPDATE jsvoice.direct_messages SET read_at=now() WHERE recipient=$1 AND sender=$2 AND read_at IS NULL',
 [req.account.id,req.params.id]);
 res.json({messages:q.rows.map(x=>({id:x.id,mine:x.sender===req.account.id,body:x.body,createdAt:x.created_at}))});
}));
router.post('/messages/:id',auth,run(async(req,res)=>{
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(400).json({error:'Usuario inválido'});
 const body=typeof req.body?.body==='string'?req.body.body.trim():'';
 if(!body||body.length>1000)return res.status(400).json({error:'El mensaje debe tener entre 1 y 1000 caracteres'});
 const allowed=await pool.query(`SELECT 1 FROM jsvoice.friendships WHERE status='accepted'
   AND ((sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)) LIMIT 1`,
 [req.account.id,req.params.id]);
 if(!allowed.rowCount)return res.status(403).json({error:'Solo podés enviar mensajes a tus amigos'});
 const recent=await pool.query(`SELECT count(*)::int n FROM jsvoice.direct_messages WHERE sender=$1
  AND created_at>now()-interval '1 minute'`,[req.account.id]);
 if(recent.rows[0].n>=25)return res.status(429).json({error:'Demasiados mensajes. Esperá un momento'});
 const q=await pool.query('INSERT INTO jsvoice.direct_messages(id,sender,recipient,body) VALUES($1,$2,$3,$4) RETURNING id,created_at',
 [randomUUID(),req.account.id,req.params.id,body]);
 res.status(201).json({ok:true,id:q.rows[0].id,createdAt:q.rows[0].created_at});
}));
router.delete('/friends/:id',auth,run(async(req,res)=>{
 await pool.query('DELETE FROM jsvoice.friendships WHERE (sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)',[req.account.id,req.params.id]);
 res.json({ok:true});
}));
router.post('/logout',auth,run(async(req,res)=>{
 const token=req.get('authorization').slice(7);
 await pool.query('DELETE FROM jsvoice.sessions WHERE session_hash=$1',[hash(token)]);
 res.json({ok:true});
}));
export default router;