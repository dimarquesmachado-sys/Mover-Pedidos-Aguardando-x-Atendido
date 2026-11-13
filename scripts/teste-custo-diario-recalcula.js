'use strict';
/* 13/11 — CUSTO QUE MUDA NO BLING RECALCULA AS VENDAS JÁ GRAVADAS (rotina de custo das 23h, lib/checkout/custo-diario).
   O dono prefere corrigir o custo no Bling. A rotina relia o custo e abria a faixa nova, mas as vendas já gravadas no
   histórico ficavam com o custo antigo (o Mês/Ano mostrava o número velho até alguém lançar o custo à mão).
   Prova, com a rotina DE VERDADE e um ambiente de mentira — o desenho fechado depois da revisão do Codex no #861:
   · custo mudou nesta rodada → recalcula as vendas DESSE SKU desde o dia da faixa nova; nada mudou → nada;
   · mudança que a sincronização das 6h registrou ANTES das 23h também é vista (a base é a foto gravada);
   · duas mudanças em dias diferentes entre duas rodadas → recalcula desde a MAIS ANTIGA; faixa trocada no lugar → desde
     o começo dela; SKU novo → desde a 1ª faixa;
   · a mudança só é dada por aplicada quando a fila CONFIRMA o recálculo com sucesso: falhou, ou o servidor reiniciou e a
     fila esqueceu → é pedida de novo na rodada seguinte;
   · teto por rodada: o que passa fica pendente e sai na rodada seguinte; a semente (1ª vez, milhares de SKUs) não enfileira;
   · a foto mora em arquivo próprio (não engorda o de custos); empresa sem as peças segue como sempre; fila caindo não
     derruba a rotina nem perde a pendência;
   · a fila é UMA por empresa, e as três empresas ligam as três peças. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const criar = require('../lib/checkout/custo-diario').criar;

const D = (n) => '2026-11-' + String(n).padStart(2, '0');
function ambiente(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custo-diario-rec-'));
  const CUSTO_FILE = path.join(dir, '_custos.json'), FOTO = path.join(dir, '_custo-diario-foto.json');
  fs.writeFileSync(CUSTO_FILE, JSON.stringify({ _sementeCompleta: 1, CM1: { id: 1, custo: 120, ts: 1 }, QUIETO: { id: 9, custo: 10, ts: 1 } }));
  const vig = o.vigencias || { CM1: [{ custo: 120, de: '2026-08-01', ate: null, origem: 'bling' }], QUIETO: [{ custo: 10, de: '2026-01-01', ate: null, origem: 'bling' }] };
  const pedidos = [], fila = {};   /* fila[sku] = o que a fila diz que fez por último */
  const _cst = { rodando: false, falhas: 0, inicio: null };
  const amb = { pedidos, vig, fila, arquivo: CUSTO_FILE, FOTO, aoSincronizar: o.aoSincronizar || null, pedirFalha: !!o.pedirFalha,
    foto: () => JSON.parse(fs.readFileSync(FOTO, 'utf8')), gravarFoto: (j) => fs.writeFileSync(FOTO, JSON.stringify(j)) };
  const deps = {
    CUSTO_FILE, empresa: 'teste', esperaRepedirMs: o.esperaRepedirMs == null ? 0 : o.esperaRepedirMs,   /* nos testes as rodadas são coladas: sem espera, salvo onde ela é o assunto */
    readJson: (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } },
    escrever: (p, x) => fs.writeFileSync(p, JSON.stringify(x)),
    estadoSync: () => _cst,
    custoSync: async () => { _cst.inicio = Date.now() + Math.random(); if (amb.aoSincronizar) amb.aoSincronizar(vig); },   /* é a sincronização que abre as faixas */
    blingGet: async () => ({ ok: true, data: { data: [{ codigo: 'CM1' }] } }),
    registrarCustoVigente: () => {}, lerVigenciaDe: () => null, gravarVigenciaDe: () => {},
  };
  if (!o.semPecas) {
    deps.lerVigencias = () => vig;
    deps.pedirRecalculo = (sku, dia) => { if (amb.pedirFalha) throw new Error('fila caiu'); pedidos.push([sku, dia]); };
    if (!o.semConfirmacao) deps.estadoRecalculo = (sku) => ({ ultimo: fila[sku] || null });
  }
  amb.api = criar(deps);
  amb.rodar = async (dia) => { pedidos.length = 0; await amb.api.custoDiario(dia); return amb.api.estado(); };
  return amb;
}
const novaFaixa = (v, sku, custo, de) => { const l = v[sku]; const dAnt = new Date(de + 'T12:00:00Z'); dAnt.setUTCDate(dAnt.getUTCDate() - 1); l[l.length - 1].ate = dAnt.toISOString().slice(0, 10); l.push({ custo, de, ate: null, origem: 'bling' }); };
const okDepois = (de) => ({ ok: true, de, fim: new Date(Date.now() + 60000).toISOString() });

