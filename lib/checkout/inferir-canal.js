'use strict';

/* 19/10 — de que marketplace é um pedido, pelo NÚMERO DO PEDIDO NA LOJA (numero_loja). Mesma regra que a AMB e a Girassol
   usam na venda do dia (era uma função solta em cada checkout); nasce aqui pra GOOD não ganhar mais uma cópia.
     com hífen → amazon · com letra → shopee · 200… → ml · 585… → tiktok · 15… → magalu · resto → outro */
function inferirCanal(nl) {
  const s = String(nl || '');
  if (!s) return 'outro';
  if (s.indexOf('-') >= 0) return 'amazon';
  if (/[a-z]/i.test(s)) return 'shopee';
  if (/^200/.test(s)) return 'ml';
  if (/^585/.test(s)) return 'tiktok';
  if (/^15/.test(s)) return 'magalu';
  return 'outro';
}

module.exports = { inferirCanal };
