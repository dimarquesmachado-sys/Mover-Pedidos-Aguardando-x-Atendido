'use strict';
/* 01/11 — CAÇA DA MAGALU: IMPOSTO DESCONHECIDO NÃO VIRA ZERO (auditoria do Codex no SHA 208fdb7d, achado F04). Mês sem
   alíquota no painel NEM na tabela de fábrica caía em ZERO na caça: imposto R$ 0 e margem inflada (a GOOD não tem
   setembro/outubro na tabela). Agora é a MESMA regra do backfill: painel → tabela de fábrica → alíquota de RESERVA da
   empresa (AMB 14,1; sem dizer, 15), contada em `imposto_pela_reserva`. Prova com a peça de produção (magaluLinhas) e a
   Magalu/Supabase de mentira: venda de R$ 100 em mês com painel (6,5%), com tabela (5%) e sem nenhum dos dois. */
const assert = require('assert');
const path = require('path');
const { criarCacaMagalu } = require('../lib/checkout/magalu-caca');

function caca(aliqReserva) {
  const pedidos = [
    { code: 'M-OUT', id: 'u1', purchased_at: '2026-10-20T10:00:00Z', status: 'approved', total: 100, itens: [{ sku: 'SK1', desc: 'a', qtd: 1, valor: 100 }] },
    { code: 'M-SET', id: 'u2', purchased_at: '2026-09-20T10:00:00Z', status: 'approved', total: 100, itens: [{ sku: 'SK1', desc: 'a', qtd: 1, valor: 100 }] },
    { code: 'M-AGO', id: 'u3', purchased_at: '2026-08-20T10:00:00Z', status: 'approved', total: 100, itens: [{ sku: 'SK1', desc: 'a', qtd: 1, valor: 100 }] },
  ];
  const fetch = async (url) => {
    const r = (b) => ({ status: 200, ok: true, json: async () => b });
    if (/pedidos-do-dia/.test(url)) return r({ ok: true, pedidos, parcial: false });
    if (/financeiro-lote/.test(url)) return r({ ok: true, pedidos: {} });
    return r(null);
  };
  const readJson = (arq, d) => {
    if (/_config-fiscal\.json$/.test(arq)) return { aliquotas: { '2026-10': 6.5 }, taxas: { magalu: 16 } };   // outubro no painel
    if (/_custos\.json$/.test(arq)) return { SK1: { custo: 20 } };
    return d;
  };
  const o = { empresa: 'good', magaluEmpresa: () => 'good', supaReq: async () => ({ ok: true, status: 200, body: '[]' }), blingGet: async () => ({ ok: false }),
    readJson, CACHE_DIR: '/tmp/x', DEFAULT_ALIQ_BK: () => ({ '2026-09': 5 }), magaluFreteSkuLer: () => ({}), reparoAtivo: () => false, histCache: () => ({}), fetch };
  if (aliqReserva != null) o.aliqReserva = aliqReserva;
  return criarCacaMagalu(o);
}

(async () => {
  process.env.ADMIN_KEY = 'adm'; process.env.PORT = '3999';
  const _log = console.log; console.log = () => {};
  try {
    for (const [reserva, esperado] of [[undefined, 15], [14.1, 14.1]]) {
      const r = await caca(reserva).magaluLinhas('2026-08-01', '2026-10-31', 'good', new Set());
      const imp = (cod) => { const l = r.linhas.find((x) => x.numero_loja === cod); assert.ok(l, 'a venda ' + cod + ' não virou linha'); return Number(l.imposto); };
      assert.strictEqual(imp('M-OUT'), 6.5, 'outubro: a alíquota do painel (6,5%)');
      assert.strictEqual(imp('M-SET'), 5, 'setembro: a alíquota da tabela de fábrica (5%)');
      assert.strictEqual(imp('M-AGO'), esperado, 'agosto, sem painel nem tabela: tinha que ser a RESERVA da empresa (' + esperado + '%), nunca zero — veio ' + imp('M-AGO'));
      assert.ok(r.imposto_pela_reserva >= 1 && JSON.stringify(r.meses_pela_reserva) === '["2026-08"]', 'a caça tem que contar e dizer QUAL mês usou a reserva: ' + JSON.stringify({ n: r.imposto_pela_reserva, m: r.meses_pela_reserva }));
      const ago = r.linhas.find((x) => x.numero_loja === 'M-AGO');
      assert.ok(ago.margem < 100 - 20 - 16 - 0.01, 'a margem do mês sem alíquota não pode ignorar o imposto: ' + ago.margem);
    }
  } finally { console.log = _log; }
  const amb = require('fs').readFileSync(path.join(__dirname, '..', 'amb-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/const _cacaMgAmb = require\('\.\.\/lib\/checkout\/magalu-caca'\)\.criarCacaMagalu\(\{\n[^\n]*\n  aliqReserva: 14\.1,/.test(amb), 'a AMB tem que entregar à caça a mesma reserva do backfill dela (14,1)');
  console.log('ok — caça da Magalu: mês sem alíquota usa a reserva da empresa (15 ou a dela, 14,1 na AMB), contada; painel e tabela continuam valendo');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
