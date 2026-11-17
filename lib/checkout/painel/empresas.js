'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   O PAINEL DE CADA EMPRESA NUM LUGAR SÓ (21/10/2026, tela única — passo final).

   As três empresas saem da MESMA tela (lib/checkout/painel/dashboard.html) pelo gerador (dashboard-modelo). Aqui fica
   o que muda de uma pra outra: nome, logo, ícones, link do Magalu, selo da versão e as CAPACIDADES (o que o backend
   da empresa tem — o que não tem vira aviso honesto ou some). As alíquotas de fábrica NÃO ficam aqui: vêm do backend
   de cada empresa na hora (o MESMO DEFAULT_ALIQ_BK que o servidor usa no cálculo).

   Empresa nova: uma entrada aqui + a rota /dashboard chamando painelDaEmpresa.
   ───────────────────────────────────────────────────────────────────────────── */

/* 16/11 — FASE 4 (docs/plano-multiloja-passos.md): recurso do painel some ou aparece por CAPACIDADE DO CONTRATO, nunca por nome
   de empresa. O resumo da Shopee e o frete da Magalu são lidos do contrato (lib/empresas/registro: 'shopee', 'magalu') — as três
   têm os dois, então hoje nada muda na tela; a quarta empresa sai certa só pelo contrato dela. `vendasSync` e `canario` são
   recursos do checkout (todas têm) e ficam ligados. O que a empresa declara aqui por cima ganha (`manifesto`, `projecaoMes`…). */
const PAINEL_EMPRESA = {
  /* a AMB é o próprio modelo: sem troca de identidade, só as capacidades */
  ambtotal: { prefixo: '/amb-checkout-offline', identidadeDoModelo: true },   /* 23/10: a AMB ganhou /canario-estado */
  /* a Girassol tinha cópia própria da tela (até 21/10): mesmo nome, mesmo logo (girassol com fundo amarelo), mesmo
     ícone da aba (PNG) e o ícone do atalho servido pela rota dela (/girassol-backup-offline/icone.png) */
  girassol: { prefixo: '/girassol-backup-offline', nome: 'Girassol', slugMagalu: 'girassol', logoEmoji: '🌻', selo: 'GI',
    logoFundo: 'linear-gradient(135deg,#fbbf24,#f59e0b)', favicon: () => require('./icone-girassol').FAVICON, appleIcone: 'icone.png' },
  /* Codex #695: o que a GOOD ainda não tem vira aviso na tela; a projeção do mês dela continua.
     19/10: a venda do dia (#714) e o ⚙️ do frete Magalu (Codex #715) já existem na GOOD — ligados. O resumo da Shopee
     segue desligado (a GOOD não tem o módulo Shopee). */
  good: { prefixo: '/good-checkout-offline', nome: 'GOOD Import', slugMagalu: 'good', aliqPadrao: 15, logoEmoji: '📦', selo: 'G',
    manifesto: false, projecaoMes: true },   /* 23/10: canário · 27/10: o resumo da Shopee (a GOOD ganhou o módulo) */
};

/* 17/11 (montarCheckout, passo 16): o APP da empresa (PWA: o ícone de 128px e o manifesto do atalho no celular, servidos por
   lib/checkout/rotas-pwa). Era escrito à mão no arquivo de entrada da Girassol e da AMB (o nome, o nome curto, a descrição e o
   ícone em base64 de ~30 KB). A GOOD não tem ícone PNG (o painel dela anuncia `manifesto: false`): sem entrada aqui, a
   empresa não monta a peça — quando tiver o ícone, é uma entrada aqui. */
const PWA_EMPRESA = {
  girassol: { nome: 'Intelig\u00eancia de Vendas \u00b7 Girassol', shortName: 'Girassol',
    descricao: 'Faturamento, margem, previs\u00e3o de vendas e plano de compra da Magazine Girassol', icone: () => require('./icone-girassol').PWA },
  ambtotal: { nome: 'Intelig\u00eancia de Vendas \u00b7 AMBTotal', shortName: 'AMBTotal',
    descricao: 'Faturamento, margem, previs\u00e3o de vendas e plano de compra da AMBTotal', icone: () => require('./icone-ambtotal').PWA },
};

/* as capacidades do painel, a partir do CONTRATO da empresa (id do painel = id canônico do contrato) */
function capacidadesDoContrato(id, registro) {
  const reg = registro || require('../../empresas/registro').carregar({ servico: 'mover-pedidos' });
  const tem = (c) => reg.temCapacidade(id, c) === true;
  return { vendasSync: true, canario: true, shopeeResumo: tem('shopee'), freteMagalu: tem('magalu') };
}

function painelDaEmpresa(id, extra) {
  const base = PAINEL_EMPRESA[id];
  if (!base) throw new Error('painelDaEmpresa: empresa sem painel configurado: ' + id);
  const cfg = Object.assign({}, base, extra || {});
  /* Fase 4: as capacidades vêm do contrato; o que vier por `extra.capacidades` (um teste, um ajuste pontual) ganha por cima */
  cfg.capacidades = Object.assign(capacidadesDoContrato(id, extra && extra.registro), (extra && extra.capacidades) || {});
  delete cfg.registro;
  if (typeof cfg.favicon === 'function') cfg.favicon = cfg.favicon();
  return require('../dashboard-modelo').gerarPainel(cfg);
}

module.exports = { PAINEL_EMPRESA, PWA_EMPRESA, painelDaEmpresa, capacidadesDoContrato };
