'use strict';
/* 25/10 — o resgate do pedido pro ATENDIDO (degraus) e o backfill das NFs do arquivo local viraram PEÇAS ÚNICAS
   (lib/checkout/resgate-atendido e lib/checkout/backfill-nf-local): eram idênticas nas três empresas. Prova de
   EQUIVALÊNCIA com o código de antes (scripts/fixtures/resgate-nf-local-antes.js, o da AMB) — as mesmas respostas e as
   MESMAS chamadas ao Bling em cada caminho do resgate (direto, recusa sem degrau, degrau aceito, todos recusados,
   falha operacional) e o mesmo resultado no backfill de NF, com os mesmos arquivos; e as três empresas usam a peça. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnl-'));
  const CACHE_DIR = path.join(dir, 'cache'), ARQUIVO_DIR = path.join(dir, 'arq'), CONFERIDOS_FILE = path.join(dir, 'conferidos.json');
  fs.mkdirSync(path.join(CACHE_DIR, '101'), { recursive: true }); fs.mkdirSync(path.join(ARQUIVO_DIR, '102'), { recursive: true });
  const readJson = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
  const writeJson = (a, v) => fs.writeFileSync(a, JSON.stringify(v));
  const dep = { ARQUIVO_DIR, CACHE_DIR, CONFERIDOS_FILE, path, readJson, writeJson };
  const velho = require('./fixtures/resgate-nf-local-antes.js')(dep);
  const R = require('../lib/checkout/resgate-atendido');
  const novoMover = R.criarResgateAtendido({ tag: 'AMBBKP' })._moverAtendidoDesandando;
  const novoBNL = require('../lib/checkout/backfill-nf-local').criarBackfillNFLocal(dep);
  const j = (x) => JSON.stringify(x);

  // os ajudantes
  for (const [sv, env] of [[18, ''], [18, '15, 9'], [null, '21'], [24, 'x,0,-1,7']]) assert.strictEqual(j(R._degrausResgate(sv, env)), j(velho._degrausResgate(sv, env)), '_degrausResgate');
  for (const mv of [null, { erro: 'x' }, { data: { error: { type: 'VALIDATION_ERROR' } } }, { raw: 'texto' }]) assert.strictEqual(j(R._detalheBling(mv)), j(velho._detalheBling(mv)), '_detalheBling');

  // o resgate, caminho a caminho (sem esperar as pausas de 2/8/20 s)
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);
  const recusaTrans = { ok: false, status: 400, erro: 'não há transições para essa situação', data: { error: { type: 'VALIDATION_ERROR' } } };
  const cenarios = {
    direto: () => [{ ok: true }],
    recusa_sem_degrau: () => [{ ok: false, status: 500, erro: 'boom' }],
    degrau_aceito: () => [recusaTrans, { ok: true }, { ok: true }],
    todos_recusados: () => [recusaTrans, recusaTrans, recusaTrans, recusaTrans, recusaTrans],
    falha_operacional: () => [recusaTrans, { ok: false, status: 429, erro: 'Too Many' }],
  };
  process.env.AMBBKP_SIT_DEGRAUS = '15';
  for (const [nome, resp] of Object.entries(cenarios)) {
    const rodar = async (fn) => {
      const fila = resp().slice(), chamadas = [], marcas = [];
      const r = await fn({ moverSituacao: async (id, sit) => { chamadas.push(sit); return fila.length ? fila.shift() : recusaTrans; },
        pedidoId: 77, sitAtual: 9999, sitAtendido: 9, sitVerificado: 18, sitDespachados: 9999,
        marcarParado: (p) => { marcas.push('parado:' + p); return true; }, limparMarca: () => marcas.push('limpa') });
      return j({ r, chamadas, marcas });
    };
    assert.strictEqual(await rodar(novoMover), await rodar(velho._moverAtendidoDesandando), 'resgate respondeu diferente no caminho ' + nome);
  }
  delete process.env.AMBBKP_SIT_DEGRAUS;
  global.setTimeout = _st;

  // o backfill das NFs do arquivo local: os mesmos arquivos, o mesmo resultado
  const QUANDO = new Date(Date.now() - 86400000).toISOString();   /* a mesma data nas duas rodadas */
  const prep = () => {
    writeJson(CONFERIDOS_FILE, { 101: { conferido_em: QUANDO }, 102: { conferido_em: QUANDO }, 103: { conferido_em: QUANDO } });
    writeJson(path.join(CACHE_DIR, '101', 'nf-simp.json'), { numeroPedidoLoja: 'ML1', uf: 'SP', municipio: 'Osasco', itens: [{ valorTotal: 10.5 }, { valorTotal: 4.5 }] });
    writeJson(path.join(ARQUIVO_DIR, '102', 'nf-simp.json'), { consumidor: { endereco: 'Rua A, 1, Centro, Rio de Janeiro - RJ' }, itens: [] });
  };
  prep(); const rv = j(velho.backfillNFLocal(45)); const cv = fs.readFileSync(CONFERIDOS_FILE, 'utf8');
  prep(); const rn = j(novoBNL(45)); const cn = fs.readFileSync(CONFERIDOS_FILE, 'utf8');
  assert.ok(/"preenchidos_pela_nf":1/.test(rv), 'o caso de teste do backfill não exercitou nada: ' + rv);
  assert.strictEqual(rn, rv, 'backfillNFLocal respondeu diferente');
  assert.strictEqual(cn, cv, 'backfillNFLocal gravou diferente');
  fs.rmSync(dir, { recursive: true, force: true });

  // as três empresas pela peça
  for (const [arq, tag] of [['girassol-backup-offline/gbo-app.js', 'GIRABKP'], ['amb-checkout-offline/index.js', 'AMBBKP'], ['good-checkout-offline/index.js', 'GOODBKP']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(s.includes("criarResgateAtendido({ tag: '" + tag + "' })") && /require\('\.\.\/lib\/checkout\/backfill-nf-local'\)\.criarBackfillNFLocal\(/.test(s), arq + ': não usa as peças (ou com o tag de outra empresa)');
    assert.ok(!/^(async )?function (_degrausResgate|_detalheBling|_moverAtendidoDesandando|backfillNFLocal)\s*\(/m.test(s), arq + ': sobrou cópia');
  }
  console.log('ok — resgate pro ATENDIDO e backfill de NF local em peça única: mesmas respostas e mesmas chamadas que o código de antes, nas três empresas');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
