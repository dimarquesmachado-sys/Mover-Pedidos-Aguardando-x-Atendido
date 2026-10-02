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

for (const falta of Object.keys(pecasBase())) {
  const pecas = pecasBase();
  delete pecas[falta];
  assert.throws(() => criarRotasPainel({ empresa: 'x', prefixo: '/x', pecas }),
    new RegExp('falta a peça ' + falta),
    'a fábrica aceitou montar SEM `' + falta + '` — a falha apareceria na primeira chamada da ' +
    'rota em produção, não no boot');
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
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\['amb'\]/.test(codigo),
    "sobrou um `['amb']` chumbado — a GOOD leria o seller da AMB e a conferência compararia " +
    'contra a loja errada');
  assert.ok(!/ambtotal|loja: 'amb'/.test(codigo), 'sobrou seller/loja da AMB chumbado');
  assert.ok(!/require\('\.\.\/lib\//.test(codigo), "require('../lib/...') resolve para lib/lib");
  assert.ok(!/'\/amb-checkout-offline/.test(codigo),
    'sobrou o prefixo da AMB — as rotas nasceriam no caminho errado nas outras empresas');
}

console.log('OK: fabrica de rotas do painel — peca obrigatoria derruba no boot, empresa e parametro, sem require relativo');
