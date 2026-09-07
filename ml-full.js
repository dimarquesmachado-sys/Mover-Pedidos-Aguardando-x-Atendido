'use strict';

/* ═══ ML FULL — NF-e emitidas PELO Mercado Livre (Fulfillment, série 2) ═══════════
   No ML Full quem emite a NF-e é o próprio ML (Faturador, certificado do seller no
   servidor deles). Ninguém traz esses XMLs pro Bling — quando a importação nativa
   come bola, a venda fica sem NF e sem margem no dashboard (caso de 06/09 na AMB).

   FASE ATUAL: SONDA (b1). Antes de qualquer motor/cron, provar o contrato real da
   API de invoices com as vendas que a gente TEM na mão, e já baixar os XMLs delas
   (resolve a parte ML das 7 entradas manuais: o dono só arrasta o ZIP na tela de
   importar do Bling — Loja MLivre, unidade MLivre FULL, contas SIM, estoque NÃO).

   Doc: https://developers.mercadolivre.com.br/pt_br/obtendo-nota-fiscal
   - consulta individual: GET /users/{uid}/invoices/orders/{order_id}
   - XML:                 GET /users/{uid}/invoices/documents/xml/{invoice_id}/authorized
     (e/ou o campo xml_location no corpo da nota — a sonda tenta os dois e diz qual serviu)
   - lote por período:    /invoices/sites/MLB/batch_request/period/stream  ← fica pro motor

   MATRIZ DE SAÍDAS por venda (cada uma tem ramo aqui E aparece nomeada na resposta):
   - xml_salvo                      → baixou, gravou em ML_FULL_DIR, chave extraída
   - nota_encontrada_sem_xml        → a nota existe mas nenhum dos 2 caminhos de XML serviu
                                       (conclusivo p/ esta rodada; corpo cru nos passos)
   - sem_nota_no_ml_404             → o ML respondeu 404 na nota deste pedido (conclusivo:
                                       ou não é Full, ou a nota ainda não existe lá)
   - pedido_nao_encontrado          → nem /orders nem /packs conhecem o número (conclusivo)
   - transitorio_tente_de_novo      → 429/5xx/timeout mesmo após 1 retentativa — NÃO é
                                       "não funciona"; rodar de novo em ~1 min
   - erro_<status>                  → resposta inesperada e conclusiva (401/403/etc), corpo cru
   "NÃO SEI" ≠ "NÃO EXISTE": só 404 e 4xx conclusivos encerram; o resto pede nova rodada.

   Rotas (todas atrás de ?k=ADMIN_KEY, gate no index.js da raiz):
   - GET /ml-full/sonda?empresa=amb&vendas=ID,ID[,...][&cru=1]
   - GET /ml-full/zip?empresa=amb          → ZIP dos XMLs já salvos da empresa
   - GET /ml-full/status[?empresa=amb]     → o que há no disco + versão
   ════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const VERSAO = 'ml-full b2 (sonda)';
const ML_API = 'https://api.mercadolibre.com';
const DIR = process.env.ML_FULL_DIR || '/data/ml-full';

/* fetch trocável só nos testes — produção usa o node-fetch do repo */
const _fetchRef = { fn: require('node-fetch') };

/* empresa como PARÂMETRO desde o nascimento — os três managers têm o mesmo contrato
   (garantirTokenML() → access_token), conferido nos exports antes de escrever isto */
const MANAGERS = {
  amb:      () => require('./ambtotal/mlTokenManager'),
  girassol: () => require('./girassol/mlTokenManager'),
  good:     () => require('./good/mlTokenManager'),
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* Codex #344 r2+r3: o abort DE VERDADE mora nos managers — toda chamada fetch
   deles agora carrega timeout: 20000 (node-fetch v2 destrói o socket ao estourar,
   então a requisição pendurada morre na fonte; o F3 herda a mesma proteção).
   Este prazo externo fica como cinto de segurança pra qualquer outra pendurada,
   e ENGOLE o settle tardio do perdedor da corrida — sem unhandledRejection nem
   refresh atrasado disparando depois da resposta. */
function comPrazo(promessa, ms, rotulo) {
  let t;
  promessa.catch(() => {}); // o perdedor da corrida não vira unhandledRejection
  const prazo = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(rotulo + ' demorou >' + Math.round(ms / 1000) + 's (ML instável?) — rode de novo em ~1 min')), ms); });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(t));
}

