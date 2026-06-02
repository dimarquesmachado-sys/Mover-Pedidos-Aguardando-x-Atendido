'use strict';

/**
 * blingProdutos.js — Consulta e atualiza produtos no Bling para /amb-drive-imagens
 *
 * Funções:
 *   buscarProdutoPorCodigo(codigo)   → produto resumido pelo SKU
 *   buscarProdutoPorId(id)           → produto completo (inclui midia, variacoes, estrutura)
 *   atualizarImagens(id, urls)       → grava imagens externas (bug-fixes do Bling embutidos)
 *
 * Bugs do Bling contornados (descobertos no projeto AMBTotal):
 *   1. Campo é "externa" (singular), não "externas" — senão é ignorado
 *   2. "externa: []" não limpa — usa padding com {link:''} até o tamanho atual
 *   3. Kit (formato E): preserva estrutura com componente.id (não produto.id)
 *   4. lancamentoEstoque default 'P' se vazio
 *   5. Código da variação vem vazio no JSON do pai — busca individual
 */

const tokenMgr = require('./tokenManager');

const BLING_BASE = 'https://api.bling.com.br/Api/v3';
const PAUSA_MS = Number(process.env.AMBIMG_BLING_PAUSA_MS || 400);
const MAX_RETRIES = 5;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP com retry/backoff em 429 ────────────────────────────────────

async function blingReq(method, path, body) {
  const url = `${BLING_BASE}${path}`;
  const opts = { method, headers: {} };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let ultima = null;
  for (let tentativa = 1; tentativa <= MAX_RETRIES; tentativa++) {
    const r = await tokenMgr.fetchComRetry(url, opts);
    const txt = await r.text();
    let data;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { _raw: txt }; }

    if (r.ok) return data;
    ultima = { status: r.status, data };

    if (r.status === 429) {
      const waitMs = Math.min(1000 * Math.pow(2, tentativa - 1), 16000);
      console.log(`[amb-drive-imagens blingProdutos] 429 em ${method} ${path} (${tentativa}/${MAX_RETRIES}) — aguardando ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }
    if (r.status === 503) {
      throw new Error('Bling fora do ar (503). Tente novamente em alguns minutos.');
    }
    throw new Error(`Bling ${method} ${path} ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  throw new Error(`Bling ${method} ${path} ${ultima.status} após ${MAX_RETRIES} tentativas: ${JSON.stringify(ultima.data).slice(0, 300)}`);
}

const blingGet = (path) => blingReq('GET', path);

// ── Buscas ───────────────────────────────────────────────────────────

async function buscarProdutoPorCodigo(codigo) {
  const data = await blingGet(`/produtos?codigo=${encodeURIComponent(codigo)}&limite=10&pagina=1`);
  const produtos = data?.data || [];
  if (produtos.length === 0) return { encontrado: false };
  const exato = produtos.find(p => (p.codigo || '').toUpperCase() === String(codigo).toUpperCase());
  const escolhido = exato || produtos[0];
  return { encontrado: true, id: escolhido.id, codigo: escolhido.codigo, nome: escolhido.nome };
}

async function buscarProdutoPorId(id) {
  const data = await blingGet(`/produtos/${id}`);
  return data?.data || null;
}

// ── Atualizar imagens (com os bug-fixes do Bling) ────────────────────

async function atualizarImagens(idProduto, urls) {
  console.log(`[amb-drive-imagens blingProdutos] atualizarImagens id=${idProduto}, ${urls.length} URLs`);

  const produtoAntes = await buscarProdutoPorId(idProduto);
  if (!produtoAntes) throw new Error(`Produto ${idProduto} não encontrado no Bling`);

  const externasAntes = ((produtoAntes.midia || {}).imagens || {}).externas || [];
  const internasAntes = ((produtoAntes.midia || {}).imagens || {}).internas || [];

  await sleep(PAUSA_MS);

  // Bling usa SINGULAR "externa" no PUT/PATCH. Padding com {link:''} força
  // sobrescrever todas as posições (Bling faz merge posicional e ignora [] vazio).
  const externasNovas = (urls || []).map(link => ({ link }));
  const externasComPadding = [...externasNovas];
  while (externasComPadding.length < externasAntes.length) {
    externasComPadding.push({ link: '' });
  }

  const bodyPatch = {
    midia: { imagens: { externa: externasComPadding } }
  };

  // Kit/composição (formato "E"): preserva estrutura, senão Bling dá 400
  if (produtoAntes.formato === 'E' && produtoAntes.estrutura) {
    bodyPatch.estrutura = {
      tipoEstoque: produtoAntes.estrutura.tipoEstoque || 'V',
      lancamentoEstoque: produtoAntes.estrutura.lancamentoEstoque || 'P',
      componentes: (produtoAntes.estrutura.componentes || []).map(c => ({
        componente: { id: (c.produto && c.produto.id) || (c.componente && c.componente.id) },
        quantidade: c.quantidade
      })),
      excluir: false
    };
  }

  await blingReq('PATCH', `/produtos/${idProduto}`, bodyPatch);
  await sleep(PAUSA_MS);

  // Verifica
  const verif = await buscarProdutoPorId(idProduto);
  const externasDepois = ((verif && verif.midia || {}).imagens || {}).externas || [];

  if (externasDepois.length !== urls.length) {
    throw new Error(
      `Bling aceitou o PATCH mas não atualizou corretamente. ` +
      `Esperado ${urls.length} externas, atual ${externasDepois.length}.`
    );
  }

  console.log(`[amb-drive-imagens blingProdutos] OK id=${idProduto}: ${externasDepois.length} externas confirmadas`);
  return {
    ok: true,
    qtdExternas: externasNovas.length,
    qtdInternasMantidas: internasAntes.length,
    qtdExternasConfirmadas: externasDepois.length
  };
}

module.exports = {
  buscarProdutoPorCodigo,
  buscarProdutoPorId,
  atualizarImagens
};
