'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   FUNÇÕES BASE DO CHECKOUT — as três empresas (14/09/2026).

   Passo 2 da Fase 3. O `base.js` de cada pasta misturava duas naturezas opostas: a
   CONFIGURAÇÃO da empresa (envs, situações do Bling, janelas, pausas — o que a
   torna ela mesma) e as funções, que eram as mesmas nas três: 91 linhas com
   exatamente DUAS envs diferentes, as de operadores e admins.

   Aqui ficam só as funções — incluindo os caches em memória (manifesto, sku/ean,
   localização), que precisam vir junto porque as funções os leem e escrevem. A
   primeira tentativa desta extração levou as funções e DEIXOU os caches pra trás:
   o boot quebrou na hora, o que é o desfecho certo — cache órfão seria pior.
   ──────────────────────────────────────────────────────────────────────────── */

function criar(cfg) {
  /* a lista saiu do LINT de órfãos, não de palpite: cada nome aqui é um que a extração
     deixaria solto e que só apareceria em produção, na primeira chamada. */
  const OBRIGATORIOS = ['tag', 'envOperadores', 'envAdmin', 'BLING_BASE', 'garantirToken',
                        'PAUSA_MS', 'MANIFEST_FILE', 'SKU_EAN_FILE', 'LOC_FILE',
                        'EAN_INDEX_FILE', 'RESERVAS_FILE', 'RESERVA_TTL_MS', 'sleep'];
  for (const n of OBRIGATORIOS) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/base-funcoes: falta ' + n);
  }
  const fs = require('fs');
  const { tag, BLING_BASE, garantirToken, PAUSA_MS, MANIFEST_FILE, SKU_EAN_FILE, LOC_FILE,
          EAN_INDEX_FILE, RESERVAS_FILE, RESERVA_TTL_MS, sleep } = cfg;
  function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (e) {} }

  function readJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fb; } }

  /* Codex #509 (P1): devolve se a gravação deu certo. Até aqui ninguém olhava — cada
     chamador é "melhor esforço" (cache que reconstrói sozinho). A contagem de estoque é
     diferente: lá a gravação É o produto, e reportar sucesso sem ter gravado perde o
     lançamento em silêncio. Os chamadores antigos continuam ignorando o retorno — não
     muda nada pra eles. */
  function writeJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); return true; }
  catch (e) { console.error(`[${tag}] write`, file, e.message); return false; }
  }

  function dataISO(d) { return d.toISOString().slice(0, 10); }

  function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }

  function html(res, code, body) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }); res.end(body); }


  // acessores de cache em disco
  const manifest       = () => readJson(MANIFEST_FILE, {});
  const salvarManifest = (m) => writeJson(MANIFEST_FILE, m);
  const skuEanCache    = () => readJson(SKU_EAN_FILE, {});
  const locCache       = () => readJson(LOC_FILE, {});
  const salvarLoc      = (m) => writeJson(LOC_FILE, m);
  const salvarSkuEan   = (m) => writeJson(SKU_EAN_FILE, m);
  /* 23/09 (Codex #514, P1) — LIMPA O NCM QUE JÁ ESTÁ GRAVADO. Consertar o coletor impede NCM
     NOVO, mas o índice se realimenta de si mesmo: os três indexadores completos partem deste
     leitor e regravam o que leram, então os NCM antigos sobreviveriam a toda varredura futura.
     E eles são o problema de verdade: NCM tem 8 dígitos, mesmo formato de um EAN-8, então um
     bipe legítimo pode cair no produto errado.
     A regra é estreita de propósito — só descarta chave de 8 dígitos cujo valor guardado NÃO
     tem esse mesmo número como código de barras conhecido. EAN-8 de verdade continua. */
  const lerIndiceEan = () => {
    const idx = readJson(EAN_INDEX_FILE, {}) || {};
    let sujo = false;
    for (const chave of Object.keys(idx)) {
      if (!/^\d{8}$/.test(chave)) continue;          // 13 dígitos e chaves "sku:" ficam
      const it = idx[chave];
      const declarado = it && (it.ean || it.gtin || it.codigoBarras);
      if (String(declarado || '') === chave) continue;  // o produto diz que ESTE é o código dele
      delete idx[chave];
      sujo = true;
    }
    if (sujo) { try { writeJson(EAN_INDEX_FILE, idx); } catch (e) {} }
    return idx;
  };

  function lerReservas() {
  const r = readJson(RESERVAS_FILE, {});
  const agora = Date.now();
  let mudou = false;
  for (const id of Object.keys(r)) {
    const t = Date.parse(r[id] && r[id].em) || 0;
    if (!t || agora - t > RESERVA_TTL_MS) { delete r[id]; mudou = true; }
  }
  if (mudou) writeJson(RESERVAS_FILE, r);
  return r;
  }

  function lerOperadores() {
  const raw = process.env[cfg.envOperadores] || '';
  const map = {};
  raw.split(',').forEach(par => {
    const i = par.indexOf(':');
    if (i > 0) {
      const nome = par.slice(0, i).trim();
      const senha = par.slice(i + 1).trim();
      if (nome) map[nome] = senha;
    }
  });
  return map;
  }

  function lerAdmins() {
  return (process.env[cfg.envAdmin] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  }

  function ehAdmin(nome) {
  const a = lerAdmins();
  return a.length === 0 || a.includes(String(nome || '').trim().toLowerCase());
  }

  /* 22/08 (Codex #183): 3º parâmetro OPCIONAL `signal`, pra quem chama poder CANCELAR de verdade.
   Sem ele, o Promise.race do ciclo rejeitava só a espera — o fetch continuava vivo aqui dentro, e
   cada página que estourava o prazo deixava até 4 conexões penduradas, acumulando a cada ciclo. */
  async function blingGet(pathUrl, tentativas = 3, signal = undefined) {
  let token;
  try { token = await garantirToken(); }
  catch (e) { return { ok: false, status: 401, data: null, erro: 'token: ' + e.message }; }
  /* 23/09 (retomada do #324, que ficou 575 commits pra trás) — 429 REAL × REDE CAÍDA.
     Ao esgotar as tentativas, esta função devolvia `status: 429` tanto pro Bling limitando
     quanto pra rede caindo (DNS, socket). Como o backfill espera 2/4/8 minutos no 429, uma
     queda de rede passou a custar ~14 minutos por página sem ajudar em nada.
     O status continua 429 — quem já o lê não muda —, mas agora vêm `limite` e `rede` dizendo
     o que de fato aconteceu, e só o limite REAL merece a espera longa.
     `limite` NÃO exige que nada tenha falhado por rede: num lote 429 → rede → 429, o limite é
     real e estava sendo perdido (esse era o segundo apontamento do PR original). */
  let viu429 = false, viuRede = false;
  for (let t = 0; t < tentativas; t++) {
    if (signal && signal.aborted) return { ok: false, status: 0, data: null, erro: 'abortado' };
    let r;
    try {
      const _op = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
      if (signal) _op.signal = signal;
      r = await fetch(BLING_BASE + pathUrl, _op);
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, status: 0, data: null, erro: 'abortado' };
      viuRede = true;                                  // DNS, socket — não é o Bling limitando
      await sleep(800); continue;
    }
    if (r.status === 429) { viu429 = true; await sleep(1500 * (t + 1)); continue; }
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  }
  return { ok: false, status: 429, data: null, limite: viu429, rede: viuRede };
  }

  /* Codex #524 (P1): a re-tentativa em cima de EXCEÇÃO DE REDE (fetch que lançou) supõe que o
     pedido nunca chegou no Bling — verdade pro PATCH de situação e de localização (idempotentes:
     mandar de novo dá no mesmo resultado), mas falsa pra uma ESCRITA que CRIA algo (POST de
     estoque): se o Bling processou e a conexão caiu antes da resposta chegar, a re-tentativa
     manda o MESMO lançamento de novo e duplica. `opcoes.semRetryDeRede` deixa o chamador que
     não pode arriscar isso optar por não repetir — devolve um resultado AMBÍGUO (não confirmado,
     mas também não claramente recusado) em vez de tentar de novo às cegas. Os dois chamadores
     existentes (PATCH) não passam a opção, então continuam exatamente como antes. */
  async function blingWrite(method, pathUrl, body, opcoes) {
  const semRetryDeRede = !!(opcoes && opcoes.semRetryDeRede);
  let token;
  try { token = await garantirToken(); }
  catch (e) { return { ok: false, status: 401, data: null, erro: 'token: ' + e.message }; }
  /* 24/09 — o laço volta ao 3 fixo: a versão que ficou controla a repetição por
     `semRetryDeRede` (acima), não por um teto de tentativas. O `_tentativas` era da MINHA
     versão descartada e ficou órfão aqui — o eslint do check `orfaos` pegou, e em produção
     isso quebraria TODA escrita no Bling, não só a entrada de estoque. */
  for (let t = 0; t < 3; t++) {
    const opts = { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
    if (body !== undefined && body !== null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(BLING_BASE + pathUrl, opts); }
    catch (e) {
      if (semRetryDeRede) return { ok: false, status: 0, data: null, erro: 'rede: ' + e.message, ambiguo: true };
      await sleep(800); continue;
    }
    if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
    let txt;
    /* Codex #524 (P1): `fetch` já tinha resolvido aqui — o Bling aceitou o POST e mandou os
       cabeçalhos —, então uma queda de conexão durante `r.text()` escapava do catch de cima e
       saía deste laço sem o tratamento de "ambíguo". Pro chamador que não pode arriscar duplicar
       (a entrada de estoque), isso reabria exatamente o buraco que `semRetryDeRede` existe pra
       fechar: dois minutos depois, o lock local expira e o mesmo lançamento pode ser reenviado
       sem aviso. Mesma regra do catch do fetch: mesmo resultado. */
    try { txt = await r.text(); }
    catch (e) {
      if (semRetryDeRede) return { ok: false, status: 0, data: null, erro: 'rede: ' + e.message, ambiguo: true };
      await sleep(800); continue;
    }
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, data, raw: (txt || '').slice(0, 300) };
  }
  return { ok: false, status: 429, data: null };
  }

  async function moverSituacao(blingId, idSituacao) {
  return await blingWrite('PATCH', `/pedidos/vendas/${blingId}/situacoes/${idSituacao}`, null);
  }



  return { ensureDir, readJson, writeJson, dataISO, json, html, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao, manifest, salvarManifest, skuEanCache, locCache, salvarLoc, salvarSkuEan, lerIndiceEan };
}

module.exports = { criar };
