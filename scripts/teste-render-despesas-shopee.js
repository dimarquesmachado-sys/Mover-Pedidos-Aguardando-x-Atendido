/* ═══ A PEÇA DAS DESPESAS DA SHOPEE GERA A MESMA TELA QUE A VERSÃO EMBUTIDA ═══════════════════
   Por que este teste existe: extrair uma função que o dono já usa todo dia só é seguro se a saída
   for IGUAL. "Compila" e "não dá erro" não provam nada — a tela podia mudar de número, de rótulo
   ou de link e ninguém ver.

   Então o teste roda as DUAS — a original ainda dentro do HTML e a peça de `/lib` — com os MESMOS
   dados, e exige HTML idêntico. Enquanto a tela embutida existir, isso é uma trava real: mexer em
   uma e esquecer a outra fica vermelho.                                                        */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.resolve(__dirname, '..');
const { desenharDespesasShopee: PECA } = require(path.join(raiz, 'lib', 'checkout', 'render-despesas-shopee'));

const BRL = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const N = (v) => (Number(v) || 0).toLocaleString('pt-BR');
const dBR = (s) => String(s || '').split('-').reverse().join('/');
const MOTIVO_SHP = { x: 'motivo X' };
const NOME_TIPO_SHP = { COMMISSION: 'Comissão', SERVICE: 'Serviço' };

/* dois cenários: um cheio e um VAZIO — o vazio pega o caso de "sem despesa no período", onde um
   erro de extração apareceria como tabela em branco em vez de aviso. */
const CENARIOS = [
  /* ⚠️ os campos são os que a função REALMENTE lê (`d.ads`, `d.carteira`, `d.devolucoes`,
     `d.atualizado`) — na 1ª versão deste teste eu inventei `total`/`por_tipo`/`maiores` e, sem
     `devolucoes.maiores`, a tabela com os LINKS nem era desenhada: a mutação que trocava o `MOD`
     passava batida. Li a função antes de montar o cenário. */
  { nome: 'com despesas', d: {
      atualizado: { carteira: '2026-09-30T10:00:00', devolucoes: '2026-09-29' },
      ads: { gasto: 300.5, roas: 4.2, vendas: 1262.1 },
      carteira: {
        custo_por_tipo: { COMMISSION: 800.4, SERVICE: 120, ADJUSTMENT_FOR_RR_AFTER_ESCROW_VERIFIED: 50, OUTRO_TIPO: 10 },
        sai_do_bolso: 1280.9,
      },
      devolucoes: {
        quantidade: 7, valor_devolvido: 410.5, custo_real_na_carteira: 180.25, canceladas_fora_da_conta: 2,
        por_motivo: { x: 5, y: 2 },
        por_sku: [
          { sku: 'SKU-1', nome: 'Produto "aspas" 1', qtd: 4, valor: 250.5, custo_real: 120 },
          { sku: 'SKU-2', nome: 'Produto 2', qtd: 3, valor: 160, custo_real: 60.25 },
        ],
        maiores: [
          { order_sn: '2409ABC', sku: 'SKU-1', motivo: 'x', texto: 'chegou "quebrado"', status: 'ABERTA', parcial: true, valor: 120.5, custo_real: 60 },
          { order_sn: '2409XYZ', sku: 'SKU-2', motivo: 'y', status: 'FECHADA', valor: 90, custo_real: 0 },
          { order_sn: '', sku: '', motivo: '', valor: 0 },
        ],
      },
    } },
  /* sem `custo_real` nos SKUs: coluna/rodapé de custo somem e o % passa a ser do valor devolvido */
  { nome: 'sem custo real nos SKUs', d: {
      atualizado: { devolucoes: '2026-09-29' },
      ads: { gasto: 0 },
      carteira: { custo_por_tipo: { COMMISSION: 10 }, sai_do_bolso: 0 },
      devolucoes: { quantidade: 1, valor_devolvido: 50, por_sku: [{ sku: 'SKU-3', qtd: 1, valor: 50 }], maiores: [] },
    } },
  { nome: 'sem despesas', d: { atualizado: '2026-09-30', ads: {}, carteira: {}, devolucoes: { total: 0, maiores: [] } } },
  { nome: 'rota recusou', d: { ok: false, erro: 'token do Shopee vencido' } },
];