async function garantirToken(empresa) {
  const mk = MANAGERS[empresa];
  if (!mk) throw new Error('empresa desconhecida: ' + empresa + ' (use amb, girassol ou good)');
  try {
    const tk = await comPrazo(Promise.resolve().then(() => mk().garantirTokenML()), 30000, 'validação do token ML da ' + empresa);
    if (!tk) throw new Error('manager devolveu token vazio');
    return tk;
  } catch (e) {
    throw new Error('sem token ML da ' + empresa + ': ' + String(e.message || e).slice(0, 160));
  }
}

/* GET no ML com 1 retentativa para transitório (429/5xx/timeout/rede).
   auth: 'bearer' manda o token; 'nenhuma' não manda (links assinados de storage
   quebram se receberem Authorization que não esperam). */
async function mlGet(token, url, auth = 'bearer') {
  let ultimo = null;
  for (let tent = 1; tent <= 2; tent++) {
    /* Codex #344 r4: o timeout do node-fetch v2 não destrói corpo TRAVADO — o
       retry recomeçava com o socket anterior vivo. O AbortController aborta de
       verdade, e o timer só é limpo depois do text() (corpo travado também
       precisa do abort). */
    const ac = new AbortController();
    const tAb = setTimeout(() => ac.abort(), 30000);
    try {
      const headers = auth === 'bearer' ? { Authorization: 'Bearer ' + token } : {};
      const r = await _fetchRef.fn(url, { headers, signal: ac.signal, timeout: 30000 });
      const texto = await r.text();
      const transitorio = r.status === 429 || r.status >= 500;
      ultimo = { status: r.status, ok: r.status >= 200 && r.status < 300, texto, transitorio };
    } catch (e) {
      ultimo = { status: 0, ok: false, texto: 'rede/timeout: ' + String(e.message || e).slice(0, 160), transitorio: true };
    } finally { clearTimeout(tAb); }
    if (!ultimo.transitorio) return ultimo;
    if (tent === 1) await sleep(4000);
  }
  return ultimo;
}

function registrar(passos, rotulo, url, r, cru) {
  passos.push({
    passo: rotulo,
    url,
    status: r.status,
    transitorio: r.transitorio || undefined,
    corpo: String(r.texto || '').slice(0, cru ? 6000 : 1200),
  });
}

function jsonSeguro(texto) { try { return JSON.parse(texto); } catch (e) { return null; } }

function extrairChave(xml) {
  const m = String(xml || '').match(/NFe(\d{44})/);
  return m ? m[1] : null;
}

function salvarXml(empresa, orderId, invoiceId, xml) {
  fs.mkdirSync(DIR, { recursive: true });
  const nome = empresa + '-' + orderId + '-' + (invoiceId || 'sem-id') + '.xml';
  fs.writeFileSync(path.join(DIR, nome), xml);
  return nome;
}

/* Tenta os dois caminhos de XML documentados, na ordem, e diz qual serviu.
   ACEITE (Codex #344): só corpo com CHAVE de NF-e (44 dígitos) — 2xx com HTML de
   erro/login ou outro XML qualquer NÃO vira arquivo salvo (iria quebrar a
   importação no Bling); nesse caso o corpo fica visível no passo, que é ouro
   de diagnóstico. Transitório (429/5xx/timeout) nos caminhos de XML PROPAGA —
   nunca vira "sem XML". */
