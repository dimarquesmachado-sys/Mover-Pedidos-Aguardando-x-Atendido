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
    situacao: (nf.situacao && (nf.situacao.id || nf.situacao)) || null,
    dataEmissao: nf.dataEmissao || null   // b10: hora OFICIAL da NF — antes era descartada aqui e o card 🕓 do painel nunca recebia o dado
    ,serie: (nf.serie != null ? String(nf.serie) : null)   // 24/08: série 1 = emissão nossa da matriz (ver filtro Full)
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

/* ═══ SÉRIE DA NF DO PEDIDO — só para o filtro Full (24/08) ═════════════════════════════
   Deliberadamente SEPARADA do nfDoPedido, por dois motivos que o Codex apontou no #193:

   1) nfDoPedido cai, no último passo, num palpite por FAIXA DE ID (acharNFporRange): pega
      qualquer NF cujo id esteja entre o id do pedido e id+2000. Serve pra achar DANFE, mas
      aqui decidiria se um pedido é Full ou não — e casar com a NF de OUTRO pedido, série 1,
      exporia um Full de verdade à fila do estoquista. Aqui só vale NF POSITIVAMENTE
      VINCULADA ao pedido.

   2) /pedidos/vendas/{id}/nfe às vezes devolve um RESUMO sem o campo `serie` (o mesmo
      endpoint já omite dataEmissao, e o repo já contorna isso buscando /nfe/{id}). Sem
      hidratar, a série viria null, o clone seria tratado como Full e movido — anulando a
      proteção em silêncio.

   Devolve { numero, serie } ou null. null = não sei, e quem chama mantém o conservador. */
async function serieDaNFdoPedido(id, signal) {   // signal opcional: sem prazo, um Bling mudo pendura o await pra sempre
  /* ⚠️ UMA REGRA SÓ PRA TODA A FUNÇÃO (reescrita em 25/08, 3ª rodada do Codex #199).
     Três vezes seguidas o mesmo defeito apareceu em pontos diferentes: uma chamada ao Bling
     falhava e o resultado era reportado como "sem NF". Eu vinha corrigindo o ponto apontado
     em vez de tratar a função inteira — então reescrevi com UMA regra que vale pra todas as
     chamadas: TODO acesso ao Bling passa por `pedir()`, e QUALQUER falha dele marca `falhou`.
     Não existe mais caminho onde uma consulta que não foi vira "não tem nota".

     Por que isso importa: "sem NF" faz o relógio de 6h do filtro Full correr; ao vencer, o
     pedido é MOVIDO. Se a nota existisse e fosse série 1 (clone de reposição em garantia),
     ela seria movida sem ninguém nunca ter lido a série — o estrago que a trava existe pra
     impedir.

     Devolve: { serie } · { semNF:true } (o Bling RESPONDEU e não há nota) · { falhou:true } */
  let falhou = false;                                  // alguma chamada não foi?
  let nfVinculada = false;                             // o Bling CONFIRMOU que existe uma NF ligada ao pedido?
  let respondeu = false;                               // alguma chamada respondeu?
  let leuNotaSemSerie = false;                         // li a NOTA (o Bling respondeu com ela) e a série não veio no corpo
  const pedir = async (url) => {
    try {
      const r = await blingGet(url, 3, signal);
      if (!r || r.ok === false) { falhou = true; return null; }
      respondeu = true;
      return (r.data && r.data.data) || null;
    } catch (e) { falhou = true; return null; }
  };
  const serieDe = (nf) => (nf && nf.serie != null && String(nf.serie) !== '')
    ? { numero: nf.numero || null, serie: String(nf.serie),
        situacao: (nf.situacao && (nf.situacao.id || nf.situacao)) || null,
        nfId: (nf.id != null ? String(nf.id) : null) } : null;   /* 25/08: situação junto (autorizada=2 na prática da casa, ver nfFluxos.js) — a sonda usa pra não listar NF cancelada como clone vivo */

  // 1) NF vinculada direto ao pedido
  let nf = await pedir(`/pedidos/vendas/${id}/nfe`);
  if (Array.isArray(nf)) nf = nf[0];
  let achou = serieDe(nf);
  if (achou) return achou;
  if (nf && Number(nf.id) > 0) {                       // veio resumo sem série → busca o detalhe
    nfVinculada = true;
    await sleep(PAUSA_MS);
    const detNf = await pedir(`/nfe/${nf.id}`);
    achou = serieDe(detNf);
    if (achou) return achou;
    if (detNf) leuNotaSemSerie = true;                 // a nota veio inteira e mesmo assim sem série
  }

  // 2) pelo detalhe do pedido (notaFiscal.id)
  if (!achou) {
    await sleep(PAUSA_MS);
    const det = await pedir(`/pedidos/vendas/${id}`);
    const raw = det ? (det.notaFiscal != null ? det.notaFiscal : det.nfe) : null;
    const nfId = (raw && typeof raw === 'object') ? raw.id : raw;
    if (Number(nfId) > 0) {
      nfVinculada = true;
      await sleep(PAUSA_MS);
      const detNf2 = await pedir(`/nfe/${nfId}`);
      achou = serieDe(detNf2);
      if (achou) return achou;
      if (detNf2) leuNotaSemSerie = true;              // idem: nota lida, série ausente do corpo
    }
  }

  /* Só posso afirmar "não tem nota" se NENHUMA chamada falhou. Basta uma ter falhado pra
     virar `falhou` — na dúvida o relógio não corre e a gente tenta de novo no próximo ciclo. */
  /* Codex #206: a nota LIDA vence falha alheia. Se `/nfe/{id}` respondeu com a nota (sem
     série no corpo) mas uma chamada REDUNDANTE depois falhou (429), `falhou` mascararia a
     confirmação e o relógio das 6h não andaria — no ambiente rate-limitado que este ajuste
     mira, isso seria o "para sempre" de volta. A leitura confirmada decide primeiro. */
  if (leuNotaSemSerie) return { nfSemSerie: true };
  if (falhou) return { falhou: true };
  /* ⚠️ Codex #199 (P1): se o Bling CONFIRMOU que existe NF vinculada mas a série não veio
     em nenhuma leitura, isso NÃO é "sem nota" — é "não consegui ler a série de uma nota que
     existe". Devolver semNF aqui deixaria o relógio das 6h correr e o pedido ser movido sem
     a série NUNCA ter sido lida: se fosse um clone série 1, é o incidente de 24/08 voltando
     por outra porta. Falha = não conta tempo, tenta de novo. */
  /* 26/08 (7 Full Shopee/Magalu acampados): vinculada mas a nota NUNCA foi lida = falha
     transitória, tenta de novo sem contar tempo — o caso estrutural (nota lida sem série,
     típico de XML importado pela extensão) já retornou { nfSemSerie } lá em cima e conta
     no relógio de 6h confirmadas. Nota ilegível não é clone: clone é emitido pelo Bling ao
     salvar e nasce com série 1 legível desde o primeiro minuto. */
  if (nfVinculada) return { falhou: true };
  return respondeu ? { semNF: true } : { falhou: true };
}

