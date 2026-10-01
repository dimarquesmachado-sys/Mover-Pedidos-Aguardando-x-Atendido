/* 30/09 — A FÁBRICA FISCAL NÃO PODE BUSCAR PEÇA POR REQUIRE RELATIVO.

   O que aconteceu, em produção e nas TRÊS empresas: a rota /robo/nfs-consultar-situacao fazia
   `require('./nfBlingApi')` de dentro de `lib/fiscal/`, onde esse arquivo não existe — cada
   empresa tem o seu na própria pasta. A rota respondia "Cannot find module" desde que o módulo
   virou fábrica, e ninguém percebeu porque ela só é chamada quando se vai diagnosticar uma NF
   parada. O dono topou com isso exatamente nessa hora.

   A fábrica é código ÚNICO com a empresa como parâmetro: tudo que é da empresa entra por
   INJEÇÃO. Um require relativo ali dentro procura na pasta errada por construção.

   Este teste trava a classe inteira, não o caso: nenhum require relativo de peça de empresa
   dentro de lib/fiscal/, e a peça nova chegando pelas três. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const fabrica = fs.readFileSync(path.join(raiz, 'lib', 'fiscal', 'criar-modulo.js'), 'utf8');

/* a regra geral: a fábrica só pode exigir o que está em lib/ — nada da pasta da empresa */
/* ⚠️ sem tirar os comentários, o próprio comentário que EXPLICA o bug ("fazia
   `require('./nfBlingApi')`...") seria lido como código e o teste acusaria o que já está
   consertado. Falso positivo ensina a ignorar o vermelho — pior que não ter o teste. */
const fabricaCodigo = fabrica
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const requires = [...fabricaCodigo.matchAll(/require\('\.\/([^']+)'\)/g)].map(m => m[1]);
for (const alvo of requires) {
  const existe = fs.existsSync(path.join(raiz, 'lib', 'fiscal', alvo + '.js'))
              || fs.existsSync(path.join(raiz, 'lib', 'fiscal', alvo));
  assert.ok(existe,
    "a fábrica faz require('./" + alvo + "') e esse arquivo NÃO existe em lib/fiscal/ — se é " +
    'peça da empresa, ela tem que entrar por injeção em `pecas`, senão a rota quebra em ' +
    'produção nas três empresas');
}

/* e a peça que motivou isto chega pelas três */
assert.ok(/getNFsSituacaoConsulta,\n  \} = cfg\.pecas;/.test(fabrica) || /getNFsSituacaoConsulta/.test(fabrica),
  'a fábrica não recebe `getNFsSituacaoConsulta` por injeção');

for (const emp of ['girassol', 'ambtotal', 'good']) {
  const src = fs.readFileSync(path.join(raiz, emp, 'index.js'), 'utf8');
  assert.ok(/getNFsSituacaoConsulta: require\('\.\/nfBlingApi'\)\.getNFsSituacaoConsulta/.test(src),
    emp + ': não injeta `getNFsSituacaoConsulta` na fábrica — a rota /robo/nfs-consultar-situacao ' +
    'volta a quebrar nesta empresa');

  /* e a função existe DE VERDADE no módulo da empresa: injetar undefined é o mesmo bug com
     outra cara, e só apareceria quando alguém chamasse a rota */
  /* as QUATRO peças que a fábrica usa nas rotas de debug: o teste varreu o arquivo e achou
     que não era só uma rota quebrada, eram quatro — /robo/nfs-consultar-situacao,
     /debug/nf-corrigir/, /debug/sintegra/ e /debug/cep/. */
  for (const peca of ['getNFsSituacaoConsulta', 'getNFDetalhe', 'getIEPorCNPJ', 'getCidadePorCEP']) {
    assert.ok(new RegExp(peca + ": require\\('\\./nfBlingApi'\\)\\." + peca).test(src),
      emp + ': não injeta `' + peca + '` — a rota que a usa volta a quebrar nesta empresa');
    const mod = require(path.join(raiz, emp, 'nfBlingApi'));
    assert.strictEqual(typeof mod[peca], 'function',
      emp + '/nfBlingApi não exporta `' + peca + '` — a injeção passaria undefined, que é o ' +
      'mesmo bug com outra cara');
  }
}

/* a resposta não pode mentir a empresa: o rótulo estava chumbado como "ambtotal" na fábrica
   das três, então a Girassol diria que é AMB */
assert.ok(!/empresa: 'ambtotal'/.test(fabrica),
  'a fábrica responde com a empresa chumbada — a Girassol e a GOOD se identificariam como AMB');

console.log('OK: fabrica fiscal sem require relativo de peca de empresa; getNFsSituacaoConsulta injetada nas 3');
