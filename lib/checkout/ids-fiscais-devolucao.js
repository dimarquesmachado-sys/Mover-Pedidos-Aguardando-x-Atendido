'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   OS DOIS IDS FISCAIS DA NF DE DEVOLUÇÃO, POR EMPRESA (27/11/2026, pedido do dono).

   A Toolbox emite a NF de devolução pela tela do Bling e precisa de dois números da empresa: a natureza de operação
   ("Devolução de mercadoria — entrada") e o id interno da empresa no Bling. Eles viviam só no serviço do Devoluções, que
   só responde com login no painel dele — e no checkout o "Gerar devolução (Toolbox)" parava em "sessao invalida ou
   expirada". O dono: "pq logando no checkout não serve? faça com q não precise ter q logar lá no devoluções."

   Agora o checkout entrega os dois, lidos das variáveis DESTE serviço — com o MESMO NOME que elas têm no Devoluções
   (pedido dele: "não é melhor deixar o mm nome no devoluções e no mover-pedidos?"):
       <PREFIXO>ID_EMPRESA_CONTROL              (o id da empresa; a API do Bling não entrega — vem da tela dele)
       <PREFIXO>ID_NATUREZA_DEVOLUCAO_ENTRADA   (a natureza usada pra EMITIR a devolução)
   PREFIXO: GIRASSOL_, GOOD_, AMB_ — e, pra empresa nova, o nome dela em maiúsculas + "_".
   ⚠️ NÃO é <PREFIXO>NATUREZAS_DEVOLUCAO_IDS: essa é a lista que o Devoluções usa pra RECONHECER notas de devolução e
   pode ter mais de um número.

   Só vale o PAR completo, e só número com cara de id: faltando um, ou torto, devolve null — e a Toolbox segue pelo
   caminho de sempre (o servidor do Devoluções, ou o que ela guardou dele). Número errado aqui é nota na empresa ou na
   natureza erradas; por isso nada é adivinhado nem tem padrão no código.
   ───────────────────────────────────────────────────────────────────────────── */
const PREFIXOS = { girassol: 'GIRASSOL_', good: 'GOOD_', amb: 'AMB_', ambtotal: 'AMB_' };
const ID = /^\d{4,20}$/;

function prefixoDe(empresa) {
  const e = String(empresa || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9]{1,30}$/.test(e)) return null;
  return PREFIXOS[e] || (e.toUpperCase() + '_');
}

/* { idNaturezaOperacao, idEmpresaControl } ou null */
function idsFiscaisDevolucao(empresa, env) {
  const pref = prefixoDe(empresa);
  if (!pref) return null;
  const amb = env || process.env;
  const emp = String(amb[pref + 'ID_EMPRESA_CONTROL'] || '').trim();
  const nat = String(amb[pref + 'ID_NATUREZA_DEVOLUCAO_ENTRADA'] || '').trim();
  if (!ID.test(emp) || !ID.test(nat)) return null;
  return { idNaturezaOperacao: nat, idEmpresaControl: emp };
}

module.exports = { idsFiscaisDevolucao, prefixoDe };
