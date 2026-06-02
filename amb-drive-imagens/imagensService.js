'use strict';

/**
 * imagensService.js — Lógica de processar imagens do Drive e enviar pro Bling.
 *
 * Portado do projeto standalone (AMBTotal/AMBTotal Imagens), adaptado pro padrão
 * do mover-pedidos (driveApi + blingProdutos do próprio módulo).
 *
 * - processarUm({sku, pastaId})  → torna imagens públicas, gera URLs LH3, detecta variações
 * - enviarUm({sku, urls, variacoesUrls}) → envia pro Bling (pai + variações)
 * - listarPastas() → lista pastas de SKU na pasta-mãe do Drive
 */

const drive = require('./driveApi');
const blingProdutos = require('./blingProdutos');

const MAX_IMAGENS_BLING = 12;

function extrairNumero(nome) {
  const base = String(nome || '').replace(/\.[^.]+$/, '');
  const matches = base.match(/\d+/g);
  if (!matches) return 999999;
  return parseInt(matches[matches.length - 1], 10);
}

function ordenarImagens(imagens) {
  imagens.sort((a, b) => {
    const na = extrairNumero(a.name);
    const nb = extrairNumero(b.name);
    if (na !== nb) return na - nb;
    return String(a.name).localeCompare(String(b.name), 'pt-BR');
  });
  return imagens;
}

// ── Listar pastas ────────────────────────────────────────────────────

async function listarPastas() {
  const mae = drive.pastaMae();
  if (!mae) throw new Error('AMBIMG_DRIVE_FOLDER_ID não configurado');

  const subpastas = await drive.listarSubpastas(mae);
  const resultados = await Promise.all(subpastas.map(async (sub) => {
    try {
      const conteudo = await drive.listarConteudoCompleto(sub.id);
      return {
        sku: sub.name,
        pastaId: sub.id,
        qtdImagens: conteudo.imagens.length,
        qtdSubpastas: conteudo.subpastas.length,
        createdTime: sub.createdTime,
        modifiedTime: sub.modifiedTime
      };
    } catch (e) {
      return { sku: sub.name, pastaId: sub.id, qtdImagens: 0, qtdSubpastas: 0, erro: e.message,
               createdTime: sub.createdTime, modifiedTime: sub.modifiedTime };
    }
  }));
  resultados.sort((a, b) => a.sku.localeCompare(b.sku, 'pt-BR', { numeric: true, sensitivity: 'base' }));
  return resultados;
}

// ── Processar imagens (torna públicas + gera URLs LH3) ───────────────

async function processarImagensRaw(imagens, contextoLog) {
  if (!imagens || imagens.length === 0) return { qtd: 0, urls: [], nomes: [] };

  ordenarImagens(imagens);
  const qtdTotal = imagens.length;
  const limitadas = imagens.slice(0, MAX_IMAGENS_BLING);
  let aviso = null;
  if (qtdTotal > MAX_IMAGENS_BLING) {
    aviso = `${contextoLog} tem ${qtdTotal} imagens, limitado a ${MAX_IMAGENS_BLING}. Imagens 13+ ignoradas.`;
    console.log(`[amb-drive-imagens] AVISO: ${aviso}`);
  }

  // Torna públicas de 3 em 3
  for (let i = 0; i < limitadas.length; i += 3) {
    const lote = limitadas.slice(i, i + 3);
    await Promise.all(lote.map(async (img) => {
      try { await drive.tornarPublico(img.id); }
      catch (e) { console.log(`[amb-drive-imagens] Aviso publicar ${img.name}: ${e.message}`); }
    }));
  }

  const urls = limitadas.map(img => `https://lh3.googleusercontent.com/d/${img.id}`);
  const nomes = limitadas.map(img => img.name);
  const ret = { qtd: limitadas.length, qtdTotal, urls, nomes, urlsConcatenadas: urls.join('|') };
  if (aviso) ret.aviso = aviso;
  return ret;
}

async function processarUm({ sku, pastaId }) {
  if (!sku || !pastaId) return { erro: 'sku ou pastaId faltando' };
  try {
    const { imagens: imagensPai, subpastas } = await drive.listarConteudoCompleto(pastaId);
    const resultadoPai = await processarImagensRaw(imagensPai, `SKU ${sku}`);

    if (!subpastas || subpastas.length === 0) {
      if (resultadoPai.qtd === 0) return { qtd: 0, urls: [], aviso: 'pasta sem imagens' };
      return resultadoPai;
    }

    console.log(`[amb-drive-imagens] SKU ${sku} tem ${subpastas.length} subpasta(s) de variação`);
    const variacoes = {};
    for (const sub of subpastas) {
      const codigoVar = sub.name;
      try {
        const { imagens: imagensVar } = await drive.listarConteudoCompleto(sub.id);
        variacoes[codigoVar] = await processarImagensRaw(imagensVar, `Variação ${codigoVar}`);
      } catch (e) {
        variacoes[codigoVar] = { erro: e.message };
      }
    }
    return { ...resultadoPai, temVariacoes: true, variacoes };
  } catch (e) {
    return { erro: e.message };
  }
}

