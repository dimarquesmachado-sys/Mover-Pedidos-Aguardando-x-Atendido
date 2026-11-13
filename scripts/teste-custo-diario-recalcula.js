'use strict';
/* 13/11 — CUSTO QUE MUDA NO BLING RECALCULA AS VENDAS JÁ GRAVADAS (rotina de custo das 23h, lib/checkout/custo-diario).
   O dono prefere corrigir o custo no Bling. A rotina relia o custo e abria a faixa nova a partir do dia da mudança, mas as
   vendas daquele dia que já estavam no histórico ficavam com o custo antigo (o Mês/Ano mostrava o número velho até alguém
   lançar o custo à mão). Prova, com a rotina DE VERDADE e um ambiente de mentira:
   · custo de um SKU mudou nesta rodada → pede o recálculo das vendas DESSE SKU desde o dia em que a faixa nova começa;
   · SKU cujo custo não mudou → nada; SKU que ganhou a 1ª faixa → recalcula (as vendas dele estavam sem custo);
   · mudança demais de uma vez (semente, reajuste em massa) → NÃO pede SKU a SKU, e diz isso no estado;
   · empresa que não passa as duas peças → a rotina segue como sempre; falha ao pedir não derruba a rotina;
   · a fila é UMA por empresa (o "lançar custo" e a rotina dividem a mesma); as três empresas ligam as duas peças. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const criar = require('../lib/checkout/custo-diario').criar;

function ambiente(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custo-diario-rec-'));
  const CUSTO_FILE = path.join(dir, '_custos.json');
  fs.writeFileSync(CUSTO_FILE, JSON.stringify({ _sementeCompleta: 1, KC6: { id: 6, custo: 147, ts: 1 }, CM1: { id: 1, custo: 120, ts: 1 }, QUIETO: { id: 9, custo: 10, ts: 1 } }));
  const vig = o.vigencias || { KC6: [{ custo: 147, de: '2026-09-16', ate: null, origem: 'bling' }], CM1: [{ custo: 120, de: '2026-08-01', ate: null, origem: 'bling' }], QUIETO: [{ custo: 10, de: '2026-01-01', ate: null, origem: 'bling' }] };
  const pedidos = [];
  const _cst = { rodando: false, falhas: 0, inicio: null };
  const deps = {
    CUSTO_FILE, empresa: 'teste',
    readJson: (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } },
    escrever: (p, x) => fs.writeFileSync(p, JSON.stringify(x)),
    estadoSync: () => _cst,
    /* a sincronização de mentira: é ela que, relendo o Bling, abre as faixas novas (o.aoSincronizar mexe em `vig`) */
    custoSync: async () => { _cst.inicio = Date.now() + Math.random(); if (o.aoSincronizar) o.aoSincronizar(vig); },
    blingGet: async () => ({ ok: true, data: { data: (o.alterados || [{ codigo: 'CM1' }]) } }),
    registrarCustoVigente: () => {}, lerVigenciaDe: () => null, gravarVigenciaDe: () => {},
  };
  if (!o.semPecas) { deps.lerVigencias = () => vig; deps.pedirRecalculo = (sku, dia) => { if (o.pedirFalha) throw new Error('fila caiu'); pedidos.push([sku, dia]); }; }
  return { api: criar(deps), pedidos, vig };
}
const HOJE = '2026-11-12';

