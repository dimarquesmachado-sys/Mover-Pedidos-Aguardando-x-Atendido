'use strict';
/* 16/11 — AS DUAS ROTAS DA SESSÃO DA SHOPEE, NUMA PEÇA (docs/NORTE-2026-11.md, item C — `montarCheckout`, passo 2).

   Eram as últimas rotas PRÓPRIAS da AMB (amb-checkout-offline/index.js, ~110 linhas); a Girassol e a GOOD não as tinham —
   e as três usam a MESMA sessão da Shopee (lib/checkout/shopee-sessao: cookie semeado no disco, renovado pelo set-cookie
   de cada chamada). Nivelar por cima: a peça é das três.
     · POST <prefixo>/shopee-semear  (só ADMIN_KEY) — cola o cookie (ou o cURL inteiro) da sessão do Seller Center no jar
       da empresa; exige SPC_ST (o da chamada de return que funciona, HttpOnly);
     · GET  <prefixo>/shopee-devolucao?rid=|rsn=[&diag=1] (chave OU sessão de admin) — pergunta ao Seller Center se a
       devolução foi entregue (histórico da logística reversa), com cache em _shopee-devolucoes.json; `rsn` resolve pro
       `rid` pelo detalhe da devolução.
   O código é o da AMB, movido (mover não é reescrever): só o prefixo virou configuração. As duas rotas são PÚBLICAS no
   portão de sessão da empresa (`config-empresa.portao.publicasExtras`) porque fazem a própria checagem de credencial —
   a de semear nem aceita sessão (só a chave).

   criar({ PREFIXO, VERSAO, CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin, readBody, readJson, writeJson, ensureDir,
           fetch, sessao: { shopeeSessaoLer, shopeeSessaoAtualiza, SHOPEE_SESSAO_FILE, _shopeeHash }, SHOPEE_ENV_COOKIE })
     → (req, res, urlObj, method, p) → boolean   (um passo da fila lib/checkout/rotas-empresa) */
const path = require('path');

const PECAS = ['PREFIXO', 'VERSAO', 'CACHE_DIR', 'json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin', 'readBody', 'readJson', 'writeJson', 'ensureDir', 'fetch', 'sessao', 'SHOPEE_ENV_COOKIE'];

