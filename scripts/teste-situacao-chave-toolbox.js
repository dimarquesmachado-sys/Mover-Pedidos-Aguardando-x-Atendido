'use strict';
/* 12/11 — AS DUAS ROTAS DO "CONSULTAR SITUAÇÃO" ACEITAM A CHAVE DA TOOLBOX (além da de admin).
   Pedido do dono: as notas não podem depender de ele abrir o Bling ("se eu não entrar, a NF fica travada infinita"). A
   Toolbox faz a consulta em qualquer navegador com o Bling aberto — os do galpão ficam o dia todo. Só que ela pedia a
   chave de ADMIN, que não pode morar no computador do estoquista. Prova:
   1) a regra: só `/robo/nfs-consultar-situacao` e `/robo/nfs-consultar-situacao/resultado` (com o prefixo de qualquer
      empresa) entram na exceção; o resto de /robo/ não; a chave confere em tempo constante e, sem a env, ninguém passa;
   2) o SERVIDOR DE VERDADE: com a chave da Toolbox no header a lista passa pelo porteiro nas três empresas; chave
      errada, chave na URL ou sem chave → "não encontrada"; a chave de admin continua valendo; e as OUTRAS rotas de
      /robo/ (o teste do reenvio) NÃO abrem com a chave da Toolbox. */
const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { ehRotaRoboToolbox, chaveToolboxConfere, ehRotaCentralAdmin } = require('../lib/http/rotas-protegidas');

for (const p of ['/robo/nfs-consultar-situacao', '/amb/robo/nfs-consultar-situacao', '/good/robo/nfs-consultar-situacao', '/quarta/robo/nfs-consultar-situacao', '/robo/nfs-consultar-situacao/resultado', '/amb/robo/nfs-consultar-situacao/resultado'])
  assert.ok(ehRotaRoboToolbox(p) && ehRotaCentralAdmin(p), p + ' tem que estar na exceção (e continuar sendo rota central)');
for (const p of ['/robo/nf-reenvio-teste', '/amb/robo/nf-reenvio-teste', '/robo/nfs-consultar-situacao/outra', '/robo/nfs-consultar-situacaoX', '/a/b/robo/nfs-consultar-situacao', '/run/corrigir-nfs', '/amb/setup-nf', '/robo/', '', null])
  assert.ok(!ehRotaRoboToolbox(p), JSON.stringify(p) + ' NÃO pode entrar na exceção da chave da Toolbox');
assert.ok(chaveToolboxConfere('abc', 'abc') && !chaveToolboxConfere('abd', 'abc') && !chaveToolboxConfere('ab', 'abc') && !chaveToolboxConfere('', '') && !chaveToolboxConfere('x', '') && !chaveToolboxConfere(undefined, 'abc'), 'a chave só confere igual — e sem a env configurada ninguém passa');

const PORTA = 39000 + Math.floor(Math.random() * 500);
function pedir(caminho, headers) {
  return new Promise((ok) => {
    const rq = http.request({ host: '127.0.0.1', port: PORTA, path: caminho, method: 'GET', headers: headers || {} }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => ok({ st: r.statusCode, b })); });
    rq.on('error', () => ok({ st: 0, b: '' })); rq.setTimeout(20000, () => { rq.destroy(); ok({ st: 0, b: 'timeout' }); }); rq.end();
  });
}
(async () => {
  const tmp = require('os').tmpdir() + '/sit-toolbox-' + process.pid;
  const srv = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: Object.assign({}, process.env, { PORT: String(PORTA), ADMIN_KEY: 'adm-teste', TOOLBOX_KEY: 'tbx-teste', ML_FULL_DIR: tmp + '/mlf', ML_FULL_CONF_ARQ: tmp + '/mlf.json', GIRABKP_CACHE_DIR: tmp + '/g', AMBBKP_CACHE_DIR: tmp + '/a', GOODBKP_CACHE_DIR: tmp + '/o' }) });
  try {
    let pronto = false;
    for (let i = 0; i < 60 && !pronto; i++) { await new Promise((ok) => setTimeout(ok, 500)); const r = await pedir('/comum/nav.js'); pronto = r.st === 200; }
    assert.ok(pronto, 'o servidor não subiu');
    for (const pre of ['', '/amb', '/good']) {
      const rota = pre + '/robo/nfs-consultar-situacao';
      let r = await pedir(rota, { 'X-Toolbox-Key': 'tbx-teste' });
      assert.ok(r.st !== 404 && /refresh_token|token|nfs/i.test(r.b), rota + ' com a chave da Toolbox tinha que PASSAR pelo porteiro (aqui para no token do Bling, que não existe no teste): ' + r.st + ' ' + r.b.slice(0, 120));
      r = await pedir(rota, { 'X-Toolbox-Key': 'errada' }); assert.strictEqual(r.st, 404, rota + ' com chave errada');
      r = await pedir(rota); assert.strictEqual(r.st, 404, rota + ' sem chave');
      r = await pedir(rota + '?k=tbx-teste'); assert.strictEqual(r.st, 404, rota + ': a chave da Toolbox NA URL não vale (só no header; na URL é a de admin)');
      r = await pedir(rota + '?k=adm-teste'); assert.notStrictEqual(r.st, 404, rota + ': a chave de admin continua valendo');
      r = await pedir(pre + '/robo/nf-reenvio-teste?id=12345678', { 'X-Toolbox-Key': 'tbx-teste' });
      assert.strictEqual(r.st, 404, pre + '/robo/nf-reenvio-teste NÃO pode abrir com a chave da Toolbox (só admin)');
    }
    console.log('ok — as duas rotas do "Consultar situação" aceitam a chave da Toolbox (só no header), nas três empresas; o resto de /robo/ continua só admin');
  } finally { try { srv.kill('SIGKILL'); } catch (e) {} }
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
