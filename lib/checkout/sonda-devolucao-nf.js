'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   SONDA: A API DO BLING DIZ DE QUAL NOTA UMA NF DE DEVOLUÇÃO É? (27/11/2026 — só leitura, só admin, sem dado de gente)

   O dono: "vc não consegue consultar no bling se a venda já teve a devolução NF emitida?". Hoje não: a vigia dos cancelados
   (cancelados-bling-vigia) só enxerga a NF de VENDA ainda autorizada, e quem já devolveu por fora continua no aviso até
   tocar em "já gerei a devolução". Antes de prometer que dá, VER O DADO num caso real (devolução 131176 da NF 131099):

     1. lê a nota ORIGINAL (a chave de acesso, o número, o id);
     2. lê a nota de DEVOLUÇÃO e procura a original dentro dela — em qualquer campo (chave, número, id);
     3. se a devolução traz o link do XML, lê o XML e procura a referência oficial (<refNFe>);
     4. tenta a LISTA de notas de entrada do dia (tipo=0): a devolução aparece nela? com que campos?

   A resposta leva NOMES de campos e sim/não — nunca valor de campo de gente (nome, documento, endereço). Os únicos valores
   que saem são da própria nota: tipo, situação, finalidade, série, número, data e as chaves de acesso referenciadas.

   sondar({ blingGet, devId, origId, fetch? }) → objeto pronto pra resposta
   ───────────────────────────────────────────────────────────────────────────── */
const PAGINAS_LISTA = 5;
const semZeros = (v) => String(v == null ? '' : v).replace(/^0+/, '');
const soDig = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/* todos os caminhos de um objeto (só os NOMES; lista vira []), e onde cada alvo aparece */
function varrer(obj, alvos) {
  const caminhos = new Set(), achados = {};
  for (const k of Object.keys(alvos)) achados[k] = [];
  (function anda(v, cam, fundo) {
    if (fundo > 8) return;
    if (Array.isArray(v)) { v.slice(0, 50).forEach((x) => anda(x, cam + '[]', fundo + 1)); return; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) anda(v[k], cam ? cam + '.' + k : k, fundo + 1); return; }
    if (cam) caminhos.add(cam);
    if (v == null || v === '') return;
    const s = String(v);
    for (const k of Object.keys(alvos)) { const a = alvos[k]; if (a && (k === 'chave' ? soDig(s).includes(a) : semZeros(s) === a) && !achados[k].includes(cam)) achados[k].push(cam); }
  })(obj, '', 0);
  return { caminhos: [...caminhos].sort(), achados };
}