async function buscarXml(token, uid, invoiceId, corpoNota, passos, cru) {
  let houveTransitorio = false;
  const tentar = async (rotulo, urlX, auth) => {
    const r = await mlGet(token, urlX, auth);
    if (r.transitorio) houveTransitorio = true;
    const chave = r.ok ? extrairChave(r.texto) : null;
    const resumo = chave
      ? '(NF-e de ' + r.texto.length + ' bytes, chave ' + chave + ')'
      : (r.ok ? '(2xx SEM chave de NF-e no corpo — não aceito) ' + r.texto : r.texto);
    registrar(passos, rotulo, urlX, { ...r, texto: resumo }, cru);
    return chave ? { xml: r.texto, chave } : null;
  };

  const mLoc = String(corpoNota || '').match(/"xml_location"\s*:\s*"([^"]+)"/);
  if (mLoc) {
    let urlX = mLoc[1].replace(/\\\//g, '/');
    // b2 (cobaia de 07/09): o ML devolve xml_location RELATIVO (/users/...) — sem resolver
    // contra a API, o fetch recusava ('Only absolute URLs') e o rótulo saía transitório errado.
    if (urlX.startsWith('/')) urlX = ML_API + urlX;
    const auth = urlX.startsWith(ML_API) ? 'bearer' : 'nenhuma';
    const ok = await tentar('xml via xml_location (' + auth + ')', urlX, auth);
    if (ok) return { xml: ok.xml, chave: ok.chave, via: 'xml_location' };
  }
  if (invoiceId) {
    const urlD = ML_API + '/users/' + uid + '/invoices/documents/xml/' + invoiceId + '/authorized';
    const ok = await tentar('xml via documents/authorized', urlD, 'bearer');
    if (ok) return { xml: ok.xml, chave: ok.chave, via: 'documents/authorized' };
  }
  return houveTransitorio ? { transitorio: true } : null;
}

/* Sonda a NOTA de UM order id (já resolvido de pack, se era o caso). */
async function sondarUmaOrder(token, uid, empresa, orderId, cru) {
  const passos = [];
  const urlN = ML_API + '/users/' + uid + '/invoices/orders/' + orderId;
  const rN = await mlGet(token, urlN);
  registrar(passos, 'nota do pedido', urlN, rN, cru);
  if (rN.transitorio) return { resultado: 'transitorio_tente_de_novo', passos };
  if (rN.status === 404) return { resultado: 'sem_nota_no_ml_404', passos };
  if (!rN.ok) return { resultado: 'erro_' + rN.status, passos };

  const nota = jsonSeguro(rN.texto) || {};
  let invoiceId = null;
  if (nota.id != null && String(nota.id) !== String(orderId)) invoiceId = nota.id;
  if (!invoiceId) {
    const mInv = rN.texto.match(/"invoice_id"\s*:\s*"?(\d+)"?/);
    if (mInv) invoiceId = mInv[1];
  }
  const encontrado = await buscarXml(token, uid, invoiceId, rN.texto, passos, cru);
  if (encontrado && encontrado.transitorio) return { resultado: 'transitorio_tente_de_novo', invoice_id: invoiceId || null, passos };
  if (!encontrado) return { resultado: 'nota_encontrada_sem_xml', invoice_id: invoiceId || null, passos };

  const arquivo = salvarXml(empresa, orderId, invoiceId, encontrado.xml);
  return {
    resultado: 'xml_salvo', via: encontrado.via, invoice_id: invoiceId || null,
    arquivo, chave: encontrado.chave, passos,
  };
}

/* Sonda uma NOTA direto pelo id dela (b2) — a cobaia provou que invoices/orders/{order}
   devolve SÓ a nota de venda; a DEVOLUÇÃO tem id próprio e não aparece por aquele fio.
   Aqui provamos se detalhe e XML saem por id — o caminho que o motor usará pras entradas. */