// ── Enviar pro Bling (pai + variações) ───────────────────────────────

async function enviarUm({ sku, urls, variacoesUrls }) {
  if (!sku) return { erro: 'sku faltando' };
  if (!Array.isArray(urls) || urls.length === 0) return { erro: 'urls vazias - processe primeiro' };
  try {
    const produto = await blingProdutos.buscarProdutoPorCodigo(sku);
    if (!produto.encontrado) return { erro: 'produto não encontrado no Bling' };

    const completo = await blingProdutos.buscarProdutoPorId(produto.id);
    const temVariacoes = completo && completo.formato === 'V' && Array.isArray(completo.variacoes) && completo.variacoes.length > 0;

    const r = await blingProdutos.atualizarImagens(produto.id, urls);
    const resultadoPai = {
      ok: true,
      idProduto: produto.id,
      nomeProduto: produto.nome,
      qtdEnviadas: r.qtdExternas,
      qtdConfirmadas: r.qtdExternasConfirmadas,
      qtdInternasMantidas: r.qtdInternasMantidas
    };

    if (!temVariacoes) return { ...resultadoPai, enviadoEm: new Date().toISOString() };

    const resultadosVariacoes = {};
    variacoesUrls = variacoesUrls || {};

    for (const variacao of completo.variacoes) {
      let codigoVar = variacao.codigo;
      if (!codigoVar) {
        try {
          const varCompleta = await blingProdutos.buscarProdutoPorId(variacao.id);
          codigoVar = varCompleta && varCompleta.codigo ? varCompleta.codigo : null;
        } catch (e) {
          console.log(`[amb-drive-imagens] Erro buscando código da variação id=${variacao.id}: ${e.message}`);
        }
      }
      if (!codigoVar) {
        resultadosVariacoes[`(id ${variacao.id})`] = { erro: 'variação sem código no Bling' };
        continue;
      }

      const temSubpastaPropria = !!(variacoesUrls[codigoVar] && variacoesUrls[codigoVar].length > 0);
      const urlsVar = temSubpastaPropria ? variacoesUrls[codigoVar] : urls;
      const fonte = temSubpastaPropria ? 'subpasta-propria' : 'replicado-pai';

      try {
        const rVar = await blingProdutos.atualizarImagens(variacao.id, urlsVar);
        resultadosVariacoes[codigoVar] = {
          ok: true, idVariacao: variacao.id, fonte,
          qtdEnviadas: rVar.qtdExternas, qtdConfirmadas: rVar.qtdExternasConfirmadas
        };
      } catch (e) {
        resultadosVariacoes[codigoVar] = { erro: e.message, idVariacao: variacao.id, fonte };
      }
    }

    return { ...resultadoPai, temVariacoes: true, variacoes: resultadosVariacoes, enviadoEm: new Date().toISOString() };
  } catch (e) {
    return { erro: e.message };
  }
}

// ── Processar e enviar de uma vez ────────────────────────────────────

async function processarEEnviarUm(item) {
  const proc = await processarUm(item);
  if (proc.erro) return { etapa: 'processar', erro: proc.erro };
  if (!proc.urls || proc.urls.length === 0) return { etapa: 'processar', erro: proc.aviso || 'sem URLs geradas' };

  let variacoesUrls = null;
  if (proc.temVariacoes && proc.variacoes) {
    variacoesUrls = {};
    for (const codVar of Object.keys(proc.variacoes)) {
      const v = proc.variacoes[codVar];
      if (v && Array.isArray(v.urls) && v.urls.length > 0) variacoesUrls[codVar] = v.urls;
    }
  }

  const env = await enviarUm({ sku: item.sku, urls: proc.urls, variacoesUrls });
  return {
    processamento: {
      qtd: proc.qtd, urls: proc.urls, nomes: proc.nomes,
      urlsConcatenadas: proc.urlsConcatenadas,
      temVariacoes: !!proc.temVariacoes, variacoes: proc.variacoes || null
    },
    envio: env
  };
}

module.exports = {
  listarPastas,
  processarUm,
  enviarUm,
  processarEEnviarUm
};
