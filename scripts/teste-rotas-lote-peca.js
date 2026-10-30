'use strict';
/* 30/10 — as ROTAS DE LOTE do checkout (etiquetas em massa, a página de envio, as DANFEs em lote) e o DECODIFICADOR das
   etiquetas da Shopee viraram peças únicas (lib/checkout/rotas-lote, lib/checkout/decodificar-zpl-shopee) — eram só da
   GOOD. Passo 1: a GOOD usa as peças. Prova:
   · o código das peças COMO A GOOD AS RODA (prefixo, nome no log, empresa do aviso no lugar) é, linha por linha, o de
     antes (fixtures) — só mudou de onde vêm as peças;
   · as rotas funcionam de verdade (a peça, com manifesto e pastas de mentira): casa pela NF, grava a etiqueta na pasta,
     marca etiqueta_anexada no manifesto e no pedido; NF duplicada no manifesto = ambígua (não casa às cegas); NF que não
     existe = sem pedido; quem não é admin leva 403; a página de envio chama a rota NO PREFIXO da empresa;
   · a GOOD não tem mais as rotas nem o decodificador no arquivo dela. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const codigo = require('./_codigo-ciclo');

// 1) o código como a GOOD roda = o de antes
const peca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-lote.js'), 'utf8');
const i = peca.indexOf('  async function handle(req, res, p, method, urlObj) {\n'), j = peca.indexOf('\n    return false;\n  }\n\n  return { handle };');
/* o código das rotas COMO A GOOD AS RODA: as aspas do HTML vêm escapadas (\") no arquivo — desescapo dos dois lados antes de
   comparar; a troca do botão vem ANTES da troca genérica do prefixo */
const desesc = (t) => t.split('\\"').join('"');
const comoGood = desesc(peca.slice(i + '  async function handle(req, res, p, method, urlObj) {\n'.length, j))
  .split("fetch(\"' + PREFIXO + '/etiquetas-zpl-massa\"").join('fetch("/good-checkout-offline/etiquetas-zpl-massa"')
  .split("PREFIXO + '/").join("'/good-checkout-offline/").split("'[' + TAG + ']").join("'[GOODBKP]")
  .split("require('../avisar-devolucoes')(EMPRESA_AVISO,").join("require('../lib/avisar-devolucoes')('good',")
  .split("{ Location: PREFIXO + '/' }").join("{ Location: '/good-checkout-offline/' }")
  .split("· ' + NOME + '</title>").join('· GOOD</title>').split("— ' + NOME + '</h2>").join('— GOOD</h2>');
const antes = desesc(fs.readFileSync(path.join(__dirname, 'fixtures', 'rotas-lote-good-antes.js.txt'), 'utf8'));
const A = codigo(antes), R = codigo(comoGood);
if (JSON.stringify(A) !== JSON.stringify(R)) { const k = A.findIndex((l, n) => l !== R[n]); assert.fail('as rotas de lote como a GOOD roda NÃO são as de antes — linha ' + k + ':\n  antes: ' + String(A[k]).slice(0, 160) + '\n  agora: ' + String(R[k]).slice(0, 160)); }
const dec = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'decodificar-zpl-shopee.js'), 'utf8');
const decAntes = fs.readFileSync(path.join(__dirname, 'fixtures', 'decod-zpl-good-antes.js.txt'), 'utf8');
const dA = codigo(decAntes), dR = codigo(dec).filter((l) => !/^(const fs = require\('fs'\);|const path = require\('path'\);|module\.exports = \{ decodificarZplShopee \};|'use strict';)$/.test(l));
assert.deepStrictEqual(dR, dA, 'o decodificador não é o de antes');
assert.ok(A.length > 100, 'a fixture veio curta');