const TELAS = [
  ['AMB', 'amb-checkout-offline/amb-dashboard.html', '/amb-checkout-offline'],
  ['Girassol', 'girassol-backup-offline/dashboard.html', '/girassol-backup-offline'],
];

const problemas = [];
let comparadas = 0;

/* trava contra fixture "bonita mas vazia" (Codex #676): o cenário cheio TEM de acender cada ramo
   da tela — se um marcador sumir da saída, o teste fica vermelho em vez de passar em branco. */
const MARCADORES = ['Comissão', 'Ads (consumo)', 'ROAS', '4.2', 'sai do bolso', 'por que voltou', 'motivo X',
  'SKU que mais voltou', 'custo real', 'total das devolu', 'Atenção', 'ir-shopee?sn=2409ABC', 'parcial',
  'FORA da conta', 'Shopee atualizada em 30/09/2026'];

for (const [emp, arq, MOD] of TELAS) {
  const html = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = html.indexOf('function desenharDespesasShopee');
  const els = {};
  global.document = { getElementById: (id) => els[id] || (els[id] = { innerHTML: '' }) };

  /* já migrada: sem versão embutida a comparar, mas as checagens da PEÇA abaixo continuam */
  const ORIG = i < 0 ? null : new Function('MOD', 'BRL', 'dBR', 'N', 'MOTIVO_SHP', 'NOME_TIPO_SHP',
    html.slice(i, html.indexOf('\n}', i) + 2) + '; return desenharDespesasShopee;')(MOD, BRL, dBR, N, MOTIVO_SHP, NOME_TIPO_SHP);

  for (const { nome, d } of CENARIOS) {
    let saidaOrig = null;
    if (ORIG) {
      Object.keys(els).forEach((k) => delete els[k]);
      ORIG(d);
      saidaOrig = JSON.stringify(els);
    }

    Object.keys(els).forEach((k) => delete els[k]);
    PECA(d, { MOD, BRL, dBR, N, MOTIVO_SHP, NOME_TIPO_SHP, el: global.document.getElementById('shpCards') });
    const saidaPeca = JSON.stringify(els);

    if (ORIG) {
      comparadas++;
      if (saidaOrig !== saidaPeca) {
        problemas.push(emp + ' (' + nome + '): a peça gera tela DIFERENTE da embutida');
      }
    }
    if (nome === 'com despesas') {
      MARCADORES.forEach((m) => {
        if (saidaPeca.indexOf(m) < 0) problemas.push(emp + ': o cenário cheio não exerce "' + m + '" (fixture fraca ou peça quebrada)');
      });
    }
  }

  /* o link do pedido tem de levar o prefixo DESTA empresa — link que abre o pedido da outra loja
     é pior que link nenhum, e foi o motivo de `MOD` entrar por parâmetro (Codex #675). */
  Object.keys(els).forEach((k) => delete els[k]);
  PECA(CENARIOS[0].d, { MOD, BRL, dBR, N, MOTIVO_SHP, NOME_TIPO_SHP, el: global.document.getElementById('shpCards') });
  const tudo = JSON.stringify(els);
  if (tudo.indexOf('ir-shopee') >= 0 && tudo.indexOf(MOD + '/ir-shopee') < 0) {
    problemas.push(emp + ': o link do pedido não leva o prefixo da empresa');
  }
}

assert.deepStrictEqual(problemas, [],
  '[DESPESAS-SHOPEE] a peça não reproduz a tela:\n  ' + problemas.join('\n  '));

if (comparadas === 0) {
  /* nada embutido sobrou: a paridade está APOSENTADA, não "aprovada" — dizer isso em voz alta */
  console.log('OK (paridade aposentada): nenhuma tela embute mais a função; só as checagens da peça rodaram');
} else {
  console.log('OK: a peça das despesas da Shopee gera a MESMA tela que a versão embutida (' + comparadas + ' comparações)');
}
