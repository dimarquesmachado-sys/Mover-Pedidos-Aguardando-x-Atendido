'use strict';
/* 15/11 — ZERO `require` CRUZADO ENTRE PASTAS DE EMPRESA (docs/NORTE-2026-11.md, item C, passo 1).

   A AMB e a GOOD faziam `require('../girassol-backup-offline/gbo-app')` pra rodar o backfill, ler o próprio andamento,
   reservar a vaga do resgate e descobrir as situações de cancelamento DELAS. Desligar a Girassol (ou renomear a pasta)
   derrubava o backfill das outras duas — e, no caminho, o motor pegava da Girassol o que o contexto não trouxesse (o
   classificador Flex, a tarifa leve do ML, o canário dela adiando o backfill da GOOD). Agora cada empresa só fala com as
   peças de lib/checkout: backfill-rodar (motor sem empresa padrão), backfill-estado (andamento e vaga por empresa),
   situacoes-cancelamento (situações por empresa) e ml-fee-leve (a tarifa leve, uma só). Provas:
     1) nenhum arquivo de amb-checkout-offline, good-checkout-offline, girassol-backup-offline ou lib carrega a pasta de
        outra empresa (fora comentário);
     2) o backfill da GOOD roda pelo backfill-rodar com o contexto dela e o gbo-app NÃO é carregado no processo;
     3) contexto incompleto é recusado COM O NOME do que faltou (não cai na Girassol); a Girassol não roda por aqui;
     4) o andamento/vaga por empresa: a trava extra da Girassol não segura a GOOD; a vaga do resgate respeita a trava extra;
        trava extra que explode conta como ocupado; o objeto da Girassol ninguém troca por ctx, o da AMB é o dela;
     5) as situações de cancelamento da GOOD não encostam no cache da Girassol;
     6) o gbo-app continua exportando o de sempre, e o que exporta é a MESMA peça (quem ainda chamar por ele vê o mesmo). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* 1) grep: nada de require cruzado (código, não comentário) */
const PASTAS = ['amb-checkout-offline', 'good-checkout-offline', 'girassol-backup-offline'];
const semComentarios = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
const arquivosJs = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'node_modules' ? [] : arquivosJs(path.join(dir, e.name))) : (/\.js$/.test(e.name) ? [path.join(dir, e.name)] : []));
const cruzados = [];
for (const pasta of PASTAS.concat(['lib'])) {
  for (const f of arquivosJs(path.join(raiz, pasta))) {
    const codigo = semComentarios(fs.readFileSync(f, 'utf8'));
    for (const outra of PASTAS) {
      if (outra === pasta) continue;
      const re = new RegExp("require\\((['\"])(\\.\\.\\/|\\.\\/)*" + outra.replace(/-/g, '\\-') + "(\\/|\\1)");
      if (re.test(codigo)) cruzados.push(path.relative(raiz, f) + ' → ' + outra);
    }
  }
}
assert.deepStrictEqual(cruzados, [], 'require cruzado entre pastas de empresa: ' + cruzados.join('; '));
/* o que cada empresa chama agora (texto, pra ninguém voltar a atalho) */
const amb = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
const good = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
const gboSrc = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
/* 16/11 (montarCheckout, passo 9): a AMB e a GOOD rodam o backfill pela peça lib/checkout/backfill-empresa, que chama o backfill-rodar */
assert.ok(require('./_backfill-empresa').usaPeca(amb, 'amb') && require('./_backfill-empresa').usaPeca(good, 'good'), 'a AMB e a GOOD têm que rodar o backfill pelo backfill-rodar (pela peça do contexto)');
/* as quatro entradas da GOOD (fatia do plano, diário, manual e o dia do repasse) rodam o motor único: pela peça (`_bfEmp`) ou pelo
   backfill-rodar com o contexto DELA — nenhuma pela pasta de outra empresa */
