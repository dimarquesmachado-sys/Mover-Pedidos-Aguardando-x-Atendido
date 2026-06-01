'use strict';
// ──────────────────────────────────────────────────────────────────────
// PROBE (somente leitura) — testa se o Render consegue chamar a API
// interna do Bling (vendas.lojas.virtuais) usando o cookie de sessão.
//
// Não importa nada. Só chama obterListaDePedidos e devolve o resultado,
// pra sabermos se o Cloudflare deixa o IP do Render passar com o cookie.
//
// Cookie vem da env var BLING_COOKIE (cole o header Cookie inteiro lá).
// ──────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const URL_BLING = 'https://www.bling.com.br/services/vendas.lojas.virtuais.server.php?f=obterListaDePedidos';
const ID_INTEGRACAO = process.env.STAGING_ID_INTEGRACAO || '5237';
const ID_LOJA       = process.env.STAGING_ID_LOJA       || '203146903';
const TIPO_INTEGRACAO = 'MercadoLivre';
const JANELA_DIAS = parseInt(process.env.STAGING_JANELA_DIAS || '15');

function periodoBR() {
  const fim = new Date();
  const ini = new Date();
  ini.setDate(ini.getDate() - JANELA_DIAS);
  const fmt = d => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  return { dataInicial: fmt(ini), dataFinal: fmt(fim) };
}

function montarFiltro(dataInicial, dataFinal) {
  const e = (k, v) => `<e><k>${k}</k><v>${v}</v></e>`;
  return '<xjxobj>'
    + e('numero', '') + e('situacao', '') + e('situacaoVenda', 'todas')
    + e('dataInicial', dataInicial) + e('dataFinal', dataFinal)
    + e('ordemVenda', 'date_desc') + e('ordemVenda2', '') + e('ordemVenda3', '')
    + e('apelido', 'undefined') + e('shipmentType', 'undefined')
    + e('pedidosImportados', 'S') + e('ordem', 'date_desc')
    + e('page', '0') + e('paginacao', '') + e('idFormaPagamento', 'undefined')
    + '</xjxobj>';
}

async function listarStaging() {
  const cookie = process.env.BLING_COOKIE;
  if (!cookie) return { erro: 'BLING_COOKIE não configurado nas env vars do Render' };

  const { dataInicial, dataFinal } = periodoBR();
  const filtro = montarFiltro(dataInicial, dataFinal);

  const params = new URLSearchParams();
  params.append('xajax', 'obterListaDePedidos');
  params.append('xajaxr', Date.now().toString());
  params.append('xajaxargs[]', ID_INTEGRACAO);
  params.append('xajaxargs[]', ID_LOJA);
  params.append('xajaxargs[]', TIPO_INTEGRACAO);
  params.append('xajaxargs[]', filtro);
  params.append('xajaxargs[]', 'P');

  const resp = await fetch(URL_BLING, {
    method: 'POST',
    headers: {
      'Cookie': cookie,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://www.bling.com.br',
      'Referer': 'https://www.bling.com.br/vendas.lojas.virtuais.php',
      'Accept': '*/*',
      'Accept-Language': 'pt-BR,pt;q=0.9'
    },
    body: params.toString()
  });

  const texto = await resp.text();
  const contentType = resp.headers.get('content-type') || '';

  // tenta interpretar como JSON (resposta esperada)
  let json = null;
  try { json = JSON.parse(texto); } catch (e) { /* não é JSON */ }

  // heurística de bloqueio: não veio JSON, ou veio HTML/Cloudflare/login
  const txtLower = texto.toLowerCase();
  const pareceBloqueio =
    !json ||
    txtLower.includes('cloudflare') ||
    txtLower.includes('<!doctype html') ||
    txtLower.includes('cf-') ||
    txtLower.includes('faça login') ||
    txtLower.includes('vendas.php#login');

  let pendentes = null, exemplos = null;
  if (json && Array.isArray(json.data)) {
    const naoImportados = json.data.filter(d => String(d.idImportado) === '0');
    pendentes = naoImportados.length;
    exemplos = naoImportados.slice(0, 5).map(d => ({
      numero: d.numero,
      idImportado: d.idImportado,
      dataPedido: d.dataPedido
    }));
  }

  return {
    veredicto: pareceBloqueio
      ? '❌ PARECE BLOQUEADO/SEM SESSÃO — o caminho A pode não funcionar do Render'
      : '✅ PASSOU — o Render conseguiu falar com a API interna do Bling!',
    httpStatus: resp.status,
    contentType,
    pareceBloqueio,
    totalNaLista: json && Array.isArray(json.data) ? json.data.length : null,
    pedidosNaoImportados: pendentes,
    exemplos,
    amostraResposta: texto.slice(0, 500)
  };
}

module.exports = { listarStaging };
