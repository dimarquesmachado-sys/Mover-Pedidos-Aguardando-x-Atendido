'use strict';
// ════════════════════════════════════════════════════════════════════════
//  PODA DO BUCKET DE EXPEDIÇÃO (Supabase Storage) — 05/08/2026
// ════════════════════════════════════════════════════════════════════════
//  POR QUE: o bucket `expedicao` acumulou 1,09 GB e estourou o Free Plan da
//  org (limite 1 GB, grace period até 03/09/2026). Medido em 05/08:
//    abr 2.220 arquivos / 223 MB · mai 1.276 / 96 MB · jun 3.332 / 316 MB
//    jul 4.144 / 433 MB · ago (5 dias) 477 / 48 MB
//  E está ACELERANDO. Sem poda, volta a estourar em ~1 mês.
//  Decisão do Diego: guardar os últimos 45 dias.
//
//  ⚠️ POR QUE NÃO APAGAR PELO SQL: dar DELETE na tabela `storage.objects`
//  remove o REGISTRO mas deixa o arquivo órfão no armazenamento — o espaço
//  continua contando. A remoção de verdade é pela API de Storage, que é o
//  que este módulo faz.
//
//  SEGURANÇA: o padrão é SIMULAR. Sem `&gravar=1` ele só conta e mostra
//  exemplos, sem apagar nada.
// ════════════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');

const base = require('./base');
const { json, ehAdmin } = base;

const BUCKET = process.env.EXPEDICAO_BUCKET || 'expedicao';

