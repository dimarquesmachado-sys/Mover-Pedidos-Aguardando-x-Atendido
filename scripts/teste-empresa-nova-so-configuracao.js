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

   O teste não usa rede nem toca em /data: contrato e TODOS os caminhos persistentes dos módulos
   que sobem no boot ficam em diretório temporário, a porta é alocada pelo SO e o processo é
   derrubado assim que confirma que subiu. Subir não basta: o boot tem que MOSTRAR as quatro
   empresas carregadas (senão uma omissão silenciosa passaria).

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

/* ⚠️ Codex #619 (P1): os módulos que sobem no boot criam pasta em /data (respostas-rapidas, fragil,
   backups...) e num host limpo o usuário do CI não pode criar /data → EACCES derrubava o processo
   antes do marcador. Todo caminho persistente vai pra dentro de tmp. Módulo novo que chumbe /data
   e suba no boot vai falhar aqui com o EACCES na mensagem — some a env dele a esta lista. */
const ENVS_DIR = ['ML_FULL_DIR', 'RESPOSTAS_DATA_DIR', 'AUTO_MSG_DATA_DIR', 'BACKUP_DATA_DIR',
  'BLING_RITMO_DIR', 'TIKTOK_CACHE_DIR', 'FRAGIL_DATA_DIR', 'MAGALU_DATA_DIR',
  'AMBBKP_ARQUIVO_DIR', 'AMBBKP_CACHE_DIR', 'GIRABKP_ARQUIVO_DIR', 'GIRABKP_CACHE_DIR',
  'GOODBKP_ARQUIVO_DIR', 'GOODBKP_CACHE_DIR'];
const ENVS_ARQ = ['AMB_TOKEN_FILE', 'AMB_NF_TOKEN_FILE', 'AMB_ML_TOKEN_FILE', 'GOOD_TOKEN_FILE',
  'GOOD_NF_TOKEN_FILE', 'GOOD_ML_TOKEN_FILE', 'ML_TOKEN_FILE', 'AMBIMG_TOKEN_FILE',
  'GOODIMG_TOKEN_FILE', 'LIXAS_TOKEN_FILE', 'ESTOQUE_TOKEN_FILE', 'ESTOQUE_GIRASSOL_TOKEN_FILE',
  'ESTOQUE_GIRASSOL_INDICE_EAN_FILE', 'FRAGIL_TOKEN_FILE', 'FRAGIL_INDICE_EAN_FILE',
  'CANARIO_MODULOS_FILE', 'CANARIO_TOKENS_FILE'];
const env = Object.assign({}, process.env, {
  ADMIN_KEY: 'teste-ci',
  ML_FULL_CONF_ARQ: path.join(tmp, 'conf.json'),
  CONTRATO_EMPRESAS_ARQ: arq,
  EMPRESAS: 'girassol,good,amb,quartaloja',
  PORT: '0', // Codex #619 (P2): o SO escolhe a porta — sem corrida com outro serviço do runner
});
for (const e of ENVS_DIR) env[e] = path.join(tmp, e.toLowerCase());
for (const e of ENVS_ARQ) env[e] = path.join(tmp, e.toLowerCase() + '.json');
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

/* ⚠️ ── as QUATRO empresas têm que aparecer CARREGADAS no boot ─────────────────────────
   Codex #619 (P2): o marcador SUBIU_OK sai de um timer do próprio teste, então "subiu" não prova
   que a quarta foi montada nem que as três antigas continuam lá. Verifica-se a saída do boot:
   a linha "[config] lojas:" (o que o serviço realmente montou) e a montagem a partir do contrato. */
const linhaLojas = (saida.match(/\[config\] lojas: ([^|\n]*)/) || [])[1] || '';
const montadas = linhaLojas.split(',').map(x => x.trim()).filter(Boolean);
for (const e of ['girassol', 'good', 'amb', 'quartaloja']) {
  assert.ok(montadas.includes(e), '[EMPRESA-NOVA] "' + e + '" não consta nas lojas montadas no ' +
    'boot (linha "[config] lojas:" = "' + linhaLojas + '"). Subir com uma empresa a menos é ' +
    'regressão silenciosa.');
}
assert.ok(/loja "quartaloja" montada a partir do contrato/.test(saida),
  '[EMPRESA-NOVA] a quarta empresa não foi montada a partir do contrato');
assert.ok(/Empresas ativas:[^\n]*Quarta Loja/.test(saida),
  '[EMPRESA-NOVA] a quarta empresa não aparece entre as "Empresas ativas" do boot');
assert.ok(/\[Quarta Loja\] cron F1/.test(saida),
  '[EMPRESA-NOVA] a quarta empresa subiu sem agendar os crons de pedido (F1)');

console.log('OK: uma empresa nova sobe so com contrato + ' + ENVS_ESPERADAS.length + ' env, sem mexer em codigo');
