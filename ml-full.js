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

const VERSAO = 'ml-full b3 (motor fase 1 — varredura manual)';
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

/* ═══ FASE 1 DO MOTOR (b3) — provada pelas 3 sondas de 07/09 ═══════════════════
   Lote: GET period/stream é ZIP SÍNCRONO com pastas por categoria e arquivo
   {invoice_id}_{chave}-procNFe.xml. O motor: abre em memória, IGNORA simbólicas/
   transferência/retiro (política v1 — vira chave liga/desliga se o dono quiser),
   tira o tpNF do PRÓPRIO XML (nome de pasta de venda/devolução a gente ainda não
   viu — o censo de pastas sai na resposta e ensina), cruza a CHAVE com o Bling
   (2 passos: lista filtrada + DETALHE confirma — a lista do Bling é resumida e o
   filtro já foi visto sendo ignorado; lição do raio-x do snf) e SÓ o que falta
   vira arquivo em {DIR}/saida|entrada pro /ml-full/zip servir. Falha de consulta
   e teto de cota NUNCA concluem: caem em nao_conferidas e a rodada seguinte
   fecha (idempotente: salvo não re-salva, presente cai fora de novo). Cron fica
   DESLIGADO até o dono validar a varredura manual. */
const BLING_BASE = 'https://api.bling.com.br/Api/v3';
const BLING_TOKENS = {
  amb:      () => require('./ambtotal/tokenManager'),
  girassol: () => require('./girassol/tokenManager'),
  good:     () => require('./good/tokenManager'),
};

async function garantirTokenBling(empresa) {
  const mk = BLING_TOKENS[empresa];
  if (!mk) throw new Error('empresa desconhecida: ' + empresa);
  try {
    const tk = await mk().garantirToken();
    if (!tk) throw new Error('token vazio');
    return tk;
  } catch (e) { throw new Error('sem token Bling da ' + empresa + ': ' + String(e.message || e).slice(0, 160)); }
}

/* GET binário no ML (o stream do lote) — corpo em Buffer, abort de 60s, 1 retentativa
   pra transitório. Nunca conclui nada: devolve o que veio. */
async function mlGetBuffer(token, url) {
  let ultimo = null;
  for (let tent = 1; tent <= 2; tent++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 60000);
    try {
      const r = await _fetchRef.fn(url, { headers: { Authorization: 'Bearer ' + token }, signal: ac.signal, timeout: 60000 });
      const buf = await r.buffer();
      const transitorio = r.status === 429 || r.status >= 500;
      ultimo = { status: r.status, ok: r.status >= 200 && r.status < 300, buf, transitorio };
    } catch (e) {
      ultimo = { status: 0, ok: false, buf: Buffer.from('rede/timeout: ' + String(e.message || e).slice(0, 160)), transitorio: true };
    } finally { clearTimeout(t); }
    if (!ultimo.transitorio) return ultimo;
    if (tent === 1) await sleep(4000);
  }
  return ultimo;
}

/* {invoice_id}_{chave}-procNFe.xml dentro de pastas por categoria */
function classificarEntradaZip(nome) {
  const m = String(nome || '').match(/(?:^|\/)(\d+)_(\d{44})-procNFe\.xml$/);
  if (!m) return null;
  const pastas = String(nome).split('/').slice(0, -1);
  return { invoice_id: m[1], chave: m[2], pasta: pastas[pastas.length - 1] || '', caminho: String(nome) };
}
const RE_PASTA_IGNORADA = /simb[oó]lic|transfer[eê]ncia|retiro/i;

function lerTpNF(xml) {
  const m = String(xml || '').match(/<tpNF>([01])<\/tpNF>/);
  return m ? (m[1] === '1' ? 'saida' : 'entrada') : null;
}

/* A chave está no Bling? Dois passos, como o raio-x do snf aprendeu na marra:
   a LISTA é representação resumida (sem chaveAcesso confiável) e o filtro já foi
   visto sendo IGNORADO — então lista vazia absolve, lista com item só condena
   depois que o DETALHE confirmar a chave. Qualquer outra coisa: verificada:false. */
