'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   CATEGORIA DA TARIFA DO ML — classifica a descrição do faturamento (15/09/2026).

   Peça pequena e PURA: recebe o texto que o Mercado Livre manda e devolve a que
   categoria ele pertence. Sem dependência nenhuma — nem cache, nem Bling, nem
   empresa. Por isso é a primeira fatia segura do entrypoint.

   O valor dela não é o tamanho, é o que está escrito dentro: cada regra aqui
   nasceu de dinheiro que apareceu ou sumiu de um card. O caso mais caro está
   documentado no corpo — o ML manda "Anulación del cargo por campaña de
   publicidad" em espanhol, e o padrão em português não pegava: eram R$ 849 de
   estorno de ads na AMB, dinheiro A FAVOR do dono, que não aparecia em card
   nenhum. Triplicar isso significava três chances de alguém consertar num lugar
   só e o dinheiro continuar sumindo nos outros dois.
   ──────────────────────────────────────────────────────────────────────────── */

function _mlbCategoria(det) {
  const t = String(det || '').toLowerCase();
  /* 02/09 — regras nascidas da LISTA real do que sobrou em 'outros' (rota ml-billing-outros),
     não de suposição. O que apareceu nas duas empresas:
       "Anulación del cargo por campaña de publicidad"  → ESTORNO de ads, e vinha em espanhol:
          são -R$ 849 na AMB que o ML devolveu e não apareciam em card nenhum (dinheiro A FAVOR
          do dono, sumido). O 'cancelamento|bonifica' não pega porque o texto usa 'anulación'.
       "Cargo por venta con afiliados"                  → comissão do programa de afiliados,
          R$ 1.103 na Girassol e R$ 149 na AMB — é custo por VENDA, entra como comissão.
       "Cobrança do diferencial de alíquota (ICMS-DIFAL)" → R$ 1.571 na Girassol; a regra de
          imposto não pegava porque o texto vem com 'diferencial de alíquota' e o DIFAL só
          aparece entre parênteses, abreviado como ICMS-DIFA.
       "Tarifa de manutenção da Minha página"           → R$ 1.089; a regra pedia 'minha página'
          exato e o texto tem 'manutenção da' no meio.
       "Tarifa de venda"                                → sobrou por acento/variação. */
  if (/anulaci[oó]n|estorno de cargo/.test(t))    return 'credito';
  if (/afiliado|con afiliados/.test(t))           return 'comissao';
  if (/diferencial de al[ií]quota|difa/.test(t))  return 'imposto';
  if (/minha p[áa]gina|manuten[çc][ãa]o da minha/.test(t)) return 'assinatura';
  /* 02/09 (o dono confirmou): a garantia do Programa Decola da AMB NÃO foi reembolsada —
     não atendemos aos requisitos e o ML ficou com os R$ 250. Deixou de ser caução e virou
     custo, então entra como despesa do período em vez de ficar escondida em 'outros'. */
  if (/programa decola/.test(t))                  return 'decola';
  if (/cancelamento|bonifica/.test(t))            return 'credito';
  if (/publicidade|product ads/.test(t))          return 'ads';
  if (/armazenamento|full/.test(t))               return 'full';
  if (/devolu/.test(t))                           return 'devolucao';
  if (/envio|frete/.test(t))                      return 'frete';
  /* 02/09: o resumo da fatura usa "Tarifas de venda" (é a MAIOR linha, R$ 16.897 em agosto);
     o detalhe usa "Custo por vender no Mercado Livre". Os dois são comissão. */
  if (/vender no mercado livre|tarifas? de venda/.test(t))  return 'comissao';
  if (/antecipa/.test(t))                         return 'antecipacao';
  if (/cobrar no mercado pago|recebimento/.test(t)) return 'mp';
  if (/parcelamento/.test(t))                     return 'parcelamento';
  /* 02/09 — conferido contra a fatura de agosto/2026 da AMB (R$ 45.926,80): duas linhas
     caíam em 'outros' e sumiam da tela, porque o card só desenha as categorias que conhece.
     São pequenas mas são dinheiro que sai do bolso, e a de imposto tende a crescer:
       "Tarifas da Minha página"  R$ 99,00
       "Impostos" (ICMS-DIFAL)    R$ 22,95                                            */
  if (/minha p[áa]gina|minha-pagina/.test(t))     return 'assinatura';
  /* Codex #317: 'iss' solto casava DENTRO de comissão e emissão, e como imposto agora entra
     na despesa do período, uma comissão seria descontada no lugar errado. Palavra inteira. */
  if (/imposto|difal|icms|\biss\b/.test(t))       return 'imposto';
  return 'outros';
}

module.exports = { _mlbCategoria };
