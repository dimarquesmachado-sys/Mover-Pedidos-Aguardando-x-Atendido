'use strict';
/* 24/10 — o backfill da GOOD não previa o frete da Magalu: o contexto dela passava `magaluFreteSkuLer: null`, então todo
   pedido da Magalu sem frete no Bling entrava com frete ZERO (margem inflada), enquanto a Girassol e a AMB usam a média
   do frete REAL do SKU. Prova: o contexto da GOOD entrega o leitor do banco DA GOOD (a mesma instância da peça que a venda
   do dia usa pra gravar), e a peça lê o banco da pasta da empresa. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

const s = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
assert.ok(!/magaluFreteSkuLer: null/.test(s), 'o contexto do backfill da GOOD ainda passa o banco do frete da Magalu como null');
assert.ok(/magaluFreteSkuLer: \(\.\.\.a\) => magaluFreteSkuLer\(\.\.\.a\)/.test(s), 'o contexto do backfill da GOOD não entrega o leitor do banco');
assert.ok(/const \{ magaluFreteProvisorio, magaluFreteSkuGravar, magaluFreteSkuLer(, magaluFretePrevistoSku)? \} = require\('\.\.\/lib\/checkout\/magalu-frete'\)\.criar\(\{\s*\n\s*CACHE_DIR, readJson, writeJson, blingGet,/.test(s),
  'o leitor não vem da MESMA instância da peça (a da GOOD, com a pasta dela) que a venda do dia usa pra gravar');
/* 25/10: a LEITURA do histórico (Mês/Ano) também completa o frete da Magalu na GOOD — a fase 2 (tabela por
   peso/cubagem) só roda com magaluFretePrevistoSku no contexto, como a Girassol e a AMB já passam */
assert.ok(/magaluFretePrevistoSku: \(\.\.\.a\) => magaluFretePrevistoSku\(\.\.\.a\),/.test(s), 'a leitura do histórico da GOOD não recebe a previsão do frete da Magalu');
assert.ok(/const \{ magaluFreteProvisorio, magaluFreteSkuGravar, magaluFreteSkuLer, magaluFretePrevistoSku \} = require\('\.\.\/lib\/checkout\/magalu-frete'\)\.criar\(/.test(s), 'a previsão não vem da peça da GOOD');
for (const arq of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js']) {
  const o = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/rotasHistorico\(\{[^}]*magaluFretePrevistoSku/.test(o), arq + ': a leitura do histórico perdeu a previsão do frete da Magalu');
}
// a peça lê o banco da pasta da empresa
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'));
fs.writeFileSync(path.join(dir, '_magalu_frete_sku.json'), JSON.stringify({ SKU1: { media: 23.5, n: 4 } }));
const rj = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
const p = require('../lib/checkout/magalu-frete').criar({ CACHE_DIR: dir, readJson: rj, writeJson: () => {}, blingGet: async () => null, resolverProdutoPorSku: async () => null });
assert.strictEqual(p.magaluFreteSkuLer().SKU1.media, 23.5, 'a peça não leu o banco da pasta da empresa');
fs.rmSync(dir, { recursive: true, force: true });
console.log('ok — GOOD: o backfill e a leitura do histórico preveem o frete da Magalu (média real do SKU, senão a tabela por peso/cubagem), como a Girassol e a AMB');
