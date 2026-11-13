'use strict';
/* 13/11 — A RODADA DAS NOTAS DA MAGALU SE RECUPERA SOZINHA, E O "VERIFICADO" É POR EMPRESA (lib/magalu-nf-saude).
   Caso real (12/11, AMB): "o servidor não verifica a Magalu desde 11/11 23:02 (15h atrás) — alguma coisa travou". Dia de
   vários deploys: a rodada leva minutos (2 min de espera entre as empresas) e um reinício no meio a mata; ninguém a
   refazia até o próximo horário. E o "verificado" vinha só da última rodada — uma rodada de outra empresa o apagava.
   Prova (a peça pura + a ligação no magalu-oauth):
   · a verificação boa de cada empresa fica guardada e não some com a rodada seguinte (parcial, interrompida ou falha);
     "sem notas" conta como verificação boa; falha (ok:false) não;
   · atrasou além do prazo (7h30 — a agenda tem no máximo 7h entre rodadas) → recupera SÓ a empresa atrasada;
   · dentro do prazo, com rodada em andamento, ou tendo tentado há menos de 1 h → não recupera;
   · empresa nunca verificada → recupera;
   · o servidor grava o mapa no fim de cada rodada, usa-o pra responder à extensão e agenda a conferência. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/magalu-nf-saude');
const H = 3600000, T0 = Date.parse('2026-11-12T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

/* ── o mapa por empresa ── */
let mapa = S.registrarRodada({}, { fim: iso(T0 - 16 * H), resultado: [{ empresa: 'good', ok: true }, { empresa: 'amb', ok: true, vazio: true }] });
assert.ok(mapa.good.em === iso(T0 - 16 * H) && mapa.amb.vazio === true && mapa.good.vazio === false);
/* rodada seguinte SÓ da GOOD (o botão "só GOOD"): a da AMB não some */
mapa = S.registrarRodada(mapa, { fim: iso(T0 - 2 * H), resultado: [{ empresa: 'good', ok: true }] });
assert.ok(mapa.good.em === iso(T0 - 2 * H) && mapa.amb.em === iso(T0 - 16 * H), 'uma rodada de outra empresa não pode apagar a verificação desta: ' + JSON.stringify(mapa));
/* rodada em que a AMB FALHOU: a última boa dela continua sendo a antiga (não vira a hora da falha) */
mapa = S.registrarRodada(mapa, { fim: iso(T0 - 1 * H), resultado: [{ empresa: 'good', ok: true }, { empresa: 'amb', ok: false, erro: '429' }] });
assert.strictEqual(mapa.amb.em, iso(T0 - 16 * H), 'falha não conta como verificação');
/* rodada INTERROMPIDA (reinício no meio: sem fim, sem resultado): nada muda — e não estoura */
assert.deepStrictEqual(S.registrarRodada(mapa, { inicio: iso(T0), fim: null, resultado: null }), mapa);
assert.deepStrictEqual(S.registrarRodada(null, null), {});
/* a resposta pra extensão: do mapa; sem mapa (1º deploy), cai na última rodada como antes */
assert.deepStrictEqual(S.verificadoDe(mapa, null, 'amb'), { em: iso(T0 - 16 * H), vazio: true });
assert.deepStrictEqual(S.verificadoDe({}, { fim: iso(T0 - 3 * H), resultado: [{ empresa: 'amb', ok: true }] }, 'amb'), { em: iso(T0 - 3 * H), vazio: false });
assert.strictEqual(S.verificadoDe({}, { fim: iso(T0), resultado: [{ empresa: 'amb', ok: false }] }, 'amb'), null);
assert.strictEqual(S.verificadoDe({}, { fim: null, resultado: null }, 'amb'), null);

