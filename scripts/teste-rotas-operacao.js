'use strict';
/* 14/11 — AS ROTAS DA OPERAÇÃO LIGADAS POR UMA PEÇA SÓ (lib/checkout/rotas-operacao.js) — Fase 3, item 5 do plano:
   "o `routes` virar montagem", 1º passo.

   Cada empresa escrevia à mão, dentro do `routes` dela, a ligação das cinco peças de rota da operação (contagem de
   estoque, separação, backfill, NF anexada, conferido): cinco blocos `require(...).criar({ … })` e cinco chamadas. Iguais
   nas três a menos do prefixo da URL, da pasta, da env do depósito e do id. Agora a ligação é a peça, e o que é da
   empresa sai da configuração dela (lib/checkout/config-empresa).

   A PROVA DE QUE NADA MUDOU, pras três: os blocos de antes estão em scripts/fixtures/rotas-operacao-antes-*.js.txt
   (tirados da main sem tocar no texto). Aqui rodam o bloco de ANTES e a ligação de HOJE — o trecho VIVO do arquivo de
   cada empresa + a peça de PRODUÇÃO + a configuração de PRODUÇÃO (scripts/_rotas-operacao-ligacao.js; só as cinco peças
   de rota são dublês, que anotam o que receberam) — e exige:
     1. cada peça de rota recebe a MESMA coisa, chave por chave, vinda da mesma peça do arquivo da empresa;
     2. as cinco são chamadas na MESMA ordem, com os MESMOS argumentos, e param na primeira que atende;
     3. a opção do Full (FULL_VAI_DESPACHADOS) segue o destino configurado na empresa, ligada ou desligada.
   E mais:
     4. as cinco peças de rota DE VERDADE aceitam o que a peça entrega (nenhuma reclama de chave faltando);
     5. peça esquecida derruba o BOOT dizendo o nome dela (antes era ReferenceError no boot; numa lista viraria
        `undefined` calado, estourando só na 1ª requisição);
     6. empresa NOVA: prefixo, pasta, env do depósito e id saem da convenção, sem escrever nada. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const L = require('./_rotas-operacao-ligacao');

const EMPRESAS = {
  girassol: { arq: 'girassol-backup-offline/gbo-app.js', modulo: 'girassol-backup-offline', env: 'GIRABKP_DEPOSITO_GERAL', id: 'girassol' },
  amb:      { arq: 'amb-checkout-offline/index.js',      modulo: 'amb-checkout-offline',     env: 'AMBBKP_DEPOSITO_GERAL',  id: 'amb' },
  good:     { arq: 'good-checkout-offline/index.js',     modulo: 'good-checkout-offline',    env: 'GOODBKP_DEPOSITO_GERAL', id: 'good' },
};
const fixture = (emp) => fs.readFileSync(path.join(__dirname, 'fixtures', 'rotas-operacao-antes-' + emp + '.js.txt'), 'utf8');
const NUM_CHAVES = { 'rotas-contagem': 20, 'rotas-separacao': 16, 'rotas-backfill': 12, 'rotas-nf-anexar': 17, 'rotas-conferido': 19 };

(async () => {
  for (const [emp, E] of Object.entries(EMPRESAS)) {
    const antes = await L.deAntes(fixture(emp));
    const agora = await L.daEmpresa(E.arq);

    /* a fixture é mesmo o bloco de antes (não um arquivo vazio que "bate" com qualquer coisa) */
    for (const n of L.PECAS) {
      assert.ok(antes.recebe[n], emp + ': a fixture de antes não cria a peça ' + n);
      assert.strictEqual(Object.keys(antes.recebe[n]).length, NUM_CHAVES[n], emp + ': a fixture de antes da peça ' + n + ' não tem as chaves que tinha');
    }
    assert.strictEqual(antes.recebe['rotas-contagem'].prefixo, '/' + E.modulo);

    /* 1) cada peça de rota recebe o MESMO de antes */
    for (const n of L.PECAS) {
      assert.ok(agora.recebe[n], emp + ': a ligação de hoje não cria a peça ' + n);
      assert.deepStrictEqual(agora.recebe[n], antes.recebe[n], emp + ': a peça ' + n + ' NÃO recebe o que recebia do bloco escrito à mão');
    }
    /* …e, dito por extenso, o que é DA EMPRESA (o que antes era texto no arquivo dela e agora sai da configuração) */
    for (const n of L.PECAS) assert.strictEqual(agora.recebe[n].prefixo, '/' + E.modulo, emp + ': prefixo errado em ' + n);
    assert.deepStrictEqual(agora.recebe['rotas-contagem'].empresa, { pasta: E.modulo, envDeposito: E.env }, emp + ': a contagem não recebe a pasta e a env do depósito DELA');
    assert.strictEqual(agora.recebe['rotas-nf-anexar'].empresaId, E.id, emp + ': o id da empresa na NF anexada mudou');
    /* o estado vivo é o do arquivo da empresa, pela mesma referência (a sentinela diz QUAL peça chegou) */
    assert.strictEqual(agora.recebe['rotas-backfill'].statusValores, '«_bf»');
    assert.strictEqual(agora.recebe['rotas-backfill'].statusDetalhes, '«_bfd»');
    assert.strictEqual(agora.recebe['rotas-nf-anexar'].statusMlSync, '«_mls»');
    assert.strictEqual(agora.recebe['rotas-backfill'].dorme, '«sleep»');
    assert.strictEqual(agora.recebe['rotas-contagem'].marca, "«require('./painel-marca')»", emp + ': a tela da contagem não recebe a marca do painel desta empresa');
    assert.strictEqual(agora.recebe['rotas-separacao'].tag, '«base.tag»');
    /* a contagem não ganha outra porta de escrita além da que aplica a entrada (e, com ela, vêm quem pode e o depósito) */
    const cc = agora.recebe['rotas-contagem'];
    assert.ok(cc.blingWrite === '«blingWrite»' && cc.ehAdmin === '«ehAdmin»' && cc.lerAdmins === '«lerAdmins»' && cc.empresa.envDeposito, emp + ': a contagem recebe a escrita sem quem pode aplicar / sem o depósito');
    assert.ok(!Object.keys(cc).some((k) => /blingPost|blingPut|blingPatch/.test(k)), emp + ': a contagem recebeu outra porta de escrita');

    /* 2) as chamadas: mesma ordem, mesmos argumentos, para na primeira que atende */
    const ORDEM = ['rotas-contagem', 'rotas-separacao', 'rotas-backfill', 'rotas-nf-anexar', 'rotas-conferido'];
    const BASE = ['«req»', '«res»', '«urlObj»', '«method»'];
    {
      const a = await antes.chamar({}), g = await agora.chamar({});
      assert.deepStrictEqual(g, a, emp + ': as chamadas (ninguém atende) não são as de antes');
      assert.strictEqual(g.tratou, false, emp + ': ninguém atendeu e a peça disse que tratou');
      assert.deepStrictEqual(g.chamadas.map((c) => c[0]), ORDEM, emp + ': a ordem das cinco mudou');
      assert.deepStrictEqual(g.chamadas.map((c) => c[1]), [BASE, BASE, BASE.concat('«validarSessao»'), BASE.concat('«validarSessao»'), BASE.concat('«validarSessao»')],
        emp + ': os argumentos das chamadas mudaram (backfill, NF anexada e conferido recebem o validarSessao)');
    }
    for (let i = 0; i < ORDEM.length; i++) {
      const resp = { [ORDEM[i]]: true };
      const a = await antes.chamar(resp), g = await agora.chamar(resp);
      assert.deepStrictEqual(g, a, emp + ': com ' + ORDEM[i] + ' atendendo, as chamadas não são as de antes');
      assert.strictEqual(g.tratou, true, emp + ': ' + ORDEM[i] + ' atendeu e a peça disse que não tratou');
      assert.deepStrictEqual(g.chamadas.map((c) => c[0]), ORDEM.slice(0, i + 1), emp + ': depois de ' + ORDEM[i] + ' atender, as seguintes não podem ser chamadas');
    }

    /* 3) a opção do Full segue o destino configurado na empresa — ligada e desligada, como antes */
    for (const [sit, esperado] of [[745123, true], [0, false]]) {
      const a2 = await L.deAntes(fixture(emp), { sitDespachados: sit }), g2 = await L.daEmpresa(E.arq, { sitDespachados: sit });
      assert.strictEqual(a2.recebe['rotas-conferido'].FULL_VAI_DESPACHADOS, esperado);
      assert.strictEqual(g2.recebe['rotas-conferido'].FULL_VAI_DESPACHADOS, esperado, emp + ': com o destino ' + sit + ' a opção do Full não é ' + esperado);
      assert.strictEqual(g2.recebe['rotas-conferido'].fullJaDespachado, '«fullJaDespachado»');
    }

    /* o arquivo da empresa não tem mais a ligação escrita à mão, e chama a peça UMA vez */
    const src = fs.readFileSync(path.join(L.RAIZ, E.arq), 'utf8');
    for (const n of L.PECAS) assert.ok(!src.includes("require('../lib/checkout/" + n + "')"), emp + ': a ligação escrita à mão de ' + n + ' voltou pro arquivo da empresa');
    assert.strictEqual(src.split('if (await _rotasOperacao(req, res, urlObj, method)) return true;').length - 1, 1, emp + ': a peça tem que ser chamada exatamente uma vez no tratador');
  }

  /* 4) as cinco peças de rota DE VERDADE aceitam o que a peça entrega */
  const { criar, PECAS } = require('../lib/checkout/rotas-operacao');
  const fn = () => {};
  const completo = () => {
    const P = {};
    for (const n of PECAS) P[n] = fn;
    return Object.assign(P, { tag: 'T', marca: {}, PAUSA_MS: 0, VERSAO: 'v', CACHE_DIR: '/tmp/x', locCache: {}, RESERVAS_FILE: '/tmp/r', LOC_LOG_FILE: '/tmp/l',
      CONFERIDOS_FILE: '/tmp/c', MANIFEST_FILE: '/tmp/m', SHOPEE_ENV_COOKIE: 'X', SIT_VERIFICADO: 0, SYNC_ON: false,
      statusValores: {}, statusDetalhes: {}, statusMlSync: {}, FULL_VAI_DESPACHADOS: false });
  };
  for (const emp of Object.keys(EMPRESAS)) {
    const h = criar(emp, completo());
    assert.strictEqual(typeof h, 'function', emp + ': a peça não devolveu o tratador');
    /* caminho de outra empresa / que não é de nenhuma das cinco: ninguém atende */
    const res = { c: 0 };
    assert.strictEqual(await h({ method: 'GET', headers: {} }, res, new URL('http://h/outra-coisa/qualquer'), 'GET'), false);
    assert.strictEqual(res.c, 0);
  }

  /* 5) peça esquecida derruba o boot com o nome dela — cada uma das que o arquivo da empresa entrega */
  for (const n of PECAS) {
    const P = completo(); delete P[n];
    assert.throws(() => criar('amb', P), (e) => e.message.includes('rotas-operacao') && e.message.includes('ambtotal') && new RegExp('falta a peça ' + n + '$').test(e.message),
      'faltando `' + n + '`, o boot tinha que cair dizendo o nome');
  }
  assert.throws(() => criar('amb', undefined), /falta a peça/);
  /* valor "falso" é valor (SYNC_ON desligado, destino 0, opção do Full desligada): não é peça faltando */
  assert.doesNotThrow(() => criar('amb', completo()));
  assert.throws(() => criar('empresa-que-nao-existe', completo()), /desconhecida/);

  /* 6) empresa NOVA (registro de mentira, como em scripts/teste-config-empresa-checkout.js): só a convenção */
  {
    const k = L.PECAS.map((n) => require.resolve(path.join(L.RAIZ, 'lib', 'checkout', n + '.js')));
    const salvos = k.map((x) => require.cache[x]);
    const recebeu = {};
    try {
      L.PECAS.forEach((n, i) => { require.cache[k[i]] = { id: k[i], filename: k[i], loaded: true, exports: { criar: (cfg) => { recebeu[n] = cfg; return async () => false; } } }; });
      const regNova = { normalizar: (x) => x, obter: (id) => (id === 'nova' ? { id: 'nova', prefixoEnv: 'NOVA_' } : null) };
      criar('nova', completo(), { registro: regNova });
    } finally {
      k.forEach((x, i) => { if (salvos[i]) require.cache[x] = salvos[i]; else delete require.cache[x]; });
    }
    for (const n of L.PECAS) assert.strictEqual(recebeu[n].prefixo, '/nova-checkout-offline', 'empresa nova: prefixo fora da convenção em ' + n);
    assert.deepStrictEqual(recebeu['rotas-contagem'].empresa, { pasta: 'nova-checkout-offline', envDeposito: 'NOVABKP_DEPOSITO_GERAL' }, 'empresa nova: pasta/env do depósito fora da convenção');
    assert.strictEqual(recebeu['rotas-nf-anexar'].empresaId, 'nova');
  }

  console.log('ok — rotas da operação: uma ligação pras três; cada peça de rota recebe o que recebia do bloco escrito à mão (chave por chave), na mesma ordem e com os mesmos argumentos; peça esquecida derruba o boot pelo nome; empresa nova sai da convenção');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
