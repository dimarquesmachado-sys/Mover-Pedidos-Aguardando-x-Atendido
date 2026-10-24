'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   CONFIGURAÇÃO DO CHECKOUT POR EMPRESA (19/10/2026) — Fase 3 do plano multiloja ("estrangular o checkout").

   O dono: "tem que ir fazendo lib multiempresa... assim não rola" (ligar CNPJ novo no checkout não pode ser copiar a
   pasta e ajustar). Até aqui, cada pasta de checkout escrevia À MÃO o que é dela pra cada peça compartilhada — que env
   ler, que loja da Shopee, que empresa na Magalu, que conta do TikTok, que gerenciador de token do ML. Agora isso sai
   DAQUI, do mesmo jeito que o fiscal já faz (lib/empresas/registro + montar-empresa):
     · empresa NOVA não escreve nada: segue a CONVENÇÃO — envs <PREFIXO>BKP_X (prefixo do contrato) caindo na X sem
       prefixo e depois no padrão; lojas (Shopee, Magalu, TikTok) = o id canônico; token do ML = <id>/mlTokenManager;
     · as três antigas têm nomes HISTÓRICOS (a Girassol nasceu sem prefixo, a AMB lê a URL da Shopee só com prefixo...)
       e declaram as EXCEÇÕES abaixo — exatamente o que cada pasta fazia, conferido linha a linha pelo teste
       (scripts/teste-config-empresa-checkout.js): mudar uma exceção muda o comportamento, então ela é dado, não gosto.
   ───────────────────────────────────────────────────────────────────────────── */

const URL_SHOPEE_PADRAO = 'https://girassol-shopee-sync-organizar-envio.onrender.com';

/* id canônico → o que difere da convenção (só o que difere) */
const HISTORICO = {
  girassol: {
    tag: 'GIRABKP', modulo: 'girassol-backup-offline', mlTokenManager: 'girassol/mlTokenManager',
    vendasDia: {
      magEmpresa: { envs: ['MAGALU_EMPRESA'] },
      shopeeUrl:  { envs: ['SHOPEE_SYNC_URL'] },
      shopeeKey:  { envs: ['SHOPEE_SYNC_KEY'] },
      shopeeLoja: { envs: [] },
    },
    /* a varredura de cancelados da Girassol sempre leu com o prefixo GBO_ (e cai na sem prefixo nas compartilhadas) */
    /* 21/10: o canário da Girassol sempre perguntou à Shopee só com a SHOPEE_SYNC_KEY; e só ela tem o importador do ML
       que o conserto do canário usa pra reimportar a venda que não chegou (girassol/importarPedido) */
    canario: { shopeeKey: { envs: ['SHOPEE_SYNC_KEY'] } },
    importarPedido: 'girassol/importarPedido',
    /* 22/10: a OLIST (encerrada por volta de abr/mai-2026) — o Bling não guarda a taxa nem o frete dela. A Girassol
       vendia por ela: ~22% sobre os produtos (do Jodda) e motoboy R$ 12/pedido (o dono). Loja dela no Bling: 203301094 */
    olist: { taxaPct: 22, freteReais: 12, lojaBling: '203301094' },
    cancelados: {
      shopeeUrl:  { envs: ['GBO_SHOPEE_SYNC_URL', 'SHOPEE_SYNC_URL'] },
      shopeeKey:  { envs: ['GBO_SHOPEE_SYNC_KEY', 'SHOPEE_SYNC_KEY'] },
      shopeeLoja: { envs: ['GBO_SHOPEE_SYNC_LOJA'] },
    },
  },
  ambtotal: {
    tag: 'AMBBKP', modulo: 'amb-checkout-offline', mlTokenManager: 'ambtotal/mlTokenManager', loja: 'amb',
    /* 24/10: a AMB COMEÇOU A VENDER em 09/04/2026 (o dono) — antes disso não há venda a buscar; a saúde dos dados
       (/embarque/dados) e o plano do ano contam o "começo" daqui, não de 1º de janeiro */
    inicioVendas: '2026-04-09',
    vendasDia: {
      shopeeUrl:  { envs: ['AMBBKP_SHOPEE_SYNC_URL'] },   /* a AMB nunca caiu na SHOPEE_SYNC_URL aqui */
    },
  },
  good: {
    tag: 'GOODBKP', modulo: 'good-checkout-offline', mlTokenManager: 'good/mlTokenManager',
    /* 22/10: a GOOD também vendeu pela OLIST (o dono) — mesmo acordo da Girassol; o pedido é reconhecido pelo nº na
       loja começando com "ORD" (a loja da Olist no Bling da GOOD não é a da Girassol) */
    olist: { taxaPct: 22, freteReais: 12, lojaBling: null },
  },
};

