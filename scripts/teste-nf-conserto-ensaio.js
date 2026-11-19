'use strict';
/* 18/11 — O ENSAIO DO CONSERTO DA NF QUE O MERCADO LIVRE RECUSA POR ENDEREÇO (1ª etapa do pedido do dono de automatizar o
   que ele faz à mão: clonar a nota, colar o endereço da venda do ML, emitir, subir o XML no ML; a nota errada cancela e,
   "se passar de 24h da emissão da NF, aí sim, gera a NF devolução").

   Esta etapa NÃO ESCREVE NADA. O que se prova (o código de produção, sem rede de verdade):
   A. a peça (lib/fiscal/nf-conserto-endereco): lê o endereço da nota e o da venda (nos dois formatos do envio do ML),
      compara sem tropeçar em acento/caixa/máscara do CEP, decide cancelar × devolução pela regra das 24 h (sem data não
      decide), monta a nota nova (a mesma nota, sem o que é da antiga, com o endereço da venda) e lista o que falta;
   B. a resposta de rota não leva dado de gente (nome, documento, rua, número, CEP);
   C. a rota, pelo `routes` real das TRÊS empresas: sem credencial é 404; só GETs saem (Bling e ML) — nenhum POST/PUT/
      DELETE; venda simples e carrinho; e cada leitura que falha diz a etapa (nunca "não precisa consertar"). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const C = require('../lib/fiscal/nf-conserto-endereco');

/* ═══ A. a peça ═══ */
const AGORA = Date.parse('2026-11-18T15:00:00-03:00');
const nf = (extra) => Object.assign({ id: 777, numero: '130772', situacao: 5, dataEmissao: '2026-11-18 09:00:00', chaveAcesso: '3526'.padEnd(44, '1'), xml: 'https://x/xml', linkDanfe: 'https://x/d', linkPDF: 'https://x/p', dataOperacao: '2026-11-18 09:00:00',
  numeroPedidoLoja: '2000016131728867', naturezaOperacao: { id: 15 }, loja: { id: 203146903 },
  contato: { id: 9, nome: 'Fulana de Tal', numeroDocumento: '12345678909', endereco: { endereco: 'Rua das Flores', numero: '10', complemento: '', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '01001-000' } },
  serie: 1, valorNota: 62.9, valorFrete: 12.9, optanteSimplesNacional: true, vendedor: { id: 0 }, intermediador: { cnpj: '03007331000141', nomeUsuario: 'LOJA' }, finalidade: 1,
  itens: [{ codigo: 'A1', descricao: 'Coisa', quantidade: 1, valor: 50 }],
  transporte: { fretePorConta: 0, volumes: [], etiqueta: { nome: 'Fulana de Tal', endereco: 'Rua das Flores', numero: '10', complemento: '', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '01001-000' } } }, extra || {});
