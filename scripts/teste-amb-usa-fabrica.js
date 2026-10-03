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

/* ⚠️ 02/10 — A MONTAGEM PRECISA FICAR NO FIM DO HANDLER. Ela estava no começo, e passar peças
   declaradas mais abaixo NA MESMA FUNÇÃO derrubou duas rotas da AMB com "Cannot access 'FOTO_V'
   before initialization". `node --check` não pega — só a chamada real. */
{
  const iMonta = amb.indexOf('criarRotasPainel');
  const iUltimaRota = amb.lastIndexOf("'/amb-checkout-offline/");
  assert.ok(iMonta > iUltimaRota,
    'a montagem da fábrica voltou pra ANTES das rotas da AMB — peças declaradas depois ficam ' +
    'em zona morta e derrubam rotas da empresa que mais fatura');
}

/* ⚠️ e peça NÃO pode ir como getter: a fábrica usa a maioria como VALOR (FOTO_V, _mlb) e chama
   outras direto (supaReq(url)) — getter devolveria a função em vez do resultado */
{
  const bloco = amb.slice(amb.indexOf('pecas: {'), amb.indexOf('});', amb.indexOf('pecas: {')));
  for (const n of ['FOTO_V', '_mlb', 'supaReq', 'supaCfg']) {
    assert.ok(!new RegExp(n + '\\s*:\\s*\\(\\)\\s*=>').test(bloco),
      'a peça `' + n + '` está indo como getter — a fábrica a usa como valor ou a chama direto, ' +
      'e receberia a função em vez do dado');
  }
}

/* ⚠️ 02/10 — O TESTE DE ESCOPO AGORA É DE VERDADE: MONTA E CHAMA.

   Duas versões anteriores falharam como teste:
     · a 1a NUNCA FALHAVA — eu comparava `!dentroDeBloco || m.index < iMonta`, e os dois lados
       eram sempre verdadeiros. Um teste que só dizia "sim", e eu confiei nele;
     · a 2a contava CHAVES pra medir profundidade, e acusou `FOTO_V`, que funciona — chave dentro
       de texto e comentário conta igual. Falso positivo ensina a ignorar o vermelho.

   O que realmente pega o erro é montar a fábrica e chamar uma rota que SÓ ela serve. Se alguma
   peça não existir naquele ponto (foi o caso de `responderCusto`, declarada dentro do bloco de
   uma rota), a montagem falha e a chamada não responde. */
module.exports = (async () => {
  process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-escopo';
  const mod = require(path.join(raiz, 'amb-checkout-offline', 'index.js'));
  const h = mod.routes(async () => ({}));
  const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
  const u = new URL('http://x/amb-checkout-offline/js/plano-compra.js');
  const tratou = await h({ method: 'GET', url: u.pathname, headers: {} }, res, u);

  assert.ok(tratou === true && res._s === 200,
    'a fábrica NÃO montou na AMB — alguma peça passada não existe no ponto da montagem ' +
    '(foi o caso de `responderCusto`, declarada dentro do bloco de uma rota). Quando isso ' +
    'acontece, rotas da empresa que mais fatura param de responder.');
  assert.doesNotThrow(() => new Function(res._b), 'o script servido pela fábrica não compila');

  console.log('OK: AMB usa a fabrica, monta no fim e so passa peca que existe ali');
})();
