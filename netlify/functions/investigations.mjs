import { getStore } from '@netlify/blobs';

const STORE = 'aerosage-investigations';
const ID_RE = /^AS-[0-9]{8}-[A-Z0-9]{8,12}$/;
const MAX_BYTES = 180_000;

function reply(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}})}

export default async req=>{
  const url=new URL(req.url), id=String(url.searchParams.get('id')||'').trim().toUpperCase();
  if(!ID_RE.test(id)) return reply({error:'A valid investigation ID is required.'},400);
  const store=getStore(STORE);
  if(req.method==='GET'){
    const data=await store.get(id,{type:'json',consistency:'strong'});
    return data?reply({investigation:data}):reply({error:'Investigation not found.'},404);
  }
  if(req.method==='POST'){
    const raw=await req.text();
    if(raw.length>MAX_BYTES) return reply({error:'Investigation payload is too large.'},413);
    let body; try{body=JSON.parse(raw)}catch{return reply({error:'Invalid JSON payload.'},400)}
    if(body?.id!==id) return reply({error:'Investigation ID mismatch.'},400);
    const data={...body,updatedAt:new Date().toISOString()};
    await store.setJSON(id,data);
    return reply({ok:true,id,updatedAt:data.updatedAt});
  }
  return reply({error:'GET or POST only.'},405);
};