// A chave PRECISA poder apagar. A anon/publishable costuma listar e não apagar.
// Se o DELETE voltar 401/403, criar EXPEDICAO_STORAGE_KEY no Render com a
// service_role do projeto Expedição-Imagens (Settings → API → service_role).
function cfgStorage() {
  const url = (process.env.EXPEDICAO_SUPABASE_URL || process.env.AUTO_MSG_GIRASSOL_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.EXPEDICAO_STORAGE_KEY || process.env.AUTO_MSG_GIRASSOL_SUPABASE_KEY || '';
  return { url, key };
}

// 05/08: a MESMA poda usada pela rota, agora tambem chamavel pela rotina noturna.
// Sem isso a limpeza continuaria dependendo de alguem lembrar de abrir a URL.
async function podarExpedicao(dias, max) {
  const d = Math.max(7, Number(dias) || 45);
  const m = Math.min(5000, Math.max(1, Number(max) || 2000));
  const { url, key } = cfgStorage();
  if (!url || !key) return { apagados: 0, mb: 0, erro: 'sem credencial de storage' };
  const dorme = ms => new Promise(r => setTimeout(r, ms));
  const H = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  const corte = new Date(Date.now() - d * 864e5).toISOString();
  const velhos = []; let bytes = 0;
  let off = 0;
  for (let pag = 0; pag < 60; pag++) {
    const r = await fetch(url + '/storage/v1/object/list/' + BUCKET, { method: 'POST', headers: H,
      body: JSON.stringify({ prefix: '', limit: 100, offset: off, sortBy: { column: 'created_at', order: 'asc' } }) });
    if (!r.ok) return { apagados: 0, mb: 0, erro: 'listagem HTTP ' + r.status };
    const lote = await r.json().catch(() => null);
    if (!Array.isArray(lote) || !lote.length) break;
    let passou = false;
    for (const o of lote) {
      const c = o.created_at || (o.metadata && o.metadata.lastModified) || '';
      if (c && c < corte) { if (velhos.length < m) { velhos.push(o.name); bytes += Number((o.metadata && o.metadata.size) || 0); } }
      else if (c) passou = true;
    }
    off += lote.length;
    if (passou || velhos.length >= m) break;
    await dorme(120);
  }
  if (!velhos.length) return { apagados: 0, mb: 0 };
  let apagados = 0, erro = null;
  for (let i = 0; i < velhos.length; i += 100) {
    const lote = velhos.slice(i, i + 100);
    const r = await fetch(url + '/storage/v1/object/' + BUCKET, { method: 'DELETE', headers: H, body: JSON.stringify({ prefixes: lote }) });
    if (r.ok) apagados += lote.length;
    else { erro = 'DELETE HTTP ' + r.status; if (r.status === 401 || r.status === 403) break; }
    await dorme(200);
  }
  return { apagados, mb: Math.round(bytes / 1048576 * 10) / 10, erro };
}

function rotasLimpeza(ctx) {
  const { validarSessao } = ctx;
  const dorme = ms => new Promise(r => setTimeout(r, ms));

  function admOk(req, urlObj) {
    const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
    const s = validarSessao(req.headers['cookie']);
    return (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (s && ehAdmin(s));
  }

  // Lista uma página do bucket. Devolve também a resposta CRUA na 1ª página —
  // instrumentação de propósito: se a API mudar de formato, a gente vê na hora
  // em vez de receber "0 arquivos" e achar que o bucket está limpo.
  async function listarPagina(url, key, offset, limite) {
    const r = await fetch(url + '/storage/v1/object/list/' + BUCKET, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: limite, offset, sortBy: { column: 'created_at', order: 'asc' } })
    });
    const txt = await r.text();
    let dados = null;
    try { dados = JSON.parse(txt); } catch (e) {}
    return { status: r.status, ok: r.ok, dados, cru: txt.slice(0, 400) };
  }

  // Apaga em lote (a API aceita uma lista de nomes de uma vez)
  async function apagarLote(url, key, nomes) {
    const r = await fetch(url + '/storage/v1/object/' + BUCKET, {
      method: 'DELETE',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: nomes })
    });
    const txt = await r.text();
    return { status: r.status, ok: r.ok, cru: txt.slice(0, 300) };
  }

  return async function handleLimpeza(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    if (method === 'GET' && p === '/girassol-backup-offline/limpar-expedicao') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const q = urlObj.searchParams;
      const dias = Math.max(7, parseInt((q && q.get('dias')) || '45', 10) || 45);   // nunca menos de 7, por segurança
      const gravar = (q && q.get('gravar')) === '1';
      const max = Math.min(5000, Math.max(1, parseInt((q && q.get('max')) || '2000', 10) || 2000));

      const { url, key } = cfgStorage();
      if (!url || !key) { json(res, 500, { ok: false, erro: 'sem EXPEDICAO_SUPABASE_URL / EXPEDICAO_STORAGE_KEY (nem os AUTO_MSG_GIRASSOL_* de reserva)' }); return true; }

      const corte = new Date(Date.now() - dias * 864e5).toISOString();
      const velhos = [];
      let bytesVelhos = 0, totalVistos = 0, cruPrimeira = null, statusLista = null;

      // varre o bucket em ordem de criação: os mais antigos vêm primeiro,
      // então dá pra parar assim que chegar num arquivo dentro do prazo
      let off = 0;
      for (let pag = 0; pag < 60; pag++) {
        const r = await listarPagina(url, key, off, 100);
        if (pag === 0) { cruPrimeira = r.cru; statusLista = r.status; }
        if (!r.ok || !Array.isArray(r.dados)) {
          json(res, 502, { ok: false, erro: 'a listagem do bucket não voltou como lista', status: r.status, resposta_crua: r.cru });
          return true;
        }
        if (!r.dados.length) break;
        let passouDoCorte = false;
        for (const o of r.dados) {
          totalVistos++;
          const criado = o.created_at || (o.metadata && o.metadata.lastModified) || '';
          if (criado && criado < corte) {
            if (velhos.length < max) { velhos.push(o.name); bytesVelhos += Number((o.metadata && o.metadata.size) || 0); }
          } else if (criado) { passouDoCorte = true; }
        }
        off += r.dados.length;
        if (passouDoCorte || velhos.length >= max) break;
        await dorme(120);
      }

      const mb = b => Math.round(b / 1048576 * 10) / 10;
      const resposta = {
        ok: true, bucket: BUCKET, dias_guardados: dias, corte,
        arquivos_vistos: totalVistos,
        para_apagar: velhos.length, espaco_a_liberar_mb: mb(bytesVelhos),
        exemplos: velhos.slice(0, 5),
        gravou: false
      };

      if (!gravar) {
        resposta.simulacao = true;
        resposta.aviso = 'NADA foi apagado. Confira os exemplos e repita com &gravar=1.';
        resposta.diagnostico_listagem = { status: statusLista, trecho_da_resposta: cruPrimeira };
        json(res, 200, resposta);
        return true;
      }

      if (!velhos.length) { resposta.msg = 'nada mais antigo que o corte — bucket já está no prazo'; json(res, 200, resposta); return true; }

      let apagados = 0, falhas = 0, ultimoErro = null;
      for (let i = 0; i < velhos.length; i += 100) {
        const lote = velhos.slice(i, i + 100);
        const r = await apagarLote(url, key, lote);
        if (r.ok) apagados += lote.length;
        else { falhas += lote.length; ultimoErro = { status: r.status, resposta: r.cru }; if (r.status === 401 || r.status === 403) break; }
        await dorme(200);
      }
      resposta.gravou = true;
      resposta.apagados = apagados;
      resposta.falhas = falhas;
      if (ultimoErro) {
        resposta.erro = ultimoErro;
        if (ultimoErro.status === 401 || ultimoErro.status === 403) {
          resposta.o_que_fazer = 'a chave em uso não tem permissão de apagar. Criar EXPEDICAO_STORAGE_KEY no Render com a service_role do projeto Expedição-Imagens (Supabase → Settings → API → service_role) e rodar de novo';
        }
      }
      json(res, 200, resposta);
      return true;
    }

    return false;   // não é rota de limpeza
  };
}

module.exports = { rotasLimpeza, podarExpedicao };
