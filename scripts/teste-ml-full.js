'use strict';
/* Teste da SONDA ml-full — exercita as funções de produção (exporta e importa),
   nunca cópia da lógica. Um cenário por saída da matriz declarada no topo do módulo.
   Rodar: node scripts/teste-ml-full.js  →  sai "OK: N cenários" ou explode com o motivo. */

process.env.ML_FULL_DIR = require('os').tmpdir() + '/ml-full-teste-' + Date.now();

const assert = require('assert');
const mf = require('../ml-full');
const { sondarVenda, extrairChave, _trocarFetchParaTeste } = mf._interno;

const XML = '<?xml version="1.0"?><NFe><infNFe Id="NFe12345678901234567890123456789012345678901234"></infNFe></NFe>';

function resposta(status, corpo) {
  return { status, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) };
}

/* fetch falso programável por tabela url→resposta. Casa pelo trecho MAIS LONGO
   que a URL contém — senão '/orders/111' engoliria '/invoices/orders/111' e o
   teste mentiria (foi exatamente o 1º furo que este arquivo pegou, em si mesmo). */
function fetchDeTabela(tabela) {
  return async (url) => {
    let melhor = null;
    for (const [trecho, r] of tabela) {
      if (url.includes(trecho) && (!melhor || trecho.length > melhor[0].length)) melhor = [trecho, r];
    }
    if (melhor) return typeof melhor[1] === 'function' ? melhor[1](url) : melhor[1];
    throw new Error('teste não previu chamada para: ' + url);
  };
}