(async () => {
  // 2) as rotas funcionando
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lote-'));
  const MANIFEST_FILE = path.join(dir, '_manifest.json');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
  writeJson(MANIFEST_FILE, { 101: { nf_numero: 5555, numero: 9001 }, 102: { nf_numero: 7777 }, 103: { nf_numero: 7777 } });
  fs.mkdirSync(path.join(dir, '101')); writeJson(path.join(dir, '101', 'pedido.json'), { id: 101 });
  let resp = null;
  const json = (res, code, o) => { resp = { code, o }; };
  const { criarRotasLote } = require('../lib/checkout/rotas-lote');
  let admin = true;
  const rl = criarRotasLote({ prefixo: '/amb-checkout-offline', tag: 'AMBBKP', nome: 'AMB', empresaAviso: 'amb', CACHE_DIR: dir, MANIFEST_FILE, ETIQ_FORMATO: 'zpl',
    json, readBody: async (req) => req._body, readJson, writeJson, ensureDir: (d) => fs.mkdirSync(d, { recursive: true }), manifest: () => readJson(MANIFEST_FILE, {}),
    validarSessao: () => (admin ? 'diego' : 'estoquista'), ehAdmin: () => admin, baixarDanfe: async () => null });
  const zpl = (n) => Buffer.from('^XA^FO10,10^FD' + 'x'.repeat(300) + n + '^FS^XZ', 'latin1').toString('base64');
  const req = { headers: { cookie: 'x' }, _body: { etiquetas: [{ nf: 5555, zpl_base64: zpl(1) }, { nf: 7777, zpl_base64: zpl(2) }, { nf: 9999, zpl_base64: zpl(3) }] } };
  const res = { writeHead() {}, end() {} };
  const tratou = await rl.handle(req, res, '/amb-checkout-offline/etiquetas-zpl-massa', 'POST', new URL('http://x/amb-checkout-offline/etiquetas-zpl-massa'));
  assert.ok(tratou && resp && resp.code === 200 && resp.o.anexadas === 1, 'a massa não casou 1 etiqueta: ' + JSON.stringify(resp));
  assert.deepStrictEqual(resp.o.ambiguas, [7777], 'NF duplicada no manifesto tinha que ser ambígua');
  assert.deepStrictEqual(resp.o.sem_pedido, [9999], 'NF sem pedido tinha que voltar em sem_pedido');
  assert.ok(fs.existsSync(path.join(dir, '101', 'etiqueta.zpl')), 'a etiqueta não foi gravada na pasta do pedido');
  assert.ok(readJson(MANIFEST_FILE, {})['101'].etiqueta_anexada === true && readJson(path.join(dir, '101', 'pedido.json'), {}).etiqueta_anexada === true, 'não marcou etiqueta_anexada no manifesto e no pedido');
  admin = false;
  await rl.handle(req, res, '/amb-checkout-offline/etiquetas-zpl-massa', 'POST', new URL('http://x/'));
  assert.strictEqual(resp.code, 403, 'quem não é admin tinha que levar 403');
  admin = true;
  let html = '';
  const resH = { writeHead() {}, end(b) { html = String(b || ''); }, setHeader() {} };
  const tH = await rl.handle({ headers: { cookie: 'x' } }, resH, '/amb-checkout-offline/etiquetas-massa', 'GET', new URL('http://x/amb-checkout-offline/etiquetas-massa'));
  assert.ok(tH && /Etiquetas em massa · AMB/.test(html) && html.includes('fetch("/amb-checkout-offline/etiquetas-zpl-massa"') && !/good-checkout/.test(html), 'a página de envio não chama a rota no prefixo da empresa');
  assert.strictEqual(await rl.handle({ headers: {} }, res, '/amb-checkout-offline/outra', 'GET', new URL('http://x/')), false, 'rota que não é dela tinha que passar adiante');
  let erro = null; try { criarRotasLote({ prefixo: '/x' }); } catch (e) { erro = e.message; }
  assert.ok(erro && /falta peça da empresa/.test(erro), 'peça sem a configuração tinha que recusar');
  // 3) a GOOD usa as peças e não tem mais as rotas no arquivo dela
  const g = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(g.includes("if (await _rotasLote(readBody).handle(req, res, p, method, urlObj)) return true;") && g.includes("prefixo: '/good-checkout-offline', tag: 'GOODBKP', nome: 'GOOD', empresaAviso: 'good',"), 'a GOOD não usa a peça');
  assert.ok(!/async function decodificarZplShopee|p === '\/good-checkout-offline\/etiquetas-zpl-massa'/.test(g), 'sobrou a cópia na GOOD');
  console.log('ok — rotas de lote e decodificador em peça única: a GOOD roda o mesmo código; massa casa pela NF, ambígua/sem pedido/403; a página chama o prefixo da empresa');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