async function blingTemChave(tokenBling, chave) {
  try {
    const ac1 = new AbortController(); const t1 = setTimeout(() => ac1.abort(), 20000);
    let r, corpo;
    try {
      r = await _fetchRef.fn(BLING_BASE + '/nfe?chaveAcesso=' + chave, { headers: { Authorization: 'Bearer ' + tokenBling, Accept: 'application/json' }, signal: ac1.signal, timeout: 20000 });
      corpo = await r.text();
    } finally { clearTimeout(t1); }
    if (!r || (r.status !== 200)) return { verificada: false, erro: 'HTTP ' + (r ? r.status : 0) + ' na lista' };
    const j = jsonSeguro(corpo);
    const arr = (j && Array.isArray(j.data)) ? j.data : null;
    if (!arr) return { verificada: false, erro: 'lista ilegível' };
    if (!arr.length) return { verificada: true, esta_no_bling: false };
    if (arr.length > 3) return { verificada: false, erro: 'filtro chaveAcesso parece ignorado (' + arr.length + ' itens)' };
    const id = arr[0] && arr[0].id;
    if (!id) return { verificada: false, erro: 'item sem id na lista' };
    const ac2 = new AbortController(); const t2 = setTimeout(() => ac2.abort(), 20000);
    let r2, corpo2;
    try {
      r2 = await _fetchRef.fn(BLING_BASE + '/nfe/' + id, { headers: { Authorization: 'Bearer ' + tokenBling, Accept: 'application/json' }, signal: ac2.signal, timeout: 20000 });
      corpo2 = await r2.text();
    } finally { clearTimeout(t2); }
    if (!r2 || r2.status !== 200) return { verificada: false, erro: 'HTTP ' + (r2 ? r2.status : 0) + ' no detalhe' };
    const det = jsonSeguro(corpo2);
    const chaveDet = det && det.data && det.data.chaveAcesso ? String(det.data.chaveAcesso) : null;
    if (chaveDet === chave) return { verificada: true, esta_no_bling: true, id };
    return { verificada: false, erro: 'detalhe com outra chave (filtro ignorado?)' };
  } catch (e) {
    return { verificada: false, erro: String(e.message || e).slice(0, 160) };
  }
}

/* A varredura da fase 1 — manual, com teto de cota e matriz explícita:
   ignorada_simbolica · ja_baixada · ja_no_bling · pendente_nova · nao_conferida
   (erro/teto — NUNCA conclui) · anomalia (chave do nome ≠ chave do XML). */
async function varrerLote(empresa, de, ate, teto, deps) {
  const tokenML = deps && deps.tokenML ? deps.tokenML : await garantirToken(empresa);
  const rMe = await mlGet(tokenML, ML_API + '/users/me');
  const me = jsonSeguro(rMe.texto) || {};
  if (!rMe.ok || !me.id) {
    return { ok: false, resultado: rMe.transitorio ? 'transitorio_tente_de_novo' : 'erro_users_me_' + rMe.status };
  }
  const q = 'start=' + de + '&end=' + ate + '&sale=all&return=all&full=all&others=all&file_types=xml&simple_folder=false';
  const urlLote = ML_API + '/users/' + me.id + '/invoices/sites/MLB/batch_request/period/stream?' + q;
  const rz = await mlGetBuffer(tokenML, urlLote);
  if (rz.transitorio) return { ok: false, resultado: 'transitorio_tente_de_novo', detalhe: rz.buf.toString().slice(0, 200) };
  if (!rz.ok) return { ok: false, resultado: 'erro_lote_' + rz.status, detalhe: rz.buf.toString().slice(0, 400) };
  if (rz.buf.slice(0, 2).toString() !== 'PK') return { ok: false, resultado: 'lote_nao_veio_zip', detalhe: rz.buf.toString().slice(0, 400) };

  const AdmZip = require('adm-zip');
  let zip;
  try { zip = new AdmZip(rz.buf); } catch (e) { return { ok: false, resultado: 'zip_ilegivel', detalhe: String(e.message || e).slice(0, 200) }; }

  const censo = {};
  const novas = [], naoConferidas = [], anomalias = [];
  let ignoradasSimbolicas = 0, jaBaixadas = 0, jaNoBling = 0, consultasBling = 0;
  let tokenBling = (deps && deps.tokenBling) || null;

  for (const en of zip.getEntries()) {
    if (en.isDirectory) continue;
    const c = classificarEntradaZip(en.entryName);
    if (!c) continue;
    censo[c.pasta] = (censo[c.pasta] || 0) + 1;
    if (RE_PASTA_IGNORADA.test(c.caminho)) { ignoradasSimbolicas++; continue; }

    const xml = en.getData().toString('utf8');
    const chaveXml = extrairChave(xml);
    if (chaveXml !== c.chave) { anomalias.push({ arquivo: c.caminho, chave_nome: c.chave, chave_xml: chaveXml }); continue; }
    const tipo = lerTpNF(xml);
    if (!tipo) { anomalias.push({ arquivo: c.caminho, erro: 'sem tpNF legível' }); continue; }

    const nomeDisco = empresa + '-' + c.invoice_id + '-' + c.chave + '.xml';
    const destino = path.join(DIR, tipo, nomeDisco);
    if (fs.existsSync(destino)) { jaBaixadas++; continue; }

    if (consultasBling >= teto) { naoConferidas.push({ chave: c.chave, tipo, motivo: 'teto de ' + teto + ' consultas ao Bling — rode de novo' }); continue; }
    if (!tokenBling) {
      try { tokenBling = await garantirTokenBling(empresa); }
      catch (e) { return { ok: false, resultado: 'sem_token_bling', detalhe: String(e.message || e) }; }
    }
    const b = await blingTemChave(tokenBling, c.chave);
    consultasBling += b.esta_no_bling === true ? 2 : 1;
    await sleep(350);
    if (!b.verificada) { naoConferidas.push({ chave: c.chave, tipo, motivo: b.erro }); continue; }
    if (b.esta_no_bling) { jaNoBling++; continue; }

    fs.mkdirSync(path.join(DIR, tipo), { recursive: true });
    fs.writeFileSync(destino, xml);
    novas.push({ tipo, invoice_id: c.invoice_id, chave: c.chave, arquivo: nomeDisco, numero: String(Number(c.chave.slice(25, 34))) });
  }

  return {
    ok: true, janela: { de, ate }, uid: me.id,
    censo_pastas: censo,
    ignoradas_simbolicas: ignoradasSimbolicas,
    ja_baixadas: jaBaixadas,
    ja_no_bling: jaNoBling,
    pendentes_novas: novas.length,
    nao_conferidas: naoConferidas.length,
    anomalias: anomalias.length ? anomalias : undefined,
    consultas_bling: consultasBling,
    novas,
    lista_nao_conferidas: naoConferidas.length ? naoConferidas : undefined,
    aviso: naoConferidas.length ? 'nao_conferidas NÃO são veredito — erro/teto na consulta; rode de novo que a varredura é idempotente' : undefined,
  };
}

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

