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

  function writeJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
  catch (e) { console.error(`[${tag}] write`, file, e.message); }
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
  const lerIndiceEan = () => readJson(EAN_INDEX_FILE, {});

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
  for (let t = 0; t < tentativas; t++) {
    if (signal && signal.aborted) return { ok: false, status: 0, data: null, erro: 'abortado' };
    let r;
    try {
      const _op = { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
      if (signal) _op.signal = signal;
      r = await fetch(BLING_BASE + pathUrl, _op);
    } catch (e) {
      if (signal && signal.aborted) return { ok: false, status: 0, data: null, erro: 'abortado' };
      await sleep(800); continue;
    }
    if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
    const txt = await r.text();
    let data = null; try { data = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  }
  return { ok: false, status: 429, data: null };
  }

  async function blingWrite(method, pathUrl, body) {
  let token;
  try { token = await garantirToken(); }
  catch (e) { return { ok: false, status: 401, data: null, erro: 'token: ' + e.message }; }
  for (let t = 0; t < 3; t++) {
    const opts = { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } };
    if (body !== undefined && body !== null) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let r;
    try { r = await fetch(BLING_BASE + pathUrl, opts); }
    catch (e) { await sleep(800); continue; }
    if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
    const txt = await r.text();
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
