'use strict';
/* 15/11 — A CABEÇA COMUM DO `routes` (docs/NORTE-2026-11.md, item C, passo 3).

   O começo do handler das três empresas era o mesmo, na mesma ordem, com os nomes da empresa escritos à mão:
     1. /api/contexto (lib/checkout/contexto-api) — identidade e capacidades, pro painel se montar sozinho;
     2. /descobrir-ids (lib/checkout/descobrir-ids) — os ids desta empresa no Bling, só com a ADMIN_KEY;
     3. o PORTÃO DE SESSÃO (lib/checkout/portao-sessao) — daqui pra baixo tudo exige sessão (ou a chave);
     4. as rotas de catálogo (lib/checkout/rotas-catalogo) — DEPOIS do portão (Codex #480): não validam sessão sozinhas;
     5. a sonda dos cancelados antes da postagem (lib/checkout/rotas-cancelados-mkt) — criada na 1ª chamada;
     6. as cinco peças da operação (lib/checkout/rotas-operacao) — também depois do portão.
   Agora é esta peça: `criar(empresa, pecas)` monta as seis com o que é da empresa vindo de lib/checkout/config-empresa
   (prefixo da URL, pasta, gerenciador do token do ML, conta do TikTok, envs e padrões do /descobrir-ids) e devolve
   `cabeca(req, res, urlObj, method, p)` → true quando respondeu. O arquivo da empresa só passa as peças DELE
   (catálogo e operação já montados, json, chave, sessão, manifesto) e segue com as rotas que só ela tem.

   A ORDEM é a de sempre e é regra: o portão fica antes de catálogo, cancelados e operação. O teste
   (scripts/teste-cabeca-routes.js) prova que uma rota de catálogo sem sessão leva 401 e PARA. */
const path = require('path');
const { configCheckout } = require('./config-empresa');

const RAIZ = path.join(__dirname, '..', '..');
const PECAS = ['json', 'lerChaveAdmin', 'blingGet', 'validarSessao', 'ehAdmin', 'manifest', 'lerConferidos', 'uiBuild', 'rotasCatalogo', 'rotasOperacao'];

function criar(empresa, pecas) {
  const p = pecas || {};
  const falta = PECAS.filter((k) => p[k] == null);
  if (falta.length) throw new Error('lib/checkout/cabeca-routes (' + empresa + '): falta ' + falta.join(', '));
  const cfg = configCheckout(empresa);
  const PREFIXO = '/' + cfg.modulo;
  const { json, lerChaveAdmin, blingGet, validarSessao, ehAdmin, manifest, lerConferidos, rotasCatalogo, rotasOperacao } = p;

  /* 1. /api/contexto — só identidade e capacidade: nada de credencial, caminho ou env (isto chega no navegador do galpão) */
  const ctxApi = require('./contexto-api').montar({ empresa, modulo: cfg.modulo, json, uiBuild: p.uiBuild });
  /* 3. o portão (as públicas comuns + as desta empresa, em config-empresa) */
  const portao = require('./portao-sessao').criar(empresa, { validarSessao, lerChaveAdmin, json });
  /* 5. a sonda dos cancelados — criada na 1ª chamada, como era (o manifesto da empresa pode nascer depois do boot) */
  let cancMkt = null;
  const _cancMkt = () => cancMkt || (cancMkt = require('./rotas-cancelados-mkt').criar({ prefixo: PREFIXO, empresa: cfg.id, tiktokConta: cfg.tiktokConta,
    manifest, lerConferidos, json, validarSessao, ehAdmin }));

  /* 2. /descobrir-ids — pedido do dono em 26/08: os ids do Bling eram mapeados no DevTools, tela por tela, e é a maior
     fonte de digitação (e de erro: id de FILIAL e id de UNIDADE DE NEGÓCIO são espaços diferentes). Com o token que a
     empresa já tem depois do OAuth, dá pra simplesmente perguntar. Só com a ADMIN_KEY. */
  async function descobrirIds(req, res, urlObj) {
    const _k = lerChaveAdmin(req, urlObj);
    if (!process.env.ADMIN_KEY || _k !== process.env.ADMIN_KEY) { json(res, 403, { ok: false, erro: 'chave inválida' }); return true; }
    try {
      const di = cfg.descobrirIds;
      const d = require('./descobrir-ids').criar({ rotulo: di.rotulo, blingGet,
        /* o token do ML vem do gerenciador fiscal DESTA empresa (config-empresa.mlTokenManager, relativo à raiz) */
        garantirTokenML: () => require(path.join(RAIZ, cfg.mlTokenManager)).garantirTokenML(),
        envNomes: di.envNomes,
        temExpedicao: require('../empresas/registro').carregar({ servico: 'mover-pedidos' }).temCapacidade(cfg.id, 'expedicao') === true,
        /* 16/09 (P2 do Codex): o padrão do canal do ML foi REMOVIDO do código — declará-lo aqui faria a conferência dizer
           "não existe no Render, mas o padrão do código já é este valor", que é o contrário da verdade: sem a env, o F1 e
           o F3 se recusam a rodar. Dizer que está tudo bem quando não está é o pior jeito de errar numa ferramenta de
           conferência. Por isso só entram os padrões que a empresa declara (config-empresa.descobrirIds) */
        padroesEnv: di.padroesEnv, padroesExtras: di.padroesExtras });
      json(res, 200, await d.descobrir());
    } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); }
    return true;
  }

  return async function cabeca(req, res, urlObj, method, pth) {
    const m = method || req.method;
    const rota = pth || urlObj.pathname;
    if (await ctxApi(req, res, urlObj)) return true;
    if (rota === PREFIXO + '/descobrir-ids') return descobrirIds(req, res, urlObj);
    /* o portão só age nas rotas deste módulo; público, callback do OAuth, chave da Toolbox e porteiro central passam;
       o resto exige sessão (ou a ADMIN_KEY) — senão 401 e PARA */
    if (portao(req, res, rota, urlObj)) return true;
    if (await rotasCatalogo(req, res, urlObj, m)) return true;
    if (await _cancMkt()(req, res, urlObj, m)) return true;
    if (await rotasOperacao(req, res, urlObj, m)) return true;
    return false;
  };
}

module.exports = { criar, PECAS };
