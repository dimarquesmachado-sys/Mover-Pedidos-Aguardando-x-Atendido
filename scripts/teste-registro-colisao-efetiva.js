/* 04/10 — DUAS EMPRESAS PODIAM RESOLVER PRA MESMA CREDENCIAL DO BLING.

   Achado H da auditoria do Codex, e é o último bloqueio da QUARTA EMPRESA. O registro recusava
   colisão de alias, slug e sufixo — mas só do que estava DECLARADO. Os padrões
   (`slug_http` → `/id`, `prefixo_env` → `ID_`, `sufixo_tabelas` → `_id`) são aplicados DEPOIS,
   na montagem: o PADRÃO de uma empresa podia bater com o valor DECLARADO de outra, e o contrato
   não reclamava.

   Reproduzido: `alfa` sem `prefixo_env` (herda `ALFA_`) e `beta` declarando `prefixo_env:
   "ALFA_"` passavam no boot, e as DUAS liam `ALFA_BLING_CLIENT_ID`. A beta operaria com a CONTA
   DA ALFA — emitindo nota, movendo pedido e gastando cota em nome de outro CNPJ.

   É por isso que ligar uma quarta empresa sem isto era arriscado: um descuido de uma linha no
   contrato fazia duas lojas compartilharem credencial, e nada avisava.

   O teste CARREGA o registro de verdade com contratos montados pra cada caso — carregar é
   justamente o momento em que o conflito tem que aparecer.

   ⚠️ E cobre o lado do FALSO POSITIVO: um contrato são precisa continuar passando. Guarda que
   recusa demais vira guarda desligada.

   Marcador estável [COLISAO]. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const raiz = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registro-colisao-'));

function carregar(empresas, nome) {
  const arq = path.join(dir, nome + '.json');
  fs.writeFileSync(arq, JSON.stringify({ versao: 1, empresas }));
  delete require.cache[require.resolve(path.join(raiz, 'lib', 'empresas', 'registro.js'))];
  const reg = require(path.join(raiz, 'lib', 'empresas', 'registro.js'));
  return reg.carregar({ servico: 'mover-pedidos', caminho: arq });
}

function recusa(empresas, nome) {
  try { carregar(empresas, nome); return null; } catch (e) { return String(e.message || e); }
}

/* ── as colisões EFETIVAS precisam derrubar o boot ────────────────────────────────── */
const COLISOES = [
  ['credencial (padrão da alfa × declarado da beta)',
   { alfa: { id_canonico: 'alfa', capacidades: [] },
     beta: { id_canonico: 'beta', capacidades: [], prefixo_env: 'ALFA_' } },
   /prefixo_env/],

  ['rota HTTP',
   { alfa: { id_canonico: 'alfa', capacidades: [] },
     beta: { id_canonico: 'beta', capacidades: [], slug_http: '/alfa' } },
   /slug_http/],

  ['sufixo de tabelas',
   { alfa: { id_canonico: 'alfa', capacidades: [] },
     beta: { id_canonico: 'beta', capacidades: [], sufixo_tabelas: '_alfa' } },
   /sufixo_tabelas/],

  ['prefixo fiscal',
   { alfa: { id_canonico: 'alfa', capacidades: [] },
     beta: { id_canonico: 'beta', capacidades: [], prefixo_fiscal: 'ALFA_' } },
   /prefixo_fiscal/],
];

for (const [nome, empresas, esperado] of COLISOES) {
  const erro = recusa(empresas, nome.replace(/\W+/g, '-'));
  assert.ok(erro,
    '[COLISAO] ' + nome + ': o registro ACEITOU duas empresas que resolvem pro mesmo valor. ' +
    'Em produção isso significa uma loja lendo as credenciais/rotas da outra — emitindo nota e ' +
    'gastando cota em nome de outro CNPJ.');
  assert.ok(esperado.test(erro),
    '[COLISAO] ' + nome + ': recusou, mas por outro motivo → ' + erro.slice(0, 110));
}

/* ⚠️ ── e o contrato SÃO não pode ser recusado ────────────────────────────────────── */
{
  const erro = recusa({
    alfa: { id_canonico: 'alfa', capacidades: [] },
    beta: { id_canonico: 'beta', capacidades: [] },
    gama: { id_canonico: 'gama', capacidades: [], prefixo_env: 'GAMA_NF_', slug_http: '/gama-loja' },
  }, 'sao');
  assert.strictEqual(erro, null,
    '[COLISAO] FALSO POSITIVO: um contrato sem colisão nenhuma foi recusado → ' +
    String(erro).slice(0, 120) + '. Guarda que recusa demais vira guarda desligada.');
}

/* e o contrato REAL do repositório continua válido — é o que roda hoje nas três empresas */
{
  delete require.cache[require.resolve(path.join(raiz, 'lib', 'empresas', 'registro.js'))];
  const reg = require(path.join(raiz, 'lib', 'empresas', 'registro.js'));
  assert.doesNotThrow(() => reg.carregar({ servico: 'mover-pedidos' }),
    '[COLISAO] o contrato REAL do repositório passou a ser recusado — a guarda nova está ' +
    'apertada demais e derrubaria o boot das três empresas');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log('OK: colisao efetiva (credencial, rota, tabela, fiscal) derruba o boot; contrato sao passa');
