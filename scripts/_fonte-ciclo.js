'use strict';
/* 30/10 — o CICLO do checkout virou a peça única lib/checkout/ciclo-empresa; o ciclo.js da empresa que migrou é só a
   configuração dela. Os testes que conferem o TEXTO do ciclo de uma empresa leem por aqui: se o arquivo é o da peça,
   devolve o ciclo COMO A EMPRESA O RODA — a peça com os parâmetros dela no lugar (prefixo das variáveis e do log, chave
   fiscal, unidades Full, token e API do ML), sem a fábrica em volta. Senão, o arquivo. */
const fs = require('fs');
const path = require('path');
function _param(cfg, nome) { const m = new RegExp(nome + ":\\s*'([^']*)'").exec(cfg); return m ? m[1] : null; }
function _lista(cfg, nome) { const m = new RegExp(nome + ':\\s*(\\[[^\\]]*\\])').exec(cfg); return m ? m[1] : '[]'; }
function _req(cfg, nome) { const m = new RegExp(nome + ":\\s*\\(\\)\\s*=>\\s*require\\('([^']*)'\\)").exec(cfg); return m ? m[1] : null; }
function comoAEmpresaRoda(raiz, cfg) {
  let t = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'ciclo-empresa.js'), 'utf8');
  const ENV = _param(cfg, 'prefixoEnv'), LOG = _param(cfg, 'prefixoLog') || ENV, EMP = _param(cfg, 'empresaFiscal');
  const i = t.indexOf("  const ENV = o.prefixoEnv, LOG = o.prefixoLog || o.prefixoEnv;\n");
  const j = t.lastIndexOf('\n  return { ');
  let corpo = t.slice(i + "  const ENV = o.prefixoEnv, LOG = o.prefixoLog || o.prefixoEnv;\n".length, j);
  /* o que a empresa exporta = o que a fábrica devolve (no arquivo de antes era o module.exports) */
  const ret = t.slice(j + 1, t.indexOf('\n', j + 1)).trim().replace(/^return /, 'module.exports = ');
  corpo = corpo.split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');
  corpo = corpo.replace(/process\.env\[ENV \+ '_([A-Z0-9_]+)'\]/g, (m, n) => 'process.env.' + ENV + '_' + n)
    .split('`[${LOG}]').join('`[' + LOG + ']').split("'[' + LOG + ']").join("'[" + LOG + ']')
    .split('_agF3.ler(o.empresaFiscal)').join("_agF3.ler('" + EMP + "')").split('_agF3.registrar(o.empresaFiscal,').join("_agF3.registrar('" + EMP + "',")
    .split('const UNS_FULL_CASA = (o.unsFullCasa || []).map(String);').join('const UNS_FULL_CASA = ' + _lista(cfg, 'unsFullCasa') + ';')
    .split('const UNS_EMISSAO_PROPRIA_CASA = (o.unsEmissaoPropriaCasa || []).map(String);').join('const UNS_EMISSAO_PROPRIA_CASA = ' + _lista(cfg, 'unsEmissaoPropriaCasa') + ';')
    .split('o.mlTokenManager()').join("require('" + (_req(cfg, 'mlTokenManager') || '') + "')")
    .split('o.mlApi()').join("require('" + (_req(cfg, 'mlApi') || '') + "')")
    .split('const fetch = o.fetch || require(\'node-fetch\');').join("const fetch = require('node-fetch');")
    .split('const base  = o.base;').join("const base  = require('./base');");
  const MOD = ['base', 'nf', 'etiquetas', 'comum', 'produtos', 'arquivo', 'separacao'];
  for (const m of MOD) corpo = corpo.split('o.' + m + ')').join("require('./" + m + "'))").split('= o.' + m + ';').join("= require('./" + m + "');");
  /* os requires da LIB voltam pro caminho de quem está na pasta da empresa; os módulos da empresa ficam em './' */
  corpo = corpo.replace(/require\('\.\/([a-z0-9-]+)'\)/g, (m0, n) => (MOD.includes(n) ? m0 : "require('../lib/checkout/" + n + "')"))
    .split("require('../fiscal/").join("require('../lib/fiscal/");
  /* o módulo do Madeira: a empresa que não entrega cai no require pelo prefixo da pasta (que não existe → null), como era */
  if (!/mmEtiquetas:/.test(cfg)) corpo = corpo.split('(o.mmEtiquetas ? o.mmEtiquetas() : null)').join("require('../' + path.basename(__dirname).split('-')[0] + '-mm-etiquetas')");
  return corpo + '\n' + ret + '\n';
}
function ler(raiz, rel) {
  const arq = path.join(raiz, rel);
  const s = fs.readFileSync(arq, 'utf8');
  if (/ciclo\.js$/.test(rel) && s.includes("require('../lib/checkout/ciclo-empresa').criarCiclo(")) return comoAEmpresaRoda(raiz, s);
  return s;
}
module.exports = { ler, comoAEmpresaRoda };
