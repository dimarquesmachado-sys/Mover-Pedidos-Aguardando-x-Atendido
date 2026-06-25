'use strict';
// nf.js — notas fiscais: buscar a NF do pedido, baixar DANFE/XML e montar os dados do DANFE simplificado.

const { fs, path, fetch, garantirToken, QZ_CERT, QZ_PRIVKEY, VERSAO, BLING_BASE,
  CACHE_DIR, SIT_ATENDIDO, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS, KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE,
  EAN_INDEX_FILE, ARQUIVO_DIR, ARQUIVO_DIAS, SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html, manifest, salvarManifest, skuEanCache, locCache, salvarLoc,
  salvarSkuEan, lerIndiceEan, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao } = require('./base');

const EMITENTE_FALLBACK = { razao: 'Magazine Girassol Ltda', cnpj: '27548456000147', ie: '675.374.241.113', endereco: 'Rua Jose Ruscitto, 150, BOX 1 - Galpao, Taboao da Serra - SP' };

function parseNF(nf) {
  if (!nf) return null;
  return {
    id: nf.id || null,
    numero: nf.numero || null,
    chave: nf.chaveAcesso || nf.chave || null,
    situacao: (nf.situacao && (nf.situacao.id || nf.situacao)) || null
  };
}

async function acharNFporRange(pedidoId) {
  const pid = Number(pedidoId);
  if (!pid) return null;
  const teto = pid + 2000;
  let melhor = null;
  for (let pagina = 1; pagina <= 12; pagina++) {
    const { ok, data } = await blingGet(`/nfe?limite=100&pagina=${pagina}`);
    const lista = (data && data.data) || [];
    if (!ok || lista.length === 0) break;
    let menorIdPagina = Infinity;
    for (const nf of lista) {
      const nid = Number(nf.id) || 0;
      if (nid && nid < menorIdPagina) menorIdPagina = nid;
      if (nid >= pid && nid <= teto && (!melhor || nid < Number(melhor.id))) melhor = nf;
    }
    if (menorIdPagina < pid) break; // já passou abaixo do pedido → não acha mais
    await sleep(PAUSA_MS);
  }
  return parseNF(melhor);
}

async function nfDoPedido(id) {
  // 1) tenta o endpoint direto (barato)
  const r = await blingGet(`/pedidos/vendas/${id}/nfe`);
  if (r.ok) {
    let nf = r.data && r.data.data;
    if (Array.isArray(nf)) nf = nf[0];
    if (nf) return parseNF(nf);
  }
  // 2) fallback: range de ID no /nfe
  return await acharNFporRange(id);
}

async function carregarNFs(idMinimo) {
  const nfs = [];
  for (let pagina = 1; pagina <= 40; pagina++) {
    const { ok, data } = await blingGet(`/nfe?limite=100&pagina=${pagina}`);
    const lista = (data && data.data) || [];
    if (!ok || lista.length === 0) break;
    let menor = Infinity;
    for (const nf of lista) {
      const nid = Number(nf.id) || 0;
      nfs.push(nf);
      if (nid && nid < menor) menor = nid;
    }
    if (menor < idMinimo) break; // já cobriu o lote
    await sleep(PAUSA_MS);
  }
  return nfs;
}

function acharNFnaLista(pedidoId, nfs) {
  const pid = Number(pedidoId);
  if (!pid) return null;
  const teto = pid + 2000;
  let melhor = null;
  for (const nf of nfs) {
    const nid = Number(nf.id) || 0;
    if (nid >= pid && nid <= teto && (!melhor || nid < Number(melhor.id))) melhor = nf;
  }
  return parseNF(melhor);
}

async function baixarDanfe(nfId) {
  if (!nfId) return null;
  try {
    const det = await blingGet(`/nfe/${nfId}`);
    const nf = det.data && det.data.data;
    const link = nf && nf.linkPDF;
    if (!link) return null;
    const resp = await fetch(link, { redirect: 'follow' });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.slice(0, 4).toString('latin1') !== '%PDF') return null; // não veio PDF (bloqueio?)
    return buf;
  } catch (e) { return null; }
}

