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
const _mlManagersRef = { map: {
  amb:      () => require('./ambtotal/mlTokenManager'),
  girassol: () => require('./girassol/mlTokenManager'),
  good:     () => require('./good/mlTokenManager'),
} };
const MANAGERS = new Proxy({}, { get: (_, k) => _mlManagersRef.map[k], has: (_, k) => k in _mlManagersRef.map });

/* Codex #350 r3 (P1): o comPrazo estoura, o refresh de USO ÚNICO segue em background
   por design (#344) — e o lock da varredura solta no finally: outra varredura podia
   entrar e disparar um SEGUNDO refresh concorrente, queimando o token. A aquisição
   agora é uma PROMESSA ÚNICA por empresa: todo chamador espera a mesma (cada um com
   o próprio prazo); nunca há dois garantirTokenML em voo pra mesma empresa. */
const _tokenMLEmVoo = new Map();
function _aquisicaoTokenML(empresa) {
  let p = _tokenMLEmVoo.get(empresa);
  if (!p) {
    const mk = _mlManagersRef.map[empresa];
    if (!mk) return Promise.reject(new Error('empresa desconhecida: ' + empresa));
    p = Promise.resolve().then(() => mk().garantirTokenML()).finally(() => _tokenMLEmVoo.delete(empresa));
    p.catch(() => {});
    _tokenMLEmVoo.set(empresa, p);
  }
  return p;
}

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
const _blingTokensRef = { map: {
  amb:      () => require('./ambtotal/tokenManager'),
  girassol: () => require('./girassol/tokenManager'),
  good:     () => require('./good/tokenManager'),
} };
const BLING_TOKENS = new Proxy({}, { get: (_, k) => _blingTokensRef.map[k], has: (_, k) => k in _blingTokensRef.map });

/* Codex #349 r3 (provado no interpretador antes de escrever): o parser ISO do V8
   NORMALIZA o dia — '2026-02-30T12Z' vira 2 de março, '04-31' vira 1º de maio; só
   mês >12 dá NaN. Round-trip: reconstitui AAAAMMDD do timestamp e exige igualdade. */
function dataValida(aaaammdd) {
  if (!/^\d{8}$/.test(String(aaaammdd))) return null;
  const iso = aaaammdd.slice(0, 4) + '-' + aaaammdd.slice(4, 6) + '-' + aaaammdd.slice(6, 8);
  const ts = Date.parse(iso + 'T12:00:00Z');
  if (!ts) return null;
  return new Date(ts).toISOString().slice(0, 10) === iso ? ts : null;
}

/* Codex #349 r4 (P1 — a MESMA classe que o canário levou hoje, agora portada): com
   teto finito, as notas presentes que abrem o lote re-gastavam consulta em toda rodada
   e uma faltante lá no fim ficava inalcançável pra sempre. Receita idêntica ao #347:
   presença CONFIRMADA vira cache de 7 dias (não re-gasta) e a fila de candidatas
   ROTACIONA com o dia — avança mesmo com cache frio pós-deploy. */
const _confirmadasNoBling = new Map(); // chave → ts da confirmação
const TTL_CONFIRMADA = 7 * 86400000;
/* Codex #349 r5 (P2, no acerto): duas varreduras simultâneas da MESMA empresa dobram
   o tráfego e a segunda quebra no renameSync do que a primeira arquivou (ENOENT).
   Trava simples por empresa; a rota devolve 409 amigável. */
const _varrendo = new Set();
/* Codex #350 r1: rotação ALEATÓRIA pode repetir faixas e deixar posições sem visita por
   muitas rodadas — o cursor monotônico por empresa avança exatamente pelo que a rodada
   COBRIU, então rodadas sucessivas percorrem faixas disjuntas até dar a volta. */
const _cursorFila = new Map(); // empresa → próxima posição de partida

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
/* Acerto pós-varredura de fogo (07/09): o censo real mostrou que vendas e devoluções
   vêm juntas em 'Autorizadas' — e existe a pasta 'Canceladas'. NF cancelada não se
   importa; ela é insumo da futura fila 'cancelada no ML × viva no Bling' (anotado). */
