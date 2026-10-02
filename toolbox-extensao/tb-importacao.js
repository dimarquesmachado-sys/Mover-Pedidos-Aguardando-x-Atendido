'use strict';
/* ══════════════════════════════════════════════════════════════════════
   tb-importacao.js — leitura do retorno do importador de XML do Bling
   (compartilhada pelos blocos Magalu e Shopee do ct-nf.js, e testável
   em Node sem DOM: scripts/teste-ct-nf-contagem.js)
   ══════════════════════════════════════════════════════════════════════
   POR QUE EXISTE (raio-x de 07/09, caso "31/31/31" da AMB):
   a mensagem de DUPLICADA do Bling contém as duas frases — "XML não
   importado" E "já está registrada" — então a contagem antiga somava a
   mesma nota nos dois contadores. Como o registro de importadas só
   rodava com nao_importados === 0, ele parou de rodar em 03/09 e toda
   nota importada com sucesso virou pendente eterno (bola de neve de 31,
   provada pelo /fbs/raio-x: as 31 estavam TODAS no Bling, com id).

   INVARIANTE: recusa por JÁ EXISTIR é presença confirmada — nunca conta
   como falha; só FALHA REAL (recusa por outro motivo) ou resposta VAZIA
   (200 sem conteúdo não é evidência de processamento) segura o registro.

   COMO CLASSIFICA: para cada ocorrência de "XML não importado", olha a
   JANELA À FRENTE (até a próxima ocorrência, teto de 240 chars) — o
   motivo vem depois da frase. Se a janela tem "já está registrada", é
   duplicada; senão, falha real. Escolha CONSERVADORA de propósito: um
   layout que não conheçamos vira falha real (não marca por engano e a
   nota re-tenta, visível), nunca o contrário — e o corpo agora fica
   guardado (campo `corpo`, e no resumo que o registrar envia ao
   servidor) pra refinar com o texto verdadeiro se aparecer um formato
   novo, em vez de voltar à adivinhação.
   ══════════════════════════════════════════════════════════════════════ */

function resumirImportacaoBling(txt) {
  // tira os marcadores de CDATA antes das tags, senao sobra "]]>" no texto
  const limpo = String(txt || '')
    .replace(/<!\[CDATA\[/g, ' ').replace(/\]\]>/g, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const conta = re => (limpo.match(re) || []).length;

  const RE_DUP = /já está registrada|ja esta registrada/i;
  const reNao = /XML não importado|XML nao importado/gi;
  const posicoes = [];
  let m;
  while ((m = reNao.exec(limpo))) posicoes.push(m.index);

  let falhasReais = 0;
  for (let i = 0; i < posicoes.length; i++) {
    const ini = posicoes[i];
    const fim = Math.min((i + 1 < posicoes.length) ? posicoes[i + 1] : limpo.length, ini + 240);
    if (!RE_DUP.test(limpo.slice(ini, fim))) falhasReais++;
  }

  const corpo = limpo.trim();
  return {
    ja_registradas: conta(/já está registrada|ja esta registrada/gi),
    eram_de_entrada: conta(/Para importar notas de entrada/gi),
    nao_importados: conta(/XML não importado|XML nao importado/gi), // contagem BRUTA da frase (compat com resumos antigos)
    falhas_reais: falhasReais,
    corpo_vazio: corpo === '',
    trecho: corpo.slice(0, 300),
    corpo: corpo.slice(0, 2000),
  };
}

/* ═══ b9 (ML Full) — loja e unidade da tela de importacao, lidas da PROPRIA pagina ═══
   O bloco ML Full (ct-nf.js) nao tem ids cravados por empresa como o Magalu/Shopee:
   le as opcoes dos selects da tela /importador.notas.fiscais.lote.php (o HTML que o
   descobrirIdEmpresa ja baixa) e escolhe a loja do Mercado Livre e a unidade Full.
   CONSERVADOR: loja ambigua (0 ou 2+ candidatas) = NAO importa e pede pra escolher
   na configuracao — importar na loja errada e pior que nao importar. */
function opcoesDoSelectBling(html, ids) {
  const fonte = String(html || '');
  for (const id of ids || []) {
    const re = new RegExp('<select[^>]*(?:id|name)\\s*=\\s*["\']' + id + '["\'][^>]*>([\\s\\S]*?)</select>', 'i');
    const m = re.exec(fonte);
    if (!m) continue;
    const out = [];
    const reO = /<option([^>]*)>([\s\S]*?)<\/option>/gi;
    let o;
    while ((o = reO.exec(m[1]))) {
      const mv = /value\s*=\s*["']?([^"'>\s]*)/i.exec(o[1]);
      out.push({ v: mv ? mv[1] : '', t: o[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() });
    }
    return out;
  }
  return null;   // select nao existe na pagina
}
function escolherLojaUnidadeML(lojas, unidades, cfg) {
  const c = cfg || {};
  const reML = /mercado\s*livre|mercadolivre|\bm\.?\s*livre\b|mlivre/i;   // 'Mercado Livre', 'MLivre' (nome da loja na AMB)
  let loja = String(c.mlf_loja || '').trim();
  let motivoLoja = loja ? 'configurada' : null;
  if (!loja) {
    const cand = (lojas || []).filter((x) => x.v && x.v !== '0' && reML.test(x.t));
    if (cand.length === 1) { loja = cand[0].v; motivoLoja = 'achada: ' + cand[0].t; }
    else motivoLoja = cand.length ? 'ambigua (' + cand.map((x) => x.t).join(' / ') + ')' : 'nenhuma loja "Mercado Livre" na tela';
  }
  let unidade = (c.mlf_unidade !== undefined && c.mlf_unidade !== null && String(c.mlf_unidade).trim() !== '') ? String(c.mlf_unidade).trim() : null;
  let motivoUnidade = unidade !== null ? 'configurada' : null;
  if (unidade === null) {
    if (!unidades || !unidades.length) { unidade = ''; motivoUnidade = 'a tela nao tem unidade de negocio'; }
    else {
      const full = unidades.filter((x) => x.v && /full/i.test(x.t));
      const fullML = full.filter((x) => reML.test(x.t) || /\bML\b|meli/i.test(x.t));
      const pick = fullML.length === 1 ? fullML[0] : (full.length === 1 ? full[0] : null);
      if (pick) { unidade = pick.v; motivoUnidade = 'achada: ' + pick.t; }
      else { unidade = unidades[0].v; motivoUnidade = 'padrao da tela: ' + (unidades[0].t || '(vazio)'); }
    }
  }
  return { loja: loja || null, unidade, motivoLoja, motivoUnidade };
}

/* export só existe no Node (teste); no navegador a função vira global do
   isolated world, visível pro ct-nf.js carregado depois (ordem no manifest) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resumirImportacaoBling, opcoesDoSelectBling, escolherLojaUnidadeML };
}
