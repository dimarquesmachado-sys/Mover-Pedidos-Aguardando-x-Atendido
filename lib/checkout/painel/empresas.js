'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   O PAINEL DE CADA EMPRESA NUM LUGAR SÓ (21/10/2026, tela única — passo final).

   As três empresas saem da MESMA tela (lib/checkout/painel/dashboard.html) pelo gerador (dashboard-modelo). Aqui fica
   o que muda de uma pra outra: nome, logo, ícones, link do Magalu, selo da versão e as CAPACIDADES (o que o backend
   da empresa tem — o que não tem vira aviso honesto ou some). As alíquotas de fábrica NÃO ficam aqui: vêm do backend
   de cada empresa na hora (o MESMO DEFAULT_ALIQ_BK que o servidor usa no cálculo).

   Empresa nova: uma entrada aqui + a rota /dashboard chamando painelDaEmpresa.
   ───────────────────────────────────────────────────────────────────────────── */

const PAINEL_EMPRESA = {
  /* a AMB é o próprio modelo: sem troca de identidade, só as capacidades */
  ambtotal: { prefixo: '/amb-checkout-offline', identidadeDoModelo: true,
    capacidades: { vendasSync: true, shopeeResumo: true, freteMagalu: true, canario: true } },   /* 23/10: a AMB ganhou /canario-estado */
  /* a Girassol tinha cópia própria da tela (até 21/10): mesmo nome, mesmo logo (girassol com fundo amarelo), mesmo
     ícone da aba (PNG) e o ícone do atalho servido pela rota dela (/girassol-backup-offline/icone.png) */
  girassol: { prefixo: '/girassol-backup-offline', nome: 'Girassol', slugMagalu: 'girassol', logoEmoji: '🌻', selo: 'GI',
    logoFundo: 'linear-gradient(135deg,#fbbf24,#f59e0b)', favicon: () => require('./icone-girassol').FAVICON, appleIcone: 'icone.png',
    capacidades: { vendasSync: true, shopeeResumo: true, freteMagalu: true, canario: true } },
  /* Codex #695: o que a GOOD ainda não tem vira aviso na tela; a projeção do mês dela continua.
     19/10: a venda do dia (#714) e o ⚙️ do frete Magalu (Codex #715) já existem na GOOD — ligados. O resumo da Shopee
     segue desligado (a GOOD não tem o módulo Shopee). */
  good: { prefixo: '/good-checkout-offline', nome: 'GOOD Import', slugMagalu: 'good', aliqPadrao: 15, logoEmoji: '📦', selo: 'G',
    capacidades: { vendasSync: true, shopeeResumo: true, freteMagalu: true, canario: true }, manifesto: false, projecaoMes: true },   /* 23/10: canário · 27/10: o resumo da Shopee (a GOOD ganhou o módulo) */
};

function painelDaEmpresa(id, extra) {
  const base = PAINEL_EMPRESA[id];
  if (!base) throw new Error('painelDaEmpresa: empresa sem painel configurado: ' + id);
  const cfg = Object.assign({}, base, extra || {});
  if (typeof cfg.favicon === 'function') cfg.favicon = cfg.favicon();
  return require('../dashboard-modelo').gerarPainel(cfg);
}

module.exports = { PAINEL_EMPRESA, painelDaEmpresa };