async function sondar(o) {
  const le = async (c) => { try { const r = await o.blingGet(c); return r && r.ok && r.data ? { d: r.data.data } : { http: (r && r.status) || 0 }; } catch (e) { return { http: 0 }; } };
  const out = { original: null, devolucao: null, xml: null, lista: null };
  const og = await le('/nfe/' + o.origId);
  if (!og.d || typeof og.d !== 'object') { out.original = { lida: false, http: og.http || 0 }; return out; }
  const chave = soDig(og.d.chaveAcesso);
  const alvos = { chave: chave.length === 44 ? chave : null, numero: semZeros(og.d.numero) || null, id: String(o.origId) };
  out.original = { lida: true, tem_chave: !!alvos.chave, numero: og.d.numero != null ? String(og.d.numero) : null, tipo: og.d.tipo != null ? og.d.tipo : null };
  const dv = await le('/nfe/' + o.devId);
  if (!dv.d || typeof dv.d !== 'object') { out.devolucao = { lida: false, http: dv.http || 0 }; return out; }
  const v = varrer(dv.d, alvos);
  const sit = dv.d.situacao && typeof dv.d.situacao === 'object' ? dv.d.situacao.valor : dv.d.situacao;
  out.devolucao = { lida: true, tipo: dv.d.tipo != null ? dv.d.tipo : null, situacao: sit != null ? sit : null, finalidade: dv.d.finalidade != null ? dv.d.finalidade : null,
    numero: dv.d.numero != null ? String(dv.d.numero) : null, serie: dv.d.serie != null ? String(dv.d.serie) : null, data_emissao: dv.d.dataEmissao || null,
    campos: v.caminhos, a_original_aparece_em: v.achados };
  /* o XML (a referência oficial é a tag refNFe). O link é do próprio Bling; só as chaves referenciadas saem daqui. */
  const link = typeof dv.d.xml === 'string' && /^https:\/\//.test(dv.d.xml) ? dv.d.xml : null;
  if (!link) out.xml = { tem_link: false };
  else {
    let host = null; try { host = new URL(link).host; } catch (e) { host = null; }
    out.xml = { tem_link: true, host };
    if (host && /(^|\.)bling\.com\.br$/.test(host)) {
      try {
        const busca = o.fetch || require('node-fetch');
        /* Codex #1002: redirecionamento NÃO é seguido (o destino escaparia da trava de host/https) — só é dito pra onde ia */
        const r = await busca(link, { timeout: 15000, redirect: 'manual' });
        out.xml.http = (r && r.status) || 0;
        if (r && r.status >= 300 && r.status < 400) { let para = null; try { para = new URL(String(r.headers.get('location')), link).host; } catch (e) { para = null; } out.xml.redireciona_para_host = para; }
        else if (r && r.ok) {
          const txt = String(await r.text());
          /* 200 com página de login, corpo vazio ou outra coisa NÃO é "sem referência": só um XML de NF-e inteiro responde */
          out.xml.e_nfe = /<infNFe[\s>]/.test(txt) && /<\/infNFe>/.test(txt);
          if (out.xml.e_nfe) { const refs = [...txt.matchAll(/<refNFe>\s*(\d{44})\s*<\/refNFe>/g)].map((m) => m[1]); out.xml.referencias = refs.slice(0, 10); out.xml.referencia_a_original = !!(alvos.chave && refs.includes(alvos.chave)); }
        }
      } catch (e) { out.xml.http = 0; }
    } else out.xml.lido = false;
  }
  /* a lista das notas de ENTRADA do dia da devolução */
  const dia = /^\d{4}-\d{2}-\d{2}/.test(String(dv.d.dataEmissao || '')) ? String(dv.d.dataEmissao).slice(0, 10) : null;
  if (!dia) out.lista = { tentada: false };
  else {
    const seg = new Date(Date.parse(dia + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
    /* Codex #1002: até PAGINAS_LISTA páginas; "não está" só se a lista ACABOU — parou em página cheia = não sei (null) */
    let ela = null, notas = 0, primeiro = null, acabou = false, falha = null;
    for (let pag = 1; pag <= PAGINAS_LISTA && !ela && !acabou; pag++) {
      let r = null; try { r = await o.blingGet('/nfe?tipo=0&dataEmissaoInicial=' + dia + '&dataEmissaoFinal=' + seg + '&limite=100&pagina=' + pag); } catch (e) { r = null; }
      const itens = r && r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : null;
      if (!itens) { falha = { pagina: pag, http: (r && r.status) || 0 }; break; }
      notas += itens.length; if (!primeiro && itens[0]) primeiro = itens[0];
      ela = itens.find((x) => x && String(x.id) === String(o.devId)) || null;
      if (itens.length < 100) acabou = true;
    }
    if (falha && falha.pagina === 1) out.lista = { tentada: true, veio: false, http: falha.http };
    else out.lista = { tentada: true, veio: true, notas, lista_completa: acabou, a_devolucao_esta_na_lista: ela ? true : (acabou ? false : null), campos_do_item: primeiro ? varrer(primeiro, {}).caminhos : [],
      a_original_aparece_no_item: ela ? varrer(ela, alvos).achados : null };
    /* 27/11: e a MESMA lista pedindo uma situação por vez (é assim que o índice das devoluções lista) — a devolução aparece? */
    out.lista_por_situacao = {};
    for (const sit of [5, 6, 7]) {
      let r = null; try { r = await o.blingGet('/nfe?tipo=0&situacao=' + sit + '&dataEmissaoInicial=' + dia + '&dataEmissaoFinal=' + seg + '&limite=100&pagina=1'); } catch (e) { r = null; }
      const itens = r && r.ok && r.data && Array.isArray(r.data.data) ? r.data.data : null;
      out.lista_por_situacao[sit] = !itens ? { veio: false, http: (r && r.status) || 0 } : { veio: true, notas: itens.length, a_devolucao_esta: itens.some((nota) => !!nota && String(nota.id) === String(o.devId)) ? true : (itens.length < 100 ? false : null) };
    }
  }
  return out;
}

module.exports = { sondar, varrer };
