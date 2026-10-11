import pg from 'pg';
import {GoogleAuth} from 'google-auth-library';

const connection=process.env.JSVOICE_DATABASE_URL||'';
const pool=connection?new pg.Pool({connectionString:connection,max:2,
  connectionTimeoutMillis:6500,idleTimeoutMillis:20000,
  ssl:connection.includes('localhost')?undefined:{rejectUnauthorized:false}}):null;
let initialized=false;
const credentialsRaw=process.env.FCM_SERVICE_ACCOUNT_JSON||'';
let credentials=null;
try{
  if(credentialsRaw)credentials=JSON.parse(credentialsRaw);
}catch{console.error('FCM: credenciales JSON inválidas (sin imprimir secretos)')}
const projectId=process.env.FCM_PROJECT_ID||credentials?.project_id||'';
const auth=credentials?.client_email&&credentials?.private_key?
  new GoogleAuth({credentials,scopes:['https://www.googleapis.com/auth/firebase.messaging']}):null;
export function pushReady(){return Boolean(pool&&auth&&projectId)}
async function ensureDevices(){
  if(!pool)throw new Error('No hay base de datos para notificaciones');
  if(initialized)return;
  await pool.query(`CREATE SCHEMA IF NOT EXISTS jsvoice;
    CREATE TABLE IF NOT EXISTS jsvoice.push_devices (
      token TEXT PRIMARY KEY,
      account_id UUID NOT NULL REFERENCES jsvoice.accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS jsvoice_push_account ON jsvoice.push_devices(account_id);`);
  initialized=true;
}
export async function registerPushDevice(accountId,token){
  if(typeof token!=='string'||token.length<60||token.length>4096||!(/^[A-Za-z0-9:_-]+$/).test(token))
    throw Object.assign(new Error('Token de notificación inválido'),{status:400});
  await ensureDevices();
  await pool.query(`INSERT INTO jsvoice.push_devices(token,account_id) VALUES($1,$2)
    ON CONFLICT(token) DO UPDATE SET account_id=excluded.account_id,updated_at=now()`,[token,accountId]);
  await pool.query(`DELETE FROM jsvoice.push_devices WHERE account_id=$1 AND token NOT IN
    (SELECT token FROM jsvoice.push_devices WHERE account_id=$1 ORDER BY updated_at DESC LIMIT 8)`,[accountId]);
}
export async function unregisterPushDevice(accountId,token){
  if(!pool||!token||typeof token!=='string'||token.length>4096)return;
  await ensureDevices();
  await pool.query('DELETE FROM jsvoice.push_devices WHERE account_id=$1 AND token=$2',[accountId,token]);
}
export async function sendPushToAccount(accountId,{type,title,body,otherId='',callId=''}){
  if(!pushReady())return {enabled:false,sent:0};
  try{
    await ensureDevices();
    const devices=await pool.query('SELECT token FROM jsvoice.push_devices WHERE account_id=$1 ORDER BY updated_at DESC LIMIT 8',[accountId]);
    if(!devices.rowCount)return {enabled:true,sent:0};
    const client=await auth.getClient();
    const access=await client.getAccessToken();
    if(!access?.token)return {enabled:true,sent:0};
    const ttl=type==='call'?'120s':'86400s';
    const data={type:String(type||''),title:String(title||'JS VOICE').slice(0,90),
      body:String(body||'').slice(0,160),otherId:String(otherId||''),callId:String(callId||'')};
    let sent=0;
    for(const {token} of devices.rows){
      try{
        const response=await fetch('https://fcm.googleapis.com/v1/projects/'+encodeURIComponent(projectId)+'/messages:send',{
          method:'POST',signal:AbortSignal.timeout(6500),
          headers:{Authorization:'Bearer '+access.token,'Content-Type':'application/json'},
          body:JSON.stringify({message:{token,data,android:{priority:type==='call'?'HIGH':'NORMAL',ttl,
            restricted_package_name:'com.jsff.voice'}}})
        });
        if(response.ok){sent++;continue}
        const err=await response.json().catch(()=>({}));
        const codes=(err.error?.details||[]).map(x=>x.errorCode).filter(Boolean);
        if(codes.includes('UNREGISTERED')){
          await pool.query('DELETE FROM jsvoice.push_devices WHERE token=$1',[token]);
        }else console.error('FCM envío HTTP',response.status,'(sin mostrar tokens)');
      }catch(err){console.error('FCM error de red:',err?.message||'desconocido')}
    }
    return {enabled:true,sent};
  }catch(e){console.error('FCM no se pudo enviar:',e?.message||'desconocido');return {enabled:true,sent:0}}
}