const envioAntigo = { status: 'ready_to_ship', substatus: 'invoice_pending', receiver_address: { street_name: 'RUA DAS FLÔRES', street_number: '10', comment: '', neighborhood: { name: 'centro' }, city: { name: 'Sao Paulo' }, state: { id: 'BR-SP' }, zip_code: '04567000' } };
const envioNovo = { status: 'ready_to_ship', substatus: 'invoice_pending', destination: { shipping_address: { address_line: 'Rua das Flores 10', street_name: 'Rua das Flores', street_number: '10', comment: 'ap 2', neighborhood: { name: 'Centro' }, city: { name: 'São Paulo' }, state: { id: 'BR-SP' }, zip_code: '04567-000' } } };
{
  assert.deepStrictEqual(C.enderecoDoML(envioAntigo), { endereco: 'RUA DAS FLÔRES', numero: '10', complemento: '', bairro: 'centro', municipio: 'Sao Paulo', uf: 'SP', cep: '04567000' });
  assert.strictEqual(C.fonteDoEnderecoML(envioAntigo), 'receiver_address');
  assert.strictEqual(C.fonteDoEnderecoML(envioNovo), 'destination.shipping_address');
  assert.strictEqual(C.enderecoDoML(envioNovo).cep, '04567000', 'o CEP do formato novo do envio sai só com os dígitos');
  assert.strictEqual(C.enderecoDoML({ status: 'x' }), null); assert.strictEqual(C.enderecoDoML(null), null);
  assert.strictEqual(C.enderecoDaNota(nf()).cep, '01001000'); assert.strictEqual(C.enderecoDaNota({}), null);

  /* a comparação sozinha (quem chamar com o endereço cru): a máscara do CEP não é diferença; um dígito é */
  assert.strictEqual(C.comparar({ cep: '04567-000' }, { cep: '04567000' }).find((c) => c.campo === 'cep').igual, true);
  assert.strictEqual(C.comparar({ cep: '04567-000' }, { cep: '04567001' }).find((c) => c.campo === 'cep').igual, false);
  const p = C.planejar(nf(), envioAntigo, AGORA);
  assert.deepStrictEqual(p.diferentes, ['cep'], 'acento, caixa e máscara não são diferença — só o CEP difere neste caso: ' + JSON.stringify(p.campos));
  assert.deepStrictEqual([p.ok, p.pronta, p.pendencias, p.nota_errada, p.nota.horas_desde_a_emissao, p.fonte_do_endereco_no_ml], [true, true, [], 'cancelar', 6, 'receiver_address']);
  /* a nota nova: a mesma nota, sem o que é da antiga, com o endereço da venda */
  const n = p.nota_nova;
  for (const k of ['id', 'numero', 'chaveAcesso', 'xml', 'linkDanfe', 'linkPDF', 'situacao', 'dataEmissao', 'dataOperacao']) assert.ok(!(k in n), 'a nota nova levou `' + k + '` da antiga');
  assert.deepStrictEqual(n.contato.endereco, { endereco: 'RUA DAS FLÔRES', numero: '10', complemento: '', bairro: 'centro', municipio: 'Sao Paulo', uf: 'SP', cep: '04567000' });
  assert.deepStrictEqual([n.contato.id, n.contato.nome, n.naturezaOperacao.id, n.itens.length, n.loja.id, n.finalidade, n.intermediador.cnpj], [9, 'Fulana de Tal', 15, 1, 203146903, 1, '03007331000141'], 'o resto da nota tem que ir igual');
  /* 19/11: o que a API só devolve na leitura não vai na criação; o frete vai em transporte.frete; e o endereço da venda
     entra também na etiqueta (o endereço de entrega da nota), sem trocar o nome de quem recebe */
  for (const k of ['serie', 'valorNota', 'valorFrete', 'optanteSimplesNacional', 'numeroPedidoLoja', 'vendedor']) assert.ok(!(k in n), 'a nota nova levou `' + k + '`, que a API do Bling não aceita ao criar');
  assert.deepStrictEqual(p.fica_de_fora_na_criacao, ['serie', 'valorNota', 'valorFrete', 'optanteSimplesNacional', 'numeroPedidoLoja', 'vendedor']);
  assert.strictEqual(n.transporte.frete, 12.9, 'o frete da nota lida tem que ir em transporte.frete');
  assert.deepStrictEqual(n.transporte.etiqueta, { nome: 'Fulana de Tal', endereco: 'RUA DAS FLÔRES', numero: '10', complemento: '', bairro: 'centro', municipio: 'Sao Paulo', uf: 'SP', cep: '04567000' });
  assert.deepStrictEqual(C.montarNotaNova(nf({ transporte: { fretePorConta: 0, frete: 5 } }), C.enderecoDoML(envioAntigo)).transporte, { fretePorConta: 0, frete: 5 }, 'frete já informado não é trocado; sem etiqueta, nenhuma é inventada');
  /* a etiqueta comparada com a venda, e a FORMA do que a nota traz (sem valor) */
  assert.deepStrictEqual(p.etiqueta.diferentes, ['cep']);
  assert.deepStrictEqual(p.forma.contato_endereco, { bairro: 'preenchido', cep: 'preenchido', complemento: 'vazio', endereco: 'preenchido', municipio: 'preenchido', numero: 'preenchido', uf: 'preenchido' });
  assert.deepStrictEqual(p.forma.transporte, { etiqueta: 'objeto', fretePorConta: 'preenchido', volumes: 'objeto' });
  assert.strictEqual(C.planejar(nf({ transporte: { fretePorConta: 0 } }), envioAntigo, AGORA).etiqueta, null, 'nota sem etiqueta: o ensaio diz que não tem');
  /* o caso real (NF 130772): o CEP vazio no destinatário e certo... ou errado na etiqueta — os dois aparecem */
  const real = C.planejar(nf({ contato: { id: 9, nome: 'Fulana de Tal', endereco: { endereco: 'Rua das Flores 10', numero: '', complemento: '', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '' } } }), envioAntigo, AGORA);
  const cR = (c) => real.campos.find((x) => x.campo === c);
  assert.deepStrictEqual([cR('cep').na_nota, cR('cep').tam_nota, cR('cep').tam_ml, cR('cep').um_contem_o_outro], [false, 0, 8, false]);
  assert.deepStrictEqual([cR('endereco').igual, cR('endereco').um_contem_o_outro, cR('endereco').tam_nota, cR('endereco').tam_ml], [false, true, 17, 14], 'o número colado na rua é diferença de FORMATO: um lado contém o outro');
  assert.strictEqual(real.forma.contato_endereco.cep, 'vazio');
  /* endereço do destinatário igual e etiqueta diferente: ainda há o que consertar */
  const soEtiq = C.planejar(nf({ contato: { id: 9, endereco: { endereco: 'rua das flores', numero: '10', bairro: 'CENTRO', municipio: 'São Paulo', uf: 'sp', cep: '04567-000' } } }), envioAntigo, AGORA);
  assert.ok(soEtiq.pronta && !soEtiq.diferentes.length && soEtiq.etiqueta.diferentes.join() === 'cep', 'só a etiqueta diferente também é conserto');
  assert.strictEqual(nf().contato.endereco.cep, '01001-000'); assert.strictEqual(p.nota_nova === nf(), false);
  const orig = nf(); C.planejar(orig, envioAntigo, AGORA); assert.strictEqual(orig.contato.endereco.cep, '01001-000', 'montar a nota nova não pode mexer na nota lida');

  /* 24 h: até lá cancela; depois, devolução; sem data, não decide */
  assert.strictEqual(C.planejar(nf({ dataEmissao: '2026-11-17 15:01:00' }), envioAntigo, AGORA).nota_errada, 'cancelar');
  assert.strictEqual(C.planejar(nf({ dataEmissao: '2026-11-17 14:00:00' }), envioAntigo, AGORA).nota_errada, 'devolucao');
  const semData = C.planejar(nf({ dataEmissao: null, dataOperacao: null }), envioAntigo, AGORA);
  assert.ok(semData.nota_errada === null && !semData.pronta && /data de emissão/.test(semData.pendencias.join('|')), 'sem a data de emissão o ensaio não pode escolher cancelar nem devolução');
  /* o que falta, dito */
  const pend = (x, e) => C.planejar(x, e, AGORA).pendencias.join(' | ');
  assert.ok(/já é o da venda/.test(pend(nf({ contato: { id: 9, endereco: { endereco: 'rua das flores', numero: '10', bairro: 'CENTRO', municipio: 'São Paulo', uf: 'sp', cep: '04567-000' } }, transporte: { fretePorConta: 0 } }), envioAntigo)), 'endereço igual = nada a consertar');
  assert.ok(/não traz o endereço de entrega/.test(pend(nf(), { status: 'x' })));
  assert.ok(/não traz o endereço do destinatário/.test(pend(nf({ contato: { id: 9 } }), envioAntigo)));
  assert.ok(/8 dígitos/.test(pend(nf(), { receiver_address: Object.assign({}, envioAntigo.receiver_address, { zip_code: '0456' }) })));
  assert.ok(/sem municipio/.test(pend(nf(), { receiver_address: Object.assign({}, envioAntigo.receiver_address, { city: null }) })));
  assert.ok(/sem itens/.test(pend(nf({ itens: [] }), envioAntigo)));
  assert.ok(/não está autorizada \(situação 2\)/.test(pend(nf({ situacao: 2 }), envioAntigo)), 'nota cancelada não entra em conserto');
  assert.ok(C.planejar(nf({ situacao: { valor: 6 } }), envioAntigo, AGORA).pronta, 'a situação pode vir como objeto');
  assert.deepStrictEqual(C.planejar(null, envioAntigo, AGORA), { ok: false, pronta: false, pendencias: ['a nota não veio do Bling'] });

  /* ═══ B. sem dado de gente ═══ */
  const s = JSON.stringify(C.semDadoDeGente(C.planejar(nf(), envioNovo, AGORA)));
  for (const v of ['Fulana', '12345678909', 'Flores', '04567', '01001', 'ap 2', '3526111']) assert.ok(!s.includes(v), 'a resposta de rota levou dado de gente: ' + v);
  const sd = C.semDadoDeGente(C.planejar(nf(), envioNovo, AGORA));
  assert.deepStrictEqual(sd.diferentes, ['complemento', 'cep']);
  assert.deepStrictEqual([sd.nota_nova.montada, sd.nota_nova.itens, sd.nota_nova.tem_natureza, sd.nota_nova.tem_contato, sd.nota_nova.sem_o_que_e_da_antiga, sd.nota_nova.sem_o_que_so_existe_na_leitura, sd.nota_nova.etiqueta_com_o_endereco_da_venda], [true, 1, true, true, true, true, true]);
  assert.deepStrictEqual(sd.nota_nova.forma_do_transporte, { etiqueta: 'objeto', frete: 'preenchido', fretePorConta: 'preenchido', volumes: 'objeto' });
  assert.ok(sd.etiqueta && sd.forma && Array.isArray(sd.fica_de_fora_na_criacao), 'a resposta de rota tem que levar a etiqueta, a forma e o que fica de fora');
}

