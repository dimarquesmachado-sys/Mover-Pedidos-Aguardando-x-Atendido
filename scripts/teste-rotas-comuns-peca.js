'use strict';
/* 31/10 — ROTAS COMUNS em peça única (lib/checkout/rotas-comuns): as 26 rotas que as TRÊS empresas tinham escritas iguais no
   arquivo delas (arquivos, DANFE, etiqueta, XML, impressão, login, operadores, QZ, reenvio de documentos, faturamento do ML,
   cookies da Shopee, separação) — ~560 linhas fora de cada um dos três arquivos. Prova:
   · rota por rota, o código da peça COMO CADA EMPRESA O RODA (prefixo — inclusive o do cookie da sessão —, nome no log e a
     chave dela no lugar) é o código que a empresa tinha (fixtures);
   · as três montam a peça com a configuração delas e chamam no lugar da primeira dessas rotas; nenhuma delas sobrou no
     arquivo de nenhuma empresa;
   · a peça atende de verdade (o certificado do QZ) no prefixo de cada empresa e passa adiante o que não é dela. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const codigo = require('./_codigo-ciclo');
const peca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-comuns.js'), 'utf8');
const corpo = peca.slice(peca.indexOf('  async function handle(req, res, p, method, urlObj) {\n'), peca.indexOf('\n    return false;\n  }\n\n  return { handle };'));
function blocos(texto) {
  const L = texto.split('\n'), out = {};
  for (let i = 0; i < L.length; i++) {
    const l = L[i];
    if (!/^\s*(if|else if)\s*\(/.test(l)) continue;
    const m = /\bp(?: ===|\.startsWith\() ?\(?'(\/[A-Za-z0-9_.-]*\/?)'/.exec(l.replace(/PREFIXO \+ '/g, "'"));
    if (!m) continue;
    const mm = /method === '([A-Z]+)'/.exec(l), k = (mm ? mm[1] : '*') + ' ' + m[1];
    const ind = l.length - l.trimStart().length; let j = i + 1;
    while (j < L.length && !(L[j].startsWith(' '.repeat(ind) + '}') && L[j].length - L[j].trimStart().length === ind)) j++;
    out[k] = L.slice(i, j + 1).join('\n');
  }
  return out;
}
const P = blocos(corpo);
const EMP = [['amb', 'amb-checkout-offline', 'AMBBKP', 'index.js'], ['good', 'good-checkout-offline', 'GOODBKP', 'index.js'], ['girassol', 'girassol-backup-offline', 'GIRABKP', 'gbo-app.js']];
for (const [emp, pasta, tag, arq] of EMP) {
  const pref = '/' + pasta;
  const antes = require('./fixtures/rotas-comuns-' + emp + '-antes.json').rotas;
  assert.strictEqual(Object.keys(P).length, 30, 'a peça não tem as 30 rotas');
  for (const k of Object.keys(antes)) {
    assert.ok(P[k], emp + ': a rota ' + k + ' não está na peça');
    const como = P[k].split("'; Path=' + PREFIXO + '; HttpOnly").join("'; Path=" + pref + "; HttpOnly").split('p === PREFIXO ||').join("p === '" + pref + "' ||").split("PREFIXO + '/").join("'" + pref + '/')
      .split('`[${TAG}]').join('`[' + tag + ']').split('.includes(EMPRESA);').join(".includes('" + emp + "');").split('{ loja: EMPRESA, ').join("{ loja: '" + emp + "', ")
      /* Codex #781: os requires DENTRO das rotas vivem agora em lib/checkout ('../x'); na pasta da empresa eram '../lib/x' */
      .split("require('../").join("require('../lib/");
    const a = codigo(antes[k]), r = codigo(como);
    if (JSON.stringify(a) !== JSON.stringify(r)) { const n = a.findIndex((x, i) => x !== r[i]); assert.fail(emp + ' ' + k + ': o código da peça não é o que a empresa tinha — linha ' + n + ':\n  antes: ' + String(a[n]).slice(0, 150) + '\n  agora: ' + String(r[n]).slice(0, 150)); }
  }
  const s = fs.readFileSync(path.join(raiz, pasta, arq), 'utf8');
  assert.ok(s.includes("prefixo: '" + pref + "', tag: '" + tag + "', empresa: '" + emp + "',") && s.includes('if (await _rotasComuns(readBody).handle(req, res, p, method, urlObj)) return true;'), emp + ': não monta/chama a peça');
  for (const k of Object.keys(antes)) {
    const rota = k.split(' ')[1];
    const re = new RegExp("\\bp(?: ===|\\.startsWith\\() ?\\(?'" + (pref + rota).replace(/[/.*+?^${}()|[\]\\-]/g, '\\$&') + "'");
    /* só BLOCO de rota conta (linha que abre com if/else if) — a lista do porteiro de sessão também cita o caminho, e fica */
    assert.ok(!s.split('\n').some((l) => /^\s*(if|else if)\s*\(/.test(l) && re.test(l)), emp + ': sobrou a rota ' + k + ' no arquivo');
  }
}
/* 31/10 (passo 2): QUEM RESPONDE. A fábrica do painel também atende /custo-historico e /tiktok-custo-devolucoes, e em
   empresa onde ela é chamada ANTES da peça comum (a GOOD), a rota só chega na peça comum se estiver na lista de rotas
   PRÓPRIAS da empresa (a fábrica pula as próprias). Toda rota que as duas atendem tem que estar nessa lista, nas três —
   senão a resposta troca de dona em silêncio. */
{
  const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  const daFabrica = new Set([...fab.matchAll(/^\s*(?:if|else if)\s*\([^\n]*\bp === \(?PREFIXO \+ '\/([A-Za-z0-9_.-]+)'/gm)].map((m) => m[1]));
  const comuns = new Set(Object.keys(P).map((k) => k.split(' ')[1].replace(/^\//, '').replace(/\/$/, '')));
  const asDuas = [...daFabrica].filter((r) => comuns.has(r));
  assert.ok(asDuas.includes('custo-historico') && asDuas.includes('tiktok-custo-devolucoes'), 'a conferência não achou as rotas que as duas atendem: ' + JSON.stringify(asDuas));
  for (const [emp, pasta, , arq] of EMP) {
    const s2 = fs.readFileSync(path.join(raiz, pasta, arq), 'utf8');
    const m = /rotasProprias:\s*\[([^\]]*)\]/.exec(s2);
    const proprias = new Set(m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []);
    for (const r of asDuas) assert.ok(proprias.has(r), emp + ': /' + r + ' é atendida pela fábrica E pela peça comum, mas não está nas rotas PRÓPRIAS da empresa — a fábrica responderia no lugar');
  }
}
(async () => {
  const { criarRotasComuns, PECAS } = require('../lib/checkout/rotas-comuns');
  for (const [emp, pasta, tag] of EMP) {
    const o = { prefixo: '/' + pasta, tag, empresa: emp };
    for (const k of PECAS) o[k] = () => undefined;
    o.QZ_CERT = 'CERT-' + emp;
    const r = criarRotasComuns(o);
    let corpoResp = '';
    const res = { writeHead() {}, setHeader() {}, end(b) { corpoResp += String(b || ''); } };
    const t = await r.handle({ method: 'GET', headers: {} }, res, '/' + pasta + '/qz-cert', 'GET', new URL('http://x/' + pasta + '/qz-cert'));
    assert.ok(t === true && corpoResp.includes('CERT-' + emp), emp + ': o certificado do QZ não saiu no prefixo da empresa');
    assert.strictEqual(await r.handle({ method: 'GET', headers: {} }, res, '/' + pasta + '/nao-existe', 'GET', new URL('http://x/')), false, emp + ': rota que não é dela tinha que passar adiante');
  }
  /* Codex #781: as rotas que carregam um módulo da lib DENTRO delas (NFs travadas) funcionam de verdade, nas três — antes do
     conserto o require apontava pra lib/lib/… e a rota dava 500 "Cannot find module" */
  const os = require('os');
  for (const [emp, pasta, tag] of EMP) {
    const o = { prefixo: '/' + pasta, tag, empresa: emp };
    for (const k of PECAS) o[k] = () => undefined;
    o.CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trav-'));
    const respostas = [];
    o.json = (res, code, body) => respostas.push({ code, body });
    o.lerChaveAdmin = () => null;
    const r = criarRotasComuns(o);
    await r.handle({ method: 'GET', headers: {} }, {}, '/' + pasta + '/nf-travadas', 'GET', new URL('http://x/' + pasta + '/nf-travadas'));
    const ult = respostas[respostas.length - 1];
    assert.ok(ult && ult.code === 200 && !/Cannot find module/.test(JSON.stringify(ult.body)), emp + ': /nf-travadas não respondeu (o módulo da lib não carregou?): ' + JSON.stringify(ult).slice(0, 200));
  }
  let erro = null; try { criarRotasComuns({ prefixo: '/x' }); } catch (e) { erro = e.message; }
  assert.ok(erro && /falta peça da empresa/.test(erro), 'peça sem a configuração tinha que recusar');
  console.log('ok — rotas comuns em peça única: as 30 rotas, rota por rota, são o código que cada empresa tinha; as três chamam a peça; nada sobrou nos arquivos');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
