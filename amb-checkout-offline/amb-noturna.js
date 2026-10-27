'use strict';
// amb-noturna.js -- a rotina da madrugada: a MADRUGADA ÚNICA lib/checkout/noturna-empresa (26/10/2026: era cópia na
// Girassol e na AMB, com as etapas em ordens diferentes). Aqui só a empresa e o prefixo das rotas; as peças vêm do contexto.
const { criarNoturna: _criar } = require('../lib/checkout/noturna-empresa');
function criarNoturna(ctx) { return _criar(Object.assign({}, ctx, { empresa: 'amb', prefixo: '/amb-checkout-offline' })); }
module.exports = { criarNoturna };