const RE_PASTA_CANCELADA = /(^|\/)Canceladas(\/|$)/i;

function lerTpNF(xml) {
  const m = String(xml || '').match(/<tpNF>([01])<\/tpNF>/);
  return m ? (m[1] === '1' ? 'saida' : 'entrada') : null;
}

/* Sonda-situação de 08/09 (nota 3795, detalhe confirmando chave E situação):
   no Bling v3, situacao=2 é CANCELADA — e a lista padrão NÃO as devolve. */
const SITUACAO_CANCELADA_BLING = 2;

/* A chave está no Bling? Dois passos, como o raio-x do snf aprendeu na marra:
   a LISTA é representação resumida (sem chaveAcesso confiável) e o filtro já foi
   visto sendo IGNORADO — então lista vazia absolve, lista com item só condena
   depois que o DETALHE confirmar a chave. Qualquer outra coisa: verificada:false. */
async function blingTemChave(tokenBling, chave, orcamentoRestante, tipo) {
  /* Conserto da CEGUEIRA (provada em 07-08/09 com 7 falso-ausentes) + #352 r1:
     a lista padrão não devolve CANCELADAS (situacao=2, cravado pela sonda) nem,
     pela evidência das entradas 8150/8086, notas de ENTRADA (tipo=0 quando o
     tpNF do XML é entrada). Sequência: lista padrão → se vazia OU se o candidato
     não confirmar a chave no detalhe (filtro ignorado), lista de canceladas →
     detalhe confirma. Ausente conclusivo exige as DUAS listas vazias. Cada GET
     conta em `feitas` NO INSTANTE em que começa; teto no meio adia com flag,
     nunca conclui. Cancelada confirmada custa até 4 chamadas — por isso o teto
     mínimo público subiu (rota). */
  let feitas = 0;
  const sufTipo = tipo === 'entrada' ? '&tipo=0' : '';
  const listar = async (extra) => {
    await sleep(350);
    feitas++;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await _fetchRef.fn(BLING_BASE + '/nfe?chaveAcesso=' + chave + sufTipo + extra, { headers: { Authorization: 'Bearer ' + tokenBling, Accept: 'application/json' }, signal: ac.signal, timeout: 20000 });
      return { r, corpo: await r.text() };
    } finally { clearTimeout(t); }
  };
  const detalhar = async (id) => {
    await sleep(350);
    feitas++;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
    try {
      const r = await _fetchRef.fn(BLING_BASE + '/nfe/' + id, { headers: { Authorization: 'Bearer ' + tokenBling, Accept: 'application/json' }, signal: ac.signal, timeout: 20000 });
      return { r, corpo: await r.text() };
    } finally { clearTimeout(t); }
  };
  const lerLista = (res, rotulo) => {
    if (!res.r || res.r.status !== 200) return { erro: 'HTTP ' + (res.r ? res.r.status : 0) + ' na ' + rotulo };
    const j = jsonSeguro(res.corpo);
    const arr = (j && Array.isArray(j.data)) ? j.data : null;
    if (!arr) return { erro: rotulo + ' ilegível' };
    if (arr.length > 1) return { erro: rotulo + ' com ' + arr.length + ' itens pra chave única (filtro ignorado?)' };
    return { arr };
  };
  try {
    const l1 = lerLista(await listar(''), 'lista');
    if (l1.erro) return { verificada: false, erro: l1.erro, chamadas: feitas };

    let candidato = l1.arr.length ? l1.arr[0] : null;

    if (candidato && candidato.id) {
      if (Number(orcamentoRestante) - feitas < 1) return { verificada: false, teto: true, erro: 'teto no meio — lista feita, detalhe adiado pra próxima rodada', chamadas: feitas };
      const d1 = await detalhar(candidato.id);
      if (!d1.r || d1.r.status !== 200) return { verificada: false, erro: 'HTTP ' + (d1.r ? d1.r.status : 0) + ' no detalhe', chamadas: feitas };
      const det1 = jsonSeguro(d1.corpo);
      if (!det1 || !det1.data) return { verificada: false, erro: 'detalhe 200 ilegível', chamadas: feitas };
      if (String(det1.data.chaveAcesso || '') === chave) return { verificada: true, esta_no_bling: true, id: candidato.id, chamadas: feitas };
      /* #352 r1 (P2): candidato ERRADO (filtro ignorado) não encerra — a cancelada
         ainda pode existir; cai pra segunda lista em vez de inconcluir pra sempre. */
    }

    if (Number(orcamentoRestante) - feitas < 1) return { verificada: false, teto: true, erro: 'teto no meio — lista de canceladas adiada', chamadas: feitas };
    const l2 = lerLista(await listar('&situacao=' + SITUACAO_CANCELADA_BLING), 'lista de canceladas');
    if (l2.erro) return { verificada: false, erro: l2.erro, chamadas: feitas };
    if (!l2.arr.length) {
      return { verificada: true, esta_no_bling: false, chamadas: feitas };
    }
    const cand2 = l2.arr[0];
    if (!cand2 || !cand2.id) return { verificada: false, erro: 'item sem id na lista de canceladas', chamadas: feitas };
    if (Number(orcamentoRestante) - feitas < 1) return { verificada: false, teto: true, erro: 'teto no meio — detalhe da cancelada adiado', chamadas: feitas };
    const d2 = await detalhar(cand2.id);
    if (!d2.r || d2.r.status !== 200) return { verificada: false, erro: 'HTTP ' + (d2.r ? d2.r.status : 0) + ' no detalhe da cancelada', chamadas: feitas };
    const det2 = jsonSeguro(d2.corpo);
    if (!det2 || !det2.data) return { verificada: false, erro: 'detalhe da cancelada 200 ilegível', chamadas: feitas };
    if (String(det2.data.chaveAcesso || '') === chave) return { verificada: true, esta_no_bling: true, cancelada: true, id: cand2.id, chamadas: feitas };
    return { verificada: false, erro: 'detalhes com outra chave nas duas listas (filtro ignorado?)', chamadas: feitas };
  } catch (e) {
    return { verificada: false, erro: String(e.message || e).slice(0, 160), chamadas: feitas || 1 };
  }
}

