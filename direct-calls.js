import {Router} from 'express';
import pg from 'pg';
import {sendPushToAccount} from './push.js';
import {randomUUID,createHash} from 'node:crypto';

/* Dedicated, session-authenticated invitations. Recipient must accept first.
   Room membership is checked by the WebSocket handler as well. */
const connection=process.env.JSVOICE_DATABASE_URL||'';
const pool=connection?new pg.Pool({connectionString:connection,max:2,
  connectionTimeoutMillis:7000,idleTimeoutMillis:20000,
  ssl:connection.includes('localhost')?undefined:{rejectUnauthorized:false}}):null;
const router=Router();
let roomCreator=null;
export function configureDirectRooms(create){roomCreator=create}
const tokenHash=t=>createHash('sha256').update(t).digest('hex');
async function accountBySession(session){
 if(!pool||typeof session!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(session))return null;
 const r=await pool.query('SELECT account_id FROM jsvoice.sessions WHERE session_hash=$1 AND expires_at>now()',[tokenHash(session)]);
 return r.rows[0]?.account_id||null;
}
export async function directRoomAllowed(room,session){
 const id=await accountBySession(session);
 if(!id||!room?.directCaller)return false;
 const q=await pool.query(`SELECT caller,recipient,status,expires_at FROM jsvoice.direct_calls
 WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1`,[room.id]);
 if(!q.rowCount)return false;
 const c=q.rows[0];
 return c.status==='accepted' && (c.caller===id||c.recipient===id) ||
  c.status==='ringing' && c.caller===id && new Date(c.expires_at)>new Date();
}
async function auth(req,res,next){
 try{
  const bearer=/^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(req.get('Authorization')||'');
  const id=await accountBySession(bearer?.[1]);
  if(!id)return res.status(401).json({error:'Iniciá sesión de nuevo con Google'});
  req.accountId=id;next();
 }catch(e){next(e)}
}
function wrap(fn){return async(req,res,next)=>{try{await fn(req,res)}catch(e){next(e)}}}
function view(r){return {id:r.id,roomId:r.room_id,status:r.status,otherId:r.other_id,
  name:r.display_name,avatar:r.settings?.avatar||'🎮',
  photo:r.has_photo?'/api/account/accounts/'+r.other_id+'/photo':r.google_photo,
  friendCode:r.friend_code,createdAt:r.created_at,expiresAt:r.expires_at};}
router.get('/calls',auth,wrap(async(req,res)=>{
 await pool.query("UPDATE jsvoice.direct_calls SET status='expired',responded_at=now() WHERE status='ringing' AND expires_at<now()");
 const q=await pool.query(`SELECT c.*,a.id AS other_id,a.display_name,a.settings,
 a.photo IS NOT NULL AS has_photo,a.google_photo,a.friend_code
 FROM jsvoice.direct_calls c
 JOIN jsvoice.accounts a ON a.id=CASE WHEN c.caller=$1 THEN c.recipient ELSE c.caller END
 WHERE (c.recipient=$1 OR c.caller=$1) AND c.created_at>now()-interval '2 hours'
 ORDER BY c.created_at DESC LIMIT 40`,[req.accountId]);
 res.set('Cache-Control','no-store');
 res.json({incoming:q.rows.filter(x=>x.recipient===req.accountId).map(view),
 outgoing:q.rows.filter(x=>x.caller===req.accountId).map(view)});
}));
router.post('/calls',auth,wrap(async(req,res)=>{
 if(!roomCreator)return res.status(503).json({error:'Llamadas directas no disponibles'});
 const friendCode=String(req.body?.friendCode||'').trim().toUpperCase();
 if(!/^[A-F0-9]{10}$/.test(friendCode))return res.status(400).json({error:'Ingresá el código de amigo de 10 caracteres'});
 const a=await pool.query('SELECT id,display_name FROM jsvoice.accounts WHERE friend_code=$1',[friendCode]);
 if(!a.rowCount)return res.status(404).json({error:'No encontramos esa cuenta'});
 const other=a.rows[0];if(other.id===req.accountId)return res.status(400).json({error:'No podés llamarte a vos mismo'});
 const q=await pool.query(`SELECT
 COUNT(*) FILTER(WHERE created_at>now()-interval '1 minute')::int AS recent,
 COUNT(*) FILTER(WHERE created_at>now()-interval '1 day')::int AS daily,
 COUNT(*) FILTER(WHERE status='ringing' AND expires_at>now())::int AS pending
 FROM jsvoice.direct_calls WHERE caller=$1`,[req.accountId]);
 const n=q.rows[0];
 if(n.recent>=3||n.daily>=25||n.pending>=2)return res.status(429).json({error:'Alcanzaste el límite de invitaciones. Probá más tarde'});
 const ex=await pool.query("SELECT id FROM jsvoice.direct_calls WHERE caller=$1 AND recipient=$2 AND status='ringing' AND expires_at>now()",[req.accountId,other.id]);
 if(ex.rowCount)return res.status(409).json({error:'Ya le enviaste una invitación. Esperá su respuesta'});
 const room=roomCreator({caller:req.accountId,recipient:other.id,calleeName:other.display_name});
 const id=randomUUID();
 try{await pool.query('INSERT INTO jsvoice.direct_calls(id,caller,recipient,room_id) VALUES($1,$2,$3,$4)',
  [id,req.accountId,other.id,room.id]);}
 catch(e){console.error('Direct call save failed:',e.message);throw e}
 const caller=await pool.query('SELECT display_name FROM jsvoice.accounts WHERE id=$1',[req.accountId]);
 await sendPushToAccount(other.id,{type:'call',title:'Llamada entrante',
   body:(caller.rows[0]?.display_name||'Un amigo')+' te está llamando por JS VOICE',
   callId:id,otherId:req.accountId});
 res.status(201).json({callId:id,roomId:room.id,hostKey:room.hostKey,status:'ringing',expiresInSeconds:120});
}));
router.post('/calls/:id/respond',auth,wrap(async(req,res)=>{
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.status(404).json({error:'No encontramos la llamada'});
 if(typeof req.body?.accept!=='boolean')return res.status(400).json({error:'Elegí aceptar o rechazar'});
 const status=req.body.accept?'accepted':'declined';
 const q=await pool.query(`UPDATE jsvoice.direct_calls SET status=$3,responded_at=now()
 WHERE id=$1 AND recipient=$2 AND status='ringing' AND expires_at>now()
 RETURNING room_id`,[req.params.id,req.accountId,status]);
 if(!q.rowCount)return res.status(409).json({error:'La invitación venció o ya fue respondida'});
 res.json({status,roomId:req.body.accept?q.rows[0].room_id:null});
}));
router.post('/calls/:id/cancel',auth,wrap(async(req,res)=>{
 if(!/^[0-9a-f-]{36}$/i.test(req.params.id))return res.sendStatus(404);
 const q=await pool.query(`UPDATE jsvoice.direct_calls SET status='cancelled',responded_at=now()
 WHERE id=$1 AND caller=$2 AND status='ringing' RETURNING id`,[req.params.id,req.accountId]);
 if(!q.rowCount)return res.status(409).json({error:'La invitación ya fue respondida'});
 res.json({ok:true});
}));
router.use((err,req,res,next)=>{
 console.error('Direct call:',err?.message);
 if(!res.headersSent)res.status(500).json({error:'No se pudo completar la llamada'});
});
export default router;