async function sondarNota(token, uid, empresa, notaId, cru) {
  const passos = [];
  const urlD = ML_API + '/users/' + uid + '/invoices/' + notaId;
  const rD = await mlGet(token, urlD);
  registrar(passos, 'detalhe da nota por id (endpoint em prova)', urlD, rD, cru);

  const urlX = ML_API + '/users/' + uid + '/invoices/documents/xml/' + notaId + '/authorized';
  const rX = await mlGet(token, urlX);
  const chave = rX.ok ? extrairChave(rX.texto) : null;
  registrar(passos, 'xml por id (documents/authorized)', urlX,
    { ...rX, texto: chave ? '(NF-e de ' + rX.texto.length + ' bytes, chave ' + chave + ')' : (rX.ok ? '(2xx SEM chave de NF-e — não aceito) ' + rX.texto : rX.texto) }, cru);

  if (chave) {
    const arquivo = salvarXml(empresa, 'nota', notaId, rX.texto);
    return { nota: String(notaId), resultado: 'xml_salvo', via: 'documents/authorized (por id)', arquivo, chave, passos };
  }
  if (rX.transitorio) return { nota: String(notaId), resultado: 'transitorio_tente_de_novo', passos };
  return { nota: String(notaId), resultado: rX.status === 404 ? 'sem_xml_para_esta_nota_404' : 'sem_xml_aceito_' + rX.status, passos };
}

/* Sonda UMA venda como o dono a enxerga (número que pode ser order OU pack —
   lição do F3: /orders/{pack} responde 404 e o certo é /packs/{id}). */
async function sondarVenda(token, uid, empresa, venda, cru) {
  const passos = [];
  const urlO = ML_API + '/orders/' + venda;
  const rO = await mlGet(token, urlO);
  registrar(passos, 'pedido', urlO, rO, cru);

  if (rO.ok) {
    const sub = await sondarUmaOrder(token, uid, empresa, venda, cru);
    return [{ venda, tipo: 'order', resultado: sub.resultado, via: sub.via, invoice_id: sub.invoice_id, arquivo: sub.arquivo, chave: sub.chave, passos: passos.concat(sub.passos) }];
  }
  if (rO.transitorio) return [{ venda, resultado: 'transitorio_tente_de_novo', passos }];

  if (rO.status === 404) {
    const urlP = ML_API + '/packs/' + venda;
    const rP = await mlGet(token, urlP);
    registrar(passos, 'pack (fallback do 404)', urlP, rP, cru);
    if (rP.transitorio) return [{ venda, resultado: 'transitorio_tente_de_novo', passos }];
    if (rP.status === 404) return [{ venda, resultado: 'pedido_nao_encontrado', passos }];
    if (!rP.ok) return [{ venda, resultado: 'erro_' + rP.status, passos }];

    const pack = jsonSeguro(rP.texto) || {};
    const ordens = (Array.isArray(pack.orders) ? pack.orders : []).map(o => o && o.id).filter(Boolean);
    if (!ordens.length) return [{ venda, tipo: 'pack', resultado: 'erro_pack_sem_orders', passos }];

    const saida = [];
    for (const oid of ordens) {
      const sub = await sondarUmaOrder(token, uid, empresa, oid, cru);
      saida.push({ venda: venda + ' → order ' + oid, tipo: 'pack', resultado: sub.resultado, via: sub.via, invoice_id: sub.invoice_id, arquivo: sub.arquivo, chave: sub.chave, passos: (saida.length ? [] : passos).concat(sub.passos) });
      await sleep(400);
    }
    return saida;
  }
  return [{ venda, resultado: 'erro_' + rO.status, passos }];
}

function listarArquivos(empresa) {
  try {
    return fs.readdirSync(DIR)
      .filter(n => n.endsWith('.xml') && (!empresa || n.startsWith(empresa + '-')))
      .map(n => { const st = fs.statSync(path.join(DIR, n)); return { arquivo: n, bytes: st.size, em: st.mtime.toISOString() }; })
      .sort((a, b) => (a.em < b.em ? 1 : -1));
  } catch (e) { return []; }
}

