'use strict';

const fs = require('fs');

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

  /* vocabulário de capacidades vem do PRÓPRIO contrato (lib/empresas/registro), não de uma
     lista solta aqui — capacidade nova só entra no vocabulário num commit revisado lá, e
     esta rota herda automaticamente em vez de ficar pra trás e esconder o recurso. */
  const CAPACIDADES = require('../empresas/registro').CAPACIDADES_CONHECIDAS;

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

/* lê o UI_BUILD cravado no painel.html — é o painel que sabe a própria versão, não o
   backend (VERSAO é a versão do SERVIDOR; confundir os dois faz o check de cache velho
   comparar coisas sem relação nenhuma, como a AMB comparando b92 de servidor com b129 de
   UI). Se o arquivo não existir ou o padrão não bater, devolve null em vez de inventar. */
function _lerUiBuild(caminhoPainel) {
  if (!caminhoPainel) return null;
  try {
    const html = fs.readFileSync(caminhoPainel, 'utf8');
    const m = html.match(/UI_BUILD\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

/* wrapper resiliente pra quem monta a rota dentro de routes(): carrega o registro AQUI,
   protegido por try/catch, em vez de deixar o require+carregar() do chamador estourar sem
   rede — sem isso, contrato-empresas.json ausente derruba o boot inteiro no lugar de cair
   no modo antigo que config/empresas.js já sabe tratar (achado do Codex: esta rota é
   OPCIONAL, e um endpoint opcional não pode ser o motivo do serviço não subir). */
function montar(cfg) {
  for (const n of ['empresa', 'modulo', 'json']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/contexto-api: falta ' + n);
  }
  let registro;
  try {
    registro = require('../empresas/registro').carregar({ servico: cfg.servico || 'mover-pedidos' });
  } catch (e) {
    console.warn('[contexto-api] registro indisponível (' + (e.message || e) + ') — /api/contexto de "' + cfg.modulo + '" desativada');
    return async () => false;
  }
  return criar({
    empresa: cfg.empresa,
    modulo: cfg.modulo,
    registro,
    json: cfg.json,
    uiBuild: _lerUiBuild(cfg.painelHtml),
  });
}

module.exports = { criar, montar };
