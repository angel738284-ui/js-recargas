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
const publicAccount=a=>({id:a.id,name:a.display_name,avatar:a.settings?.avatar||'🎮',photo:portrait(a),bio:a.bio,friendCode:a.friend_code});
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
router.get('/accounts/:id/photo',run(async(req,res)=>{
 await ensureDatabase();
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.sendStatus(404);
 const result=await pool.query('SELECT photo FROM jsvoice.accounts WHERE id=$1',[req.params.id]);
 if(!result.rowCount||!result.rows[0].photo)return res.sendStatus(404);
 res.set('Cache-Control','public,max-age=120');
 res.type('jpeg').send(result.rows[0].photo);
}));
router.get('/friends',auth,run(async(req,res)=>{
 const q=await pool.query(`SELECT f.sender,f.recipient,f.status,a.id,a.display_name,a.google_photo,a.photo IS NOT NULL AS has_photo,a.friend_code,a.bio,a.settings
 FROM jsvoice.friendships f JOIN jsvoice.accounts a ON a.id=
 CASE WHEN f.sender=$1 THEN f.recipient ELSE f.sender END
 WHERE f.sender=$1 OR f.recipient=$1 ORDER BY f.created_at DESC LIMIT 150`,[req.account.id]);
 res.json({friends:q.rows.filter(x=>x.status==='accepted').map(x=>publicAccount({...x,photo:x.has_photo?true:null})),
 requests:q.rows.filter(x=>x.status==='pending'&&x.recipient===req.account.id)
 .map(x=>publicAccount({...x,photo:x.has_photo?true:null}))});
}));
router.post('/friends/request',auth,run(async(req,res)=>{
 const friendCode=String(req.body?.friendCode||'').trim().toUpperCase();
 if(!/^[0-9A-F]{10}$/.test(friendCode))return res.status(400).json({error:'Código de amigo inválido'});
 const q=await pool.query('SELECT id FROM jsvoice.accounts WHERE friend_code=$1',[friendCode]);
 if(!q.rowCount||q.rows[0].id===req.account.id)return res.status(404).json({error:'No encontramos ese usuario'});
 const other=q.rows[0].id;
 const count=await pool.query(`SELECT count(*)::int AS n FROM jsvoice.friendships
 WHERE sender=$1 AND created_at>now()-interval '1 day'`,[req.account.id]);
 if(count.rows[0].n>=20)return res.status(429).json({error:'Máximo de 20 solicitudes por día'});
 const existing=await pool.query(`SELECT status FROM jsvoice.friendships
 WHERE (sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1)`,[req.account.id,other]);
 if(existing.rowCount)return res.status(409).json({error:'Ya existe una solicitud o amistad'});
 await pool.query('INSERT INTO jsvoice.friendships(sender,recipient) VALUES($1,$2)',[req.account.id,other]);
 res.status(201).json({ok:true});
}));
router.post('/friends/:id/accept',auth,run(async(req,res)=>{
 const q=await pool.query(`UPDATE jsvoice.friendships SET status='accepted'
 WHERE sender=$1 AND recipient=$2 AND status='pending' RETURNING sender`,[req.params.id,req.account.id]);
 if(!q.rowCount)return res.sendStatus(404);
 res.json({ok:true});
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