async function varrerLote(empresa, de, ate, teto, deps) {
  if (_varrendo.has(empresa)) return { ok: false, resultado: 'ja_ha_varredura_em_andamento', detalhe: 'espere a varredura atual da ' + empresa + ' terminar (a resposta dela traz o resultado)' };
  _varrendo.add(empresa);
  try {
    return await _varrerLoteInterno(empresa, de, ate, teto, deps);
  } catch (e) {
    return { ok: false, resultado: 'erro_varredura', detalhe: String(e.message || e).slice(0, 200) };
  } finally { _varrendo.delete(empresa); }
}

async function _varrerLoteInterno(empresa, de, ate, teto, deps) {
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
  const canceladasNoLote = [];
  const chavesCanceladas = new Set();
  let quarentenadas = 0;
  let tokenBling = (deps && deps.tokenBling) || null;

  /* Codex #349 r2: a sonda salvou legados na RAIZ com outro padrão de nome — conferir
     só o destino tipado deixaria o /varrer gravar uma SEGUNDA cópia da mesma chave e o
     ZIP apresentaria a NF-e duas vezes. O dedup é por CHAVE, atravessando raiz+tipadas. */
  /* Codex #350 r2 (P1): a MESMA chave pode existir em MAIS de um caminho (legado da raiz
     + cópia tipada — estado histórico real deste módulo); Map chave→um caminho movia só
     uma cópia e o ZIP continuava servindo a outra. Vale pra quarentena E pro arquivar. */
  const chavesDisco = new Map(); // chave → TODOS os caminhos no disco
  for (const a of listarArquivos(empresa, null)) {
    const mNome = a.arquivo.match(/-(\d{44})\.xml$/);
    let ch = mNome ? mNome[1] : null;
    if (!ch) { try { ch = extrairChave(fs.readFileSync(a.caminho, 'utf8')); } catch (e) {} }
    if (!ch) continue;
    if (!chavesDisco.has(ch)) chavesDisco.set(ch, []);
    chavesDisco.get(ch).push(a.caminho);
  }
  let arquivadas = 0;
  /* Codex #350 r3 (P2): rename que falha não pode sumir — o chamador reportaria
     arquivada/quarentenada com a cópia ainda sendo servida pelo /zip. */
  const moverTodas = (caminhos, subpasta) => {
    const dest = path.join(DIR, subpasta);
    fs.mkdirSync(dest, { recursive: true });
    let movidos = 0, falhas = 0;
    for (const cam of caminhos) {
      try { fs.renameSync(cam, path.join(dest, path.basename(cam))); movidos++; } catch (e) { falhas++; }
    }
    return { movidos, falhas };
  };

  const candidatas = [];
  for (const en of zip.getEntries()) {
    if (en.isDirectory) continue;
    const c = classificarEntradaZip(en.entryName);
    if (!c) continue;
    censo[c.pasta] = (censo[c.pasta] || 0) + 1;
    if (RE_PASTA_IGNORADA.test(c.caminho)) { ignoradasSimbolicas++; continue; }
    if (RE_PASTA_CANCELADA.test(c.caminho)) {
      /* Codex #350 r2 (P2): o nome do arquivo pode mentir — o ramo autorizado valida a
         chave do XML e o cancelado pulava a validação, quarentenando pela fé no nome.
         Mismatch é anomalia aqui também, sem quarentena e sem marcar a chave. */
      const chaveXmlCanc = extrairChave(en.getData().toString('utf8'));
      if (chaveXmlCanc !== c.chave) { anomalias.push({ arquivo: c.caminho, chave_nome: c.chave, chave_xml: chaveXmlCanc }); continue; }
      canceladasNoLote.push({ invoice_id: c.invoice_id, chave: c.chave });
      chavesCanceladas.add(c.chave);
      /* Codex #350 r1 (P1): cancelada JÁ SALVA ficaria no ZIP pra sempre — TODAS as
         cópias vão pra quarentena canceladas/ (r2: inclusive raiz+tipada da mesma chave). */
      const caminhosCanc = chavesDisco.get(c.chave);
      if (caminhosCanc && caminhosCanc.length) {
        const mv = moverTodas(caminhosCanc, 'canceladas');
        if (!mv.falhas) { quarentenadas++; chavesDisco.delete(c.chave); }
        else anomalias.push({ chave: c.chave, erro: 'quarentena parcial: ' + mv.falhas + ' cópia(s) não movida(s) — a chave segue no ZIP até a próxima rodada' });
      }
      continue;
    }

    const xml = en.getData().toString('utf8');
    const chaveXml = extrairChave(xml);
    if (chaveXml !== c.chave) { anomalias.push({ arquivo: c.caminho, chave_nome: c.chave, chave_xml: chaveXml }); continue; }
    const tipo = lerTpNF(xml);
    if (!tipo) { anomalias.push({ arquivo: c.caminho, erro: 'sem tpNF legível' }); continue; }
    candidatas.push({ c, xml, tipo });
  }

  /* Codex #350 r3 (P1): cursor por empresa colidia entre JANELAS — varrer outra data
     sobrescrevia o progresso da primeira. A identidade do cursor é empresa+janela. */
  const chaveCursor = empresa + '|' + de + '|' + ate;
  const _rot = candidatas.length ? (_cursorFila.get(chaveCursor) || 0) % candidatas.length : 0;
  const fila = candidatas.slice(_rot).concat(candidatas.slice(0, _rot));
  /* Codex #350 r2 (P1): avançar por CONTAGEM de resolvidas pulava posições — cache-hit
     DEPOIS do corte contava, a cortada no meio não, e (6 candidatas, última em cache,
     teto=1) visitava só 1,3,5 pra sempre. O cursor avança até a PRIMEIRA cortada por
     teto: prefixo contíguo resolvido, nada fica pra trás. */
  let primeiroCorte = null;
  let idxFila = -1;

  for (const cand of fila) {
    idxFila++;
    const c = cand.c, xml = cand.xml, tipo = cand.tipo;
    if (chavesCanceladas.has(c.chave)) continue; // apareceu também em Canceladas: nunca importa

    /* presença confirmada há menos de 7 dias: não gasta consulta */
    const conf = _confirmadasNoBling.get(c.chave);
    if (conf && (Date.now() - conf) < TTL_CONFIRMADA) {
      const salvaConf = chavesDisco.get(c.chave);
      if (salvaConf && salvaConf.length) {
        const mv = moverTodas(salvaConf, 'importadas');
        if (!mv.falhas) { chavesDisco.delete(c.chave); arquivadas++; }
        else { jaBaixadas++; naoConferidas.push({ chave: c.chave, tipo, motivo: 'no Bling, mas arquivamento parcial (' + mv.falhas + ' cópia(s))' }); }
      }
      else jaNoBling++;
      continue;
    }

    const nomeDisco = empresa + '-' + c.invoice_id + '-' + c.chave + '.xml';
    const destino = path.join(DIR, tipo, nomeDisco);
    /* Codex #349 r3: arquivo salvo NÃO é destino final — depois que o operador importa,
       a chave passa a existir no Bling e o ZIP precisa parar de re-apresentá-la. Salva
       re-encontrada no lote é RE-CONFERIDA (dentro do teto) e, presente no Bling, vai
       pra importadas/ (fora dos ZIPs, histórico preservado); ausente/erro segue no ZIP. */
    const caminhosSalvos = chavesDisco.get(c.chave) || (fs.existsSync(destino) ? [destino] : null);
    const jaSalva = !!(caminhosSalvos && caminhosSalvos.length);

    if (consultasBling >= teto) {
      if (primeiroCorte === null) primeiroCorte = idxFila;
      if (jaSalva) { jaBaixadas++; continue; }
      naoConferidas.push({ chave: c.chave, tipo, motivo: 'teto de ' + teto + ' consultas ao Bling — rode de novo' });
      continue;
    }
    if (!tokenBling) {
      try { tokenBling = await garantirTokenBling(empresa); }
      catch (e) { return { ok: false, resultado: 'sem_token_bling', detalhe: String(e.message || e) }; }
      /* Codex #349 r4 (encerrando a classe pela via que o revisor ofereceu): a aquisição
         do token é trabalho OPACO do manager — 1 sonda e, com token vencido, +1 refresh
         OAuth; somar um número fixo aqui seria chute (r3 somava 1 e errava no vencido).
         Fica DECLARADO fora do teto: o teto governa as consultas DO VARREDOR; a
         aquisição acontece no máximo 1× por varredura e a resposta avisa em nota_cota. */
    }
    if (jaSalva) {
      const b0 = await blingTemChave(tokenBling, c.chave, teto - consultasBling, tipo);
      consultasBling += b0.chamadas || 1;
      if (b0.verificada && b0.esta_no_bling) {
        _confirmadasNoBling.set(c.chave, Date.now());
        const mv = moverTodas(caminhosSalvos, 'importadas');
        if (!mv.falhas) { chavesDisco.delete(c.chave); arquivadas++; }
        else { jaBaixadas++; naoConferidas.push({ chave: c.chave, tipo, motivo: 'no Bling, mas arquivamento parcial (' + mv.falhas + ' cópia(s)) — segue no ZIP até mover' }); }
      }
      else if (!b0.verificada) {
        if (b0.teto && primeiroCorte === null) primeiroCorte = idxFila;
        /* Codex #349 r4: reconferência que falhou NÃO pode sumir como ja_baixada — o
           relatório pareceria completo com status jamais verificado. O arquivo fica,
           e a pendência aparece nomeada. */
        jaBaixadas++;
        naoConferidas.push({ chave: c.chave, tipo, motivo: 'salva no disco; reconferência falhou: ' + b0.erro });
      }
      else jaBaixadas++;
      continue;
    }
    const b = await blingTemChave(tokenBling, c.chave, teto - consultasBling, tipo);
    consultasBling += b.chamadas || 1;

    if (!b.verificada) {
      if (b.teto && primeiroCorte === null) primeiroCorte = idxFila;
      naoConferidas.push({ chave: c.chave, tipo, motivo: b.erro });
      continue;
    }
    if (b.esta_no_bling) { _confirmadasNoBling.set(c.chave, Date.now()); jaNoBling++; continue; }

    fs.mkdirSync(path.join(DIR, tipo), { recursive: true });
    fs.writeFileSync(destino, xml);
    chavesDisco.set(c.chave, [destino]);
    novas.push({ tipo, invoice_id: c.invoice_id, chave: c.chave, arquivo: nomeDisco, numero: String(Number(c.chave.slice(25, 34))) });
  }

  if (candidatas.length) _cursorFila.set(chaveCursor, (_rot + (primeiroCorte === null ? fila.length : primeiroCorte)) % candidatas.length);
  return {
    ok: true, janela: { de, ate }, uid: me.id,
    censo_pastas: censo,
    ignoradas_simbolicas: ignoradasSimbolicas,
    canceladas_no_lote: canceladasNoLote.length || undefined,
    canceladas_quarentenadas: quarentenadas || undefined,
    canceladas: canceladasNoLote.length ? canceladasNoLote : undefined,
    ja_baixadas: jaBaixadas,
    arquivadas_no_bling: arquivadas,
    ja_no_bling: jaNoBling,
    pendentes_novas: novas.length,
    nao_conferidas: naoConferidas.length,
    anomalias: anomalias.length ? anomalias : undefined,
    consultas_bling: consultasBling,
    nota_cota: 'o teto cobre as consultas do varredor; a aquisição do token Bling (1-2 req do manager, no máx. 1x por varredura) fica fora dele',
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
    const tk = await comPrazo(_aquisicaoTokenML(empresa), 30000, 'validação do token ML da ' + empresa);
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

/* Codex #349 (P1): a raiz (legado das sondas) NÃO pode ser assumida como saída — a
   própria sonda-nota nasceu pra buscar DEVOLUÇÃO e salvou a 7935 (tpNF 0) ali; mapear
   raiz=saída poria uma entrada no ZIP de saída, direção fiscal errada. Arquivo de raiz
   é classificado pelo tpNF do PRÓPRIO XML; ilegível fica fora dos ZIPs tipados
   (aparece só no /status como 'desconhecido'). */
function _pastasDeVarredura() {
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
  for (const pasta of _pastasDeVarredura()) {
    let nomes = [];
    try { nomes = fs.readdirSync(pasta); } catch (e) { continue; }
    const daRaiz = pasta === DIR;
    for (const n of nomes) {
      if (!n.endsWith('.xml') || (empresa && !n.startsWith(empresa + '-'))) continue;
      const cheio = path.join(pasta, n);
      let st; try { st = fs.statSync(cheio); } catch (e) { continue; }
      if (!st.isFile()) continue;
      let t;
      if (daRaiz) {
        try { t = lerTpNF(fs.readFileSync(cheio, 'utf8')) || 'desconhecido'; } catch (e) { t = 'desconhecido'; }
      } else t = pasta.endsWith('entrada') ? 'entrada' : 'saida';
      if (tipo && t !== tipo) continue;
      saida.push({ arquivo: n, caminho: cheio, tipo: t, bytes: st.size, em: st.mtime.toISOString() });
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
    const dDe = dataValida(de);
    const dAte = dataValida(ate);
    if (!dDe || !dAte || dAte < dDe || (dAte - dDe) >= 7 * 86400000) {
      /* Codex #349 (P2): de/ate são datas INCLUSIVAS — 01→08 são 8 dias corridos e passava */
      json(res, 400, { ok: false, erro: 'janela inválida — no máximo 7 dias corridos, inclusive as pontas (cota do Bling)' });
      return true;
    }
    /* Codex #350 r3 + #352 r1: teto pequeno pina o cursor numa chave inconcluível —
       e a CANCELADA confirmada custa até 4 chamadas (filtro-ignorado no caminho:
       lista + detalhe errado + lista de canceladas + detalhe). Mínimo público: 4. */
    const teto = Math.max(4, Math.min(200, Number(urlObj.searchParams.get('teto')) || 60));
    /* Codex #350 r1: o token ML entra DENTRO do lock (o refresh do ML é de uso único —
       duas aquisições simultâneas podiam corromper a renovação antes mesmo da trava);
       e a recusa de concorrência sai como 409 de verdade, não 200. */
    const r = await varrerLote(empresa, de, ate, teto, null);
    json(res, r.resultado === 'ja_ha_varredura_em_andamento' ? 409 : 200, Object.assign({ versao: VERSAO, empresa }, r, r.ok ? {
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

  /* SONDA-SITUAÇÃO (07/09): a lista GET /nfe?chaveAcesso= NÃO enxerga canceladas
     (provado com as 3795/3858, canceladas no Bling e invisíveis pra busca) — e a doc
     pública não publica o enum de situacao. Esta sonda varre situacao=1..12 com uma
     chave de cancelada CONHECIDA e revela qual código a torna visível; com o código
     na mão, o blingTemChave ganha a segunda consulta e canceladas presentes deixam
     de virar falso-ausente. 12 GETs com o ritmo da casa, uma vez, só leitura. */
  if (p === '/ml-full/sonda-situacao') {
    const empresa = String(urlObj.searchParams.get('empresa') || 'amb').toLowerCase().trim();
    if (!MANAGERS[empresa]) { json(res, 400, { ok: false, erro: 'empresa deve ser amb, girassol ou good' }); return true; }
    const chave = String(urlObj.searchParams.get('chave') || '').trim();
    if (!/^\d{44}$/.test(chave)) { json(res, 400, { ok: false, erro: 'passe &chave= com os 44 dígitos de uma nota que você SABE estar cancelada no Bling' }); return true; }
    let tokenBling;
    try { tokenBling = await garantirTokenBling(empresa); }
    catch (e) { json(res, 200, { ok: false, erro: String(e.message || e) }); return true; }
    const resultados = [];
    for (let sit = 1; sit <= 12; sit++) {
      await sleep(350);
      let linha = { situacao: sit };
      try {
        const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20000);
        let r, corpo;
        try {
          r = await _fetchRef.fn(BLING_BASE + '/nfe?chaveAcesso=' + chave + '&situacao=' + sit, { headers: { Authorization: 'Bearer ' + tokenBling, Accept: 'application/json' }, signal: ac.signal, timeout: 20000 });
          corpo = await r.text();
        } finally { clearTimeout(t); }
        const j = jsonSeguro(corpo);
        const arr = (j && Array.isArray(j.data)) ? j.data : null;
        linha.status = r.status;
        linha.itens = arr ? arr.length : null;
        /* Codex #351 r3: 200 com corpo ilegível não é sucesso — sem isto, contribuía
           pro veredito negativo conclusivo. */
        if (r.status === 200 && arr === null) linha.erro = 'corpo 200 ilegível';
        /* Codex #351 r2: TODOS os candidatos (até 3) são inspecionados — a nota certa pode
           vir em arr[1] com o filtro ignorado; falha do DETALHE conta como falha da linha;
           e a evidência definitiva do enum é o situacao DO DETALHE da nota confirmada
           (o filtro situacao também pode ser ignorado — chave batendo com sit errado não
           revela nada, mas ENTREGA a situação real, que é a resposta que queremos). */
        if (arr && arr.length) {
          for (const cand of arr.slice(0, 3)) {
            if (!cand || !cand.id) continue;
            await sleep(350);
            const ac2 = new AbortController(); const t2 = setTimeout(() => ac2.abort(), 20000);
            try {
              const r2 = await _fetchRef.fn(BLING_BASE + '/nfe/' + cand.id, { headers: { Authorization: 'Bearer ' + tokenBling, Accept: 'application/json' }, signal: ac2.signal, timeout: 20000 });
              const corpo2 = await r2.text();
              if (!r2 || r2.status !== 200) { linha.detalhe_falhou = 'HTTP ' + (r2 ? r2.status : 0); continue; }
              const det = jsonSeguro(corpo2);
              /* Codex #351 r4: detalhe 200 ILEGÍVEL é falha, não mismatch — senão viraria
                 negativo conclusivo com o detalhe quebrado. */
              if (!det || !det.data) { linha.detalhe_falhou = 'detalhe 200 ilegível'; continue; }
              const chaveDet = det.data.chaveAcesso ? String(det.data.chaveAcesso) : null;
              if (chaveDet === chave) {
                linha.chave_confirmada = true;
                linha.situacao_da_nota = det.data.situacao;
                linha.primeiro = { id: cand.id, numero: det.data.numero, serie: det.data.serie, situacao: det.data.situacao };
                break;
              }
            } catch (e) { linha.detalhe_falhou = String(e.message || e).slice(0, 80); } finally { clearTimeout(t2); }
          }
          if (!linha.chave_confirmada && !linha.detalhe_falhou) {
            /* Codex #351 r3: com mais de 3 candidatos, a chave pode estar além do corte —
               a linha vira INCONCLUSIVA (conta como falha), nunca negativo conclusivo. */
            if (arr.length > 3) linha.inconclusiva = 'lista com ' + arr.length + ' itens, só 3 inspecionados';
            else linha.filtro_ignorado = true;
          }
        }
      } catch (e) { linha.erro = String(e.message || e).slice(0, 120); }
      resultados.push(linha);
    }
    /* Codex #351 r2 — precedência epistemológica: positivo CONFIRMADO vale mesmo com
       falhas alheias (falha só impede o veredito NEGATIVO); reveladora exige o situacao
       do detalhe casando com o sit pedido; e a situação REAL da nota (do detalhe) sai
       na resposta ainda que nenhum filtro tenha funcionado — é ela a resposta final. */
    const falharam = resultados.filter(x => x.erro || x.status !== 200 || x.detalhe_falhou || x.inconclusiva).length;
    const reveladoras = resultados.filter(x => x.chave_confirmada === true && String(x.situacao_da_nota) === String(x.situacao)).map(x => x.situacao);
    const confirmadaQualquer = resultados.find(x => x.chave_confirmada === true);
    const situacaoReal = confirmadaQualquer ? confirmadaQualquer.situacao_da_nota : null;
    let veredito;
    if (reveladoras.length) {
      veredito = 'a(s) situação(ões) ' + reveladoras.join(', ') + ' revela(m) esta chave (detalhe confirmou chave E situação)'
        + (falharam ? ' — ' + falharam + ' outras consultas falharam, sem afetar o positivo' : '');
    } else if (situacaoReal != null) {
      veredito = 'a nota ESTÁ no Bling com situacao=' + situacaoReal + ' (detalhe confirmou a chave), mas nenhum filtro situacao pedido casou — o filtro parece ignorado; use situacao=' + situacaoReal + ' no conserto';
    } else if (falharam) {
      veredito = 'INCONCLUSIVO — ' + falharam + ' das consultas falharam (429/timeout/detalhe); rode de novo';
    } else {
      veredito = 'as 12 consultas e detalhes responderam e nenhuma revelou a chave — ou ela não está no Bling, ou o filtro combinado não funciona';
    }
    json(res, 200, {
      ok: true, versao: VERSAO, empresa, chave,
      veredito,
      situacao_real_da_nota: situacaoReal != null ? situacaoReal : undefined,
      consultas_falhas: falharam || undefined,
      resultados,
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
    varrerLote, classificarEntradaZip, lerTpNF, blingTemChave, dataValida,
    _trocarBlingTokensParaTeste(m) { _blingTokensRef.map = m; },
    _trocarManagersMLParaTeste(m) { _mlManagersRef.map = m; },
    _limparCacheConfirmadasParaTeste() { _confirmadasNoBling.clear(); }, comPrazo,
    _trocarFetchParaTeste(f) { _fetchRef.fn = f; },
  },
};
