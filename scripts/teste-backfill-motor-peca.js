'use strict';
/* 13/11 — O MOTOR DO HISTÓRICO DE VENDAS saiu do arquivo da Girassol pra peça (lib/checkout/backfill-motor.js; plano
   multiloja, Fase 3 item 5). O `backfillVendas` já era um só pras três (a AMB e a GOOD o chamam com o contexto delas), mas
   morava em 790 linhas do arquivo da Girassol. Mover NÃO é reescrever. Prova:
   1) o CORPO da peça é o que estava no arquivo — byte a byte, desfeitas as trocas registradas (os módulos vizinhos, que
      mudaram de caminho relativo porque o corpo mudou de pasta, e o token padrão do ML, que virou peça);
   2) todo `require` relativo da peça RESOLVE de verdade (o corpo carregava módulos por caminho relativo ao arquivo antigo —
      na pasta nova apontariam pro lugar errado e só estourariam com o servidor rodando);
   3) o arquivo da Girassol monta a peça entregando TODAS as peças por acessor, o nome `backfillVendas` continua existindo
      (função declarada) e exportado, e o corpo antigo saiu; a AMB e a GOOD seguem chamando o motor por ele;
   4) a peça de verdade: recusa montagem incompleta, não lê nada na montagem, e lê o que é da empresa A CADA rodada — as
      travas do começo (reparo de SKU, canário, caça da Magalu, backfill já rodando) respondem "adiado" sem tocar em
      rede nem banco, com os PADRÕES de quem montou; e quem chama com `ctx` manda no que é dele. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const arqPeca = path.join(raiz, 'lib', 'checkout', 'backfill-motor.js');
const pecaSrc = fs.readFileSync(arqPeca, 'utf8');
const antes = fs.readFileSync(path.join(__dirname, 'fixtures', 'backfill-motor-corpo-antes.txt'), 'utf8');
const { criar, PECAS } = require('../lib/checkout/backfill-motor');

/* 1) o corpo */
const cab = pecaSrc.indexOf('  return async function backfillVendas(de, ate, empresa, ctx){\n'); assert.ok(cab > 0);
const iniCorpo = pecaSrc.indexOf(' } = G;\n', cab) + ' } = G;\n'.length;
let corpo = pecaSrc.slice(iniCorpo, pecaSrc.lastIndexOf('};\n}\n\nmodule.exports'));
const TROCAS = [   /* [na peça, como era no arquivo da Girassol, quantas vezes] */
  ["require('./backfill-deps')", "require('../lib/checkout/backfill-deps')", 1],
  ["require('./troca-periodo-historico')", "require('../lib/checkout/troca-periodo-historico')", 2],
  ["require('./config-empresa')", "require('../lib/checkout/config-empresa')", 1],
  ["require('./magalu-frete-pacote')", "require('../lib/checkout/magalu-frete-pacote')", 1],
  ["require('./repasse-pendente')", "require('../lib/checkout/repasse-pendente')", 1],
  ['    garantirTokenML: () => G.garantirTokenML(),', "    garantirTokenML: () => require('../girassol/mlTokenManager').garantirTokenML(),", 1],
];
for (const [nova, velha, n] of TROCAS) { assert.strictEqual(corpo.split(nova).length - 1, n, 'troca registrada não está na peça (' + n + 'x): ' + nova); corpo = corpo.split(nova).join(velha); }
assert.strictEqual(corpo, antes, 'fora das trocas registradas, o corpo do motor tem que ser o que estava no arquivo da Girassol (mover não é reescrever)');
assert.ok(corpo.split('\n').length > 780, 'o corpo do motor encolheu');
/* a desestruturação entrega exatamente as peças que o corpo usa pelo nome (o token padrão é chamado por `G.`) */
const desestr = pecaSrc.slice(pecaSrc.indexOf('    const { ', cab) + '    const { '.length, iniCorpo - ' } = G;\n'.length).split(', ');
assert.deepStrictEqual(desestr.slice().sort(), PECAS.filter((n) => n !== 'garantirTokenML').sort(), 'a peça tem que ler, a cada rodada, tudo o que declara precisar');

