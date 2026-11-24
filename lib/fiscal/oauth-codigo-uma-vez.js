'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   OAUTH — O CÓDIGO DE AUTORIZAÇÃO VAI AO BLING UMA VEZ SÓ (24/11/2026).

   O caso: o dono reautorizou o app do Bling da AMB pelo celular (permissão nova de Pedidos de Compra). A tela mostrou
   "✅ Token Bling obtido", o token foi gravado — e em minutos (uma vez, em 23 segundos) o Bling passou a recusá-lo, e a
   recusar também a renovação. Três autorizações seguidas, o mesmo fim.

   A página do callback ficava com o CÓDIGO no endereço (`/callback?code=...`) e, a cada carga, mandava o código ao
   Bling de novo: recarregar a aba (o navegador do celular recarrega sozinho ao voltar pra ela), o botão voltar, um
   pré-carregamento. Código de autorização usado duas vezes é, pelo protocolo (RFC 6749, 4.1.2), motivo pra o servidor
   negar E revogar os tokens que nasceram daquele código.

   Esta peça garante, sem tocar em rede nem em disco:

   criarCodigoUmaVez({ trocar, agora?, validadeMs?, maximo? }) → { tratar, recibo }
       tratar(codigo) → Promise<{ ok, recibo, erro, repetido }>
           A PRIMEIRA vez que um código aparece, chama `trocar(codigo)` (a troca de verdade, no Bling). Toda vez
           seguinte com o MESMO código — durante a troca ou depois dela, tenha dado certo ou errado — devolve o
           resultado da primeira, sem chamar `trocar` de novo. Código que falhou também não é reenviado: se o Bling
           chegou a processá-lo e a resposta se perdeu, reenviar derrubaria o token; o caminho é autorizar de novo
           (código novo).
       recibo(r) → true se `r` é o recibo de uma troca que deu certo há pouco (a página de "feito", sem código no
           endereço, pode ser recarregada à vontade).
   O código nunca é guardado: só o SHA-256 dele. Memória curta (15 min, 50 códigos) — basta pra aba recarregada; depois
   de reinício do servidor um código velho já expirou no Bling (vale 1 minuto) e a troca só falha, sem token pra perder.
   ───────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');

function criarCodigoUmaVez(cfg) {
  if (!cfg || typeof cfg.trocar !== 'function') throw new Error('oauth-codigo-uma-vez: falta `trocar`');
  const agora = typeof cfg.agora === 'function' ? cfg.agora : Date.now;
  const validadeMs = Number(cfg.validadeMs) > 0 ? Number(cfg.validadeMs) : 15 * 60 * 1000;
  const maximo = Number(cfg.maximo) > 0 ? Number(cfg.maximo) : 50;
  const vistos = new Map();   /* sha256(código) → { promessa, ts, recibo } */

  function podar() {
    const t = agora();
    for (const [k, v] of vistos) if (t - v.ts > validadeMs) vistos.delete(k);
    while (vistos.size > maximo) vistos.delete(vistos.keys().next().value);   /* o mais antigo sai primeiro */
  }

  function tratar(codigo) {
    const c = String(codigo == null ? '' : codigo);
    if (!c) return Promise.resolve({ ok: false, recibo: null, erro: 'código de autorização ausente', repetido: false });
    podar();
    const chave = crypto.createHash('sha256').update(c).digest('hex');
    const ja = vistos.get(chave);
    if (ja) return ja.promessa.then((r) => Object.assign({}, r, { repetido: true }));
    const reg = { ts: agora(), recibo: null, promessa: null };   /* o recibo só nasce se a troca der certo */
    reg.promessa = Promise.resolve().then(() => cfg.trocar(c)).then(
      () => { reg.recibo = crypto.randomBytes(9).toString('hex'); return { ok: true, recibo: reg.recibo, erro: null, repetido: false }; },
      (e) => ({ ok: false, recibo: null, erro: String((e && e.message) || e), repetido: false }));
    vistos.set(chave, reg);
    podar();
    return reg.promessa;
  }

  function recibo(r) {
    const s = String(r == null ? '' : r);
    if (!s) return false;
    podar();
    for (const v of vistos.values()) if (v.recibo && v.recibo === s) return true;
    return false;
  }

  return { tratar, recibo };
}

module.exports = { criarCodigoUmaVez };