assert.strictEqual(((good.match(/_bfEmp\.backfillVendas\(/g) || []).length + (good.match(/require\('\.\.\/lib\/checkout\/backfill-rodar'\)/g) || []).length) >= 4, true, 'a GOOD tem que rodar o backfill (fatia, diário, manual, dia) pelo backfill-rodar');
assert.ok(/require\('\.\.\/lib\/checkout\/situacoes-cancelamento'\)\.garantirSitCancel\(bg, 'good'\)/.test(good), 'as situações de cancelamento da GOOD vêm da peça');
/* toda leitura do andamento/vaga na GOOD é DA GOOD (a trava do plano, do diário, do status, do resgate) — nunca de outra empresa */
const usosEstadoGood = good.match(/(?:backfill-estado'\)|_est)\.(?:ocupado|foto|reservarVaga|liberarVaga)\([^)]*\)/g) || [];
assert.ok(usosEstadoGood.length >= 7, 'a GOOD tinha que ler o andamento pela peça em pelo menos 7 lugares: ' + usosEstadoGood.join(' | '));
for (const u of usosEstadoGood) assert.ok(/\(('good'|m, 'good')\)$/.test(u), 'a GOOD leu o andamento de outra empresa: ' + u);
assert.ok(!/function _feeMLLeve\(/.test(amb) && !/function _feeMLLeve\(/.test(gboSrc), 'a tarifa leve do ML é UMA (lib/checkout/ml-fee-leve) — sobrou cópia');
assert.ok(/const _backfill = _ESTADO\.estado\('girassol'\);/.test(gboSrc) && /_ESTADO\.travaExtra\('girassol'/.test(gboSrc) && /const garantirSitCancel = _SIT\.garantirSitCancel;/.test(gboSrc), 'a Girassol tem que usar as mesmas peças');

/* 2) o backfill da GOOD roda pelo backfill-rodar sem carregar o gbo-app */
const RODAR = require('../lib/checkout/backfill-rodar');
const ESTADO = require('../lib/checkout/backfill-estado');
const SIT = require('../lib/checkout/situacoes-cancelamento');
const gboCarregado = () => Object.keys(require.cache).some((k) => /girassol-backup-offline/.test(k));
assert.strictEqual(gboCarregado(), false, 'as peças não podem carregar o gbo-app');
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => ({ ok: false, status: 500, json: async () => null, text: async () => '' }) };
const dirGood = fs.mkdtempSync(path.join(os.tmpdir(), 'good-'));
const chamadasBling = [];
const bg = async (p) => {
  chamadasBling.push(p);
  if (/^\/situacoes\/modulos$/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 1, nome: 'Vendas' }] } };
  if (/^\/situacoes\/modulos\/1$/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 12, nome: 'Cancelado' }] } };
  return { ok: true, status: 200, data: { data: [] } };
};
const ehFlexChamadas = [];
const ctxGood = { blingGet: bg, readJson: (f, pad) => pad, CACHE_DIR: dirGood, supaReq: async () => ({ ok: true, status: 200, body: '[]' }), supaCount: async () => null,
  DEFAULT_ALIQ_BK: {}, ehFlex: (s) => { ehFlexChamadas.push(s); return false; }, garantirTokenML: async () => 'tk-good', LOJA_MKT: {}, canarioRodando: () => false, reparoAtivo: () => false };
