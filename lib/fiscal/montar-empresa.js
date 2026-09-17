'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   MONTAR UMA EMPRESA A PARTIR DO REGISTRO (14/09/2026).

   O último passo do critério da auditoria: "dado um quarto registro válido e
   credenciais, o mesmo artefato sobe rotas e crons isolados, sem criar pasta e sem
   editar JavaScript".

   Hoje as três empresas existentes continuam com a pasta delas — e de propósito:
   elas carregam HISTÓRIA que o registro não sabe (a Girassol grava tokens em
   caminho relativo ao módulo, usa envs sem prefixo e tem outra estratégia de
   retentativa no F1). Mexer nisso sem necessidade seria trocar estado vivo por
   elegância, e já vimos hoje o preço disso.

   O que este montador faz é o contrário: pra uma empresa NOVA, que não tem
   história, ele deriva tudo do registro — nomes de env pelo prefixo do serviço,
   caminhos por id canônico, rótulo pelo id — e devolve o módulo fiscal pronto.
   As exceções continuam possíveis, mas são explícitas, e empresa nova não precisa
   de nenhuma.
   ──────────────────────────────────────────────────────────────────────────── */

const { criarModuloFiscal } = require('./criar-modulo');
const { criarFluxosPedidos } = require('./fluxos-pedidos');
const { criarFluxoNF } = require('./nf-fluxos');
const { criarFluxoNFeML } = require('./nfe-ml-fluxo');
const { criarBlingApi } = require('./bling-api');
const { criarNfBlingApi } = require('./nf-bling-api');
const { criarMlApi } = require('./ml-api');
const { criarTokenManager } = require('./token-manager');
const { criarNfTokenManager } = require('./nf-token-manager');
const { criarMlTokenManager } = require('./ml-token-manager');

/* minutos do F3 escalonados: empresa nova entra num minuto que ninguém usa, senão
   nasce disputando a cota do Bling com as que já existem. */
function _minutoF3(ocupados) {
  for (let m = 0; m < 10; m++) if (!ocupados.includes(m)) return m;
  return 0;
}

