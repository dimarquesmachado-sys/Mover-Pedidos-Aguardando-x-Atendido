/* 04/10 — FALHAR UMA PÁGINA DA LISTA TRAVAVA A TELA DA GOOD.

   Na "Análise de Vendas", quando `/historico-linhas` falhava, o aviso substituía a tabela
   INTEIRA — e com ela os botões "Anterior/Próxima". O usuário ficava sem jeito de tentar de novo
   nem de voltar: só F5. Pior, `PAGINA` já tinha avançado no clique, então o estado apontava pra
   uma página que nunca carregou.

   ⚠️ A AMB E A GIRASSOL JÁ TRATAM ISSO (`_hlUltima`, `repetirHist`) — o comentário lá descreve
   exatamente este defeito, vivido no PR #132. A GOOD era a única que ficava presa: o conserto
   existia no repositório e não tinha sido aplicado aqui.

   Verificação de TELA, no texto da página: o painel da GOOD é HTML com script embutido, sem
   módulo pra importar. Por isso o teste confere a presença das peças que impedem o travamento,
   e a bateria de `onclick-existe` garante que as funções chamadas existem.

   Marcador estável [PAG-TRAVA]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');

/* ── o aviso de falha precisa oferecer SAÍDA ──────────────────────────────────────── */
{
  const i = tela.indexOf('Não consegui carregar a lista agora');
  assert.ok(i > 0, '[PAG-TRAVA] sumiu o aviso de falha da lista');
  const bloco = tela.slice(i, i + 900);

  assert.ok(/tentar a página/.test(bloco),
    '[PAG-TRAVA] a falha da página não oferece TENTAR DE NOVO — o aviso substitui a tabela e ' +
    'leva os botões junto, deixando a tela presa até um F5');

  assert.ok(/irPagina\(/.test(bloco),
    '[PAG-TRAVA] o aviso de falha não tem botão que chame irPagina — sem saída da tela');
}

/* ⚠️ ── e a página vigente só pode avançar no SUCESSO ─────────────────────────────── */
{
  assert.ok(/_ultimaPaginaOk/.test(tela),
    '[PAG-TRAVA] não há registro da última página que REALMENTE carregou — sem isso, uma falha ' +
    'deixa o estado apontando pra uma página que não está na tela');

  const iOk = tela.indexOf('_ultimaPaginaOk = d.pagina');
  assert.ok(iOk > 0,
    '[PAG-TRAVA] a página vigente não é atualizada no sucesso — a lista pode ficar travada numa ' +
    'página só, com "Próxima" pedindo sempre a mesma');
  assert.ok(tela.indexOf('PAGINA = paginaVigente') > 0,
    '[PAG-TRAVA] a falha não devolve a página vigente pro último valor bom');
  assert.ok(tela.indexOf('_ultimaJanelaOk === chaveJanela') > 0 && tela.indexOf('_ultimaJanelaOk = chaveJanela') > 0,
    '[PAG-TRAVA] a página boa não é amarrada ao intervalo — trocar de período e falhar a página 1 ' +
    'restauraria o número de página de OUTRO período');
}

/* ⚠️ ── TROCAR DE PERÍODO zera a página de retorno (Codex #621) ──────────────────────
   `_ultimaPaginaOk` é global. Ver a página 4 do "Mês", trocar pra "Hoje" e falhar na página 1
   fazia a tela "voltar" pra página 4 — número de OUTRO intervalo de datas, que em "Hoje" nem
   existe. Todo lugar que zera `PAGINA` tem que zerar as duas. */
{
  /* ⚠️ só as REATRIBUIÇÕES interessam: a linha da DECLARAÇÃO (`let … PAGINA = 1;`) já nasce
     coerente, porque `_ultimaPaginaOk` é declarada logo abaixo também com 1. Minha primeira
     versão não distinguia as duas e acusava a própria declaração. */
  const zeram = [...tela.matchAll(/PAGINA\s*=\s*1\s*;/g)]
    .map((m) => m.index)
    .filter((i) => {
      const ini = tela.lastIndexOf('\n', i) + 1;
      return !/^\s*(let|const|var)\s/.test(tela.slice(ini, i));
    });
  assert.ok(zeram.length >= 2,
    '[PAG-TRAVA] não achei os caminhos que zeram a página (troca de período e recarregar)');
  for (const i of zeram) {
    const linha = tela.slice(i, tela.indexOf('\n', i));
    assert.ok(/_ultimaPaginaOk\s*=\s*1/.test(linha),
      '[PAG-TRAVA] este caminho zera PAGINA mas NÃO a página de retorno → ' + linha.trim().slice(0, 90) +
      '. A tela voltaria pra uma página de outro intervalo de datas.');
  }
}

/* ⚠️ ── a declaração precisa vir ANTES do primeiro uso (zona morta do `let`) ───────────
   Eu tinha posto o `let` 38 linhas DEPOIS do primeiro uso: a primeira falha de página explodiria
   com "Cannot access before initialization" em vez de mostrar o aviso — e `node --check` NÃO
   pega isso, porque é erro de execução, não de sintaxe. */
{
  const iDecl = tela.indexOf('let _ultimaPaginaOk');
  assert.ok(iDecl > 0, '[PAG-TRAVA] sumiu a declaração de _ultimaPaginaOk');
  const usos = [...tela.matchAll(/_ultimaPaginaOk/g)].map((m) => m.index)
    .filter((i) => i !== iDecl + 4 && i !== iDecl);
  const primeiroCodigo = usos.filter((i) => {
    const antes = tela.slice(Math.max(0, i - 400), i);
    return !/\/\*(?:(?!\*\/)[\s\S])*$/.test(antes);     /* ignora menção dentro de comentário */
  });
  if (primeiroCodigo.length) {
    assert.ok(iDecl < Math.min(...primeiroCodigo),
      '[PAG-TRAVA] `_ultimaPaginaOk` é USADA antes de ser declarada (linha da declaração: ' +
      (tela.slice(0, iDecl).split('\n').length) + ', primeiro uso: ' +
      (tela.slice(0, Math.min(...primeiroCodigo)).split('\n').length) + '). `let` tem zona morta ' +
      'temporal: a primeira falha de página explodiria com "Cannot access before initialization" ' +
      'em vez de mostrar o aviso — e `node --check` não pega, porque é erro de execução.');
  }
}

/* ── as outras duas empresas continuam com o tratamento delas ─────────────────────── */
for (const [emp, arq, marca] of [
  ['AMB', 'amb-checkout-offline/amb-dashboard.html', '_hlUltima'],
  ['Girassol', 'girassol-backup-offline/dashboard.html', '_hlUltima'],
]) {
  const t = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(t.includes(marca),
    '[PAG-TRAVA] ' + emp + ' perdeu o registro da consulta tentada (' + marca + ') — era o que ' +
    'permitia repetir a página que falhou');
  assert.ok(/repetirHist/.test(t),
    '[PAG-TRAVA] ' + emp + ' perdeu o botão de repetir a consulta que falhou');
}

console.log('OK: falha de pagina nao trava a tela em nenhuma das tres empresas');
