'use strict';
/* 18/11 (norte C, `montarCheckout`, passo 24) — as rotas em que a FÁBRICA do painel cede a vez numa empresa.
   Cada arquivo de entrada escrevia a lista à mão (`rotasProprias: [...]`); agora ela é da fábrica (`ROTAS_DAS_PECAS`: o que
   o canário da empresa e as rotas comuns atendem antes dela, nas três) e o arquivo só escreve `rotasProprias` se tiver
   rota só dele (hoje nenhum tem). Os testes que conferiam a lista no texto do arquivo conferem AQUI a união das duas. */
function declaradas(srcDoArquivo) {
  const daFabrica = require('../lib/checkout/fabrica-rotas-painel').ROTAS_DAS_PECAS;
  const m = /rotasProprias:\s*\[([^\]]*)\]/.exec(String(srcDoArquivo || ''));
  const doArquivo = m ? [...m[1].matchAll(/'([\w.\/-]+)'/g)].map((x) => x[1]) : [];
  return [...new Set(daFabrica.concat(doArquivo))];
}
/* no formato que os testes já liam (o miolo de `rotasProprias: [ … ]`) */
function texto(srcDoArquivo) { return declaradas(srcDoArquivo).map((n) => "'" + n + "'").join(', '); }
module.exports = { declaradas, texto };