/* ═══ C. a rota, pelo routes real das três ═══ */
const chamadas = [];
let roteiroML = {};
const nfetch = require.resolve('node-fetch');
require.cache[nfetch] = { id: nfetch, filename: nfetch, loaded: true, exports: async (url, opts) => {
  const u = String(url); chamadas.push(((opts && opts.method) || 'GET') + ' ' + u);
  if (!u.startsWith('https://api.mercadolibre.com')) throw new Error('rede bloqueada no teste: ' + u);
  const r = roteiroML[u.replace('https://api.mercadolibre.com', '')] || [404, { message: 'not found' }];
  return { ok: r[0] === 200, status: r[0], json: async () => r[1], text: async () => JSON.stringify(r[1]) };
} };
for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
process.env.ADMIN_KEY = 'chave-ensaio';
const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-conserto-'));
for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; }
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
const CE = require('../lib/checkout/config-empresa');
const R = require('../lib/checkout/rota-nf-conserto');

(async () => {
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    /* a fábrica de cada empresa atende o caminho (pelo routes real): sem credencial, 404 — e nada foi lido */
    for (const [emp, arq] of [['girassol', 'girassol-backup-offline/gbo-app.js'], ['amb', 'amb-checkout-offline/index.js'], ['good', 'good-checkout-offline/index.js']]) {
      const pref = CE.prefixoDe(emp);
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const pedir = async (qs) => { const u = new URL('http://x' + pref + '/nf-conserto-ensaio' + qs); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
        const t = await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return [t, res._s, res._b]; };
      chamadas.length = 0;
      const semK = await pedir('?nf=777');
      assert.ok(semK[1] === 404 || semK[1] === 401 || semK[1] === 302, emp + ': sem credencial a rota respondeu ' + semK[1] + ' ' + semK[2].slice(0, 120));
      assert.strictEqual(chamadas.length, 0, emp + ': sem credencial a rota foi ler alguma coisa: ' + chamadas.join(', '));
      const ruim = await pedir('?k=chave-ensaio&nf=abc');
      assert.ok(ruim[1] === 400 && /só dígitos/.test(ruim[2]) && /"escreveu_algo":false/.test(ruim[2]), emp + ': id de nota inválido tem que ser recusado: ' + ruim[1] + ' ' + ruim[2].slice(0, 160));
    }

    /* a peça da rota, com o Bling e o token de mentira (o ML é o `node-fetch` acima) */
    for (const emp of ['girassol', 'amb', 'good']) {
      const pref = CE.prefixoDe(emp);
      const lidasBling = [];
      const montar = (nota, extra) => R.criar(Object.assign({ empresa: emp, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '', validarSessao: () => null, ehAdmin: () => false,
        blingGet: async (c) => { lidasBling.push(c); return nota ? { ok: true, status: 200, data: { data: nota } } : { ok: false, status: 404, data: null }; }, tokenML: async () => 'tok-' + emp }, extra || {}));
      const pedir = async (rota, qs) => { const u = new URL('http://x' + pref + '/nf-conserto-ensaio' + qs); const res = {}; const t = await rota({ method: 'GET', headers: {} }, res, u, 'GET', u.pathname); return [t, res._s, res._o]; };
      assert.strictEqual(await montar(nf())({ method: 'POST', headers: {} }, {}, new URL('http://x' + pref + '/nf-conserto-ensaio'), 'POST', pref + '/nf-conserto-ensaio'), false, emp + ': a rota do ensaio é só GET');
      assert.strictEqual(R.atende(pref, 'GET', pref + '/nf-conserto'), false);

      /* venda simples: /orders dá o envio */
      chamadas.length = 0; lidasBling.length = 0;
      roteiroML = { '/orders/2000016131728867': [200, { shipping: { id: 4455 } }], '/shipments/4455': [200, envioAntigo] };
      const ok = await pedir(montar(nf()), '?k=chave-ensaio&nf=777');
      assert.deepStrictEqual([ok[0], ok[1], ok[2].ok, ok[2].pronta, ok[2].nota_errada, ok[2].diferentes, ok[2].envio_achado_por, ok[2].escreveu_algo, ok[2].empresa],
        [true, 200, true, true, ok[2].nota_errada, ['cep'], 'venda', false, emp], emp + ': o ensaio da venda simples: ' + JSON.stringify(ok[2]).slice(0, 300));
      assert.deepStrictEqual(lidasBling, ['/nfe/777'], emp + ': do Bling o ensaio só lê a nota');
      assert.deepStrictEqual(chamadas, ['GET https://api.mercadolibre.com/orders/2000016131728867', 'GET https://api.mercadolibre.com/shipments/4455'], emp + ': do ML o ensaio só lê a venda e o envio');
      assert.ok(chamadas.every((c) => c.startsWith('GET ')), emp + ': o ensaio escreveu alguma coisa: ' + chamadas.join(', '));
      for (const v of ['Fulana', '12345678909', 'Flores', '04567', '01001']) assert.ok(!JSON.stringify(ok[2]).includes(v), emp + ': a resposta levou dado de gente: ' + v);
      assert.deepStrictEqual([ok[2].nf, ok[2].pedido_ml, ok[2].envio.substatus], [{ id: '777', numero: '130772' }, '2000016131728867', 'invoice_pending']);

      /* carrinho: /orders não acha, /packs dá o envio; e o pedido informado vence o da nota */
      chamadas.length = 0;
      roteiroML = { '/packs/2000009': [200, { shipment: { id: 88 } }], '/shipments/88': [200, envioNovo] };
      const pk = await pedir(montar(nf()), '?k=chave-ensaio&nf=777&pedido=2000009');
      assert.deepStrictEqual([pk[2].ok, pk[2].envio_achado_por, pk[2].pedido_ml, pk[2].fonte_do_endereco_no_ml, pk[2].diferentes], [true, 'carrinho', '2000009', 'destination.shipping_address', ['complemento', 'cep']], emp + ': carrinho: ' + JSON.stringify(pk[2]).slice(0, 300));

      /* cada leitura que falha diz a etapa — nunca "pronta" nem "não precisa" */
      roteiroML = {};
      const e1 = await pedir(montar(null), '?k=chave-ensaio&nf=777');
      assert.deepStrictEqual([e1[2].ok, e1[2].etapa, e1[2].status, e1[2].escreveu_algo], [false, 'nota_no_bling', 404, false]);
      const e2 = await pedir(montar(nf({ numeroPedidoLoja: '' })), '?k=chave-ensaio&nf=777');
      assert.deepStrictEqual([e2[2].ok, e2[2].etapa], [false, 'pedido_do_ml']);
      const e3 = await pedir(montar(nf(), { tokenML: async () => { throw new Error('refresh recusado'); } }), '?k=chave-ensaio&nf=777');
      assert.ok(e3[2].ok === false && e3[2].etapa === 'token_do_ml' && /refresh recusado/.test(e3[2].erro));
      const e4 = await pedir(montar(nf()), '?k=chave-ensaio&nf=777');
      assert.deepStrictEqual([e4[2].ok, e4[2].etapa, e4[2].status_venda, e4[2].status_carrinho], [false, 'envio_da_venda', 404, 404]);
      roteiroML = { '/orders/2000016131728867': [200, { shipping: { id: 4455 } }], '/shipments/4455': [429, {}] };
      const e5 = await pedir(montar(nf()), '?k=chave-ensaio&nf=777');
      assert.deepStrictEqual([e5[2].ok, e5[2].etapa, e5[2].status], [false, 'envio_no_ml', 429], emp + ': o ML limitando não é "não precisa consertar"');
      /* sem credencial: 404, nada lido */
      chamadas.length = 0; lidasBling.length = 0;
      const sem = await pedir(montar(nf()), '?nf=777');
      assert.deepStrictEqual([sem[0], sem[1], sem[2], lidasBling.length, chamadas.length], [true, 404, { error: 'not found' }, 0, 0]);
      /* sessão de admin vale como credencial */
      roteiroML = { '/orders/2000016131728867': [200, { shipping: { id: 4455 } }], '/shipments/4455': [200, envioAntigo] };
      const adm = await pedir(montar(nf(), { validarSessao: () => ({ user: 'dono' }), ehAdmin: () => true }), '?nf=777');
      assert.strictEqual(adm[2].ok, true, emp + ': a sessão de admin tem que valer');
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }
  console.log('ok — ensaio do conserto da NF recusada pelo ML por endereço: a peça (endereços, comparação, 24 h, nota nova, pendências), sem dado de gente, e a rota nas três (só admin, só leitura, venda e carrinho, cada falha com a etapa)');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
