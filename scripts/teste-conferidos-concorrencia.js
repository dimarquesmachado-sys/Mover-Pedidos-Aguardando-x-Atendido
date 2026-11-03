'use strict';
/* 01/11 — CONFERIDOS SEM ATUALIZAÇÃO PERDIDA (auditoria do Codex no SHA 208fdb7d, achado F02). Quem finalizava/sincronizava
   lia a lista de conferidos, ESPERAVA o Bling e regravava a lista INTEIRA lida antes — o que outro pedido gravou na espera
   sumia. Prova com as funções DE PRODUÇÃO e gravação de mentira (em memória):
   A) o "verificado" (lib/checkout/rotas-conferido, SYNC_ON): dois pedidos finalizados juntos, o Bling responde na ordem
      [2, 1] — no fim os DOIS estão nos conferidos, sincronizados (antes: só o 1, e os dois responderam sucesso);
   B) a sincronização do ciclo (lib/checkout/ciclo-empresa, sincronizarConferidos): durante a espera do Bling, um pedido
      novo é bipado e um pendente é desfeito — no fim o novo CONTINUA lá e o desfeito NÃO volta (antes: a lista do começo,
      regravada no fim, apagava o novo e ressuscitava o desfeito). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const disco = {};
const readJson = (f, d) => (f in disco ? JSON.parse(JSON.stringify(disco[f])) : d);
const writeJson = (f, o) => { disco[f] = JSON.parse(JSON.stringify(o)); };

(async () => {
  /* A) o "verificado" */
  const CONF = '/c/conferidos.json';
  disco[CONF] = {};
  const pendentes = {};
  const moverSituacao = (id) => new Promise((ok) => { pendentes[id] = ok; });
  const respostas = [];
  const { criar } = require(path.join(raiz, 'lib', 'checkout', 'rotas-conferido'));
  const h = criar({ prefixo: '/x', tag: 'T', json: (res, code, o) => respostas.push(o), readBody: async (req) => req._body, readJson, writeJson,
    lerReservas: () => ({}), moverSituacao, arquivarFinalizado: () => {}, sincronizarConferidos: async () => ({}), rodarCiclo: () => {},
    CONFERIDOS_FILE: CONF, RESERVAS_FILE: '/c/reservas.json', CACHE_DIR: '/c', SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 'x' });
  const req = (id) => ({ method: 'POST', headers: {}, _body: { id, user: 'op' } });
  const r1 = h(req('1'), {}, new URL('http://x/x/conferido'), 'POST', () => 'op');
  const r2 = h(req('2'), {}, new URL('http://x/x/conferido'), 'POST', () => 'op');
  for (let i = 0; i < 20 && !(pendentes['1'] && pendentes['2']); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(pendentes['1'] && pendentes['2'], 'os dois pedidos tinham que estar esperando o Bling');
  pendentes['2']({ ok: true }); await new Promise((r) => setTimeout(r, 5));
  pendentes['1']({ ok: true });
  await Promise.all([r1, r2]);
  const fim = disco[CONF];
  assert.deepStrictEqual(Object.keys(fim).sort(), ['1', '2'], 'um conferido se perdeu com a resposta do Bling fora de ordem: ' + JSON.stringify(Object.keys(fim)));
  assert.ok(fim['1'].sincronizado && fim['2'].sincronizado, 'os dois tinham que ficar sincronizados');
  assert.ok(respostas.length === 2 && respostas.every((o) => o && o.ok), 'os dois tinham que responder ok');

  /* B) a sincronização do ciclo — a função DE PRODUÇÃO, tirada do código da peça */
  const src = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'ciclo-empresa.js'), 'utf8');
  const i = src.indexOf('  async function sincronizarConferidos(pular) {');
  assert.ok(i > 0, 'não achei a sincronização dos conferidos na peça do ciclo');
  const corpo = src.slice(i, src.indexOf('\n  }\n', i) + 4);
  const CF = '/s/conferidos.json';
  disco[CF] = { 7: { conferido_em: 'a' }, 9: { conferido_em: 'b' } };
  const reqLib = (m) => require(m.startsWith('.') ? path.join(raiz, 'lib', 'checkout', m) : m);
  const mover = async (id) => {
    if (String(id) === '7') {   // durante a espera do Bling: o 8 é bipado e o 9 é desfeito
      const atual = readJson(CF, {}); atual['8'] = { conferido_em: 'novo' }; delete atual['9']; writeJson(CF, atual);
    }
    return { ok: true };
  };
  const fn = new Function('readJson', 'writeJson', 'CONFERIDOS_FILE', 'MANIFEST_FILE', 'FULL_DESPACHADOS_FILE', '_fullDespachadosNoProcesso', 'moverSituacao', 'blingGet',
    'SIT_VERIFICADO', 'SIT_ATENDIDO', 'SIT_DESPACHADOS', 'LOG', 'sleep', 'PAUSA_MS', 'require', 'console',
    corpo + '\nreturn sincronizarConferidos;');
  const sinc = fn(readJson, writeJson, CF, '/s/m.json', '/s/fd.json', new Set(), mover, async () => ({}), 24, 9, 0, 'T', async () => {}, 0, reqLib, { log: () => {} });
  await sinc();
  const depois = disco[CF];
  assert.ok(depois['8'], 'o pedido bipado DURANTE a sincronização sumiu (a lista do começo foi regravada por cima)');
  assert.ok(!depois['9'], 'o pedido desfeito durante a sincronização VOLTOU (ressuscitado pela lista do começo)');
  assert.ok(depois['7'] && depois['7'].sincronizado, 'o 7 tinha que ficar sincronizado');
  console.log('ok — conferidos sem atualização perdida: verificado com Bling fora de ordem e sincronização do ciclo preservam o que foi gravado na espera');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
