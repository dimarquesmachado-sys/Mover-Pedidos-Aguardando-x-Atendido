'use strict';
/* 14/10 — parecer do Codex (6.5): na tela da GOOD, a resposta da LISTA pedida no período anterior
   reaparecia sob o período novo quando o agregado novo falhava (SEQ_LINHAS só andava dentro de
   carregarLinhas). Roda carregar() e carregarLinhas() DE PRODUÇÃO, recortadas do dashboard.html,
   com DOM e fetch de mentira, na ordem que dava o defeito. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'dashboard.html'), 'utf8');
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const pega = (assin) => { const i = js.indexOf(assin); assert.ok(i >= 0, 'não achei ' + assin); return js.slice(i, js.indexOf('\n}\n', i) + 2); };
const codigo = pega('async function carregar(){') + '\n' + pega('async function carregarLinhas(){');

(async () => {
  const els = {}; const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '' });
  const pend = []; const fetchFake = (url) => new Promise(res => pend.push({ url, res }));
  const resp = (obj) => ({ json: async () => obj });
  const ctx = new Function('document', 'fetch', `
    let SEQ_CARDS = 0, SEQ_LINHAS = 0, PERIODO = 'A', PAGINA = 1, _ultimaPaginaOk = 1, _ultimaJanelaOk = null, FRESH_PROX = false, HIST = null;
    const MOD = '/good-checkout-offline';
    const janela = (p) => p === 'A' ? { de: '2026-09-01', ate: '2026-09-30' } : { de: '2026-10-14', ate: '2026-10-14' };
    const pintarPeriodos = () => {}, semCustoNoCard = () => {}, pintarCards = () => {}, pintarQuebras = () => {}, pintarAvisos = () => {}, avisarOndeTemDado = () => {};
    const esc = (x) => String(x); const linhaPedido = (o) => '<tr><td>' + o.numero + '</td></tr>';
    ${codigo}
    return { carregar, carregarLinhas, setPeriodo: (p) => { PERIODO = p; PAGINA = 1; } };`)({ getElementById: el }, fetchFake);

  // 1) lista do período A no ar
  const pA = ctx.carregarLinhas();
  assert.ok(pend[0].url.includes('/historico-linhas?de=2026-09-01'));
  // 2) troca pro período B; o agregado novo FALHA
  ctx.setPeriodo('B'); const pB = ctx.carregar();
  pend[1].res(resp({ ok: false, erro: 'leitura do histórico INCOMPLETA' })); await pB;
  assert.ok(/Não deu pra carregar o período/.test(el('cards').innerHTML));
  // 3) a lista VELHA chega agora
  pend[0].res(resp({ ok: true, pedidos: Array.from({ length: 20 }, (_, i) => ({ numero: 900 + i })), total_pedidos: 20, pagina: 4, total_paginas: 4 })); await pA;
  assert.strictEqual(el('resumoAnalise').textContent, '', 'o resumo do período ANTERIOR apareceu sob o período novo: "' + el('resumoAnalise').textContent + '"');
  assert.ok(!/900/.test(el('tabela').innerHTML), 'a tabela do período anterior foi pintada sob o período novo');
  assert.strictEqual(el('paginacao').innerHTML, '', 'a paginação do período anterior ficou na tela');
  // controle positivo: agregado OK chama a lista do período atual e ela pinta
  const pB2 = ctx.carregar();
  pend[2].res(resp({ ok: true, totais: { pedidos: 1 } })); await new Promise(r => setTimeout(r, 0));
  assert.ok(pend[3] && pend[3].url.includes('/historico-linhas?de=2026-10-14'), 'agregado OK não pediu a lista do período atual');
  pend[3].res(resp({ ok: true, pedidos: [{ numero: 1 }], total_pedidos: 1, pagina: 1, total_paginas: 1 })); await pB2; await new Promise(r => setTimeout(r, 0));
  assert.ok(/1 pedido\(s\) no período/.test(el('resumoAnalise').textContent), 'a lista do período atual não pintou');
  console.log('ok — lista do período anterior não pinta por baixo do período novo (GOOD)');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
