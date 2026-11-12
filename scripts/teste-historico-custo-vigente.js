'use strict';
/* 12/11 — AS VENDAS DO DIA USAM O CUSTO QUE VALIA NO DIA DA VENDA (rota /historico, que alimenta o Hoje/Ontem/Semana).
   Caso real do dono (AMB, SKU CM1): corrigiu o custo e a venda de HOJE, na Análise de vendas, seguia com o custo antigo.
   A rota lia só o banco de custos (a última leitura do Bling) e ignorava a linha do tempo do custo — inclusive a faixa
   lançada à mão no dashboard. O Mês/Ano (que vem do histórico) mostrava o custo novo; o Hoje, não.
   Prova, com a rota DE VERDADE e os arquivos de uma empresa de mentira:
   · SKU com faixa lançada à mão: a venda de hoje sai com o custo da faixa (não o do banco);
   · faixas com datas: cada venda pega o custo do DIA DELA (a de antes da mudança fica com o antigo);
   · SKU sem faixa pro dia: o banco de custos, como sempre; SKU sem nada: sem custo (nunca zero inventado);
   · vale pras vendas bipadas (conferidos) e pras ainda não bipadas (vendas do dia); a caixa do SKU não importa. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rotasHistorico } = require('../lib/checkout/historico');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-custo-'));
const gravar = (nome, obj) => fs.writeFileSync(path.join(dir, nome), JSON.stringify(obj));
const hoje = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
const diasAtras = (n) => new Date(Date.now() - n * 86400000).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
gravar('_custos.json', { CM1: { custo: 120 }, SEMFAIXA: { custo: 50 }, KC6: { custo: 147 } });   /* a última leitura do Bling */
gravar('_custos-vigencia.json', {
  CM1: [{ custo: 102.59, de: diasAtras(60), ate: null, origem: 'manual' }],                       /* lançado à mão: vale até hoje */
  KC6: [{ custo: 126.65, de: diasAtras(70), ate: diasAtras(3), origem: 'manual' }, { custo: 147, de: diasAtras(2), ate: null, origem: 'bling' }],
});
gravar('_vendas_dia.json', {
  a: { numero: '1', data: hoje, venda_em: new Date().toISOString(), it: [{ sku: 'CM1', q: 1 }, { sku: 'SEMFAIXA', q: 1 }, { sku: 'NADA', q: 1 }] },
  b: { numero: '2', data: diasAtras(5), it: [{ sku: 'KC6', q: 1 }] },      /* antes da faixa do Bling: 126,65 */
  c: { numero: '3', data: diasAtras(1), it: [{ sku: 'kc6', q: 1 }] },      /* depois: 147 (e a caixa do SKU não importa) */
});
const conf = path.join(dir, 'conferidos.json');
fs.writeFileSync(conf, JSON.stringify({ 900: { numero: '900', conferido_em: new Date().toISOString(), venda_dia: hoje, nf_emissao: null, nf_id: null, itens: [{ sku: 'cm1', qtd: 1 }] } }));

const lerJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
const handler = rotasHistorico({ empresa: 'tcusto', modulo: 'tcusto', validarSessao: () => 'dono', supaCfg: () => ({ url: '', key: '' }), CACHE_DIR: dir, CONFERIDOS_FILE: conf,
  readJson: lerJson, writeJson: (f, v) => fs.writeFileSync(f, JSON.stringify(v)), ehAdmin: () => true, blingGet: async () => ({}), nfDoPedido: async () => null, detalhePedido: async () => null,
  sleep: async () => {}, json: (res, st, corpo) => { res.st = st; res.corpo = corpo; }, histCache: {}, PAUSA_MS: 0 });

(async () => {
  const res = {};
  const tratou = await handler({ method: 'GET', headers: { cookie: 'x' }, url: '/tcusto/historico' }, res, new URL('http://x/tcusto/historico'));
  assert.ok(tratou && res.st === 200 && res.corpo && Array.isArray(res.corpo.itens) && Array.isArray(res.corpo.vendas_bling), 'a rota /historico não respondeu: ' + JSON.stringify(res).slice(0, 200));
  const venda = (n) => res.corpo.vendas_bling.find((v) => String(v.numero) === n);
  const custo = (v, sku) => v.it.find((i) => i.sku === sku).custo;
  assert.strictEqual(custo(venda('1'), 'CM1'), 102.59, 'a venda de HOJE do SKU com custo lançado à mão tinha que sair com o custo lançado (o banco ainda diz 120)');
  assert.strictEqual(custo(venda('1'), 'SEMFAIXA'), 50, 'SKU sem faixa pro dia: o banco de custos, como sempre');
  assert.strictEqual(custo(venda('1'), 'NADA'), null, 'SKU sem custo nenhum: fica sem custo (nunca um zero inventado)');
  assert.strictEqual(custo(venda('2'), 'KC6'), 126.65, 'a venda de 5 dias atrás pega o custo que valia NAQUELE dia');
  assert.strictEqual(custo(venda('3'), 'kc6'), 147, 'a venda de ontem pega a faixa nova — e a caixa do SKU não importa');
  const bipado = res.corpo.itens.find((h) => String(h.numero) === '900');
  assert.strictEqual(bipado.itens[0].custo, 102.59, 'vale também pro pedido já bipado (conferidos)');
  console.log('ok — vendas do dia/semana: o custo é o que valia no dia da venda (a faixa lançada à mão incluída); sem faixa, a última leitura do Bling');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
