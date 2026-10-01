/* 30/09 — CORREÇÕES DE CIDADE: é esta lib que decide se a NF sai ou fica parada na SEFAZ.

   O caso que motivou: uma NF da Girassol não emitiu porque o cliente escreveu "Sem Peixe" e o
   nome oficial do IBGE é "Sem-Peixe" (MG). A SEFAZ recusa, e a NF fica esperando.

   A lib já existia e já tinha o caso IDÊNTICO resolvido — `Embu-Guaçu` — sob o comentário
   "Nomes que clientes informam sem o hífen oficial". Faltava só a entrada.

   Este teste não existia. A lib decide emissão fiscal nas TRÊS empresas e nenhuma checagem
   olhava pra ela: um erro de digitação numa chave (acento, caixa, pipe) passaria em silêncio e
   só apareceria como NF parada. */
const assert = require('assert');
const path = require('path');
const { CORRECOES_CIDADE, aplicarCorrecaoCidade } = require(path.join(__dirname, '..', 'lib', 'correcoesCidades'));

/* o caso novo, nas grafias que o cliente realmente digita */
for (const escrito of ['Sem Peixe', 'sem peixe', 'SEM PEIXE', 'Sem-Peixe', 'Sem  Peixe', ' Sem Peixe ', 'Sem Peixe']) {
  const r = aplicarCorrecaoCidade(escrito, 'MG');
  assert.strictEqual(r.municipio, 'Sem-Peixe',
    '"' + escrito + '/MG" não vira "Sem-Peixe": a SEFAZ recusa e a NF fica parada');
  assert.strictEqual(r.uf, 'MG', 'a UF se perdeu na correção de ' + escrito);
}

/* o caso gêmeo que já existia: se ele quebrar, a regra do hífen regrediu */
assert.strictEqual(aplicarCorrecaoCidade('Embu Guaçu', 'SP').municipio, 'Embu-Guaçu',
  'o Embu-Guaçu parou de ser corrigido — é o mesmo padrão do Sem-Peixe');

/* e o que JÁ está certo não pode ser mexido: corrigir o que não precisa é pior que não corrigir */
for (const [cidade, uf] of [['Belo Horizonte', 'MG'], ['São Paulo', 'SP'], ['Rio de Janeiro', 'RJ']]) {
  const r = aplicarCorrecaoCidade(cidade, uf);
  assert.strictEqual(r.municipio, cidade, cidade + ' foi alterada sem precisar');
  assert.strictEqual(r.uf, uf, 'a UF de ' + cidade + ' foi alterada');
}

/* as CHAVES do mapa seguem o formato que a função procura: minúsculas e "cidade|uf".
   Uma chave com maiúscula ou sem o pipe nunca casa, e a correção não acontece — em silêncio. */
for (const chave of Object.keys(CORRECOES_CIDADE)) {
  assert.strictEqual(chave, chave.toLowerCase(),
    'chave "' + chave + '" tem maiúscula: a busca é em minúsculas e esta entrada NUNCA casaria');
  assert.ok(/^[^|]+\|[a-z]{2}$/.test(chave),
    'chave "' + chave + '" fora do formato "cidade|uf" — não casaria nunca');
  const v = CORRECOES_CIDADE[chave];
  assert.ok(v && v.municipio && v.uf, 'a entrada "' + chave + '" está incompleta');
  assert.strictEqual(v.uf, v.uf.toUpperCase(), 'a UF de "' + chave + '" precisa ser maiúscula (vai pra NF)');
  /* e a UF do destino tem que bater com a da chave: trocar de estado numa correção de nome
     mandaria a NF pro lugar errado */
  assert.strictEqual(v.uf.toLowerCase(), chave.split('|')[1],
    'a entrada "' + chave + '" corrige para outra UF (' + v.uf + ') — confira se é intencional');
}

console.log('OK: correcoes de cidade — Sem-Peixe entra, Embu-Guacu segue, cidade certa nao e mexida, chaves no formato');
