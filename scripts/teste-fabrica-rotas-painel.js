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
for (const falta of ['json', 'lerChaveAdmin', 'CACHE_DIR', 'fsx', 'pathx']) {
  const pecas = { json: () => {}, lerChaveAdmin: () => '', validarSessao: () => true,
                  readJson: () => ({}), writeJson: () => {}, CACHE_DIR: '/tmp',
                  fsx: require('fs'), pathx: require('path') };
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
  const f = criarRotasPainel({ empresa: 'good', prefixo: '/good-checkout-offline', pecas: {
    json: () => {}, lerChaveAdmin: () => '', validarSessao: () => true, readJson: () => ({}),
    writeJson: () => {}, CACHE_DIR: '/tmp', fsx: require('fs'), pathx: require('path') } });
  assert.strictEqual(typeof f, 'function', 'a fábrica não devolveu o roteador');
}

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
  assert.ok(!/'\/amb-checkout-offline/.test(codigo),
    'sobrou o prefixo da AMB — as rotas nasceriam no caminho errado nas outras empresas');
}

console.log('OK: fabrica de rotas do painel — peca obrigatoria derruba no boot, empresa e parametro, sem require relativo');
