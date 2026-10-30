'use strict';
/* 30/10 — o CICLO do checkout em peça única, passo 2: a GOOD passa a usar lib/checkout/ciclo-empresa (a peça que nasceu do
   ciclo da AMB). Nivelar por cima: a GOOD ganha o que só a AMB tinha (o diagnóstico do parameter da Shopee, o log
   detalhado da série, a unidade Full da casa / emissão própria — vazias pra GOOD), e a peça ganhou da GOOD o log verdadeiro
   quando o despacho do Full não está configurado. Prova, comparando o CÓDIGO (sem comentários):
   · toda linha nova no ciclo da GOOD vem do ciclo da AMB (com os nomes da GOOD) — nada inventado;
   · toda linha da GOOD que saiu está na lista das trocadas por equivalentes (scripts/fixtures/ciclo-good-trocadas.json) —
     nenhuma capacidade dela se perde em silêncio;
   · o que é DA GOOD continua: Madeira Madeira, a loja /good no serviço da Shopee, a chave fiscal 'good', o token e a API
     do ML dela, as variáveis GOODBKP_*, e o despacho do Full desligado sem GOODBKP_SIT_DESPACHADOS;
   · a GOOD exporta tudo o que exportava. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const F = require('./_fonte-ciclo');
const codigo = require('./_codigo-ciclo');

const R = codigo(F.ler(raiz, 'good-checkout-offline/ciclo.js'));
const G = codigo(fs.readFileSync(path.join(__dirname, 'fixtures', 'ciclo-good-antes.js'), 'utf8'));
const ambComNomesDaGood = fs.readFileSync(path.join(__dirname, 'fixtures', 'ciclo-amb-antes.js'), 'utf8')
  .split('AMBBKP').join('GOODBKP').split("'../ambtotal/").join("'../good/")
  .split("_agF3.ler('amb')").join("_agF3.ler('good')").split("_agF3.registrar('amb',").join("_agF3.registrar('good',")
  .split('/amb/interno/etiqueta').join('/good/interno/etiqueta')
  .split("require('../' + path.basename(__dirname).split('-')[0] + '-mm-etiquetas')").join("require('../good-mm-etiquetas')")
  .split("['2920348', '2920232', '2839148', '3456195']").join('[]').split("['2839148', '3456195']").join('[]');
const M = new Set(codigo(ambComNomesDaGood));
const sG = new Set(G), sR = new Set(R);
const novas = R.filter((l) => !sG.has(l));
const GUARDA = new Set(codigo(fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'ciclo-empresa.js'), 'utf8')
  .split('${LOG}').join('GOODBKP').split('${ENV}').join('GOODBKP')));   /* a guarda do despacho (veio da própria GOOD) */
const inventadas = novas.filter((l) => !M.has(l) && !(sG.has(l) || GUARDA.has(l)));
assert.deepStrictEqual(inventadas, [], 'o ciclo da GOOD ganhou linha que não vem da AMB nem dela: ' + JSON.stringify(inventadas).slice(0, 400));
assert.ok(novas.length > 10, 'quase nada mudou — a comparação não está olhando o ciclo novo');
const trocadas = new Set(require('./fixtures/ciclo-good-trocadas.json').linhas);
const sumiram = G.filter((l) => !sR.has(l));
const foraDaLista = sumiram.filter((l) => !trocadas.has(l));
assert.deepStrictEqual(foraDaLista, [], 'saiu linha da GOOD que não está na lista das trocadas por equivalentes: ' + JSON.stringify(foraDaLista).slice(0, 400));
// o que é da GOOD continua
const txt = F.ler(raiz, 'good-checkout-offline/ciclo.js');
for (const [o, por] of [["require('../good-mm-etiquetas')", 'Madeira Madeira'], ["SH_URL + '/good/interno/etiqueta", 'a loja /good na Shopee'],
  ["_agF3.registrar('good',", 'a chave fiscal'], ["require('../good/mlTokenManager')", 'o token do ML dela'], ["require('../good/mlApi')", 'a API do ML dela'],
  ['GOODBKP_SIT_DESPACHADOS não configurado', 'o log do despacho desligado'], ['process.env.GOODBKP_UN_FULL', 'as unidades Full pela env dela']]) {
  assert.ok(txt.includes(o), 'a GOOD perdeu ' + por + ' (' + o + ')');
}
assert.ok(!/AMBBKP|ambtotal|'\/amb\//.test(codigo(txt).join('\n')), 'sobrou nome da AMB no código do ciclo da GOOD');
// exporta tudo o que exportava
const mod = require(path.join(raiz, 'good-checkout-offline', 'ciclo.js'));
const exportsAntes = /module\.exports = \{([^}]*)\}/.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'ciclo-good-antes.js'), 'utf8'))[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
for (const k of exportsAntes) assert.ok(typeof mod[k] !== 'undefined', 'a GOOD não exporta mais ' + k);
console.log('ok — ciclo da GOOD na peça: ' + novas.length + ' linha(s) novas, todas da AMB; ' + sumiram.length + ' trocadas por equivalentes (lista conferida); o que é da GOOD continua');
