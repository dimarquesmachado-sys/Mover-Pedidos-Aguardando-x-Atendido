'use strict';
/* 20/10 — pedidos com a etiqueta liberada no ML ficaram no AGUARDANDO. A trava do F1/F2 ("já em execução — pulando") não
   soltava nunca se uma rodada ficasse presa numa chamada sem resposta (e a consulta ao ML não tinha prazo). Prova:
   1) a trava ÚNICA (lib/fiscal/trava-fluxos): rodada concorrente é pulada; presa além do limite, a nova roda mesmo assim
      e a velha, ao terminar tarde, NÃO solta a trava da nova; erro fica registrado e sobe; o estado anota contagens e a
      amostra do que foi decidido de cada pedido;
   2) a API do ML (peça de produção) põe prazo em toda consulta que não traz o próprio sinal;
   3) as duas versões do F1/F2 (lib = AMB/GOOD e a da Girassol) usam a trava única e anotam a decisão de cada pedido;
      as empresas entregam o estado e o Mover-Pedidos o mostra em /diagnostico/fluxos. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarTravaFluxos } = require('../lib/fiscal/trava-fluxos');

let _fim = false;
process.on('beforeExit', () => { if (!_fim) { console.error('FALHOU: o teste terminou sem chegar ao fim'); process.exitCode = 1; } });
(async () => {
  // 1) a trava
  let t = 1000000; const tr = criarTravaFluxos('T', { agoraFn: () => t });
  const log = console.log, warn = console.warn; console.log = () => {}; console.warn = () => {};
  let soltarVelha; const velha = tr.comGuard('F2', () => new Promise(r => { soltarVelha = r; }));   // rodada que "pendura"
  let rodou = 0;
  await tr.comGuard('F2', async () => { rodou++; });
  assert.strictEqual(rodou, 0, 'rodada concorrente não foi pulada'); assert.strictEqual(tr.estado().F2.pulados, 1);
  t += 31 * 60000;   // passou do limite (30 min)
  let soltarNova; const nova = tr.comGuard('F2', () => new Promise(r => { soltarNova = r; }));
  await new Promise(r => setImmediate(r));
  assert.strictEqual(tr.estado().F2.liberacoesForcadas, 1, 'presa além do limite e a nova não rodou');
  soltarVelha(); await velha;   // a velha termina tarde…
  assert.strictEqual(tr.estado().F2.rodando, true, 'a rodada velha, ao terminar tarde, soltou a trava da nova');
  await tr.comGuard('F2', async () => { rodou++; });
  assert.strictEqual(rodou, 0, 'com a nova rodando, a seguinte tinha que ser pulada');
  soltarNova(); await nova;
  assert.strictEqual(tr.estado().F2.rodando, false);
  await assert.rejects(tr.comGuard('F1', async () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(tr.estado().F1.ultimoErro, 'boom', 'o erro não ficou registrado');
  await tr.comGuard('F2', async () => { tr.anotar('F2', { encontrados: 3 }); tr.decidiu('F2', { id: 1, decisao: 'mover pro ATENDIDO' }); });
  const e = tr.estado().F2;
  assert.ok(e.ultimo.encontrados === 3 && e.amostra.length === 1 && e.ultimoFim && e.rodadas >= 3, 'o estado não anotou a rodada: ' + JSON.stringify(e));
  console.log = log; console.warn = warn;

  // 2) a API do ML: prazo em toda consulta sem sinal próprio
  const vistos = [];
  require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (u, o) => { vistos.push(o || {}); return { ok: true, status: 200, json: async () => ({ status: 'ready_to_ship', substatus: 'ready_to_print', shipping: { id: 9 } }), text: async () => '{}' }; } };
  delete require.cache[require.resolve('../lib/fiscal/ml-api')];
  const api = require('../lib/fiscal/ml-api').criarMlApi({ rotulo: 'T' });
  await api.getShipmentSubstatus('tk', 9);
  assert.strictEqual(vistos[0].timeout, 20000, 'a consulta do envio no ML saiu sem prazo');
  await api.getShipmentInfo('tk', '2000', { signal: { aborted: false, addEventListener() {} } });
  assert.ok(vistos[1].signal && vistos[1].timeout == null, 'com sinal próprio, o prazo não pode ser trocado');

  // 3) as duas versões usam a trava única e anotam; as empresas entregam o estado; a rota existe
  for (const [onde, arq] of [['lib (AMB/GOOD)', 'lib/fiscal/fluxos-pedidos.js'], ['Girassol', 'girassol/fluxos.js']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(/criarTravaFluxos\(/.test(s) && /const comGuard = _trava\.comGuard;/.test(s), onde + ': não usa a trava única');
    assert.ok(!/const _rodando = \{ F1: false, F2: false \};/.test(s), onde + ': sobrou a trava antiga (que nunca soltava)');
    assert.ok(/_trava\.decidiu\('F2', \{ id: p\.id, numero: p\.numero, flex: isFlex/.test(s), onde + ': o F2 não anota a decisão de cada pedido');
    assert.ok(/_trava\.decidiu\('F2', \{ id: p\.id, numero: p\.numero, loja: p\.loja && p\.loja\.id, decisao: 'loja fora do Mercado Envios' \}/.test(s), onde + ': o F2 não anota quem ele descarta pela loja');
    assert.ok(/_trava\.anotar\('F2', \{ semTokenML:/.test(s), onde + ': o F2 não anota quando fica sem token do ML');
    assert.ok(/estadoFluxos: \(\) => _trava\.estado\(\)/.test(s), onde + ': não exporta o estado');
  }
  assert.ok(/estadoFluxos/.test(fs.readFileSync(path.join(raiz, 'girassol', 'index.js'), 'utf8')), 'a Girassol não entrega o estado');
  assert.ok(/estadoFluxos: fluxos\.estadoFluxos/.test(fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'montar-empresa.js'), 'utf8')), 'AMB/GOOD não entregam o estado');
  assert.ok(/if \(path === '\/diagnostico\/fluxos'\) \{/.test(fs.readFileSync(path.join(raiz, 'index.js'), 'utf8')), 'a rota /diagnostico/fluxos não existe');
  _fim = true;
  console.log('ok — F1/F2: trava única que solta a rodada presa, prazo nas consultas ao ML e o estado de cada rodada em /diagnostico/fluxos (as três empresas)');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
