'use strict';
/* 29/10 — a CAÇA DE VENDAS DA MAGALU nas três empresas (passo 2 do backfill único). A peça (lib/checkout/magalu-caca)
   era só da AMB; a Girassol e a GOOD ganham: de hora em hora, a rota /magalu-caca da fábrica e o passo DENTRO do backfill
   compartilhado (sem ele, o backfill apagaria o que a caça recuperou). Prova, com o backfillVendas DE PRODUÇÃO
   (16/11, montarCheckout passo 10: lib/checkout/backfill-rodar, a entrada das três; era o do arquivo da Girassol) no contexto
   da GOOD, com Bling e Supabase de mentira:
   · com a caça da empresa no contexto: as vendas que a Magalu tem e o Bling não entram na MESMA gravação, e a caça recebe
     o que o Bling já trouxe (não duplica);
   · a caça falhando: o backfill segue com o que o Bling trouxe e diz por quê; empresa sem caça: nada muda;
   · caça gravando: o backfill não começa (adiado);
   · a regra das dependências: a Girassol cai na caça dela; outra empresa sem a dela fica SEM (nunca a da Girassol);
   · o estado da peça é UM objeto (a fábrica guarda a referência e vê a caça em andamento);
   · as três montam a peça com a chave delas, de hora em hora em minutos diferentes, e a fábrica recebe a caça. */
const assert = require('assert');
const fs = require('fs');
require('./_gbo-com-motor').instalar();   /* 13/11: o motor do histórico saiu do arquivo da Girassol pra lib/checkout/backfill-motor.js — este teste lê o arquivo COM o motor no lugar, tirado da peça viva */
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirGood = fs.mkdtempSync(path.join(os.tmpdir(), 'goo-'));
process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
fs.writeFileSync(path.join(dirGood, '_custos-vigencia.json'), JSON.stringify({ X1: [{ de: '2026-01-01', ate: null, custo: 20 }] }));
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '{}' }) };

