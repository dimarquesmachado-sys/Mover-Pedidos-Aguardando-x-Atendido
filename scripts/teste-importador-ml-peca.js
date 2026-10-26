'use strict';
/* 25/10 — o IMPORTADOR DO ML (recoloca no Bling a venda que não chegou — o conserto do canário) virou PEÇA ÚNICA
   (lib/importar-pedido-ml): era só da Girassol (girassol/importarPedido.js); a AMB e a GOOD ganham. Prova:
   · EQUIVALÊNCIA da Girassol com o código de antes (fixture), com o ML e o Bling de mentira (fetch e tokens falsos no
     formato real): o DRY-RUN monta o MESMO pedido e faz as MESMAS consultas; o "confirmar" cria igual (contato + pedido);
   · AMB e GOOD: cada uma com os PRÓPRIOS tokens, o intermediador da NF DELA (AMBTOTAL / GIMPO — nunca o da Girassol),
     a variável do canal do ML DELA (sem ela, recusa ANTES de escrever qualquer coisa no Bling);
   · a configuração única liga o importador nas três. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ORDER = { id: 2000012345, date_created: '2026-10-20T10:00:00.000-03:00', pack_id: null, shipping: { id: 445566 }, buyer: { nickname: 'COMPRADOR1' },
  order_items: [{ item: { id: 'MLB111', seller_sku: 'SKU-A', title: 'Produto A' }, quantity: 2, unit_price: 50 }, { item: { id: 'MLB222', seller_sku: 'SKU-X', title: 'Produto X' }, quantity: 1, unit_price: 30 }] };
let log = [];
async function fakeFetch(url, opt) {
  const o = opt || {}; const m = o.method || 'GET';
  log.push(m + ' ' + url.replace(/^https:\/\/[^/]+/, '') + (o.body ? ' ' + o.body : ''));
  const r = (st, b) => ({ status: st, ok: st >= 200 && st < 300, json: async () => b, text: async () => JSON.stringify(b) });
  if (/mercadolibre\.com\/orders\/2000012345\/billing_info/.test(url)) return r(200, { buyer: { billing_info: { doc_number: '12345678909', first_name: 'Maria', last_name: 'Silva' } } });
  if (/mercadolibre\.com\/orders\/2000012345$/.test(url)) return r(200, ORDER);
  if (/mercadolibre\.com\/shipments\/445566/.test(url)) return r(200, { receiver_name: 'Maria Silva', receiver_address: { street_name: 'Rua A', street_number: 10, neighborhood: { name: 'Centro' }, city: { name: 'Osasco' }, state: { id: 'BR-SP' }, zip_code: '06000-000' } });
  if (/bling\.com\.br\/Api\/v3\/produtos\?limite=1/.test(url)) return r(200, { data: [] });
  if (/bling\.com\.br\/Api\/v3\/produtos\?codigo=SKU-A/.test(url)) return r(200, { data: [{ id: 901, codigo: 'SKU-A', unidade: 'UN', nome: 'Produto A' }] });
  if (/bling\.com\.br\/Api\/v3\/produtos\?/.test(url)) return r(200, { data: [] });
  if (/bling\.com\.br\/Api\/v3\/contatos\?pesquisa=/.test(url)) return r(200, { data: [] });
  if (m === 'POST' && /\/contatos$/.test(url)) return r(201, { data: { id: 555 } });
  if (m === 'POST' && /\/pedidos\/vendas$/.test(url)) return r(201, { data: { id: 777, numero: 9001 } });
  return r(404, { erro: 'rota de mentira não prevista: ' + url });
}
const tokens = { tokenManager: { garantirToken: async () => 'tok-bling' }, mlTokenManager: { garantirTokenML: async () => 'tok-ml' } };

(async () => {
  process.env.ME_LOJA_IDS = '203300000'; process.env.AMB_ME_LOJA_IDS = '204400000'; delete process.env.GOOD_ME_LOJA_IDS;
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  // a versão de ANTES da Girassol, na pasta dela, com o fetch e os tokens de mentira (cache de require)
  const pasta = path.join(raiz, 'girassol');
  const nf = require.resolve('node-fetch'), tm = require.resolve(path.join(pasta, 'tokenManager.js')), mtm = require.resolve(path.join(pasta, 'mlTokenManager.js'));
  const salvo = { nf: require.cache[nf], tm: require.cache[tm], mtm: require.cache[mtm] };
  require.cache[nf] = { id: nf, filename: nf, loaded: true, exports: fakeFetch };
  require.cache[tm] = { id: tm, filename: tm, loaded: true, exports: tokens.tokenManager };
  require.cache[mtm] = { id: mtm, filename: mtm, loaded: true, exports: tokens.mlTokenManager };
  const arqAntigo = path.join(pasta, '_importar_antigo_teste.js');
  fs.writeFileSync(arqAntigo, fs.readFileSync(path.join(__dirname, 'fixtures', 'importar-pedido-girassol-antes.js'), 'utf8'));
  let velho;
  try { velho = require(arqAntigo); } finally { try { fs.unlinkSync(arqAntigo); } catch (e) {} }
  for (const [k, v] of Object.entries({ [nf]: salvo.nf, [tm]: salvo.tm, [mtm]: salvo.mtm })) { if (v) require.cache[k] = v; else delete require.cache[k]; }
  const { criarImportadorMl } = require('../lib/importar-pedido-ml');
  const nfGir = require('../girassol/nfBlingApi');
  const novo = criarImportadorMl(Object.assign({ rotulo: 'GIRASSOL', nfBlingApi: nfGir, envMeLojaIds: 'ME_LOJA_IDS', rotaDescobrir: '/girassol-backup-offline/descobrir-ids', fetch: fakeFetch }, tokens));
  const rodar = async (imp, conf) => { log = []; const r = await imp.testarImportarPedido(2000012345, conf); return JSON.stringify({ r, log }); };
  const a = await rodar(novo, false), b = await rodar(velho, false);
  assert.ok(/"modo":"DRY-RUN/.test(a) && /"loja":\{"id":203300000\}/.test(a) && /MAGAZINEGIRASSOL/.test(a), 'o dry-run da Girassol não montou o pedido esperado: ' + a.slice(0, 300));
  assert.strictEqual(a, b, 'Girassol: o DRY-RUN mudou em relação ao código de antes');
  const c = await rodar(novo, true), d = await rodar(velho, true);
  assert.ok(/"modo":"CRIADO"/.test(c) && /POST \/Api\/v3\/pedidos\/vendas/.test(c), 'o confirmar não criou o pedido: ' + c.slice(0, 300));
  assert.strictEqual(c, d, 'Girassol: o CONFIRMAR mudou em relação ao código de antes');

  // AMB e GOOD: tokens, intermediador e canal DELAS
  const amb = criarImportadorMl(Object.assign({ rotulo: 'AMB', nfBlingApi: require('../ambtotal/nfBlingApi'), envMeLojaIds: 'AMB_ME_LOJA_IDS', rotaDescobrir: '/amb-checkout-offline/descobrir-ids', fetch: fakeFetch }, tokens));
  const ra = await rodar(amb, false);
  assert.ok(/"loja":\{"id":204400000\}/.test(ra) && /"nomeUsuario":"AMBTOTAL"/.test(ra) && !/MAGAZINEGIRASSOL/.test(ra), 'AMB: o pedido não saiu com o canal e o intermediador DELA: ' + ra.slice(0, 400));
  const good = criarImportadorMl(Object.assign({ rotulo: 'GOOD', nfBlingApi: require('../good/nfBlingApi'), envMeLojaIds: 'GOOD_ME_LOJA_IDS', rotaDescobrir: '/good-checkout-offline/descobrir-ids', fetch: fakeFetch }, tokens));
  log = []; let erro = null;
  try { await good.testarImportarPedido(2000012345, true); } catch (e) { erro = e.message; }
  assert.ok(erro && /GOOD_ME_LOJA_IDS/.test(erro) && /\/good-checkout-offline\/descobrir-ids/.test(erro) && log.length === 0, 'GOOD sem a variável do canal: tinha que recusar ANTES de tocar no Bling: ' + erro + ' | ' + log.join(' ; '));
  /* Codex #742 — DE PONTA A PONTA, pelo adaptador de verdade do canário: o conserto da AMB acha 1 venda do ML fora
     do Bling, reconfere (não está), chama o importador REAL (a peça, com o ML e o Bling de mentira) e tem que contar
     como CRIADO — antes, o { modo: 'CRIADO', pedidoCriado } do importador virava "erro" e o aviso mandava importar à
     mão (duplicata). */
  { const os2 = require('os');
    const dirC = fs.mkdtempSync(path.join(os2.tmpdir(), 'can-imp-'));
    const { criarCanarioDaEmpresa } = require('../lib/checkout/canario-empresa');
    const can = criarCanarioDaEmpresa('amb', {
      deps: () => ({ blingGet: async () => ({ ok: true, status: 200, data: { data: [] } }), LOJA_MKT: {}, irmasDoPack: async () => [], CACHE_DIR: dirC, pedirAoSync: null, fetch: fakeFetch }),
      mlTokenManager: () => tokens.mlTokenManager,
      importarPedido: () => amb,
    });
    log = [];
    const saida = await can.consertar({ ok: true, alertas: [{ canal: 'ml', faltando: 1, de: 20, pct: 5, gravidade: 'atencao' }], por_canal: { ml: { exemplos: ['2000012345'] } }, nao_verificados: [] });
    assert.ok(saida && saida.criados.length === 1 && saida.erros.length === 0 && saida.criados[0].pedido === 9001,
      'o conserto não contou a criação de verdade como CRIADO: ' + JSON.stringify(saida).slice(0, 300));
    assert.ok(log.some((l) => /^POST \/Api\/v3\/pedidos\/vendas/.test(l)), 'o conserto não chegou a criar o pedido no Bling');
    fs.rmSync(dirC, { recursive: true, force: true }); }
  global.setTimeout = _st;

  // os wrappers das três empresas e a configuração
  for (const [p2, env] of [['girassol', 'ME_LOJA_IDS'], ['ambtotal', 'AMB_ME_LOJA_IDS'], ['good', 'GOOD_ME_LOJA_IDS']]) {
    const s = fs.readFileSync(path.join(raiz, p2, 'importarPedido.js'), 'utf8');
    assert.ok(/criarImportadorMl\(\{/.test(s) && s.includes("envMeLojaIds: '" + env + "'") && /tokenManager: require\('\.\/tokenManager'\)/.test(s) && /nfBlingApi: require\('\.\/nfBlingApi'\)/.test(s), p2 + '/importarPedido.js não é a peça com as coisas DELA');
  }
  const cfg = require('../lib/checkout/config-empresa');
  assert.deepStrictEqual(['girassol', 'amb', 'good'].map((e) => cfg.configCheckout(e).importarPedido), ['girassol/importarPedido', 'ambtotal/importarPedido', 'good/importarPedido'], 'a configuração não liga o importador nas três');
  console.log('ok — importador do ML em peça única: a Girassol faz o mesmo de antes (dry-run e confirmar); AMB e GOOD com o canal e o intermediador delas');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
