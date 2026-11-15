'use strict';
/* 15/11 — A FONTE MAGALU FALHANDO NÃO APAGA O PERÍODO (auditoria do Codex de 15/11/2026, P1 nº 3).

   O backfill reconstrói o período do zero: Bling + vendas diretas do ML + a caça da Magalu (as vendas que o Bling não tem).
   Antes, quando a caça FALHAVA (rota fora, HTTP 503, exceção) ou vinha PELA METADE (`parcial`/`truncado`), o motor só
   anotava `msg_magalu` e seguia pra troca: o período era regravado SEM as vendas que só a Magalu tinha — e a rodada
   terminava `ok:true`. Na prova do Codex, uma venda antiga recuperada só da Magalu desapareceu.

   Prova com o motor DE PRODUÇÃO (lib/checkout/backfill-motor, pelo `backfillVendas` da Girassol com o contexto da AMB, como
   a AMB roda), Bling e Supabase de mentira, e a caça da Magalu em cada estado:
     A. caça OK → a rodada troca o período e a venda só-da-Magalu está nas linhas gravadas (o cenário normal);
     B. caça devolve `erro` → ABORTADO, `ok:false`, `transitorio:true`, `fonte_incompleta:'magalu'`; NENHUMA linha gravada
        no rascunho e NENHUMA troca pedida ao banco;
     C. caça devolve `parcial:true` → idem (lista pela metade não é lista);
     D. caça LANÇA → idem;
     E. o abort é ANTES do DELETE: a rodada responde com o motivo e o período fica como estava. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirAmb = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-'));
process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
fs.writeFileSync(path.join(dirAmb, '_custos.json'), JSON.stringify({ A1: { custo: 20 }, M1: { custo: 30 } }));
fs.writeFileSync(path.join(dirAmb, '_config-fiscal.json'), JSON.stringify({ aliquotas: { '2026-10': 9.5 }, taxas: { magalu: 16 } }));
/* sem rede: o ML de mentira não tem vendedor (as vendas diretas do ML ficam de fora — não é o assunto deste teste) */
const fetchStub = async (url) => ({ ok: false, status: 404, json: async () => ({}), text: async () => '{}' });
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fetchStub };

const LJ = { ml: 206017293, magalu: 206018666 };
const pedidos = [
  { id: 1, numero: 9001, nl: '2000011111111111', lj: LJ.ml, sit: 9, itens: [{ codigo: 'A1', quantidade: 2, valor: 50 }], taxas: { taxaComissao: 14, custoFrete: 9 }, uf: 'SP' },
  { id: 5, numero: 9005, nl: 'LU-555', lj: LJ.magalu, sit: 9, itens: [{ codigo: 'M1', quantidade: 1, valor: 90 }], taxas: { taxaComissao: 14.4, custoFrete: 0 }, uf: 'PR' },
];
const blingGet = async (p) => {
  if (/^\/situacoes\/modulos$/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 98310, nome: 'Vendas' }] } };
  if (/^\/situacoes\/modulos\/98310$/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 12, nome: 'Cancelado' }, { id: 9, nome: 'Atendido' }] } };
  if (/^\/pedidos\/vendas\?/.test(p)) return { ok: true, status: 200, data: { data: /pagina=1(&|$)/.test(p) ? pedidos.map((x) => ({ id: x.id, numero: x.numero, numeroLoja: x.nl, data: '2026-10-05', situacao: { id: x.sit }, loja: { id: x.lj } })) : [] } };
  const m = /^\/pedidos\/vendas\/(\d+)$/.exec(p);
  if (m) { const x = pedidos.find((y) => String(y.id) === m[1]);
    return { ok: true, status: 200, data: { data: { id: x.id, numero: x.numero, numeroPedidoLoja: x.nl, numeroLoja: x.nl, data: '2026-10-05', situacao: { id: x.sit }, loja: { id: x.lj },
      itens: x.itens.map((it) => Object.assign({ descricao: 'p ' + it.codigo }, it)), total: x.itens.reduce((a, it) => a + it.valor * it.quantidade, 0),
      taxas: x.taxas, contato: { endereco: { uf: x.uf } }, transporte: {} } } }; }
  return { ok: true, status: 200, data: { data: [] } };
};
/* a venda que SÓ a Magalu tem (o Bling não importou) */
const linhaMg = { empresa: 'amb', numero_pedido: 'MG-ZZ1', numero_loja: 'ZZ1', canal: 'magalu', data_venda: '2026-10-05', sku: 'M1', quantidade: 1, valor_produto: 70, valor_nota: 70, custo: 30, comissao: 11.2, frete_vendedor: 8, imposto: 6.65, margem: 14.15 };
const cacaOk = async () => ({ linhas: [Object.assign({}, linhaMg)], pedidos: 1, na_magalu: 2, parcial: false, erro: null });
const cacaErro = async () => ({ linhas: [], pedidos: 0, na_magalu: 0, parcial: false, erro: 'rota da Magalu: HTTP 503' });
const cacaParcial = async () => ({ linhas: [Object.assign({}, linhaMg)], pedidos: 1, na_magalu: 9, parcial: true, erro: null });
const cacaQuebra = async () => { throw new Error('ECONNRESET na caça'); };