(async () => {
  /* 1) o custo do CM1 mudou no Bling hoje (a própria rodada o relê): recálculo só dele, desde o dia da faixa nova */
  let e = ambiente({ aoSincronizar: (v) => novaFaixa(v, 'CM1', 102.59, D(12)) });
  let st = await e.rodar(D(12));
  assert.deepStrictEqual(e.pedidos, [['CM1', D(12)]], 'só o SKU cujo custo mudou, desde o dia em que a faixa nova começa: ' + JSON.stringify(e.pedidos));
  assert.ok(st.custos_mudados === 1 && /pedido pra 1 SKU/.test(st.recalculo) && st.recalculo_pendentes === 1, JSON.stringify(st));
  assert.ok(e.foto().foto.CM1 === D(12) + '|102.59' && e.foto().pendentes.CM1.de === D(12) && e.foto().pendentes.CM1.pedido_em, 'a foto anda e a mudança fica PENDENTE até a fila confirmar: ' + JSON.stringify(e.foto()));
  assert.ok(!('_custoDiarioFoto' in JSON.parse(fs.readFileSync(e.arquivo, 'utf8'))), 'a foto não pode ir pra dentro do arquivo de custos');
  /* 2) a fila confirmou (recalculou bem, depois do pedido): na rodada seguinte a pendência sai e nada é pedido de novo */
  e.aoSincronizar = null; e.fila.CM1 = okDepois(D(12));
  st = await e.rodar(D(13));
  assert.ok(e.pedidos.length === 0 && st.custos_mudados === 0 && Object.keys(e.foto().pendentes).length === 0, 'recálculo confirmado: a pendência sai: ' + JSON.stringify([e.pedidos, e.foto().pendentes]));

  /* 3) Codex #861: o recálculo FALHOU em fundo (banco fora) — a mudança não pode ser dada por aplicada: pede de novo */
  e = ambiente({ aoSincronizar: (v) => novaFaixa(v, 'CM1', 102.59, D(12)) });
  await e.rodar(D(12)); e.aoSincronizar = null;
  e.fila.CM1 = { ok: false, de: D(12), msg: 'banco fora', fim: new Date(Date.now() + 60000).toISOString() };
  await e.rodar(D(13));
  assert.deepStrictEqual(e.pedidos, [['CM1', D(12)]], 'recálculo que falhou tem que ser pedido de novo na rodada seguinte: ' + JSON.stringify(e.pedidos));
  /* …e se o servidor reiniciou e a fila não lembra de nada: pede de novo também */
  delete e.fila.CM1; await e.rodar(D(14));
  assert.deepStrictEqual(e.pedidos, [['CM1', D(12)]], 'fila que esqueceu (reinício) = não confirmado');
  /* um sucesso ANTIGO (anterior ao pedido) ou que começou DEPOIS da data pedida não confirma */
  e.fila.CM1 = { ok: true, de: D(12), fim: '2026-01-01T00:00:00.000Z' }; await e.rodar(D(15)); assert.strictEqual(e.pedidos.length, 1, 'sucesso de antes do pedido não vale');
  e.fila.CM1 = okDepois(D(13)); await e.rodar(D(16)); assert.strictEqual(e.pedidos.length, 1, 'recálculo que começou depois da data pedida não cobre a pendência');
  e.fila.CM1 = okDepois(D(11)); await e.rodar(D(17)); assert.ok(e.pedidos.length === 0 && !e.foto().pendentes.CM1, 'recálculo que cobre a data (começou antes) confirma');

  /* a rotina é chamada de minuto em minuto enquanto a releitura não fecha: pendência pedida HÁ POUCO espera a confirmação em
     vez de ser pedida de novo a cada tique (o recálculo do tique anterior ainda está rodando) */
  e = ambiente({ esperaRepedirMs: 6 * 3600000, aoSincronizar: (v) => novaFaixa(v, 'CM1', 102.59, D(12)) });
  await e.rodar(D(12)); assert.strictEqual(e.pedidos.length, 1); e.aoSincronizar = null;
  st = await e.rodar(D(13));
  assert.ok(e.pedidos.length === 0 && e.foto().pendentes.CM1 && /esperando a fila confirmar/.test(st.recalculo), 'pedido de agora há pouco não é repetido — e a pendência continua lá: ' + JSON.stringify([e.pedidos, st]));
  const fotoVelha = e.foto(); fotoVelha.pendentes.CM1.pedido_em = new Date(Date.now() - 7 * 3600000).toISOString(); e.gravarFoto(fotoVelha);
  await e.rodar(D(14)); assert.strictEqual(e.pedidos.length, 1, 'passado o prazo sem confirmação, pede de novo');

  /* 4) Codex #861: a sincronização das 6h JÁ registrou a mudança antes das 23h — a base é a foto gravada da rodada anterior */
  e = ambiente({ vigencias: { CM1: [{ custo: 120, de: '2026-08-01', ate: D(11), origem: 'bling' }, { custo: 102.59, de: D(12), ate: null, origem: 'bling' }], QUIETO: [{ custo: 10, de: '2026-01-01', ate: null, origem: 'bling' }] } });
  e.gravarFoto({ foto: { CM1: '2026-08-01|120', QUIETO: '2026-01-01|10' }, pendentes: {} });
  await e.rodar(D(12));
  assert.deepStrictEqual(e.pedidos, [['CM1', D(12)]], 'mudança registrada antes da rotina tinha que ser recalculada: ' + JSON.stringify(e.pedidos));

  /* 5) Codex #861: DUAS mudanças em dias diferentes desde a foto (10 → 20 em 11/11 → 30 em 12/11): desde a MAIS ANTIGA */
  e = ambiente({ vigencias: { CM1: [{ custo: 10, de: '2026-08-01', ate: D(10) }, { custo: 20, de: D(11), ate: D(11) }, { custo: 30, de: D(12), ate: null }] } });
  e.gravarFoto({ foto: { CM1: '2026-08-01|10' }, pendentes: {} });
  await e.rodar(D(12));
  assert.deepStrictEqual(e.pedidos, [['CM1', D(11)]], 'com duas mudanças, o recálculo é desde a primeira (11/11), não só desde a última: ' + JSON.stringify(e.pedidos));
  /* faixa da foto trocada NO LUGAR (mesmo dia, outro custo): desde o começo dela */
  e = ambiente({ vigencias: { CM1: [{ custo: 99, de: D(5), ate: null }] } });
  e.gravarFoto({ foto: { CM1: D(5) + '|120' }, pendentes: {} });
  await e.rodar(D(12)); assert.deepStrictEqual(e.pedidos, [['CM1', D(5)]]);
  /* pendência antiga + mudança nova do mesmo SKU: fica a data MAIS ANTIGA */
  e = ambiente({ vigencias: { CM1: [{ custo: 10, de: '2026-08-01', ate: D(11) }, { custo: 30, de: D(12), ate: null }] } });
  e.gravarFoto({ foto: { CM1: '2026-08-01|10' }, pendentes: { CM1: { de: D(3), pedido_em: null } } });
  await e.rodar(D(12)); assert.deepStrictEqual(e.pedidos, [['CM1', D(3)]]);

  /* 6) nada mudou: nada pedido; SKU novo: desde a 1ª faixa dele */
  e = ambiente({}); st = await e.rodar(D(12));
  assert.ok(e.pedidos.length === 0 && st.custos_mudados === 0 && !st.recalculo, JSON.stringify(st));
  e = ambiente({ aoSincronizar: (v) => { v.NOVO = [{ custo: 30, de: D(12), ate: null }]; } });
  await e.rodar(D(12)); assert.deepStrictEqual(e.pedidos, [['NOVO', D(12)]]);

  /* 7) teto por rodada: com foto gravada e 301 mudanças, 300 saem agora e 1 fica pendente pra próxima — nenhuma se perde */
  e = ambiente({ aoSincronizar: (v) => { for (let i = 0; i < 301; i++) v['M' + String(i).padStart(3, '0')] = [{ custo: 5, de: D(12), ate: null }]; } });
  e.gravarFoto({ foto: { CM1: '2026-08-01|120', QUIETO: '2026-01-01|10' }, pendentes: {} });
  st = await e.rodar(D(12));
  assert.ok(e.pedidos.length === 300 && st.recalculo_pendentes === 301 && /1 ficaram pra próxima rodada/.test(st.recalculo), JSON.stringify([e.pedidos.length, st]));
  e.aoSincronizar = null; for (const [sku] of e.pedidos.slice()) e.fila[sku] = okDepois(D(12));
  st = await e.rodar(D(13));
  assert.ok(e.pedidos.length === 1 && st.recalculo_pendentes === 1, 'na rodada seguinte saem as confirmadas e é pedida a que tinha ficado: ' + JSON.stringify([e.pedidos, st]));
  /* a SEMENTE (1ª vez, sem foto, mudança demais): não enfileira nada, só guarda a foto */
  e = ambiente({ aoSincronizar: (v) => { for (let i = 0; i < 301; i++) v['S' + i] = [{ custo: 5, de: D(12), ate: null }]; } });
  st = await e.rodar(D(12));
  assert.ok(e.pedidos.length === 0 && /semente/.test(st.recalculo) && Object.keys(e.foto().pendentes).length === 0 && Object.keys(e.foto().foto).length === 303, JSON.stringify(st));

  /* 8) sem as peças: como sempre. Fila caindo: a rotina termina e a pendência NÃO se perde. Sem confirmação: baixa no pedido */
  e = ambiente({ semPecas: true, aoSincronizar: (v) => novaFaixa(v, 'CM1', 1, D(12)) });
  st = await e.rodar(D(12)); assert.ok(!st.erro && st.custos_mudados === undefined && !fs.existsSync(e.FOTO));
  e = ambiente({ pedirFalha: true, aoSincronizar: (v) => novaFaixa(v, 'CM1', 1, D(12)) });
  st = await e.rodar(D(12));
  assert.ok(!st.erro && st.terminou && e.foto().pendentes.CM1 && e.foto().pendentes.CM1.pedido_em === null && /não entraram na fila/.test(st.recalculo), 'a fila falhando não derruba a rotina nem perde a pendência: ' + JSON.stringify([st, e.foto().pendentes]));
  e.pedirFalha = false; e.aoSincronizar = null; await e.rodar(D(13)); assert.deepStrictEqual(e.pedidos, [['CM1', D(12)]], 'e na rodada seguinte ela é pedida');
  e = ambiente({ semConfirmacao: true, aoSincronizar: (v) => novaFaixa(v, 'CM1', 1, D(12)) });
  await e.rodar(D(12)); assert.ok(e.pedidos.length === 1 && Object.keys(e.foto().pendentes).length === 0, 'sem como confirmar, a pendência sai quando o pedido entra na fila');

  /* ── uma fila por empresa ── */
  const R = require('../lib/checkout/custo-recalculo');
  const cfg = (emp, marca) => ({ empresa: emp, hoje: () => D(12), reaplicar: async () => { marca.n = (marca.n || 0) + 1; return { msg: 'concluído', linhas: 0, atualizadas: 0, erros: 0 }; } });
  const mA = {}, mB = {}, mC = {};
  const f1 = R.daEmpresa(cfg('fila-x', mA)), f2 = R.daEmpresa(cfg('fila-x', mB)), f3 = R.daEmpresa(cfg('fila-y', mC));
  assert.ok(f1 === f2 && f1 !== f3, 'a mesma empresa recebe a MESMA fila; outra empresa, outra');
  f2.pedir('KC6', D(12)); await f1.terminar();
  assert.ok(mA.n === 1 && !mB.n && f1.estado('KC6').ultimo.ok === true && f1.estado('KC6').ultimo.de === D(12) && f1.estado('KC6').ultimo.fim, 'a fila de verdade devolve o que a rotina usa pra confirmar (ok, de, fim): ' + JSON.stringify(f1.estado('KC6')));
  assert.throws(() => R.daEmpresa({ reaplicar: async () => ({}), hoje: () => D(12) }), /falta empresa/);
  /* ── a ligação: as rotas comuns e as três empresas usam a fila da empresa, com as três peças ── */
  const rc = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
  assert.ok(/require\('\.\/custo-recalculo'\)\.daEmpresa\(\{ reaplicar: \(de, ate, emp, opts\) => reaplicarCusto\(de, ate, emp, opts\), empresa: EMPRESA,/.test(rc), 'o "lançar custo" tem que usar a fila da empresa');
  for (const [arq, emp] of [['amb-checkout-offline/index.js', 'amb'], ['girassol-backup-offline/gbo-app.js', 'girassol'], ['good-checkout-offline/index.js', 'good']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const i = s.indexOf("require('../lib/checkout/custo-diario').criar({"), bloco = s.slice(i, s.indexOf('\n});', i));
    assert.ok(/lerVigencias: \(\) => lerVigencias\(\),/.test(bloco) && /pedirRecalculo: \(sku, dia\) => _filaRecalculoCusto\(\)\.pedir\(sku, dia\),/.test(bloco) && /estadoRecalculo: \(sku\) => _filaRecalculoCusto\(\)\.estado\(sku\),/.test(bloco), arq + ': a rotina das 23h não liga a foto, o pedido e a confirmação do recálculo');
    assert.ok(new RegExp("const _filaRecalculoCusto = \\(\\) => require\\('\\.\\./lib/checkout/custo-recalculo'\\)\\.daEmpresa\\(\\{ empresa: '" + emp + "', reaplicar: \\(de, ate, emp, opts\\) => reaplicarCusto\\(de, ate, emp, opts\\),").test(s) && new RegExp("tag: '[A-Z]+', empresa: '" + emp + "',").test(s), arq + ': a fila tem que ser a da empresa ' + emp + ' (a mesma das rotas comuns)');
  }
  console.log('ok — custo que muda no Bling recalcula as vendas já gravadas: desde a mudança mais antiga, só dado por aplicado quando a fila confirma, com teto por rodada — pela fila única da empresa, nas três');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