/* b3: o motor separa por tipo em subpastas; a raiz (legado das sondas) conta como saída */
function _pastasDoTipo(tipo) {
  if (tipo === 'entrada') return [path.join(DIR, 'entrada')];
  if (tipo === 'saida') return [DIR, path.join(DIR, 'saida')];
  return [DIR, path.join(DIR, 'saida'), path.join(DIR, 'entrada')];
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

/* Codex #348: o check literal de '..' era pouco — %252e no navegador vira %2e no
   searchParams.get() e o WHATWG resolve como ponto-ponto NA HORA DO FETCH, escapando
   do confinamento e transformando a sonda em proxy autenticado do ML. A validação
   certa é no PATHNAME NORMALIZADO — exatamente a URL que o fetch vai usar. */
function urlDoLote(uid, caminho, q) {
  const prefixo = '/users/' + uid + '/invoices/';
  let u;
  try { u = new URL(ML_API + prefixo + String(caminho || '').replace(/^\/+/, '') + (q ? ('?' + q) : '')); }
  catch (e) { return { ok: false, erro: 'caminho/q inválidos' }; }
  if (u.origin + '/' !== ML_API + '/' || !u.pathname.startsWith(prefixo)) {
    return { ok: false, erro: 'caminho fora de ' + prefixo + ' — isto é sonda, não proxy' };
  }
  return { ok: true, url: u.toString() };
}

function listarArquivos(empresa, tipo) {
  const saida = [];
  for (const pasta of _pastasDoTipo(tipo)) {
    let nomes = [];
    try { nomes = fs.readdirSync(pasta); } catch (e) { continue; }
    for (const n of nomes) {
      if (!n.endsWith('.xml') || (empresa && !n.startsWith(empresa + '-'))) continue;
      const cheio = path.join(pasta, n);
      let st; try { st = fs.statSync(cheio); } catch (e) { continue; }
      if (!st.isFile()) continue;
      saida.push({ arquivo: n, caminho: cheio, tipo: pasta.endsWith('entrada') ? 'entrada' : 'saida', bytes: st.size, em: st.mtime.toISOString() });
    }
  }
  return saida.sort((a, b) => (a.em < b.em ? 1 : -1));
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

  /* FASE 1 DO MOTOR: varredura MANUAL por janela (cron só depois de validada).
     Gasta cota do Bling (1-2 GETs por nota nova) — rodar fora do horário do galpão. */
  if (p === '/ml-full/varrer') {
    const empresa = String(urlObj.searchParams.get('empresa') || 'amb').toLowerCase().trim();
    if (!MANAGERS[empresa]) { json(res, 400, { ok: false, erro: 'empresa deve ser amb, girassol ou good' }); return true; }
    const de = String(urlObj.searchParams.get('de') || '');
    const ate = String(urlObj.searchParams.get('ate') || '');
    if (!/^\d{8}$/.test(de) || !/^\d{8}$/.test(ate)) {
      json(res, 400, { ok: false, erro: 'passe &de=AAAAMMDD&ate=AAAAMMDD', exemplo: '/ml-full/varrer?empresa=amb&de=20260901&ate=20260907&k=SUA_ADMIN_KEY' });
      return true;
    }
    const dDe = Date.parse(de.slice(0, 4) + '-' + de.slice(4, 6) + '-' + de.slice(6, 8) + 'T12:00:00Z');
    const dAte = Date.parse(ate.slice(0, 4) + '-' + ate.slice(4, 6) + '-' + ate.slice(6, 8) + 'T12:00:00Z');
    if (!dDe || !dAte || dAte < dDe || (dAte - dDe) > 7 * 86400000) {
      json(res, 400, { ok: false, erro: 'janela inválida — no máximo 7 dias por varredura (cota do Bling)' });
      return true;
    }
    const teto = Math.max(1, Math.min(200, Number(urlObj.searchParams.get('teto')) || 60));
    let tokenML;
    try { tokenML = await garantirToken(empresa); }
    catch (e) { json(res, 200, { ok: false, erro: String(e.message || e) }); return true; }
    const r = await varrerLote(empresa, de, ate, teto, { tokenML });
    json(res, r.ok ? 200 : 200, Object.assign({ versao: VERSAO, empresa }, r, r.ok ? {
      baixar_saida: 'https://mover-pedidos-aguardando-x-atendido.onrender.com/ml-full/zip?empresa=' + empresa + '&tipo=saida&k=SUA_ADMIN_KEY',
      baixar_entrada: 'https://mover-pedidos-aguardando-x-atendido.onrender.com/ml-full/zip?empresa=' + empresa + '&tipo=entrada&k=SUA_ADMIN_KEY',
    } : {}));
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
    const caminho = String(urlObj.searchParams.get('caminho') || 'sites/MLB/batch_request/period/stream');
    const q = String(urlObj.searchParams.get('q') || '');
    const alvo = urlDoLote(me.id, caminho, q);
    if (!alvo.ok) { json(res, 400, { ok: false, erro: alvo.erro }); return true; }
    const url = alvo.url;
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
    const tipo = String(urlObj.searchParams.get('tipo') || 'saida').toLowerCase().trim();
    if (tipo !== 'saida' && tipo !== 'entrada') { json(res, 400, { ok: false, erro: 'tipo deve ser saida ou entrada' }); return true; }
    const arquivos = listarArquivos(empresa, tipo);
    if (!arquivos.length) { json(res, 200, { ok: false, erro: 'nenhum XML de ' + tipo + ' salvo para ' + empresa + ' — rode /ml-full/varrer (ou a sonda) primeiro' }); return true; }
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    for (const a of arquivos) zip.addLocalFile(a.caminho);
    const buf = zip.toBuffer();
    const hoje = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="nf-ml-full-' + empresa + '-' + tipo + '-' + hoje + '.zip"',
      'Content-Length': buf.length,
    });
    res.end(buf);
    return true;
  }

  if (p === '/ml-full/status') {
    const empresa = String(urlObj.searchParams.get('empresa') || '').toLowerCase().trim() || null;
    json(res, 200, { ok: true, versao: VERSAO, dir: DIR, empresa: empresa || '(todas)', arquivos: listarArquivos(empresa, null) });
    return true;
  }

  return false;
}

module.exports = {
  tratar, VERSAO,
  _interno: {
    sondarVenda, sondarUmaOrder, sondarNota, urlDoLote, mlGet, extrairChave, garantirToken, listarArquivos,
    varrerLote, classificarEntradaZip, lerTpNF, blingTemChave, comPrazo,
    _trocarFetchParaTeste(f) { _fetchRef.fn = f; },
  },
};