function criar(o) {
  const falta = PECAS.filter((k) => !o || o[k] == null || o[k] === '');
  if (falta.length) throw new Error('lib/checkout/rotas-shopee-sessao: falta ' + falta.join(', '));
  for (const k of ['shopeeSessaoLer', 'shopeeSessaoAtualiza', '_shopeeHash']) if (typeof o.sessao[k] !== 'function') throw new Error('lib/checkout/rotas-shopee-sessao: sessao.' + k + ' tem que ser função');
  if (!o.sessao.SHOPEE_SESSAO_FILE) throw new Error('lib/checkout/rotas-shopee-sessao: falta sessao.SHOPEE_SESSAO_FILE');
  const { PREFIXO, VERSAO, CACHE_DIR, json, lerChaveAdmin, validarSessao, ehAdmin, readBody, readJson, writeJson, ensureDir, fetch, SHOPEE_ENV_COOKIE } = o;
  const { shopeeSessaoLer, shopeeSessaoAtualiza, SHOPEE_SESSAO_FILE, _shopeeHash } = o.sessao;

async function _rotaShopeeSemear(req, res, urlObj, method, p) {
  if (!(method === 'POST' && p === PREFIXO + '/shopee-semear')) return false;
  const kSe = lerChaveAdmin(req, urlObj);
  if (!process.env.ADMIN_KEY || kSe !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
  let bodySe = {}; try { const _rb = await readBody(req); bodySe = (_rb && typeof _rb === 'object') ? _rb : JSON.parse(_rb || '{}'); } catch (e) {}
  let bruto = String(bodySe.cookie || bodySe.curl || '').trim();
  if (!bruto) { json(res, 400, { ok: false, erro: 'faltou {cookie:"..."} ou {curl:"..."} no corpo' }); return true; }
  // aceita o cURL inteiro: pega o valor de -H 'Cookie: ...' (aspa simples ou dupla)
  let ck = bruto;
  const mCk = bruto.match(/-H\s+['"]cookie:\s*([^'"]+)['"]/i);
  if (mCk) ck = mCk[1];
  ck = ck.replace(/^cookie:\s*/i, '').trim();
  const nomes = [...new Set((ck.match(/(?:^|;\s*)([A-Za-z0-9_]+)=/g) || []).map(x => x.replace(/[;=\s]/g, '')))];
  const temST = /(?:^|;\s*)SPC_ST=/.test(ck);
  if (!temST) { json(res, 400, { ok: false, erro: 'o cookie colado NAO tem SPC_ST — cole o da chamada de return que funciona (com HttpOnly)', nomes }); return true; }
  const novo = { cookie: ck, semente: _shopeeHash(ck), origem: 'semeado', atualizado: new Date().toISOString(), renovacoes: 0 };
  try { ensureDir(CACHE_DIR); writeJson(SHOPEE_SESSAO_FILE, novo); } catch (e) { json(res, 500, { ok: false, erro: 'falhou ao gravar o jar: ' + String(e && e.message || e) }); return true; }
  json(res, 200, { ok: true, gravado: true, tam_cookie: ck.length, tem_SPC_ST: true, cookies: nomes.length, nomes, versao: VERSAO });
  return true;
}
async function _rotaShopeeDevolucao(req, res, urlObj, method, p) {
  if (!(method === 'GET' && p === PREFIXO + '/shopee-devolucao')) return false;
  const kSd = lerChaveAdmin(req, urlObj);
  const opSd = validarSessao(req.headers['cookie']);
  const podeSd = (process.env.ADMIN_KEY && kSd === process.env.ADMIN_KEY) || (opSd && ehAdmin(opSd));
  if (!podeSd) { json(res, 404, { error: 'not found' }); return true; }

  const ridQ = String((urlObj.searchParams && urlObj.searchParams.get('rid')) || '').trim();
  const rsnQ = String((urlObj.searchParams && urlObj.searchParams.get('rsn')) || '').trim().toUpperCase();
  const diagSd = ((urlObj.searchParams && urlObj.searchParams.get('diag')) || '') === '1';
  if (!ridQ && !rsnQ) { json(res, 400, { ok: false, erro: 'faltou ?rid= (id interno da URL do portal) ou ?rsn= (numero da solicitacao)' }); return true; }

  const ARQ_DEV = path.join(CACHE_DIR, '_shopee-devolucoes.json');
  const mapaSd = readJson(ARQ_DEV, {}) || {};
  const passosSd = [];
  let rid = ridQ || (rsnQ ? (mapaSd['rsn:' + rsnQ] || null) : null);
  if (!ridQ && rid) passosSd.push({ passo: 'cache-rsn', rid });

  const jaSd = rid && mapaSd[rid];
  if (jaSd && jaSd.entregue && !diagSd) { json(res, 200, { ok: true, origem: 'cache', rid, rsn: rsnQ || null, entregue: true, entregue_em: jaSd.entregue_em || null, versao: VERSAO }); return true; }

  try {
    const sessSd = shopeeSessaoLer();
    const ckSd = sessSd.cookie;
    if (!ckSd) {
      passosSd.push({ passo: 'cookie', erro: 'sem cookie: env ' + SHOPEE_ENV_COOKIE + ' vazia e nada gravado no disco' });
    } else {
      const cdsSd = (ckSd.match(/(?:^|;\s*)SPC_CDS=([^;]+)/) || [])[1] || '';
      // b21 - os endpoints de DEVOLUCAO exigem o token anti-CSRF
      // (errcode 2 "token not found" com cookie vivo): o valor do
      // cookie csrftoken repetido no cabecalho X-CSRFToken. Os de
      // pedido (ir-shopee) nunca cobraram; os de return cobram.
      const csrfSd = (ckSd.match(/(?:^|;\s*)csrftoken=([^;]+)/i) || [])[1] || '';
      passosSd.push({ passo: 'preparo', tem_cds: !!cdsSd, tem_csrf: !!csrfSd, tam_cookie: ckSd.length, origem_cookie: sessSd.origem || null });
      const cabSd = {
        'Cookie': ckSd,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://seller.shopee.com.br/portal/sale/return',
        'X-Api-Src-List': 'pc',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0'
      };
      if (csrfSd) cabSd['X-CSRFToken'] = csrfSd;

      if (!rid && rsnQ) {
        const urlDet = 'https://seller.shopee.com.br/api/v3/return/detail'
          + '?SPC_CDS=' + encodeURIComponent(cdsSd) + '&SPC_CDS_VER=2'
          + '&return_sn=' + encodeURIComponent(rsnQ) + '&language=pt-br';
        const rDet = await fetch(urlDet, { headers: cabSd });
        const tDet = await rDet.text();
        shopeeSessaoAtualiza(rDet);
        let jDet = null; try { jDet = JSON.parse(tDet); } catch (e) {}
        let achouSd = null;
        (function varre(o, prof) {
          if (!o || typeof o !== 'object' || prof > 6 || achouSd) return;
          if (o.return_id != null) { achouSd = String(o.return_id); return; }
          if (o.returnid != null) { achouSd = String(o.returnid); return; }
          Object.keys(o).forEach(k2 => { if (o[k2] && typeof o[k2] === 'object') varre(o[k2], prof + 1); });
        })(jDet, 0);
        passosSd.push({ passo: 'resolver-rsn', status: rDet.status, rid_achado: achouSd, corpo: achouSd ? undefined : tDet.slice(0, 500) });
        if (achouSd) { rid = achouSd; mapaSd['rsn:' + rsnQ] = rid; try { ensureDir(CACHE_DIR); writeJson(ARQ_DEV, mapaSd); } catch (e) {} }
      }

      if (rid) {
        const urlHist = 'https://seller.shopee.com.br/api/v1/return/reverse_logistics_tracking_history/'
          + '?SPC_CDS=' + encodeURIComponent(cdsSd) + '&SPC_CDS_VER=2'
          + '&log_id=1&return_id=' + encodeURIComponent(rid);
        const rH = await fetch(urlHist, { headers: cabSd });
        const tH = await rH.text();
        shopeeSessaoAtualiza(rH);
        let jH = null; try { jH = JSON.parse(tH); } catch (e) {}

        const eventosSd = [];
        (function varre(o, prof) {
          if (!o || prof > 7) return;
          if (Array.isArray(o)) { o.forEach(x => varre(x, prof + 1)); return; }
          if (typeof o !== 'object') return;
          const t2 = o.ctime || o.time || o.timestamp || o.update_time || o.create_time || null;
          const d2 = o.description || o.desc || o.message || o.text || o.status_text || null;
          if (t2 && d2) eventosSd.push({ t: Number(t2), texto: String(d2) });
          Object.keys(o).forEach(k2 => varre(o[k2], prof + 1));
        })(jH, 0);
        eventosSd.sort((a, b) => b.t - a.t);
        const isoSd = t2 => { const n2 = Number(t2); const ms = n2 > 1e12 ? n2 : (n2 > 1e9 ? n2 * 1000 : NaN); const dt = new Date(ms); return isNaN(dt) ? null : dt.toISOString(); };
        const evSd = eventosSd.find(e => /devolvid|entregue|entregad|delivered|delivery.?done/i.test(e.texto)) || null;

        const outSd = { ok: rH.status === 200, http_historico: rH.status, rid, rsn: rsnQ || null,
          entregue: !!evSd, entregue_em: evSd ? isoSd(evSd.t) : null,
          ultimo_evento: eventosSd[0] ? { quando: isoSd(eventosSd[0].t), texto: eventosSd[0].texto.slice(0, 120) } : null,
          eventos: eventosSd.slice(0, 5).map(e => ({ quando: isoSd(e.t), texto: e.texto.slice(0, 120) })),
          origem_cookie: sessSd.origem || null, versao: VERSAO };
        passosSd.push({ passo: 'historico', status: rH.status, eventos: eventosSd.length, corpo: eventosSd.length ? undefined : tH.slice(0, 500) });
        if (outSd.entregue) { mapaSd[rid] = { entregue: true, entregue_em: outSd.entregue_em, ts: Date.now() }; try { ensureDir(CACHE_DIR); writeJson(ARQ_DEV, mapaSd); } catch (e) {} }
        if (diagSd) outSd.passos = passosSd;
        json(res, 200, outSd);
        return true;
      }
    }
  } catch (e) {
    passosSd.push({ passo: 'excecao', erro: String((e && e.message) || e).slice(0, 250) });
  }
  json(res, 200, { ok: false, rid: rid || null, rsn: rsnQ || null, erro: 'nao consegui ler a devolucao — veja os passos', passos: passosSd, versao: VERSAO });
  return true;
}

  return async function rotasShopeeSessao(req, res, urlObj, method, p) {
    if (await _rotaShopeeSemear(req, res, urlObj, method, p)) return true;
    if (await _rotaShopeeDevolucao(req, res, urlObj, method, p)) return true;
    return false;
  };
}

module.exports = { criar, PECAS, ROTAS: ['/shopee-semear', '/shopee-devolucao'] };
