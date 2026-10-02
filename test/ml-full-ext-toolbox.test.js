'use strict';
// b10 — rotas que a TOOLBOX usa pra importar sozinha no Bling (igual ao Magalu/Shopee Full):
// /ml-full/ext/estado, /ml-full/zip?max= (lote) e /ml-full/ext/registrar, com CORS so pro
// bling.com.br e o VINCULO empresa<->conta do Bling (nunca subir nota da Girassol na GOOD).
// Exercita o tratar() DE PRODUCAO com req/res falsos.
const os = require('os'); const fs = require('fs'); const path = require('path');
const { EventEmitter } = require('events');
process.env.ML_FULL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mlf-ext-'));   // diretorio PROPRIO
const AdmZip = require('adm-zip');
const mf = require('../ml-full');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const DIR = process.env.ML_FULL_DIR;
const CH = (n) => '3526072754845600014755002' + String(n).padStart(9, '0') + '1144343275';
const A = CH(1), B = CH(2), C = CH(3), G = CH(4);
const gravar = (sub, nome, ch, tp, quando) => {
  fs.mkdirSync(path.join(DIR, sub), { recursive: true });
  const f = path.join(DIR, sub, nome);
  fs.writeFileSync(f, '<nfeProc><NFe><infNFe Id="NFe' + ch + '"><ide><tpNF>' + tp + '</tpNF></ide></infNFe></NFe></nfeProc>');
  fs.utimesSync(f, quando, quando);
};
gravar('saida', 'girassol-111-' + A + '.xml', A, 1, new Date('2026-09-01'));   // a mais antiga
gravar('saida', 'girassol-112-' + B + '.xml', B, 1, new Date('2026-09-02'));
gravar('entrada', 'girassol-113-' + C + '.xml', C, 0, new Date('2026-09-03'));
gravar('saida', 'good-114-' + G + '.xml', G, 1, new Date('2026-09-04'));       // de OUTRA empresa
const L = CH(5);
gravar('saida', 'girassol-9001-8001.xml', L, 1, new Date('2026-09-05'));   // LEGADO da sonda: sem a chave no NOME (so no conteudo)
fs.mkdirSync(path.join(DIR, 'saida'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'saida', 'girassol-9002-8002.xml'), '<lixo/>');   // sem chave nem no conteudo

