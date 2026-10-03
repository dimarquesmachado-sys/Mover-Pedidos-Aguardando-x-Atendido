/* 02/10 — A AMB PASSA A USAR A FÁBRICA DE ROTAS, sem perder nada.

   O dono: "não esqueça isto! tem que ser sempre multiloja, senão as lojas vão ficar com painéis
   diferentes."

   ⚠️ A AMB JÁ TEM 43 DAS ROTAS QUE A FÁBRICA TRAZ. Ligar sem cuidado criaria duas respostas pro
   mesmo caminho, e a da fábrica (mais nova, menos rodada) venceria em produção na empresa que
   mais fatura. Por isso TODAS as 43 entram em `rotasProprias`: a dela sempre vence.

   O que ela GANHA hoje são os scripts compartilhados do painel — as mesmas peças que a GOOD já
   usa, com o prefixo da AMB.

   ⚠️ E NADA DE APAGAR CÓPIA NESTE PR. Medi 505 linhas de rota duplicada que poderiam sair, mas
   apagar antes de provar que a da fábrica responde IGUAL é como eu quebraria a empresa que mais
   fatura. Ligar primeiro, comparar depois, remover por último. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const amb = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
const mlf = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-painel-ml.js'), 'utf8');

assert.ok(/criarRotasPainel/.test(amb), 'a AMB parou de montar a fábrica');

/* ⚠️ TODA rota que a AMB já tem E a fábrica traz PRECISA estar em rotasProprias — senão a
   fábrica responde antes e a resposta da empresa que mais fatura muda sem ninguém pedir. */
{
  const naFab = new Set([...(fab + mlf).matchAll(/PREFIXO \+ '(\/[\w-]+)'/g)].map(m => m[1]));
  const proprias = new Set([...amb.matchAll(/'\/amb-checkout-offline(\/[\w-]+)'/g)].map(m => m[1]));
  const m = amb.match(/rotasProprias:\s*\[([^\]]*)\]/);
  assert.ok(m, 'a AMB monta a fábrica SEM declarar rotasProprias — 43 rotas dela seriam ' +
    'respondidas pela fábrica em vez da própria');
  const declaradas = new Set([...m[1].matchAll(/'([\w-]+)'/g)].map(x => '/' + x[1]));
  for (const r of naFab) {
    if (!proprias.has(r)) continue;
    assert.ok(declaradas.has(r),
      'a rota ' + r + ' existe na AMB E na fábrica, mas NÃO está em rotasProprias — a fábrica ' +
      'responderia no lugar da versão da empresa que mais fatura');
  }
}

/* as peças obrigatórias: a fábrica confere no boot, e descobrir uma por rodada custa o dia */
{
  const m = fab.match(/for \(const p of \[([\s\S]*?)\]\) \{\s*\n\s*if \(cfg\.pecas\[p\] == null\)/);
  assert.ok(m, 'não achei a lista de obrigatórias da fábrica');
  const obrig = [...m[1].matchAll(/'(\w+)'/g)].map(x => x[1]);
  /* ⚠️ a janela fixa de 1.400 caracteres cortava o bloco no meio e acusava peça que ESTAVA lá —
     falso positivo, que ensina a ignorar o vermelho. Recorta até o fim do objeto `pecas`. */
  const _i = amb.indexOf('criarRotasPainel');
  const _f = amb.indexOf('});', amb.indexOf('pecas:', _i));
  const bloco = amb.slice(_i, _f > _i ? _f : _i + 2600);
  for (const n of obrig) {
    assert.ok(new RegExp('\\b' + n + '\\b').test(bloco),
      'a AMB não passa a peça obrigatória `' + n + '` — a fábrica recusaria montar e ela não ' +
      'ganharia nada');
  }
}

/* o script compartilhado tem que carregar sem a querystring da página (lição do #582) */
assert.ok(/js\/plano-compra\.js' \|\|/.test(amb),
  'o script do painel não está liberado na guarda de sessão da AMB — daria 401 e a seção sumiria');

/* falha ao montar não pode derrubar o módulo da AMB */
assert.ok(/_rotasPainelAMB = async \(\) => false;/.test(amb),
  'se a fábrica falhar ao montar, a AMB inteira cairia junto');

console.log('OK: AMB usa a fabrica e mantem TODAS as rotas proprias vencendo');
