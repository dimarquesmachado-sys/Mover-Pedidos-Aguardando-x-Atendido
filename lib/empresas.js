'use strict';

/**
 * lib/empresas.js — a lista de empresas em UM lugar, vinda de env (30/08).
 *
 * O dono perguntou: "se eu tivesse que ligar uma 4ª empresa hoje, como seria?". Testei em
 * vez de responder de cabeça, e a resposta era ruim: a empresa está FIXA em quatro lugares
 * diferentes (EMPRESAS_VALIDAS do magalu-oauth, o mapa de envs do Bling, a lista do
 * canário de módulos e o default do TIKTOK_LOJAS). Ligar uma loja nova exigiria mexer em
 * código — exatamente o que ele quer evitar.
 *
 * Agora a lista sai de EMPRESAS (env), com as três atuais como padrão pra nada quebrar.
 * O nome da empresa vira a chave de tudo: as envs seguem o padrão <EMPRESA>_ALGO, e quem
 * precisa de exceção (as três antigas têm nomes históricos) declara no mapa de compat.
 */

/* nomes históricos: a Girassol nasceu sem prefixo e a AMB usa AMB_, não AMBTOTAL_ */
const COMPAT_BLING = { girassol: 'BLING_CLIENT_ID', good: 'GOOD_BLING_CLIENT_ID', amb: 'AMB_BLING_CLIENT_ID' };

function lista() {
  return String(process.env.EMPRESAS || 'girassol,good,amb')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function valida(empresa) {
  return lista().indexOf(String(empresa || '').toLowerCase().trim()) >= 0;
}

/** Nome da env do Bling daquela empresa — compat pros nomes antigos, padrão pros novos. */
function envBling(empresa) {
  const e = String(empresa || '').toLowerCase().trim();
  return COMPAT_BLING[e] || (e.toUpperCase() + '_BLING_CLIENT_ID');
}

/** Nome do seller no Magalu; empresa nova declara em <EMPRESA>_MAGALU_SELLER. */
function sellerMagalu(empresa) {
  const e = String(empresa || '').toLowerCase().trim();
  const fixos = { girassol: 'magazinegirassol', amb: 'ambtotal', good: 'goodimport-magazine' };
  return process.env[e.toUpperCase() + '_MAGALU_SELLER'] || fixos[e] || e;
}

module.exports = { lista, valida, envBling, sellerMagalu };
