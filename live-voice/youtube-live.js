'use strict';
// YouTube Data API v3 Live Chat polling. Only server keeps the key.
function videoIdFrom(input) {
  const raw = String(input || '').trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  let u; try { u = new URL(raw); } catch { throw Error('youtube_url_invalid'); }
  const host=u.hostname.toLowerCase(), p=u.pathname.split('/').filter(Boolean);
  let id='';
  if (host==='youtu.be'||host==='www.youtu.be') id=p[0]||'';
  else if (['youtube.com','www.youtube.com','m.youtube.com'].includes(host)) {
    if(p[0]==='watch') id=u.searchParams.get('v')||'';
    if(p[0]==='live'||p[0]==='embed') id=p[1]||'';
  }
  if(!/^[\w-]{11}$/.test(id))throw Error('youtube_url_invalid');
  return id;
}
function createYouTubeLive({apiKey,onComment,onError=()=>{},fetchImpl=fetch}) {
  let epoch=0,timer=null,pageToken='',errors=0,seen=new Set();
  const state={status:'disconnected',videoId:'',liveChatId:'',title:'',error:null,lastPoll:null};
  const snapshot=()=>({...state,configured:Boolean(apiKey)});
  function disconnect(){
    epoch++;if(timer!==null)clearTimeout(timer);timer=null;
    pageToken='';errors=0;seen.clear();
    Object.assign(state,{status:'disconnected',videoId:'',liveChatId:'',title:'',error:null,lastPoll:null});
    return snapshot();
  }
  async function api(endpoint,params){
    if(!apiKey)throw Error('youtube_api_key_missing');
    const url=new URL('https://www.googleapis.com/youtube/v3/'+endpoint);
    for(const [k,v]of Object.entries(params))url.searchParams.set(k,String(v));
    const res=await fetchImpl(url,{headers:{'x-goog-api-key':apiKey,accept:'application/json'},signal:AbortSignal.timeout(12000)});
    const body=await res.json().catch(()=>({}));
    if(!res.ok){
      const reason=String(body?.error?.errors?.[0]?.reason||body?.error?.status||res.status).slice(0,80);
      const e=new Error('youtube_api_'+res.status+'_'+reason);e.reason=reason;throw e;
    }
    return body;
  }
  function schedule(ms,id){
    if(id!==epoch)return;
    if(timer!==null)clearTimeout(timer);
    timer=setTimeout(()=>{poll(id).catch(onError);},ms);timer.unref?.();
  }
  async function poll(id){
    if(id!==epoch||state.status!=='connected')return;
    let delay=10000;
    try{
      const body=await api('liveChat/messages',{liveChatId:state.liveChatId,part:'id,snippet,authorDetails',maxResults:200,...(pageToken?{pageToken}:{})});
      if(id!==epoch)return;
      state.lastPoll=Date.now();state.error=null;errors=0;
      const initial=!pageToken;
      pageToken=body.nextPageToken||pageToken;
      for(const item of body.items||[]){
        if(!item?.id||seen.has(item.id))continue;
        seen.add(item.id);if(seen.size>1000)seen=new Set([...seen].slice(-500));
        if(initial||item.snippet?.type!=='textMessageEvent')continue;
        const comment=String(item.snippet?.displayMessage||item.snippet?.textMessageDetails?.messageText||'').trim().slice(0,300);
        if(!comment)continue;
        const username=String(item.authorDetails?.channelId||item.authorDetails?.displayName||'youtube-user').slice(0,80);
        const displayName=String(item.authorDetails?.displayName||'Espectador').slice(0,80);
        try{Promise.resolve(onComment({username,displayName,comment,platform:'youtube'})).catch(onError);}catch(e){onError(e);}
      }
      if(body.offlineAt){state.status='ended';return;}
      delay=Math.max(3000,Math.min(30000,Number(body.pollingIntervalMillis)||10000));
    }catch(e){
      if(id!==epoch)return;
      state.error=String(e?.message||e).slice(0,200);onError(e);
      if(['liveChatEnded','liveChatDisabled'].includes(e.reason)){state.status='ended';return;}
      errors++;delay=Math.min(60000,5000*Math.pow(2,Math.min(errors,4)));
    }
    schedule(delay,id);
  }
  async function connect(input){
    const videoId=videoIdFrom(input);disconnect();
    const id=epoch;state.status='connecting';state.videoId=videoId;
    try{
      const body=await api('videos',{part:'snippet,liveStreamingDetails',id:videoId});
      if(id!==epoch)return snapshot();
      const video=body.items?.[0],chatId=video?.liveStreamingDetails?.activeLiveChatId;
      if(!chatId)throw Error('youtube_live_chat_not_active');
      state.liveChatId=String(chatId);state.title=String(video?.snippet?.title||'').slice(0,160);
      state.status='connected';schedule(0,id);return snapshot();
    }catch(e){
      if(id===epoch){state.status='error';state.error=String(e?.message||e).slice(0,200);}throw e;
    }
  }
  return {connect,disconnect,snapshot};
}
module.exports=createYouTubeLive;
module.exports.videoIdFrom=videoIdFrom;
