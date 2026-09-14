'use strict';
/* REGISTRO CANÔNICO DE EMPRESAS (13/09) — o primeiro passo que a auditoria multiloja
   recomendou. O que este teste guarda:
     1. alias é de BORDA e o id canônico manda por dentro ('amb' → 'ambtotal');
     2. o prefixo de env é POR SERVIÇO, e prefixo VAZIO é valor, não ausência (a Girassol
        nasceu sem prefixo no Mover-Pedidos — forçar underscore inventaria env inexistente);
     3. a fachada antiga devolve exatamente o mesmo de antes (migração sem susto);
     4. o registro FALHA ALTO em colisão de alias/slug/tabela, que é o que faria a quarta
        empresa quebrar em silêncio meses depois;
     5. uma QUARTA empresa sintética funciona só com dado — o critério de sucesso da auditoria. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { carregar, ContratoInvalidoError } = require('../lib/empresas/registro');

// 1) alias de borda → id canônico
const mp = carregar({ servico: 'mover-pedidos' });
assert.strictEqual(mp.normalizar('amb'), 'ambtotal');
assert.strictEqual(mp.normalizar('/amb'), 'ambtotal', 'slug com barra também normaliza');
assert.strictEqual(mp.normalizar('AMBTOTAL'), 'ambtotal');
assert.strictEqual(mp.normalizar('nao-existe'), null, 'empresa fora do contrato não nasce por digitação');

// 2) prefixo por serviço, com o vazio preservado
assert.strictEqual(mp.nomeEnv('girassol', 'BLING_CLIENT_ID'), 'BLING_CLIENT_ID', 'Girassol no Mover-Pedidos não tem prefixo');
assert.strictEqual(mp.nomeEnv('amb', 'BLING_CLIENT_ID'), 'AMB_BLING_CLIENT_ID');
const dev = carregar({ servico: 'devolucoes' });
assert.strictEqual(dev.nomeEnv('girassol', 'BLING_CLIENT_ID'), 'GIRASSOL_BLING_CLIENT_ID', 'no outro serviço ela entra no padrão');
assert.strictEqual(dev.nomeEnv('good', 'BLING_CLIENT_ID'), 'BLING_CLIENT_ID', 'e lá quem não tem prefixo é a GOOD');

// 3) a fachada não mudou de comportamento
const fachada = require('../lib/empresas');
for (const e of ['girassol', 'amb', 'good']) {
  assert.strictEqual(fachada.envBling(e), mp.nomeEnv(e, 'BLING_CLIENT_ID'), 'envBling de ' + e + ' mudou — a fachada tinha que ser idêntica');
}
assert.strictEqual(fachada.canonico('amb'), 'ambtotal');

// 4) colisões FALHAM ALTO (sem isso, a quarta empresa quebra meses depois, em silêncio)
function comContrato(empresas) {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'contr-')), 'c.json');
  fs.writeFileSync(arq, JSON.stringify({ versao: 'teste', empresas }));
  return () => carregar({ caminho: arq, servico: 'mover-pedidos' });
}
assert.throws(comContrato({
  a: { id_canonico: 'a', aliases: ['x'], slug_http: '/a', sufixo_tabelas: '_a', capacidades: [] },
  b: { id_canonico: 'b', aliases: ['x'], slug_http: '/b', sufixo_tabelas: '_b', capacidades: [] },
}), /alias "x" aponta pra duas/, 'alias repetido tem que explodir');
assert.throws(comContrato({
  a: { id_canonico: 'a', slug_http: '/mesmo', sufixo_tabelas: '_a', capacidades: [] },
  b: { id_canonico: 'b', slug_http: '/mesmo', sufixo_tabelas: '_b', capacidades: [] },
}), /slug_http .* colide/, 'slug repetido tem que explodir');
assert.throws(comContrato({
  a: { id_canonico: 'a', slug_http: '/a', sufixo_tabelas: '_igual', capacidades: [] },
  b: { id_canonico: 'b', slug_http: '/b', sufixo_tabelas: '_igual', capacidades: [] },
}), /sufixo_tabelas .* colide/, 'tabela compartilhada entre empresas tem que explodir');
assert.throws(comContrato({ a: { nome: 'sem id' } }), /sem id_canonico/);

// 4a) contrato LIDO (JSON válido) mas sem o bloco `empresas` (ausente, vazio, null, tipo
// errado) é regra violada, não "ilegível" — tem que ser ContratoInvalidoError, senão o
// catch de config/empresas.js confunde os dois e cai no modo antigo, que ignora EMPRESAS
// e sobe todas as lojas conhecidas (Codex, P1 r2)
function comContratoCru(objCru) {
  const arq = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'contr-')), 'c.json');
  fs.writeFileSync(arq, JSON.stringify(objCru));
  return () => carregar({ caminho: arq, servico: 'mover-pedidos' });
}
for (const semEmpresas of [{}, { empresas: {} }, { empresas: null }, { empresas: [] }, 'nao-e-objeto']) {
  let erro;
  try { comContratoCru(semEmpresas)(); } catch (e) { erro = e; }
  assert.ok(erro instanceof ContratoInvalidoError,
    'contrato sem o bloco `empresas` (' + JSON.stringify(semEmpresas) + ') tem que ser ContratoInvalidoError — veio ' + (erro && erro.constructor.name));
}

// 4b) `capacidades` é OBRIGATÓRIA (Codex, P2) — ausente, ou de outro tipo, tem que explodir,
// não virar null silencioso em temCapacidade() pra uma empresa que esqueceu de declarar
assert.throws(comContrato({ a: { id_canonico: 'a', slug_http: '/a', sufixo_tabelas: '_a' } }),
  /não declara `capacidades`/, 'empresa sem `capacidades` tem que explodir, não herdar null');
assert.throws(comContrato({ a: { id_canonico: 'a', slug_http: '/a', sufixo_tabelas: '_a', capacidades: 'fiscal' } }),
  /não declara `capacidades`/, 'capacidades que não é lista tem que explodir');

// 5) QUARTA empresa só com dado — o critério de sucesso da auditoria
const quarta = comContrato({
  ambtotal: { id_canonico: 'ambtotal', aliases: ['amb'], slug_http: '/amb', prefixo_env: 'AMB_', sufixo_tabelas: '_amb', capacidades: [] },
  nova: { id_canonico: 'nova', aliases: ['nv'], slug_http: '/nova', prefixo_env: 'NOVA_', sufixo_tabelas: '_nova', capacidades: [] },
})();
assert.strictEqual(quarta.normalizar('nv'), 'nova', 'a empresa nova existe sem uma linha de código novo');
assert.strictEqual(quarta.nomeEnv('nova', 'BLING_CLIENT_ID'), 'NOVA_BLING_CLIENT_ID');
assert.strictEqual(quarta.obter('nova').sufixoTabelas, '_nova');
assert.deepStrictEqual(quarta.ativas().map(e => e.id).sort(), ['ambtotal', 'nova']);

// e a env de ativação é FILTRO, não cadastro
const so1 = carregar({ servico: 'mover-pedidos', ativas: 'amb' });
assert.deepStrictEqual(so1.ativas().map(e => e.id), ['ambtotal']);
assert.throws(() => carregar({ servico: 'mover-pedidos', ativas: 'amb,fantasma' }).ativas(),
  /não está no contrato/, 'env não pode inventar empresa');

console.log('OK: registro canônico — alias de borda vira id canônico, prefixo por serviço (vazio inclusive), fachada intacta, colisões falham alto e a 4ª empresa nasce só de dado');
