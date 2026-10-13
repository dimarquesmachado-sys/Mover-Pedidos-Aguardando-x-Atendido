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
      atualizado: '2026-09-30',
      ads: { consumo: 300.5, desembolso: 280 },
      carteira: { saldo: 1200.75, entradas: 5000, saidas: 3799.25 },
      devolucoes: { total: 410.5, maiores: [
        { order_sn: '2409ABC', sku: 'SKU-1', motivo: 'x', status: 'ABERTA', valor: 120.5, custo: 60 },
        { order_sn: '2409XYZ', sku: 'SKU-2', motivo: 'x', status: 'FECHADA', valor: 90, custo: 40 },
      ] },
    } },
  { nome: 'sem despesas', d: { atualizado: '2026-09-30', ads: {}, carteira: {}, devolucoes: { total: 0, maiores: [] } } },
  { nome: 'rota recusou', d: { ok: false, erro: 'token do Shopee vencido' } },
];

const TELAS = [
  ['AMB', 'amb-checkout-offline/amb-dashboard.html', '/amb-checkout-offline'],
  ['Girassol', 'girassol-backup-offline/dashboard.html', '/girassol-backup-offline'],
];

const problemas = [];

for (const [emp, arq, MOD] of TELAS) {
  const html = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = html.indexOf('function desenharDespesasShopee');
  if (i < 0) continue;   /* já migrada: nada a comparar nesta empresa */
  const orig = html.slice(i, html.indexOf('\n}', i) + 2);

  const els = {};
  global.document = { getElementById: (id) => els[id] || (els[id] = { innerHTML: '' }) };

  const ORIG = new Function('MOD', 'BRL', 'dBR', 'N', 'MOTIVO_SHP', 'NOME_TIPO_SHP',
    orig + '; return desenharDespesasShopee;')(MOD, BRL, dBR, N, MOTIVO_SHP, NOME_TIPO_SHP);

  for (const { nome, d } of CENARIOS) {
    Object.keys(els).forEach((k) => delete els[k]);
    ORIG(d);
    const saidaOrig = JSON.stringify(els);

    Object.keys(els).forEach((k) => delete els[k]);
    PECA(d, { MOD, BRL, dBR, N, MOTIVO_SHP, NOME_TIPO_SHP, el: global.document.getElementById('shpCards') });
    const saidaPeca = JSON.stringify(els);

    if (saidaOrig !== saidaPeca) {
      problemas.push(emp + ' (' + nome + '): a peça gera tela DIFERENTE da embutida');
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

console.log('OK: a peça das despesas da Shopee gera a MESMA tela que a versão embutida');
