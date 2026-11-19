/* 30/09 — A TOOLBOX TEM QUE CONHECER AS MESMAS EMPRESAS QUE A PONTE DE DEVOLUÇÕES.

   O que aconteceu: a Girassol entrou no Devoluções em 28/09, o `bg-devolucoes.js` foi acertado,
   e o POPUP ficou pra trás — o dono não tinha por onde chegar na Devoluções da Girassol pela
   extensão. Mesma classe de erro que a regra da casa chama de "portar tudo, sempre", e que já
   tinha aparecido no próprio bg ("empresa desconhecida na extensao" ao emitir a 1a NF dela).

   ⚠️ A FONTE DA VERDADE AQUI É O `ENDERECO_IDS` DO bg-devolucoes.js, não o contrato: tentei
   amarrar no `ativa_em.devolucoes` do contrato e descobri que ele só está preenchido na
   GIRASSOL — GOOD e AMB, que são as originais, têm `ativa_em` VAZIO. Amarrar ali daria falso
   negativo pras duas empresas que mais usam a ponte.
   O `ENDERECO_IDS` é o que a extensão realmente usa pra emitir: se uma empresa está lá, a
   ponte funciona pra ela, e então o popup PRECISA ter como chegar nela. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const popup = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'popup.js'), 'utf8');
const bg = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-devolucoes.js'), 'utf8');

/* as empresas que a PONTE atende, lidas EXECUTANDO o fundo dela (2.1.21: o ENDERECO_IDS nasce da ficha, não está mais escrito) */
const vm = require('vm');
const ENDERECO_IDS = (() => {
  const chrome = { runtime: { onMessage: { addListener() {} }, onInstalled: { addListener() {} }, sendMessage: async () => ({}), id: 'ext', getManifest: () => ({ version: 'teste' }) },
    webRequest: { onSendHeaders: { addListener() {} }, onBeforeSendHeaders: { addListener() {} } },
    storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [] }, windows: { update: async () => {} }, scripting: { executeScript: async () => [] } };
  const ctx = vm.createContext({ chrome, console: { log() {}, warn() {}, error() {} }, Date, String, Number, JSON, Promise, Map, Set, Math, Array, Object, Error, setTimeout, clearTimeout, encodeURIComponent, fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  vm.runInContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'tb-empresas.js'), 'utf8'), ctx);
  vm.runInContext(bg, ctx);
  return vm.runInContext('ENDERECO_IDS', ctx);
})();
const naPonte = Object.keys(ENDERECO_IDS);
assert.ok(naPonte.length >= 3,
  'a ponte de Devoluções conhece só ' + naPonte.length + ' empresa(s) — eram 3 em 30/09 (girassol, good, ambtotal)');

/* 2.1.20 (V-09): o popup não tem mais links escritos à mão por empresa — ele se monta da FICHA
   (tb-empresas.js). Então o que se confere aqui é que toda empresa da ponte está na ficha com o
   mesmo prefixo; o link renderizado (com a barra no fim) é provado EXECUTANDO o popup em
   scripts/teste-toolbox-ficha-empresas.js. */
const ficha = require(path.join(raiz, 'toolbox-extensao', 'tb-empresas.js'));
for (const [chave, endereco] of Object.entries(ENDERECO_IDS)) {
  const k = ficha.tbChave(chave);
  assert.ok(k, 'empresa "' + chave + '" está na ponte e não na ficha da Toolbox (tb-empresas.js) — se é empresa ' +
    'nova, acrescente na ficha, senão ela fica sem menu, sem link e sem Central');
  assert.ok(endereco.startsWith(ficha.TB_EMPRESAS[k].devolucoes + '/api/'),
    'o endereço da ponte da ' + k + ' (' + endereco + ') não bate com o prefixo da ficha (' + ficha.TB_EMPRESAS[k].devolucoes + ')');
}
assert.ok(!/\['↩️ Devoluções (Girassol|GOOD|AMB)', '/.test(popup), 'o popup voltou a ter link de Devoluções escrito à mão por empresa — a lista é a ficha');

/* a versão do manifest precisa subir quando a extensão muda: sem isso ele não sabe se
   instalou a nova (ele instala à mão nos três navegadores) */
const manifesto = JSON.parse(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'manifest.json'), 'utf8'));
assert.ok(/^\d+\.\d+\.\d+$/.test(manifesto.version), 'a versão do manifest saiu do formato X.Y.Z');

console.log('OK: Toolbox — toda empresa atendida pela ponte está na ficha, com o mesmo prefixo (' + naPonte.join(', ') + ')');