async function nfDoPedido(id) {
  // 1) tenta o endpoint direto (barato)
  const r = await blingGet(`/pedidos/vendas/${id}/nfe`);
  if (r.ok) {
    let nf = r.data && r.data.data;
    if (Array.isArray(nf)) nf = nf[0];
    if (nf) return parseNF(nf);
  }
  // 2) vinculo no detalhe do pedido (Bling v3: det.notaFiscal = { id } quando ha NF vinculada).
  //    Pega NF emitida MUITO depois do pedido (id fora da faixa do passo 3 — ex: dados fiscais corrigidos a mao).
  try {
    await sleep(PAUSA_MS);
    const d = await blingGet(`/pedidos/vendas/${id}`);
    const det = d && d.data && d.data.data;
    const raw = det ? (det.notaFiscal != null ? det.notaFiscal : det.nfe) : null;
    const nfId = (raw && typeof raw === 'object') ? raw.id : raw;
    if (Number(nfId) > 0) {
      await sleep(PAUSA_MS);
      const nd = await blingGet(`/nfe/${nfId}`);
      const nf = nd && nd.data && nd.data.data;
      if (nf) return parseNF(nf);
    }
  } catch (e) {}
  // 3) fallback: range de ID no /nfe
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

function acharNFnaLista(pedidoId, nfs, opts) {
  const pid = Number(pedidoId);
  if (!pid) return null;
  const o = opts || {};
  const nLoja = (o.numeroLoja != null && String(o.numeroLoja).trim()) ? String(o.numeroLoja).trim() : '';
  // 1) vínculo EXATO pelo nº do pedido na loja (quando a listagem /nfe traz numeroPedidoLoja) — sem heurística
  if (nLoja) {
    const exato = (nfs || []).find(nf => nf && nf.numeroPedidoLoja != null && String(nf.numeroPedidoLoja).trim() === nLoja);
    if (exato) { const p = parseNF(exato); if (p) p._criterio = 'exato'; return p; }
  }
  // 2) faixa de id (heurística) COM EXCLUSIVIDADE: uma NF nunca casa com dois pedidos.
  //    Bug real corrigido: comprador com 3 pedidos quase juntos fazia os 3 casarem com a MESMA NF (a menor da faixa)
  //    → 3 etiquetas com a mesma DANFE embaixo. Agora cada NF só casa uma vez; disputa → vínculo direto.
  const teto = pid + 2000;
  let melhor = null, houveConflito = false;
  for (const nf of (nfs || [])) {
    const nid = Number(nf.id) || 0;
    if (!(nid >= pid && nid <= teto)) continue;
    if (o.usadasIds && o.usadasIds.has(nid)) { houveConflito = true; continue; }          // já casada com outro pedido NESTE lote
    const dono = (o.donoPorNumero && nf.numero != null) ? o.donoPorNumero[String(nf.numero)] : null;
    if (dono && String(dono) !== String(pedidoId)) { houveConflito = true; continue; }    // já pertence a outro pedido no manifest
    if (!melhor || nid < Number(melhor.id)) melhor = nf;
  }
  if (!melhor) return houveConflito ? { _ambigua: true } : null;   // ambíguo → quem chamou cai pro vínculo direto (nfDoPedido)
  const p = parseNF(melhor); if (p) p._criterio = 'faixa';
  return p;
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
    destUF: _xmlTag(_xmlBloco(dest, 'enderDest'), 'UF') || null,
    destMun: _xmlTag(_xmlBloco(dest, 'enderDest'), 'xMun') || null,
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
    uf: x.destUF || null, municipio: x.destMun || null,
    numeroPedido: numeroPedido || '',
    numeroPedidoLoja: nf.numeroPedidoLoja || '',
    tributos: x.tributos || ''
  };
}


module.exports = {
  serieDaNFdoPedido, parseNF, acharNFporRange, nfDoPedido, carregarNFs, acharNFnaLista, baixarDanfe, parseXmlNF, baixarXmlNF, dadosNFSimp };
