'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   SESSÃO DA SHOPEE (cookie do painel) — fatia 3 da desduplicação (11/09).

   Eram ~88 linhas iguais nas duas empresas. O que elas resolvem: o cookie do
   painel da Shopee VENCE, e a sessão precisa sobreviver a deploy — por isso o
   valor do disco tem prioridade sobre a env, a não ser que o dono cole uma
   semente NOVA (detectada por hash da própria env).

   O nome da env muda por empresa (AMBBKP_SHOPEE_COOKIE, GBO_SHOPEE_COOKIE...),
   então ELE é o parâmetro — o resto é igual. É a peça mais "multi-empresa por
   natureza" das três fatias até agora: prova de que dava pra ser código único
   desde o começo.
   ──────────────────────────────────────────────────────────────────────────── */

const path = require('path');

function criar(deps) {
  /* ensureDir entrou na 2ª volta: o lint acusou assim que a fatia saiu do arquivo. */
  const { CACHE_DIR, readJson, writeJson, ensureDir, SHOPEE_ENV_COOKIE } = deps;
  for (const [nome, v] of Object.entries({ CACHE_DIR, readJson, writeJson, ensureDir, SHOPEE_ENV_COOKIE })) {
    if (v == null) throw new Error('lib/checkout/shopee-sessao: falta a dependência ' + nome);
  }

  const SHOPEE_SESSAO_FILE = path.join(CACHE_DIR, '_shopee-sessao.json');

  function _shopeeHash(s) {
    try { return require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 12); }
    catch (e) { return 'len' + String(s).length; }
  }

  function shopeeSessaoLer() {
    const env  = String(process.env[SHOPEE_ENV_COOKIE] || '').trim();
    const j    = readJson(SHOPEE_SESSAO_FILE, null) || {};
    const envH = env ? _shopeeHash(env) : '';
    if (env && j.semente !== envH) {          // semente nova na env → ela manda
      const novo = { cookie: env, semente: envH, origem: 'env', atualizado: new Date().toISOString(), renovacoes: 0 };
      try { ensureDir(CACHE_DIR); writeJson(SHOPEE_SESSAO_FILE, novo); } catch (e) {}
      return novo;
    }
    if (j.cookie) return j;
    if (env) return { cookie: env, semente: envH, origem: 'env', atualizado: null, renovacoes: 0 };
    return { cookie: '', origem: 'nenhum', renovacoes: 0 };
  }

  // Pega o set-cookie da resposta e funde no jar. Devolve null se nada mudou.
  function shopeeSessaoAtualiza(resp) {
    let lista = [];
    try { if (resp && resp.headers && typeof resp.headers.getSetCookie === 'function') lista = resp.headers.getSetCookie() || []; } catch (e) {}
    if (!lista.length) { try { const s = resp && resp.headers && resp.headers.get('set-cookie'); if (s) lista = [s]; } catch (e) {} }
    if (!lista.length) return null;

    const atual = shopeeSessaoLer();
    if (!atual.cookie) return null;

    const mapa = new Map();
    String(atual.cookie).split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) mapa.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); });

    let mudou = 0;
    lista.forEach(sc => {
      const par = String(sc).split(';')[0];
      const i = par.indexOf('=');
      if (i <= 0) return;
      const nome = par.slice(0, i).trim();
      const val  = par.slice(i + 1).trim();
      if (!nome) return;
      if (!val || val === 'deleted') { if (mapa.delete(nome)) mudou++; return; }
      if (mapa.get(nome) !== val) { mapa.set(nome, val); mudou++; }
    });
    if (!mudou) return null;

    const cookie = Array.from(mapa.entries()).map(([k, v]) => k + '=' + v).join('; ');
    const novo = { cookie, semente: atual.semente || '', origem: 'renovado', atualizado: new Date().toISOString(), renovacoes: (atual.renovacoes || 0) + 1 };
    try { ensureDir(CACHE_DIR); writeJson(SHOPEE_SESSAO_FILE, novo); } catch (e) {}
    return { mudou, renovacoes: novo.renovacoes };
  }

  const SHOPEE_CAB = {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://seller.shopee.com.br/portal/sale/order',
    'X-Api-Src-List': 'pc',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0'
  };

  function shopeeUrlBusca(cookie, termo) {
    const cds = (String(cookie).match(/(?:^|;\s*)SPC_CDS=([^;]+)/) || [])[1] || '';
    return 'https://seller.shopee.com.br/api/v3/order/get_order_list_search_bar_hint'
         + '?SPC_CDS=' + encodeURIComponent(cds)
         + '&SPC_CDS_VER=2&keyword=' + encodeURIComponent(termo)
         + '&category=1&order_list_tab=100&entity_type=1';
  }

  // Chamada barata só pra Shopee renovar os cookies. Roda no cron 2x ao dia.

  // 20/08 (pedido do Diego: "quando vc fizer coisas pra acompanhar status, coloca o URL Completo.
  // assim eu vejo na tela e já acompanho. do jeito q tá, não consigo saber o caminho"): quem dispara
  // uma rotina longa recebe a mensagem "?status=1 p/ acompanhar" — e não tem como montar o caminho a
  // partir dela. A resposta passa a trazer a URL inteira, pronta pra clicar.
  function _urlStatus(req, caminho, extra, chave) {
    try {
      const host = (req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || '';
      const proto = (req && req.headers && req.headers['x-forwarded-proto']) || 'https';
      const base = host ? (proto + '://' + host) : '';
      // Codex (P2): quem dispara com ?k=<chave> e sem sessão recebia um link com o texto
      // "SUA_ADMIN_KEY" — que não abre. O link tem que funcionar pra quem o recebeu: se veio com
      // chave, ela volta; se foi por sessão (o cookie acompanha o clique), fica sem chave nenhuma.
      const k = chave ? ('&k=' + encodeURIComponent(chave)) : '';
      return base + caminho + '?status=1' + (extra || '') + k;
    } catch (e) { return caminho + '?status=1'; }
  }

  /* _urlStatus e _shopeeHash são usados FORA desta fatia (o lint mostrou: 4 pontos do
     checkout chamam _urlStatus, 3 chamam _shopeeHash) — por isso saem exportados, em vez
     de eu deixar o arquivo com referência órfã. */
  return { shopeeSessaoLer, shopeeSessaoAtualiza, shopeeUrlBusca, SHOPEE_CAB, SHOPEE_SESSAO_FILE, _shopeeHash, _urlStatus };
}

module.exports = { criar };
