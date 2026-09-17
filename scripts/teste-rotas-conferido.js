'use strict';
/* 17/09 — 5ª e última fatia das rotas IDÊNTICAS do passo 4: `conferido` (o estoquista termina
   o pedido e ele é arquivado), `run` e `sincronizar`.

   O `conferido` só chegou aqui idêntico por um caminho que vale registrar: ao medir esta
   fatia, a diferença entre as empresas era o `nf_id` que só a AMB e a Girassol gravavam — o
   link ↗ pra NF no Bling nunca aparecia na GOOD. Portada a capacidade (#488), o Codex achou
   que ela vinha com um furo junto: sem a guarda `!snapC.nf_anexada`, o campo grava o id da
   nota CANCELADA quando o admin anexa a NF à mão. As três ficaram com a guarda, e SÓ ENTÃO o
   corpo ficou igual. Medir a fatia consertou um bug antes de extrair qualquer coisa. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criar } = require('../lib/checkout/rotas-conferido');
const raiz = path.join(__dirname, '..');

const deps = {
  prefixo: '/x', json: () => {}, readBody: async () => ({}), readJson: () => ({}), writeJson: () => {},
  lerReservas: () => ({}), moverSituacao: async () => ({}), arquivarFinalizado: () => {},
  sincronizarConferidos: async () => ({}), rodarCiclo: async () => ({}),
  CONFERIDOS_FILE: '/tmp/c.json', RESERVAS_FILE: '/tmp/r.json', CACHE_DIR: '/tmp',
  SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 'teste', rotulo: 'TESTE',
};

assert.throws(() => criar({}), /falta prefixo/);
for (const faltando of ['SIT_VERIFICADO', 'arquivarFinalizado', 'rodarCiclo', 'RESERVAS_FILE']) {
  const parcial = Object.assign({}, deps); delete parcial[faltando];
  assert.throws(() => criar(parcial), new RegExp('falta ' + faltando),
    'dependência ausente derruba na criação, não na primeira chamada');
}
assert.strictEqual(typeof criar(deps), 'function');

/* O SIT_VERIFICADO é INJETADO, nunca lido de env aqui dentro: ele é o destino do pedido
   conferido e DEPENDE DA EXPEDIÇÃO (com app vai pra VERIFICADO, sem app vai direto pra
   DESPACHADOS). Uma lib não pode decidir o fluxo físico de uma empresa que ela não conhece. */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-conferido.js'), 'utf8');
  assert.ok(!/process\.env/.test(s),
    'a lib não pode ler env: o destino do conferido depende da Expedição, que é decisão da empresa');
  assert.ok(/SIT_VERIFICADO/.test(s) && /cfg/.test(s), 'o destino tem que vir injetado');
}

/* a guarda do nf_id continua nas três — portar a capacidade sem ela portaria o buraco */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(!/nf_id:\s*\(snapC && snapC\.nf/.test(s),
    arq + ': o nf_id voltou SEM a guarda !snapC.nf_anexada — gravaria o id da nota cancelada');
}

/* A POSIÇÃO É PARTE DA SEGURANÇA (lição do #480) e nenhuma cópia volta pras pastas */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const portao = s.indexOf("erro: 'Sessão necessária. Faça login.'");
  const delega = s.indexOf('_rotasConferido(req, res, urlObj');
  assert.ok(portao > 0 && delega > 0, arq + ': faltou o portão ou a delegação');
  assert.ok(delega > portao, arq + ': a delegação está ANTES do portão — as rotas responderiam sem autenticação');
  for (const rota of ['conferido', 'sincronizar']) {
    assert.ok(!new RegExp("p === '/[\\w-]+/" + rota + "'").test(s), arq + ': a cópia de /' + rota + ' voltou');
  }
}

/* 17/09 (2 P2 do Codex) — O RÓTULO E O PREFIXO TINHAM FICADO CRAVADOS COMO AMB.
   As três empresas rodam no MESMO processo: o log da Girassol sairia como [AMBBKP], e a
   resposta do /run dela mandaria o operador olhar /amb-checkout-offline/status. Log que
   atribui a ação à empresa errada é pior que log nenhum — manda investigar a conta errada. */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-conferido.js'), 'utf8');
  /* tirar os comentários DE VERDADE: meu filtro por linha não pegava continuação de bloco,
     e o teste acusava a menção que está dentro do próprio comentário que explica o conserto. */
  const codigo = s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/AMBBKP|amb-checkout-offline/.test(codigo),
    'a lib tem rótulo ou slug da AMB cravado — as três rodam no mesmo processo');
  assert.ok(/\[\$\{rotulo\}\]/.test(codigo), 'o log tem que usar o rótulo injetado');
  assert.ok(/\$\{prefixo\}\/status/.test(codigo), 'a rota de status tem que sair do prefixo injetado');

  /* prova de verdade: três instâncias, três respostas */
  const base = {
    json: () => {}, readBody: async () => ({}), readJson: () => ({}), writeJson: () => {},
    lerReservas: () => ({}), moverSituacao: async () => ({}), arquivarFinalizado: () => {},
    sincronizarConferidos: async () => ({}), rodarCiclo: async () => ({}),
    CONFERIDOS_FILE: '/tmp/c.json', RESERVAS_FILE: '/tmp/r.json', CACHE_DIR: '/tmp',
    SIT_VERIFICADO: 24, SYNC_ON: true, VERSAO: 't',
  };
  const vistas = [];
  for (const [pref, rot] of [['/a', 'A'], ['/b', 'B']]) {
    const h = criar(Object.assign({}, base, {
      prefixo: pref, rotulo: rot,
      json: (r, c, corpo) => vistas.push(corpo && corpo.mensagem),
    }));
    h({ headers: {} }, {}, { pathname: pref + '/run', searchParams: new URLSearchParams() }, 'GET', () => true);
  }
  assert.ok(vistas[0] !== vistas[1], 'duas empresas responderam a MESMA rota de status');
  assert.ok(/\/a\/status/.test(vistas[0]) && /\/b\/status/.test(vistas[1]),
    'cada empresa tem que apontar pro PRÓPRIO status');
}

console.log('OK: rotas de conferência — uma lib para as três, o destino do conferido vem injetado (depende da Expedição) e a guarda do nf_id segue de pé');
