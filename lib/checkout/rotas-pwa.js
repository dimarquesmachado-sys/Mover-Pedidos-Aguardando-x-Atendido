'use strict';
/* 15/11 — ÍCONE E MANIFESTO DO APP (PWA), peça única (docs/NORTE-2026-11.md, item C: as rotas-cópia).

   Pra aba do navegador, o favorito (Ctrl+D) e principalmente o atalho na tela de início do celular. Servidos pelo
   servidor (não embutidos) porque o Android só aceita ícone de URL real no "adicionar à tela de início". Eram duas cópias
   (Girassol e AMB) com uma diferença que não era de propósito: a AMB versionava a URL do ícone no manifesto
   (`icone.png?v=<VERSAO>`, Codex PR#9: o ícone sai com cache de 30 dias — quando MUDA, navegador e PWA seguravam o
   antigo até um mês) e a Girassol não. Agora as duas versionam. A GOOD não tem ícone PNG (o painel dela anuncia
   `manifesto: false`) — quando tiver, é só montar esta peça.

   `criar({ prefixo, nome, shortName, descricao, iconeB64, VERSAO })` → `rota(req, res, p, method)`: true quando respondeu. */
function criar(cfg) {
  const c = cfg || {};
  for (const n of ['prefixo', 'nome', 'shortName', 'descricao', 'iconeB64', 'VERSAO']) {
    if (!c[n]) throw new Error('lib/checkout/rotas-pwa: falta ' + n);
  }
  const png = Buffer.from(String(c.iconeB64), 'base64');
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('lib/checkout/rotas-pwa (' + c.prefixo + '): o ícone não é um PNG');
  const ROTA_ICONE = c.prefixo + '/icone.png', ROTA_MAN = c.prefixo + '/manifest.webmanifest';
  const src = 'icone.png?v=' + encodeURIComponent(c.VERSAO);
  const manifesto = JSON.stringify({
    name: c.nome, short_name: c.shortName, description: c.descricao,
    start_url: c.prefixo + '/dashboard', scope: c.prefixo + '/',
    display: 'standalone', orientation: 'portrait-primary', background_color: '#0a0e1a', theme_color: '#0a0e1a',
    icons: [{ src, sizes: '128x128', type: 'image/png', purpose: 'any' }, { src, sizes: '128x128', type: 'image/png', purpose: 'maskable' }],
  });
  function rota(req, res, p, method) {
    const m = method || (req && req.method);
    if (m !== 'GET') return false;
    if (p === ROTA_ICONE) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=2592000' });
      res.end(png); return true;
    }
    if (p === ROTA_MAN) {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      res.end(manifesto); return true;
    }
    return false;
  }
  return rota;
}

module.exports = { criar };
