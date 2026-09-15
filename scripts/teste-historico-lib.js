'use strict';
/* 14/09 — passo 3 da Fase 3: o histórico vira lib. O que isso destrava: a GOOD NÃO TINHA
   histórico nenhum (por isso não tem dashboard de vendas), e a peça que falta lá é exatamente
   a que estava duplicada na AMB e na Girassol — ~1.000 linhas cada, a mesma lógica, uma
   parametrizada e a outra cravada.
   O teste guarda o risco real desta peça, que não é o contrato e sim a IDENTIDADE dos dados:
   cada empresa tem que ler o cache, o admin, o cliente Bling e a fatia do Supabase DELA.
   Misturar isso já aconteceu uma vez (Codex #197) e o sintoma é o pior possível: número certo
   da empresa errada, que ninguém questiona porque parece um número. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const CTX_MIN = { validarSessao: () => true, supaCfg: () => ({ url: '', key: '' }), histCache: {} };

/* a lib não aceita contexto pela metade — sem isso, faltaria a rede que o fallback dava */
const lib = require('../lib/checkout/historico');
assert.throws(() => lib.rotasHistorico({ empresa: 'x' }), /falta /,
  'contexto incompleto tem que derrubar no boot, não virar herança silenciosa de outra empresa');

/* 14/09 — a GOOD entrou: ela nunca teve histórico (por isso não tinha dashboard), e o painel
   dela já CHAMAVA /good-checkout-offline/historico, batendo numa rota inexistente. */
const FACHADAS = [
  ['amb-checkout-offline', 'amb-historico', 'amb'],
  ['girassol-backup-offline', 'historico', 'girassol'],
  ['good-checkout-offline', 'historico-good', 'good'],
];

for (const [pasta, arq, empresa] of FACHADAS) {
  const { rotasHistorico } = require('../' + pasta + '/' + arq);
  assert.strictEqual(typeof rotasHistorico(CTX_MIN), 'function', pasta + ': não devolveu handler');

  const s = fs.readFileSync(path.join(__dirname, '..', pasta, arq + '.js'), 'utf8');
  assert.ok(new RegExp("empresa: '" + empresa + "'").test(s),
    pasta + ": a fatia do Supabase tem que ser 'empresa=eq." + empresa + "' — trocar mostra o número da empresa errada");
  assert.ok(new RegExp("modulo: '" + pasta + "'").test(s),
    pasta + ': o prefixo das seis rotas tem que ser o desta empresa');
  /* as dependências vêm do base DESTA pasta */
  for (const dep of ['CACHE_DIR', 'CONFERIDOS_FILE', 'ehAdmin', 'blingGet', 'PAUSA_MS']) {
    assert.ok(new RegExp(dep + ': base\\.' + dep).test(s), pasta + ': ' + dep + ' tem que vir do base desta empresa');
  }
  assert.ok(!/\|\| base\./.test(s), pasta + ': fallback silencioso de volta — é por aí que uma empresa herda dados da outra');
}

/* as duas não podem apontar pra mesma fatia do Supabase */
const empresas = FACHADAS.map(([pasta, arq]) => {
  const s = fs.readFileSync(path.join(__dirname, '..', pasta, arq + '.js'), 'utf8');
  return (/empresa: '([^']+)'/.exec(s) || [])[1];
});
assert.strictEqual(new Set(empresas).size, empresas.length, 'duas empresas lendo a mesma fatia: ' + empresas.join(', '));

/* a alíquota do Simples é tabela MENSAL e por empresa (AMB 4%→8,82%, Girassol 11,4%→15%).
   A da GOOD ainda não foi informada, e o teste guarda a honestidade disso: tabela VAZIA cai
   no padrão do cálculo, e ninguém deve preenchê-la com chute — imposto inventado vira número
   errado no lugar de número ausente. */
{
  const idx = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');
  const m = /const DEFAULT_ALIQ_BK_GOOD = (\{[^}]*\});/.exec(idx);
  assert.ok(m, 'a GOOD precisa declarar a tabela de alíquotas, nem que vazia');
  const tabela = JSON.parse(m[1].replace(/'/g, '"').replace(/(\d{4}-\d{2}):/g, '"$1":'));
  const valores = Object.values(tabela);
  if (valores.length) {
    for (const v of valores) assert.ok(Number(v) > 0, 'alíquota da GOOD com valor inválido: ' + v);
  }
}

console.log('OK: histórico único nas TRÊS — a lib exige contexto completo, e cada empresa lê a própria fatia, o próprio cache e o próprio admin');
