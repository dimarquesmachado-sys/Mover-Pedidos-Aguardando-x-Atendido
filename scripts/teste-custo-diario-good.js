'use strict';
/* 14/10 — a GOOD ganha o custo diário (a mesma peça da Girassol e da AMB, lib/checkout/custo-diario.js,
   que tem teste próprio). Aqui a prova é da LIGAÇÃO, por execução: monta o módulo da GOOD, chama a rota
   /custo-diario (com chave errada de propósito, pra não disparar a rotina) e exige a recusa de chave —
   antes a rota respondia que faltava a peça; confere que o custo diário é agendado (16/11: pelo relógio
   das três, lib/checkout/agendador, no minuto da GOOD — não mais por cron do orquestrador); e que a
   vigência retroativa chega ao registro de custo, como na Girassol. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.GOODBKP_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cdg-'));
process.env.ADMIN_KEY = 'chave-certa';
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('rede não era pra ser chamada'); } };

(async () => {
  const mod = require(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'));
  const handler = mod.routes(async () => ({}));
  /* chave CERTA, mas com a trava pesada do processo segura pelo teste: a rota passa por todas as
     checagens de peça e de chave e para no 409 "rotina pesada em curso" — sem disparar nada */
  const trava = require('../lib/checkout/trava-pesada');
  assert.ok(trava.tentarEntrar('teste-custo-diario-good'), 'não consegui segurar a trava pesada pro teste');
  const u = new URL('http://x/good-checkout-offline/custo-diario?k=chave-certa');
  const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
  try { await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); } finally { trava.sair('teste-custo-diario-good'); }
  assert.ok(!/falta|semPeca|não expõe|nao expoe/i.test(res._b), 'a rota /custo-diario da GOOD ainda diz que falta a peça: ' + res._b.slice(0, 160));
  assert.strictEqual(res._s, 409, 'com a peça montada e a trava ocupada, a rota tem que recusar com 409 — veio ' + res._s + ' ' + res._b.slice(0, 160));
  assert.ok(/teste-custo-diario-good/.test(res._b), 'o 409 tem que nomear quem segura a trava: ' + res._b.slice(0, 160));
  /* 16/11 (montarCheckout, passo 7): o custo diário da GOOD é agendado pelo RELÓGIO das três (lib/checkout/agendador, minuto 30:
     23h30 em diante e a recuperação até as 6h) — os dois crons do orquestrador saíram (agendar pelos dois rodaria em dobro) */
  for (const k of ['custoDiario', 'custoDiarioRecupera']) assert.ok(!(mod.crons || {})[k] && !(mod.rotinas || {})[k], 'sobrou o cron ' + k + ' da GOOD (o relógio do agendador já agenda o custo diário)');
  { const srcG = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8'); const k = srcG.indexOf("const bootstrap = require('../lib/checkout/agendador').criarAgendador({");
    const b = srcG.slice(k, srcG.indexOf('\n});', k));
    assert.ok(k > 0 && /\n  empresa: 'good',/.test(b) && /\n  minutoCustoDiario: 30,/.test(b) && /custoDiario: \(\.\.\.a\) => custoDiario\(\.\.\.a\),/.test(b), 'o relógio da GOOD tem que chamar o custo diário dela, às 23h30'); }
  /* e o relógio de verdade, com o minuto da GOOD: 23h20 não roda, 23h35 e 3h roda */
  { const { criarAgendador } = require('../lib/checkout/agendador'); const ints = []; let rodou = 0;
    const nada = async () => {};
    criarAgendador({ empresa: 'good', minutoCustoDiario: 30, plano: { motor: { tocar: nada }, criarPlano: () => null, existe: () => true }, mlSyncFees: nada, custoSync: nada, custoDiario: async () => { rodou++; }, varrerCancelados: nada, mlBillingSync: nada, vendasSync: nada, rodarCiclo: nada, log: () => {}, setTimeout: () => 0, setInterval: (fn, ms) => { ints.push({ fn, ms }); return 0; } })();
    const tick = ints.find((x) => x.ms === 60000); const RealDate = Date;
    for (const [h, m, deve] of [[23, 20, 0], [23, 35, 1], [3, 0, 1], [14, 0, 0]]) { rodou = 0; global.Date = class extends RealDate { getHours() { return h; } getMinutes() { return m; } }; try { tick.fn(); } finally { global.Date = RealDate; } assert.strictEqual(rodou, deve, 'GOOD às ' + h + 'h' + m + ': custo diário ' + (deve ? '' : 'NÃO ') + 'devia rodar'); } }
  const src = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');
  /* 16/11 (passo 5): o registro de custo vem da peça lib/checkout/custo-empresa, que liga a vigência retroativa (`_vigenciaDeRef.valor`) — a GOOD
     desestrutura os dois nomes dela; a peça em si é provada em scripts/teste-custo-empresa.js */
  assert.ok(/registrarCustoVigente:\s+\(sku, v, org\) => _custoLib\.registrarCustoVigente\(_ctxCusto, sku, v, org, _vigenciaDeRef\.valor\)/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'custo-empresa.js'), 'utf8')), 'a vigência retroativa da madrugada não chega ao registro de custo (peça custo-empresa)');
  /* 16/11 (passo 6): a vigência é lida e gravada pelas rotinas de custo da empresa (lib/checkout/rotinas-custo-empresa), no
     `_vigenciaDeRef` da peça de custo DESTA empresa — a GOOD entrega a peça dela às rotinas */
  const rot = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'rotinas-custo-empresa.js'), 'utf8');
  assert.ok(/require\('\.\.\/lib\/checkout\/custo-empresa'\)\.criar\(\{ empresa: 'good',/.test(src) && /get custoEmpresa\(\) \{ return _custoEmp; \}/.test(src)
    && /lerVigenciaDe: \(\) => CE\(\)\._vigenciaDeRef\.valor,/.test(rot) && /gravarVigenciaDe: \(v\) => \{ CE\(\)\._vigenciaDeRef\.valor = v; \},/.test(rot) && /registrarCustoVigente: \(\.\.\.a\) => CE\(\)\.registrarCustoVigente\(\.\.\.a\),/.test(rot), 'a GOOD tem que montar a peça do custo e usar o registro e a vigência dela');
  assert.ok(/require\('\.\.\/lib\/checkout\/rotinas-custo-empresa'\)\.criar\(\{\s*empresa: 'good'/.test(src) && /require\('\.\/custo-diario'\)\.criar\(\{\s*empresa,/.test(rot), 'o custo diário da GOOD tem que ser a peça compartilhada');
  console.log('ok — custo diário ligado na GOOD (rota responde, agendado pelo relógio das três às 23h30 sem cron em dobro, vigência retroativa)');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
