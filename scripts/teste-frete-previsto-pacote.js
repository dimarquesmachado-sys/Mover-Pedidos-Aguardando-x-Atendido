'use strict';
/* 03/11 — FRETE PREVISTO DO PACOTE DA MAGALU = a MAIOR média entre os itens (lib/checkout/magalu-frete-pacote). Caso real
   (Girassol, pedido 124275, Magalu LU #1583470110317513): tosquiadeira de 1200 W + kit de lâminas; a regra antiga ("o 1º
   SKU em ordem alfabética com banco") pegou o kit ('9-dentes-reta' vem antes de 'TAF-PRO-220v') e o previsto saiu
   R$ 17,95, contra R$ 181,80 de coparticipação no repasse — margem R$ 163,85 alta. Prova:
   · a regra sozinha: o maior vence, independe da ordem dos itens, empate fica com o 1º em ordem alfabética, sem banco
     nenhum → null (segue pra tabela por dimensão);
   · a FUNÇÃO DE PRODUÇÃO da venda do dia (lib/checkout/magalu-frete, magaluFreteProvisorio) com o banco de mentira do
     caso real → R$ 181,80, nas duas ordens dos itens;
   · os outros três lugares que decidem o previsto (o leitor do histórico, a caça da Magalu e o backfill) usam a regra
     única — nenhum ficou com o laço antigo do "1º com banco". */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { maiorMediaDoPacote } = require('../lib/checkout/magalu-frete-pacote');

const banco = { '9-dentes-reta': { media: 17.95, n: 12 }, 'TAF-PRO-220v': { media: 181.8, n: 3 }, 'KP22': { media: 30, n: 5 }, 'KP18': { media: 30, n: 2 } };
const mediaDe = (s) => banco[s] && banco[s].media;
assert.deepStrictEqual(maiorMediaDoPacote(['9-dentes-reta', 'TAF-PRO-220v'], mediaDe), { media: 181.8, sku: 'TAF-PRO-220v' }, 'o item grande tinha que definir o frete do pacote');
assert.deepStrictEqual(maiorMediaDoPacote(['TAF-PRO-220v', '9-dentes-reta'], mediaDe), { media: 181.8, sku: 'TAF-PRO-220v' }, 'a ordem dos itens mudou o resultado');
assert.deepStrictEqual(maiorMediaDoPacote(['KP22', 'KP18'], mediaDe), { media: 30, sku: 'KP18' }, 'empate tem que ficar com o 1º em ordem alfabética (determinístico)');
assert.deepStrictEqual(maiorMediaDoPacote(['9-dentes-reta', 'SEM-BANCO'], mediaDe), { media: 17.95, sku: '9-dentes-reta' }, 'item sem banco não pode zerar o que tem');
assert.strictEqual(maiorMediaDoPacote(['SEM-1', 'SEM-2'], mediaDe), null, 'sem banco nenhum tinha que devolver null (segue pra tabela)');
assert.strictEqual(maiorMediaDoPacote([], mediaDe), null);

(async () => {
  /* a função de produção da venda do dia, com o banco de mentira do caso real */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfp-'));
  fs.writeFileSync(path.join(dir, '_magalu_frete_sku.json'), JSON.stringify(banco));
  const rj = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
  const p = require('../lib/checkout/magalu-frete').criar({ CACHE_DIR: dir, readJson: rj, writeJson: () => {}, blingGet: async () => null, resolverProdutoPorSku: async () => null });
  assert.strictEqual(await p.magaluFreteProvisorio({ it: [{ sku: '9-dentes-reta' }, { sku: 'TAF-PRO-220v' }] }), 181.8, 'a venda do dia previu o frete do item pequeno (o caso do pedido 124275)');
  assert.strictEqual(await p.magaluFreteProvisorio({ it: [{ sku: 'TAF-PRO-220v' }, { sku: '9-dentes-reta' }] }), 181.8, 'a ordem dos itens mudou a previsão da venda do dia');
  assert.strictEqual(await p.magaluFreteProvisorio({ it: [{ sku: '9-dentes-reta' }] }), 17.95, 'pedido de um item só tinha que continuar com a média dele');
  fs.rmSync(dir, { recursive: true, force: true });
  /* os outros três lugares usam a regra única e não ficou o laço antigo */
  for (const [arq, desc] of [['lib/checkout/historico.js', 'o leitor do histórico'], ['lib/checkout/magalu-caca.js', 'a caça da Magalu'], ['girassol-backup-offline/gbo-app.js', 'o backfill'], ['lib/checkout/magalu-frete.js', 'a venda do dia']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(/magalu-frete-pacote'\)\.maiorMediaDoPacote\(/.test(s), desc + ' (' + arq + ') não usa a regra única do frete do pacote');
    assert.ok(!/Number\(b\.media\); if \(m > 0\) \{ _(sp|pacotePrev) = m; break; \}/.test(s) && !/const fp = _bancoDe\(it\.s0, resolve\(it\.s0\)\);/.test(s), desc + ' (' + arq + ') ainda tem o laço antigo do "1º SKU com banco"');
  }
  console.log('ok — frete previsto do pacote da Magalu: a maior média entre os itens (o caso do pedido 124275 dá R$ 181,80), nos quatro lugares');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
