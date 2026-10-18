'use strict';
/* 17/10 — "a nota quando o ML pede". Com a emissão automática do Bling desligada (Girassol, out/2026), o pedido do ML em
   invoice_pending ("Pronta para emitir NF-e" — o dono clicou "Já tenho os produtos" ou chegou o dia da coleta) e SEM nota
   ganha a nota gerada pelo sistema. Prova, com as funções DE PRODUÇÃO (recortadas da lib e da Girassol):
   espera a emissão automática; não gera com nota, nem lixas A-COMBINAR, nem desligado; não repete em 6 h; erro tenta de
   novo; o F2 só chama no invoice_pending sem etiqueta; e o POST do Bling não é repetido em erro de rede. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

let _fim = false;
process.on('beforeExit', () => { if (!_fim) { console.error('FALHOU: o teste terminou sem chegar ao fim'); process.exitCode = 1; } });
(async () => {
  for (const [onde, arq, rot] of [['lib (AMB/GOOD)', 'lib/fiscal/fluxos-pedidos.js', 'AMB'], ['Girassol', 'girassol/fluxos.js', 'GIRASSOL']]) {
    const src = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const i = src.indexOf('const _mlPediuNF = new Map();');
    const iF = src.indexOf('async function _emitirNFQuandoMLPede(', i);
    const fim = src.indexOf(onde === 'Girassol' ? '\n}\n' : '\n  }\n', iF) + (onde === 'Girassol' ? 3 : 5);
    const bloco = src.slice(i, fim);
    const montar = () => { const chamadas = [];
      const fn = new Function('gerarNFeDoPedido', 'rotulo', 'console', bloco + '\nreturn _emitirNFQuandoMLPede;')(
        async (tk, id) => { chamadas.push(String(id)); return montar.resposta || { ok: true, nfId: 9 }; }, rot, { log() {}, warn() {} });
      return { fn, chamadas }; };
    const ped = (id, extra) => [{ id }, Object.assign({ id, itens: [{ codigo: 'SKU1' }], notaFiscal: null }, extra)];
    // a) sem nota: 1ª vez espera; passada a espera gera UMA vez; depois não repete
    process.env.EMITIR_NF_ESPERA_MIN = '0';
    let m = montar(); await m.fn('tk', ...ped(1)); assert.deepStrictEqual(m.chamadas, [], onde + ': gerou na 1ª vez (sem dar o tempo da emissão automática)');
    await m.fn('tk', ...ped(1)); assert.deepStrictEqual(m.chamadas, ['1'], onde + ': não gerou depois da espera');
    await m.fn('tk', ...ped(1)); assert.deepStrictEqual(m.chamadas, ['1'], onde + ': gerou de novo antes de o Bling mostrar a nota');
    // b) já tem nota · c) lixas A-COMBINAR · d) desligado
    m = montar(); await m.fn('tk', ...ped(2, { notaFiscal: { id: 77 } })); await m.fn('tk', ...ped(2, { notaFiscal: { id: 77 } }));
    assert.deepStrictEqual(m.chamadas, [], onde + ': gerou nota pra pedido que já tem');
    m = montar(); await m.fn('tk', ...ped(3, { itens: [{ codigo: 'A-COMBINAR-100-lisa-125mm' }] })); await m.fn('tk', ...ped(3, { itens: [{ codigo: 'A-COMBINAR-100-lisa-125mm' }] }));
    assert.deepStrictEqual(m.chamadas, [], onde + ': gerou nota de lixa A-COMBINAR (antes de acertar o grão)');
    process.env[rot + '_EMITIR_NF_QUANDO_ML_PEDIR'] = '0';
    m = montar(); await m.fn('tk', ...ped(4)); await m.fn('tk', ...ped(4)); delete process.env[rot + '_EMITIR_NF_QUANDO_ML_PEDIR'];
    assert.deepStrictEqual(m.chamadas, [], onde + ': gerou com a emissão desligada');
    // e) erro do Bling (não ambíguo): tenta de novo no ciclo seguinte
    m = montar(); montar.resposta = { ok: false, erro: 'HTTP 400' };
    await m.fn('tk', ...ped(5)); await m.fn('tk', ...ped(5)); await m.fn('tk', ...ped(5)); montar.resposta = null;
    assert.deepStrictEqual(m.chamadas, ['5', '5'], onde + ': erro do Bling travou a nova tentativa');
    delete process.env.EMITIR_NF_ESPERA_MIN;
    // f) o F2 só chama quando o ML pede a nota e não há etiqueta; temEtiquetaML entrega o status
    assert.ok(/if \(saida\) \{ saida\.status = status; saida\.substatus = substatus; \}/.test(src), onde + ': temEtiquetaML não entrega o status do envio');
    assert.ok(/deveAtender = await temEtiquetaML\(mlToken, numeroLoja, _envF2\);\n[^\n]*\n\s*if \(!deveAtender && String\(_envF2\.substatus \|\| ''\) === 'invoice_pending'\) await _emitirNFQuandoMLPede\(token, p, pDetalhe\);/.test(src), onde + ': o F2 não chama a nota quando o ML pede (ou chama fora do invoice_pending)');
  }
  // g) o POST do Bling: URL certa, uma tentativa só em erro de rede (ambíguo), 429 adia, 200 devolve o id
  const resp = []; let modo = 'rede';
  require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (u, o) => {
    resp.push([o && o.method, String(u)]);
    if (modo === 'rede') throw new Error('ECONNRESET');
    if (modo === '429') return { status: 429, headers: { get: () => null }, text: async () => '' };
    return { status: 200, headers: { get: () => null }, text: async () => '{"data":{"id":123}}' }; } };
  delete require.cache[require.resolve('../lib/fiscal/bling-api')];
  const api = require('../girassol/blingApi');
  let r = await api.gerarNFeDoPedido('tk', 555);
  assert.ok(r.ambiguo && !r.ok, 'erro de rede tinha que voltar ambíguo'); assert.strictEqual(resp.length, 1, 'o POST foi repetido em erro de rede');
  assert.deepStrictEqual(resp[0], ['POST', 'https://api.bling.com.br/Api/v3/pedidos/vendas/555/gerar-nfe']);
  modo = '429'; r = await api.gerarNFeDoPedido('tk', 555); assert.ok(!r.ok && !r.ambiguo && /429/.test(r.erro));
  modo = 'ok'; r = await api.gerarNFeDoPedido('tk', 555); assert.ok(r.ok && r.nfId === 123, 'não leu o id da nota: ' + JSON.stringify(r));
  _fim = true;
  console.log('ok — a nota quando o ML pede: espera, não duplica, respeita lixas/nota existente/desligado, e o POST não repete em erro de rede (lib e Girassol)');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
