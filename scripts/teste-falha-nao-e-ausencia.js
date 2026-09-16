'use strict';
/* 16/09 — TRÊS ACHADOS QUE SÃO O MESMO ERRO, trazidos do repo de Devoluções:
     · lá, a busca por nome da AMB ficou cega o dia todo porque um 401 PASSAGEIRO do Bling
       matou o índice na primeira página — e o token estava bom;
     · lá, erro de API virou "esta empresa não usa o recurso", e a mensagem chegou a sugerir
       desligar o Shopee Full de quem tem 330 notas;
     · lá, "não encontrado" e "não consigo enxergar" chegavam iguais na tela, e o dono
       concluiu que um pedido não existia quando ele estava no Bling.

   Os três são a mesma confusão: FALHA lida como AUSÊNCIA. E o estrago é sempre pior que o
   erro original, porque a resposta parece normal — ninguém desconfia de "não encontrado".

   Este teste trava os pontos equivalentes AQUI. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* 1. a indexação do catálogo: lista vazia só significa "acabou" se a resposta veio OK */
for (const arq of ['amb-checkout-offline/ciclo.js', 'girassol-backup-offline/ciclo.js', 'good-checkout-offline/ciclo.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const bloco = /async function indexarCatalogoCompleto[\s\S]*?\n\}/.exec(s);
  assert.ok(bloco, arq + ': não achei a indexação');
  const b = bloco[0];

  assert.ok(!/const itens = \(r\.ok && r\.data/.test(b),
    arq + ': `r.ok` de volta dentro da lista — resposta com falha viraria "acabou o catálogo"');
  assert.ok(/if \(!r\.ok\)/.test(b), arq + ': falta tratar a resposta que não veio OK');
  assert.ok(/401/.test(b), arq + ': 401 tem que ser tratado como PASSAGEIRO — foi ele que cegou a busca no outro repo');
  for (const st of ['429', '500', '503']) {
    assert.ok(new RegExp(st).test(b), arq + ': ' + st + ' também é passageiro');
  }
  assert.ok(/continue;/.test(b), arq + ': tem que tentar a MESMA página de novo, não pular');
  assert.ok(/abortou/.test(s), arq + ': falta a marca de abortado');
  assert.ok(/if \(!idxStatus\.abortou\) writeJson/.test(s),
    arq + ': o salvamento final grava mesmo após erro — o índice PARCIAL apagaria o bom, e índice velho serve, parcial cega');
}

/* 2. a rota que grava localização: Bling fora do ar não é produto inexistente */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-separacao.js'), 'utf8');
  assert.ok(/if \(!busca\.ok\)/.test(s), 'falta separar "não consegui consultar" de "não existe"');
  assert.ok(/NÃO quer dizer que o SKU/.test(s),
    'a mensagem de falha tem que dizer explicitamente que NÃO é ausência — foi assim que o dono concluiu que um pedido não existia');
  assert.ok(/o Bling respondeu, e não há produto/.test(s),
    'e a mensagem de ausência tem que deixar claro que o Bling RESPONDEU');
}

console.log('OK: falha ≠ ausência — índice não morre em 401 passageiro, não grava parcial, e "não existe" não se confunde com "não consegui ver"');