(async () => {
  let cen = 0;

  // 1) ORDER direto, nota com xml_location fora do ML (sem Bearer) → xml_salvo + chave
  _trocarFetchParaTeste(fetchDeTabela([
    ['/orders/111', resposta(200, { id: 111, status: 'paid' })],
    ['/invoices/orders/111', resposta(200, { id: 555001, xml_location: 'https://storage.exemplo.com/nf.xml' })],
    ['storage.exemplo.com', resposta(200, XML)],
  ]));
  let r = await sondarVenda('tk', 999, 'amb', '111', false);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].resultado, 'xml_salvo');
  assert.strictEqual(r[0].via, 'xml_location');
  assert.strictEqual(r[0].chave, '12345678901234567890123456789012345678901234');
  cen++;

  // 2) PACK (orders/{id} 404 → /packs) com 2 ordens; XML só pelo documents/authorized
  _trocarFetchParaTeste(fetchDeTabela([
    ['/orders/222', resposta(404, { message: 'not found' })],
    ['/packs/222', resposta(200, { id: 222, orders: [{ id: 21 }, { id: 22 }] })],
    ['/invoices/orders/21', resposta(200, { id: 777021 })],
    ['/invoices/orders/22', resposta(200, { id: 777022 })],
    ['/invoices/documents/xml/777021/authorized', resposta(200, XML)],
    ['/invoices/documents/xml/777022/authorized', resposta(200, XML)],
  ]));
  r = await sondarVenda('tk', 999, 'amb', '222', false);
  assert.strictEqual(r.length, 2, 'pack de 2 ordens vira 2 entradas');
  assert.ok(r.every(e => e.resultado === 'xml_salvo' && e.via === 'documents/authorized'));
  cen++;

  // 3) nota 404 → sem_nota_no_ml_404 (conclusivo, NÃO transitório)
  _trocarFetchParaTeste(fetchDeTabela([
    ['/orders/333', resposta(200, { id: 333 })],
    ['/invoices/orders/333', resposta(404, { message: 'invoice not found' })],
  ]));
  r = await sondarVenda('tk', 999, 'amb', '333', false);
  assert.strictEqual(r[0].resultado, 'sem_nota_no_ml_404');
  cen++;

  // 4) nota existe mas nenhum caminho de XML serve → nota_encontrada_sem_xml
  _trocarFetchParaTeste(fetchDeTabela([
    ['/orders/444', resposta(200, { id: 444 })],
    ['/invoices/orders/444', resposta(200, { id: 888444 })],
    ['/invoices/documents/xml/888444/authorized', resposta(400, { message: 'not authorized yet' })],
  ]));
  r = await sondarVenda('tk', 999, 'amb', '444', false);
  assert.strictEqual(r[0].resultado, 'nota_encontrada_sem_xml');
  assert.strictEqual(String(r[0].invoice_id), '888444');
  cen++;

  // 5) 429 nas DUAS tentativas → transitorio_tente_de_novo (nunca vira "não existe")
  //    (o mlGet espera 4s entre tentativas — o teste paga esse tempo de propósito,
  //     porque é o caminho de produção, sem atalho)
  _trocarFetchParaTeste(fetchDeTabela([
    ['/orders/555', resposta(429, { message: 'local_rate_limited' })],
  ]));
  r = await sondarVenda('tk', 999, 'amb', '555', false);
  assert.strictEqual(r[0].resultado, 'transitorio_tente_de_novo');
  assert.ok(r[0].passos[0].transitorio === true);
  cen++;

  // 6) nem order nem pack → pedido_nao_encontrado
  _trocarFetchParaTeste(fetchDeTabela([
    ['/orders/666', resposta(404, {})],
    ['/packs/666', resposta(404, {})],
  ]));
  r = await sondarVenda('tk', 999, 'amb', '666', false);
  assert.strictEqual(r[0].resultado, 'pedido_nao_encontrado');
  cen++;

  // 7) erro conclusivo (403) aparece com o status no nome e corpo no passo
  _trocarFetchParaTeste(fetchDeTabela([
    ['/orders/777', resposta(403, { message: 'forbidden - PolicyAgent' })],
  ]));
  r = await sondarVenda('tk', 999, 'amb', '777', false);
  assert.strictEqual(r[0].resultado, 'erro_403');
  assert.ok(r[0].passos[0].corpo.includes('PolicyAgent'));
  cen++;

  // 8) (Codex r1) nota OK mas os caminhos de XML dão 429 → transitorio, NUNCA "sem xml"
  _trocarFetchParaTeste(fetchDeTabela([
    ['/orders/888', resposta(200, { id: 888 })],
    ['/invoices/orders/888', resposta(200, { id: 999888 })],
    ['/invoices/documents/xml/999888/authorized', resposta(429, { message: 'rate limited' })],
  ]));
  r = await sondarVenda('tk', 999, 'amb', '888', false);
  assert.strictEqual(r[0].resultado, 'transitorio_tente_de_novo', 'XML transitório propaga');
  cen++;

  // 9) (Codex r1) 2xx com HTML (começa com '<' mas SEM chave NF-e) → não salva, não é xml_salvo
  _trocarFetchParaTeste(fetchDeTabela([
    ['/orders/999', resposta(200, { id: 999 })],
    ['/invoices/orders/999', resposta(200, { id: 111999, xml_location: 'https://storage.exemplo.com/pagina' })],
    ['storage.exemplo.com', resposta(200, '<html><body>faça login para continuar</body></html>')],
    ['/invoices/documents/xml/111999/authorized', resposta(200, '<html>erro</html>')],
  ]));
  r = await sondarVenda('tk', 999, 'amb', '999', false);
  assert.strictEqual(r[0].resultado, 'nota_encontrada_sem_xml', 'HTML 2xx não vira xml_salvo');
  assert.ok(r[0].passos.some(p => String(p.corpo).includes('SEM chave de NF-e')), 'passo explica a recusa');
  assert.ok(!r[0].arquivo, 'nada foi salvo em disco');
  cen++;

  // extras de unidade
  assert.strictEqual(extrairChave('nada aqui'), null);
  assert.strictEqual(mf.VERSAO.includes('b1'), true);

  console.log('OK: ' + cen + ' cenários da matriz passaram (' + mf.VERSAO + ')');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
