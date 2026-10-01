'use strict';
// O INDICE EAN DO ESTOQUE-GIRASSOL (e do fragil) SOBREVIVE AO REINICIO.
// Medido 01/10: 9s apos cada boot, ~9.000 buscas de detalhe a 1/s na conta
// Bling da Girassol (2h30) so pra montar o indice EAN em memoria. Com a fila
// do Devolucoes, passava dos 3/s do Bling: 429 no bipe por 2h30 a cada deploy.

const fs = require('fs');
const os = require('os');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const disco = require('../lib/indice-ean-disco');
const tmp = path.join(os.tmpdir(), 'indice-ean-teste-' + process.pid, 'sub', 'indice-ean.json');

// ── a lib ──
{
  const v = disco.carregar(tmp);
  ok(v.eans.size === 0 && v.verificados.size === 0 && !v.erro, '  sem arquivo: vazio, sem erro (boot faz a carga inteira, como antes)');
  const eans = new Map([['7891234567890', '11'], ['7899999999999', '12']]);
  const verif = new Set(['11', '12', '13']);   // 13: produto SEM ean, mas ja verificado
  const r = disco.salvar(tmp, eans, verif);
  ok(r.ok && r.eans === 2 && r.verificados === 3, '⚠️ salva (cria a pasta, atomico via tmp+rename)');
  ok(fs.existsSync(tmp) && !fs.existsSync(tmp + '.tmp'), '  o .tmp nao sobra');
  const c = disco.carregar(tmp);
  ok(c.eans.get('7891234567890') === '11' && c.verificados.has('13') && c.salvo_em, '  carrega de volta: EANs, ids verificados (inclusive o SEM ean) e a data');
  fs.writeFileSync(tmp, '{ corrompido');
  const cc = disco.carregar(tmp);
  ok(cc.eans.size === 0 && cc.erro, '  arquivo corrompido: vazio + erro (nunca lanca; o boot segue)');
  // arquivo antigo sem a lista de verificados: quem tem EAN conta como verificado
  fs.writeFileSync(tmp, JSON.stringify({ eans: { '7890000000000': '99' } }));
  ok(disco.carregar(tmp).verificados.has('99'), '  arquivo sem "verificados": todo id com EAN vale como verificado');
  ok(disco.salvar('', eans, verif).ok === false, '  sem caminho: ok:false, nao lanca');
}

// ── os dois apps usam a lib e PULAM os verificados ──
for (const [p, env] of [['estoque-girassol/blingProdutos.js', 'ESTOQUE_GIRASSOL_INDICE_EAN_FILE'], ['fragil/blingProdutos.js', 'FRAGIL_INDICE_EAN_FILE']]) {
  const s = fs.readFileSync(path.join(__dirname, '..', p), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const nome = p.split('/')[0];
  ok(/require\('\.\.\/lib\/indice-ean-disco'\)/.test(s), `⚠️ ${nome}: usa a lib`);
  ok(new RegExp(`process\\.env\\.${env} \\|\\| '/data/${nome}/indice-ean\\.json'`).test(s), `  ${nome}: arquivo no disco persistente (/data/${nome}/), env ${env}`);
  ok(/const disco = eanDisco\.carregar\(INDICE_EAN_FILE\);/.test(s), `  ${nome}: carrega do disco ANTES de qualquer chamada ao Bling`);
  ok(/filter\(\(id\) => !idsVerificados\.has\(String\(id\)\)\)/.test(s), `⚠️ ${nome}: so busca os NAO verificados (o 2o boot nao refaz as 9.000)`);
  ok(/idsVerificados\.add\(String\(p\.id\)\);/.test(s), `  ${nome}: buscarDetalhe marca o id como verificado (com ou sem EAN)`);
  ok(/eanDisco\.salvar\(INDICE_EAN_FILE, indiceEan, idsVerificados\)/.test(s), `  ${nome}: salva ao terminar`);
  ok(/desdeOUltimoSalvo >= 200/.test(s), `  ${nome}: e a cada 200 no meio (um reinicio em 2h nao perde tudo)`);
  // Regra 12: os nomes existem
  ok(/const idsVerificados = new Set\(\)/.test(s) && /const indiceEan\s+= new Map\(\)/.test(s), `  ${nome}: idsVerificados e indiceEan declarados`);
  ok(s.indexOf('const idsVerificados') < s.indexOf('async function buscarDetalhe'), `  ${nome}: declarado antes de buscarDetalhe usar (sem TDZ)`);
}

// ── simulacao do 2o boot: o que o filtro faz com o disco cheio ──
{
  const idsListagem = ['11', '12', '13', '14'];   // 14 e novo
  const d = disco.carregar(tmp);
  // reconstruo o disco cheio
  disco.salvar(tmp, new Map([['7891234567890', '11'], ['7899999999999', '12']]), new Set(['11', '12', '13']));
  const d2 = disco.carregar(tmp);
  const pendentes = idsListagem.filter((id) => !d2.verificados.has(id));
  ok(pendentes.length === 1 && pendentes[0] === '14', '⚠️ 2o boot: de 4 produtos, so o NOVO (14) vai ao Bling — nao os 9.000');
}
try { fs.rmSync(path.dirname(path.dirname(tmp)), { recursive: true, force: true }); } catch (e) {}

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
