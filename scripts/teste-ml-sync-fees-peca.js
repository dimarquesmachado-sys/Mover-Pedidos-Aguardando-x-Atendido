'use strict';
/* 13/11 — A PESCA DAS TARIFAS DO MERCADO LIVRE em peça única (lib/checkout/ml-sync-fees.js; plano multiloja, Fase 3 item 5).
   O `mlSyncFees` era o mesmo corpo na Girassol e na AMB (133 de 136 linhas de código); mudava o gerente de token, a versão
   do marcador de custos e o texto de dois comentários. Prova:
   1) o CORPO da peça é o que as duas tinham — byte a byte, desfeitas as trocas registradas (o que virou peça entregue por
      quem monta) e, pra AMB, as diferenças que ela já tinha em relação à Girassol;
   2) as duas empresas montam a peça com o token DELAS, a versão DELAS (Girassol: ML_COSTS_V; AMB: 1) e o estado DELAS —
      e o corpo antigo saiu dos arquivos;
   3) a peça de verdade: recusa montagem incompleta; a versão decide quem é relido (com 1, só quem não tem marca — o
      comportamento da AMB; com 2, também quem foi marcado com 1 — o da Girassol); sem token, encerra sem estourar e
      solta o estado; o estado que as rotas leem é o MESMO objeto que a rodada atualiza. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const pecaSrc = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'ml-sync-fees.js'), 'utf8');
const antesGira = fs.readFileSync(path.join(__dirname, 'fixtures', 'ml-sync-fees-corpo-girassol-antes.txt'), 'utf8');
const antesAmb = fs.readFileSync(path.join(__dirname, 'fixtures', 'ml-sync-fees-corpo-amb-antes.txt'), 'utf8');

/* 1) o corpo */
const marca = '    let _mls = G._mls;\n';
const ini = pecaSrc.indexOf(marca); assert.ok(ini > 0, 'a peça tem que ler o estado da empresa a cada rodada');
const corpo = pecaSrc.slice(ini + marca.length, pecaSrc.lastIndexOf('};\n}\n\nmodule.exports'));
/* o que virou peça/opção: [na peça, como era na Girassol] */
const TROCAS = [
  ['Number(c.ml_costs_v3 || 0) < VERSAO_CUSTOS', 'Number(c.ml_costs_v3 || 0) < ML_COSTS_V'],
  ['c2[cid].ml_costs_v3 = VERSAO_CUSTOS;', 'c2[cid].ml_costs_v3 = ML_COSTS_V;'],
  ['  try { tokenML = await G.garantirTokenML(); }', "  try { const { garantirTokenML } = require('../girassol/mlTokenManager'); tokenML = await garantirTokenML(); }"],
  ['amostras: [] }; G._mls = _mls;', 'amostras: [] };'],
];
let comoGirassol = corpo;
for (const [nova, velha] of TROCAS) { assert.strictEqual(comoGirassol.split(nova).length, 2, 'troca registrada não está na peça (uma vez): ' + nova); comoGirassol = comoGirassol.replace(nova, velha); }
assert.strictEqual(comoGirassol, antesGira, 'fora das trocas registradas, o corpo da peça tem que ser o que a Girassol tinha (mover não é reescrever)');
/* a AMB: o mesmo corpo, com as diferenças que ela JÁ tinha — [como era na Girassol, como era na AMB] */
const SO_DA_AMB = [["    return c.tarifa_ml == null || c.venda_em == null || Number(c.ml_costs_v3 || 0) < ML_COSTS_V || c.ml_order == null || t >= recheck;   /* Codex PR#48: marcador versionado */   // ml_order==null: ainda sem o par pack/order — uma passada preenche   // !ml_costs_v2 = ainda nao passou pelo /costs (frete real + estorno) — vale uma passada", "    return c.tarifa_ml == null || c.venda_em == null || !c.ml_costs_v3 || c.ml_order == null || t >= recheck;   // ml_order==null: ainda sem o par pack/order — uma passada preenche   // !ml_costs_v2 = ainda nao passou pelo /costs (frete real + estorno) — vale uma passada"], ["  try { const { garantirTokenML } = require('../girassol/mlTokenManager'); tokenML = await garantirTokenML(); }", "  try { const { garantirTokenML } = require('../ambtotal/mlTokenManager'); tokenML = await garantirTokenML(); }"], ["    for (const [cid, d] of Object.entries(pend)) { if (!c2[cid]) continue; if (d.fee != null) c2[cid].tarifa_ml = d.fee; if (d.frete != null) c2[cid].frete_ml = d.frete; if (d.venda) c2[cid].venda_em = d.venda; if (d.credito != null) c2[cid].credito_ml = d.credito; if (d.credito_fonte) c2[cid].credito_fonte = d.credito_fonte; if (d.logistica) c2[cid].logistica_ml = d.logistica; if (d.pack) c2[cid].ml_pack = d.pack; if (d.order) c2[cid].ml_order = d.order; if (d.costs_ok && d.ship_ok) { c2[cid].ml_costs_v3 = ML_COSTS_V; if (d.credito == null && c2[cid].credito_fonte !== 'billing') delete c2[cid].credito_ml;   /* 25/08: 'costs_gross' NÃO é exceção aqui — ele nasce da própria resposta do /costs, então uma leitura FRESCA e COMPLETA (costs_ok E ship_ok) que diz \"sem crédito\" desmente o valor velho. Protegê-lo seria blindar o dado contra a própria atualização, e o ml_costs_v3 avança logo abaixo: passada a rejanela de 3 dias, o crédito obsoleto pararia de ser reconferido e inflaria a margem pra sempre. Falha ou 429 já são barrados por costs_ok/ship_ok. 'billing' continua exceção: vem do relatório oficial de faturamento, outra fonte. */ /* Codex PR#48: /costs novo manda — resposta fresca com custo do vendedor derruba o gross antigo */ if (d.frete == null) delete c2[cid].frete_ml; } }", "    for (const [cid, d] of Object.entries(pend)) { if (!c2[cid]) continue; if (d.fee != null) c2[cid].tarifa_ml = d.fee; if (d.frete != null) c2[cid].frete_ml = d.frete; if (d.venda) c2[cid].venda_em = d.venda; if (d.credito != null) c2[cid].credito_ml = d.credito; if (d.credito_fonte) c2[cid].credito_fonte = d.credito_fonte; if (d.logistica) c2[cid].logistica_ml = d.logistica; if (d.pack) c2[cid].ml_pack = d.pack; if (d.order) c2[cid].ml_order = d.order; if (d.costs_ok && d.ship_ok) { c2[cid].ml_costs_v3 = 1; if (d.credito == null && c2[cid].credito_fonte !== 'billing') delete c2[cid].credito_ml;   /* 25/08: 'costs_gross' NÃO é exceção aqui — ele nasce da própria resposta do /costs, então uma leitura FRESCA e COMPLETA (costs_ok E ship_ok) que diz \"sem crédito\" desmente o valor velho. Protegê-lo seria blindar o dado contra a própria atualização, e o ml_costs_v3 avança logo abaixo: passada a rejanela de 3 dias, o crédito obsoleto pararia de ser reconferido e inflaria a margem pra sempre. Falha ou 429 já são barrados por costs_ok/ship_ok. 'billing' continua exceção: vem do relatório oficial de faturamento, outra fonte. */ /* Codex PR#40: /costs vazio não apaga crédito do billing */ if (d.frete == null) delete c2[cid].frete_ml; } }"], ["              reg.ship_ok = true;   /* Codex PR#48: /costs sozinho nao prova que sabemos se e Flex */", "              reg.ship_ok = true;   /* 25/08: idem — ver o comentário do outro ponto */"], ["              // 13/08 (porte do b58 da AMB): o bonus do Flex e o gross_amount — ver comentario\n              // na outra copia desta mesma logica (o arquivo tem as duas: pescarDadosML e este\n              // bloco inline do mlSyncFees). Corrigir SEMPRE as duas.", "              // 13/08 — MEDIDO com a rota ml-flex-debug (venda 2000014472881525, entregue):\n              // compensation 0 · compensations [] · sender_cost 0 · base_cost 0 · gross_amount 8,90\n              // = o \"Estorno / Bonus por envio\" da tela. Quando o ML nao manda base_cost, o bruto\n              // do frete E a bonificacao do Flex (o vendedor nao pagou nada: sender_cost 0)."]];
let comoAmb = comoGirassol;
for (const [gira, amb] of SO_DA_AMB) { assert.strictEqual(comoAmb.split(gira).length, 2, 'o trecho que diferia na AMB não está no corpo (uma vez)'); comoAmb = comoAmb.replace(gira, amb); }
assert.strictEqual(comoAmb, antesAmb, 'com as diferenças próprias dela, o corpo tem que ser o que a AMB tinha');
/* e essas diferenças são só: a marca simples (versão 1), o gerente de token dela e o texto de comentários */
{ const semComentario = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const dif = SO_DA_AMB.map(([g, a]) => [semComentario(g).trim(), semComentario(a).trim()]).filter(([g, a]) => g !== a);
  assert.ok(dif.length === 3 && /Number\(c\.ml_costs_v3 \|\| 0\) < ML_COSTS_V/.test(dif[0][0]) && /!c\.ml_costs_v3/.test(dif[0][1]) && /girassol\/mlTokenManager/.test(dif[1][0]) && /ambtotal\/mlTokenManager/.test(dif[1][1]) && /ml_costs_v3 = ML_COSTS_V;/.test(dif[2][0]) && /ml_costs_v3 = 1;/.test(dif[2][1]),
    'a AMB só podia diferir no marcador (1, "não tem marca"), no gerente de token e em comentários: ' + JSON.stringify(dif.map((d) => [d[0].slice(0, 60), d[1].slice(0, 60)]))); }