(async () => {
  const _log = console.log; console.log = () => {};
  let falhou = null;
  try {
    const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
    const comum = require('../amb-checkout-offline/comum');
    const gbo = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
    const LOJA_MKT = { [LJ.ml]: 'ml', [LJ.magalu]: 'magalu' };
    /* o Supabase de mentira: registra TUDO o que lhe pedem; "existentes" é o que o período tem hoje */
    const rodar = async (magaluLinhas, jaTinha) => {
      const pedidosSupa = []; const gravadas = [];
      const supaReq = async (emp, met, q, body) => {
        pedidosSupa.push(met + ' ' + String(q).split('?')[0]);
        if (met === 'POST' && Array.isArray(body)) gravadas.push(...body.map((l) => Object.assign({}, l)));
        return { ok: true, status: met === 'POST' ? 201 : 200, body: '[]' };
      };
      const estado = { rodando: false, empresa: null, de: null, ate: null, pagina: 0, pedidos: 0, itens: 0, gravados: 0, erros: 0, fase: 'parado', inicio: null, fim: null, msg: '' };
      const ctx = { estadoBackfill: estado, blingGet, readJson, CACHE_DIR: dirAmb, supaReq, supaCount: async () => (jaTinha == null ? 3 : jaTinha),
        DEFAULT_ALIQ_BK: { '2026-10': 9.5 }, aliqReserva: 14.1, custoVigenteEm: () => null, mapasBilling: async () => ({ com: {}, fre: {} }), garantirTokenML: async () => null,
        escrowEmLote: async () => ({}), escrowDoPedido: async () => null, LOJA_MKT, magaluFreteSkuLer: () => ({ M1: { media: 13.3 } }),
        creditosFlex: async () => ({}), magaluLinhas, cacaMagaluRodando: () => false, canarioRodando: () => false, reparoAtivo: () => false,
        ehFlex: comum.ehFlex, garantirSitCancel: async () => ({ ids: [12] }) };
      const r = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'amb', ctx);
      return { r, pedidosSupa, gravadas, estado };
    };
    const trocou = (x) => x.pedidosSupa.some((p) => /rpc\/trocar_periodo_historico/.test(p)) && x.gravadas.length > 0;

    /* A. caça OK: troca, e a venda só-da-Magalu está lá */
    const A = await rodar(cacaOk);
    assert.ok(A.r && A.r.ok !== false && A.r.desfecho !== 'abortado', 'o cenário normal não rodou: ' + JSON.stringify(A.r && { d: A.r.desfecho, m: A.r.msg }));
    assert.ok(trocou(A), 'no cenário normal a troca do período tinha que acontecer: ' + JSON.stringify(A.pedidosSupa));
    assert.ok(A.gravadas.some((l) => l.numero_loja === 'ZZ1' && l.canal === 'magalu'), 'a venda que só a Magalu tem não foi gravada no cenário normal');
    assert.ok(A.gravadas.some((l) => l.numero_loja === 'LU-555'), 'a venda da Magalu que o Bling tem não foi gravada');

    /* B/C/D: a caça falha → ABORTADO antes do DELETE, nada gravado */
    for (const [nome, caca, trecho] of [['erro', cacaErro, /caça da Magalu falhou \(rota da Magalu: HTTP 503\)/], ['parcial', cacaParcial, /veio pela metade/], ['exceção', cacaQuebra, /caça da Magalu quebrou \(ECONNRESET/]]) {
      const X = await rodar(caca);
      assert.ok(X.r && X.r.ok === false && X.r.desfecho === 'abortado', 'caça da Magalu com ' + nome + ': a rodada tinha que ABORTAR — era o P1: seguia e apagava o período: ' + JSON.stringify(X.r && { ok: X.r.ok, d: X.r.desfecho, m: X.r.msg }));
      assert.ok(X.r.transitorio === true && X.r.fonte_incompleta === 'magalu', nome + ': o abort tem que ser transitório e dizer a fonte: ' + JSON.stringify({ t: X.r.transitorio, f: X.r.fonte_incompleta }));
      assert.ok(trecho.test(String(X.r.msg)) && /nada foi apagado/.test(String(X.r.msg)), nome + ': a mensagem tem que dizer o motivo e que nada foi apagado: ' + X.r.msg);
      assert.ok(!trocou(X) && X.gravadas.length === 0, nome + ': NENHUMA linha pode ir pro rascunho e a troca não pode ser pedida: ' + JSON.stringify(X.pedidosSupa) + ' gravadas=' + X.gravadas.length);
      assert.ok(X.estado.fase === 'abortado' && X.estado.rodando === false && X.estado.erros >= 1, nome + ': o andamento tem que ficar abortado e livre: ' + JSON.stringify({ f: X.estado.fase, r: X.estado.rodando }));
      assert.ok(String(X.estado.msg_magalu || '').length > 0, nome + ': msg_magalu continua dizendo o que a caça respondeu');
    }
    /* F (Codex #898): período GRANDE já gravado (100 linhas) e a coleta sem a Magalu fica pequena — o abort tem que continuar sendo o
       da FONTE (transitório, fonte dita), não o da guarda de sanidade dos 60% (que o fatiado trata como erro fixo e não repete) */
    for (const [nome, caca] of [['erro', cacaErro], ['parcial', cacaParcial], ['exceção', cacaQuebra]]) {
      const G = await rodar(caca, 100);
      assert.ok(G.r && G.r.ok === false && G.r.desfecho === 'abortado' && G.r.transitorio === true && G.r.fonte_incompleta === 'magalu', nome + ' com período de 100 linhas: o abort tem que ser o da fonte (transitório), veio ' + JSON.stringify(G.r && { t: G.r.transitorio, f: G.r.fonte_incompleta, m: String(G.r.msg).slice(0, 90) }));
      assert.ok(!/menos de 60%/.test(String(G.r.msg)), nome + ': caiu na guarda de sanidade em vez do portão da fonte: ' + G.r.msg);
      assert.ok(!trocou(G) && G.gravadas.length === 0, nome + ' (100 linhas): nada gravado, nada trocado');
    }
    /* e a guarda de sanidade segue viva quando a coleta vem pequena SEM fonte falhando */
    { const pedidosPoucos = pedidos.splice(1); const H = await rodar(cacaOk, 100); pedidos.push(...pedidosPoucos);
      assert.ok(H.r && H.r.desfecho === 'abortado' && /menos de 60%/.test(String(H.r.msg)) && H.r.transitorio !== true, 'coleta pequena com fontes ok: a guarda dos 60% é quem aborta (sem transitório): ' + JSON.stringify(H.r && { t: H.r.transitorio, m: String(H.r.msg).slice(0, 90) })); }
    /* o rascunho de rodada abandonada (housekeeping) pode ter sido limpo — mas o PERÍODO em si (a função de troca) não foi tocado */
    const E = await rodar(cacaErro);
    assert.ok(!E.pedidosSupa.some((p) => /DELETE vendas_historico/.test(p)), 'o período (vendas_historico) não pode receber DELETE direto: ' + JSON.stringify(E.pedidosSupa));
  } catch (e) { falhou = e; }
  finally { console.log = _log; }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — backfill: a caça da Magalu com erro, pela metade ou quebrando ABORTA antes do DELETE (transitório, fonte dita, nada gravado, nada trocado); com a caça ok a venda que só a Magalu tem entra na troca');
  process.exit(0);
})();
