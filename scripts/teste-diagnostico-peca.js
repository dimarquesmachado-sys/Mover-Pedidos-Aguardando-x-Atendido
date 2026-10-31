'use strict';
/* 31/10 — o DIAGNÓSTICO do checkout (rotas de raio-X, sonda e manutenção) virou PEÇA ÚNICA (lib/checkout/diagnostico-empresa),
   passo 1: nasce do diagnostico.js da Girassol (o único que tinha o módulo inteiro) e a Girassol usa. Prova:
   · o código da peça COMO A GIRASSOL O RODA (prefixo, empresa, token do ML, módulos dela no lugar) é, linha por linha, o
     diagnostico.js de antes (fixture) — só mudou de onde vêm as peças;
   · o contrato não muda: o arquivo da Girassol exporta rotasDiagnostico(ctx) e o handler trata as rotas DELA e passa
     adiante as que não são;
   · peça sem a configuração da empresa recusa. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const codigo = require('./_codigo-ciclo');
const peca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'diagnostico-empresa.js'), 'utf8');
const i = peca.indexOf("  const PREFIXO = o.prefixo, EMPRESA = o.empresa;\n"), j = peca.lastIndexOf('\n  return { rotasDiagnostico };');
const desesc = (t) => t.split('\\"').join('"');
let comoGir = desesc(peca.slice(i + "  const PREFIXO = o.prefixo, EMPRESA = o.empresa;\n".length, j))
  .split("fetch(\"' + PREFIXO + '/restaurar\"").join('fetch("/girassol-backup-offline/restaurar"')
  .split("PREFIXO + '/").join("'/girassol-backup-offline/")
  .split("empresa=eq.' + EMPRESA + '&").join('empresa=eq.girassol&').split('supaCfg(EMPRESA)').join("supaCfg('girassol')")
  .split('o.mlTokenManager()').join("require('../girassol/mlTokenManager')").split("require('../http/").join("require('../lib/http/")
  .split('const base = o.base;').join("const base = require('./base');")
  /* 31/10 (diag 3): a peça ganhou da AMB/GOOD os resgates parados no backup e na restauração (vale pras três) — pra
     comparar com a Girassol de antes, tira essas duas linhas e o nome no base */
  .split(' , RESGATES_FILE } = base;').join(' } = base;')
  .replace(/^[ \t]*resgates_parados: readJson\(RESGATES_FILE, \{\}\),\n/m, '')
  .replace(/^[ \t]*if \(body\.resgates_parados && typeof body\.resgates_parados === 'object'\) \{[^\n]*\n/m, '')
  /* Codex #779: o raio-X do /debug-ml só trata quando vem o ?id= (sem id segue pra listagem), e a listagem usa a loja do ML
     da EMPRESA — pra comparar com a Girassol de antes, desfaz as duas mudanças de propósito */
  .replace(/^([ \t]*)if \(q0\) \{\n/m, "$1if (!q0) { json(res, 200, { ok: false, erro: 'passe ?id=NUMERO' }); return true; }\n")
  .replace(/^[ \t]*\}[ \t]*\/\* fim do raio-X por \?id= \(sem id, segue pra listagem\) \*\/\n/m, '')
  .replace(/^[ \t]*const _lojaML = Object\.keys\(base\.LOJA_MKT \|\| \{\}\)\.find\([^\n]*\n/m, '')
  .replace(/^[ \t]*if \(!_lojaML\) \{ json\(res, 200, \{ ok: false, erro: 'a empresa não tem loja do ML[^\n]*\n/m, '')
  .split("const { data } = await blingGet('/pedidos/vendas?idLoja=' + encodeURIComponent(_lojaML) + '&limite=20&pagina=1');").join('const { data } = await blingGet(`/pedidos/vendas?idLoja=203146903&limite=20&pagina=1`);')
  /* 31/10 (passo 2): o token do Mercado Pago passou a ser o da empresa — pra Girassol, o mesmo de antes (o comentário da
     troca sai na comparação, que olha só o código) */
  .replace(/^[ \t]*const _mpVar = 'MP_ACCESS_TOKEN_' \+ String\(EMPRESA\)\.toUpperCase\(\);\n/m, '')
  .split('const mpTok = process.env[_mpVar];').join('const mpTok = process.env.MP_ACCESS_TOKEN_GIRASSOL;')
  .split("out.erro = 'falta ' + _mpVar + ' no env do Render';").join("out.erro = 'falta MP_ACCESS_TOKEN_GIRASSOL no env do Render';");
for (const [m, v] of [['./nf', 'o.nf'], ['./comum', 'o.comum'], ['./produtos', 'o.produtos'], ['./ciclo', 'o.ciclo'], ['./danfe-simplificado', 'o.danfeSimplificado']]) comoGir = comoGir.split(v).join("require('" + m + "')");
const antes = desesc(fs.readFileSync(path.join(__dirname, 'fixtures', 'diagnostico-girassol-antes.js.txt'), 'utf8'));
const A = codigo(antes).filter((l) => l !== "'use strict';" && !/^module\.exports = \{ rotasDiagnostico \};$/.test(l));
const R = codigo(comoGir);
if (JSON.stringify(A) !== JSON.stringify(R)) { const k = A.findIndex((l, n) => l !== R[n]); assert.fail('o diagnóstico como a Girassol roda NÃO é o de antes — linha ' + k + ':\n  antes: ' + String(A[k]).slice(0, 160) + '\n  agora: ' + String(R[k]).slice(0, 160)); }
assert.ok(A.length > 600, 'a fixture veio curta');
assert.ok(!codigo(peca).some((l) => /girassol/.test(l)), 'sobrou nome da Girassol no código da peça');
(async () => {
  const mod = require(path.join(raiz, 'girassol-backup-offline', 'diagnostico.js'));
  assert.strictEqual(typeof mod.rotasDiagnostico, 'function', 'a Girassol não exporta mais rotasDiagnostico');
  const h = mod.rotasDiagnostico({ VERSAO: 'x', validarSessao: () => null, supaCfg: () => ({}), readBody: async () => ({}) });
  assert.strictEqual(typeof h, 'function', 'rotasDiagnostico não devolve o handler');
  let erro = null; try { require('../lib/checkout/diagnostico-empresa').criarDiagnostico({ prefixo: '/x' }); } catch (e) { erro = e.message; }
  assert.ok(erro && /falta peça da empresa/.test(erro), 'peça sem a configuração tinha que recusar');
  console.log('ok — diagnóstico em peça única (passo 1, Girassol): o código como ela roda é, linha por linha, o de antes; mesmo contrato');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
