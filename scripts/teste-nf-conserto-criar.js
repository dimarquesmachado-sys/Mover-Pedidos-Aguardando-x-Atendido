'use strict';
/* 19/11 — CONSERTO DA NF RECUSADA PELO ML POR ENDEREÇO, 2ª etapa: CRIAR A NOTA NOVA NO BLING (a primeira que escreve).
   O dono, à mão: "clono a NF, edito manualmente copiando os dados de endereço q pego dentro do pedido no MLivre, aí colo
   campo por campo na nova NF no Bling, salvo". Esta etapa faz até o "salvo": a nota nasce PENDENTE.

   O que se prova (o código de produção, sem rede de verdade):
   A. o registro (lib/fiscal/nf-conserto-registro): uma nota nova por nota recusada; dúvida não vira "não criou"; nota
      criada não se solta; arquivo ilegível PARA (não é "vazio");
   B. a peça: venda que já saiu é pendência (e só o teste pedido passa por cima); o erro do Bling sai sem os valores da
      pessoa; a nota criada é conferida contra a venda;
   C. a rota, pelo `routes` real das TRÊS empresas: sem credencial 404; sem `confirma=sim` não lê nem escreve;
   D. a rota com o Bling de mentira, nas três: cria UMA vez (o corpo é a nota com o endereço da venda), não repete, e cada
      resposta do Bling cai no lugar certo — recusa conclusiva solta o registro; rede/5xx/408/"ok sem id"/exceção ficam
      como DÚVIDA e barram a repetição até alguém mandar esquecer. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const C = require('../lib/fiscal/nf-conserto-endereco');
const Reg = require('../lib/fiscal/nf-conserto-registro');
const Trav = require('../lib/nf-travadas');

const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-conserto-criar-'));
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
let _n = 0; const pasta = () => { const d = path.join(PASTAS, 'd' + (++_n)); fs.mkdirSync(d, { recursive: true }); return d; };

const AGORA = Date.parse('2026-11-18T15:00:00-03:00');
const nf = (extra) => Object.assign({ id: 777, numero: '130772', situacao: 5, dataEmissao: '2026-11-18 09:00:00', chaveAcesso: '3526'.padEnd(44, '1'), xml: 'https://x/xml',
  numeroPedidoLoja: '2000016131728867', naturezaOperacao: { id: 15 }, loja: { id: 203146903 },
  contato: { id: 9, nome: 'Fulana de Tal', numeroDocumento: '12345678909', telefone: '11988887777', endereco: { endereco: 'Rua das Flores', numero: '10', complemento: '', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '' } },
  serie: 1, valorNota: 62.9, valorFrete: 12.9, itens: [{ codigo: 'A1', descricao: 'Coisa', quantidade: 1, valor: 50 }],
  transporte: { fretePorConta: 0, volumes: [], etiqueta: { nome: 'Fulana de Tal', endereco: 'Rua das Flores', numero: '10', complemento: '', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '' } } }, extra || {});
const END_ML = { street_name: 'Avenida Nova', street_number: '250', comment: 'bloco B', neighborhood: { name: 'Centro' }, city: { name: 'São Paulo' }, state: { id: 'BR-SP' }, zip_code: '04567000' };
const envio = (status) => ({ status: status || 'ready_to_ship', substatus: 'invoice_pending', destination: { shipping_address: END_ML } });

/* ═══ A. o registro ═══ */
{
  const d = pasta();
  assert.deepStrictEqual(Reg.ler(d), {}, 'sem arquivo, o registro é vazio');
  assert.strictEqual(Reg.de(d, 1), null);
  assert.strictEqual(Reg.abrir(d, 1, { numero: '10', pedido_ml: '2000' }), true);
  assert.deepStrictEqual([Reg.de(d, 1).estado, Reg.de(d, 1).numero, Reg.de(d, 1).pedido_ml], ['criando', '10', '2000']);
  assert.strictEqual(Reg.abrir(d, 1, { numero: 'outro' }), false, 'abrir de novo a mesma nota não pode passar');
  assert.strictEqual(Reg.de(d, 1).numero, '10', 'quem chegou primeiro fica com o registro');
  Reg.duvida(d, 1, 'caiu');
  assert.deepStrictEqual([Reg.de(d, 1).estado, Reg.de(d, 1).motivo, Reg.de(d, 1).pedido_ml], ['incerta', 'caiu', '2000']);
  assert.strictEqual(Reg.soltar(d, 1), true); assert.strictEqual(Reg.de(d, 1), null);
  assert.strictEqual(Reg.soltar(d, 1), false, 'soltar o que não existe diz que não soltou');
  Reg.abrir(d, 2, {}); Reg.fechar(d, 2, { id: 999, numero: 130800 });
  assert.deepStrictEqual([Reg.de(d, 2).estado, Reg.de(d, 2).nova_id, Reg.de(d, 2).nova_numero], ['criada', '999', '130800']);
  assert.strictEqual(Reg.soltar(d, 2), false, 'registro de nota CRIADA não se solta'); assert.strictEqual(Reg.de(d, 2).estado, 'criada');
  Reg.abrir(d, 3, {}); assert.strictEqual(Reg.soltar(d, 3), true, 'o "criando" (servidor parou no meio) dá pra soltar');
  /* arquivo ilegível não é arquivo vazio */
  fs.writeFileSync(Reg.arquivo(d), '{ quebrado');
  assert.throws(() => Reg.de(d, 2)); assert.throws(() => Reg.abrir(d, 9, {}));
  fs.writeFileSync(Reg.arquivo(d), '[]'); assert.throws(() => Reg.ler(d), /formato/);
}