(async () => {
  const _log = console.log; console.log = () => {};
  let falhou = null;
  try {
    const gbo = require(path.join(raiz, 'lib', 'checkout', 'backfill-rodar.js'));
    const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
    const pedidos = [{ id: 1, numero: 5001, nl: '2000012345678901', loja: 701 }, { id: 3, numero: 5003, nl: 'LU-123456', loja: 703 }];
    const blingGet = async (p) => {
      if (/^\/pedidos\/vendas\?/.test(p)) return { ok: true, status: 200, data: { data: /pagina=1(&|$)/.test(p) ? pedidos.map((x) => ({ id: x.id, numero: x.numero, numeroLoja: x.nl, data: '2026-10-05', situacao: { id: 9 }, loja: { id: x.loja } })) : [] } };
      const m = /^\/pedidos\/vendas\/(\d+)$/.exec(p);
      if (m) { const x = pedidos.find((y) => String(y.id) === m[1]);
        return { ok: true, status: 200, data: { data: { id: x.id, numero: x.numero, numeroPedidoLoja: x.nl, data: '2026-10-05', loja: { id: x.loja },
          itens: [{ codigo: 'X1', descricao: 'produto', quantidade: 1, valor: 100 }], total: 100, taxas: { taxaComissao: 10, custoFrete: 5 }, contato: { endereco: { uf: 'SP' } } } } }; }
      return { ok: true, status: 200, data: { data: [] } };
    };
    const gravadas = [];
    const base = {
      blingGet, readJson, CACHE_DIR: dirGood,
      supaReq: async (emp, met, q, body) => { if (met === 'POST' && Array.isArray(body)) gravadas.push(...body); return { ok: true, status: met === 'POST' ? 201 : 200, body: '[]' }; },
      supaCount: async () => null, DEFAULT_ALIQ_BK: { '2026-10': 10 },
      custoVigenteEm: (sku, data) => require('../lib/custo').custoVigenteEm({ CACHE_DIR: dirGood, path, fs, readJson }, sku, data),
      /* sem token do ML: o gerenciador de produção RECUSA quando não há credencial */
      garantirTokenML: async () => { throw new Error('GOOD ML: token não configurado'); }, LOJA_MKT: { '701': 'ml', '703': 'magalu' }, mapasBilling: null, escrowEmLote: null, escrowDoPedido: null, magaluFreteSkuLer: () => ({}),
      ehFlex: require(path.join(raiz, 'good-checkout-offline', 'comum.js')).ehFlex,
    };
    // 1) com a caça da empresa: as vendas que só a Magalu tem entram na MESMA gravação; a caça recebe o que o Bling já trouxe
    let jaRecebido = null;
    const linhaMg = { empresa: 'good', numero_pedido: 'MG-M9', numero_loja: 'M9', canal: 'magalu', data_venda: '2026-10-05', sku: 'X1', quantidade: 1, valor_produto: 77, valor_nota: 77, custo: 20, comissao: 7, frete_vendedor: 3, imposto: 7.7, margem: 39.3 };
    const ctx1 = Object.assign({}, base, { magaluLinhas: async (de, ate, emp, ja) => { jaRecebido = Array.from(ja); return { linhas: [linhaMg], pedidos: 1, na_magalu: 2, parcial: false, erro: null }; } });
    gravadas.length = 0;
    const r1 = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', ctx1);
    assert.ok(r1 && r1.desfecho !== 'abortado' && r1.desfecho !== 'erro', 'o backfill não rodou: ' + JSON.stringify(r1 && { desfecho: r1.desfecho, msg: r1.msg }));
    assert.ok(gravadas.some((l) => l.numero_loja === 'M9' && l.canal === 'magalu' && Number(l.valor_produto) === 77), 'a venda que só a Magalu tem não entrou na gravação do backfill');
    assert.strictEqual(gravadas.length, 3, 'linhas gravadas (2 do Bling + 1 da Magalu): ' + gravadas.length);
    assert.deepStrictEqual(jaRecebido, ['LU-123456'], 'a caça não recebeu o que o Bling já trouxe da Magalu (duplicaria): ' + JSON.stringify(jaRecebido));
    assert.ok(r1.do_magalu && r1.do_magalu.vendas === 1 && r1.do_magalu.linhas === 1, 'o resultado não diz o que veio da Magalu: ' + JSON.stringify(r1.do_magalu));
    // 2) a caça falhando: ABORTA antes de trocar o período e diz por quê (15/11, auditoria do Codex P1 nº 3 — antes
    //    "seguia com o Bling", e a venda que só a Magalu tinha sumia do período regravado; scripts/teste-backfill-fonte-magalu.js)
    const ctx2 = Object.assign({}, base, { magaluLinhas: async () => ({ linhas: [], pedidos: 0, erro: 'rota da Magalu: HTTP 500' }) });
    gravadas.length = 0;
    const r2 = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', ctx2);
    assert.ok(r2 && r2.desfecho === 'abortado' && r2.ok === false && r2.transitorio === true && r2.fonte_incompleta === 'magalu' && gravadas.length === 0 && /rota da Magalu/.test(String(r2.msg_magalu || '')), 'a caça falhando tinha que ABORTAR sem gravar nada, dizendo por quê: ' + JSON.stringify(r2 && { d: r2.desfecho, n: gravadas.length, m: r2.msg_magalu, t: r2.transitorio }));
    // 3) sem caça no contexto: nada muda
    gravadas.length = 0;
    const r3 = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', base);
    assert.ok(r3 && gravadas.length === 2 && !r3.do_magalu, 'empresa sem caça mudou de comportamento');
    // 4) caça gravando: o backfill não começa
    gravadas.length = 0;
    const r4 = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', Object.assign({}, base, { cacaMagaluRodando: () => true }));
    assert.ok(r4 && r4.desfecho === 'adiado' && gravadas.length === 0, 'o backfill começou com a caça gravando: ' + JSON.stringify(r4 && { d: r4.desfecho, m: r4.msg }));
    // 5) a regra das dependências
    const { resolverDepsBackfill } = require('../lib/checkout/backfill-deps');
    const loc = { magaluLinhas: () => 'girassol' };
    assert.ok(resolverDepsBackfill('girassol', null, loc, 'girassol').magaluLinhas === loc.magaluLinhas, 'a Girassol não cai na caça dela');
    assert.strictEqual(resolverDepsBackfill('nova', {}, loc, 'girassol').magaluLinhas, null, 'empresa sem a caça dela pegou a da Girassol');
    // 6) o estado da peça é UM objeto (a fábrica guarda a referência)
    { const { criarCacaMagalu } = require('../lib/checkout/magalu-caca');
      const pc = criarCacaMagalu({ empresa: 'good', supaReq: async () => ({ ok: true, body: '[]' }), blingGet: async () => ({ ok: false }), readJson: (a, d) => d, CACHE_DIR: dirGood,
        fetch: async () => ({ status: 500, json: async () => null }) });
      const ref = pc.estado();
      await pc.cacaMagalu('2026-10-01', '2026-10-02');
      assert.ok(pc.estado() === ref && ref.de === '2026-10-01' && ref.rodando === false, 'o estado virou outro objeto (a fábrica veria a caça velha)'); }
  } catch (e) { falhou = e; }
  finally { console.log = _log; }
  if (falhou) { console.error('FALHOU:', falhou.message); process.exit(1); }
  // 7) as três montam a peça com a chave delas, de hora em hora, e a fábrica recebe a caça
  const ler = (a) => fs.readFileSync(path.join(raiz, a), 'utf8');
  const g = ler('girassol-backup-offline/gbo-app.js'), d = ler('good-checkout-offline/index.js'), a = ler('amb-checkout-offline/index.js');
  for (const [nome, s, emp, var_, min] of [['Girassol', g, 'girassol', '_cacaMgGir', "'25 * * * *'"], ['GOOD', d, 'good', '_cacaMgGood', "'45 * * * *'"], ['AMB', a, 'amb', '_cacaMgAmb', "'35 * * * *'"]]) {
    assert.ok(new RegExp('const ' + var_ + " = require\\('\\.\\./lib/checkout/magalu-caca'\\)\\.criarCacaMagalu\\(\\{\\n  empresa: '" + emp + "'").test(s), nome + ': não monta a peça com a chave dela');
    assert.ok(s.includes('cacaMagalu: ' + min), nome + ': a caça não está agendada de hora em hora (' + min + ')');
  }
  for (const [nome, s, var_] of [['Girassol', g, '_cacaMgGir'], ['GOOD', d, '_cacaMgGood']]) {
    assert.ok(s.includes('cacaMagalu: (...a) => ' + var_ + '.cacaMagalu(...a), _mgc: ' + var_ + '.estado(),') && s.includes('cacaMagalu: () => ' + var_ + '.cacaMagaluCron()'), nome + ': a fábrica/rotina não recebe a caça');
  }
  /* 16/11 (montarCheckout, passo 9): o contexto do backfill é a peça lib/checkout/backfill-empresa — a GOOD entrega a caça DELA */
  { const _BE = require('./_backfill-empresa');
    assert.ok(_BE.entrega(d, 'cacaMagalu', '_cacaMgGood') && _BE.leva('magaluLinhas', /P\.cacaMagalu\.magaluLinhas\(d1, d2, e2, j2\)/) && _BE.leva('cacaMagaluRodando', /P\.cacaMagalu\.estado\(\)\.rodando/), 'GOOD: o contexto do backfill não leva a caça dela');
    /* 16/11 (passo 10): a Girassol também — o arquivo cru (sem o apoio, que mostra o motor no lugar da montagem) */
    const gCru = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js')).toString('utf8');
    assert.ok(_BE.usaPeca(gCru, 'girassol') && _BE.entrega(gCru, 'cacaMagalu', '_cacaMgGir'), 'Girassol: o contexto do backfill não leva a caça dela'); }
  assert.ok(g.includes("magaluLinhas: (d1, d2, e2, j2) => _cacaMgGir.magaluLinhas(d1, d2, e2, j2) }, 'girassol');") && g.includes('_reparoAtivo || _cacaMgGir.estado().rodando) ret')
    /* 09/11 (plano, Fase 3 4c): o /sku-repara da Girassol passou a ser o da FÁBRICA — a recusa com a caça rodando mora lá
       (pelo `_mgc` que a Girassol entrega, conferido acima); a cópia não pode ter voltado */
    && (g.includes("if (_cacaMgGir.estado().rodando) { json(res, 409,") || (/if \(_mgc && _mgc\.rodando\) \{ json\(res, 409, \{ ok: false, erro: 'ca[^']*a da Magalu rodando/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8')) && !g.includes("p === '/girassol-backup-offline/sku-repara'"))),
    'Girassol: backfill, vaga do Bling ou reparo de SKU sem a caça');
  console.log('ok — caça da Magalu nas três: dentro do backfill (sem duplicar), falha da caça aborta a troca sem apagar nada, trava o backfill enquanto grava, estado estável, de hora em hora');
  process.exit(0);
})();
