/* 04/10 — UMA EMPRESA NOVA PRECISA SUBIR SÓ COM CONFIGURAÇÃO.

   Este é o teste do objetivo que guia a consolidação multiempresa: "embarcar novos CNPJs com o
   menos de dor possível". Ele PLUGA uma quarta empresa fictícia — só declarando no contrato e
   dando as envs — e exige que o serviço INICIE.

   Medido em 04/10, depois de fechados os achados D (desligar uma empresa para todo o trabalho
   dela) e H (duas empresas resolvendo pra mesma credencial): a quarta sobe com UMA linha no
   contrato e UMA env (`<PREFIXO>_ME_LOJA_IDS`). Nenhuma mudança de código.

   ⚠️ POR QUE ISSO VIRA TESTE E NÃO ANOTAÇÃO: o valor não é o número de envs de hoje, é saber na
   hora em que ele MUDAR. Qualquer `require` novo chumbado numa das três empresas, qualquer campo
   que passe a ser obrigatório, qualquer rota que assuma pasta própria — tudo isso quebra o
   embarque do CNPJ novo, e hoje só se descobriria na hora de plugar de verdade, com a loja
   parada esperando.

   O teste não usa rede nem toca em /data: contrato em diretório temporário, e o processo é
   derrubado assim que confirma que subiu.

   Marcador estável [EMPRESA-NOVA]. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const raiz = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'empresa-nova-'));

/* a quarta empresa, declarada só no contrato */
const contrato = JSON.parse(fs.readFileSync(path.join(raiz, 'contrato-empresas.json'), 'utf8'));
contrato.empresas.quartaloja = {
  id_canonico: 'quartaloja', nome: 'Quarta Loja', aliases: ['quartaloja', 'quarta'],
  slug_http: '/quarta', sufixo_tabelas: '_quarta',
  prefixo_env: 'QUARTA_', prefixo_fiscal: 'QUARTA_',
  prefixo_env_historico: { devolucoes: 'QUARTA_', 'mover-pedidos': 'QUARTA_' },
  capacidades: ['fiscal', 'checkout', 'ml'],
  conta_marketplace: { bling: 'propria', ml: 'propria' },
  apps_por_servico: {}, dono_hoje: {}, dono_alvo: {},
};
const arq = path.join(tmp, 'contrato.json');
fs.writeFileSync(arq, JSON.stringify(contrato));

/* ⚠️ as envs que a empresa nova precisa. Quando esta lista crescer, o teste falha e diz qual
   apareceu — é exatamente o aviso que se quer ter ANTES de plugar um CNPJ de verdade. */
const ENVS_ESPERADAS = ['QUARTA_ME_LOJA_IDS'];

const env = Object.assign({}, process.env, {
  ADMIN_KEY: 'teste-ci',
  ML_FULL_DIR: path.join(tmp, 'ml'),
  ML_FULL_CONF_ARQ: path.join(tmp, 'conf.json'),
  CONTRATO_EMPRESAS_ARQ: arq,
  EMPRESAS: 'girassol,good,amb,quartaloja',
  PORT: String(7400 + Math.floor(Math.random() * 120)),
});
for (const e of ENVS_ESPERADAS) env[e] = e.includes('IDS') ? '123456' : 'valor-de-teste';

const r = spawnSync(process.execPath, ['-e',
  'require(' + JSON.stringify(path.join(raiz, 'index.js')) + ');' +
  'setTimeout(function(){ console.log("SUBIU_OK"); process.exit(0); }, 8000);'],
  { cwd: raiz, env, encoding: 'utf8', timeout: 100000 });

const saida = String(r.stdout || '') + String(r.stderr || '');
fs.rmSync(tmp, { recursive: true, force: true });

/* ── o serviço tem que SUBIR ──────────────────────────────────────────────────────── */
if (!saida.includes('SUBIU_OK')) {
  const pedida = (saida.match(/precisa de ([A-Z0-9_]+)/) || [])[1];
  if (pedida && !ENVS_ESPERADAS.includes(pedida)) {
    assert.fail('[EMPRESA-NOVA] plugar um CNPJ novo passou a exigir a env ' + pedida + ', que ' +
      'não era necessária. Isso AUMENTA o custo de embarcar empresa — e hoje só se descobriria ' +
      'na hora de plugar de verdade, com a loja parada esperando. Se a exigência é legítima, ' +
      'some a env a ENVS_ESPERADAS e documente onde o dono consegue esse valor.');
  }
  const erro = (saida.match(/Error:[^\n]{0,180}/) || ['(sem mensagem)'])[0];
  assert.fail('[EMPRESA-NOVA] o serviço NÃO SOBE com uma quarta empresa declarada só no ' +
    'contrato → ' + erro + '. O objetivo da consolidação é embarcar CNPJ novo sem mexer em ' +
    'código; se isso quebrou, o embarque quebrou junto.');
}

/* ⚠️ ── e a quarta não pode ter QUEBRADO as três que já existem ───────────────────────
   Subir com a empresa nova não vale nada se a Girassol, a GOOD ou a AMB pararem junto. */
for (const e of ['girassol', 'good', 'amb']) {
  assert.ok(!new RegExp('empresa_desconhecida[^\\n]*' + e, 'i').test(saida),
    '[EMPRESA-NOVA] plugar a quarta empresa deixou "' + e + '" desconhecida no boot');
}

console.log('OK: uma empresa nova sobe so com contrato + ' + ENVS_ESPERADAS.length + ' env, sem mexer em codigo');
