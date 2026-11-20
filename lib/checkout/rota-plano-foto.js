'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   A FOTO DE UM PRODUTO DO PLANO DE COMPRA, servida pelo próprio servidor (20/11/2026).
   GET <prefixo>/plano-compra/foto?sku=<SKU>

   Pra quê: a planilha do Plano de Compra passou a levar a foto do produto em cada linha (pedido do dono). Quem monta a
   planilha é o navegador, e ele não consegue ler os bytes de uma imagem hospedada em outro site (o navegador barra). Esta
   rota busca a foto e devolve do mesmo endereço do painel.

   NÃO é um "buscador de qualquer endereço": quem chama informa só o SKU. O endereço da foto é o que o PRÓPRIO servidor
   guardou ao calcular o plano (o cache de produtos do plano — veio do cadastro do Bling). Mesmo assim, antes de buscar:
     · só https, sem usuário/senha no endereço, sem porta fora da 443;
     · nome de máquina de verdade — nada de IP, "localhost" ou nome interno (sem ponto, .local, .internal);
     · redirecionamento é seguido à mão (até 3), cada salto pelas MESMAS regras;
     · só resposta que se diz imagem, com teto de tamanho e de tempo.
   Trava: chave OU sessão de admin (o Plano de Compra é do admin); sem as duas, 404.
   "Não achei" e "não consegui buscar" têm resposta própria — a planilha sai sem aquela foto, e não quebra.
   ───────────────────────────────────────────────────────────────────────────── */

const TETO_BYTES = 8 * 1024 * 1024;
const PRAZO_MS = 12000;
const MAX_SALTOS = 3;

function caminhoDe(prefixo) { return prefixo + '/plano-compra/foto'; }
function atende(prefixo, method, p) { return method === 'GET' && p === caminhoDe(prefixo); }

/* o endereço pode ser buscado? devolve a URL (objeto) ou null */
function enderecoPermitido(bruto) {
  let u;
  try { u = new URL(String(bruto || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (u.port && u.port !== '443') return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || h.indexOf('.') < 0) return null;                       /* sem ponto: nome interno ("localhost", "bling") */
  /* IP v4 ou v6 — o leitor de endereços já entrega o IP "disfarçado" (0x7f000001, 2130706433) na forma comum (127.0.0.1) */
  if (/^[0-9.]+$/.test(h) || h.indexOf(':') >= 0 || /^\[/.test(u.hostname)) return null;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(h)) return null;
  return u;
}

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rota-plano-foto: falta empresa');
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin', 'lerCacheDeProdutos']) {
    if (typeof o[k] !== 'function') throw new Error('lib/checkout/rota-plano-foto (' + o.empresa + '): falta ' + k);
  }
  const prefixo = o.prefixo != null ? o.prefixo : require('./config-empresa').prefixoDe(o.empresa);
  const { json, lerChaveAdmin, validarSessao, ehAdmin, lerCacheDeProdutos } = o;
  const buscar = o.fetch || require('node-fetch');
  const teto = Number(o.tetoBytes) > 0 ? Number(o.tetoBytes) : TETO_BYTES;
  const prazo = Number(o.prazoMs) > 0 ? Number(o.prazoMs) : PRAZO_MS;

  /* Codex #959: resposta que NÃO vai ser lida até o fim (redirecionamento, erro, não-imagem, grande demais) tem o corpo
     fechado na hora — senão a conexão com o site da foto fica aberta depois da resposta (e o prazo, já desarmado, não a
     fecha mais). E, na saída, o que ainda estiver pendente é abortado. */
  function largar(r) { try { if (r && r.body && typeof r.body.destroy === 'function') r.body.destroy(); } catch (e) {} }

  /* busca os bytes da foto: { ok, tipo, bytes } ou { ok:false, motivo } */
  async function buscarFoto(inicio) {
    let u = inicio;
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), prazo);
    try {
      for (let salto = 0; salto <= MAX_SALTOS; salto++) {
        const r = await buscar(u.href, { redirect: 'manual', signal: ac.signal, headers: { Accept: 'image/*' }, size: teto });
        if (r.status >= 300 && r.status < 400) {
          const para = r.headers && r.headers.get && r.headers.get('location');
          let prox = null; try { prox = para ? enderecoPermitido(new URL(para, u.href).href) : null; } catch (e) { prox = null; }
          largar(r);
          if (!prox) return { ok: false, motivo: 'redirecionamento pra endereço que não pode ser buscado' };
          u = prox; continue;
        }
        if (r.status !== 200) { largar(r); return { ok: false, motivo: 'a foto respondeu ' + r.status }; }
        const tipo = String((r.headers && r.headers.get && r.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
        if (!/^image\/(jpeg|jpg|png|webp|gif|bmp|avif)$/.test(tipo)) { largar(r); return { ok: false, motivo: 'a resposta não é imagem' }; }
        const dito = Number(r.headers && r.headers.get && r.headers.get('content-length'));
        if (isFinite(dito) && dito > teto) { largar(r); return { ok: false, motivo: 'foto grande demais' }; }
        const bytes = Buffer.from(await r.arrayBuffer());
        if (!bytes.length) return { ok: false, motivo: 'foto vazia' };
        if (bytes.length > teto) return { ok: false, motivo: 'foto grande demais' };
        return { ok: true, tipo, bytes };
      }
      return { ok: false, motivo: 'redirecionamentos demais' };
    } catch (e) {
      return { ok: false, motivo: ac.signal.aborted ? 'a foto demorou demais' : 'não consegui buscar a foto' };
    } finally { clearTimeout(tm); try { ac.abort(); } catch (e) {} }   /* terminou (bem ou mal): nada fica pendurado */
  }

  return async function rotaPlanoFoto(req, res, urlObj, method, p) {
    if (!atende(prefixo, method, p)) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const sku = String((urlObj.searchParams && urlObj.searchParams.get('sku')) || '').trim();
    if (!sku || sku.length > 120) { json(res, 400, { ok: false, erro: 'use ?sku=<SKU do produto>' }); return true; }
    let cache = null;
    try { cache = lerCacheDeProdutos(); } catch (e) { cache = null; }
    const item = cache && typeof cache === 'object' && Object.prototype.hasOwnProperty.call(cache, sku) ? cache[sku] : null;
    const u = item && item.img ? enderecoPermitido(item.img) : null;
    if (!item || !item.img) { json(res, 404, { ok: false, erro: 'sem foto guardada pra esse SKU — calcule o plano de compra primeiro' }); return true; }
    if (!u) { json(res, 422, { ok: false, erro: 'o endereço da foto desse produto não pode ser buscado' }); return true; }
    const f = await buscarFoto(u);
    if (!f.ok) { json(res, 502, { ok: false, erro: f.motivo }); return true; }
    res.writeHead(200, { 'Content-Type': f.tipo, 'Content-Length': f.bytes.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    res.end(f.bytes);
    return true;
  };
}

module.exports = { criar, atende, caminhoDe, enderecoPermitido, TETO_BYTES };
