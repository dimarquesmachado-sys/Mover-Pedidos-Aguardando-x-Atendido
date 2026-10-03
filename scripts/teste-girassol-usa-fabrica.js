/* 02/10 — A GIRASSOL PASSA A USAR A FÁBRICA, pelo caminho já provado na AMB hoje.

   O dono: "tem que ser sempre multiloja, senão as lojas vão ficar com painéis diferentes."

   ⚠️ A GIRASSOL É A EMPRESA QUE MAIS FATURA. Todas as 33 rotas que ela já tem E a fábrica trata
   entram em `rotasProprias`: a dela vence. Ligar sem isso trocaria a resposta dela pela versão
   da fábrica, que é menos rodada.

   ⚠️ MONTAGEM NO FIM DO HANDLER. Na AMB ela ficava no começo e peças declaradas mais abaixo na
   mesma função ficavam em zona morta ("Cannot access 'FOTO_V' before initialization"), derrubando
   duas rotas. Aqui nasce no lugar certo.

   ⚠️ E A LIÇÃO QUE EU ERREI DUAS VEZES HOJE: o que impede uma peça de alcançar a montagem é ela
   ser ANINHADA (dentro de função ou bloco), não a posição no arquivo. `travaPesada` e
   `custoSyncTravado` são declaradas ~1.800 linhas DEPOIS e funcionam, porque estão no nível do
   módulo. `responderCusto` e `garantirTokenML`, na AMB, aparecem ANTES e não funcionam, porque
   estão dentro de função. Por isso este teste MONTA E CHAMA em vez de medir texto. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const gira = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
const mlf = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-painel-ml.js'), 'utf8');

assert.ok(/criarRotasPainel/.test(gira), 'a Girassol parou de montar a fábrica');

/* toda rota que a Girassol tem E a fábrica trata precisa estar em rotasProprias */
{
  const tratadas = new Set([...(fab + mlf).matchAll(/p === \(PREFIXO \+ '(\/[\w-]+)'\)/g)].map((m) => m[1]));
  const proprias = new Set([...gira.matchAll(/'\/girassol-backup-offline(\/[\w-]+)'/g)].map((m) => m[1]));
  const m = gira.match(/rotasProprias:\s*\[([^\]]*)\]/);
  assert.ok(m, 'a Girassol monta a fábrica SEM declarar rotasProprias');
  const declaradas = new Set([...m[1].matchAll(/'([\w-]+)'/g)].map((x) => '/' + x[1]));
  for (const r of tratadas) {
    if (!proprias.has(r)) continue;
    assert.ok(declaradas.has(r),
      'a rota ' + r + ' existe na Girassol E na fábrica, mas NÃO está em rotasProprias — a ' +
      'fábrica responderia no lugar da versão da empresa que MAIS FATURA');
  }
}

/* a montagem fica DEPOIS das rotas próprias: a dela vence por posição, não só pela lista */
assert.ok(gira.indexOf('criarRotasPainel') > gira.lastIndexOf("'/girassol-backup-offline/"),
  'a montagem voltou pra antes das rotas da Girassol');

/* falha ao montar não derruba o módulo */
assert.ok(/_rotasPainelGira = async \(\) => false;/.test(gira),
  'se a fábrica falhar ao montar, a Girassol inteira cairia junto');

/* os scripts são interface: precisam carregar sem a querystring da página (lição do #582) */
for (const s of ['plano-compra', 'ferramentas-custo']) {
  assert.ok(gira.indexOf("/girassol-backup-offline/js/" + s + ".js' ||") >= 0,
    'o script ' + s + ' não está liberado na guarda de sessão — daria 401 e a seção sumiria');
}

/* ⚠️ O TESTE QUE VALE: MONTA E CHAMA. Medir texto não pega peça fora de escopo — foi assim que
   eu escrevi, no #590, um teste que nunca falhava. */
module.exports = (async () => {
  process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-escopo';
  const mod = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
  const h = mod.routes(async () => ({}));
  const bate = async (caminho) => {
    const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    const u = new URL('http://x' + caminho);
    const t = await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
    return { t, s: res._s, b: res._b };
  };

  const s = await bate('/girassol-backup-offline/js/plano-compra.js');
  assert.ok(s.t === true && s.s === 200,
    'a fábrica NÃO montou na Girassol — alguma peça passada não existe no ponto da montagem. ' +
    'Quando isso acontece, o painel da empresa que mais fatura perde seções.');
  assert.doesNotThrow(() => new Function(s.b), 'o script servido pela fábrica não compila');
  assert.ok(s.b.includes('/girassol-backup-offline'),
    'o script veio com o prefixo de outra empresa — apontaria pras rotas erradas');

  /* e as rotas próprias seguem respondendo: a fábrica não pode ter tomado o lugar delas */
  for (const r of ['reaplicar-status', 'varrer-cancelados-status', 'painel']) {
    const x = await bate('/girassol-backup-offline/' + r + '?k=' + process.env.ADMIN_KEY);
    assert.ok(x.t === true, 'a rota própria /' + r + ' parou de responder depois de ligar a fábrica');
  }

  console.log('OK: Girassol usa a fabrica, monta no fim e mantem as 33 rotas proprias vencendo');

  /* ⚠️ carregar o módulo da Girassol abre um socket que não fecha sozinho: sem isto o teste
     PASSA mas não ENCERRA, e o `verifica.js` conta como vermelho por tempo esgotado — um falso
     vermelho, que ensina a ignorar o vermelho de verdade. Mesmo padrão dos outros testes da
     casa. */
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
