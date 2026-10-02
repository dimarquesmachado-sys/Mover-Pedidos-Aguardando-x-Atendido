/* 02/10 — PLANO DE COMPRA COMO PEÇA COMPARTILHADA, não cópia entre painéis.

   O dono: "segue criando os cards todos e acessos, botões todos multiloja e que funcione pra
   GOOD" — com o alvo de sempre: "pra amanhã qdo ligar outra, fique mais fácil".

   ⚠️ TENTEI COLAR O BLOCO DA AMB NO PAINEL DA GOOD E FALHEI TRÊS VEZES, cada uma por um motivo
   diferente que só os testes pegaram:
     1. `onclick="baixarPlano()"` sem a função  → o teste `onclick-existe` acusou;
     2. a função caiu num SEGUNDO bloco <script> → o teste procura no mesmo bloco do onclick;
     3. `renderPlano` usa `_planoFiltrado`/`PLANO`/`_planoCarregando`, que ficaram pra trás →
        variável fantasma, e TRÊS testes da GOOD vermelhos de uma vez.
   Cada remendo abria o furo seguinte: o bloco arrasta HTML, estado e funções que se chamam
   entre si. Desfiz tudo e fiz a peça.

   Pela peça, o painel da GOOD cresceu 6 linhas em vez de 200 — e o `verifica` passou de
   primeira, porque nada do que era dela foi tocado. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { scriptDoPlano } = require(path.join(raiz, 'lib', 'checkout', 'painel-plano-compra'));

/* ⚠️ O QUE A TELA RECEBE TEM QUE COMPILAR. Script quebrado não dá erro visível: a seção
   simplesmente não aparece, e pareceria "a GOOD não tem Plano de Compra". */
for (const base of ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline']) {
  const s = scriptDoPlano(base);
  assert.doesNotThrow(() => new Function(s),
    'o script gerado para ' + base + ' NÃO compila — a seção sumiria sem erro na tela');
  assert.ok(s.includes(base),
    'o script de ' + base + ' não leva o prefixo da empresa — chamaria a rota de outra');
  for (const outra of ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline']) {
    if (outra === base) continue;
    assert.ok(!s.includes(outra),
      'o script de ' + base + ' contém o prefixo de ' + outra + ' — misturaria dados de duas empresas');
  }
  assert.ok(/window\.carregarPlano/.test(s) && /window\.baixarPlano/.test(s),
    'as funções não ficam acessíveis pro onclick do HTML em ' + base);
  assert.ok(/getElementById\("planoCompraAqui"\)/.test(s),
    'o script não procura o espaço da seção — empresa sem o espaço quebraria em vez de ignorar');
}

/* a fábrica serve o script */
{
  const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  assert.ok(/'\/js\/plano-compra\.js'/.test(fab), 'a fábrica parou de servir o script');
  assert.ok(/application\/javascript/.test(fab), 'serve com o tipo errado — o navegador recusaria');
  /* ⚠️ falha ao gerar não pode derrubar o painel: devolve comentário e a tela segue */
  assert.ok(/plano-compra indisponível/.test(fab),
    'erro ao gerar o script passou a estourar — derrubaria a tela inteira por causa de uma seção');
}

/* o painel da GOOD abre espaço e inclui */
{
  const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
  assert.ok(/id="planoCompraAqui"/.test(tela), 'sumiu o espaço da seção no painel da GOOD');
  assert.ok(/js\/plano-compra\.js/.test(tela), 'o painel da GOOD não inclui mais o script');
  /* e o que é DELA continua lá — foi isso que a cópia apagava */
  assert.ok(/pintarQuebras/.test(tela), 'sumiram as seções Por Canal / Top / Por Dia');
  assert.ok(!/amb-checkout-offline/.test(tela), 'entrou prefixo da AMB no painel da GOOD');
}

console.log('OK: plano de compra e peca compartilhada, com a empresa como parametro');