/* Handler no padrão da casa (tiktok-oauth): tratar(req,res,urlObj,json) → true se tratou.
   O gate de ADMIN_KEY é feito no index.js da raiz para TODO /ml-full/*. */
async function tratar(req, res, urlObj, json) {
  const p = urlObj.pathname;

  if (p === '/ml-full/sonda') {
    const empresa = String(urlObj.searchParams.get('empresa') || 'amb').toLowerCase().trim();
    const cru = urlObj.searchParams.get('cru') === '1';
    const vendas = String(urlObj.searchParams.get('vendas') || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!MANAGERS[empresa]) { json(res, 400, { ok: false, erro: 'empresa deve ser amb, girassol ou good' }); return true; }
    if (!vendas.length) {
      json(res, 400, { ok: false, erro: 'passe &vendas=ID,ID (número da venda no ML; pode ser pack)', exemplo: '/ml-full/sonda?empresa=amb&vendas=2000018307797668&k=SUA_ADMIN_KEY' });
      return true;
    }

    let token;
    try { token = await garantirToken(empresa); }
    catch (e) { json(res, 200, { ok: false, erro: String(e.message || e) }); return true; }

    const passosMe = [];
    const rMe = await mlGet(token, ML_API + '/users/me');
    registrar(passosMe, 'users/me (uid da conta)', ML_API + '/users/me', rMe, cru);
    const me = jsonSeguro(rMe.texto) || {};
    if (!rMe.ok || !me.id) {
      json(res, 200, { ok: false, erro: rMe.transitorio ? 'ML instável agora (429/5xx) — rode de novo em ~1 min' : 'users/me falhou — corpo nos passos', passos: passosMe });
      return true;
    }

    const entradas = [];
    for (const v of vendas) {
      entradas.push(...await sondarVenda(token, me.id, empresa, v, cru));
      await sleep(400);
    }
    const resumo = {};
    for (const e of entradas) resumo[e.resultado] = (resumo[e.resultado] || 0) + 1;

    json(res, 200, {
      ok: true, versao: VERSAO, empresa, uid: me.id, apelido: me.nickname || null,
      resumo,
      aviso: entradas.some(e => e.resultado === 'transitorio_tente_de_novo')
        ? 'houve resposta transitória (429/5xx/timeout) — isso NÃO é "não existe"; rode a sonda de novo em ~1 min'
        : undefined,
      xmls_no_disco: listarArquivos(empresa).length,
      baixar_zip: 'https://mover-pedidos-aguardando-x-atendido.onrender.com/ml-full/zip?empresa=' + empresa + '&k=SUA_ADMIN_KEY',
      vendas: entradas,
    });
    return true;
  }

  if (p === '/ml-full/sonda-nota') {
    const empresa = String(urlObj.searchParams.get('empresa') || 'amb').toLowerCase().trim();
    const cru = urlObj.searchParams.get('cru') === '1';
    const notas = String(urlObj.searchParams.get('notas') || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!MANAGERS[empresa]) { json(res, 400, { ok: false, erro: 'empresa deve ser amb, girassol ou good' }); return true; }
    if (!notas.length) { json(res, 400, { ok: false, erro: 'passe &notas=ID,ID (id da nota no ML, ex.: 6888307616)' }); return true; }
    let token; try { token = await garantirToken(empresa); } catch (e) { json(res, 200, { ok: false, erro: String(e.message || e) }); return true; }
    const rMe = await mlGet(token, ML_API + '/users/me');
    const me = jsonSeguro(rMe.texto) || {};
    if (!rMe.ok || !me.id) { json(res, 200, { ok: false, erro: rMe.transitorio ? 'ML instável agora — rode de novo em ~1 min' : 'users/me falhou (HTTP ' + rMe.status + ')' }); return true; }
    const saida = [];
    for (const id of notas) { saida.push(await sondarNota(token, me.id, empresa, id, cru)); await sleep(400); }
    const resumo = {}; for (const e2 of saida) resumo[e2.resultado] = (resumo[e2.resultado] || 0) + 1;
    json(res, 200, { ok: true, versao: VERSAO, empresa, uid: me.id, resumo, notas: saida });
    return true;
  }

  /* Sonda do LOTE por período (b2) — a peça que o motor precisa provar antes do cron.
     &q= é a QUERYSTRING CRUA repassada ao ML (itera parâmetros sem redeploy: o erro do
     ML costuma nomear o que falta) e &caminho= troca o sufixo, sempre PRESO ao prefixo
     /users/{uid}/invoices/ — sonda, não proxy. Só leitura. */
  if (p === '/ml-full/sonda-lote') {
    const empresa = String(urlObj.searchParams.get('empresa') || 'amb').toLowerCase().trim();
    if (!MANAGERS[empresa]) { json(res, 400, { ok: false, erro: 'empresa deve ser amb, girassol ou good' }); return true; }
    let token; try { token = await garantirToken(empresa); } catch (e) { json(res, 200, { ok: false, erro: String(e.message || e) }); return true; }
    const rMe = await mlGet(token, ML_API + '/users/me');
    const me = jsonSeguro(rMe.texto) || {};
    if (!rMe.ok || !me.id) { json(res, 200, { ok: false, erro: rMe.transitorio ? 'ML instável agora — rode de novo em ~1 min' : 'users/me falhou (HTTP ' + rMe.status + ')' }); return true; }
    const caminho = String(urlObj.searchParams.get('caminho') || 'sites/MLB/batch_request/period/stream').replace(/^\/+/, '');
    if (caminho.indexOf('..') >= 0) { json(res, 400, { ok: false, erro: 'caminho inválido' }); return true; }
    const q = String(urlObj.searchParams.get('q') || '');
    const url = ML_API + '/users/' + me.id + '/invoices/' + caminho + (q ? ('?' + q) : '');
    const r = await mlGet(token, url);
    json(res, 200, {
      ok: true, versao: VERSAO, empresa, uid: me.id, url, status: r.status,
      transitorio: r.transitorio || undefined,
      corpo: String(r.texto || '').slice(0, 8000),
      dica: 'itere por &q= (querystring crua pro ML) e &caminho= (sufixo depois de /invoices/) — o erro do ML costuma nomear o parâmetro que falta',
    });
    return true;
  }

  if (p === '/ml-full/zip') {
    const empresa = String(urlObj.searchParams.get('empresa') || 'amb').toLowerCase().trim();
    if (!MANAGERS[empresa]) { json(res, 400, { ok: false, erro: 'empresa deve ser amb, girassol ou good' }); return true; }
    const arquivos = listarArquivos(empresa);
    if (!arquivos.length) { json(res, 200, { ok: false, erro: 'nenhum XML salvo ainda para ' + empresa + ' — rode /ml-full/sonda primeiro' }); return true; }
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    for (const a of arquivos) zip.addLocalFile(path.join(DIR, a.arquivo));
    const buf = zip.toBuffer();
    const hoje = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="nf-ml-full-' + empresa + '-' + hoje + '.zip"',
      'Content-Length': buf.length,
    });
    res.end(buf);
    return true;
  }

  if (p === '/ml-full/status') {
    const empresa = String(urlObj.searchParams.get('empresa') || '').toLowerCase().trim() || null;
    json(res, 200, { ok: true, versao: VERSAO, dir: DIR, empresa: empresa || '(todas)', arquivos: listarArquivos(empresa) });
    return true;
  }

  return false;
}

module.exports = {
  tratar, VERSAO,
  _interno: {
    sondarVenda, sondarUmaOrder, sondarNota, mlGet, extrairChave, garantirToken, listarArquivos, comPrazo,
    _trocarFetchParaTeste(f) { _fetchRef.fn = f; },
  },
};
