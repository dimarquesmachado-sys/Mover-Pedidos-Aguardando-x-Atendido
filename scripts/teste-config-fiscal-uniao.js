'use strict';
/* 08/11 (rotas comuns, passo 10a) — O /config-fiscal NIVELADO (igual nas três empresas). Roda o CÓDIGO DE VERDADE da rota
   de cada empresa (o trecho do arquivo dela) com o disco e a sessão de mentira:
   · GET devolve as alíquotas padrão DA EMPRESA;
   · POST: mês em branco e 0% apagam (não gravam 0%); a CIÊNCIA da alíquota herdada é gravada com quem e quando (a GOOD
     ignorava — o dashboard é o mesmo nas três e o aviso nunca saía na GOOD); o flex só aceita ml/shopee/outros/geral e
     quem salva 'outros' apaga o 'geral' antigo (Girassol e AMB não apagavam); o que mudou (com filtro de mês, em ordem)
     vai pra reaplicação do imposto; o cache do histórico é limpo. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
function bloco(src, ini) { let n = 0, j = src.indexOf('{', ini); for (; j < src.length; j++) { const c = src[j]; if (c === '{') n++; else if (c === '}') { n--; if (!n) break; } } return j + 1; }
function rotaDe(arq, pfx) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const m = new RegExp("[ \\t]*if \\(\\(method === 'GET' \\|\\| method === 'POST'\\) && p === '" + pfx.replace(/[-/]/g, '\\$&') + "/config-fiscal'\\) \\{").exec(s);
  assert.ok(m, arq + ': não achei a rota /config-fiscal');
  return s.slice(s.lastIndexOf('\n', m.index) + 1, bloco(s, m.index));
}
const LIVRES = ['validarSessao', 'lerChaveAdmin', 'ehAdmin', 'json', 'path', 'CACHE_DIR', 'ALIQ_APURADOS', 'readJson', 'readBody', 'writeJson', 'ALIQ_PADRAO', 'DEFAULT_ALIQ_BK', '_histCache', 'reaplicarImposto', 'console'];
async function rodar(rota, pfx, metodo, corpo, disco) {
  let resp = null; const reaplicados = []; const hist = { a: 1, b: 2 };
  const PADRAO = { '2026-01': 9.9 };
  const fab = new Function(...LIVRES, 'return async function (req, res, p, method, urlObj) {\n' + rota + '\nreturn false; };');
  const h = fab(() => ({ usuario: 'diego' }), () => null, () => true, (res, code, body) => { resp = { code, body }; }, path, '/c', ['2026-01'],
    (f, d) => (disco.cfg ? JSON.parse(JSON.stringify(disco.cfg)) : d), async () => corpo, (f, v) => { disco.cfg = JSON.parse(JSON.stringify(v)); },
    PADRAO, PADRAO, hist, async (m) => { reaplicados.push(...m); }, { log: () => {} });
  await h({ method: metodo, headers: {} }, {}, pfx + '/config-fiscal', metodo, new URL('http://h' + pfx + '/config-fiscal'));
  await new Promise((s) => setImmediate(s));
  return { resp, reaplicados, hist, PADRAO };
}
(async () => {
  /* 08/11 (passo 10b): a rota mora na PEÇA comum — o código de verdade é o dela; cada empresa entrega as alíquotas
     padrão, os meses apurados, o cache do histórico e a reaplicação DELA, e não sobra cópia no arquivo da empresa */
  const _src = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
  const _m = /[ \t]*if \(\(method === 'GET' \|\| method === 'POST'\) && p === PREFIXO \+ '\/config-fiscal'\) \{/.exec(_src);
  assert.ok(_m, 'a rota /config-fiscal não está na peça comum');
  const ROTA_PECA = _src.slice(_src.lastIndexOf('\n', _m.index) + 1, bloco(_src, _m.index)).replace("PREFIXO + '/config-fiscal'", "'/x/config-fiscal'");
  const ESPERADO = { 'girassol-backup-offline/gbo-app.js': /ALIQ_PADRAO: DEFAULT_ALIQ_BK, ALIQ_APURADOS, _histCache, reaplicarImposto: \(\.\.\.a\) => reaplicarImposto\(\.\.\.a\),/,
    'amb-checkout-offline/index.js': /ALIQ_PADRAO: DEFAULT_ALIQ_BK, ALIQ_APURADOS, _histCache, reaplicarImposto: \(\.\.\.a\) => reaplicarImposto\(\.\.\.a\),/,
    'good-checkout-offline/index.js': /ALIQ_PADRAO: DEFAULT_ALIQ_BK_GOOD, ALIQ_APURADOS, _histCache: _histCacheGood, reaplicarImposto: \(\.\.\.a\) => reaplicarImposto\(\.\.\.a\),/ };
  for (const [arq, pfx] of [['girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'], ['amb-checkout-offline/index.js', '/amb-checkout-offline'], ['good-checkout-offline/index.js', '/good-checkout-offline']]) {
    const emp = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(ESPERADO[arq].test(emp), arq + ': a empresa não entrega à peça as alíquotas/cache/reaplicação DELA');
    assert.ok(!new RegExp("p === '" + pfx.replace(/[-/]/g, '\\$&') + "/config-fiscal'").test(emp), arq + ': sobrou cópia da rota no arquivo da empresa');
    const rota = ROTA_PECA;
    const g = await rodar(rota, '/x', 'GET', null, {});
    assert.ok(g.resp.code === 200 && g.resp.body.apuradas === g.PADRAO, arq + ': o GET não devolveu as alíquotas padrão da empresa');
    const disco = { cfg: { aliquotas: { '2026-10': 7, '2026-11': 6 }, taxas: {}, flex: { geral: 4, ml: 2 } } };
    const r = await rodar(rota, '/x', 'POST', { aliquotas: { '2026-09': 8, '2026-10': null, '2026-11': 0 }, taxas: { ML: 12 }, flex: { outros: 5, invalido: 3, ml: null }, ciencia_aliq: { '2026-11': '2026-10' } }, disco);
    const c = disco.cfg;
    assert.deepStrictEqual(c.aliquotas, { '2026-09': 8 }, arq + ': em branco e 0% tinham que apagar (não gravar 0%): ' + JSON.stringify(c.aliquotas));
    assert.strictEqual(c.taxas.ml, 12, arq + ': a taxa não foi gravada');
    assert.deepStrictEqual(c.flex, { outros: 5 }, arq + ': flex — chave inválida ignorada, campo limpo apaga, e quem salva "outros" apaga o "geral" antigo: ' + JSON.stringify(c.flex));
    assert.ok(c.ciencia_aliq && c.ciencia_aliq['2026-11'] && c.ciencia_aliq['2026-11'].de === '2026-10' && c.ciencia_aliq['2026-11'].por === 'diego',
      arq + ': a CIÊNCIA da alíquota herdada não foi gravada: ' + JSON.stringify(c.ciencia_aliq));
    assert.deepStrictEqual(r.reaplicados, ['2026-09', '2026-10', '2026-11'], arq + ': os meses que mudaram (em ordem) tinham que ir pra reaplicação: ' + JSON.stringify(r.reaplicados));
    assert.strictEqual(Object.keys(r.hist).length, 0, arq + ': o cache do histórico tinha que ser limpo');
    assert.ok(r.resp.code === 200 && r.resp.body.ok, arq + ': o POST não respondeu ok');
    /* Codex #812: 'outros' FORA da faixa (101) não apaga o 'geral' salvo — a conta continuaria com R$4, não cairia no padrão */
    const d2 = { cfg: { aliquotas: {}, taxas: { ml: 12, shopee: 20 }, flex: { geral: 4 } } };
    await rodar(rota, '/x', 'POST', { flex: { outros: 101 }, taxas: { ml: null, shopee: 0 } }, d2);
    assert.deepStrictEqual(d2.cfg.flex, { geral: 4 }, arq + ': "outros" recusado (101) não podia apagar o "geral" salvo: ' + JSON.stringify(d2.cfg.flex));
    /* (auditoria da função) taxa: campo limpo APAGA (volta ao padrão); 0 digitado é gravado como 0 */
    assert.ok(!('ml' in d2.cfg.taxas) && d2.cfg.taxas.shopee === 0, arq + ': taxa — campo limpo tinha que apagar e 0 digitado gravar 0: ' + JSON.stringify(d2.cfg.taxas));
  }
  console.log('ok — /config-fiscal nivelado nas três: alíquota em branco/0% apaga, ciência gravada com quem e quando, flex com as chaves certas e "outros" no lugar do "geral", reaplicação dos meses que mudaram, cache do histórico limpo');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
