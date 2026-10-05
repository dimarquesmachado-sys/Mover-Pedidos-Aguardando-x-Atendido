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
  const iFalha = tela.indexOf('PAGINA = _ultimaPaginaOk');
  assert.ok(iOk > 0,
    '[PAG-TRAVA] a página vigente não é atualizada no sucesso — a lista pode ficar travada numa ' +
    'página só, com "Próxima" pedindo sempre a mesma');
  assert.ok(iFalha > 0,
    '[PAG-TRAVA] a falha não devolve a página vigente pro último valor bom');
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
