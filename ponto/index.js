'use strict';

/**
 * Módulo Ponto — registro de ponto por celular (geolocalização, trava de almoço,
 * relatório de horas extras, lançamentos e login do funcionário por email+senha).
 *
 * Padrão igual aos outros módulos: exporta routes(readBody) -> handle(req,res,urlObj).
 * Serve frontend em /ponto/ (funcionário) e /ponto/admin.html (gestor).
 * Banco: Supabase próprio (REST), via variáveis PONTO_*.
 *
 * Variáveis de ambiente no Render:
 *   PONTO_SUPABASE_URL          (Project Settings > API)
 *   PONTO_SUPABASE_SERVICE_KEY  (service_role — secret)
 *   PONTO_ADMIN_TOKEN           (senha do painel admin)
 *   PONTO_SESSION_SECRET        (opcional; se não setar, usa o PONTO_ADMIN_TOKEN)
 *
 * Não tem cron nem dependência nova (usa node-fetch + crypto nativo).
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const fetch  = require('node-fetch');

const ADMIN_TOKEN    = process.env.PONTO_ADMIN_TOKEN || 'troque-este-token';
const SESSION_SECRET = process.env.PONTO_SESSION_SECRET || ADMIN_TOKEN;
const SB_URL = (process.env.PONTO_SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.PONTO_SUPABASE_SERVICE_KEY || '';

// Foto aleatória (anti-GPS falso). Probabilidade por tipo de batida.
const FOTO_PROB_ENTRADA = parseFloat(process.env.PONTO_FOTO_PROB_ENTRADA || '0.6');
const FOTO_PROB_OUTROS  = parseFloat(process.env.PONTO_FOTO_PROB_OUTROS  || '0.25');
const FOTO_SEED = process.env.PONTO_FOTO_SEED || SESSION_SECRET;
const FOTO_MAX_BYTES = 350 * 1024; // teto da foto recebida (~350KB)

// ── Helpers HTTP locais ───────────────────────────────────────────────
function json(res, code, body){ res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(body)); }
function notFound(res){ return json(res, 404, { error: 'not found' }); }

// IP real de quem fez a requisição (Render fica atrás de proxy → x-forwarded-for).
function ipDe(req){
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || '';
}
// Decide de forma DETERMINÍSTICA se uma batida pede foto.
// Mesmo (funcionário, dia, tipo) sempre dá o mesmo resultado → não dá pra recarregar e escapar.
function precisaFoto(fid, data, tipo){
  if(!tipo) return false;
  const h = crypto.createHash('sha256').update(`${fid}|${data}|${tipo}|${FOTO_SEED}`).digest();
  const r = h.readUInt32BE(0) / 0xFFFFFFFF; // 0..1 estável
  const prob = tipo === 'entrada' ? FOTO_PROB_ENTRADA : FOTO_PROB_OUTROS;
  return r < prob;
}
// IP está na lista da rede do galpão?
function naRede(ip, cfg){
  if(!ip || !cfg || !cfg.ips_galpao) return false;
  return cfg.ips_galpao.split(',').map(s=>s.trim()).filter(Boolean).includes(ip);
}

const PUBLIC_DIR = path.join(__dirname, '..', 'public', 'ponto');
function servir(res, relPath){
  const ext = path.extname(relPath).toLowerCase();
  const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
    '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon' }[ext] || 'application/octet-stream';
  const full = path.join(PUBLIC_DIR, relPath);
  if (!full.startsWith(PUBLIC_DIR)) return notFound(res);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return notFound(res);
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(full).pipe(res);
}

// ── Supabase REST ─────────────────────────────────────────────────────
const enc = encodeURIComponent;
function sbHeaders(extra){ return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(extra||{}) }; }
async function sbGet(q){
  const r = await fetch(`${SB_URL}/rest/v1/${q}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase GET ${q}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function sbInsert(table, body, prefer){
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, { method:'POST', headers: sbHeaders({ Prefer: prefer || 'return=representation' }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Supabase POST ${table}: ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function sbPatch(table, q, body){
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { method:'PATCH', headers: sbHeaders({ Prefer:'return=representation' }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Supabase PATCH ${table}: ${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function sbDelete(table, q){
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${q}`, { method:'DELETE', headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase DELETE ${table}: ${r.status} ${await r.text()}`);
  return true;
}
async function sbUpsert(table, onConflict, rows){
  const r = await fetch(`${SB_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method:'POST', headers: sbHeaders({ Prefer:'resolution=ignore-duplicates,return=minimal' }), body: JSON.stringify(rows) });
  if (!r.ok) throw new Error(`Supabase UPSERT ${table}: ${r.status} ${await r.text()}`);
  return true;
}

// ── Helpers de cálculo ────────────────────────────────────────────────
function dataSP(d = new Date()){ return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); }
function diaSemana(s){ const [y,m,d] = s.split('-').map(Number); return new Date(Date.UTC(y, m-1, d)).getUTCDay(); }
function diffMin(a,b){ return Math.round((new Date(b) - new Date(a)) / 60000); }
function haversine(lat1,lon1,lat2,lon2){
  const R=6371000, rad=x=>x*Math.PI/180;
  const dLat=rad(lat2-lat1), dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return Math.round(R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
}
function limitesMes(ano,mes){
  const inicio=`${ano}-${String(mes).padStart(2,'0')}-01`;
  const ultimo=new Date(Date.UTC(ano,mes,0)).getUTCDate();
  const fim=`${ano}-${String(mes).padStart(2,'0')}-${String(ultimo).padStart(2,'0')}`;
  return { inicio, fim };
}
function montarMomento(data, hhmm){ return new Date(`${data}T${hhmm}:00-03:00`).toISOString(); }
function horaSP(m){ return new Date(m).toLocaleTimeString('pt-BR',{ timeZone:'America/Sao_Paulo', hour:'2-digit', minute:'2-digit' }); }
const ORDEM=['entrada','saida_almoco','retorno_almoco','saida'];
const ROTULO={ entrada:'Entrada', saida_almoco:'Saída p/ almoço', retorno_almoco:'Retorno do almoço', saida:'Saída (fim do dia)' };
const TIPO_LABEL={ ferias:'Férias', folga:'Folga', atestado:'Atestado', feriado:'Feriado', completar:'Completado (escala)' };
const TIPO_LANC=['ferias','folga','atestado','feriado','completar'];

function minutosDia(bs){
  const g=t=>bs.find(b=>b.tipo===t);
  const ent=g('entrada'), sa=g('saida_almoco'), ra=g('retorno_almoco'), sai=g('saida');
  let trab=0, almoco=0;
  if(ent&&sa) trab+=diffMin(ent.momento,sa.momento);
  if(ra&&sai) trab+=diffMin(ra.momento,sai.momento);
  if(ent&&sai&&!sa&&!ra) trab=diffMin(ent.momento,sai.momento);
  if(sa&&ra) almoco=diffMin(sa.momento,ra.momento);
  return { trab, almoco, completo: !!(ent&&sai) };
}
function agregar(batidasPorDia, lancPorData, escalaDe, almocoMin, todasDatas){
  const base = (todasDatas && todasDatas.length) ? todasDatas : [...new Set([...Object.keys(batidasPorDia), ...Object.keys(lancPorData)])].sort();
  let trabTotal=0, espTotal=0, extras=0, deficit=0, extrasSabado=0, almocosCurtos=0;
  const detalhe=[];
  for(const dia of base){
    const dow=diaSemana(dia), abono=lancPorData[dia];
    const esc=escalaDe(dia); const esp=esc.jornada_min[String(dow)] ?? 0; const tol=esc.tolerancia_min ?? 0;
    const arr=batidasPorDia[dia]||[];
    const temBatida=arr.length>0;
    const real = temBatida || !!abono;
    const horarios={}; for(const t of ORDEM){ const x=arr.find(y=>y.tipo===t); horarios[t]=x?horaSP(x.momento):''; }
    let trab=0, almoco=0, completo=true, saldo=0;
    if(abono){ trab=esp; saldo=0; }
    else if(temBatida){ const m=minutosDia(arr); trab=m.trab; almoco=m.almoco; completo=m.completo; saldo=trab-esp; }
    if(real){
      trabTotal+=trab; espTotal+=esp;
      if(!abono){
        if(saldo>tol) extras+=saldo; else if(saldo<-tol) deficit+=saldo;
        if(dow===6) extrasSabado+=trab;
        if(almoco>0 && almoco<almocoMin) almocosCurtos++;
      }
    }
    const saldoEf = (!real) ? 0 : (Math.abs(saldo)<=tol ? 0 : saldo);
    detalhe.push({ data:dia, dow, vazio:!real, trabalhado:trab, esperado:esp, saldo, saldo_efetivo:saldoEf, tol, almoco, completo, horarios, abono: abono?TIPO_LABEL[abono]:null });
  }
  return { detalhe, trabalhado:trabTotal, esperado:espTotal, saldo:trabTotal-espTotal, extras, deficit, extras_sabado:extrasSabado, almocos_curtos:almocosCurtos };
}

// ── Senha (scrypt) e token de sessão ──────────────────────────────────
function hashSenha(senha){
  const salt=crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(String(senha),salt,32).toString('hex')}`;
}
function conferirSenha(senha, armazenado){
  if(!armazenado || !armazenado.includes(':')) return false;
  const [salt,h]=armazenado.split(':');
  const c=crypto.scryptSync(String(senha),salt,32).toString('hex');
  try{ return crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(c,'hex')); }catch{ return false; }
}
function gerarToken(id){
  const p=`${id}.${Date.now()+1000*60*60*24*30}`;
  const sig=crypto.createHmac('sha256',SESSION_SECRET).update(p).digest('hex');
  return Buffer.from(p).toString('base64')+'.'+sig;
}
function verificarToken(token){
  try{
    const [b64,sig]=String(token).split('.');
    const p=Buffer.from(b64,'base64').toString();
    const e=crypto.createHmac('sha256',SESSION_SECRET).update(p).digest('hex');
    if(sig!==e) return null;
    const [id,exp]=p.split('.');
    if(Date.now()>Number(exp)) return null;
    return Number(id);
  }catch{ return null; }
}

// ── Acessos ao banco ──────────────────────────────────────────────────
async function getConfig(){ const a=await sbGet('config?id=eq.1&select=*'); return a[0]; }
// Resolve a escala vigente de cada funcionário numa data (pega a atribuição com vigência <= data mais recente)
async function montarEscalas(funcIds){
  const escalas=await sbGet('escalas?select=*');
  const emap={}; escalas.forEach(e=>emap[e.id]=e);
  let q='escala_funcionario?select=*&order=vigencia_inicio.asc';
  if(funcIds && funcIds.length) q+=`&funcionario_id=in.(${funcIds.join(',')})`;
  const atrs=await sbGet(q);
  const byFunc={}; atrs.forEach(a=>(byFunc[a.funcionario_id]=byFunc[a.funcionario_id]||[]).push(a));
  return (funcId, dia, fallback)=>{
    const list=byFunc[funcId]||[]; let chosen=null;
    for(const a of list){ if(String(a.vigencia_inicio)<=dia) chosen=a; }
    const e=chosen && emap[chosen.escala_id];
    return e ? { jornada_min:e.jornada_min, tolerancia_min:e.tolerancia_min ?? 0, nome:e.nome, turnos:e.turnos } : fallback;
  };
}
async function buscarPorEmail(email){ const a=await sbGet(`funcionarios?email=ilike.${enc(email)}&ativo=eq.true&select=*`); return a[0]||null; }
async function funcionarioDoToken(token){ const id=verificarToken(token); if(!id) return null; const a=await sbGet(`funcionarios?id=eq.${id}&ativo=eq.true&select=*`); return a[0]||null; }
function adminOk(req){ return req.headers['x-admin-token']===ADMIN_TOKEN; }
function naoAutorizado(res){ json(res,401,{erro:'Não autorizado.'}); return true; }

// ── Rotas ─────────────────────────────────────────────────────────────
function routes(readBody){
  return async function handle(req, res, urlObj){
    const { method } = req;
    const p = urlObj.pathname;
    if (!p.startsWith('/ponto')) return false;

    // Frontend estático
    if (method==='GET' && (p==='/ponto' || p==='/ponto/')) { servir(res,'index.html'); return true; }
    if (method==='GET' && (p==='/ponto/admin' || p==='/ponto/admin.html')) { servir(res,'admin.html'); return true; }
    if (method==='GET' && (p==='/ponto/favicon.png' || p==='/ponto/favicon.ico')) { servir(res,'favicon.png'); return true; }

    try {
      // ───────── FUNCIONÁRIO ─────────
      if (method==='POST' && p==='/ponto/login') {
        const b=await readBody(req); const email=String(b.email||'').trim().toLowerCase();
        if(!email){ json(res,400,{erro:'Informe o email.'}); return true; }
        const f=await buscarPorEmail(email);
        if(!f){ json(res,401,{erro:'Email não encontrado. Confirme com o gestor.'}); return true; }
        if(!f.senha_definida || !f.senha_hash){ json(res,200,{precisa_criar_senha:true,nome:f.nome}); return true; }
        if(!b.senha){ json(res,400,{erro:'Informe a senha.'}); return true; }
        if(!conferirSenha(b.senha,f.senha_hash)){ json(res,401,{erro:'Senha incorreta.'}); return true; }
        json(res,200,{ok:true,token:gerarToken(f.id),nome:f.nome,cargo:f.cargo,setor:f.setor}); return true;
      }

      if (method==='POST' && p==='/ponto/criar-senha') {
        const b=await readBody(req); const email=String(b.email||'').trim().toLowerCase(); const senha=String(b.senha||'');
        if(senha.length<4){ json(res,400,{erro:'A senha precisa ter pelo menos 4 caracteres.'}); return true; }
        const f=await buscarPorEmail(email);
        if(!f){ json(res,401,{erro:'Email não encontrado. Confirme com o gestor.'}); return true; }
        if(f.senha_definida){ json(res,409,{erro:'Senha já criada. Faça login.'}); return true; }
        await sbPatch('funcionarios',`id=eq.${f.id}`,{senha_hash:hashSenha(senha),senha_definida:true});
        json(res,200,{ok:true,token:gerarToken(f.id),nome:f.nome,cargo:f.cargo,setor:f.setor}); return true;
      }

      if (method==='POST' && p==='/ponto/minhas-batidas') {
        const b=await readBody(req); const f=await funcionarioDoToken(b.token);
        if(!f){ json(res,401,{erro:'Sessão expirada. Faça login de novo.'}); return true; }
        const data=b.data||dataSP();
        const bs=await sbGet(`batidas?funcionario_id=eq.${f.id}&data=eq.${data}&select=*&order=momento.asc`);
        const cfg=await getConfig();
        const ap=await sbGet(`aprovacoes?funcionario_id=eq.${f.id}&data=eq.${data}&select=status&order=criado_em.desc&limit=1`);
        const sols=await sbGet(`solicitacoes_batida?funcionario_id=eq.${f.id}&data=eq.${data}&status=eq.pendente&select=tipo,momento`);
        const proximo=ORDEM[bs.length]||null;
        json(res,200,{batidas:bs,proximo,rotulo:proximo?ROTULO[proximo]:null,almoco_minimo:cfg?cfg.almoco_minimo:60,aprovacao_status:ap[0]?ap[0].status:null,solicitacoes:sols,foto_requerida:proximo?precisaFoto(f.id,data,proximo):false}); return true;
      }

      // Funcionário lança uma batida que esqueceu (sujeita a aprovação; ignora GPS/raio)
      if (method==='POST' && p==='/ponto/solicitar-batida') {
        const b=await readBody(req); const f=await funcionarioDoToken(b.token);
        if(!f){ json(res,401,{erro:'Sessão expirada. Faça login de novo.'}); return true; }
        const { data, tipo, hora, justificativa } = b;
        if(!data || !ORDEM.includes(tipo) || !/^\d{1,2}:\d{2}$/.test(hora||'')){ json(res,400,{erro:'Preencha data, tipo e hora corretamente.'}); return true; }
        if(!justificativa || String(justificativa).trim().length<10){ json(res,400,{erro:'Explique o motivo (mínimo 10 caracteres).'}); return true; }
        await sbInsert('solicitacoes_batida',{funcionario_id:f.id,data,tipo,momento:montarMomento(data,hora),justificativa:String(justificativa).trim(),status:'pendente'},'return=minimal');
        json(res,200,{ok:true}); return true;
      }

      if (method==='POST' && p==='/ponto/bater-ponto') {
        const b=await readBody(req); const f=await funcionarioDoToken(b.token);
        if(!f){ json(res,401,{erro:'Sessão expirada. Faça login de novo.'}); return true; }
        const { latitude, longitude, justificativa } = b;
        if(typeof latitude!=='number'||typeof longitude!=='number'){ json(res,400,{erro:'Localização não recebida. Ative o GPS e tente de novo.'}); return true; }
        const cfg=await getConfig();
        if(!cfg){ json(res,500,{erro:'Local de trabalho não configurado (tabela config).'}); return true; }
        const dist=haversine(latitude,longitude,cfg.latitude,cfg.longitude);
        if(dist>cfg.raio_metros){ json(res,403,{erro:`Você está a ${dist} m do trabalho. É preciso estar a no máximo ${cfg.raio_metros} m para bater o ponto.`,distancia:dist}); return true; }
        const data=dataSP();
        const bs=await sbGet(`batidas?funcionario_id=eq.${f.id}&data=eq.${data}&select=*&order=momento.asc`);
        const idx=bs.length, tipo=ORDEM[idx];
        if(!tipo){ json(res,409,{erro:'Os 4 pontos de hoje já foram registrados.'}); return true; }
        const agora=new Date().toISOString();
        let justUsada=null;
        if(tipo==='retorno_almoco'){
          const sa=bs.find(x=>x.tipo==='saida_almoco');
          if(sa){
            const lunch=diffMin(sa.momento,agora);
            if(lunch<cfg.almoco_minimo){
              if(!justificativa){ json(res,422,{requer_justificativa:true,minutos:lunch,minimo:cfg.almoco_minimo,erro:`O almoço teria só ${lunch} min (mínimo ${cfg.almoco_minimo} min). Justifique para registrar.`}); return true; }
              if(String(justificativa).trim().length<30){ json(res,400,{erro:'A justificativa precisa ter pelo menos 30 caracteres.'}); return true; }
              justUsada=String(justificativa).trim();
              await sbInsert('aprovacoes',{funcionario_id:f.id,data,minutos_almoco:lunch,justificativa:justUsada,status:'pendente'},'return=minimal');
            }
          }
        }
        const fotoReq = precisaFoto(f.id, data, tipo);
        const ip = ipDe(req);
        const temFoto = fotoReq && typeof b.foto==='string' && b.foto.startsWith('data:image') && b.foto.length <= FOTO_MAX_BYTES;
        const ins = await sbInsert('batidas',{funcionario_id:f.id,tipo,momento:agora,data,latitude,longitude,distancia_metros:dist,justificativa:justUsada,
          ip, na_rede:naRede(ip,cfg), tem_foto:temFoto, foto_pulada: fotoReq && !temFoto},'return=representation');
        const novaId = Array.isArray(ins) && ins[0] ? ins[0].id : (ins && ins.id);
        if(temFoto && novaId){ try{ await sbInsert('fotos_batida',{batida_id:novaId,imagem:b.foto},'return=minimal'); }catch(e){ /* foto é best-effort, não trava o ponto */ } }
        const prox=ORDEM[idx+1]||null;
        json(res,200,{ok:true,tipo,rotulo:ROTULO[tipo],distancia:dist,pendente_aprovacao:!!justUsada,proximo:prox,proximo_rotulo:prox?ROTULO[prox]:null}); return true;
      }

      if (method==='POST' && p==='/ponto/meu-historico') {
        const b=await readBody(req); const f=await funcionarioDoToken(b.token);
        if(!f){ json(res,401,{erro:'Sessão expirada. Faça login de novo.'}); return true; }
        const { inicio, fim }=limitesMes(+b.ano,+b.mes);
        const cfg=await getConfig();
        const fb={jornada_min:cfg.jornada_min, tolerancia_min:cfg.tolerancia_min||0};
        const bs=await sbGet(`batidas?funcionario_id=eq.${f.id}&data=gte.${inicio}&data=lte.${fim}&select=*&order=momento.asc`);
        const lancs=await sbGet(`lancamentos?funcionario_id=eq.${f.id}&data=gte.${inicio}&data=lte.${fim}&select=data,tipo`);
        const porDia={}; for(const x of bs)(porDia[x.data]=porDia[x.data]||[]).push(x);
        const lmap={}; for(const l of lancs) lmap[l.data]=l.tipo;
        const escDe=await montarEscalas([f.id]);
        const todasDatas=[]; let dd=new Date(inicio+'T12:00:00Z'); const fdd=new Date(fim+'T12:00:00Z');
        while(dd<=fdd){ todasDatas.push(dd.toISOString().slice(0,10)); dd.setUTCDate(dd.getUTCDate()+1); }
        const r=agregar(porDia,lmap,(dia)=>escDe(f.id,dia,fb),cfg.almoco_minimo,todasDatas);
        json(res,200,{inicio,fim,...r}); return true;
      }

      // ───────── ADMIN ─────────
      if (method==='POST' && p==='/ponto/admin/login') {
        const b=await readBody(req);
        if(b.token===ADMIN_TOKEN){ json(res,200,{ok:true}); return true; }
        json(res,401,{erro:'Token inválido.'}); return true;
      }

      if (method==='GET' && p==='/ponto/admin/funcionarios') {
        if(!adminOk(req)) return naoAutorizado(res);
        const data=await sbGet('funcionarios?select=id,nome,matricula,email,cargo,setor,ativo,senha_definida&order=nome.asc');
        json(res,200,data); return true;
      }

      if (method==='POST' && p==='/ponto/admin/funcionarios') {
        if(!adminOk(req)) return naoAutorizado(res);
        const b=await readBody(req); const { nome, matricula, email, cargo, setor }=b;
        if(!nome||!matricula||!email){ json(res,400,{erro:'Nome, matrícula e email são obrigatórios.'}); return true; }
        try{
          const ins=await sbInsert('funcionarios',{nome,matricula:String(matricula),email:String(email).trim().toLowerCase(),cargo,setor,senha_definida:false});
          json(res,200,Array.isArray(ins)?ins[0]:ins);
        }catch(e){ json(res,400,{erro:'Não foi possível cadastrar (matrícula ou email já cadastrados?).'}); }
        return true;
      }

      if (method==='POST' && /^\/ponto\/admin\/funcionarios\/[^/]+\/reset-senha$/.test(p)) {
        if(!adminOk(req)) return naoAutorizado(res);
        const id=p.split('/')[4];
        await sbPatch('funcionarios',`id=eq.${enc(id)}`,{senha_hash:null,senha_definida:false});
        json(res,200,{ok:true}); return true;
      }

      // Editar cadastro existente (nome, matrícula, email, cargo, setor, ativo)
      if (method==='POST' && /^\/ponto\/admin\/funcionarios\/[^/]+$/.test(p)) {
        if(!adminOk(req)) return naoAutorizado(res);
        const id=p.split('/')[4]; const b=await readBody(req);
        const upd={};
        if(b.nome!==undefined)      upd.nome      = b.nome;
        if(b.matricula!==undefined) upd.matricula = String(b.matricula);
        if(b.email!==undefined)     upd.email     = String(b.email).trim().toLowerCase();
        if(b.cargo!==undefined)     upd.cargo     = b.cargo;
        if(b.setor!==undefined)     upd.setor     = b.setor;
        if(b.ativo!==undefined)     upd.ativo     = !!b.ativo;
        if(!Object.keys(upd).length){ json(res,400,{erro:'Nada para atualizar.'}); return true; }
        try{
          const r=await sbPatch('funcionarios',`id=eq.${enc(id)}`,upd);
          json(res,200,Array.isArray(r)?r[0]:r);
        }catch(e){ json(res,400,{erro:'Não foi possível salvar (matrícula ou email já em uso?).'}); }
        return true;
      }

      if (method==='GET' && p==='/ponto/admin/batidas') {
        if(!adminOk(req)) return naoAutorizado(res);
        const ini=urlObj.searchParams.get('inicio'), fim=urlObj.searchParams.get('fim'), fid=urlObj.searchParams.get('funcionario_id');
        let q=`batidas?select=*,funcionarios(nome,matricula)&data=gte.${ini}&data=lte.${fim}&order=data.asc,momento.asc`;
        if(fid) q+=`&funcionario_id=eq.${fid}`;
        json(res,200,await sbGet(q)); return true;
      }

      // Tratamento de ponto — dias com horários + resultado (1 funcionário)
      if (method==='GET' && p==='/ponto/admin/dias') {
        if(!adminOk(req)) return naoAutorizado(res);
        const fid=urlObj.searchParams.get('funcionario_id');
        const ini=urlObj.searchParams.get('inicio'), fim=urlObj.searchParams.get('fim');
        if(!fid){ json(res,400,{erro:'Selecione um funcionário.'}); return true; }
        const cfg=await getConfig();
        const fb={jornada_min:cfg.jornada_min, tolerancia_min:cfg.tolerancia_min||0, nome:'Padrão (sistema)', turnos:null};
        const escDe=await montarEscalas([fid]);
        const bs=await sbGet(`batidas?funcionario_id=eq.${fid}&data=gte.${ini}&data=lte.${fim}&select=*&order=momento.asc`);
        const lancs=await sbGet(`lancamentos?funcionario_id=eq.${fid}&data=gte.${ini}&data=lte.${fim}&select=data,tipo`);
        const porDia={}; for(const x of bs)(porDia[x.data]=porDia[x.data]||[]).push(x);
        const lmap={}; for(const l of lancs) lmap[l.data]=l.tipo;
        const aprovs=await sbGet(`aprovacoes?funcionario_id=eq.${fid}&data=gte.${ini}&data=lte.${fim}&select=data,status`);
        const apMap={}; for(const a of aprovs) apMap[a.data]=a.status;
        const sols=await sbGet(`solicitacoes_batida?funcionario_id=eq.${fid}&data=gte.${ini}&data=lte.${fim}&status=eq.pendente&select=data`);
        const solSet=new Set(sols.map(x=>x.data));
        const corrs=await sbGet(`correcoes_ponto?funcionario_id=eq.${fid}&data=gte.${ini}&data=lte.${fim}&select=data,tipo,hora_original`);
        const corrPorDia={}; for(const c of corrs){ (corrPorDia[c.data]=corrPorDia[c.data]||{})[c.tipo]=c.hora_original; }
        // todos os dias do intervalo
        const datas=[]; let dt=new Date(ini+'T12:00:00Z'); const fdt=new Date(fim+'T12:00:00Z');
        while(dt<=fdt){ datas.push(dt.toISOString().slice(0,10)); dt.setUTCDate(dt.getUTCDate()+1); }
        const dias=datas.map(data=>{
          const esc=escDe(fid,data,fb);
          const dow=diaSemana(data), esp=esc.jornada_min[String(dow)] ?? 0, tol=esc.tolerancia_min ?? 0, abono=lmap[data];
          const arr=porDia[data]||[];
          const horarios={}; for(const t of ORDEM){ const b=arr.find(x=>x.tipo===t); horarios[t]=b?horaSP(b.momento):''; }
          let trab, saldo;
          if(abono){ trab=esp; saldo=0; } else { const mm=minutosDia(arr); trab=mm.trab; saldo=trab-esp; }
          const vazio=(arr.length===0 && !abono);
          const saldoEf = vazio ? 0 : (Math.abs(saldo)<=tol ? 0 : saldo);
          const fotos = arr.filter(x=>x.tem_foto).map(x=>({tipo:x.tipo, id:x.id, na_rede:!!x.na_rede, hora:horarios[x.tipo]||''}));
          return { data, dow, escala:esc.nome, turnos:(esc.turnos&&esc.turnos[String(dow)])||null,
                   vazio, abono_tipo:abono||null, abono: abono?TIPO_LABEL[abono]:null,
                   aprovacao: apMap[data]||null, solicitacao: solSet.has(data),
                   horarios, trabalhado:trab, esperado:esp, saldo, saldo_efetivo:saldoEf, tol, fotos, correcoes: corrPorDia[data]||{} };
        });
        json(res,200,{dias}); return true;
      }

      // Salvar o dia inteiro: edita / cria / exclui as 4 batidas conforme os horários
      if (method==='POST' && p==='/ponto/admin/dia') {
        if(!adminOk(req)) return naoAutorizado(res);
        const b=await readBody(req); const { funcionario_id, data, horarios }=b;
        if(!funcionario_id || !data || !horarios){ json(res,400,{erro:'Dados incompletos.'}); return true; }
        const atuais=await sbGet(`batidas?funcionario_id=eq.${funcionario_id}&data=eq.${data}&select=id,tipo,momento`);
        const mapAtual={}; atuais.forEach(x=>mapAtual[x.tipo]=x);
        const corrs=await sbGet(`correcoes_ponto?funcionario_id=eq.${funcionario_id}&data=eq.${data}&select=tipo,hora_original`);
        const corrMap={}; corrs.forEach(c=>corrMap[c.tipo]=c.hora_original);
        for(const tipo of ORDEM){
          const raw=String(horarios[tipo]||'').trim();
          let val=''; if(/^\d{1,2}:\d{2}$/.test(raw)){ const [hh,mm]=raw.split(':'); val=`${hh.padStart(2,'0')}:${mm}`; }
          const ex=mapAtual[tipo];
          const oldHora = ex ? horaSP(ex.momento) : '';
          // aplica na tabela de batidas
          if(val){
            const momento=montarMomento(data,val);
            if(ex) await sbPatch('batidas',`id=eq.${ex.id}`,{momento});
            else   await sbInsert('batidas',{funcionario_id,tipo,momento,data},'return=minimal');
          } else if(ex){
            await sbDelete('batidas',`id=eq.${ex.id}`);
          }
          // registro de alteração (antigo vermelho / novo azul)
          const temCorr = Object.prototype.hasOwnProperty.call(corrMap,tipo);
          const original = temCorr ? corrMap[tipo] : oldHora;   // 1ª edição: original = valor batido
          if(val === original){
            if(temCorr){ await sbDelete('correcoes_ponto',`funcionario_id=eq.${funcionario_id}&data=eq.${data}&tipo=eq.${tipo}`); delete corrMap[tipo]; }
          } else if(!temCorr){
            await sbInsert('correcoes_ponto',{funcionario_id,data,tipo,hora_original:original},'return=minimal');
            corrMap[tipo]=original;
          }
        }
        json(res,200,{ok:true, correcoes:corrMap}); return true;
      }

      if (method==='GET' && p==='/ponto/admin/aprovacoes') {
        if(!adminOk(req)) return naoAutorizado(res);
        json(res,200,await sbGet('aprovacoes?select=*,funcionarios(nome,matricula)&status=eq.pendente&order=criado_em.asc')); return true;
      }

      // Solicitações de batida esquecida — pendentes
      if (method==='GET' && p==='/ponto/admin/solicitacoes') {
        if(!adminOk(req)) return naoAutorizado(res);
        json(res,200,await sbGet('solicitacoes_batida?select=*,funcionarios(nome,matricula)&status=eq.pendente&order=criado_em.asc')); return true;
      }
      if (method==='POST' && /^\/ponto\/admin\/solicitacoes\/[^/]+$/.test(p)) {
        if(!adminOk(req)) return naoAutorizado(res);
        const id=p.split('/')[4]; const b=await readBody(req);
        if(!['aprovado','rejeitado'].includes(b.status)){ json(res,400,{erro:'Status inválido.'}); return true; }
        const upd=await sbPatch('solicitacoes_batida',`id=eq.${enc(id)}`,{status:b.status,decidido_em:new Date().toISOString()});
        const s=Array.isArray(upd)?upd[0]:upd;
        if(b.status==='aprovado' && s){
          const ex=await sbGet(`batidas?funcionario_id=eq.${s.funcionario_id}&data=eq.${s.data}&tipo=eq.${s.tipo}&select=id`);
          if(ex[0]) await sbPatch('batidas',`id=eq.${ex[0].id}`,{momento:s.momento});
          else await sbInsert('batidas',{funcionario_id:s.funcionario_id,tipo:s.tipo,momento:s.momento,data:s.data,justificativa:'lançado pelo funcionário (aprovado)'},'return=minimal');
        }
        json(res,200,s); return true;
      }

      if (method==='POST' && /^\/ponto\/admin\/aprovacoes\/[^/]+$/.test(p)) {
        if(!adminOk(req)) return naoAutorizado(res);
        const id=p.split('/')[4]; const b=await readBody(req);
        if(!['aprovado','rejeitado'].includes(b.status)){ json(res,400,{erro:'Status inválido.'}); return true; }
        const upd=await sbPatch('aprovacoes',`id=eq.${enc(id)}`,{status:b.status,decidido_em:new Date().toISOString()});
        const ap=Array.isArray(upd)?upd[0]:upd;
        // Rejeitado: o almoço passa a contar como o mínimo (1h) — empurra o retorno
        if(b.status==='rejeitado' && ap){
          const cfg=await getConfig(); const min=cfg.almoco_minimo||60;
          const arr=await sbGet(`batidas?funcionario_id=eq.${ap.funcionario_id}&data=eq.${ap.data}&select=id,tipo,momento`);
          const sa=arr.find(x=>x.tipo==='saida_almoco'), ra=arr.find(x=>x.tipo==='retorno_almoco');
          if(sa && ra){
            const novo=new Date(new Date(sa.momento).getTime()+min*60000).toISOString();
            await sbPatch('batidas',`id=eq.${ra.id}`,{momento:novo});
          }
        }
        json(res,200,ap); return true;
      }

      if (method==='GET' && p==='/ponto/admin/lancamentos') {
        if(!adminOk(req)) return naoAutorizado(res);
        const ini=urlObj.searchParams.get('inicio'), fim=urlObj.searchParams.get('fim');
        let q='lancamentos?select=*,funcionarios(nome,matricula)&order=data.desc';
        if(ini) q+=`&data=gte.${ini}`; if(fim) q+=`&data=lte.${fim}`;
        json(res,200,await sbGet(q)); return true;
      }

      if (method==='POST' && p==='/ponto/admin/lancamentos') {
        if(!adminOk(req)) return naoAutorizado(res);
        const b=await readBody(req); const { funcionario_id, inicio, fim, tipo, observacao }=b;
        if(!funcionario_id||!inicio||!tipo){ json(res,400,{erro:'Funcionário, data e tipo são obrigatórios.'}); return true; }
        if(!TIPO_LANC.includes(tipo)){ json(res,400,{erro:'Tipo inválido.'}); return true; }
        const rows=[]; let d=new Date(inicio+'T12:00:00Z'); const fdt=new Date((fim||inicio)+'T12:00:00Z');
        while(d<=fdt){ rows.push({funcionario_id,data:d.toISOString().slice(0,10),tipo,observacao:observacao||null}); d.setUTCDate(d.getUTCDate()+1); }
        await sbUpsert('lancamentos','funcionario_id,data,tipo',rows);
        json(res,200,{ok:true,dias:rows.length}); return true;
      }

      if (method==='DELETE' && /^\/ponto\/admin\/lancamentos\/[^/]+$/.test(p)) {
        if(!adminOk(req)) return naoAutorizado(res);
        const id=p.split('/')[4];
        await sbDelete('lancamentos',`id=eq.${enc(id)}`);
        json(res,200,{ok:true}); return true;
      }

      // ───────── REDE DO GALPÃO (anti-GPS falso) ─────────
      if (method==='GET' && p==='/ponto/admin/rede') {
        if(!adminOk(req)) return naoAutorizado(res);
        const cfg=await getConfig();
        const ips=(cfg.ips_galpao||'').split(',').map(s=>s.trim()).filter(Boolean);
        const atual=ipDe(req);
        json(res,200,{ ips, ip_atual:atual, registrado: ips.includes(atual) }); return true;
      }
      if (method==='POST' && p==='/ponto/admin/rede') {
        if(!adminOk(req)) return naoAutorizado(res);
        const cfg=await getConfig();
        const ips=(cfg.ips_galpao||'').split(',').map(s=>s.trim()).filter(Boolean);
        const atual=ipDe(req);
        if(!atual){ json(res,400,{erro:'Não consegui ler o IP desta conexão.'}); return true; }
        if(!ips.includes(atual)) ips.push(atual);
        await sbPatch('config',`id=eq.1`,{ips_galpao:ips.join(',')});
        json(res,200,{ ok:true, ips, ip_atual:atual }); return true;
      }
      if (method==='POST' && p==='/ponto/admin/rede-remover') {
        if(!adminOk(req)) return naoAutorizado(res);
        const b=await readBody(req); const alvo=String(b.ip||'').trim();
        const cfg=await getConfig();
        const ips=(cfg.ips_galpao||'').split(',').map(s=>s.trim()).filter(Boolean).filter(x=>x!==alvo);
        await sbPatch('config',`id=eq.1`,{ips_galpao:ips.join(',')});
        json(res,200,{ ok:true, ips }); return true;
      }
      // Foto de uma batida (miniatura/ampliar no admin)
      if (method==='GET' && /^\/ponto\/admin\/foto\/[^/]+$/.test(p)) {
        if(!adminOk(req)) return naoAutorizado(res);
        const id=p.split('/')[4];
        const r=await sbGet(`fotos_batida?batida_id=eq.${enc(id)}&select=imagem,criado_em`);
        if(!r[0]){ json(res,404,{erro:'Foto não encontrada.'}); return true; }
        json(res,200,{ imagem:r[0].imagem, criado_em:r[0].criado_em }); return true;
      }


      if (method==='POST' && p==='/ponto/admin/lancamento-dia') {
        if(!adminOk(req)) return naoAutorizado(res);
        const b=await readBody(req); const { funcionario_id, data, tipo }=b;
        if(!funcionario_id || !data){ json(res,400,{erro:'Dados incompletos.'}); return true; }
        await sbDelete('lancamentos',`funcionario_id=eq.${funcionario_id}&data=eq.${data}`);
        if(tipo){
          if(!TIPO_LANC.includes(tipo)){ json(res,400,{erro:'Tipo inválido.'}); return true; }
          await sbInsert('lancamentos',{funcionario_id,data,tipo,observacao:null},'return=minimal');
        }
        json(res,200,{ok:true}); return true;
      }

      // ───────── ESCALAS ─────────
      if (method==='GET' && p==='/ponto/admin/escalas') {
        if(!adminOk(req)) return naoAutorizado(res);
        json(res,200,await sbGet('escalas?select=*&order=nome.asc')); return true;
      }
      if (method==='POST' && p==='/ponto/admin/escalas') {
        if(!adminOk(req)) return naoAutorizado(res);
        const b=await readBody(req);
        if(!b.nome || !b.jornada_min){ json(res,400,{erro:'Nome e jornada são obrigatórios.'}); return true; }
        const ins=await sbInsert('escalas',{ nome:b.nome, jornada_min:b.jornada_min, tolerancia_min: b.tolerancia_min ?? 10, turnos: b.turnos ?? null });
        json(res,200,Array.isArray(ins)?ins[0]:ins); return true;
      }
      if (method==='POST' && /^\/ponto\/admin\/escalas\/[^/]+$/.test(p)) {
        if(!adminOk(req)) return naoAutorizado(res);
        const id=p.split('/')[4]; const b=await readBody(req); const patch={};
        ['nome','jornada_min','tolerancia_min','turnos'].forEach(k=>{ if(b[k]!==undefined) patch[k]=b[k]; });
        const upd=await sbPatch('escalas',`id=eq.${enc(id)}`,patch);
        json(res,200,Array.isArray(upd)?upd[0]:upd); return true;
      }
      if (method==='DELETE' && /^\/ponto\/admin\/escalas\/[^/]+$/.test(p)) {
        if(!adminOk(req)) return naoAutorizado(res);
        const id=p.split('/')[4];
        await sbDelete('escala_funcionario',`escala_id=eq.${enc(id)}`);
        await sbDelete('escalas',`id=eq.${enc(id)}`);
        json(res,200,{ok:true}); return true;
      }

      // ───────── ATRIBUIÇÕES (escala vigente por funcionário) ─────────
      if (method==='GET' && p==='/ponto/admin/atribuicoes') {
        if(!adminOk(req)) return naoAutorizado(res);
        const fid=urlObj.searchParams.get('funcionario_id');
        let q='escala_funcionario?select=*,escalas(nome),funcionarios(nome)&order=vigencia_inicio.desc';
        if(fid) q+=`&funcionario_id=eq.${fid}`;
        json(res,200,await sbGet(q)); return true;
      }
      if (method==='POST' && p==='/ponto/admin/atribuicoes') {
        if(!adminOk(req)) return naoAutorizado(res);
        const b=await readBody(req); const { funcionario_ids, escala_id, vigencia_inicio }=b;
        if(!Array.isArray(funcionario_ids) || !funcionario_ids.length || !escala_id || !vigencia_inicio){
          json(res,400,{erro:'Selecione a escala, ao menos um funcionário e a data de início.'}); return true; }
        const rows=funcionario_ids.map(x=>({ funcionario_id:x, escala_id, vigencia_inicio }));
        await sbInsert('escala_funcionario',rows,'return=minimal');
        json(res,200,{ok:true,total:rows.length}); return true;
      }
      if (method==='DELETE' && /^\/ponto\/admin\/atribuicoes\/[^/]+$/.test(p)) {
        if(!adminOk(req)) return naoAutorizado(res);
        const id=p.split('/')[4];
        await sbDelete('escala_funcionario',`id=eq.${enc(id)}`);
        json(res,200,{ok:true}); return true;
      }

      if (method==='GET' && p==='/ponto/admin/relatorio') {
        if(!adminOk(req)) return naoAutorizado(res);
        const ano=+urlObj.searchParams.get('ano'), mes=+urlObj.searchParams.get('mes');
        const { inicio, fim }=limitesMes(ano,mes);
        const cfg=await getConfig(); const tol=cfg.tolerancia_min||0;
        const fb={jornada_min:cfg.jornada_min, tolerancia_min:tol};
        const funcs=await sbGet('funcionarios?select=id,nome,matricula');
        const fmap={}; funcs.forEach(f=>fmap[f.id]=f);
        const bs=await sbGet(`batidas?select=*&data=gte.${inicio}&data=lte.${fim}&order=momento.asc`);
        const lancs=await sbGet(`lancamentos?select=funcionario_id,data,tipo&data=gte.${inicio}&data=lte.${fim}`);
        const bat={}; for(const x of bs){ (bat[x.funcionario_id]=bat[x.funcionario_id]||{}); (bat[x.funcionario_id][x.data]=bat[x.funcionario_id][x.data]||[]).push(x); }
        const lmap={}; for(const l of lancs)(lmap[l.funcionario_id]=lmap[l.funcionario_id]||{})[l.data]=l.tipo;
        const fids=new Set([...Object.keys(bat), ...Object.keys(lmap)].map(Number));
        const escDe=await montarEscalas([...fids]);
        const todasDatas=[]; let dd=new Date(inicio+'T12:00:00Z'); const fdd=new Date(fim+'T12:00:00Z');
        while(dd<=fdd){ todasDatas.push(dd.toISOString().slice(0,10)); dd.setUTCDate(dd.getUTCDate()+1); }
        const relatorio=[];
        for(const fid of fids){
          const f=fmap[fid]||{nome:'(removido)',matricula:''};
          const r=agregar(bat[fid]||{}, lmap[fid]||{}, (dia)=>escDe(fid,dia,fb), cfg.almoco_minimo, todasDatas);
          relatorio.push({funcionario_id:fid,nome:f.nome,matricula:f.matricula,...r});
        }
        relatorio.sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));
        json(res,200,{inicio,fim,tolerancia:tol,relatorio}); return true;
      }

    } catch (e) {
      console.error('[ponto] erro:', e.message);
      json(res,500,{erro:e.message}); return true;
    }

    return false; // /ponto/* desconhecido → cai no 404 global
  };
}

// ── Interface compatível com config/empresas ─────────────────────────
module.exports = {
  id: 'ponto',
  nome: 'Ponto (Registro)',
  rotinas: {},
  routes,
  crons: {}
};
