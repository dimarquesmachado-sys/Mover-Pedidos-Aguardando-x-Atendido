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

/* 13/09 — ESTE ARQUIVO VIROU FACHADA. A auditoria multiloja apontou o problema de raiz:
   a identidade de empresa tinha três fontes (o contrato, este mapa e config/empresas.js),
   com semânticas incompatíveis — o contrato diz que o id é `ambtotal` e `amb` é alias de
   borda; aqui `amb` era chave. Resultado: uma parte aceitava loja que a outra recusava, e
   adicionar empresa ao contrato ainda exigia lembrar de editar JavaScript.
   Agora quem responde é lib/empresas/registro.js, lendo o contrato. As funções abaixo
   continuam com a MESMA assinatura e o MESMO retorno (conferido nas três empresas) — é o
   que a auditoria pede: fachada durante a migração, sem tocar em fluxo de produção. */
const _registro = (() => {
  try { return require('./empresas/registro').carregar({ servico: 'mover-pedidos' }); }
  catch (e) { console.warn('[empresas] contrato indisponível (' + (e.message || e) + ') — caindo no mapa histórico'); return null; }
})();

/* nomes históricos: a Girassol nasceu sem prefixo e a AMB usa AMB_, não AMBTOTAL_.
   Mantido como REDE (contrato ilegível no boot não pode derrubar o serviço) e porque o
   teste de espelho usa este mapa pra montar o registro potencial sem depender da env. */
const COMPAT_BLING = { girassol: 'BLING_CLIENT_ID', good: 'GOOD_BLING_CLIENT_ID', amb: 'AMB_BLING_CLIENT_ID' };

function lista() {
  return String(process.env.EMPRESAS || 'girassol,good,amb')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/* 13/09 (auditoria do Codex, P1) — `valida` passa a aceitar ALIAS ou ID CANÔNICO. Antes ela
   comparava só com a lista da env: quem chamasse com 'ambtotal' (o id do contrato) levava
   "empresa inválida", e quem chamasse com 'amb' passava — a mesma loja com dois destinos
   conforme o nome usado. Agora o registro normaliza os dois lados antes de comparar. */
function valida(empresa) {
  const bruto = String(empresa || '').toLowerCase().trim();
  if (!bruto) return false;
  const ativas = lista();
  if (ativas.indexOf(bruto) >= 0) return true;
  if (!_registro) return false;
  const canon = _registro.normalizar(bruto);
  if (!canon) return false;
  return ativas.some(a => _registro.normalizar(a) === canon);
}

/* A lista de ids CANÔNICOS das lojas ativas — é o que código novo deve usar pra nomear
   cache, tabela e métrica. `lista()` continua devolvendo o que sempre devolveu porque há
   estado gravado com esses nomes: o Magalu, por exemplo, guarda o token em
   /data/<empresa>.json usando exatamente a string que recebe. Trocar aquilo aqui não seria
   refatoração, seria perder o token da empresa. */
function listaCanonica() {
  const ativas = lista();
  if (!_registro) return ativas.slice();
  const vistos = new Set();
  const out = [];
  for (const a of ativas) {
    const id = _registro.normalizar(a) || a;
    if (!vistos.has(id)) { vistos.add(id); out.push(id); }
  }
  return out;
}

/** Nome da env do Bling daquela empresa — compat pros nomes antigos, padrão pros novos. */
function envBling(empresa) {
  const e = String(empresa || '').toLowerCase().trim();
  if (_registro) {
    const nome = _registro.nomeEnv(e, 'BLING_CLIENT_ID');
    if (nome) return nome;
  }
  return COMPAT_BLING[e] || (e.toUpperCase() + '_BLING_CLIENT_ID');
}

/** Id canônico da empresa (o contrato manda): 'amb' e '/amb' devolvem 'ambtotal'. Útil
    pra quem grava cache/tabela — a auditoria pede id canônico por dentro, alias só na borda. */
function canonico(empresa) {
  return _registro ? _registro.normalizar(empresa) : null;
}

/** Nome do seller no Magalu; empresa nova declara em <EMPRESA>_MAGALU_SELLER. */
function sellerMagalu(empresa) {
  const e = String(empresa || '').toLowerCase().trim();
  const fixos = { girassol: 'magazinegirassol', amb: 'ambtotal', good: 'goodimport-magazine' };
  return process.env[e.toUpperCase() + '_MAGALU_SELLER'] || fixos[e] || e;
}

/* 08/09 (contrato de empresas): COMPAT_BLING exportado SÓ LEITURA — é a lista dos
   aliases que este repo realmente conhece, e o teste espelho a usa pra montar o
   registro potencial sem depender da env de ativação (o CI roda sem EMPRESAS). */
module.exports = { lista, listaCanonica, valida, envBling, sellerMagalu, canonico, COMPAT_BLING };