/* 2) todo require relativo resolve — e nada no corpo depende da PASTA do arquivo */
const reqs = Array.from(new Set(Array.from(pecaSrc.matchAll(/require\('(\.[^']+)'\)/g)).map((m) => m[1])));
assert.ok(reqs.length >= 5, 'cadê os módulos vizinhos?');
for (const r of reqs) { let ok = true; try { require.resolve(path.resolve(path.dirname(arqPeca), r)); } catch (e) { ok = false; } assert.ok(ok, 'a peça carrega um módulo que não existe neste caminho: ' + r); }
assert.ok(!/require\('\.\.\/lib\//.test(pecaSrc), 'sobrou um require com o caminho de quando o corpo morava na pasta da Girassol');
assert.ok(!/__dirname|__filename|process\.cwd\(/.test(corpo), 'o corpo não pode depender da pasta onde o arquivo está');
assert.ok(!/require\('\.\.\/\.\.\/girassol|require\('\.\.\/girassol/.test(pecaSrc), 'a peça não pode carregar módulo da pasta de uma empresa');

/* 3) a Girassol monta; a AMB e a GOOD seguem usando o motor por ela */
const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
const iM = gbo.indexOf("require('../lib/checkout/backfill-motor').criar({"); assert.ok(iM > 0, 'a Girassol não monta o motor');
const bloco = gbo.slice(iM, gbo.indexOf('\n});', iM));
for (const n of PECAS) assert.ok(n === 'garantirTokenML' ? /garantirTokenML: \(\) => require\('\.\.\/girassol\/mlTokenManager'\)\.garantirTokenML\(\),/.test(bloco) : bloco.includes('  get ' + n + '() { return ' + n + '; },'), 'girassol-backup-offline/gbo-app.js: não entrega ' + n + ' ao motor');
assert.ok(/\nasync function backfillVendas\(de, ate, empresa, ctx\)\{ return _backfillMotorPeca\(de, ate, empresa, ctx\); \}/.test(gbo), '`backfillVendas` tem que continuar existindo, como função declarada (o arquivo a usa antes desta linha)');
assert.ok(gbo.split('\n').length < 2000 && !gbo.includes("const _D = require('../lib/checkout/backfill-deps').resolverDepsBackfill(empresa, _ctx, {"), 'sobrou o corpo antigo do motor no arquivo da Girassol');
for (const arq of ['amb-checkout-offline/index.js', 'good-checkout-offline/index.js']) assert.ok(/backfillVendas/.test(fs.readFileSync(path.join(raiz, arq), 'utf8')), arq + ': deixou de chamar o motor?');

/* 3b) o apoio dos testes antigos (scripts/_gbo-com-motor.js): devolve o arquivo da Girassol com o motor NO LUGAR, tirado da peça
   viva — é por ele que os testes que conferiam o texto do motor "no arquivo da Girassol" continuam olhando o código de hoje */
{ const apoio = require('./_gbo-com-motor');
  const t = apoio.texto();
  assert.ok(t.includes('async function backfillVendas(de, ate, empresa, ctx){\n' + antes + '}') && !t.includes('_backfillMotorPeca'), 'o apoio tem que devolver o arquivo com a função inteira no lugar da montagem');
  assert.strictEqual(apoio.corpoComoEra(), antes, 'o corpo que o apoio entrega tem que ser o da peça viva, com os caminhos de quando morava na Girassol');
  assert.strictEqual(t.length, gbo.length - (gbo.indexOf('async function backfillVendas(de, ate, empresa, ctx){ return _backfillMotorPeca(de, ate, empresa, ctx); }') + 'async function backfillVendas(de, ate, empresa, ctx){ return _backfillMotorPeca(de, ate, empresa, ctx); }'.length - gbo.indexOf('/* 13/11 (plano multiloja, Fase 3 item 5): o MOTOR do histórico de vendas saiu deste arquivo')) + ('async function backfillVendas(de, ate, empresa, ctx){\n' + antes + '}').length, 'o apoio só pode trocar a montagem pela função — nada mais do arquivo'); }

/* 4) a peça de verdade */
(async () => {
  assert.throws(() => criar(), /falta o que é da empresa/);
  assert.throws(() => criar({}), /falta /);
  const lidos = []; const valores = {};
  const G = {};
  for (const n of PECAS) Object.defineProperty(G, n, { enumerable: true, get() { lidos.push(n); return valores[n]; } });
  const estado = { rodando: false };
  Object.assign(valores, { _estadoBackfill: () => estado, DEFAULT_ALIQ_BK: {}, _reparoAtivo: true, _canario: { rodando: false }, _cacaMgGir: { estado: () => ({ rodando: false }), magaluLinhas: async () => [] },
    _mlBilling: { aplicarCreditosFlexNaFila: async () => ({}) }, _mapasBilling: async () => ({}), garantirTokenML: async () => 't', LOJA_MKT: {} });
  const motor = criar(G);
  assert.strictEqual(lidos.length, 0, 'montar a peça não pode LER as peças da empresa (a ordem do arquivo dela não pode importar)');
  const logAntes = console.log; console.log = () => {};
  try {
    /* reparo de SKU ligado (o padrão de quem montou): adia, sem rede nem banco */
    let r = await motor('2026-11-01', '2026-11-02', 'girassol');
    assert.ok(r && r.ok === false && r.desfecho === 'adiado' && /reparo de SKU/.test(r.adiado), JSON.stringify(r));
    assert.ok(lidos.includes('_reparoAtivo') && lidos.includes('_estadoBackfill'), 'a rodada tinha que ler as peças na hora');
    /* a empresa desligou o reparo e o canário entrou: a MESMA peça montada vê os valores novos na rodada seguinte */
    valores._reparoAtivo = false; valores._canario = { rodando: true, desde: 'agora' };
    r = await motor('2026-11-01', '2026-11-02', 'girassol');
    assert.ok(r.ok === false && r.desfecho === 'adiado' && /can.rio/.test(r.msg), 'a segunda rodada tinha que ler as peças DE NOVO: ' + JSON.stringify(r));
    /* caça da Magalu gravando: adia */
    valores._canario = { rodando: false }; valores._cacaMgGir = { estado: () => ({ rodando: true }), magaluLinhas: async () => [] };
    r = await motor('2026-11-01', '2026-11-02', 'girassol');
    assert.ok(r.ok === false && /Magalu/.test(r.msg), JSON.stringify(r));
    /* já tem um backfill desta empresa rodando: não começa outro */
    valores._cacaMgGir = { estado: () => ({ rodando: false }), magaluLinhas: async () => [] }; estado.rodando = true; estado.empresa = 'girassol';
    r = await motor('2026-11-01', '2026-11-02', 'girassol');
    assert.ok(r.ok === false && r.desfecho === 'ja_rodando', JSON.stringify(r));
    /* quem chama COM contexto manda no que é dele: o reparo e o canário são os DELE, não os de quem montou */
    estado.rodando = false; valores._reparoAtivo = true; valores._canario = { rodando: true };
    r = await motor('2026-11-01', '2026-11-02', 'amb', { reparoAtivo: () => false, canarioRodando: () => false, cacaMagaluRodando: () => true });
    assert.ok(r.ok === false && /Magalu/.test(r.msg) && !/reparo|can.rio/.test(JSON.stringify(r)), 'com contexto, valem as travas de quem chamou: ' + JSON.stringify(r));
  } finally { console.log = logAntes; }
  console.log('ok — motor do histórico de vendas em peça: o corpo é o de antes (byte a byte), todo módulo vizinho resolve, a Girassol monta com as peças dela e as travas respondem com os valores da rodada');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
