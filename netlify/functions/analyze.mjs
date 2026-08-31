export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || 'base';
  const vehicle = url.searchParams.get('vehicle') || '';
  const notes = url.searchParams.get('notes') || '';

  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405);

  let csvText = '';
  try { csvText = await req.text(); } catch { return reply({ error: 'Could not read CSV body.' }, 400); }
  if (csvText.length < 30) return reply({ error: 'A telemetry CSV is required.' }, 400);
  if (csvText.length > 4_000_000) return reply({ error: 'CSV too large for this MVP (4 MB max).' }, 413);

  let packet, baseline;
  try {
    const rows = parseCSV(csvText).slice(0, 5000);
    if (rows.length < 2) return reply({ error: 'The CSV needs a header and at least one data row.' }, 400);
    const profiles = numericProfiles(rows);
    const incidents = detectIncidents(rows, profiles);
    packet = buildEvidencePacket(rows, profiles, incidents, vehicle, notes);
    const guardrails = deriveEvidenceGuardrails(packet);
    packet.evidence_guardrails = guardrails;
    baseline = {...deterministicReport(packet), evidence_guardrails: guardrails.notes};
  } catch (e) {
    return reply({ error: safeMessage(e, 'Telemetry preprocessing failed.') }, 400);
  }

  if (action === 'base') {
    return reply({
      ...baseline,
      metrics: packet.metrics,
      mode: 'baseline',
      ai_status: 'pending',
      web_status: 'pending',
      web_grounding: null
    });
  }

  // Enrichment MUST NEVER erase the valid baseline report.
  try {
    const tavilyKey = process.env.TAVILY_API_KEY || '';
    const nebiusKey = process.env.NEBIUS_API_KEY || '';
    const model = process.env.NEBIUS_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

    const [grounding, ai] = await Promise.all([
      tavilyKey ? tavilySafe(tavilyKey, groundingQuery(vehicle, packet)) : Promise.resolve(null),
      nebiusKey ? nemotronSafe(nebiusKey, model, packet) : Promise.resolve(null)
    ]);

    const report = ai?.report || baseline;
    return reply({
      ...report,
      metrics: packet.metrics,
      model,
      mode: ai?.ok ? 'live' : 'fallback',
      ai_status: ai?.ok ? 'live' : (nebiusKey ? 'fallback' : 'not-configured'),
      ai_note: ai?.note || null,
      web_status: grounding?.sources?.length ? 'live' : (tavilyKey ? 'unavailable' : 'not-configured'),
      web_grounding: grounding || null
    });
  } catch (e) {
    // Always HTTP 200 with the forensic baseline.
    return reply({
      ...baseline,
      metrics: packet.metrics,
      mode: 'fallback',
      ai_status: 'fallback',
      ai_note: safeMessage(e, 'External enrichment unavailable this run.'),
      web_status: 'unavailable',
      web_grounding: null
    });
  }
};

