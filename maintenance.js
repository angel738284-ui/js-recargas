import pg from 'pg';
const db=process.env.JSVOICE_DATABASE_URL||'';
const pool=db?new pg.Pool({connectionString:db,max:2,connectionTimeoutMillis:6500,
 idleTimeoutMillis:20000,ssl:db.includes('localhost')?undefined:{rejectUnauthorized:false}}):null;
let lastCheck=0,cached=true,callback=null,prepared=false;
async function prepare(){
 if(prepared)return;
 if(!pool)throw new Error('Database not available');
 await pool.query(`CREATE SCHEMA IF NOT EXISTS jsvoice;
 CREATE TABLE IF NOT EXISTS jsvoice.service_control(
 id INTEGER PRIMARY KEY CHECK(id=1),
 paused BOOLEAN NOT NULL DEFAULT false,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 changed_by UUID
 );
 INSERT INTO jsvoice.service_control(id,paused) VALUES(1,false)
 ON CONFLICT (id) DO NOTHING;`);
 prepared=true;
}
export async function isPaused(force=false){
 if(!force && Date.now()-lastCheck<2000)return cached;
 try{
  await prepare();
  const r=await pool.query('SELECT paused FROM jsvoice.service_control WHERE id=1');
  cached=r.rows[0]?.paused===true;
  lastCheck=Date.now();
  return cached;
 }catch(e){console.error('Maintenance status unavailable:',e.message);
  // Fail closed when status cannot be checked, avoiding bypass.
  return true;}
}
export async function setPaused(value,adminId){
 if(typeof value!=='boolean'||!adminId)throw new Error('Invalid maintenance request');
 await prepare();
 const q=await pool.query('UPDATE jsvoice.service_control SET paused=$1,changed_by=$2,updated_at=now() WHERE id=1 RETURNING paused',[value,adminId]);
 cached=q.rows[0]?.paused===true;lastCheck=Date.now();
 if(cached && callback)await callback();
 return cached;
}
export function registerPauseHandler(fn){callback=fn}
