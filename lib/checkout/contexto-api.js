'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   /api/contexto — quem é esta empresa, pra o painel se montar sozinho (15/09/2026).

   Base da Fase 4 (painel único por capacidades). Hoje os três painel.html são
   ~2.000 linhas cada e, medindo com os nomes normalizados, diferem em 73 a 109
   linhas — quase tudo MARCA: o logo em base64, o <title>, o <h1> e a versão da UI.
   Ou seja: são o mesmo painel, copiado três vezes por causa de um logo.

   Esta rota é o que falta pra inverter isso: em vez de o HTML saber de qual
   empresa ele é, ele pergunta. Com isso, um shell comum passa a ser possível sem
   nenhuma condicional por nome de empresa.

   O que ela devolve é só identidade e capacidade — nada de credencial, nada de
   caminho de disco, nada de env. O painel é servido ao navegador do galpão, e
   qualquer coisa aqui vira dado público na prática.
   ──────────────────────────────────────────────────────────────────────────── */

function criar(cfg) {
  for (const n of ['empresa', 'modulo', 'registro', 'json']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/contexto-api: falta ' + n);
  }
  const { empresa, modulo, registro, json } = cfg;

  const CAPACIDADES = ['fiscal', 'checkout', 'ml', 'ml-full', 'shopee', 'magalu', 'tiktok', 'madeira-madeira'];

  return async function handle(req, res, urlObj) {
    if (urlObj.pathname !== '/' + modulo + '/api/contexto') return false;

    const e = registro.obter(empresa);
    if (!e) { json(res, 500, { ok: false, erro: 'empresa "' + empresa + '" não está no contrato' }); return true; }

    const capacidades = {};
    for (const c of CAPACIDADES) capacidades[c] = registro.temCapacidade(e.id, c) === true;

    json(res, 200, {
      ok: true,
      empresa: e.id,
      nome: e.nome,
      slug: e.slugHttp,
      modulo,
      capacidades,
      /* a versão da UI vem de quem monta o painel; sem ela o navegador não tem como
         saber que está com HTML velho em cache — problema que já custou "ainda não
         surtiu efeito" mais de uma vez nesta casa. */
      ui_build: cfg.uiBuild || null,
    });
    return true;
  };
}

module.exports = { criar };
