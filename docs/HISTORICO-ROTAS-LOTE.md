# Histórico — as rotas de lote escritas à mão em cada arquivo (até 17/11/2026)

Norte C, `montarCheckout(empresa)`, passo 15: as rotas de lote (`lib/checkout/rotas-lote`) passaram a ser montadas pelo contrato — `daEmpresa(empresa, { readBody, base, nf })`. Abaixo, o bloco que cada arquivo de entrada tinha (fora do `routes`, montado na 1ª chamada), tirado do código sem tocar no texto.

## girassol (`girassol-backup-offline/gbo-app.js`)

```js
/* 30/10 — as ROTAS DE LOTE do checkout (peça única lib/checkout/rotas-lote — eram só da GOOD): etiquetas em MASSA
   (o ZIP da Shopee: cada etiqueta casa com o pedido pela NF de dentro dela), a página de envio e as DANFEs em lote.
   Montada na 1ª chamada, que recebe o `readBody` do handler. Só admin. */
let _rotasLoteGir = null;
function _rotasLote(readBody) {
  if (!_rotasLoteGir) _rotasLoteGir = require('../lib/checkout/rotas-lote').criarRotasLote({
    prefixo: '/girassol-backup-offline', tag: 'GIRABKP', nome: 'Girassol', empresaAviso: 'girassol',
    CACHE_DIR, MANIFEST_FILE, ETIQ_FORMATO, json, readBody, readJson, writeJson, ensureDir, manifest,
    validarSessao, ehAdmin, baixarDanfe,
  });
  return _rotasLoteGir;
}
```

## amb (`amb-checkout-offline/index.js`)

```js
/* 30/10 — as ROTAS DE LOTE do checkout (peça única lib/checkout/rotas-lote — eram só da GOOD): etiquetas em MASSA
   (o ZIP da Shopee: cada etiqueta casa com o pedido pela NF de dentro dela), a página de envio e as DANFEs em lote.
   Montada na 1ª chamada, que recebe o `readBody` do handler. Só admin. */
let _rotasLoteAmb = null;
function _rotasLote(readBody) {
  if (!_rotasLoteAmb) _rotasLoteAmb = require('../lib/checkout/rotas-lote').criarRotasLote({
    prefixo: '/amb-checkout-offline', tag: 'AMBBKP', nome: 'AMB', empresaAviso: 'amb',
    CACHE_DIR, MANIFEST_FILE, ETIQ_FORMATO, json, readBody, readJson, writeJson, ensureDir, manifest,
    validarSessao, ehAdmin, baixarDanfe,
  });
  return _rotasLoteAmb;
}
```

## good (`good-checkout-offline/index.js`)

```js
/* 30/10: o DECODIFICADOR das etiquetas raster da Shopee virou a peça única lib/checkout/decodificar-zpl-shopee
   (usado pelas rotas de lote, lib/checkout/rotas-lote). As rotas de lote da GOOD saem da peça, montada aqui. */
/* o `readBody` chega como parâmetro do `routes` (ver abaixo) — a peça é montada na 1ª chamada, que recebe ele */
let _rotasLoteGood = null;
function _rotasLote(readBody) {
  if (!_rotasLoteGood) _rotasLoteGood = require('../lib/checkout/rotas-lote').criarRotasLote({
    prefixo: '/good-checkout-offline', tag: 'GOODBKP', nome: 'GOOD', empresaAviso: 'good',
    CACHE_DIR, MANIFEST_FILE, ETIQ_FORMATO, json, readBody, readJson, writeJson, ensureDir, manifest,
    validarSessao, ehAdmin, baixarDanfe,
  });
  return _rotasLoteGood;
}
```
