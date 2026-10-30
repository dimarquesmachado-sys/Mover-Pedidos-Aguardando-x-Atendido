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
const codigo = require('./_codigo-ciclo');   /* (o nome da AMB no código) */

/* 30/10 (ciclo 3): o verificador comum — linha nova só com origem conhecida (AMB, Girassol ou a lista da peça); linha
   que sai só se estiver na lista revisada (scripts/fixtures/ciclo-good-trocadas.json) */
const r = require('./_ciclo-origem').conferir(raiz, 'good', 'good-checkout-offline');
const novas = r.novas, sumiram = r.sumiram;
assert.ok(novas.length > 10, 'quase nada mudou — a comparação não está olhando o ciclo novo');
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
console.log('ok — ciclo da GOOD na peça: ' + novas.length + ' linha(s) novas, todas de origem conhecida; ' + sumiram.length + ' trocadas por equivalentes (lista revisada); o que é da GOOD continua');