function _registro() { return require('../empresas/registro').carregar({ servico: 'mover-pedidos' }); }

/* devolve a configuração do checkout da empresa (aceita alias: amb → ambtotal) */
function configCheckout(empresa, opts) {
  const reg = (opts && opts.registro) || _registro();   /* opts.registro: só pros testes simularem uma empresa nova */
  const id = String(reg.normalizar(String(empresa || '').trim().toLowerCase()) || '').toLowerCase();
  const e = reg.obter(id);
  if (!e) throw new Error('lib/checkout/config-empresa: empresa desconhecida no contrato: ' + empresa);
  const h = HISTORICO[id] || {};
  const base = String(e.prefixoEnv || (id.toUpperCase() + '_')).replace(/_+$/, '');
  const pref = (base || id.toUpperCase()) + 'BKP_';                 /* GOOD_ → GOODBKP_ · AMB_ → AMBBKP_ */
  const loja = h.loja || id;                                         /* a loja nos serviços (Shopee multi-loja, Magalu, TikTok) */
  /* ⚠️ duas famílias de env, de propósito:
     · DA EMPRESA (qual loja, qual empresa na Magalu): SÓ o nome com prefixo, depois o padrão. O nome SEM prefixo é da
       Girassol (ela nasceu sem prefixo) — cair nele faria a AMB/GOOD/empresa nova usar a loja da Girassol;
     · COMPARTILHADA (o serviço da Shopee é um só, multi-loja: URL e chave): com prefixo, depois sem prefixo, depois o padrão. */
  const daEmpresa = (nome, padrao) => ({ envs: [pref + nome], padrao });
  const compartilhada = (nome, padrao) => ({ envs: [pref + nome, nome], padrao });
  const vd = {
    magEmpresa: daEmpresa('MAGALU_EMPRESA', loja),
    shopeeUrl:  compartilhada('SHOPEE_SYNC_URL', URL_SHOPEE_PADRAO),
    shopeeKey:  compartilhada('SHOPEE_SYNC_KEY', ''),
    shopeeLoja: daEmpresa('SHOPEE_SYNC_LOJA', loja),
  };
  for (const [k, v] of Object.entries(h.vendasDia || {})) vd[k] = Object.assign({}, vd[k], v);   /* exceção troca só as envs */
  /* 19/10: a varredura de cancelados pergunta à Shopee o que ela cancelou — mesma convenção, exceções próprias */
  const cc = {
    shopeeUrl:  compartilhada('SHOPEE_SYNC_URL', URL_SHOPEE_PADRAO),
    shopeeKey:  compartilhada('SHOPEE_SYNC_KEY', ''),
    shopeeLoja: daEmpresa('SHOPEE_SYNC_LOJA', loja),
  };
  for (const [k, v] of Object.entries(h.cancelados || {})) cc[k] = Object.assign({}, cc[k], v);
  /* 21/10: o CANÁRIO (marketplace × Bling) pergunta à Shopee quais pedidos ela tem — a chave pela convenção (a da
     empresa, senão a compartilhada); a Girassol tem a exceção histórica (só a sem prefixo) */
  const can = { shopeeKey: compartilhada('SHOPEE_SYNC_KEY', '') };
  for (const [k, v] of Object.entries(h.canario || {})) can[k] = Object.assign({}, can[k], v);
  /* a regra é lida NA HORA (env muda no Render ⇒ reinício; testes trocam process.env) */
  const ler = (regra) => { for (const n of regra.envs || []) { const v = process.env[n]; if (v) return v; } return regra.padrao; };
  return {
    id, loja, prefixoEnv: pref,
    tag: h.tag || (base + 'BKP'),
    modulo: h.modulo || (loja + '-checkout-offline'),
    mlTokenManager: h.mlTokenManager || (id + '/mlTokenManager'),   /* relativo à raiz do repo */
    tiktokConta: h.tiktokConta || loja,
    vendasDia: vd,
    cancelados: cc,
    canario: can,
    /* módulo que reimporta a venda do ML que não chegou ao Bling (relativo à raiz do repo); null = esta empresa ainda
       não tem — o conserto do canário só avisa */
    importarPedido: h.importarPedido || null,
    /* 22/10: OLIST — só quem vendeu por ela (Girassol e GOOD). A AMB e empresa nova: null (a Olist encerrou) — sem isso,
       um pedido de outro canal com nº começando em "ORD" levaria 22% e R$ 12 inventados */
    olist: h.olist || null,
    /* 24/10: a data em que a empresa começou a vender (null = antes do ano corrente / desde sempre) */
    inicioVendas: h.inicioVendas || null,
    ler,
  };
}

module.exports = { configCheckout, URL_SHOPEE_PADRAO, HISTORICO };
