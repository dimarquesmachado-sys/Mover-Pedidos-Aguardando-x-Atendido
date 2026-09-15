'use strict';

/* 14/09 — FACHADA. As ~1.000 linhas deste arquivo foram pra lib/checkout/historico.js, que é
   a MESMA lógica que a AMB tinha cravada — e a peça que faltava inteira na GOOD (por isso ela
   não tem dashboard de vendas).
   Aqui fica o contexto DESTA empresa. Nada de fallback: na lib, dependência ausente derruba
   no boot em vez de herdar em silêncio o cache, o admin ou o cliente Bling de outra empresa —
   que foi o bug do Codex #197 registrado na versão anterior deste arquivo. */

const base = require('./base');

function rotasHistorico(ctx) {
  return require('../lib/checkout/historico').rotasHistorico(Object.assign({
    empresa: 'girassol',
    modulo: 'girassol-backup-offline',
    CACHE_DIR: base.CACHE_DIR,
    CONFERIDOS_FILE: base.CONFERIDOS_FILE,
    PAUSA_MS: base.PAUSA_MS,
    readJson: base.readJson,
    writeJson: base.writeJson,
    ehAdmin: base.ehAdmin,
    blingGet: base.blingGet,
    sleep: base.sleep,
    json: base.json,
    nfDoPedido: require('./nf').nfDoPedido,
    detalhePedido: require('./ciclo').detalhePedido,
  }, ctx || {}));
}

module.exports = { rotasHistorico };