function montarEmpresa(idOuAlias, opcoes) {
  const { registro, ocupadosF3 = [0, 2, 4], excecoes = {} } = opcoes || {};
  if (!registro) throw new Error('lib/fiscal/montar-empresa: falta o registro');

  const e = registro.obter(idOuAlias);
  if (!e) throw new Error('lib/fiscal/montar-empresa: "' + idOuAlias + '" não está no contrato');
  if (registro.temCapacidade(e.id, 'fiscal') === false) {
    throw new Error('lib/fiscal/montar-empresa: ' + e.id + ' não declara a capacidade "fiscal"');
  }

  const env = (sufixo) => registro.nomeEnv(e.id, sufixo);
  const rotulo = (excecoes.rotulo || e.id).toUpperCase();
  const dir = excecoes.dirDados || ('/data/' + e.id);

  const tokenManager   = criarTokenManager({
    rotulo, envTokenFile: env('TOKEN_FILE'), arquivoToken: excecoes.arquivoToken || (dir + '/bling-tokens.json'),
    envBlingClientId: env('BLING_CLIENT_ID'), envBlingClientSecret: env('BLING_CLIENT_SECRET'),
    envBlingRedirectUri: env('BLING_REDIRECT_URI'),
  });
  const nfTokenManager = criarNfTokenManager({
    rotulo, envTokenFile: env('NF_TOKEN_FILE'), arquivoToken: excecoes.arquivoTokenNF || (dir + '/nf-tokens.json'),
    envId: env('NF_BLING_CLIENT_ID'), envSecret: env('NF_BLING_CLIENT_SECRET'),
    envRedirect: env('NF_BLING_REDIRECT_URI'), rotaSetup: (e.slugHttp === '/' + e.id ? e.slugHttp : e.slugHttp) + '/setup-nf',
  });
  const mlTokenManager = criarMlTokenManager({
    rotulo, envTokenFile: env('ML_TOKEN_FILE'), arquivoToken: excecoes.arquivoTokenML || (dir + '/ml-tokens.json'),
    envClientId: env('ML_CLIENT_ID'), envClientSecret: env('ML_CLIENT_SECRET'), envRedirect: env('ML_REDIRECT_URI'),
  });

  /* 15/09 — empresa NOVA não pode herdar o canal de venda de outra: sem o canal próprio, o
     F1 julgaria os pedidos dela pelo canal alheio e ignoraria tudo, em silêncio, que é o pior
     jeito. 16/09 — o padrão herdado que as TRÊS empresas com pasta ainda tinham saiu de
     lib/fiscal/bling-api.js; a mesma exigência agora vale pra todo mundo, com ou sem pasta. */
  /* 16/09 (P2 do Codex) — PRESENÇA NÃO É VALIDADE, aqui também. Esta checagem aceitava
     `NOVA_ME_LOJA_IDS=abc` ou só espaços: o valor existe, a fábrica monta, e o filtro de ids
     lá no blingApi devolve lista vazia — a empresa sobe e o F1/F3 se recusam a rodar, com o
     dono achando que configurou. Mesmo erro que o `empresa.js validar` tinha. */
  const _canaisBrutos = String(process.env[env('ME_LOJA_IDS')] || '').trim();
  const _canaisItens = _canaisBrutos.split(',').map(x => x.trim()).filter(Boolean);
  /* 16/09 (P2 do Codex): mesma regra do blingApi — um item ruim invalida a lista inteira.
     Descartar só o inválido deixaria a empresa nova ignorando o canal digitado errado. */
  const _canaisValidos = _canaisItens.some(x => !/^\d+$/.test(x)) ? [] : _canaisItens;
  if (!_canaisValidos.length) {
    throw new Error('lib/fiscal/montar-empresa: ' + e.id + ' precisa de ' + env('ME_LOJA_IDS') +
      (_canaisBrutos
        ? ' com ids NUMÉRICOS separados por vírgula — veio "' + _canaisBrutos.slice(0, 40) + '"'
        : ' (os ids do canal do Mercado Livre no Bling desta empresa)') +
      '. Sem isso o F1 usaria o canal de outra empresa. ' +
      /* esta empresa NÃO tem pasta de checkout, então não existe /<slug>/descobrir-ids pra
         ela — anunciar a rota mandaria o dono a um 404. O caminho real é pegar o id no Bling
         (canal de venda do Mercado Livre) ou rodar a descoberta de uma empresa que tenha
         pasta pra ver o formato. */
      'Como esta empresa é montada pelo contrato (sem pasta), ela não tem rota /descobrir-ids ' +
      'própria: pegue o id do canal do Mercado Livre direto no Bling dela.');
  }

  const blingApi = criarBlingApi({
    rotulo, envPausaMs: env('PAUSA_MS'), envGetPausaMs: env('GET_PAUSA_MS'),
    envMaxPaginas: env('MAX_PAGINAS'), envMaxPaginasNfe: env('MAX_PAGINAS_NFE'),
    envJanelaUltimosDias: env('JANELA_ULTIMOS_DIAS'), envMeLojaIds: env('ME_LOJA_IDS'),
    envSituacaoAguardando: env('SITUACAO_AGUARDANDO'),
  });
  const nfBlingApi = criarNfBlingApi({
    rotulo, nfTokenManager, envPausa: env('NF_PAUSA_MS'),
    envIntermediadorCnpj: env('NF_INTERMEDIADOR_CNPJ'), envIntermediadorNome: env('NF_INTERMEDIADOR_NOME'),
    intermediadorCnpj: excecoes.intermediadorCnpj || '03007331000141',
    intermediadorNome: excecoes.intermediadorNome || e.nome.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    pastaCacheIE: excecoes.pastaCacheIE || dir,
  });
  const mlApi = criarMlApi({ rotulo });

  const pecas = { blingApi, mlApi, mlTokenManager, tokenManager };
  const fluxos = criarFluxosPedidos({
    rotulo, pecas,
    envMaxPedidosF1: env('MAX_PEDIDOS_F1'), envMaxPedidosF2: env('MAX_PEDIDOS_F2'),
    envF1RemoveMax: env('F1_REMOVE_MAX'), envF1RemoveEsperaMin: env('F1_REMOVE_ESPERA_MIN'),
  });
  const nfFluxos = criarFluxoNF({ nfTokenManager, nfBlingApi, envCooldown: env('NF_COOLDOWN_MIN') });
  const nfeMl = criarFluxoNFeML({
    rotulo, pecas,
    envMaxNfeMl: env('MAX_NFE_ML'), envNfJanelaDias: env('NF_JANELA_DIAS_F3'), envF3MaxChecagens: env('F3_MAX_CHECAGENS'),
  });

  const minuto = excecoes.minutoF3 != null ? excecoes.minutoF3 : _minutoF3(ocupadosF3);
  const crons = excecoes.crons || {
    expediente:  '*/3 * * * *',
    virada:      '10 0 * * *',
    manha:       ['0 6 * * *', '30 6 * * *', '0 7 * * *', '*/15 * * * *'],
    corrigirNFs: '*/5 * * * *',
    /* o F3 num minuto livre: nascer no mesmo das outras seria criar disputa por cota */
    nfeMl:       [minuto, minuto + 10, minuto + 20, minuto + 30, minuto + 40, minuto + 50].join(',') + ' * * * *',
  };

  return criarModuloFiscal({
    id: e.id, nome: e.nome, prefixo: e.slugHttp === '/' + e.id ? e.slugHttp : e.slugHttp, rotulo, crons,
    pecas: {
      rotinaExpediente: fluxos.rotinaExpediente, rotinaVirada: fluxos.rotinaVirada, rotinaManha: fluxos.rotinaManha,
      corrigirNFsPendentes: nfFluxos.corrigirNFsPendentes, retryNFManual: nfFluxos.retryNFManual,
      getEstadoRetrySEFAZ: nfFluxos.getEstadoRetrySEFAZ,
      garantirToken: tokenManager.garantirToken, gerarTokenInicial: tokenManager.gerarTokenInicial,
      gerarTokenInicialNF: nfTokenManager.gerarTokenInicialNF, garantirTokenNF: nfTokenManager.garantirTokenNF,
      garantirTokenML: mlTokenManager.garantirTokenML, trocarCodigoPorToken: mlTokenManager.trocarCodigoPorToken,
      gerarUrlAutorizacao: mlTokenManager.gerarUrlAutorizacao,
      getPedidoDetalhe: blingApi.getPedidoDetalhe,
      rotinaNFeML: nfeMl.rotinaNFeML, enviarNFeUnica: nfeMl.enviarNFeUnica,
    },
  });
}

module.exports = { montarEmpresa };
