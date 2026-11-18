'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   O /backfill-status DA EMPRESA — peça única (17/11/2026, norte C, `montarCheckout`, passo 21).

   Era a última rota própria escrita nos três arquivos de entrada: a mesma trava (chave OU sessão de admin; sem as duas, 404
   — rota de diagnóstico não confirma que existe pra quem não tem credencial) e o prefixo escrito à mão. O que cada uma
   MOSTRA continua sendo dela:
     · Girassol e AMB: `{ ok, status, plano }` — o andamento do backfill no registro por empresa (lib/checkout/backfill-estado,
       o MESMO objeto que o motor e o painel leem) e o plano em fatias;
     · GOOD: o que ela já mostrava (o estado da última rodada dela — manual, do plano, da rotina diária ou do repasse —, o
       progresso vivo e a rotina diária), que entra por `extras`; e ela GANHA o `ok` e o `status` do registro, como as
       outras duas (nivelar por cima: nada do que ela mostrava sai).
   O que vem da empresa é a empresa (o prefixo sai do contrato), o plano dela e, se tiver, os `extras`.
   ───────────────────────────────────────────────────────────────────────────── */

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rota-backfill-status: falta empresa');
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin']) {
    if (typeof o[k] !== 'function') throw new Error('lib/checkout/rota-backfill-status (' + o.empresa + '): falta ' + k);
  }
  if (!o.plano || typeof o.plano.status !== 'function') throw new Error('lib/checkout/rota-backfill-status (' + o.empresa + '): falta o plano em fatias da empresa');
  if (o.extras != null && typeof o.extras !== 'function') throw new Error('lib/checkout/rota-backfill-status (' + o.empresa + '): extras tem que ser função');
  const prefixo = require('./config-empresa').prefixoDe(o.empresa);   /* empresa fora do contrato derruba no boot */
  const REG = require('./backfill-estado');
  const estado = REG.estado(o.empresa);
  const { json, lerChaveAdmin, validarSessao, ehAdmin, plano, extras } = o;

  return async function rotaBackfillStatus(req, res, urlObj, method, p) {
    if (!(method === 'GET' && p === prefixo + '/backfill-status')) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    /* 17/11 (passo 22, Codex #937): + `manual` — o desfecho da última rodada manual de um período (lib/checkout/rota-backfill-
       periodo), inclusive a recusa do motor, que não mexe no andamento (`status`); nas três (a GOOD guardava o dela) */
    json(res, 200, Object.assign({}, extras ? extras() : {}, { ok: true, status: estado, plano: plano.status(), manual: REG.manual(o.empresa) }));
    return true;
  };
}

module.exports = { criar };
