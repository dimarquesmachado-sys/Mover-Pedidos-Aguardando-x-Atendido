'use strict';
/* 11/11 (plano multiloja, Fase 3 4e) — O PLANO DE BACKFILL EM FATIAS POR EMPRESA (lib/checkout/backfill-plano-empresa).
   A AMB não tinha plano: o ano dela rodava mês a mês de uma vez e uma queda obrigava a recomeçar na mão. A peça é a união
   do motor da GOOD com o `acao=criar` da Girassol e a proteção contra clique duplo.
   Prova (a peça de produção, com a biblioteca de fatias DE VERDADE num disco temporário):
   · sem a chave de admin a rota some (404); outra rota não é dela;
   · `criar` valida as datas, grava o plano em fatias e RODA as fatias (com a janela aberta e a vez livre), uma por vez,
     como fundo da empresa — e o status mostra o plano concluído e o motor;
   · fora da janela (galpão em operação) NADA roda: o motor agenda e diz o motivo; a resposta do criar avisa quando começa;
   · com outro backfill em curso, espera a vez;
   · plano em andamento não é sobrescrito sem &refazer=1 (409); com &refazer=1, recomeça;
   · parar e retentar; a fatia que falha fica com erro no resumo;
   · a AMB monta a peça com o backfill, as travas e a pasta DELA, serve a rota, mostra o plano no status e só retoma
     no boot com a empresa ligada. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criar } = require('../lib/checkout/backfill-plano-empresa');
const fundo = require('../lib/checkout/contexto-fundo');

function montar(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plano-emp-'));
  const rodadas = [], agendados = [];
  const cfg = Object.assign({
    empresa: 'amb', prefixo: '/amb-checkout-offline', cacheDir: dir, pausaMs: 1,
    json: (res, st, o) => { res.st = st; res.o = o; },
    lerChaveAdmin: (req, u) => u.searchParams.get('k'),
    rodarFatia: async (f) => { rodadas.push({ de: f.de, ate: f.ate, fundo: !!((fundo.contexto.getStore() || {}).fundo), servico: (fundo.contexto.getStore() || {}).servico }); return { ok: true, desfecho: 'ok' }; },
    ocupado: () => false,
    podeRodarAgora: () => ({ ok: true }),
    motor: { agendar: (fn, ms) => { agendados.push({ fn, ms }); return agendados.length; }, cancelar: () => {} },
  }, extra || {});
  const p = criar(cfg);
  const chamar = async (qs, caminho) => { const res = {}; const u = new URL('http://x' + (caminho || '/amb-checkout-offline/backfill-plano') + (qs || '')); const tratou = await p.rota({}, res, u, 'GET', u.pathname); return { tratou, st: res.st, o: res.o }; };
  return { p, dir, rodadas, agendados, chamar };
}
const espera = (ms) => new Promise((s) => setTimeout(s, ms));

(async () => {
  process.env.ADMIN_KEY = 'adm';
  /* faltou peça: derruba na montagem, dizendo qual */
  assert.throws(() => criar({ empresa: 'amb' }), /falta prefixo/);

  let x = montar();
  let r = await x.chamar('?k=errada');
  assert.ok(r.tratou && r.st === 404, 'sem a chave de admin a rota tinha que sumir (404)');
  r = await x.chamar('?k=adm', '/amb-checkout-offline/outra');
  assert.strictEqual(r.tratou, false, 'a peça só responde pelo /backfill-plano');
  r = await x.chamar('?k=adm');
  assert.ok(r.st === 200 && r.o.ok && r.o.empresa === 'amb' && r.o.motor && r.o.motor.rodando === false, 'status sem plano: ' + JSON.stringify(r.o));
  /* Codex #840: data com formato certo que NÃO EXISTE (mês 13, 30 de fevereiro) também é recusada — e nada vai pro disco */
  for (const ruim of ['&de=2026-13&ate=2026-01-31', '&de=2026-02-01&ate=2026-01-31', '', '&de=2026-13-01&ate=2026-13-31', '&de=2026-02-30&ate=2026-03-05', '&de=2026-01-01&ate=2026-04-31']) {
    r = await x.chamar('?k=adm&acao=criar' + ruim);
    assert.ok(r.st === 400 && /acao=criar&de=/.test(r.o.erro), 'datas ruins tinham que ser recusadas: ' + ruim);
  }
  assert.ok(!fs.existsSync(path.join(x.dir, '_backfill_plano.json')), 'data recusada não pode deixar plano em disco');
  /* criar: 25 dias em fatias de 10 = 3 fatias; rodam uma por vez, como FUNDO da empresa */
  r = await x.chamar('?k=adm&acao=criar&de=2026-01-01&ate=2026-01-25&dias=10');
  assert.ok(r.st === 200 && r.o.ok && r.o.comeca === 'agora' && r.o.resumo && /3 fatia/.test(r.o.msg), 'criar: ' + JSON.stringify(r.o));
  for (let i = 0; i < 80 && x.rodadas.length < 3; i++) await espera(25);
  assert.deepStrictEqual(x.rodadas.map((f) => f.de + '>' + f.ate), ['2026-01-01>2026-01-10', '2026-01-11>2026-01-20', '2026-01-21>2026-01-25'], 'as 3 fatias tinham que rodar em ordem: ' + JSON.stringify(x.rodadas));
  assert.ok(x.rodadas.every((f) => f.fundo && f.servico === 'amb'), 'a fatia tinha que rodar como FUNDO da empresa (o porteiro do Bling dá a vez ao galpão)');
  await espera(60);
  r = await x.chamar('?k=adm');
  assert.ok(r.o.faltam === 0 && r.o.motor.rodando === false && fs.existsSync(path.join(x.dir, '_backfill_plano.json')), 'plano concluído e em disco: ' + JSON.stringify(r.o));

  /* fora da janela: nada roda, o motor agenda e diz o motivo; a resposta avisa quando começa */
  x = montar({ podeRodarAgora: () => ({ ok: false, esperaMs: 3600000, motivo: 'galpão em operação — começa às 18h05' }) });
  r = await x.chamar('?k=adm&acao=criar&de=2026-02-01&ate=2026-02-10');
  await espera(60);
  assert.ok(r.o.ok && /18h05/.test(r.o.comeca) && x.rodadas.length === 0 && x.agendados.length === 1 && x.agendados[0].ms === 3600000, 'fora da janela não pode rodar; tem que agendar: ' + JSON.stringify([r.o.comeca, x.rodadas.length, x.agendados.map((a) => a.ms)]));
  r = await x.chamar('?k=adm');
  assert.ok(r.o.motor.proximo && /galpão/.test(r.o.motor.proximo.motivo), 'o status tinha que dizer por que espera: ' + JSON.stringify(r.o.motor));
  /* plano em andamento: não sobrescreve sem &refazer=1 */
  r = await x.chamar('?k=adm&acao=criar&de=2026-03-01&ate=2026-03-05');
  assert.ok(r.st === 409 && /refazer=1/.test(r.o.erro) && x.p.emAndamento(), 'plano em andamento sobrescrito por um segundo clique: ' + JSON.stringify(r.o));
  r = await x.chamar('?k=adm&acao=criar&de=2026-03-01&ate=2026-03-05&refazer=1');
  assert.ok(r.st === 200 && /1 fatia/.test(r.o.msg), 'com &refazer=1 tinha que recomeçar');
  /* parar: o plano fica parado e deixa de estar "em andamento" */
  r = await x.chamar('?k=adm&acao=parar');
  assert.ok(r.st === 200 && r.o.ok && !x.p.emAndamento(), 'parar: ' + JSON.stringify(r.o));

  /* outro backfill em curso: espera a vez (não roda por cima) */
  let ocup = true;
  x = montar({ ocupado: () => ocup });
  await x.chamar('?k=adm&acao=criar&de=2026-04-01&ate=2026-04-05');
  await espera(60);
  assert.ok(x.rodadas.length === 0 && x.agendados.length === 1, 'com outro backfill em curso o plano tinha que esperar');
  ocup = false; x.agendados[0].fn();
  for (let i = 0; i < 60 && x.rodadas.length < 1; i++) await espera(25);
  assert.strictEqual(x.rodadas.length, 1, 'liberou a vez: a fatia tinha que rodar');
  /* a trava que quebra não pode liberar o plano (na dúvida, não atropela) */
  x = montar({ ocupado: () => { throw new Error('estado ilegível'); } });
  await x.chamar('?k=adm&acao=criar&de=2026-04-01&ate=2026-04-05'); await espera(60);
  assert.strictEqual(x.rodadas.length, 0, 'trava que dá erro tinha que contar como ocupado');

  /* fatia que falha: fica com erro no resumo; retentar devolve pra fila */
  let falhar = true;
  x = montar({ rodarFatia: async () => { if (falhar) return { ok: false, desfecho: 'abortado', msg: 'Bling recusou' }; return { ok: true, desfecho: 'ok' }; } });
  await x.chamar('?k=adm&acao=criar&de=2026-05-01&ate=2026-05-05');
  for (let i = 0; i < 60; i++) { await espera(25); if ((x.p.status().com_erro || 0) > 0) break; }
  assert.ok(x.p.status().com_erro === 1, 'a fatia abortada tinha que aparecer com erro: ' + JSON.stringify(x.p.status()));
  falhar = false;
  r = await x.chamar('?k=adm&acao=retentar');
  assert.ok(r.st === 200 && /1 fatia/.test(r.o.msg), 'retentar: ' + JSON.stringify(r.o));
  for (let i = 0; i < 60; i++) { await espera(25); if (x.p.status().faltam === 0 && !x.p.status().com_erro) break; }
  assert.ok(x.p.status().faltam === 0 && !x.p.status().com_erro, 'depois de retentar o plano tinha que concluir: ' + JSON.stringify(x.p.status()));

  /* a AMB monta a peça com o que é DELA */
  const amb = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
  const i = amb.indexOf("require('../lib/checkout/backfill-plano-empresa').criar({"); assert.ok(i > 0, 'a AMB não monta a peça do plano');
  const bloco = amb.slice(i, i + 700);
  assert.ok(/empresa: 'amb', prefixo: '\/amb-checkout-offline', cacheDir: CACHE_DIR/.test(bloco) && /rodarFatia: \(\{ de, ate \}\) => backfillVendas\(de, ate\)/.test(bloco), 'a AMB tem que entregar a pasta e o backfill DELA');
  assert.ok(/ocupado: \(\) => !!\(_backfill\.rodando \|\| _backfillAno\.rodando \|\| _canario\.rodando\)/.test(bloco), 'a trava da AMB tem que olhar o período, o ano e o canário');
  assert.ok(/valida\('amb'\)[^\n]*_planoAmb\.retomarNoBoot\(\)/.test(amb), 'a retomada no boot só com a AMB ligada');
  assert.ok(/if \(await _planoAmb\.rota\(req, res, urlObj, method, p\)\) return true;/.test(amb) && /plano: _planoAmb\.status\(\)/.test(amb), 'a AMB tem que servir a rota e mostrar o plano no /backfill-status');
  /* 11/11 (2): a Girassol e a GOOD também montam a MESMA peça — a Girassol deixou o "tocar" antigo (não esperava o galpão
     fechar, travava só no backfill de um período e não refazia sozinho); a GOOD monta o motor dela pela peça */
  const gir = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  const ig = gir.indexOf("require('../lib/checkout/backfill-plano-empresa').criar({"); assert.ok(ig > 0, 'a Girassol não monta a peça do plano');
  const bg = gir.slice(ig, ig + 700);
  assert.ok(/empresa: 'girassol', prefixo: '\/girassol-backup-offline', cacheDir: CACHE_DIR/.test(bg) && /rodarFatia: \(\{ de, ate \}\) => backfillVendas\(de, ate, 'girassol'\)/.test(bg) && /ocupado: \(\) => backfillOcupado\('girassol'\)/.test(bg), 'a Girassol tem que entregar a pasta, o backfill e a trava COMPLETA dela');
  assert.ok(!/tocarPlano|_planoRodando/.test(gir), 'sobrou o "tocar o plano" antigo na Girassol');
  assert.ok(/valida\('girassol'\)[^\n]*_planoGir\.retomarNoBoot\(\)/.test(gir) && /if \(await _planoGir\.rota\(req, res, urlObj, method, p\)\) return true;/.test(gir) && /plano: _planoGir\.status\(\)/.test(gir), 'a Girassol tem que servir a rota pela peça, mostrar o plano no status e só retomar no boot se estiver ligada');
  const good = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  const io = good.indexOf("require('../lib/checkout/backfill-plano-empresa').criar({"); assert.ok(io > 0, 'a GOOD não monta a peça do plano');
  assert.ok(/empresa: 'good', prefixo: '\/good-checkout-offline', cacheDir: CACHE_DIR/.test(good.slice(io, io + 400)) && /const _motorPlanoGood = _planoGood\.motor;/.test(good) && !/_fatGood\.criarMotor\(/.test(good), 'a GOOD tem que montar o motor dela PELA peça (sem criar outro por fora)');
  assert.ok(/if \(await _planoGood\.rota\(req, res, urlObj, method, p\)\) return true;/.test(good), 'a GOOD tem que servir o /backfill-plano pela peça');
  console.log('ok — plano de backfill em fatias por empresa: cria, roda uma fatia por vez como fundo, espera o galpão e a vez, não sobrescreve plano em andamento, para e retenta; as três montam a mesma peça');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