function _xmlTag(xml, tag) { const m = xml && xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\\/' + tag + '>')); return m ? m[1].trim() : ''; }

function _xmlBloco(xml, tag) { const m = xml && xml.match(new RegExp('<' + tag + '[\\s>][\\s\\S]*?<\\/' + tag + '>')); return m ? m[0] : ''; }

function _ender(bloco) {
  const lgr = _xmlTag(bloco, 'xLgr'), nro = _xmlTag(bloco, 'nro'), cpl = _xmlTag(bloco, 'xCpl');
  const bai = _xmlTag(bloco, 'xBairro'), mun = _xmlTag(bloco, 'xMun'), uf = _xmlTag(bloco, 'UF'), cep = _xmlTag(bloco, 'CEP');
  return [lgr, nro, cpl, bai, (mun ? mun + (uf ? ' - ' + uf : '') : uf), (cep ? 'CEP ' + cep : '')].filter(Boolean).join(', ');
}

function parseXmlNF(xml) {
  if (!xml) return {};
  const emit = _xmlBloco(xml, 'emit'), dest = _xmlBloco(xml, 'dest'), prot = _xmlBloco(xml, 'infProt');
  const cpl = _xmlTag(xml, 'infCpl');
  const trib = (cpl.match(/Val(?:or)?\s*[Aa]prox[\s\S]*?IBPT\.?/i) || cpl.match(/[Tt]ribut[\s\S]*?IBPT\.?/i) || [])[0] || '';
  return {
    emit: { razao: _xmlTag(emit, 'xNome'), cnpj: _xmlTag(emit, 'CNPJ') || _xmlTag(emit, 'CPF'), ie: _xmlTag(emit, 'IE'), endereco: _ender(_xmlBloco(emit, 'enderEmit')) },
    destEndereco: _ender(_xmlBloco(dest, 'enderDest')),
    protocolo: _xmlTag(prot, 'nProt'),
    dataProtocolo: _xmlTag(prot, 'dhRecbto'),
    tributos: trib.replace(/\s+/g, ' ').trim()
  };
}

async function baixarXmlNF(nf) {
  let url = nf && nf.xml;
  if (url && typeof url === 'object') url = url.link || url.url || url.href || '';
  if (!url) return '';
  try { const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) return ''; return await r.text(); }
  catch (e) { return ''; }
}

async function dadosNFSimp(nfId, numeroPedido) {
  const det = await blingGet(`/nfe/${nfId}`);
  const nf = det.data && det.data.data;
  if (!nf) return null;
  const xml = await baixarXmlNF(nf);
  const x = parseXmlNF(xml);
  const itens = (nf.itens || []).map(it => {
    const qtd = Number(it.quantidade || it.qtd || 1);
    const vUnit = Number(it.valor || it.valorUnitario || it.valorUnit || 0);
    const fm = (n) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return {
      codigo: it.codigo || (it.produto && it.produto.codigo) || '',
      descricao: it.descricao || (it.produto && it.produto.nome) || '',
      qtd, valorUnit: vUnit, valorTotal: vUnit * qtd,
      detalhe: fm(qtd) + ' UN X ' + fm(vUnit)
    };
  });
  const c = nf.contato || {};
  return {
    emitente: (x.emit && x.emit.razao) ? x.emit : EMITENTE_FALLBACK,
    chave: nf.chaveAcesso || nf.chave || '',
    protocolo: x.protocolo || '',
    dataProtocolo: x.dataProtocolo || '',
    tipo: (nf.tipo != null ? nf.tipo : 1),
    numero: nf.numero || '',
    serie: nf.serie || '1',
    dataEmissao: nf.dataEmissao || '',
    natureza: (nf.naturezaOperacao && typeof nf.naturezaOperacao === 'object')
      ? (nf.naturezaOperacao.descricao || nf.naturezaOperacao.nome || '')
      : (nf.naturezaOperacao || nf.natureza || ''),
    itens,
    qtdTotal: itens.length,
    consumidor: { doc: c.numeroDocumento || c.documento || '', nome: c.nome || '', endereco: x.destEndereco || '' },
    numeroPedido: numeroPedido || '',
    numeroPedidoLoja: nf.numeroPedidoLoja || '',
    tributos: x.tributos || ''
  };
}


module.exports = { parseNF, acharNFporRange, nfDoPedido, carregarNFs, acharNFnaLista, baixarDanfe, parseXmlNF, baixarXmlNF, dadosNFSimp };
