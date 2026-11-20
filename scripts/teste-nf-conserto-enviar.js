'use strict';
/* 19/11 — CONSERTO DA NF RECUSADA PELO ML POR ENDEREÇO, 3ª etapa: EMITIR a nota nova e mandar o XML ao ML.
   O dono, à mão: "clico pra enviar NF, a Sefaz então autoriza, daí eu clico pra baixar o XML, extraio do Zip no meu
   computador, e daí, vou no Mlivre, dentro do pedido em INFORMAR NF JÁ EMITIDA, e lá eu anexo o XML, confirmo, e pronto".

   O que se prova (o código de produção, sem rede de verdade), nas TRÊS empresas:
   A. pelo `routes` real: sem credencial 404; sem `confirma=sim` não lê nem escreve;
   B. só emite nota que ESTA rotina criou: sem registro, registro em dúvida e nota de TESTE não passam;
   C. nota pendente: confere de novo contra a venda (venda encerrada e endereço diferente NÃO emitem), pede a emissão UMA
      vez (sem repetir em queda de rede) e, autorizada na hora, manda o XML ao ML na mesma chamada;
   D. nota autorizada: manda o XML ao ML (o envio de produção, lib/fiscal/ml-api), anota e tira a nota recusada do aviso
      do checkout; chamada de novo, não manda outra vez;
   E. cada resposta no seu lugar: Bling recusa a emissão / não responde; SEFAZ rejeita; nota cancelada; ML não pede a
      nota / recusa / erro passageiro — e a resposta nunca leva dado de gente. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const Reg = require('../lib/fiscal/nf-conserto-registro');
const Trav = require('../lib/nf-travadas');

const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-conserto-enviar-'));
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
let _n = 0; const pasta = () => { const d = path.join(PASTAS, 'd' + (++_n)); fs.mkdirSync(d, { recursive: true }); return d; };

const PED = '2000016131728867';
const END_ML = { street_name: 'Avenida Nova', street_number: '250', comment: 'bloco B', neighborhood: { name: 'Centro' }, city: { name: 'São Paulo' }, state: { id: 'BR-SP' }, zip_code: '04567000' };
const envio = (status, sub) => ({ status: status || 'ready_to_ship', substatus: sub === undefined ? 'invoice_pending' : sub, destination: { shipping_address: END_ML } });
const notaNova = (sit, extra) => Object.assign({ id: 888, numero: '130800', situacao: sit, valorNota: 62.9, naturezaOperacao: { id: 15 }, loja: { id: 203146903 }, itens: [{ codigo: 'A1', quantidade: 1, valor: 50 }],
  contato: { nome: 'Fulana de Tal', numeroDocumento: '12345678909', endereco: { endereco: 'Avenida Nova', numero: '250', complemento: 'bloco B', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '04567000' } },
  transporte: { etiqueta: { nome: 'Fulana de Tal', endereco: 'Avenida Nova', numero: '250', complemento: 'bloco B', bairro: 'Centro', municipio: 'São Paulo', uf: 'SP', cep: '04567000' } } },
  sit >= 5 && sit <= 7 ? { xml: 'https://bling.exemplo/xml/888' } : {}, extra || {});

/* a nota RECUSADA (777): a mesma venda — itens, valor, natureza e loja da nova */
const ANTIGA = { id: 777, numero: '130772', situacao: 5, valorNota: 62.9, naturezaOperacao: { id: 15 }, loja: { id: 203146903 }, itens: [{ codigo: 'A1', quantidade: 1, valor: 50 }] };

const chamadas = [];
let roteiroML = {};
const nfetch = require.resolve('node-fetch');
require.cache[nfetch] = { id: nfetch, filename: nfetch, loaded: true, exports: async (url, opts) => {
  const u = String(url); const m = (opts && opts.method) || 'GET'; chamadas.push(m + ' ' + u);
  if (u === 'https://bling.exemplo/xml/888') return { ok: true, status: 200, text: async () => '<nfeProc>xml-da-888</nfeProc>', json: async () => ({}) };
  if (!u.startsWith('https://api.mercadolibre.com')) throw new Error('rede bloqueada no teste: ' + u);
  const chave = (m === 'GET' ? '' : m + ' ') + u.replace('https://api.mercadolibre.com', '');
  const r = roteiroML[chave] || [404, { message: 'not found' }];
  if (m !== 'GET') chamadas.push('CORPO ' + String(opts && opts.body));
  return { ok: r[0] >= 200 && r[0] < 300, status: r[0], json: async () => r[1], text: async () => JSON.stringify(r[1]) };
} };
for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
process.env.ADMIN_KEY = 'chave-enviar';
for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; }
const CE = require('../lib/checkout/config-empresa');
const R = require('../lib/checkout/rota-nf-conserto');

