'use strict';
/* 14/09 — O TESTE DE ACEITAÇÃO DA AUDITORIA: "dado um quarto registro válido e credenciais,
   o mesmo artefato sobe rotas e crons isolados, SEM criar pasta e SEM editar JavaScript".
   Este teste monta uma quarta empresa que não existe em lugar nenhum do repositório — não
   tem pasta, não tem require, não tem linha de código dedicada — e verifica que ela sai
   completa: rotinas, rotas, crons, e tudo apontando pras envs e caminhos DELA.
   É o critério que separa "multiempresa em consolidação" de "multiloja pronto". */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { carregar } = require('../lib/empresas/registro');
const { montarEmpresa } = require('../lib/fiscal/montar-empresa');

/* contrato sintético: a quarta empresa existe SÓ como dado */
const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nova-')), 'c.json');
fs.writeFileSync(arq, JSON.stringify({
  versao: 99,
  empresas: {
    ambtotal: { id_canonico: 'ambtotal', nome: 'AMBTotal', aliases: ['amb'], slug_http: '/amb', prefixo_env: 'AMB_', sufixo_tabelas: '_amb', capacidades: ['fiscal'] },
    quarta:   { id_canonico: 'quarta', nome: 'Quarta Loja', aliases: ['q4'], slug_http: '/quarta', prefixo_env: 'QUARTA_', sufixo_tabelas: '_quarta', capacidades: ['fiscal'] },
  },
}));
const registro = carregar({ caminho: arq, servico: 'mover-pedidos' });

/* 15/09 — empresa nova precisa declarar o CANAL DE VENDA do ML dela. O padrão herdado
   (206017293) é de outra empresa, e o F1 usa isso pra decidir o que é venda do ML: herdar
   faria a empresa nova julgar os pedidos dela pelo canal alheio — e ignorar tudo, em
   silêncio. O teste prova os dois lados: sem a env, não monta; com ela, monta. */
assert.throws(() => montarEmpresa('quarta', { registro }), /ME_LOJA_IDS/,
  'sem o canal do ML declarado, a empresa nova NÃO pode ser montada');
process.env.QUARTA_ME_LOJA_IDS = '999888777';

const mod = montarEmpresa('quarta', { registro });

/* o módulo sai completo, no mesmo formato que o orquestrador espera das outras */
assert.strictEqual(mod.id, 'quarta');
assert.strictEqual(mod.nome, 'Quarta Loja');
assert.strictEqual(typeof mod.routes, 'function', 'a empresa nova precisa expor rotas');
assert.deepStrictEqual(Object.keys(mod.rotinas).sort(),
  ['corrigirNFs', 'nfeMl', 'rotinaExpediente', 'rotinaManha', 'rotinaVirada'],
  'a empresa nova precisa das cinco rotinas — é assim que o agendador a liga');
for (const [k, v] of Object.entries(mod.rotinas)) assert.strictEqual(typeof v, 'function', 'rotina ' + k);

/* as rotas nascem sob o slug DELA — sem isso, duas empresas colidiriam na mesma URL */
const fabrica = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fiscal', 'criar-modulo.js'), 'utf8');
assert.ok(/\(prefixo \+ '\/setup'\)/.test(fabrica), 'as rotas têm que ser montadas a partir do prefixo');

/* o F3 dela NÃO pode nascer no mesmo minuto das existentes: seria disputa por cota */
const minutoNovo = String(mod.crons.nfeMl).split(',')[0];
assert.ok(!['0', '2', '4'].includes(minutoNovo),
  'a empresa nova pegou um minuto de F3 já usado (' + minutoNovo + ') — nasceria disputando cota do Bling');

/* aliases funcionam na borda, id canônico por dentro */
assert.strictEqual(montarEmpresa('q4', { registro }).id, 'quarta', 'o alias tem que montar a mesma empresa');

/* empresa fora do contrato não nasce, e sem a capacidade "fiscal" também não */
assert.throws(() => montarEmpresa('inexistente', { registro }), /não está no contrato/);
const semFiscal = path.join(path.dirname(arq), 'sf.json');
fs.writeFileSync(semFiscal, JSON.stringify({ empresas: { x: { id_canonico: 'x', nome: 'X', slug_http: '/x', prefixo_env: 'X_', sufixo_tabelas: '_x', capacidades: ['checkout'] } } }));
assert.throws(() => montarEmpresa('x', { registro: carregar({ caminho: semFiscal }) }), /não declara a capacidade "fiscal"/);

console.log('OK: uma QUARTA empresa nasce só do contrato — rotinas, rotas e crons completos, sem pasta, sem require e sem editar JavaScript');
