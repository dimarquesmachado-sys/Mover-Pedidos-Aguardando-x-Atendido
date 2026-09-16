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
  assert.ok(/o Bling respondeu uma lista vazia/.test(s),
    'a mensagem de ausência tem que deixar claro que o Bling RESPONDEU e a lista veio vazia');
}

/* Codex #484 — os três apontamentos são o MESMO erro um passo mais fundo, e o segundo
   mostrou que meu conserto não protegia nada. */
for (const arq of ['amb-checkout-offline/ciclo.js', 'girassol-backup-offline/ciclo.js', 'good-checkout-offline/ciclo.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const b2 = /async function indexarCatalogoCompleto[\s\S]*?\n\}/.exec(s)[0];

  /* (2) o pior: eu guardei o salvamento FINAL e esqueci do que publica a cada página — o
     parcial já estava em disco muito antes do aborto. Só pode haver UMA publicação. */
  /* olhar só DENTRO do laço: a publicação final (guardada por `abortou`) é legítima e está
     fora dele — minha medição anterior pegava as duas e acusava a certa. */
  const laco = /while \(pagina <= 500\) \{[\s\S]*?\n    \}/.exec(b2);
  assert.ok(laco, arq + ': não achei o laço de páginas');
  const gravaNoLaco = (laco[0].match(/writeJson\(EAN_INDEX_FILE/g) || []).length;
  assert.strictEqual(gravaNoLaco, 0, arq + ': a indexação não pode publicar o índice DENTRO do laço — o parcial chegaria ao disco antes do aborto');
  assert.ok(/if \(!idxStatus\.abortou\) writeJson\(EAN_INDEX_FILE/.test(s),
    arq + ': a publicação tem que ser única, no fim, e só se completou');

  /* (1) retry que deu certo não pode deixar erro grudado: os painéis mostram st.erro junto
     do "índice pronto", e alarme falso recorrente ensina a ignorar o alarme */
  assert.ok(!/idxStatus\.erro = 'HTTP/.test(b2),
    arq + ': tropeço de tentativa não pode ir pro campo de erro — a indexação que se recuperou apareceria como falha');
  assert.ok(/ultimo_tropeco/.test(b2), arq + ': o tropeço tem que ficar num campo separado');
}

/* (3) resposta que chegou mas não foi ENTENDIDA também não é ausência */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-separacao.js'), 'utf8');
  assert.ok(/!Array\.isArray\(busca\.data\.data\)/.test(s),
    '2xx com corpo ilegível deixa data null e viraria "SKU não existe" com autoridade de quem leu a resposta');
  assert.ok(/não consegui ler/.test(s), 'e a mensagem tem que dizer que não conseguiu LER');
}

console.log('OK: falha ≠ ausência — índice não morre em 401 passageiro, não grava parcial, e "não existe" não se confunde com "não consegui ver"');
