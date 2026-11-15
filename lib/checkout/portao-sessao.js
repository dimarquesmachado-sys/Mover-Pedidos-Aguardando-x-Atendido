'use strict';
/* 15/11 — O PORTÃO DE SESSÃO DO CHECKOUT, UM PRAS TRÊS (Fase 3, passo 5 do plano multiloja: "a lista de rotas públicas de
   cada empresa vira configuração").

   Era um bloco de ~45 linhas escrito à mão dentro do `routes` de cada empresa, igual nas três a menos da LISTA de rotas
   públicas (as que a tela de login precisa, os scripts do painel e as rotas que validam a própria credencial). O que
   ele faz, na ordem de sempre:
     1. só age nas rotas DESTE módulo (o prefixo da empresa) — o resto do servidor não é dele;
     2. deixa passar o que é PÚBLICO: a lista comum (abaixo), as exceções que a empresa declara em
        lib/checkout/config-empresa (`portao.publicasExtras`), o callback do OAuth, a rota com chave da Toolbox e as
        rotas que o porteiro CENTRAL do servidor já cobre (lib/http/rotas-protegidas — Codex F01, 01/11: a mesma regra,
        pra /pedido/debugging/123 não escapar dos dois porteiros);
     3. todo o RESTO exige sessão de operador (cookie) — ou a ADMIN_KEY como credencial (Codex PR#38: o fluxo `?k=` do
        dashboard chama /historico-longo, /previsao-vendas… e morria no 401 antes de a guarda própria delas ver a chave);
        cada rota de dados continua revalidando (chave OU sessão admin) por conta própria;
     4. sem nada: 401 "Sessão necessária. Faça login." — e o pedido PARA aqui.

   ⚠️ As listas são DADO, não gosto: mudar uma rota de pública pra protegida (ou o contrário) muda quem consegue abrir o
   quê. A peça reproduz exatamente o que cada arquivo fazia (scripts/teste-portao-sessao.js confere a lista de cada
   empresa contra a que estava no arquivo dela, caminho por caminho). O que difere entre as três — e por quê — está
   anotado em config-empresa; nivelar é decisão do dono, rota a rota, não deste passo. */

/* públicas nas TRÊS (sem o prefixo da empresa): a raiz e o painel; a tela de login e o que ela precisa; os scripts
   compartilhados do painel (02/10, lição do #582: o `<script src>` não leva a querystring da página, e sem isto quem
   abre por `?k=` toma 401 e a seção some — os DADOS seguem exigindo sessão ou chave, nas rotas deles); e as rotas que
   têm guarda PRÓPRIA (QZ, lote de DANFEs, dashboard, NFs travadas). */
const PUBLICAS_COMUNS = [
  '', '/', '/painel',
  '/login', '/operadores', '/health', '/saude',
  '/js/plano-compra.js', '/js/previsao-vendas.js', '/js/ferramentas-custo.js', '/js/devolucoes-ml.js',
  '/js/despesas-shopee.js', '/js/ficha-produto.js', '/js/chat-analise.js', '/js/manutencao.js',
  '/js/ml-financeiro.js', '/js/nf-local.js',
  '/qz-cert',   /* o certificado é público; o /qz-sign SAIU da lista em 15/11 (Codex P2-2): assinar pedido do QZ exige quem está logado */
  '/danfes-lote',     /* 30/10: guard próprio (sessão de admin; sem ela, volta pro painel) */
  '/dashboard',       /* Codex PR#38: auth PRÓPRIA na rota (sessão ADMIN ou ?k=) — o gate barrava o ?k= sem cookie */
  '/nf-travadas',     /* 04/09: leitura pro card de NFs travadas */
];

const ERRO_SEM_SESSAO = { ok: false, erro: 'Sessão necessária. Faça login.' };

/* a lista pública completa da empresa, com o prefixo — pra quem quiser conferir (o teste, um diagnóstico) */
function publicasDe(cfg) {
  const extras = (cfg && cfg.portao && Array.isArray(cfg.portao.publicasExtras)) ? cfg.portao.publicasExtras : [];
  const prefixo = '/' + cfg.modulo;
  return PUBLICAS_COMUNS.concat(extras).map((s) => prefixo + s);
}

/* criar(empresa, pecas) → portao(req, res, p, urlObj): devolve TRUE quando BARROU (o 401 já foi respondido; o
   chamador retorna), FALSE quando o pedido pode seguir (e, se houve credencial, req._op / req._admKey estão postos). */
function criar(empresa, pecas, opts) {
  const P = pecas || {};
  const cfg = require('./config-empresa').configCheckout(empresa, opts);
  for (const n of ['validarSessao', 'lerChaveAdmin', 'json']) {
    if (typeof P[n] !== 'function') throw new Error('lib/checkout/portao-sessao (' + cfg.id + '): falta a peça ' + n);
  }
  const RP = P.rotasProtegidas || require('../http/rotas-protegidas');
  const prefixo = '/' + cfg.modulo;
  const publicas = new Set(publicasDe(cfg));
  return function portao(req, res, p, urlObj) {
    if (typeof p !== 'string' || !p.startsWith(prefixo)) return false;   /* não é rota deste módulo */
    if (publicas.has(p) || RP.ehCallbackOAuth(p) || RP.ehRotaChaveToolbox(p) || RP.ehRotaCentralAdmin(p)) return false;
    const op = P.validarSessao(req.headers['cookie']);
    if (op) { req._op = op; return false; }
    const k = P.lerChaveAdmin(req, urlObj);
    if (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) { req._op = 'admin-key'; req._admKey = true; return false; }
    P.json(res, 401, Object.assign({}, ERRO_SEM_SESSAO));
    return true;
  };
}

module.exports = { criar, publicasDe, PUBLICAS_COMUNS, ERRO_SEM_SESSAO };
