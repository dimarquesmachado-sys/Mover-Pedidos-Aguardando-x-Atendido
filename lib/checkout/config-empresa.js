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
  },
  ambtotal: {
    tag: 'AMBBKP', modulo: 'amb-checkout-offline', mlTokenManager: 'ambtotal/mlTokenManager', loja: 'amb',
    vendasDia: {
      shopeeUrl:  { envs: ['AMBBKP_SHOPEE_SYNC_URL'] },   /* a AMB nunca caiu na SHOPEE_SYNC_URL aqui */
    },
  },
  good: {
    tag: 'GOODBKP', modulo: 'good-checkout-offline', mlTokenManager: 'good/mlTokenManager',
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
  /* a regra é lida NA HORA (env muda no Render ⇒ reinício; testes trocam process.env) */
  const ler = (regra) => { for (const n of regra.envs || []) { const v = process.env[n]; if (v) return v; } return regra.padrao; };
  return {
    id, loja, prefixoEnv: pref,
    tag: h.tag || (base + 'BKP'),
    modulo: h.modulo || (loja + '-checkout-offline'),
    mlTokenManager: h.mlTokenManager || (id + '/mlTokenManager'),   /* relativo à raiz do repo */
    tiktokConta: h.tiktokConta || loja,
    vendasDia: vd,
    ler,
  };
}

module.exports = { configCheckout, URL_SHOPEE_PADRAO, HISTORICO };