assert.ok(!/girassol|ambtotal|GIRABKP|AMBBKP|ML_COSTS_V/.test(corpo), 'o corpo não pode citar empresa nem a constante de uma delas');

/* 2) as duas empresas */
const { criar, PECAS } = (() => {
  /* o node-fetch de mentira entra ANTES de carregar a peça */
  require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (u) => { global.__mlFetch.push(String(u)); return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; } };
  global.__mlFetch = [];
  return require('../lib/checkout/ml-sync-fees');
})();
for (const [arq, emp, pasta, versao] of [['girassol-backup-offline/gbo-app.js', 'girassol', 'girassol', 'ML_COSTS_V'], ['amb-checkout-offline/index.js', 'amb', 'ambtotal', '1']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = s.indexOf("require('../lib/checkout/ml-sync-fees').criar({"); assert.ok(i > 0, arq + ': não monta a peça da pesca de tarifas');
  const bloco = s.slice(i, s.indexOf('});', i));
  assert.ok(new RegExp("empresa: '" + emp + "',").test(bloco) && new RegExp('versaoCustos: ' + versao + ',').test(bloco), arq + ': tem que montar com a empresa e a versão do marcador DELA');
  assert.ok(new RegExp("garantirTokenML: \\(\\) => require\\('\\.\\./" + pasta + "/mlTokenManager'\\)\\.garantirTokenML\\(\\),").test(bloco), arq + ': o token do ML tem que ser o DELA (e o require fica dentro da chamada, como era: módulo faltando = "sem token", não erro na montagem)');
  assert.ok(/get _mls\(\) \{ return _mls; \}/.test(bloco) && /set _mls\(v\) \{ _mls = v; \}/.test(bloco), arq + ': o estado da pesca tem que ir e VOLTAR (as rotas de status leem o `_mls` do arquivo)');
  for (const n of ['CONFERIDOS_FILE', 'readJson', 'writeJson']) assert.ok(bloco.includes('get ' + n + '() { return ' + n + '; }'), arq + ': não entrega ' + n);
  assert.ok(/async function mlSyncFees\(dias\) \{ return _mlSyncFeesPeca\(dias\); \}/.test(s), arq + ': `mlSyncFees` tem que continuar existindo com o mesmo nome');
  assert.ok(s.split('[ML-FEES] pescando tarifas de').length === 1 && !/async function mlSyncFees\(dias\) \{\n  dias = /.test(s), arq + ': sobrou o corpo antigo do mlSyncFees');
}
assert.ok(/^const ML_COSTS_V = 2;$/m.test(fs.readFileSync(path.join(raiz, 'girassol-backup-offline/gbo-app.js'), 'utf8')), 'a versão do marcador da Girassol continua 2');

/* 3) a peça de verdade */
(async () => {
  assert.throws(() => criar({}), /falta empresa/);
  assert.throws(() => criar({ empresa: 'x' }), /falta CONFERIDOS_FILE/);
  const tudo = () => ({ empresa: 'x', CONFERIDOS_FILE: '', _mls: {}, garantirTokenML: async () => 't', readJson: () => ({}), writeJson: () => {} });
  assert.throws(() => criar(tudo()), /falta versaoCustos/);
  assert.throws(() => criar(Object.assign(tudo(), { versaoCustos: 0 })), /falta versaoCustos/);

  const agora = new Date().toISOString();
  function ambiente(versao, o) {
    o = o || {};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlfees-')), arq = path.join(dir, 'conferidos.json');
    const ped = (extra) => Object.assign({ conferido_em: new Date(Date.now() - 5 * 86400000).toISOString(), marketplace: 'ml', numero_loja: '2000' + Math.floor(Math.random() * 1e9), tarifa_ml: 10, venda_em: agora, ml_order: '1' }, extra);
    fs.writeFileSync(arq, JSON.stringify({ semMarca: ped({}), marca1: ped({ ml_costs_v3: 1 }), marca2: ped({ ml_costs_v3: 2 }), marcaTrue: ped({ ml_costs_v3: true }),
      outroCanal: ped({ marketplace: 'shopee' }), velho: ped({ conferido_em: new Date(Date.now() - 90 * 86400000).toISOString() }) }));
    let estado = { rodando: false, feitos: 0, total: 0 }; const postos = [];
    const G = { empresa: 'teste', versaoCustos: versao, garantirTokenML: async () => { if (o.semToken) throw new Error('token vencido'); return 'tok'; },
      get _mls() { return estado; }, set _mls(v) { postos.push(v); estado = v; },
      CONFERIDOS_FILE: arq, readJson: (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } }, writeJson: (f, j) => fs.writeFileSync(f, JSON.stringify(j)) };
    const tAntes = global.setTimeout;
    return { fn: criar(G), estado: () => estado, postos, rodar: async function (d) { global.setTimeout = (f, ms) => tAntes(f, ms >= 100 ? 1 : ms); try { return await this.fn(d); } finally { global.setTimeout = tAntes; } } };
  }
  /* versão 1 (a AMB): só quem NÃO tem marca é relido — marca 1, 2 ou `true` ficam como estão */
  let e = ambiente(1); let r = await e.rodar(14);
  assert.strictEqual(e.estado().total, 1, 'com a versão 1, só o pedido sem marca entra (o comportamento da AMB): ' + JSON.stringify(e.estado()));
  /* versão 2 (a Girassol): relê também quem foi marcado com 1 (e `true`, que vale 1) */
  e = ambiente(2); r = await e.rodar(14);
  assert.strictEqual(e.estado().total, 3, 'com a versão 2, entram o sem marca e os marcados com 1 (o comportamento da Girassol): ' + JSON.stringify(e.estado()));
  /* o estado: o que a empresa recebe de volta é o MESMO objeto que a rodada atualiza (as rotas de status veem o andamento) */
  assert.ok(e.postos.length === 1 && e.postos[0] === e.estado() && r === e.estado() && e.estado().rodando === false && e.estado().feitos === 3, 'o estado tem que voltar pra empresa e ser o mesmo objeto do retorno: ' + JSON.stringify([e.postos.length, e.estado()]));
  /* sem token: encerra sem estourar e solta o estado */
  e = ambiente(2, { semToken: true }); r = await e.rodar(14);
  assert.ok(r === e.estado() && e.estado().rodando === false && e.estado().feitos === 0, 'sem token do ML a pesca encerra e NÃO fica marcada como rodando: ' + JSON.stringify(e.estado()));
  /* já rodando: sai na primeira linha, sem tocar em nada */
  e = ambiente(2); const st0 = e.estado(); st0.rodando = true; r = await e.rodar(14);
  assert.ok(r === st0 && e.postos.length === 0, 'com uma pesca em curso, a segunda não começa');
  console.log('ok — pesca de tarifas do ML em peça única: o corpo é o de antes (byte a byte) nas duas, cada empresa monta com o token, a versão do marcador e o estado dela');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
