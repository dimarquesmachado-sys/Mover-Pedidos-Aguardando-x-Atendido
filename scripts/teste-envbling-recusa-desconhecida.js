/* 04/10 — `envBling` INVENTAVA A CREDENCIAL DE UMA EMPRESA DESCONHECIDA.

   Achado medindo o embarque da quarta empresa: `envBling('typo-girasol')` devolvia
   `TYPO-GIRASOL_BLING_CLIENT_ID` — uma env que não existe em lugar nenhum.

   Por que é pior que um erro: a empresa inventada parecia VÁLIDA. `valida()` recusava esse mesmo
   nome, mas `envBling` aceitava, e a falha só apareceria muito depois, como token ausente, longe
   da causa. Num embarque de CNPJ novo é exatamente o erro que mais custa: tudo "configurado",
   nada funcionando, e nenhuma mensagem apontando pro nome errado.

   ⚠️ COM O CONTRATO ILEGÍVEL o palpite CONTINUA, de propósito: é o caso em que `COMPAT_BLING`
   existe pra não derrubar o serviço no boot, e aí um palpite é melhor que parar tudo. A recusa
   vale quando o contrato está legível e sabe dizer quem existe.

   Marcador estável [ENVBLING]. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
const empresas = require(path.join(raiz, 'lib', 'empresas.js'));

/* ── as empresas reais continuam resolvendo, inclusive por alias ──────────────────── */
{
  const esperado = [
    ['girassol', 'BLING_CLIENT_ID'],
    ['good', 'GOOD_BLING_CLIENT_ID'],
    ['amb', 'AMB_BLING_CLIENT_ID'],
    ['ambtotal', 'AMB_BLING_CLIENT_ID'],   /* id canônico */
    ['gimpo', 'GOOD_BLING_CLIENT_ID'],     /* alias */
  ];
  for (const [emp, env] of esperado) {
    assert.strictEqual(empresas.envBling(emp), env,
      '[ENVBLING] "' + emp + '" deixou de resolver pra ' + env + ' → ' +
      JSON.stringify(empresas.envBling(emp)) + '. Empresa REAL sem credencial para o serviço.');
  }
}

/* ⚠️ ── e nome desconhecido NÃO pode virar uma env inventada ──────────────────────── */
{
  for (const ruim of ['typo-girasol', 'empresa-fantasma', 'gooD-errado', '']) {
    const r = empresas.envBling(ruim);
    assert.strictEqual(r, null,
      '[ENVBLING] o nome desconhecido ' + JSON.stringify(ruim) + ' recebeu a credencial ' +
      JSON.stringify(r) + ' — uma env que não existe. Um erro de digitação vira "empresa ' +
      'válida" com credencial inexistente, e a falha aparece muito depois, como token ausente, ' +
      'longe da causa. É o erro que mais custa num embarque de CNPJ novo.');
  }
}

/* ── coerência: o que `valida()` recusa, `envBling` também recusa ─────────────────── */
{
  for (const nome of ['typo-girasol', 'empresa-fantasma']) {
    assert.strictEqual(empresas.valida(nome), false, '[ENVBLING] premissa mudou: valida() aceita ' + nome);
    assert.strictEqual(empresas.envBling(nome), null,
      '[ENVBLING] `valida()` recusa "' + nome + '" mas `envBling` entrega credencial — as duas ' +
      'respostas discordando é o que deixa a empresa fantasma passar');
  }
  for (const nome of ['girassol', 'good', 'amb']) {
    assert.strictEqual(empresas.valida(nome), true, '[ENVBLING] valida() recusou a empresa real ' + nome);
    assert.ok(empresas.envBling(nome), '[ENVBLING] envBling recusou a empresa real ' + nome);
  }
}

/* ⚠️ ── CONTRATO ILEGÍVEL: o palpite CONTINUA, e as três reais seguem resolvendo ──────
   Este é o caso em que `COMPAT_BLING` existe: contrato ausente ou quebrado não pode derrubar o
   serviço no boot. Aqui um nome derivado é melhor que parar tudo — e as três empresas atuais
   precisam continuar achando a credencial CERTA, inclusive a Girassol, que nasceu SEM prefixo
   (`BLING_CLIENT_ID`, não `GIRASSOL_BLING_CLIENT_ID`) e seria a primeira a quebrar.

   ⚠️ Não dá pra provar este caminho por mutação com o contrato legível: o registro responde
   antes e o `COMPAT` fica inalcançável. Por isso o teste força o contrato ilegível de verdade. */
{
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['-e',
    'const e = require(' + JSON.stringify(path.join(raiz, 'lib', 'empresas.js')) + ');' +
    'console.log(JSON.stringify({' +
    '  girassol: e.envBling("girassol"), good: e.envBling("good"), amb: e.envBling("amb"),' +
    '  fantasma: e.envBling("empresa-fantasma") }));'],
    { encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, process.env, { CONTRATO_EMPRESAS_ARQ: '/caminho/que/nao/existe.json' }) });

  const linha = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  assert.ok(linha, '[ENVBLING] não consegui rodar com o contrato ilegível → ' +
    String(r.stderr || '').slice(0, 140));
  const sem = JSON.parse(linha);

  assert.strictEqual(sem.girassol, 'BLING_CLIENT_ID',
    '[ENVBLING] com o contrato ILEGÍVEL a Girassol perdeu a credencial histórica (ela nasceu SEM ' +
    'prefixo) → ' + JSON.stringify(sem.girassol) + '. É a rede que impede o boot de cair.');
  assert.strictEqual(sem.good, 'GOOD_BLING_CLIENT_ID', '[ENVBLING] GOOD sem credencial no modo histórico');
  assert.strictEqual(sem.amb, 'AMB_BLING_CLIENT_ID', '[ENVBLING] AMB sem credencial no modo histórico');

  assert.ok(sem.fantasma,
    '[ENVBLING] com o contrato ILEGÍVEL a recusa não se aplica: aí ninguém sabe quem existe, e ' +
    'derivar o nome é melhor que derrubar o serviço no boot');
}

console.log('OK: envBling resolve as empresas reais (e aliases) e recusa nome desconhecido');