const _log = console.log;
(async () => {
  console.log = () => {};
  let r;
  try { r = await RODAR.backfillVendas('2026-10-05', '2026-10-05', 'good', ctxGood); } finally { console.log = _log; }
  assert.ok(r && r.ok === true && r.desfecho === 'ok' && r.empresa === 'good' && r.fase === 'concluido', 'o backfill da GOOD pelo backfill-rodar tinha que concluir: ' + JSON.stringify(r).slice(0, 200));
  assert.strictEqual(gboCarregado(), false, 'o backfill da GOOD carregou o gbo-app da Girassol');
  assert.ok(chamadasBling.some((p) => /^\/situacoes\/modulos/.test(p)) && chamadasBling.some((p) => /^\/pedidos\/vendas\?/.test(p)), 'o motor tinha que descobrir as situações e listar as vendas pelo blingGet DA GOOD: ' + chamadasBling.join(' '));
  assert.strictEqual(ESTADO.foto('good').fase, 'concluido', 'o andamento da GOOD tem que estar na peça');
  assert.strictEqual(ESTADO.foto('girassol').fase, 'parado', 'o backfill da GOOD mexeu no andamento da Girassol');
  assert.deepStrictEqual(SIT.alvo('good').ids, [12], 'as situações descobertas são as da GOOD (na peça)');
  assert.deepStrictEqual(SIT.alvo('girassol').ids, [], 'o backfill da GOOD encostou no cache de situações da Girassol');

  /* 3) contexto incompleto: recusa com nome; a Girassol não roda por aqui */
  for (const falta of ['ehFlex', 'garantirTokenML', 'blingGet', 'LOJA_MKT']) {
    const c = Object.assign({}, ctxGood); delete c[falta];
    let erro = null;
    try { await RODAR.backfillVendas('2026-10-05', '2026-10-05', 'good', c); } catch (e) { erro = e; }
    assert.ok(erro && new RegExp('não trouxe ' + falta).test(erro.message) && /good/.test(erro.message), 'sem `' + falta + '` o backfill tinha que recusar com o nome: ' + (erro && erro.message));
  }
  {
    const c = Object.assign({}, ctxGood); delete c.ehFlex; delete c.supaCount;
    let erro = null; try { await RODAR.backfillVendas('2026-10-05', '2026-10-05', 'amb', c); } catch (e) { erro = e; }
    assert.ok(erro && /supaCount, ehFlex|ehFlex, supaCount/.test(erro.message), 'tem que listar TUDO que faltou: ' + (erro && erro.message));
  }
  for (const emp of ['girassol', '', null]) {
    let erro = null; try { await RODAR.backfillVendas('2026-10-05', '2026-10-05', emp, ctxGood); } catch (e) { erro = e; }
    assert.ok(erro && /Girassol roda pelo gbo-app/.test(erro.message), 'a Girassol (ou sem empresa) não roda pelo backfill-rodar: ' + (erro && erro.message));
  }
  assert.strictEqual(gboCarregado(), false, 'a recusa carregou o gbo-app');
  assert.deepStrictEqual(RODAR.EXIGIDOS.slice().sort(), ['CACHE_DIR', 'DEFAULT_ALIQ_BK', 'LOJA_MKT', 'blingGet', 'ehFlex', 'garantirTokenML', 'readJson', 'supaCount', 'supaReq']);

  /* 4) andamento e vaga por empresa */
  let extraGir = false;
  ESTADO.travaExtra('girassol', () => extraGir);
  extraGir = true;
  assert.strictEqual(ESTADO.ocupado('girassol'), true, 'a trava extra da Girassol tem que ocupá-la');
  assert.strictEqual(ESTADO.ocupado('good'), false, 'a trava extra da Girassol segurou a GOOD');
  assert.strictEqual(ESTADO.reservarVaga('resgate', 'girassol'), false, 'a vaga da Girassol com trava extra tinha que ser recusada');
  assert.strictEqual(ESTADO.reservarVaga('resgate', 'good'), true, 'a vaga da GOOD tinha que sair');
  assert.strictEqual(ESTADO.ocupado('good'), true);
  assert.strictEqual(ESTADO.reservarVaga('de novo', 'good'), false, 'duas vagas da GOOD ao mesmo tempo');
  assert.strictEqual(ESTADO.estado('good').fase, 'resgate');
  ESTADO.liberarVaga('good');
  assert.strictEqual(ESTADO.ocupado('good'), false); assert.strictEqual(ESTADO.estado('good').fase, 'resgate-liberado');
  ESTADO.estado('good').rodando = true; ESTADO.estado('good').fase = 'lendo';
  ESTADO.liberarVaga('good');
  assert.strictEqual(ESTADO.estado('good').rodando, true, 'liberar a vaga não pode derrubar um backfill de verdade (fase ≠ resgate)');
  ESTADO.estado('good').rodando = false;
  extraGir = false;
  assert.strictEqual(ESTADO.ocupado('girassol'), false);
  ESTADO.travaExtra('girassol', () => { throw new Error('boom'); });
  assert.strictEqual(ESTADO.ocupado('girassol'), true, 'trava extra que explode conta como ocupado (nunca libera por erro)');
  ESTADO.travaExtra('girassol', null);
  assert.strictEqual(ESTADO.ocupado('girassol'), false);
  /* identidade: a AMB traz o objeto dela; o da Girassol ninguém troca */
  const objAmb = ESTADO.PARADO();
  assert.strictEqual(ESTADO.estado('amb', { estadoBackfill: objAmb }), objAmb, 'o andamento da AMB tem que ser o objeto que ela trouxe');
  assert.strictEqual(ESTADO.estado('amb'), objAmb, 'e continuar sendo ele depois');
  const objGir = ESTADO.estado('girassol');
  assert.strictEqual(ESTADO.estado('girassol', { estadoBackfill: ESTADO.PARADO() }), objGir, 'o andamento da Girassol não pode ser trocado por ctx');
  ESTADO.reiniciar(objAmb, Object.assign(ESTADO.PARADO(), { empresa: 'amb', fase: 'lendo', rodando: true }));
  assert.strictEqual(ESTADO.estado('amb'), objAmb); assert.strictEqual(ESTADO.foto('amb').fase, 'lendo'); assert.notStrictEqual(ESTADO.foto('amb'), objAmb, 'a foto é cópia');
  objAmb.rodando = false;

  /* 5) situações por empresa, sem encostar na Girassol; env fixo só da Girassol */
  const bgGir = async (p) => /^\/situacoes\/modulos$/.test(p) ? { ok: true, data: { data: [{ id: 7, nome: 'Vendas' }] } } : { ok: true, data: { data: [{ id: 777, nome: 'Cancelado' }] } };
  console.log = () => {};
  try {
    assert.deepStrictEqual((await SIT.garantirSitCancel(bgGir, 'girassol')).ids, [777]);
    assert.deepStrictEqual((await SIT.garantirSitCancel(bgGir, 'good')).ids, [12], 'a GOOD tem cache próprio (12 h) — não pode refazer com o bling da Girassol');
    assert.deepStrictEqual(SIT.alvo('amb').ids, []);
    const semMod = async () => ({ ok: true, data: { data: [] } });
    process.env.GIRABKP_SIT_CANCELADO = '55';
    assert.deepStrictEqual((await SIT.garantirSitCancel(semMod, 'amb')).ids, [], 'a AMB pegou o GIRABKP_SIT_CANCELADO');
    assert.ok(/nenhuma situação|módulo/.test(String(SIT.alvo('amb').erro)), 'sem situação, a AMB registra o erro dela');
    delete process.env.GIRABKP_SIT_CANCELADO;
  } finally { console.log = _log; }

  /* 6) o gbo-app exporta o de sempre e é a MESMA peça */
  const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-'));
  process.env.GIRABKP_CACHE_DIR = dirGir;
  const gbo = require('../girassol-backup-offline/gbo-app');
  for (const k of ['backfillVendas', 'garantirSitCancel', 'reservarVagaBackfill', 'liberarVagaBackfill', 'backfillOcupado', 'backfillEstado']) assert.strictEqual(typeof gbo[k], 'function', 'o gbo-app deixou de exportar ' + k);
  assert.strictEqual(gbo.garantirSitCancel, SIT.garantirSitCancel, 'o garantirSitCancel do gbo-app tem que ser o da peça');
  assert.strictEqual(ESTADO.reservarVaga('x', 'good'), true);
  assert.strictEqual(gbo.backfillOcupado('good'), true, 'o gbo-app tem que enxergar a vaga reservada na peça');
  assert.strictEqual(gbo.backfillEstado('good').fase, 'resgate');
  gbo.liberarVagaBackfill('good');
  assert.strictEqual(ESTADO.ocupado('good'), false, 'liberar pelo gbo-app tem que liberar na peça');
  assert.strictEqual(gbo.backfillEstado('girassol').rodando, false);
  console.log('ok — zero require cruzado; o backfill da GOOD roda pelo backfill-rodar sem carregar o gbo-app; contexto incompleto recusa com nome; andamento/vaga e situações por empresa nas peças; o gbo-app exporta a mesma peça');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