function chamar(metodo, url, { origem, corpo } = {}) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = metodo; req.headers = origem ? { origin: origem } : {};
    const out = { status: null, headers: {}, corpo: null, buf: null };
    const res = {
      setHeader: (k, v) => { out.headers[k.toLowerCase()] = v; },
      writeHead: (st, h) => { out.status = st; Object.entries(h || {}).forEach(([k, v]) => { out.headers[k.toLowerCase()] = v; }); },
      end: (b) => { if (Buffer.isBuffer(b)) out.buf = b; resolve(out); },
    };
    const json = (r, st, obj) => { out.status = st; out.corpo = obj; resolve(out); };
    Promise.resolve(mf.tratar(req, res, new URL('http://x' + url), json)).then((t) => { if (!t) { out.naoTratou = true; resolve(out); } });
    if (corpo !== undefined) setImmediate(() => { req.emit('data', typeof corpo === 'string' ? corpo : JSON.stringify(corpo)); req.emit('end'); });
  });
}
const BLING = 'https://www.bling.com.br';
(async () => {
  const pre = await chamar('OPTIONS', '/ml-full/ext/registrar?k=x', { origem: BLING });
  ok(pre.status === 204 && pre.headers['access-control-allow-origin'] === BLING && /POST/.test(pre.headers['access-control-allow-methods'] || ''), '⚠️ preflight do Bling: 204 com CORS (a extensao faz POST JSON)');
  const e1 = await chamar('GET', '/ml-full/ext/estado?empresa=girassol&idEmpresa=999&k=chaveX', { origem: BLING });
  ok(e1.status === 200 && e1.corpo.saida === 3 && e1.corpo.entrada === 1 && e1.corpo.precisa === true, '⚠️ estado: 3 de saida (2 + o legado da sonda) + 1 de entrada; o XML sem chave nenhuma nao conta');
  ok(e1.headers['access-control-allow-origin'] === BLING, '  estado com CORS pro bling.com.br');
  ok(!JSON.stringify(e1.corpo).includes(G), '  a nota da GOOD NAO aparece no estado da girassol');
  ok(/\/ml-full\/zip\?empresa=girassol&tipo=saida&max=\d+&k=chaveX/.test(e1.corpo.url_zip_saida || ''), '  url do ZIP pronta (empresa, tipo, lote e chave)');
  ok(!('chaves_saida' in e1.corpo) && !('chaves_entrada' in e1.corpo), '⚠️ Codex #578 (P1): o estado NAO lista chaves (o lote de verdade vem no X-Chaves do ZIP)');
  const mal = await chamar('GET', '/ml-full/ext/estado?empresa=girassol&k=x', { origem: 'https://evil.example' });
  ok(!mal.headers['access-control-allow-origin'], '  outra origem NAO ganha CORS');
  // ZIP em lote: max=1 traz a MAIS ANTIGA
  const z = await chamar('GET', '/ml-full/zip?empresa=girassol&tipo=saida&max=1&k=x', { origem: BLING });
  const nomes = z.buf ? new AdmZip(z.buf).getEntries().map((x) => x.entryName) : [];
  ok(z.status === 200 && nomes.length === 1 && nomes[0].includes(A), '⚠️ ZIP em lote (max=1): so a mais antiga — o resto vem na proxima volta');
  ok(z.headers['access-control-allow-origin'] === BLING, '  ZIP com CORS (a extensao baixa de dentro do Bling)');
  ok(z.headers['x-chaves'] === A && /X-Chaves/i.test(z.headers['access-control-expose-headers'] || ''), '⚠️ o ZIP diz QUAIS chaves leva (X-Chaves, exposto pro CORS) — a extensao registra exatamente essas');
  // registrar: importada + duplicada saem da fila; a conta fica vinculada
  const r1 = await chamar('POST', '/ml-full/ext/registrar?k=x', { origem: BLING, corpo: { empresa: 'girassol', idEmpresa: '999', importadas: [A], duplicadas: [C] } });
  ok(r1.status === 200 && r1.corpo.arquivadas === 2 && r1.corpo.nao_achadas.length === 0, '⚠️ registrar: a importada e a duplicada saem da fila');
  ok(r1.corpo.vinculo_aprendido === true, '⚠️ ... e a conta do Bling (999) fica vinculada a girassol');
  ok(fs.existsSync(path.join(DIR, 'importadas', 'girassol-111-' + A + '.xml')), '  o XML foi pra importadas/ (historico preservado)');
  const e2 = await chamar('GET', '/ml-full/ext/estado?empresa=girassol&idEmpresa=999&k=x');
  ok(e2.corpo.saida === 2 && e2.corpo.entrada === 0, '  estado depois: B e o legado');
  // CONTA ERRADA: outra sessao do Bling
  const e3 = await chamar('GET', '/ml-full/ext/estado?empresa=girassol&idEmpresa=888&k=x', { origem: BLING });
  ok(e3.status === 409 && e3.corpo.erro === 'conta_errada', '⚠️ outra conta do Bling: 409 conta_errada (nunca subir nota da girassol em outra empresa)');
  const r2 = await chamar('POST', '/ml-full/ext/registrar?k=x', { corpo: { empresa: 'girassol', idEmpresa: '888', importadas: [B] } });
  ok(r2.status === 409 && fs.existsSync(path.join(DIR, 'saida', 'girassol-112-' + B + '.xml')), '  registrar de outra conta: 409 e nada sai da fila');
  const zl = await chamar('GET', '/ml-full/zip?empresa=girassol&tipo=saida&max=10&k=x', { origem: BLING });
  ok((zl.headers['x-chaves'] || '').split(',').includes(L) && (zl.headers['x-chaves'] || '').split(',').length === 2, '⚠️ Codex #578 (P2): o legado da sonda entra no lote com a chave lida do CONTEUDO; o XML sem chave fica de fora');
  const rl = await chamar('POST', '/ml-full/ext/registrar?k=x', { corpo: { empresa: 'girassol', idEmpresa: '999', importadas: [L] } });
  ok(rl.status === 200 && rl.corpo.arquivadas === 1 && !fs.existsSync(path.join(DIR, 'saida', 'girassol-9001-8001.xml')), '⚠️ ... e sai da fila pela chave do conteudo (nao fica subindo pra sempre)');
  ok((await chamar('GET', '/ml-full/ext/estado?empresa=girassol&k=x')).status === 400, '⚠️ Codex #578 (P2): estado SEM idEmpresa = 400 (o vinculo nao pode ser pulado)');
  ok((await chamar('POST', '/ml-full/ext/registrar?k=x', { corpo: { empresa: 'girassol', importadas: [B] } })).status === 400 && fs.existsSync(path.join(DIR, 'saida', 'girassol-112-' + B + '.xml')), '⚠️ registrar SEM idEmpresa = 400 e nada sai da fila');
  // entradas invalidas
  ok((await chamar('GET', '/ml-full/ext/registrar?k=x')).status === 405, '  registrar so aceita POST');
  ok((await chamar('POST', '/ml-full/ext/registrar?k=x', { corpo: '{quebrado' })).status === 400, '  JSON invalido: 400');
  ok((await chamar('GET', '/ml-full/ext/estado?empresa=xpto&idEmpresa=999&k=x')).status === 400, '  empresa desconhecida: 400');
  const r3 = await chamar('POST', '/ml-full/ext/registrar?k=x', { corpo: { empresa: 'girassol', idEmpresa: '999', importadas: ['123', 'abc', CH(77)] } });
  ok(r3.status === 200 && r3.corpo.arquivadas === 0 && r3.corpo.nao_achadas.length === 1, '  chave malformada e ignorada; chave sem arquivo vira nao_achada');
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('FALHA (excecao):', e && e.stack); process.exit(1); });