/* ── quando refazer ── */
const base = { agoraMs: T0, empresas: ['good', 'amb'], verificados: mapa, estado: null, rodando: false, ultimaRecuperacaoMs: 0 };
let d = S.precisaRecuperar(base);
assert.ok(d.recuperar === true && d.quais.join() === 'amb', 'a AMB está há 16 h sem verificação boa e a GOOD há 1 h: recupera SÓ a AMB: ' + JSON.stringify(d));
assert.strictEqual(S.precisaRecuperar(Object.assign({}, base, { rodando: true })).recuperar, false, 'com rodada em andamento, espera');
d = S.precisaRecuperar(Object.assign({}, base, { ultimaRecuperacaoMs: T0 - 20 * 60000 }));
assert.ok(d.recuperar === false && d.quais.join() === 'amb' && /há pouco/.test(d.motivo), 'tentou há 20 min: não martela a Magalu');
assert.strictEqual(S.precisaRecuperar(Object.assign({}, base, { ultimaRecuperacaoMs: T0 - 61 * 60000 })).recuperar, true, 'passada 1 h, tenta de novo');
/* dentro do prazo: a madrugada inteira (23h → 6h = 7 h) NÃO dispara recuperação; 7h31 dispara */
const ok7 = { good: { em: iso(T0 - 7 * H - 10 * 60000) }, amb: { em: iso(T0 - 7 * H - 10 * 60000) } };
assert.strictEqual(S.precisaRecuperar(Object.assign({}, base, { verificados: ok7 })).recuperar, false, 'o intervalo normal da madrugada (7 h + a duração da rodada) não é atraso');
const ok8 = { good: { em: iso(T0 - 7 * H - 31 * 60000) }, amb: { em: iso(T0 - 1 * H) } };
assert.deepStrictEqual(S.precisaRecuperar(Object.assign({}, base, { verificados: ok8 })).quais, ['good']);
/* nunca verificada (empresa nova, ou arquivo perdido) → recupera; sem empresa ativa → nada */
assert.deepStrictEqual(S.precisaRecuperar(Object.assign({}, base, { verificados: {} })).quais, ['good', 'amb']);
assert.strictEqual(S.precisaRecuperar(Object.assign({}, base, { empresas: [] })).recuperar, false);
/* sem o mapa mas com a última rodada boa e recente (1º deploy desta peça): não dispara à toa */
assert.strictEqual(S.precisaRecuperar(Object.assign({}, base, { verificados: {}, estado: { fim: iso(T0 - 2 * H), resultado: [{ empresa: 'good', ok: true }, { empresa: 'amb', ok: true }] } })).recuperar, false);

/* ── a ligação no servidor ── */
const src = fs.readFileSync(path.join(__dirname, '..', 'magalu-oauth', 'index.js'), 'utf8');
assert.ok(/nfSalvarEstado\(\); nfRegistrarVerificados\(nfUltima\); \}\);/.test(src), 'o fim de toda rodada tem que gravar a verificação por empresa');
assert.ok(/require\('\.\.\/lib\/magalu-nf-saude'\)\.verificadoDe\(nfLerVerificados\(\), nfLerEstado\(\), emp3\)/.test(src), 'a resposta pra extensão tem que vir da verificação por empresa');
assert.ok(/const r = nfDisparar\('recuperacao', d\.quais\);/.test(src) && /setTimeout\(\(\) => \{ try \{ nfRecuperarSeDevido\(\); \} catch \(e\) \{\} \}, 3 \* 60000\)/.test(src) && /setInterval\(\(\) => \{ try \{ nfRecuperarSeDevido\(\); \} catch \(e\) \{\} \}, 30 \* 60000\)/.test(src), 'o servidor tem que conferir depois de subir e de tempos em tempos, refazendo só as atrasadas');
assert.ok(/_recuperacao_ms: nfUltimaRecuperacaoMs/.test(src) && /Number\(nfLerVerificados\(\)\._recuperacao_ms\)/.test(src), 'a hora da última recuperação tem que sobreviver a um reinício');
assert.ok(/_t1\.unref\(\)/.test(src) && /_t2\.unref\(\)/.test(src), 'os relógios da conferência não podem segurar o processo');
console.log('ok — Magalu NF: a verificação boa é guardada por empresa, e rodada perdida (reinício, falha) é refeita sozinha — só a empresa atrasada, no máximo uma vez por hora');
