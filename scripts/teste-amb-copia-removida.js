/* 02/10 — PRIMEIRA CÓPIA REMOVIDA DA AMB, com prova.

   ⚠️ A TENTATIVA ANTERIOR QUASE QUEBROU TRÊS TELAS. Removi três cópias de uma vez confiando que
   a fábrica entregava igual; ao chamar as rotas, UMA SUMIU e DUAS passaram a responder "esta
   empresa ainda não expõe…". Desfiz. A lição virou método:

     1. passar as PEÇAS que a rota da fábrica usa;
     2. guardar a resposta ATUAL da rota própria;
     3. remover UMA cópia;
     4. comparar CAMPO A CAMPO — não o texto, que difere só na ordem das chaves;
     5. só então a próxima.

   E uma medição minha estava errada: eu contava 43 rotas na fábrica, mas `/reaplicar-status`
   só APARECE como texto numa resposta, não é tratada. São 42. Contar menção como rota é o que
   fez a rota "sumir" no primeiro teste.

   ⚠️ `estadoCancelados` é o nome da peça — eu tinha suposto `varrerCancelados` e a rota recusou.
   Ler o produtor antes de escrever o consumidor, de novo. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const amb = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');

/* a cópia saiu */
assert.ok(!/'\/amb-checkout-offline\/varrer-cancelados-status'/.test(amb),
  'a cópia de /varrer-cancelados-status voltou pra AMB — dois donos pra mesma rota');
/* Codex #587: o disparo /varrer-cancelados saiu junto com o status */
assert.ok(!/'\/amb-checkout-offline\/varrer-cancelados'/.test(amb),
  'a cópia de /varrer-cancelados voltou pra AMB — dois donos pra mesma rota');
/* Codex #587: sem o getter, situacoes_descobertas vira null */
assert.ok(/sitCancel:\s*\(\)\s*=>\s*_sitCancel/.test(amb),
  'a AMB não passa o getter sitCancel — situacoes_descobertas viraria null');

/* 02/10 — 2ª cópia removida: /varrer-fornecedores-status, pelo mesmo método (peça passada,
   resposta guardada, comparação CAMPO A CAMPO). O disparo /varrer-fornecedores FICA: ele vai ao
   Bling de verdade, e comparar as duas respostas exigiria rodar a varredura duas vezes — cota da
   conta, que em dia de galpão tira pedido da bipagem. */
assert.ok(amb.indexOf("'/amb-checkout-offline/varrer-fornecedores-status'") < 0,
  'a cópia de /varrer-fornecedores-status voltou pra AMB — dois donos pra mesma rota');

/* e a da fábrica responde: a rota existe E a peça que ela usa é passada */
assert.ok(/p === \(PREFIXO \+ '\/varrer-cancelados-status'\)/.test(fab),
  'a fábrica não trata /varrer-cancelados-status — a AMB ficaria SEM a rota');
assert.ok(fab.indexOf("p === (PREFIXO + '/varrer-fornecedores-status')") >= 0,
  'a fábrica não trata /varrer-fornecedores-status — a AMB ficaria SEM a rota');
assert.ok(/estadoCancelados/.test(amb.slice(amb.indexOf('criarRotasPainel'), amb.indexOf('criarRotasPainel') + 2600)),
  'a AMB não passa `estadoCancelados` — a rota montaria e RECUSARIA, pior que não existir');

/* ⚠️ a rota NÃO pode ficar em rotasProprias: a cópia não existe mais, e com ela declarada a
   fábrica cederia a vez pra ninguém */
{
  const m = amb.match(/rotasProprias:\s*\[([^\]]*)\]/);
  assert.ok(m, 'a AMB perdeu o rotasProprias');
  assert.ok(!/'varrer-cancelados'|'varrer-cancelados-status'/.test(m[1]),
    'a rota segue declarada como própria mas a cópia foi removida — a fábrica cede a vez e ' +
    'NINGUÉM responde');
  assert.ok(m[1].indexOf("'varrer-fornecedores-status'") < 0,
    'a rota /varrer-fornecedores-status segue declarada como própria mas a cópia foi removida ' +
    '— a fábrica cede a vez e NINGUÉM responde');

  /* Codex #588: o DISPARO fica em rotasProprias, então a cópia local PRECISA existir — senão
     a fábrica cede a vez e ninguém inicia a varredura */
  assert.ok(m[1].indexOf("'varrer-fornecedores'") >= 0, 'o disparo saiu de rotasProprias sem plano');
  assert.ok(/p === '\/amb-checkout-offline\/varrer-fornecedores'\)/.test(amb),
    'o disparo /varrer-fornecedores segue em rotasProprias mas a cópia local sumiu — ' +
    'NINGUÉM inicia a varredura');

  /* ⚠️ `/canario-marketplaces`: a PEÇA está passada, mas a CÓPIA fica neste PR. Aquela rota VAI
     AO MARKETPLACE, e comparar as duas respostas exigiria disparar a conferência duas vezes —
     cota da conta, que em dia de galpão tira pedido da bipagem. Enquanto a cópia existe, ela
     PRECISA continuar em rotasProprias. */
  assert.ok(/conferirMarketplaces/.test((function () {
    /* ⚠️ 05/10 — ESTA JANELA ERA FIXA EM 3.000 CARACTERES e quebrou por motivo errado: acrescentei
       um comentário de 10 linhas no bloco de peças e `conferirMarketplaces`, que continuava sendo
       passada, caiu PRA FORA da janela. Teste vermelho sem defeito nenhum ensina a ignorar o
       vermelho. Agora a janela vai até o FIM da chamada da fábrica, achado por contagem de
       parênteses. */
    const ini = amb.indexOf('criarRotasPainel');
    let prof = 0, i = amb.indexOf('(', ini);
    for (let k = i; k < amb.length; k++) {
      if (amb[k] === '(') prof++;
      else if (amb[k] === ')') { prof--; if (prof === 0) return amb.slice(ini, k + 1); }
    }
    return amb.slice(ini);
  })()),
    'a peça `conferirMarketplaces` deixou de ser passada — a rota da fábrica recusaria');
  assert.ok(m[1].indexOf("'canario-marketplaces'") >= 0,
    'a cópia de /canario-marketplaces ainda existe, mas saiu de rotasProprias — a fábrica ' +
    'responderia no lugar da versão da AMB');
}

/* ⚠️ e o inverso, pras que AINDA têm cópia: toda rota que a AMB tem E a fábrica trata precisa
   estar em rotasProprias, senão a fábrica responde no lugar da versão da empresa */
{
  const mlf = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-painel-ml.js'), 'utf8');
  const tratadas = new Set([...(fab + mlf).matchAll(/p === \(PREFIXO \+ '(\/[\w-]+)'\)/g)].map(x => x[1]));
  const proprias = new Set([...amb.matchAll(/'\/amb-checkout-offline(\/[\w-]+)'/g)].map(x => x[1]));
  const m = amb.match(/rotasProprias:\s*\[([^\]]*)\]/);
  const declaradas = new Set([...m[1].matchAll(/'([\w-]+)'/g)].map(x => '/' + x[1]));
  for (const r of tratadas) {
    if (!proprias.has(r)) continue;
    assert.ok(declaradas.has(r),
      'a rota ' + r + ' tem cópia na AMB e também é tratada pela fábrica, mas não está em ' +
      'rotasProprias — a fábrica responderia no lugar da versão da empresa que mais fatura');
  }
}

console.log('OK: 1a copia removida da AMB com a peca passada e a rota da fabrica provada');
