/* 02/10 — A FÁBRICA DE ROTAS DO PAINEL, peça sozinha.

   O dono quer a GOOD igual à AMB e à Girassol, e o motivo é o alvo dele: "tem q ser
   multiempresa, pra outro CNPJ ser ligado mais facilmente".

   Medido: a GOOD tem 985 linhas de dashboard contra 4.254 da AMB, e 18 rotas do backend não
   existem nela. Mas as rotas que faltam são IDÊNTICAS entre AMB e Girassol — duas delas não
   diferem em UMA linha. Copiar pra GOOD seria a terceira cópia, e quatro no próximo CNPJ.

   ⚠️ A PRIMEIRA TENTATIVA FALHOU: as rotas carregam 13 dependências do arquivo da empresa, e
   duas eram ESTADO VIVO (`_cst`, `_vsy`) — 37 no-undef no eslint. O estado saiu primeiro
   (#556) e os no-undef caíram de 37 para 8, todas injetáveis. É o que tornou esta peça
   possível, e a razão de ela vir sozinha neste PR: ligar as três empresas junto é o que
   transformou PRs em seis rodadas hoje. */
const assert = require('assert');
const path = require('path');
const { criarRotasPainel } = require(path.join(__dirname, '..', 'lib', 'checkout', 'fabrica-rotas-painel'));

/* peça obrigatória faltando derruba NO BOOT, não na primeira chamada em produção — a lição do
   `pecas: {}` que passou batido na fábrica fiscal */
/* Codex #568: TODA dependência que o roteador desreferencia sem guarda é obrigatória */
const pecasBase = () => ({ json: () => {}, lerChaveAdmin: () => '', validarSessao: () => true,
  readJson: () => ({}), writeJson: () => {}, CACHE_DIR: '/tmp', fsx: require('fs'), pathx: require('path'),
  ehAdmin: () => true, readBody: async () => ({}), estadoRotinas: { custo: {}, vendas: {} },
  travaPesada: { quemEsta: () => null }, custoSyncTravado: async () => {}, _urlStatus: () => '',
  _inferCanal: () => 'outro', _diaFechadoDoDisco: () => null, _cstDiario: {}, LOJA_MKT: {},
  CONFERIDOS_FILE: '/tmp/_conferidos.json' });

/* ⚠️ A REGRA MUDOU E O TESTE MUDOU JUNTO (02/10), em vez de eu afrouxar a trava.

   O Codex escreveu, com razão: "toda dependência que o roteador desreferencia SEM GUARDA é
   obrigatória" — senão o estouro só muda de lugar, do boot pra primeira chamada em produção.
   Mas com a lista inteira obrigatória a GOOD NEM MONTAVA: ela não tem `vendasSync`,
   `_cstDiario` e companhia, e a fábrica toda era recusada por causa de rotas que ela nem
   usaria — o oposto do objetivo deste trabalho.

   O conserto certo não foi encolher a lista: foi a ROTA conferir antes de usar. Então a regra
   que este teste trava é a de verdade:
     · SEM guarda na rota  → obrigatória, derruba no boot
     · COM guarda (semPeca) → opcional, a rota recusa explicando
   O que não pode existir é peça usada sem guarda E sem ser obrigatória — essa é a que estoura
   em produção, e é o que o laço abaixo procura. */
const SEM_GUARDA = ['json', 'lerChaveAdmin', 'validarSessao', 'readJson', 'writeJson',
                    'CACHE_DIR', 'fsx', 'pathx'];
for (const falta of SEM_GUARDA) {
  const pecas = pecasBase();
  delete pecas[falta];
  assert.throws(() => criarRotasPainel({ empresa: 'x', prefixo: '/x', pecas }),
    new RegExp('falta a peça ' + falta),
    'a fábrica aceitou montar SEM `' + falta + '` — essa peça é usada sem guarda, então a ' +
    'falha apareceria na primeira chamada da rota em produção, não no boot');
}