(async () => {
  /* o custo do CM1 mudou no Bling hoje: a sincronização fecha a faixa antiga e abre a nova a partir de hoje */
  let e = ambiente({ aoSincronizar: (v) => { v.CM1[0].ate = '2026-11-11'; v.CM1.push({ custo: 102.59, de: HOJE, ate: null, origem: 'bling' }); } });
  await e.api.custoDiario(HOJE);
  assert.deepStrictEqual(e.pedidos, [['CM1', HOJE]], 'só o SKU cujo custo mudou tem o recálculo pedido, desde o dia em que a faixa nova começa: ' + JSON.stringify(e.pedidos));
  assert.ok(e.api.estado().custos_mudados === 1 && /recálculo das vendas pedido pra 1 SKU/.test(e.api.estado().recalculo), JSON.stringify(e.api.estado()));
  /* mudança achada na RECUPERAÇÃO (a faixa nasce datada de ontem): o recálculo é desde ontem */
  e = ambiente({ aoSincronizar: (v) => { v.KC6[0].ate = '2026-11-10'; v.KC6.push({ custo: 126.65, de: '2026-11-11', ate: null, origem: 'bling' }); } });
  await e.api.custoDiario('2026-11-11');
  assert.deepStrictEqual(e.pedidos, [['KC6', '2026-11-11']]);
  /* nada mudou de custo: nada pedido */
  e = ambiente({}); await e.api.custoDiario(HOJE);
  assert.ok(e.pedidos.length === 0 && e.api.estado().custos_mudados === 0 && !e.api.estado().recalculo, JSON.stringify(e.api.estado()));
  /* SKU novo (ganhou a 1ª faixa hoje): as vendas dele estavam sem custo → recalcula também */
  e = ambiente({ aoSincronizar: (v) => { v.NOVO = [{ custo: 30, de: HOJE, ate: null, origem: 'bling' }]; } });
  await e.api.custoDiario(HOJE);
  assert.deepStrictEqual(e.pedidos, [['NOVO', HOJE]]);
  /* mudança em massa (mais que o teto): não pede SKU a SKU, e diz isso */
  e = ambiente({ aoSincronizar: (v) => { for (let i = 0; i < 301; i++) v['M' + i] = [{ custo: 5, de: HOJE, ate: null, origem: 'bling' }]; } });
  await e.api.custoDiario(HOJE);
  assert.ok(e.pedidos.length === 0 && e.api.estado().custos_mudados === 301 && /não recalculei SKU a SKU/.test(e.api.estado().recalculo), JSON.stringify(e.api.estado()));
  /* no limite do teto ainda pede */
  e = ambiente({ aoSincronizar: (v) => { for (let i = 0; i < 300; i++) v['M' + i] = [{ custo: 5, de: HOJE, ate: null, origem: 'bling' }]; } });
  await e.api.custoDiario(HOJE); assert.strictEqual(e.pedidos.length, 300);
  /* empresa que não passa as peças: tudo como sempre; e a fila caindo não derruba a rotina (o dia fecha) */
  e = ambiente({ semPecas: true, aoSincronizar: (v) => { v.CM1.push({ custo: 1, de: HOJE, ate: null }); } });
  await e.api.custoDiario(HOJE); assert.ok(!e.api.estado().erro && e.api.estado().custos_mudados === undefined);
  e = ambiente({ pedirFalha: true, aoSincronizar: (v) => { v.CM1.push({ custo: 1, de: HOJE, ate: null }); } });
  await e.api.custoDiario(HOJE); assert.ok(!e.api.estado().erro && e.api.estado().terminou, 'a fila falhando não pode derrubar a rotina: ' + JSON.stringify(e.api.estado()));

  /* ── uma fila por empresa ── */
  const R = require('../lib/checkout/custo-recalculo');
  const cfg = (emp, marca) => ({ empresa: emp, hoje: () => HOJE, reaplicar: async () => { marca.n = (marca.n || 0) + 1; return { msg: 'concluído', linhas: 0, atualizadas: 0, erros: 0 }; } });
  const mA = {}, mB = {}, mC = {};
  const f1 = R.daEmpresa(cfg('fila-x', mA)), f2 = R.daEmpresa(cfg('fila-x', mB)), f3 = R.daEmpresa(cfg('fila-y', mC));
  assert.ok(f1 === f2 && f1 !== f3, 'a mesma empresa recebe a MESMA fila; outra empresa, outra');
  f2.pedir('KC6', HOJE); await f1.terminar();
  assert.ok(mA.n === 1 && !mB.n, 'quem chegou primeiro montou a fila; o segundo usa a que existe');
  assert.throws(() => R.daEmpresa({ reaplicar: async () => ({}), hoje: () => HOJE }), /falta empresa/);
  /* ── a ligação: as rotas comuns e as três empresas usam a fila da empresa ── */
  const rc = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
  assert.ok(/require\('\.\/custo-recalculo'\)\.daEmpresa\(\{ reaplicar: \(de, ate, emp, opts\) => reaplicarCusto\(de, ate, emp, opts\), empresa: EMPRESA,/.test(rc), 'o "lançar custo" tem que usar a fila da empresa');
  for (const [arq, emp] of [['amb-checkout-offline/index.js', 'amb'], ['girassol-backup-offline/gbo-app.js', 'girassol'], ['good-checkout-offline/index.js', 'good']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const i = s.indexOf("require('../lib/checkout/custo-diario').criar({"), bloco = s.slice(i, s.indexOf('\n});', i));
    assert.ok(/lerVigencias: \(\) => lerVigencias\(\),/.test(bloco) && new RegExp("pedirRecalculo: \\(sku, dia\\) => require\\('\\.\\./lib/checkout/custo-recalculo'\\)\\.daEmpresa\\(\\{ empresa: '" + emp + "', reaplicar: \\(de, ate, emp, opts\\) => reaplicarCusto\\(de, ate, emp, opts\\),").test(bloco), arq + ': a rotina das 23h não liga a foto dos custos e o pedido de recálculo (com a empresa ' + emp + ')');
    assert.ok(new RegExp("empresa: '" + emp + "'").test(bloco.split('pedirRecalculo')[0]) && new RegExp("tag: '[A-Z]+', empresa: '" + emp + "',").test(s), arq + ': a empresa da fila tem que ser a mesma das rotas comuns');
  }
  console.log('ok — custo que muda no Bling recalcula as vendas já gravadas desde o dia da mudança (só o SKU que mudou; em massa, não), pela fila única da empresa, nas três');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
