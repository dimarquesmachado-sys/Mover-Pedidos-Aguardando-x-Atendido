'use strict';
/* 11/11 (plano multiloja, Fase 3 item 5) — A SINCRONIZAÇÃO DE CUSTO VIROU PEÇA ÚNICA (lib/checkout/custo-sync.js).
   O `custoSync` era igual, linha a linha, no arquivo da Girassol e no da AMB (236 linhas; só o nome da empresa mudava).
   Prova:
   1) o corpo da peça é BYTE A BYTE o que os dois arquivos tinham (guardado em scripts/fixtures) — mover não é reescrever;
   2) Girassol e AMB não têm mais o corpo: montam a peça com a empresa certa e entregam TODAS as peças que ela pede, por
      acessor (lidas a cada rodada), e `custoSync` continua existindo com o mesmo nome (quem chama não muda);
   3) a peça recusa montagem sem empresa ou sem alguma peça — dizendo qual; e lê o que é da empresa A CADA RODADA (não na
      montagem): rodando duas vezes com a peça trocada no meio, a segunda rodada usa a nova;
   4) a rodada usa a EMPRESA da montagem pra falar com o banco (o nome não fica escrito à mão). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const pecaSrc = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'custo-sync.js'), 'utf8');
const antes = fs.readFileSync(path.join(__dirname, 'fixtures', 'custo-sync-corpo-antes.txt'), 'utf8');
const { criar, PECAS } = require('../lib/checkout/custo-sync');

/* 1) o corpo */
const ini = pecaSrc.indexOf('    const { ' + PECAS.join(', ') + ' } = G;\n');
assert.ok(ini > 0, 'a peça tem que ler o que é da empresa a cada rodada (desestruturando DENTRO da função)');
const corpo = pecaSrc.slice(ini + ('    const { ' + PECAS.join(', ') + ' } = G;\n').length, pecaSrc.lastIndexOf('};\n}\n\nmodule.exports'));
assert.strictEqual(corpo, antes.replace(/^\n/, ''), 'o corpo da peça não é mais o que a Girassol e a AMB tinham (mover não é reescrever)');
assert.ok(!/'girassol'|'amb'|eq\.girassol|eq\.amb/.test(corpo) && /supaCfg\(EMPRESA\)/.test(corpo) && /empresa=eq\.' \+ EMPRESA \+ '&data_venda/.test(corpo), 'o nome da empresa não pode ficar escrito à mão no corpo');

/* 2) as duas empresas */
for (const [arq, emp] of [['girassol-backup-offline/gbo-app.js', 'girassol'], ['amb-checkout-offline/index.js', 'amb']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = s.indexOf("require('../lib/checkout/custo-sync').criar({"); assert.ok(i > 0, arq + ': não monta a peça do custo');
  const bloco = s.slice(i, s.indexOf('});', i));
  assert.ok(new RegExp("empresa: '" + emp + "',").test(bloco), arq + ': tem que montar com a empresa DELA');
  for (const n of PECAS) assert.ok(bloco.includes('get ' + n + '() { return ' + n + '; }'), arq + ': não entrega ' + n + ' à peça (por acessor)');
  assert.ok(/async function custoSync\(fresh\) \{ return _custoSyncPeca\(fresh\); \}/.test(s), arq + ': `custoSync` tem que continuar existindo com o mesmo nome');
  assert.ok(!s.includes("const CUSTO_FILE = path.join(CACHE_DIR, '_custos.json');\n  /* 23/08") && s.split('[CUSTO] sync concluiu').length === 1, arq + ': sobrou o corpo antigo do custoSync');
}

/* 3) e 4) a peça de verdade, com peças de mentira */
(async () => {
  assert.throws(() => criar({}), /falta empresa/);
  assert.throws(() => criar({ empresa: 'x' }), /falta CACHE_DIR/);
  const vistos = [];
  let cst = { rodando: true };   /* "já tem uma rodada": a função sai na primeira linha — sem rede nem disco */
  const G = { empresa: 'quarta' };
  for (const n of PECAS) Object.defineProperty(G, n, { enumerable: true, get() { vistos.push(n); return n === '_cst' ? cst : undefined; } });
  const fn = criar(G);
  assert.strictEqual(vistos.length, 0, 'montar a peça não pode LER as peças da empresa (a ordem do arquivo dela não pode importar)');
  await fn(false);
  assert.ok(vistos.includes('_cst') && vistos.includes('blingGet'), 'a rodada tinha que ler as peças na hora');
  const n1 = vistos.length; cst = { rodando: true, trocado: 1 }; await fn(false);
  assert.ok(vistos.length === n1 * 2, 'a segunda rodada tinha que ler as peças DE NOVO (nada de valor guardado da primeira)');
  console.log('ok — custo-sync em peça única: o corpo é o de antes (byte a byte), Girassol e AMB montam com a empresa e as peças delas, e a peça lê o que é da empresa a cada rodada');
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