(async () => {
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    /* ═══ A. pelo routes real ═══ */
    for (const [emp, arq] of [['girassol', 'girassol-backup-offline/gbo-app.js'], ['amb', 'amb-checkout-offline/index.js'], ['good', 'good-checkout-offline/index.js']]) {
      const pref = CE.prefixoDe(emp);
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const pedir = async (qs) => { const u = new URL('http://x' + pref + '/nf-conserto-enviar' + qs); const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
        await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return [res._s, res._b]; };
      chamadas.length = 0;
      const semK = await pedir('?nf=777&confirma=sim');
      assert.ok(semK[0] === 404 || semK[0] === 401 || semK[0] === 302, emp + ': sem credencial a rota de enviar respondeu ' + semK[0]);
      const semConf = await pedir('?k=chave-enviar&nf=777');
      assert.ok(semConf[0] === 200 && /"etapa":"confirmacao"/.test(semConf[1]) && /"escreveu_algo":false/.test(semConf[1]) && /"ensaio":false/.test(semConf[1]) && !/sem_peca/.test(semConf[1]), emp + ': sem confirma=sim: ' + semConf[0] + ' ' + semConf[1].slice(0, 200));
      const semReg = await pedir('?k=chave-enviar&nf=777&confirma=sim');
      assert.ok(/"etapa":"sem_nota_nova"/.test(semReg[1]), emp + ': sem nota nova criada, a fábrica real não pode emitir nada: ' + semReg[1].slice(0, 200));
      assert.strictEqual(chamadas.length, 0, emp + ': a rota foi à rede sem ter o que emitir: ' + chamadas.join(', '));
    }

    for (const emp of ['girassol', 'amb', 'good']) {
      const pref = CE.prefixoDe(emp);
      assert.strictEqual(R.atende(pref, 'POST', pref + '/nf-conserto-enviar'), false); assert.strictEqual(R.atende(pref, 'GET', R.caminhoDeEnviar(pref)), true);
      roteiroML = { ['/orders/' + PED]: [200, { shipping: { id: 4455 } }], '/shipments/4455': [200, envio()], 'POST /shipments/4455/invoice_data/?siteId=MLB': [200, { ok: true }] };
      /* um cenário: registro com a nota nova criada (ou o que `reg` mandar), o Bling devolvendo `notas` em sequência (a
         última se repete) e respondendo `respEnviar` ao pedido de emissão */
      const cena = (notas, respEnviar, op) => {
        op = op || {};
        const dir = pasta(); const escritas = []; const lidas = []; const aoML = [];
        if (op.reg !== null) { Reg.abrir(dir, '777', Object.assign({ numero: '130772', pedido_ml: PED, teste: false }, op.reg || {})); if (!op.semFechar) Reg.fechar(dir, '777', { id: 888, numero: '130800' }); }
        if (op.anotar) Reg.anotar(dir, '777', op.anotar);
        let i = 0;
        const extra = Object.assign({}, op.extra || {});
        if (op.mlFalso) extra.enviarNFeParaML = async (tok, ped, nfD) => { aoML.push([tok, ped, nfD && nfD.id]); return op.mlFalso(); };
        const rota = R.criar(Object.assign({ empresa: emp, cacheDir: dir, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '', validarSessao: () => null, ehAdmin: () => false,
          tokenML: async () => 'tok-' + emp,
          blingGet: async (c) => { lidas.push(c); if (c === '/nfe/777') { const a = op.antiga === undefined ? ANTIGA : op.antiga; return a ? { ok: true, status: 200, data: { data: a } } : { ok: false, status: 429, data: null }; } const n = notas[Math.min(i++, notas.length - 1)]; return n === 404 ? { ok: false, status: 404, data: null } : (n ? { ok: true, status: 200, data: { data: n } } : { ok: false, status: 429, data: null }); },
          blingWrite: async (m, c, corpo, o2) => { escritas.push({ m, c, corpo, o2 }); return typeof respEnviar === 'function' ? respEnviar(dir) : respEnviar; } }, extra));
        const pedir = async (qs) => { const u = new URL('http://x' + pref + '/nf-conserto-enviar?k=chave-enviar&nf=777' + (qs == null ? '&confirma=sim' : qs)); const res = {}; await rota({ method: 'GET', headers: {} }, res, u, 'GET', u.pathname); return res._o; };
        return { dir, escritas, lidas, aoML, pedir };
      };
      const OK = { ok: true, status: 200, data: { data: {} } };
      const semGente = (o, emp2) => { for (const v of ['Fulana', '12345678909', 'Avenida', '04567', 'bloco B']) assert.ok(!JSON.stringify(o).includes(v), emp2 + ': a resposta levou dado de gente: ' + v + ' → ' + JSON.stringify(o).slice(0, 300)); };

      /* ═══ B. só nota que esta rotina criou ═══ */
      const b1 = cena([notaNova(1)], OK, { reg: null }); const rb1 = await b1.pedir();
      assert.deepStrictEqual([rb1.ok, rb1.etapa, rb1.escreveu_algo, rb1.fez, b1.lidas.length, b1.escritas.length], [false, 'sem_nota_nova', false, [], 0, 0]);
      const b2 = cena([notaNova(1)], OK, { semFechar: true }); const rb2 = await b2.pedir();
      assert.deepStrictEqual([rb2.etapa, b2.lidas.length, b2.escritas.length], ['incerta', 0, 0], emp + ': criação em dúvida não emite');
      const b3 = cena([notaNova(1)], OK, { reg: { teste: true } }); const rb3 = await b3.pedir();
      assert.deepStrictEqual([rb3.ok, rb3.etapa, rb3.nova, b3.lidas.length, b3.escritas.length], [false, 'nota_de_teste', { id: '888', numero: '130800' }, 0, 0], emp + ': nota de TESTE nunca é emitida');
      const b4 = cena([notaNova(1)], OK); const rb4 = await b4.pedir('');
      assert.deepStrictEqual([rb4.etapa, b4.lidas.length, b4.escritas.length], ['confirmacao', 0, 0]);
      const b5 = cena([notaNova(1)], OK); fs.writeFileSync(Reg.arquivo(b5.dir), '{ quebrado');
      assert.deepStrictEqual([(await b5.pedir()).etapa, b5.escritas.length], ['registro', 0]);
      const b6 = cena([notaNova(1)], OK, { reg: { pedido_ml: '' } });
      assert.deepStrictEqual([(await b6.pedir()).etapa, b6.escritas.length], ['pedido_do_ml', 0]);
      for (const falta of [{ blingWrite: undefined }, { cacheDir: undefined }]) { const sp = cena([notaNova(1)], OK, { extra: falta }); assert.deepStrictEqual([(await sp.pedir()).etapa, sp.lidas.length], ['sem_peca', 0]); }

      /* ═══ C. nota pendente ═══ */
      /* pede a emissão UMA vez; a SEFAZ autoriza na hora → manda o XML ao ML na mesma chamada (o envio de PRODUÇÃO) */
      chamadas.length = 0;
      const c1 = cena([notaNova(1), notaNova(5)], OK);
      Trav.registrar(c1.dir, { nfeId: '777', numero: '130772', pedidoML: PED, erro: 'wrong_receiver_zipcode' });
      Trav.registrar(c1.dir, { nfeId: '555', numero: '130001', pedidoML: '2000099', erro: 'wrong_receiver_zipcode' });
      const r1 = await c1.pedir();
      assert.deepStrictEqual([r1.ok, r1.etapa, r1.fez, r1.escreveu_algo, r1.nova, r1.situacao, r1.pedido_ml, r1.registro_gravado, r1.saiu_do_aviso_do_checkout, r1.ensaio, r1.empresa],
        [true, 'no_ml', ['pediu_emissao', 'mandou_xml_ao_ml'], true, { id: '888', numero: '130800' }, 5, PED, true, 1, false, emp], emp + ': pendente → autorizada → ML: ' + JSON.stringify(r1).slice(0, 300));
      assert.deepStrictEqual(c1.escritas.map((w) => [w.m, w.c, w.o2]), [['POST', '/nfe/888/enviar', { semRetryDeRede: true }]], emp + ': a emissão é UM POST /nfe/{id}/enviar na nota NOVA, sem repetir em queda de rede');
      assert.deepStrictEqual(c1.lidas, ['/nfe/888', '/nfe/777', '/nfe/888'], emp + ': lê a nota nova, confere contra a recusada (só LEITURA — a 777 não é escrita) e relê a nova depois de pedir a emissão');
      assert.deepStrictEqual(chamadas.filter((c) => !c.startsWith('GET https://api.mercadolibre.com')), ['GET https://bling.exemplo/xml/888', 'POST https://api.mercadolibre.com/shipments/4455/invoice_data/?siteId=MLB', 'CORPO <nfeProc>xml-da-888</nfeProc>'], emp + ': o XML da nota nova vai pro envio da venda: ' + chamadas.join(' | '));
      assert.ok(Reg.de(c1.dir, '777').no_ml_em && Reg.de(c1.dir, '777').sefaz_pedida_em && Reg.de(c1.dir, '777').estado === 'criada' && Reg.de(c1.dir, '777').nova_id === '888');
      assert.deepStrictEqual(Trav.lista(c1.dir).map((t) => t.nfe_id), ['555'], emp + ': aceita pelo ML, a nota recusada DESSA venda sai do aviso — a de outra venda fica');
      semGente(r1, emp);
      /* de novo: não emite nem manda outra vez */
      c1.lidas.length = 0; chamadas.length = 0;
      const r1b = await c1.pedir();
      assert.deepStrictEqual([r1b.ok, r1b.etapa, r1b.ja_estava, r1b.fez, r1b.escreveu_algo, c1.escritas.length, c1.lidas.length, chamadas.length], [true, 'no_ml', true, [], false, 1, 0, 0], emp + ': segunda chamada não pode repetir nada');

      /* a venda saiu entre criar e emitir: NÃO emite */
      for (const st of ['shipped', 'cancelled']) {
        roteiroML['/shipments/4455'] = [200, envio(st, null)];
        const c2 = cena([notaNova(1)], OK); const r2 = await c2.pedir();
        assert.deepStrictEqual([r2.ok, r2.etapa, r2.fez, r2.escreveu_algo, c2.escritas.length, Reg.de(c2.dir, '777').sefaz_pedida_em], [false, 'envio_encerrado', [], false, 0, undefined], emp + ': venda "' + st + '" não pode emitir nota: ' + JSON.stringify(r2).slice(0, 200));
        assert.ok(/NÃO emiti/.test(r2.erro));
      }
      roteiroML['/shipments/4455'] = [200, envio()];
      /* a nota no Bling não tem (mais) o endereço da venda: NÃO emite */
      const outroCep = notaNova(1); outroCep.contato.endereco.cep = '04567001';
      const c3 = cena([outroCep], OK); const r3 = await c3.pedir();
      assert.deepStrictEqual([r3.ok, r3.etapa, r3.endereco_igual_ao_da_venda, r3.fez, c3.escritas.length], [false, 'nota_diferente_da_venda', false, [], 0], emp + ': endereço diferente do da venda não emite');
      const outraEntrega = notaNova(1); outraEntrega.transporte.etiqueta.cep = '01001000';
      const c3b = cena([outraEntrega], OK); const r3b = await c3b.pedir();
      assert.deepStrictEqual([r3b.etapa, r3b.entrega_igual_ao_da_venda, c3b.escritas.length], ['nota_diferente_da_venda', false, 0], emp + ': endereço de ENTREGA diferente também não emite');
      const semEtiqueta = notaNova(1); delete semEtiqueta.transporte;
      const c3c = cena([semEtiqueta, notaNova(1)], OK); assert.deepStrictEqual([(await c3c.pedir()).etapa, c3c.escritas.length], ['aguardando_sefaz', 1], emp + ': nota sem endereço de entrega próprio vale pelo do destinatário');
      semGente(r3, emp);
      /* Codex #958: a nota nova que NÃO é a mesma venda da recusada (itens, valor, natureza, loja) não é emitida — quem emite
         confere, não depende de alguém ter lido o `confere` da criação */
      for (const [nome, antiga, em] of [['valor', Object.assign({}, ANTIGA, { valorNota: 99.9 }), ['valor_igual_ao_da_antiga']], ['itens', Object.assign({}, ANTIGA, { itens: [{ codigo: 'B2', quantidade: 1, valor: 50 }] }), ['itens_iguais_aos_da_antiga']],
        ['quantidade', Object.assign({}, ANTIGA, { itens: [{ codigo: 'A1', quantidade: 2, valor: 50 }] }), ['itens_iguais_aos_da_antiga']], ['natureza', Object.assign({}, ANTIGA, { naturezaOperacao: { id: 16 } }), ['natureza_igual']], ['loja', Object.assign({}, ANTIGA, { loja: { id: 1 } }), ['loja_igual']],
        ['tudo', { id: 777, valorNota: 1, itens: [], naturezaOperacao: { id: 9 }, loja: { id: 9 } }, ['itens_iguais_aos_da_antiga', 'valor_igual_ao_da_antiga', 'natureza_igual', 'loja_igual']]]) {
        const cd = cena([notaNova(1)], OK, { antiga }); const rd = await cd.pedir();
        assert.deepStrictEqual([rd.ok, rd.etapa, rd.diferente_em, rd.fez, rd.escreveu_algo, cd.escritas.length, Reg.de(cd.dir, '777').sefaz_pedida_em], [false, 'nota_diferente_da_antiga', em, [], false, 0, undefined], emp + ': nota nova diferente da recusada em ' + nome + ' não pode ser emitida: ' + JSON.stringify(rd).slice(0, 260));
        assert.ok(/NÃO emiti/.test(rd.erro)); semGente(rd, emp);
      }
      /* sem conseguir ler a recusada: não sei — e "não sei" não emite */
      const semA = cena([notaNova(1)], OK, { antiga: null }); const rsa = await semA.pedir();
      assert.deepStrictEqual([rsa.ok, rsa.etapa, rsa.status, rsa.fez, semA.escritas.length], [false, 'nota_no_bling', 429, [], 0], emp + ': sem ler a nota recusada, não emite');
      /* a recusada que não traz itens/valor comparáveis: "não sei" desses campos não barra (natureza e loja batem) */
      const semDado = cena([notaNova(1)], OK, { antiga: { id: 777, naturezaOperacao: { id: 15 }, loja: { id: 203146903 } } });
      assert.deepStrictEqual([(await semDado.pedir()).etapa, semDado.escritas.length], ['aguardando_sefaz', 1]);
      /* não deu pra ler o envio da venda: não emite */
      roteiroML['/shipments/4455'] = [429, {}];
      const c4 = cena([notaNova(1)], OK); const r4 = await c4.pedir();
      assert.deepStrictEqual([r4.ok, r4.etapa, r4.status, c4.escritas.length], [false, 'envio_no_ml', 429, 0]);
      roteiroML['/shipments/4455'] = [200, envio()];
      /* pediu e a nota segue pendente: espera; chamada de novo logo em seguida NÃO pede outra vez; passado o tempo, pede */
      const c5 = cena([notaNova(1)], OK); const r5 = await c5.pedir();
      assert.deepStrictEqual([r5.ok, r5.etapa, r5.fez, r5.escreveu_algo, c5.escritas.length], [true, 'aguardando_sefaz', ['pediu_emissao'], true, 1]);
      const r5b = await c5.pedir();
      assert.deepStrictEqual([r5b.ok, r5b.etapa, r5b.fez, r5b.escreveu_algo, c5.escritas.length], [true, 'aguardando_sefaz', [], false, 1], emp + ': pedido de emissão recente não se repete');
      Reg.anotar(c5.dir, '777', { sefaz_pedida_em: new Date(Date.now() - 10 * 60000).toISOString() });
      await c5.pedir(); assert.strictEqual(c5.escritas.length, 2, emp + ': passado o tempo de espera e ainda pendente, pede de novo');
      /* o Bling recusa a emissão (validação): diz o motivo sem dado de gente, e pode pedir de novo já */
      const c6 = cena([notaNova(1)], { ok: false, status: 400, data: { error: { type: 'VALIDATION_ERROR', message: 'Nota de Fulana de Tal não pode ser enviada', description: 'x', fields: [{ element: 'cep', msg: 'CEP 04567-000 inválido' }] } } });
      const r6 = await c6.pedir();
      assert.deepStrictEqual([r6.ok, r6.etapa, r6.status, r6.fez, r6.escreveu_algo, r6.mensagem, r6.campos], [false, 'bling_recusou_a_emissao', 400, [], false, 'Nota de ••• não pode ser enviada', [{ campo: 'cep', motivo: 'CEP # inválido' }]], emp + ': recusa da emissão: ' + JSON.stringify(r6).slice(0, 300));
      assert.ok(!Reg.de(c6.dir, '777').sefaz_pedida_em, emp + ': recusa conclusiva não deixa a espera armada');
      await c6.pedir(); assert.strictEqual(c6.escritas.length, 2);
      const c6b = cena([notaNova(1)], { ok: false, status: 429, data: null }); assert.deepStrictEqual([(await c6b.pedir()).etapa, !Reg.de(c6b.dir, '777').sefaz_pedida_em], ['bling_ocupado', true]);
      /* o Bling não respondeu de forma conclusiva: não sabe se pediu — espera e olha de novo (não repete na hora) */
      for (const resp of [{ ok: false, status: 0, data: null, ambiguo: true }, { ok: false, status: 500, data: null }, { ok: false, status: 408, data: null }]) {
        const c7 = cena([notaNova(1)], resp); const r7 = await c7.pedir();
        assert.deepStrictEqual([r7.ok, r7.etapa, r7.fez, r7.escreveu_algo], [false, 'aguardando_sefaz', ['pediu_emissao'], true], emp + ': resposta ' + resp.status + ' é "não sei": ' + JSON.stringify(r7).slice(0, 200));
        await c7.pedir(); assert.strictEqual(c7.escritas.length, 1, emp + ': depois de um "não sei", não repete o pedido na hora');
      }
      /* sem conseguir anotar o pedido no registro, não emite */
      const c8b = (() => { const dir = pasta(); Reg.abrir(dir, '777', { pedido_ml: PED }); Reg.fechar(dir, '777', { id: 888, numero: '130800' }); const escr = [];
        const rota = R.criar({ empresa: emp, cacheDir: dir, json: (res, st, o) => { res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '', validarSessao: () => null, ehAdmin: () => false, tokenML: async () => 't',
          blingGet: async () => { try { fs.rmSync(Reg.arquivo(dir)); fs.mkdirSync(Reg.arquivo(dir)); } catch (e) {} return { ok: true, status: 200, data: { data: notaNova(1) } }; },
          blingWrite: async (m, c) => { escr.push(c); return OK; } });
        return { rota, escr }; })();
      const u8 = new URL('http://x' + pref + '/nf-conserto-enviar?k=chave-enviar&nf=777&confirma=sim'); const res8 = {};
      await c8b.rota({ method: 'GET', headers: {} }, res8, u8, 'GET', u8.pathname);
      assert.deepStrictEqual([res8._o.ok, res8._o.etapa, res8._o.fez, c8b.escr.length], [false, 'registro', [], 0], emp + ': sem anotar o pedido de emissão, não emite: ' + JSON.stringify(res8._o).slice(0, 200));

      /* ═══ D. nota já autorizada (emitida por fora, ou numa chamada anterior) ═══ */
      for (const sit of [5, 6, 7]) {
        const d1 = cena([notaNova(sit)], OK, { mlFalso: async () => ({}) }); const rd1 = await d1.pedir();
        assert.deepStrictEqual([rd1.ok, rd1.etapa, rd1.fez, d1.escritas.length, d1.aoML], [true, 'no_ml', ['mandou_xml_ao_ml'], 0, [['tok-' + emp, PED, 888]]], emp + ': situação ' + sit + ' vai direto pro ML, sem pedir emissão de novo');
      }
      const d2 = cena([notaNova(5, { xml: '' })], OK, { mlFalso: async () => ({}) }); const rd2 = await d2.pedir();
      assert.deepStrictEqual([rd2.ok, rd2.etapa, rd2.fez, d2.aoML.length], [true, 'aguardando_xml', [], 0], emp + ': autorizada sem o endereço do XML: espera');
      const d3 = cena([notaNova(5)], OK, { mlFalso: async () => ({}), extra: { tokenML: async () => { throw new Error('refresh recusado'); } } }); const rd3 = await d3.pedir();
      assert.ok(rd3.ok === false && rd3.etapa === 'token_do_ml' && /refresh recusado/.test(rd3.erro) && d3.aoML.length === 0);
      const d4 = cena([notaNova(5)], OK, { mlFalso: async () => ({}), extra: { tokenML: async () => '' } }); const rd4 = await d4.pedir();
      assert.deepStrictEqual([rd4.ok, rd4.etapa, rd4.fez, d4.aoML.length, !!Reg.de(d4.dir, '777').no_ml_em], [false, 'token_do_ml', [], 0, false], emp + ': token vazio não pode seguir pro envio');

      /* ═══ E. cada resposta no seu lugar ═══ */
      const erroML = (msg, st, sub) => async () => { throw Object.assign(new Error(msg), st ? { mlStatus: st, mlSubstatus: sub || null } : {}); };
      const e1 = cena([notaNova(5)], OK, { mlFalso: erroML('Shipment 4455 status=ready_to_ship substatus=buffered (não é invoice_pending)', 'ready_to_ship', 'buffered') }); const re1 = await e1.pedir();
      assert.deepStrictEqual([re1.ok, re1.etapa, re1.ml_status, re1.ml_substatus, re1.fez, re1.escreveu_algo, !!Reg.de(e1.dir, '777').no_ml_em], [false, 'ml_nao_pede_nota', 'ready_to_ship', 'buffered', [], false, false]);
      const e2 = cena([notaNova(5)], OK, { mlFalso: erroML('Shipment 4455 status=shipped (não é invoice_pending)', 'shipped') }); const re2 = await e2.pedir();
      assert.deepStrictEqual([re2.etapa, re2.ml_status, !!Reg.de(e2.dir, '777').no_ml_em], ['envio_encerrado', 'shipped', false]);
      const e3 = cena([notaNova(5)], OK, { mlFalso: erroML('GIRASSOL ML envio NF shipment=4455 erro 400: {"error":"wrong_receiver_zipcode","message":"NFe receiver zipcode must be the same as the sale"} de Fulana de Tal CEP 04567-000') });
      Trav.registrar(e3.dir, { nfeId: '777', numero: '130772', pedidoML: PED, erro: 'wrong_receiver_zipcode' });
      const re3 = await e3.pedir();
      assert.deepStrictEqual([re3.ok, re3.etapa, re3.fez, !!Reg.de(e3.dir, '777').no_ml_em, Trav.lista(e3.dir).length], [false, 'ml_recusou', [], false, 1], emp + ': o ML recusar a nota nova não tira o aviso nem anota como entregue: ' + JSON.stringify(re3).slice(0, 300));
      assert.ok(/CEP da NF diferente/.test(re3.erro) && /wrong_receiver_zipcode/.test(re3.do_ml)); semGente(re3, emp);
      const e4 = cena([notaNova(5)], OK, { mlFalso: erroML('GIRASSOL ML envio NF shipment=4455 erro 503: upstream') }); const re4 = await e4.pedir();
      assert.deepStrictEqual([re4.ok, re4.etapa, !!Reg.de(e4.dir, '777').no_ml_em], [false, 'ml_erro', false]);
      /* a nota nova no Bling */
      const e5 = cena([404], OK); const re5 = await e5.pedir();
      assert.ok(re5.ok === false && re5.etapa === 'nota_nova_no_bling' && re5.status === 404 && /não existe mais/.test(re5.erro) && e5.escritas.length === 0);
      const e6 = cena([null], OK); const re6 = await e6.pedir();
      assert.ok(re6.etapa === 'nota_nova_no_bling' && re6.status === 429 && !/não existe mais/.test(re6.erro), emp + ': Bling limitando não é "a nota foi excluída"');
      for (const [sit, etapa, ok] of [[4, 'sefaz_rejeitou', false], [2, 'nota_nova_sem_efeito', false], [9, 'nota_nova_sem_efeito', false], [11, 'nota_nova_sem_efeito', false], [3, 'aguardando_sefaz', true], [8, 'aguardando_sefaz', true], [10, 'aguardando_sefaz', true], [99, 'situacao_desconhecida', false], [null, 'situacao_desconhecida', false]]) {
        const x = cena([notaNova(sit)], OK, { mlFalso: async () => ({}) }); const rx = await x.pedir();
        assert.deepStrictEqual([rx.ok, rx.etapa, rx.fez, x.escritas.length, x.aoML.length], [ok, etapa, [], 0, 0], emp + ': situação ' + sit + ': ' + JSON.stringify(rx).slice(0, 200));
      }
      /* pediu a emissão e a SEFAZ rejeitou na hora */
      const e7 = cena([notaNova(1), notaNova(4)], OK, { mlFalso: async () => ({}) }); const re7 = await e7.pedir();
      assert.deepStrictEqual([re7.ok, re7.etapa, re7.fez, re7.escreveu_algo, e7.aoML.length], [false, 'sefaz_rejeitou', ['pediu_emissao'], true, 0]);
      /* pediu e não conseguiu reler */
      const e8 = cena([notaNova(1), null], OK, { mlFalso: async () => ({}) }); const re8 = await e8.pedir();
      assert.deepStrictEqual([re8.ok, re8.etapa, re8.fez, e8.aoML.length], [true, 'aguardando_sefaz', ['pediu_emissao'], 0]);
      /* dois cliques ao mesmo tempo: UM pedido de emissão */
      let soltar = null; const t = cena([notaNova(1), notaNova(3)], () => new Promise((ok) => { soltar = () => ok(OK); }));
      const p1 = t.pedir(); for (let i = 0; i < 200 && !soltar; i++) await new Promise((r) => setImmediate(r));
      assert.ok(soltar, emp + ': a primeira chamada tinha que estar parada no pedido de emissão');
      assert.deepStrictEqual([(await t.pedir()).etapa, t.escritas.length], ['em_andamento', 1]);
      soltar(); assert.strictEqual((await p1).etapa, 'aguardando_sefaz');
      /* sem credencial: 404, nada */
      const sc = cena([notaNova(1)], OK); const uS = new URL('http://x' + pref + '/nf-conserto-enviar?nf=777&confirma=sim'); const resS = {};
      const rotaS = R.criar({ empresa: emp, cacheDir: sc.dir, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: () => '', validarSessao: () => null, ehAdmin: () => false, blingGet: async () => { throw new Error('não era pra ler'); }, blingWrite: async () => { throw new Error('não era pra escrever'); } });
      await rotaS({ method: 'GET', headers: {} }, resS, uS, 'GET', uS.pathname);
      assert.deepStrictEqual([resS._s, resS._o], [404, { error: 'not found' }]);
    }

    /* o registro: `anotar` só mexe em nota criada e não deixa trocar a nota nova */
    { const d = pasta();
      assert.strictEqual(Reg.anotar(d, 1, { x: 1 }), false); Reg.abrir(d, 1, {}); assert.strictEqual(Reg.anotar(d, 1, { x: 1 }), false, 'registro em "criando" não recebe anotação de etapa seguinte');
      Reg.fechar(d, 1, { id: 9, numero: 10 }); assert.strictEqual(Reg.anotar(d, 1, { x: 1, nova_id: 'outro', estado: 'incerta', nova_numero: 'z' }), true);
      assert.deepStrictEqual([Reg.de(d, 1).x, Reg.de(d, 1).nova_id, Reg.de(d, 1).nova_numero, Reg.de(d, 1).estado], [1, '9', '10', 'criada']); }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }
  console.log('ok — conserto da NF, emitir a nota nova e mandar o XML ao ML: só nota criada pela rotina (nunca a de teste), reconfere a venda antes de emitir, UM pedido de emissão, XML pelo envio de produção, aviso do checkout resolvido, e cada resposta do Bling/SEFAZ/ML no seu lugar — nas três');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
