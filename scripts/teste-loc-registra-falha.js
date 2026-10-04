/* 04/10 — TODA FALHA AO SALVAR LOCALIZAÇÃO DEIXA RASTRO NO SERVIDOR.

   Até hoje só o SUCESSO era registrado. Quando o estoquista não consegue salvar, o pedido TRAVA
   no checkout (a impressão é bloqueada enquanto houver item sem local) — foi o que aconteceu com
   os pedidos 123037 e 123048 da Girassol. E quem opera o galpão não manda print: sem registro no
   servidor, não sobra NADA pra saber o porquê, nem depois.

   Cada motivo pede uma ação diferente (token vencido × cota × produto inexistente × Bling
   recusou), então "não salvou" sem o motivo não serve pra nada. O registro traz SKU, operador e
   motivo. */
const assert = require('assert');
const path = require('path');
const { criar } = require(path.join(__dirname, '..', 'lib', 'checkout', 'rotas-separacao'));

function montar(cfg) {
  return criar(Object.assign({
    prefixo: '/g', tag: 'TESTE',
    json: (res, s, b) => { res._s = s; res._b = JSON.stringify(b); },
    readBody: async () => ({ sku: '6676-220v', localizacao: 'A1', op: 'ygor' }),
    readJson: () => [], writeJson: () => {},
    blingGet: async () => ({ ok: true, data: { data: [{ id: 9, estoque: {} }] } }),
    blingWrite: async () => ({ ok: true }),
    lerReservas: () => ({}), locCache: () => ({}), localizacaoDeProduto: () => null,
    salvarLoc: () => {}, montarSeparacao: () => ({}), montarSeparacaoPorPedido: () => ({}),
    RESERVAS_FILE: '/tmp/r.json', LOC_LOG_FILE: '/tmp/l.json',
  }, cfg));
}

async function bater(cfg) {
  const avisos = [];
  const orig = console.warn;
  console.warn = (m) => avisos.push(String(m));
  try {
    const h = montar(cfg);
    const res = { _s: 0, _b: '' };
    await h({ method: 'POST', headers: {} }, res, new URL('http://x/g/salvar-localizacao'), 'POST');
    return { avisos, corpo: JSON.parse(res._b || '{}') };
  } finally { console.warn = orig; }
}

module.exports = (async () => {
  /* cada caminho de falha deixa rastro, e o rastro diz QUAL é */
  const casos = [
    ['Bling fora do ar na consulta', { blingGet: async () => ({ ok: false, status: 401 }) }, /HTTP 401/],
    ['resposta ilegível', { blingGet: async () => ({ ok: true, data: null }) }, /ilegível/],
    ['produto não existe', { blingGet: async () => ({ ok: true, data: { data: [] } }) }, /não encontrado/],
    ['Bling recusou a gravação', { blingWrite: async () => ({ ok: false, status: 422 }) }, /recusou/],
    ['SKU vazio', { readBody: async () => ({ sku: '', localizacao: 'A1', op: 'ygor' }) }, /SKU inválido/],
  ];
  for (const [nome, cfg, esperado] of casos) {
    const { avisos, corpo } = await bater(cfg);
    assert.ok(avisos.length > 0,
      nome + ': a falha NÃO deixou rastro no servidor — o pedido trava no galpão e ninguém ' +
      'descobre o porquê depois');
    assert.ok(esperado.test(avisos[0]),
      nome + ': o rastro não diz o motivo certo → ' + avisos[0]);
    assert.ok(/6676-220v|\(vazio\)/.test(avisos[0]), nome + ': o rastro não diz QUAL SKU');
    assert.ok(/ygor/.test(avisos[0]), nome + ': o rastro não diz QUEM tentou');
    assert.strictEqual(corpo.ok, false, nome + ': devia responder ok:false');
  }

  /* ⚠️ e o SUCESSO não pode virar aviso de falha */
  const { avisos } = await bater({});
  assert.strictEqual(avisos.length, 0,
    'o caminho de SUCESSO está registrando falha — log mentiroso é pior que log ausente');

  console.log('OK: toda falha ao salvar localizacao deixa rastro com SKU, operador e motivo');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