/* ═══ B. a peça ═══ */
{
  const p = C.planejar(nf(), envio(), AGORA);
  assert.deepStrictEqual([p.pronta, p.envio_encerrado, p.pendencias], [true, false, []]);
  for (const st of ['shipped', 'delivered', 'not_delivered', 'cancelled']) {
    const pj = C.planejar(nf(), envio(st), AGORA);
    assert.ok(!pj.pronta && pj.envio_encerrado === true && new RegExp('já está "' + st + '"').test(pj.pendencias.join('|')), st + ': venda que já saiu/cancelou não pede nota nova: ' + JSON.stringify(pj.pendencias));
  }
  const teste = C.planejar(nf(), envio('shipped'), AGORA, { aceitaEnvioEncerrado: true });
  assert.deepStrictEqual([teste.pronta, teste.envio_encerrado], [true, true], 'só quem pede de propósito passa por cima — e o plano continua dizendo que o envio encerrou');
  assert.strictEqual(C.semDadoDeGente(C.planejar(nf(), envio('shipped'), AGORA)).envio_encerrado, true);
  assert.strictEqual(C.planejar(nf(), envio('SHIPPED '), AGORA).envio_encerrado, true, 'caixa e espaço no status não enganam');

  /* o erro do Bling sem os valores da pessoa */
  const sujo = 'O contato Fulana de Tal (123.456.789-09, fone 11 98888-7777) na RUA DAS FLORES, 10 tem CEP 04567-000 inválido; campo contato.endereco.cep do item 2';
  const limpo = C.semValoresDe(sujo, nf());
  for (const v of ['Fulana', 'FLORES', 'Flores', '123.456', '98888', '04567']) assert.ok(!limpo.includes(v), 'o erro do Bling saiu com dado de gente (' + v + '): ' + limpo);
  assert.ok(/contato\.endereco\.cep/.test(limpo) && /inválido/.test(limpo) && /item 2/.test(limpo), 'o que interessa (qual campo, por quê) tem que ficar: ' + limpo);
  assert.strictEqual(C.semValoresDe(null, nf()), ''); assert.strictEqual(C.semValoresDe('campo x', null), 'campo x');
  assert.strictEqual(C.semValoresDe('valor (a+b) [x] inválido', { contato: { nome: '(a+b) [x]' } }), 'valor ••• inválido', 'valor com caractere de expressão regular não pode quebrar a limpeza');

  /* a nota criada, conferida contra a venda */
  const doML = C.enderecoDoML(envio());
  const criada = (extra) => Object.assign({ id: 888, numero: '130800', situacao: 1, valorNota: 62.9, naturezaOperacao: { id: 15 }, loja: { id: 203146903 }, itens: [{ codigo: 'A1', descricao: 'Coisa', quantidade: 1, valor: 50 }],
    contato: { endereco: { endereco: 'AVENIDA NOVA', numero: '250', complemento: 'Bloco B', bairro: 'Centro', municipio: 'Sao Paulo', uf: 'SP', cep: '04567-000' } },
    transporte: { etiqueta: { nome: 'x', endereco: 'Avenida Nova', numero: '250', complemento: 'bloco B', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '04567000' } } }, extra || {});
  assert.deepStrictEqual(C.conferirNotaCriada(criada(), nf(), doML), { situacao: 1, endereco_igual_ao_da_venda: true, entrega_igual_ao_da_venda: true, itens: 1, itens_iguais_aos_da_antiga: true,
    valor_igual_ao_da_antiga: true, natureza_igual: true, loja_igual: true, tem_o_pedido_da_loja: false });
  const torta = C.conferirNotaCriada(criada({ valorNota: 60, itens: [{ codigo: 'A1', descricao: 'Coisa', quantidade: 1, valor: 50 }, { codigo: 'A1', descricao: 'Coisa', quantidade: 1, valor: 50 }], naturezaOperacao: { id: 16 }, loja: { id: 1 }, numeroPedidoLoja: '2000016131728867', situacao: { valor: 5 },
    contato: { endereco: Object.assign({}, criada().contato.endereco, { cep: '04567001' }) }, transporte: {} }), nf(), doML);
  assert.deepStrictEqual(torta, { situacao: 5, endereco_igual_ao_da_venda: false, entrega_igual_ao_da_venda: null, itens: 2, itens_iguais_aos_da_antiga: false,
    valor_igual_ao_da_antiga: false, natureza_igual: false, loja_igual: false, tem_o_pedido_da_loja: true }, 'cada diferença aparece; sem etiqueta a entrega é "não sei" (null), não "igual"');
  assert.strictEqual(C.conferirNotaCriada(criada({ valorNota: null }), nf(), doML).valor_igual_ao_da_antiga, null, 'sem o valor, não afirma que é igual');
  assert.strictEqual(C.conferirNotaCriada(null, nf(), doML), null);
  /* Codex #951: mesma quantidade de linhas com outro produto/quantidade/valor NÃO é "itens iguais" (e o total pode bater) */
  const A = { codigo: 'A', quantidade: 1, valor: 100 }, B = { codigo: 'B', quantidade: 2, valor: 50 };
  assert.strictEqual(C.itensIguais([B], [A]), false, 'outro produto com o mesmo total passou por igual');
  assert.strictEqual(C.itensIguais([{ codigo: 'A', quantidade: 2, valor: 100 }], [A]), false); assert.strictEqual(C.itensIguais([{ codigo: 'A', quantidade: 1, valor: 99.99 }], [A]), false);
  assert.strictEqual(C.itensIguais([B, A], [A, B]), true, 'a ordem das linhas não é diferença'); assert.strictEqual(C.itensIguais([{ codigo: ' a ', quantidade: '1.0', valor: '100.00' }], [A]), true, 'formato do número e caixa do código não são diferença');
  assert.strictEqual(C.itensIguais([A, A], [A, B]), false); assert.strictEqual(C.itensIguais([A], [A, B]), false);
  for (const sem of [[{}], [{ codigo: 'A', quantidade: 1 }], [{ codigo: '', quantidade: 1, valor: 100 }], [{ codigo: 'A', quantidade: 'x', valor: 100 }], [null]]) assert.strictEqual(C.itensIguais(sem, [A]), null, 'linha sem código/quantidade/valor é "não sei": ' + JSON.stringify(sem));
  assert.strictEqual(C.itensIguais(undefined, [A]), null); assert.strictEqual(C.itensIguais([A], null), null);
  assert.strictEqual(C.conferirNotaCriada(criada({ itens: [{ codigo: 'B1', descricao: 'Outra', quantidade: 1, valor: 50 }] }), nf(), doML).itens_iguais_aos_da_antiga, false);
  assert.strictEqual(C.conferirNotaCriada(criada({ itens: [{}] }), nf(), doML).itens_iguais_aos_da_antiga, null);
}

