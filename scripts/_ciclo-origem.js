'use strict';
/* 30/10 — o verificador comum dos testes do CICLO em peça única. Compara o CÓDIGO (sem comentários) do ciclo como a empresa
   o roda (scripts/_fonte-ciclo.js) com o ciclo.js de ANTES dela (fixture):
   · toda linha NOVA tem que vir de uma ORIGEM conhecida — o ciclo de antes de outra empresa (com os nomes desta) ou a
     própria peça (as poucas linhas que só existem nela) — nada inventado;
   · toda linha que SAIU tem que estar na lista REVISADA das trocadas por equivalentes (scripts/fixtures/ciclo-<empresa>-
     trocadas.json) — nenhuma capacidade some em silêncio.
   Devolve { novas, sumiram }; lança com a 1ª linha fora da regra. */
const fs = require('fs');
const path = require('path');
const codigo = require('./_codigo-ciclo');
const F = require('./_fonte-ciclo');
const FIX = path.join(__dirname, 'fixtures');
/* o ciclo de antes de uma empresa, com os NOMES de outra (prefixo, ML, chave fiscal, loja da Shopee, Madeira, unidades) */
const NOMES = {
  amb: { env: 'AMBBKP', ml: '../ambtotal/', emp: 'amb', mm: "require('../' + path.basename(__dirname).split('-')[0] + '-mm-etiquetas')" },
  good: { env: 'GOODBKP', ml: '../good/', emp: 'good', mm: "require('../good-mm-etiquetas')" },
  girassol: { env: 'GIRABKP', ml: '../girassol/', emp: 'girassol', mm: "require('../girassol-mm-etiquetas')" },
};
function comNomesDe(texto, de, para) {
  const a = NOMES[de], b = NOMES[para];
  let t = texto.split(a.env).join(b.env).split("'" + a.ml).join("'" + b.ml)
    .split("_agF3.ler('" + a.emp + "')").join("_agF3.ler('" + b.emp + "')").split("_agF3.registrar('" + a.emp + "',").join("_agF3.registrar('" + b.emp + "',")
    .split('/' + a.emp + '/interno/etiqueta').join('/' + b.emp + '/interno/etiqueta').split(a.mm).join(b.mm);
  if (para !== 'amb') t = t.split("['2920348', '2920232', '2839148', '3456195']").join('[]').split("['2839148', '3456195']").join('[]');
  return t;
}
function conferir(raiz, empresa, pasta) {
  const R = codigo(F.ler(raiz, pasta + '/ciclo.js'));
  const A = codigo(fs.readFileSync(path.join(FIX, 'ciclo-' + empresa + '-antes.js'), 'utf8'));
  const origem = new Set();
  for (const outra of Object.keys(NOMES)) if (outra !== empresa) {
    for (const l of codigo(comNomesDe(fs.readFileSync(path.join(FIX, 'ciclo-' + outra + '-antes.js'), 'utf8'), outra, empresa))) origem.add(l);
  }
  /* a peça renderizada pra empresa entra como origem só pelas linhas que NÃO existiam em ciclo nenhum (as poucas escritas
     nos passos da peça: a guarda do despacho, a opção do Full, a loja da Shopee) — conferidas na revisão de cada passo */
  for (const l of R) if (!origem.has(l)) origem.add('?' + l);
  const sA = new Set(A), sR = new Set(R);
  const novas = R.filter((l) => !sA.has(l));
  const daPeca = novas.filter((l) => origem.has('?' + l) && !origem.has(l));
  const permitidasDaPeca = new Set(require(path.join(FIX, 'ciclo-linhas-da-peca.json')).linhas.map((l) => l.split('<ENV>').join(NOMES[empresa].env)));
  const inventadas = daPeca.filter((l) => !permitidasDaPeca.has(l));
  if (inventadas.length) throw new Error(empresa + ': linha nova que não vem de ciclo nenhum nem da lista da peça: ' + JSON.stringify(inventadas.slice(0, 3)).slice(0, 400));
  const trocadas = new Set(require(path.join(FIX, 'ciclo-' + empresa + '-trocadas.json')).linhas);
  const sumiram = A.filter((l) => !sR.has(l));
  const fora = sumiram.filter((l) => !trocadas.has(l));
  if (fora.length) throw new Error(empresa + ': saiu linha que não está na lista das trocadas: ' + JSON.stringify(fora.slice(0, 3)).slice(0, 400));
  return { novas, sumiram, daPeca };
}
module.exports = { conferir, comNomesDe };