function reply(data, status = 200) {
  let body;
  try { body = JSON.stringify(data); }
  catch { body = '{"error":"Response serialization failed."}'; status = 500; }
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}
function safeMessage(e, fallback='Error') {
  return String(e?.message || e || fallback).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,240);
}
function parseCSV(text) {
  const matrix=[]; let row=[], cell='', quoted=false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (c==='"') { if (quoted && text[i+1]==='"') { cell+='"'; i++; } else quoted=!quoted; }
    else if (c===',' && !quoted) { row.push(cell.trim()); cell=''; }
    else if ((c==='\n'||c==='\r') && !quoted) { if(c==='\r'&&text[i+1]==='\n')i++; row.push(cell.trim()); if(row.some(Boolean))matrix.push(row); row=[]; cell=''; }
    else cell+=c;
  }
  if(cell.length||row.length){row.push(cell.trim());matrix.push(row)}
  const headers=(matrix.shift()||[]).map((h,i)=>h||`column_${i+1}`);
  return matrix.map(cols=>Object.fromEntries(headers.map((h,i)=>[h,cols[i]??''])));
}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null}
function median(a){const x=[...a].sort((p,q)=>p-q),m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2}
function numericProfiles(rows){
  const out=[];
  for(const h of Object.keys(rows[0]||{})){
    const vals=rows.map(r=>num(r[h])).filter(v=>v!==null);
    if(vals.length<Math.max(3,rows.length*.35))continue;
    const med=median(vals), dev=vals.map(v=>Math.abs(v-med)), mad=median(dev)||0;
    const anomalies=rows.map((r,i)=>({i,v:num(r[h])})).filter(x=>x.v!==null).map(x=>({row:x.i,value:x.v,score:mad?0.6745*Math.abs(x.v-med)/mad:0})).filter(x=>x.score>=3.5).sort((a,b)=>b.score-a.score).slice(0,8);
    out.push({name:h,count:vals.length,min:Math.min(...vals),max:Math.max(...vals),mean:vals.reduce((a,b)=>a+b,0)/vals.length,median:med,mad,anomalies});
  }
  return out;
}
function detectIncidents(rows, profiles){
  const score=new Map();
  const add=(i,s,r)=>{const v=score.get(i)||{score:0,reasons:[]};v.score+=s;v.reasons.push(r);score.set(i,v)};
  rows.forEach((r,i)=>{for(const [k,v] of Object.entries(r)){const key=k.toLowerCase(), text=String(v).toLowerCase(), n=num(v);
    if(/crash|cutout|cut_out|emergency|critical/.test(key)&&n!==null&&n>0)add(i,8,`${k}=${v}`);
    if(/alert|error|warning|event|state/.test(key)&&text&&!/^(0|false|none|nan|null)$/.test(text))add(i,4,`${k}: ${v}`);
    if(/battery.*(min|end)/.test(key)&&n!==null&&n<=10)add(i,4,`${k}=${v}`);
    if(/wifi|rssi|signal/.test(key)&&n!==null&&n<=-80)add(i,2,`${k}=${v}`);
    if(/angle/.test(key)&&n!==null&&n>0)add(i,5,`${k}=${v}`);
  }});
  profiles.forEach(p=>p.anomalies.slice(0,4).forEach(a=>add(a.row,Math.min(4,a.score/2),`${p.name} statistical outlier (${a.value})`)));
  return [...score.entries()].map(([row,v])=>({row,...v})).sort((a,b)=>b.score-a.score).slice(0,12);
}
function buildEvidencePacket(rows, profiles, incidents, vehicle, notes){
  const top=[...profiles].sort((a,b)=>Math.max(...b.anomalies.map(x=>x.score),0)-Math.max(...a.anomalies.map(x=>x.score),0)).slice(0,18);
  const incidentRows=incidents.map(x=>({row_index:x.row,score:round(x.score),reasons:x.reasons,values:pickInteresting(rows[x.row])}));
  return {vehicle,notes,metrics:{rows:rows.length,numeric_columns:profiles.length,anomaly_count:profiles.reduce((n,p)=>n+p.anomalies.length,0),incident_rows:incidents.length},signals:top.map(p=>({name:p.name,min:p.min,max:p.max,mean:round(p.mean),median:round(p.median),anomalies:p.anomalies.slice(0,5)})),incident_rows:incidentRows};
}
function pickInteresting(r){return Object.fromEntries(Object.entries(r).filter(([k,v])=>v!==''&&(/date|time|product|model|battery|speed|alt|wifi|rssi|sat|gps|crash|alert|cut|emergency|angle|magnet|motor|temp|volt|current/i.test(k))).slice(0,28))}
function round(n){return Math.round(n*1000)/1000}
function deterministicReport(packet){
  const reasons=packet.incident_rows.flatMap(x=>x.reasons.map(r=>r.toLowerCase()));
  const cut=reasons.some(r=>r.includes('cut'));
  const batt=reasons.some(r=>r.includes('battery'));
  const risk=cut?'critical':batt?'high':'medium';
  const confidence=cut?.92:.72;
  return {
    risk_level:risk, confidence,
    executive_summary:cut?'The telemetry contains explicit motor cut-out or emergency-state evidence. The strongest explanation is an abrupt propulsion shutdown rather than progressive battery depletion; radio, GPS and magnetic conditions remain secondary hypotheses unless higher-frequency logs show a preceding control-link failure.':'The telemetry contains abnormal safety indicators that justify a focused incident review. Deterministic preprocessing found multiple outliers and event-coded rows.',
    likely_causes:cut?[{cause:'Propulsion / motor cut-out event',confidence:.94,why:'Explicit cut-out and emergency-coded telemetry is present in the incident rows.'},{cause:'Flight-control protective shutdown',confidence:.55,why:'An emergency state can accompany protective logic, but the summary CSV cannot establish the initiating mechanism.'},{cause:'Battery-induced shutdown',confidence:.23,why:'Battery values around the primary event do not by themselves indicate progressive depletion.'}]:[{cause:'Telemetry safety event',confidence:.72,why:'Event-coded incident rows are present.'},{cause:'Power or control anomaly',confidence:.46,why:'Multiple safety-related numeric or categorical signals were flagged.'}],
    evidence:packet.incident_rows.slice(0,6).map(x=>({signal:`Row ${x.row_index}`,observation:x.reasons.join('; '),weight:x.score>=8?'high':'medium'})),
    timeline:[{phase:'Baseline',finding:'Normal and abnormal records are profiled using the same schema.'},{phase:'Deviation',finding:`The anomaly engine identified ${packet.metrics.anomaly_count} robust numeric outliers across ${packet.metrics.numeric_columns} numeric signals.`},{phase:'Safety event',finding:`${packet.metrics.incident_rows} rows contain elevated incident evidence.`},{phase:'Investigation',finding:'The compact evidence packet can be enriched by Nemotron without controlling report availability.'}],
    next_actions:['Inspect the raw high-frequency log around the top-ranked incident timestamp.','Check power train, propellers and motor controllers before another flight.','Compare firmware-specific warnings with official manufacturer documentation.','Preserve the original log file and hash it before deeper forensic work.']
  };
}
function primaryEventRows(packet){
  const cut=(packet.incident_rows||[]).filter(r=>Number(r.values?.cutout_episodes||0)>0 || /cut.?out|coupure moteurs/i.test(String(r.values?.alert_names||'')+' '+(r.reasons||[]).join(' ')));
  return cut.length?cut:(packet.incident_rows||[]).slice(0,3);
}
function fieldNums(rows, key){return rows.map(r=>Number(r.values?.[key])).filter(Number.isFinite)}
function minOrNull(a){return a.length?Math.min(...a):null}
function maxOrNull(a){return a.length?Math.max(...a):null}
function deriveEvidenceGuardrails(packet){
  const rows=primaryEventRows(packet);
  const magnetMax=maxOrNull(fieldNums(rows,'magneto_episodes'));
  const angleMax=maxOrNull(fieldNums(rows,'angle_episodes'));
  const critBattMax=maxOrNull(fieldNums(rows,'critical_batt_episodes'));
  const lowBattMax=maxOrNull(fieldNums(rows,'low_batt_episodes'));
  const batteryMin=minOrNull(fieldNums(rows,'battery_min_pct'));
  const wifiWorst=minOrNull(fieldNums(rows,'wifi_weakest_dbm'));
  const satMedianMin=minOrNull(fieldNums(rows,'sat_median'));
  const cutMax=maxOrNull(fieldNums(rows,'cutout_episodes'));
  const notes=[];
  const blocked=[];
  const capped={};
  if(cutMax!==null && cutMax>0) notes.push('Explicit motor cut-out is present in the target incident rows; propulsion shutdown evidence cannot be displaced by an unrelated unsupported hypothesis.');
  if(magnetMax===0){blocked.push('magnetic');notes.push('Magnetic cause blocked: magneto_episodes=0 across the target cut-out rows.');}
  if(angleMax===0){blocked.push('attitude');notes.push('Attitude/angle cause blocked: angle_episodes=0 across the target cut-out rows.');}
  if((critBattMax===0||critBattMax===null)&&(lowBattMax===0||lowBattMax===null)&&batteryMin!==null&&batteryMin>20){capped.battery_depletion=.25;notes.push(`Battery depletion confidence capped: no low/critical-battery episode in target rows and minimum battery is ${batteryMin}%.`);}
  if(wifiWorst!==null&&wifiWorst>-80){capped.radio=.30;notes.push(`Radio-link loss confidence capped: weakest target-event Wi-Fi is ${wifiWorst} dBm, above the -80 dBm incident threshold.`);}
  if(satMedianMin!==null&&satMedianMin>=8){capped.gps=.25;notes.push(`GPS-loss confidence capped: target-event median satellite count is at least ${satMedianMin}.`);}
  return {target_rows:rows.map(r=>r.row_index),blocked_domains:blocked,confidence_caps:capped,notes};
}
function hypothesisDomain(text){
  const t=String(text||'').toLowerCase();
  if(/magnet|compass/.test(t))return 'magnetic';
  if(/angle|attitude|tilt|orientation/.test(t))return 'attitude';
  if(/gps|satellite|gnss/.test(t))return 'gps';
  if(/wifi|radio|link loss|rssi|signal loss/.test(t))return 'radio';
  if(/battery|low voltage|deplet|critical power/.test(t))return 'battery';
  if(/motor|propulsion|esc|cut.?out|shutdown/.test(t))return 'propulsion';
  return 'other';
}
function severityRank(r){return ({low:0,medium:1,high:2,critical:3})[String(r||'').toLowerCase()]??0}
function applyEvidenceGuardrails(report, packet, fallback){
  const g=packet.evidence_guardrails||deriveEvidenceGuardrails(packet);
  let filtered=0;
  let causes=(report.likely_causes||[]).map(c=>({...c}));
  const safe=[];
  for(const c of causes){
    const text=`${c.cause||''} ${c.why||''}`;
    const d=hypothesisDomain(text);
    if((g.blocked_domains||[]).includes(d)){filtered++;continue;}
    let cap=null;
    if(d==='radio')cap=g.confidence_caps?.radio;
    if(d==='gps')cap=g.confidence_caps?.gps;
    if(d==='battery' && /deplet|low battery|critical battery|exhaust|empty|state of charge/i.test(text))cap=g.confidence_caps?.battery_depletion;
    if(Number.isFinite(cap) && Number(c.confidence)>cap){c.confidence=cap; c.why=`${c.why} Confidence capped by contradictory/absent target-event telemetry.`.slice(0,320);filtered++;}
    safe.push(c);
  }
  const hasPropulsion=safe.some(c=>hypothesisDomain(`${c.cause} ${c.why}`)==='propulsion');
  if(!hasPropulsion && fallback.likely_causes?.[0])safe.push({...fallback.likely_causes[0]});
  for(const c of fallback.likely_causes||[]){if(safe.length>=3)break;if(!safe.some(x=>x.cause===c.cause))safe.push({...c});}
  safe.sort((a,b)=>(b.confidence||0)-(a.confidence||0));
  report.likely_causes=safe.slice(0,3);
  if(severityRank(report.risk_level)<severityRank(fallback.risk_level)){report.risk_level=fallback.risk_level;report.confidence=Math.max(report.confidence||0,fallback.confidence||0);filtered++;}
  if(filtered>0){
    report.executive_summary=fallback.executive_summary+' Nemotron hypotheses were post-validated against target-event telemetry guardrails.';
    report.evidence=fallback.evidence;
  }
  report.evidence_guardrails=g.notes||[];
  report.guardrail_filtered=filtered;
  return report;
}
function groundingQuery(vehicle, packet){
  const target=primaryEventRows(packet);
  const terms=target.flatMap(x=>x.reasons||[]).join(' ').match(/cut.?out|motor|propulsion|emergency|battery|gps|wifi|magnet/gi)?.slice(0,4).join(' ')||'motor cut-out emergency propulsion';
  return `${vehicle} ${terms} official documentation troubleshooting`;
}
async function tavilySafe(key, query){
  const c=new AbortController(), timer=setTimeout(()=>c.abort(),2500);
  try{
    const r=await fetch('https://api.tavily.com/search',{method:'POST',signal:c.signal,headers:{'content-type':'application/json','authorization':`Bearer ${key}`},body:JSON.stringify({query,search_depth:'basic',max_results:3,include_answer:false})});
    const raw=await r.text(); if(!r.ok)return null;
    let j; try{j=JSON.parse(raw)}catch{return null}
    return {query,sources:(j.results||[]).slice(0,3).map(x=>({title:String(x.title||'Source').slice(0,180),url:String(x.url||'')})).filter(x=>/^https?:\/\//.test(x.url))};
  }catch{return null}finally{clearTimeout(timer)}
}
async function nemotronSafe(key, model, packet){
  // Nemotron-3 reasons by default. For this compact forensic synthesis we want
  // the final answer, not a long hidden reasoning trace consuming max_tokens.
  const c=new AbortController(), timer=setTimeout(()=>c.abort(),12000);
  const base=(process.env.NEBIUS_BASE_URL||'https://api.tokenfactory.nebius.com/v1').replace(/\/$/,'');
  const fallback=deterministicReport(packet);
  const system=`You are AeroSage. Use only supplied telemetry evidence. EVIDENCE GUARDRAILS ARE BINDING: never rank a hypothesis as likely when the supplied guardrails mark that domain unsupported or contradicted. You may mention contradicted domains only as ruled out. Do not output JSON or markdown. Return concise pipe-delimited lines only:\nRISK|high|0.78\nSUMMARY|conclusion\nCAUSE|0.65|cause|why\nEVIDENCE|high|signal|observation\nTIMELINE|phase|finding\nACTION|action`;
  const user=`Vehicle: ${packet.vehicle||'unknown'}\nGoal: ${packet.notes||'incident review'}\nEvidence: ${JSON.stringify(packet)}\nBinding guardrails: ${JSON.stringify(packet.evidence_guardrails||{})}\nReturn 1 RISK, 1 SUMMARY, 2-3 CAUSE, 3-5 EVIDENCE, 3-5 TIMELINE, 3-5 ACTION lines. Keep every line short. Do not override a zero-event guardrail.`;
  try{
    const r=await fetch(`${base}/chat/completions`,{
      method:'POST',
      signal:c.signal,
      headers:{
        'content-type':'application/json',
        'authorization':`Bearer ${key}`
      },
      body:JSON.stringify({
        model,
        messages:[
          {role:'system',content:system},
          {role:'user',content:user}
        ],
        temperature:0.2,
        top_p:0.95,
        max_tokens:1800,
        chat_template_kwargs:{
          enable_thinking:false
        }
      })
    });
    const raw=await r.text();
    if(!r.ok)return {ok:false,note:`Nebius HTTP ${r.status}`};

    const content=extractContent(raw).trim();
    if(!content)return {ok:false,note:'Nebius returned no final assistant text.'};

    const recognized=content.split(/\r?\n/).filter(line=>/^(RISK|SUMMARY|CAUSE|EVIDENCE|TIMELINE|ACTION)\|/i.test(line.trim()));
    const hasRisk=recognized.some(line=>/^RISK\|/i.test(line.trim()));
    const hasSummary=recognized.some(line=>/^SUMMARY\|/i.test(line.trim()));
    const causeCount=recognized.filter(line=>/^CAUSE\|/i.test(line.trim())).length;
    const evidenceCount=recognized.filter(line=>/^EVIDENCE\|/i.test(line.trim())).length;

    if(!hasRisk || !hasSummary || causeCount<2 || evidenceCount<3){
      return {ok:false,note:`Nemotron answered, but the structured report was incomplete (${recognized.length} recognized lines). Baseline preserved.`};
    }

    const parsed=parseLines(content,fallback);
    const checked=applyEvidenceGuardrails(parsed, packet, fallback);
    return {ok:true,report:checked,note:checked.guardrail_filtered?`Evidence guardrails filtered ${checked.guardrail_filtered} unsupported AI claim(s).`:null};
  }catch(e){
    return {ok:false,note:safeMessage(e,'Nebius unavailable this run.')}
  }finally{
    clearTimeout(timer)
  }
}
function extractContent(raw){
  try{const j=JSON.parse(raw);const c=j?.choices?.[0]?.message?.content;if(typeof c==='string')return c}catch{}
  const m=/"content"\s*:\s*"/.exec(raw); if(!m)return '';
  let i=m.index+m[0].length,out='',esc=false;
  for(;i<raw.length;i++){const ch=raw[i];if(esc){if(ch==='n')out+='\n';else if(ch==='r')out+='\r';else if(ch==='t')out+='\t';else out+=ch;esc=false;continue}if(ch==='\\'){esc=true;continue}if(ch==='"')break;out+=ch}
  return out;
}
function parseLines(content,fallback){
  const report={...fallback,likely_causes:[],evidence:[],timeline:[],next_actions:[]};let risk=false,summary=false;
  for(const raw of content.split(/\r?\n/)){const p=raw.trim().replace(/^[-*]\s*/,'').split('|').map(x=>x.trim());const tag=(p.shift()||'').toUpperCase();
    if(tag==='RISK'&&p.length>=2){if(['low','medium','high','critical'].includes(p[0].toLowerCase()))report.risk_level=p[0].toLowerCase();const c=Number(p[1]);if(Number.isFinite(c))report.confidence=Math.max(0,Math.min(1,c));risk=true}
    else if(tag==='SUMMARY'&&p.length){report.executive_summary=p.join(' | ').slice(0,700);summary=true}
    else if(tag==='CAUSE'&&p.length>=3&&report.likely_causes.length<3){const c=Number(p[0]);report.likely_causes.push({cause:p[1].slice(0,160),confidence:Number.isFinite(c)?Math.max(0,Math.min(1,c)):.5,why:p.slice(2).join(' | ').slice(0,320)})}
    else if(tag==='EVIDENCE'&&p.length>=3&&report.evidence.length<5){report.evidence.push({weight:['high','medium','low'].includes(p[0].toLowerCase())?p[0].toLowerCase():'medium',signal:p[1].slice(0,160),observation:p.slice(2).join(' | ').slice(0,320)})}
    else if(tag==='TIMELINE'&&p.length>=2&&report.timeline.length<5)report.timeline.push({phase:p[0].slice(0,120),finding:p.slice(1).join(' | ').slice(0,320)});
    else if(tag==='ACTION'&&p.length&&report.next_actions.length<5)report.next_actions.push(p.join(' | ').slice(0,220));
  }
  if(!risk){report.risk_level=fallback.risk_level;report.confidence=fallback.confidence}if(!summary)report.executive_summary=fallback.executive_summary;if(report.likely_causes.length<2)report.likely_causes=fallback.likely_causes;if(report.evidence.length<3)report.evidence=fallback.evidence;if(report.timeline.length<3)report.timeline=fallback.timeline;if(report.next_actions.length<3)report.next_actions=fallback.next_actions;return report;
}
