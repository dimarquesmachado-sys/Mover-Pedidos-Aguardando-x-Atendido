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

/* export só existe no Node (teste); no navegador a função vira global do
   isolated world, visível pro ct-nf.js carregado depois (ordem no manifest) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resumirImportacaoBling };
}