/* ═══ C e D. a rota ═══ */
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
process.env.ADMIN_KEY = 'chave-criar';
for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; }
const CE = require('../lib/checkout/config-empresa');
const R = require('../lib/checkout/rota-nf-conserto');

(async () => {
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    /* ═══ C. pelo routes real de cada empresa ═══ */
    for (const [emp, arq] of [['girassol', 'girassol-backup-offline/gbo-app.js'], ['amb', 'amb-checkout-offline/index.js'], ['good', 'good-checkout-offline/index.js']]) {
      const pref = CE.prefixoDe(emp);
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const pedir = async (qs) => { const u = new URL('http://x' + pref + '/nf-conserto-criar' + qs); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
        const t = await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return [t, res._s, res._b]; };
      chamadas.length = 0;
      const semK = await pedir('?nf=777&confirma=sim');
      assert.ok(semK[1] === 404 || semK[1] === 401 || semK[1] === 302, emp + ': sem credencial a rota de criar respondeu ' + semK[1] + ' ' + semK[2].slice(0, 120));
      const semConf = await pedir('?k=chave-criar&nf=777');
      assert.ok(semConf[1] === 200 && /"etapa":"confirmacao"/.test(semConf[2]) && /"escreveu_algo":false/.test(semConf[2]) && /"ensaio":false/.test(semConf[2]), emp + ': sem confirma=sim a fábrica real não pode criar: ' + semConf[1] + ' ' + semConf[2].slice(0, 200));
      assert.ok(!/sem_peca/.test(semConf[2]), emp + ': a fábrica não passou a escrita no Bling/pasta do cache pra rota de criar');
      const ruim = await pedir('?k=chave-criar&nf=abc&confirma=sim');
      assert.ok(ruim[1] === 400 && /só dígitos/.test(ruim[2]), emp + ': id inválido: ' + ruim[1]);
      assert.strictEqual(chamadas.length, 0, emp + ': sem credencial/sem confirmação a rota foi à rede: ' + chamadas.join(', '));
      assert.ok(!fs.existsSync(Reg.arquivo(path.join(PASTAS, emp))), emp + ': sem confirmação não pode nascer registro');
    }

    /* ═══ D. a peça da rota, com o Bling de mentira ═══ */
    for (const emp of ['girassol', 'amb', 'good']) {
      const pref = CE.prefixoDe(emp);
      roteiroML = { '/orders/2000016131728867': [200, { shipping: { id: 4455 } }], '/shipments/4455': [200, envio()] };
      const NOVA = { id: 888, numero: '130800', situacao: 1, valorNota: 62.9, naturezaOperacao: { id: 15 }, loja: { id: 203146903 }, itens: [{ codigo: 'A1', descricao: 'Coisa', quantidade: 1, valor: 50 }],
        contato: { nome: 'Fulana de Tal', endereco: { endereco: 'Avenida Nova', numero: '250', complemento: 'bloco B', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '04567000' } },
        transporte: { etiqueta: { nome: 'Fulana de Tal', endereco: 'Avenida Nova', numero: '250', complemento: 'bloco B', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '04567000' } } };
      /* um cenário: pasta própria, Bling que responde `resp` (valor ou função) ao POST */
      const cena = (resp, extra) => {
        const dir = pasta(); const escritas = []; const lidas = [];
        const rota = R.criar(Object.assign({ empresa: emp, cacheDir: dir, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '', validarSessao: () => null, ehAdmin: () => false,
          tokenML: async () => 'tok-' + emp,
          blingGet: async (c) => { lidas.push(c); if (c === '/nfe/777') return { ok: true, status: 200, data: { data: nf() } }; if (c === '/nfe/888') return { ok: true, status: 200, data: { data: NOVA } }; return { ok: false, status: 404, data: null }; },
          blingWrite: async (m, c, corpo, op) => { escritas.push({ m, c, corpo, op }); return typeof resp === 'function' ? resp(dir, escritas.length) : resp; } }, extra || {}));
        const pedir = async (qs) => { const u = new URL('http://x' + pref + '/nf-conserto-criar?k=chave-criar&nf=777' + (qs == null ? '&confirma=sim' : qs)); const res = {}; await rota({ method: 'GET', headers: {} }, res, u, 'GET', u.pathname); return res._o; };
        return { dir, escritas, lidas, rota, pedir };
      };
      const OK = { ok: true, status: 201, data: { data: { id: 888, numero: '130800' } } };

      /* 1) cria: UMA escrita, com a nota nova (endereço da venda, sem o que é da antiga), sem repetir em queda de rede */
      const a = cena(OK);
      assert.strictEqual(R.atende(pref, 'POST', pref + '/nf-conserto-criar'), false);
      assert.strictEqual(R.caminhoDeCriar(pref), pref + '/nf-conserto-criar');
      const r1 = await a.pedir();
      assert.deepStrictEqual([r1.ok, r1.criou, r1.escreveu_algo, r1.ensaio, r1.empresa, r1.nova, r1.da_nota, r1.pedido_ml, r1.registro_gravado, r1.teste_com_venda_ja_enviada],
        [true, true, true, false, emp, { id: '888', numero: '130800' }, { id: '777', numero: '130772' }, '2000016131728867', true, false], emp + ': criar: ' + JSON.stringify(r1).slice(0, 300));
      assert.strictEqual(a.escritas.length, 1, emp + ': tem que sair UMA escrita no Bling');
      const w = a.escritas[0];
      assert.deepStrictEqual([w.m, w.c, w.op], ['POST', '/nfe', { semRetryDeRede: true }], emp + ': a criação é POST /nfe e NÃO repete em queda de rede (repetir duplica a nota)');
      assert.deepStrictEqual(w.corpo.contato.endereco, { endereco: 'Avenida Nova', numero: '250', complemento: 'bloco B', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '04567000' }, emp + ': a nota nova leva o endereço da VENDA');
      assert.deepStrictEqual(w.corpo.transporte.etiqueta, { nome: 'Fulana de Tal', endereco: 'Avenida Nova', numero: '250', complemento: 'bloco B', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '04567000' });
      for (const k of ['id', 'numero', 'chaveAcesso', 'xml', 'situacao', 'serie', 'valorNota', 'numeroPedidoLoja']) assert.ok(!(k in w.corpo), emp + ': a nota nova foi pro Bling com `' + k + '`');
      assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(w.corpo.dataOperacao) && w.corpo.dataOperacao === w.corpo.dataEmissao && w.corpo.dataOperacao > '2026-11-19', emp + ': a nota vai pro Bling com a data de AGORA (o Bling recusa sem data de operação), não a da antiga: ' + w.corpo.dataOperacao);
      assert.deepStrictEqual([w.corpo.contato.id, w.corpo.naturezaOperacao.id, w.corpo.itens.length, w.corpo.loja, w.corpo.transporte.frete], [9, 15, 1, { id: 203146903, numero: '2000016131728867' }, 12.9], emp + ': a nota vai pro Bling com o nº da venda na loja');
      assert.deepStrictEqual(r1.confere, { situacao: 1, endereco_igual_ao_da_venda: true, entrega_igual_ao_da_venda: true, itens: 1, itens_iguais_aos_da_antiga: true, valor_igual_ao_da_antiga: true, natureza_igual: true, loja_igual: true, tem_o_pedido_da_loja: false });
      assert.deepStrictEqual(a.lidas, ['/nfe/777', '/nfe/888'], emp + ': do Bling lê a nota antiga e relê a criada');
      for (const v of ['Fulana', '12345678909', 'Flores', 'Avenida', '04567', '98888']) assert.ok(!JSON.stringify(r1).includes(v), emp + ': a resposta de criar levou dado de gente: ' + v);
      assert.deepStrictEqual([Reg.de(a.dir, '777').estado, Reg.de(a.dir, '777').nova_id, Reg.de(a.dir, '777').pedido_ml, Reg.de(a.dir, '777').teste], ['criada', '888', '2000016131728867', false]);
      /* 2) de novo: NÃO cria outra — nem lê nada */
      a.lidas.length = 0;
      const r2 = await a.pedir();
      assert.deepStrictEqual([r2.ok, r2.criou, r2.ja_existia, r2.nova, r2.escreveu_algo, a.escritas.length, a.lidas.length], [true, false, true, { id: '888', numero: '130800' }, false, 1, 0], emp + ': a segunda chamada não pode criar outra nota');
      /* nota criada não se esquece */
      const esq = await a.pedir('&esquecer=sim');
      assert.ok(esq.ok === false && esq.etapa === 'esquecer' && /JÁ FOI CRIADA/.test(esq.erro) && Reg.de(a.dir, '777').estado === 'criada', emp + ': esquecer não pode apagar registro de nota criada');
      assert.strictEqual((await a.pedir()).ja_existia, true);

      /* nota que não diz de qual venda é: o nº informado em &pedido= vai pra loja da nota nova */
      const semPed = cena(OK, { blingGet: async (cam) => (cam === '/nfe/777' ? { ok: true, status: 200, data: { data: nf({ numeroPedidoLoja: '' }) } } : { ok: false, status: 404, data: null }) });
      const rsp0 = await semPed.pedir('&confirma=sim&pedido=2000016131728867');
      assert.deepStrictEqual([rsp0.criou, semPed.escritas[0].corpo.loja], [true, { id: 203146903, numero: '2000016131728867' }], emp + ': o nº da venda informado tem que ir na nota nova');
      /* Codex #958: nota que está no aviso do checkout por OUTRO motivo (documento) não é clonada — sairia com o mesmo defeito */
      for (const erroML of ['{"error":"invalid_cnpj"}', 'documento do destinatário inválido']) {
        const om = cena(OK); Trav.registrar(om.dir, { nfeId: '777', numero: '130772', pedidoML: '2000016131728867', erro: erroML });
        const rom = await om.pedir();
        assert.deepStrictEqual([rom.ok, rom.etapa, rom.escreveu_algo, om.escritas.length, om.lidas.length, Reg.de(om.dir, '777')], [false, 'outro_motivo', false, 0, 0, null], emp + ': recusada por documento não cria nota nova: ' + JSON.stringify(rom).slice(0, 200));
        assert.ok(/só troca o endereço/.test(rom.erro));
      }
      /* a recusada por CEP cria; a de OUTRA nota no aviso não atrapalha; registro antigo (sem o campo) vale pelo erro guardado */
      const oc = cena(OK); Trav.registrar(oc.dir, { nfeId: '777', numero: '130772', pedidoML: '2000016131728867', erro: 'wrong_receiver_zipcode' }); Trav.registrar(oc.dir, { nfeId: '999', numero: '1', pedidoML: '2', erro: 'invalid_cnpj' });
      assert.strictEqual((await oc.pedir()).criou, true, emp + ': recusada por CEP cria');
      /* só a nota DESTE conserto conta: a de outra venda recusada por documento, e um aviso de "Consultar situação" da
         própria nota (que não é recusa do ML), não barram */
      const soOutra = cena(OK); Trav.registrar(soOutra.dir, { nfeId: '999', numero: '1', pedidoML: '2', erro: 'invalid_cnpj' });
      assert.strictEqual((await soOutra.pedir()).criou, true, emp + ': aviso de OUTRA nota não barra esta');
      const soSit = cena(OK); fs.writeFileSync(path.join(soSit.dir, '_nf_travadas.json'), JSON.stringify({ 'sit:777': { tipo: 'consultar_situacao', nfe_id: '777', numero: '130772', motivo: 'm', ultima: '2026-11-02' } }));
      assert.strictEqual((await soSit.pedir()).criou, true, emp + ': aviso de "Consultar situação" não é recusa do ML');
      const antigo = cena(OK); fs.writeFileSync(path.join(antigo.dir, '_nf_travadas.json'), JSON.stringify({ '777': { nfe_id: '777', numero: '130772', pedido_ml: '2000016131728867', motivo: 'CEP', erro_do_ml: 'NFe receiver zipcode must be the same as the sale', ultima: '2026-11-01' } }));
      assert.deepStrictEqual([Trav.lista(antigo.dir)[0].conserto, (await antigo.pedir()).criou], ['endereco', true], emp + ': aviso gravado antes de o campo existir vale pelo erro do ML que guardou');
      const antigoDoc = cena(OK); fs.writeFileSync(path.join(antigoDoc.dir, '_nf_travadas.json'), JSON.stringify({ '777': { nfe_id: '777', motivo: 'CNPJ', erro_do_ml: 'invalid_cnpj', ultima: '2026-11-01' }, 'x': { tipo: 'consultar_situacao', nfe_id: '777', ultima: '2026-11-02' } }));
      assert.deepStrictEqual([Trav.lista(antigoDoc.dir).map((t) => t.conserto), (await antigoDoc.pedir()).etapa], [[undefined, null], 'outro_motivo'], emp + ': o aviso de "Consultar situação" não é motivo do ML e não ganha o campo');
      /* 3) sem confirma: nada */
      const b = cena(OK);
      const sc = await b.pedir('');
      assert.deepStrictEqual([sc.ok, sc.etapa, sc.escreveu_algo, b.escritas.length, b.lidas.length, Reg.de(b.dir, '777')], [false, 'confirmacao', false, 0, 0, null]);
      assert.deepStrictEqual([(await b.pedir('&confirma=nao')).etapa, (await b.pedir('&esquecer=sim')).etapa, b.escritas.length], ['confirmacao', 'esquecer', 0], emp + ': confirma tem que ser "sim"; esquecer sem registro diz que não há');

      /* 4) venda que já saiu: não cria; o teste pedido de propósito cria e fica marcado */
      roteiroML['/shipments/4455'] = [200, envio('shipped')];
      const c = cena(OK);
      const foi = await c.pedir();
      assert.deepStrictEqual([foi.ok, foi.etapa, foi.envio_encerrado, foi.escreveu_algo, c.escritas.length, Reg.de(c.dir, '777')], [false, 'plano', true, false, 0, null], emp + ': venda enviada não ganha nota nova: ' + JSON.stringify(foi).slice(0, 200));
      assert.ok(/já está "shipped"/.test(foi.pendencias.join('|')));
      const tst = await c.pedir('&confirma=sim&mesmo_ja_enviado=sim');
      assert.deepStrictEqual([tst.ok, tst.criou, tst.teste_com_venda_ja_enviada, c.escritas.length, Reg.de(c.dir, '777').teste], [true, true, true, 1, true]);
      roteiroML['/shipments/4455'] = [200, envio()];
      const naoEhTeste = cena(OK); const nt = await naoEhTeste.pedir('&confirma=sim&mesmo_ja_enviado=sim');
      assert.deepStrictEqual([nt.teste_com_venda_ja_enviada, Reg.de(naoEhTeste.dir, '777').teste], [false, false], emp + ': o parâmetro de teste numa venda que NÃO saiu não marca a nota como teste');

      /* 5) leitura que falha: a etapa, sem escrever nem abrir registro */
      roteiroML['/shipments/4455'] = [429, {}];
      const d = cena(OK); const lf = await d.pedir();
      assert.deepStrictEqual([lf.ok, lf.etapa, lf.status, lf.escreveu_algo, d.escritas.length, Reg.de(d.dir, '777')], [false, 'envio_no_ml', 429, false, 0, null]);
      roteiroML['/shipments/4455'] = [200, envio()];

      /* 6) RECUSA CONCLUSIVA do Bling: diz o campo, sem dado de gente, e SOLTA o registro (dá pra tentar de novo) */
      const rec = cena((dir, n) => (n === 1 ? { ok: false, status: 400, data: { error: { type: 'VALIDATION_ERROR', message: 'Não foi possível salvar a nota de Fulana de Tal', description: 'Campos inválidos',
        fields: [{ element: 'contato.endereco.cep', msg: 'CEP 04567-000 não encontrado para Avenida Nova' }, { element: 'itens[0].codigo', msg: 'obrigatório' }] } } } : OK));
      const rr = await rec.pedir();
      assert.deepStrictEqual([rr.ok, rr.etapa, rr.status, rr.tipo, rr.escreveu_algo, rr.registro_solto], [false, 'bling_recusou', 400, 'VALIDATION_ERROR', false, true], emp + ': recusa: ' + JSON.stringify(rr).slice(0, 300));
      assert.deepStrictEqual(rr.campos, [{ campo: 'contato.endereco.cep', motivo: 'CEP # não encontrado para •••' }, { campo: 'itens[0].codigo', motivo: 'obrigatório' }]);
      assert.strictEqual(rr.mensagem, 'Não foi possível salvar a nota de •••'); assert.strictEqual(rr.descricao, 'Campos inválidos'); assert.strictEqual(rr.corpo, undefined);
      assert.strictEqual(Reg.de(rec.dir, '777'), null, emp + ': recusa conclusiva tem que soltar o registro');
      assert.deepStrictEqual(rr.campos_enviados, ['contato', 'dataEmissao', 'dataOperacao', 'itens', 'loja', 'naturezaOperacao', 'transporte'], emp + ': a recusa diz QUAIS campos foram mandados (só os nomes)');
      assert.deepStrictEqual([(await rec.pedir()).criou, rec.escritas.length], [true, 2], emp + ': depois da recusa dá pra tentar de novo');
      /* recusa sem o formato de erro do Bling: vai o corpo cru, limpo */
      const cru = cena({ ok: false, status: 422, data: null, raw: 'erro no contato Fulana de Tal 12345678909' });
      const rc = await cru.pedir();
      assert.deepStrictEqual([rc.etapa, rc.corpo, rc.campos], ['bling_recusou', 'erro no contato ••• •••', []]);
      /* 429 e 401: nada criado, registro solto, etapa própria */
      for (const [st, etapa] of [[429, 'bling_ocupado'], [401, 'token_do_bling']]) {
        const x = cena({ ok: false, status: st, data: null }); const rx = await x.pedir();
        assert.deepStrictEqual([rx.ok, rx.etapa, rx.escreveu_algo, Reg.de(x.dir, '777')], [false, etapa, false, null], emp + ': ' + st);
      }

      /* 7) NÃO SEI (rede no meio, 5xx, 408, ok sem id): fica a DÚVIDA, e a próxima chamada NÃO repete */
      for (const [nome, resp] of [['rede', { ok: false, status: 0, data: null, erro: 'rede: socket hang up', ambiguo: true }], ['500', { ok: false, status: 500, data: null }], ['408', { ok: false, status: 408, data: null }],
        ['ok sem id', { ok: true, status: 201, data: { data: {} } }], ['ok sem corpo', { ok: true, status: 200, data: null }]]) {
        const x = cena(resp); const rx = await x.pedir();
        assert.deepStrictEqual([rx.ok, rx.etapa, rx.escreveu_algo, rx.duvida_anotada, x.escritas.length], [false, 'incerta', 'talvez', true, 1], emp + ': ' + nome + ' tem que virar dúvida: ' + JSON.stringify(rx).slice(0, 200));
        assert.ok(/NÃO SEI/.test(rx.erro) && /esquecer=sim/.test(rx.erro));
        assert.strictEqual(Reg.de(x.dir, '777').estado, 'incerta');
        x.lidas.length = 0;
        const de_novo = await x.pedir();
        assert.deepStrictEqual([de_novo.ok, de_novo.etapa, de_novo.escreveu_algo, x.escritas.length, x.lidas.length], [false, 'incerta', false, 1, 0], emp + ': ' + nome + ': a dúvida tem que BARRAR a repetição');
        /* quem olhou o Bling manda esquecer — aí sim tenta de novo */
        const es = await x.pedir('&esquecer=sim');
        assert.deepStrictEqual([es.ok, es.esqueceu, es.estado_que_estava, es.escreveu_algo, Reg.de(x.dir, '777')], [true, true, 'incerta', false, null]);
        await x.pedir(); assert.strictEqual(x.escritas.length, 2, emp + ': ' + nome + ': depois de esquecer, tenta de novo');
      }
      /* a escrita estoura: também é dúvida (o registro "criando" barra) */
      const ex = cena(() => { throw new Error('socket morreu'); }); const rex = await ex.pedir();
      assert.deepStrictEqual([rex.ok, rex.etapa, rex.escreveu_algo, Reg.de(ex.dir, '777').estado], [false, 'incerta', 'talvez', 'criando'], emp + ': exceção no meio: ' + JSON.stringify(rex).slice(0, 200));
      const rex2 = await ex.pedir();
      assert.ok(rex2.etapa === 'incerta' && /o servidor parou no meio/.test(rex2.erro) && ex.escritas.length === 1, emp + ': registro "criando" de uma chamada anterior barra a repetição');
      /* exceção ANTES de abrir o registro (na leitura): nada saiu — é erro simples, sem dúvida */
      const antes = cena(OK, { blingGet: async () => { throw new Error('bling fora'); } }); const ra = await antes.pedir();
      assert.deepStrictEqual([ra.ok, ra.etapa, ra.escreveu_algo, antes.escritas.length, Reg.de(antes.dir, '777')], [false, 'erro', false, 0, null]);

      /* 8) o registro: ilegível PARA antes de qualquer coisa; se some/quebra DEPOIS de criar, a nota é dita criada e a
            próxima chamada não cria outra */
      const q = cena(OK); fs.writeFileSync(Reg.arquivo(q.dir), '{ quebrado');
      const rq = await q.pedir();
      assert.deepStrictEqual([rq.ok, rq.etapa, rq.escreveu_algo, q.escritas.length, q.lidas.length], [false, 'registro', false, 0, 0], emp + ': registro ilegível não pode virar "nunca consertei"');
      assert.strictEqual((await q.pedir('&esquecer=sim')).etapa, 'registro');
      const semDisco = cena(OK, { cacheDir: path.join(PASTAS, 'arquivo-no-lugar-da-pasta-' + emp, 'x') });
      fs.writeFileSync(path.join(PASTAS, 'arquivo-no-lugar-da-pasta-' + emp), 'x');
      const rsd = await semDisco.pedir();
      assert.deepStrictEqual([rsd.ok, rsd.etapa, rsd.escreveu_algo, semDisco.escritas.length], [false, 'registro', false, 0], emp + ': sem conseguir gravar o registro, NÃO cria a nota');
      /* a leitura do registro passou (não havia arquivo) e a GRAVAÇÃO falha: sem registro aberto, NÃO cria */
      const naoGrava = cena(OK); const _bg = naoGrava.lidas;
      const rotaNG = R.criar({ empresa: emp, cacheDir: naoGrava.dir, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '', validarSessao: () => null, ehAdmin: () => false, tokenML: async () => 't',
        blingGet: async (cam) => { _bg.push(cam); fs.mkdirSync(Reg.arquivo(naoGrava.dir), { recursive: true }); return { ok: true, status: 200, data: { data: nf() } }; },
        blingWrite: async (m, cam, corpo) => { naoGrava.escritas.push({ m, cam, corpo }); return OK; } });
      const uNG = new URL('http://x' + pref + '/nf-conserto-criar?k=chave-criar&nf=777&confirma=sim'); const resNG = {};
      await rotaNG({ method: 'GET', headers: {} }, resNG, uNG, 'GET', uNG.pathname);
      assert.deepStrictEqual([resNG._o.ok, resNG._o.etapa, resNG._o.escreveu_algo, naoGrava.escritas.length], [false, 'registro', false, 0], emp + ': não gravou o registro e criou a nota assim mesmo: ' + JSON.stringify(resNG._o).slice(0, 200));
      assert.ok(/sem ele não crio a nota/.test(resNG._o.erro));
      const quebraNoMeio = cena((dir) => { fs.writeFileSync(Reg.arquivo(dir), '{ quebrado'); return OK; });
      const rqm = await quebraNoMeio.pedir();
      assert.deepStrictEqual([rqm.ok, rqm.criou, rqm.registro_gravado, rqm.nova.id], [true, true, false, '888'], emp + ': criou e não conseguiu fechar o registro: diz as duas coisas');
      assert.deepStrictEqual([(await quebraNoMeio.pedir()).etapa, quebraNoMeio.escritas.length], ['registro', 1], emp + ': e não cria outra');

      /* 9) dois cliques ao mesmo tempo: UMA escrita */
      let soltarPost = null; const travado = cena(() => new Promise((ok) => { soltarPost = () => ok(OK); }));
      const p1 = travado.pedir();
      for (let i = 0; i < 50 && !soltarPost; i++) await new Promise((r) => setImmediate(r));
      assert.ok(soltarPost, emp + ': a primeira chamada tinha que estar parada no POST');
      const p2 = await travado.pedir();
      assert.deepStrictEqual([p2.ok, p2.etapa, p2.escreveu_algo], [false, 'em_andamento', false]);
      assert.strictEqual((await travado.pedir('&esquecer=sim')).etapa, 'em_andamento', emp + ': esquecer no meio de uma criação soltaria o registro e deixaria duplicar');
      soltarPost(); const p1r = await p1;
      assert.deepStrictEqual([p1r.criou, travado.escritas.length], [true, 1]);

      /* 10) a releitura da nota criada falha: a nota existe mesmo assim */
      const semReler = cena(OK, { blingGet: async (cam) => (cam === '/nfe/777' ? { ok: true, status: 200, data: { data: nf() } } : { ok: false, status: 429, data: null }) });
      const rsr = await semReler.pedir();
      assert.deepStrictEqual([rsr.ok, rsr.criou, rsr.confere, Reg.de(semReler.dir, '777').estado], [true, true, null, 'criada']);
      const relerEstoura = cena(OK, { blingGet: async (cam) => { if (cam === '/nfe/777') return { ok: true, status: 200, data: { data: nf() } }; throw new Error('bling caiu'); } });
      const rre = await relerEstoura.pedir();
      assert.deepStrictEqual([rre.ok, rre.criou, rre.escreveu_algo, rre.confere, rre.nova.id, Reg.de(relerEstoura.dir, '777').estado], [true, true, true, null, '888', 'criada'], emp + ': a releitura estourando não pode esconder que a nota foi criada: ' + JSON.stringify(rre).slice(0, 200));

      /* 11) empresa que não passa a escrita/pasta: diz que falta a peça, sem tentar; e o ensaio continua só lendo */
      for (const falta of [{ blingWrite: undefined }, { cacheDir: undefined }]) {
        const sp = cena(OK, falta); const rsp = await sp.pedir();
        assert.deepStrictEqual([rsp.ok, rsp.etapa, rsp.escreveu_algo, sp.lidas.length], [false, 'sem_peca', false, 0]);
      }
      const en = cena(OK); const uE = new URL('http://x' + pref + '/nf-conserto-ensaio?k=chave-criar&nf=777&confirma=sim'); const resE = {};
      await en.rota({ method: 'GET', headers: {} }, resE, uE, 'GET', uE.pathname);
      assert.deepStrictEqual([resE._o.ok, resE._o.ensaio, resE._o.escreveu_algo, resE._o.envio_encerrado, en.escritas.length, Reg.de(en.dir, '777')], [true, true, false, false, 0, null], emp + ': o ensaio não pode escrever nem abrir registro, com confirma ou sem');
      /* sem credencial: 404, nada */
      const semCred = cena(OK); const uS = new URL('http://x' + pref + '/nf-conserto-criar?nf=777&confirma=sim'); const resS = {};
      await semCred.rota({ method: 'GET', headers: {} }, resS, uS, 'GET', uS.pathname);
      assert.deepStrictEqual([resS._s, resS._o, semCred.escritas.length, semCred.lidas.length], [404, { error: 'not found' }, 0, 0]);
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }
  console.log('ok — conserto da NF, criar a nota nova no Bling: o registro (uma por nota, dúvida não é "não criou"), a peça (venda encerrada, erro sem dado de gente, conferência) e a rota nas três (só admin, só com confirma, UMA escrita, cada resposta do Bling no seu lugar)');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