/* e as opcionais montam, mas a rota que depende delas tem que ter a guarda — senão a montagem
   passa e o estouro vem na requisição, que é o pior dos dois mundos */
{
  const fs3 = require('fs');
  const src3 = fs3.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  const blocos = src3.split(/\/\* ─── (\/[\w-]+) /);
  const OPCIONAIS = ['vendasSync', 'responderCusto', 'blingGet', 'ehAdmin', 'custoSyncTravado',
                     '_inferCanal', '_diaFechadoDoDisco', '_cstDiario'];
  for (let i = 1; i < blocos.length; i += 2) {
    const rota = blocos[i], corpo = blocos[i + 1] || '';
    const usadas = OPCIONAIS.filter(n => new RegExp('\\b' + n + '\\b').test(corpo));
    if (!usadas.length) continue;
    assert.ok(/semPeca\(res,/.test(corpo),
      'a rota ' + rota + ' usa ' + usadas.join('/') + ' (que nem toda empresa tem) e NÃO confere ' +
      'antes — montaria e estouraria na primeira chamada');
  }
}

/* e a config incompleta também */
for (const campo of ['empresa', 'prefixo', 'pecas']) {
  const cfg = { empresa: 'x', prefixo: '/x', pecas: {} };
  delete cfg[campo];
  assert.throws(() => criarRotasPainel(cfg), new RegExp('falta ' + campo),
    'montou sem `' + campo + '`');
}

/* monta com as obrigatórias e devolve o roteador */
{
  const f = criarRotasPainel({ empresa: 'good', prefixo: '/good-checkout-offline', pecas: pecasBase() });
  assert.strictEqual(typeof f, 'function', 'a fábrica não devolveu o roteador');
}

/* Codex #568: sem vendasSync/blingGet (GOOD hoje) a rota responde semPeca em vez de estourar
   TypeError; e os requires da lib resolvem a partir de lib/checkout (o '../lib/...' ia pra lib/lib) */
(async () => {
  const resp = [];
  const f = criarRotasPainel({ empresa: 'good', prefixo: '/g', pecas: Object.assign(pecasBase(), { json: (r, c, o) => resp.push([c, o]) }) });
  const u = (p) => new URL('http://x' + p);
  await f({ headers: {} }, {}, '/g/vendas-sync', 'GET', u('/g/vendas-sync'));
  await f({ headers: {} }, {}, '/g/completar-detalhes', 'GET', u('/g/completar-detalhes?de=2026-01-01&ate=2026-01-02'));
  assert.ok(resp.length === 2 && resp.every(([c, o]) => c === 200 && o.ok === false && /não expõe/.test(o.erro)),
    'rota sem a peça opcional deveria responder semPeca: ' + JSON.stringify(resp));
  /* Codex #569: status do vendas-sync e config-frete sem a peça recusam; custo-sync?status=1 sem
     as peças do custo diário não estoura; com rotasProprias a fábrica cede a rota */
  resp.length = 0;
  await f({ headers: {} }, {}, '/g/vendas-sync', 'GET', u('/g/vendas-sync?status=1'));
  await f({ headers: {} }, {}, '/g/config-frete-magalu', 'POST', u('/g/config-frete-magalu'));
  assert.ok(resp.length === 2 && resp.every(([c, o]) => c === 200 && o.ok === false && /não expõe/.test(o.erro)),
    'status do vendas-sync / config-frete sem peça deveria responder semPeca: ' + JSON.stringify(resp));
  resp.length = 0;
  const sem = Object.assign(pecasBase(), { json: (r, c, o) => resp.push([c, o]) });
  ['_inferCanal', '_diaFechadoDoDisco', '_cstDiario'].forEach(k => delete sem[k]);
  const f3 = criarRotasPainel({ empresa: 'good', prefixo: '/g', pecas: sem });
  assert.strictEqual(await f3({ headers: {} }, {}, '/g/custo-sync', 'GET', u('/g/custo-sync?status=1')), true);
  assert.ok(resp.length === 1 && resp[0][0] === 200 && resp[0][1].ok === true && resp[0][1].diario === null,
    'custo-sync?status=1 sem as peças do custo diário: ' + JSON.stringify(resp));
  const f2 = criarRotasPainel({ empresa: 'good', prefixo: '/g', rotasProprias: ['custo-sync'], pecas: pecasBase() });
  assert.strictEqual(await f2({ headers: {} }, {}, '/g/custo-sync', 'GET', u('/g/custo-sync?status=1')), false,
    'rotasProprias deveria deixar a rota própria da empresa seguir');
  for (const m of ['magalu-cancelados', 'tiktok-custo-devolucoes', 'empresas']) {
    require.resolve(path.join(__dirname, '..', 'lib', m));
  }
})().catch(e => { console.error(e); process.exit(1); });

/* ⚠️ NADA DE REQUIRE RELATIVO AQUI DENTRO. Este arquivo mora em lib/ e as peças moram na pasta
   da empresa — foi exatamente esse erro que deixou 4 rotas de debug quebradas nas três (#544). */
{
  const fs2 = require('fs');
  const src = fs2.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  const semComentario = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const reqs = [...semComentario.matchAll(/require\('\.\/([^']+)'\)/g)].map(m => m[1]);
  for (const alvo of reqs) {
    assert.ok(fs2.existsSync(path.join(__dirname, '..', 'lib', 'checkout', alvo + '.js')),
      "a fábrica faz require('./" + alvo + "') e esse arquivo NÃO existe em lib/checkout/ — " +
      'peça da empresa tem que entrar por injeção');
  }
}

/* a empresa é PARÂMETRO: nada de 'amb' chumbado no corpo extraído da AMB */
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  /* ⚠️ tira TAMBÉM os comentários de uma linha. Sem isso o teste acusava a palavra "ambtotal"
     dentro de um `//` que só EXPLICA o nome do repo do Shopee — falso positivo, que ensina a
     ignorar o vermelho e é o erro que a regra da casa nomeia. */
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '')
                    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/\['amb'\]/.test(codigo),
    "sobrou um `['amb']` chumbado — a GOOD leria o seller da AMB e a conferência compararia " +
    'contra a loja errada');
  assert.ok(!/ambtotal|loja: 'amb'/.test(codigo), 'sobrou seller/loja da AMB chumbado');
  assert.ok(!/require\('\.\.\/lib\//.test(codigo), "require('../lib/...') resolve para lib/lib");
  assert.ok(!/'\/amb-checkout-offline/.test(codigo),
    'sobrou o prefixo da AMB — as rotas nasceriam no caminho errado nas outras empresas');
}

console.log('OK: fabrica de rotas do painel — peca obrigatoria derruba no boot, empresa e parametro, sem require relativo');
