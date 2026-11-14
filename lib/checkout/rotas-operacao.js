'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   AS ROTAS DA OPERAÇÃO DO GALPÃO — UMA LIGAÇÃO PRAS TRÊS (14/11/2026)
   Fase 3, item 5 do plano multiloja (docs/plano-multiloja-passos.md): "o `routes` virar montagem" — 1º passo.

   As cinco peças de rota da operação já eram únicas (lib/checkout/rotas-*): a contagem de estoque, a separação, o
   backfill (detalhes / NF / valores), a NF anexada (com a sessão da Shopee e a pesca das tarifas do ML) e o conferido.
   O que cada empresa ainda escrevia À MÃO, dentro do `routes` dela, era a LIGAÇÃO: cinco blocos
   `require('../lib/checkout/rotas-x').criar({ … })` — ~90 linhas por arquivo, iguais nas três a menos de QUATRO textos
   (o prefixo da URL, a pasta, a env do depósito e o id da empresa) — e as cinco chamadas, na mesma ordem. Empresa nova
   teria que copiar isso tudo. Agora a ligação é esta peça:

     · o que é DA EMPRESA sai da configuração dela (lib/checkout/config-empresa), pela convenção que as três já seguem:
         prefixo da URL  = '/' + módulo            ('/amb-checkout-offline')
         pasta           = módulo                  ('amb-checkout-offline')
         env do depósito = <TAG>_DEPOSITO_GERAL    ('AMBBKP_DEPOSITO_GERAL')
         id da empresa   = a loja                  ('amb' · 'good' · 'girassol')
       empresa nova segue a convenção e não escreve nada disso;
     · as PEÇAS do arquivo da empresa (funções, caminhos, estados vivos) chegam em `P`, UMA lista, e cada peça de rota
       recebe EXATAMENTE as chaves que recebia do bloco escrito à mão — nem uma a mais (chave a mais pode ligar opção
       que a empresa não pediu), nem uma a menos;
     · a ORDEM das chamadas é a que as três tinham: contagem → separação → backfill → NF anexada → conferido.

   A PROVA (scripts/teste-rotas-operacao.js): os blocos de antes das três estão guardados em
   scripts/fixtures/rotas-operacao-antes-*.js.txt, tirados da main sem tocar no texto. O teste roda o bloco de antes e a
   ligação de hoje (o trecho VIVO do arquivo de cada empresa + esta peça) e exige que cada peça de rota receba a mesma
   coisa, chave por chave, e seja chamada na mesma ordem, com os mesmos argumentos.

   ⚠️ ESTADO VIVO — `statusValores`, `statusDetalhes` e `statusMlSync` são os objetos de progresso que as rotas leem e
   escrevem enquanto o backfill / a pesca rodam. Passam POR REFERÊNCIA (nunca copiar: a rota reportaria um progresso que
   não é o da rotina de verdade), e cada empresa passa os SEUS (dois backfills não dividem contador).

   ⚠️ A POSIÇÃO É PARTE DA SEGURANÇA (lição do #480): estas rotas não validam sessão sozinhas — quem monta chama o que
   esta peça devolve DEPOIS do portão de sessão do `routes`. Os testes das cinco peças travam isso.
   ───────────────────────────────────────────────────────────────────────────── */

/* tudo que o arquivo da empresa entrega. Faltou uma ⇒ o boot cai AQUI, dizendo o nome — antes, a peça esquecida era um
   identificador inexistente no arquivo (ReferenceError no boot); numa lista, viraria `undefined` calado e só estouraria
   na 1ª requisição daquela rota. */
const PECAS = [
  'readBody', 'tag', 'marca',
  'json', 'readJson', 'writeJson', 'ensureDir', 'sleep', 'PAUSA_MS', 'VERSAO', 'CACHE_DIR',
  'validarSessao', 'ehAdmin', 'lerAdmins', 'lerChaveAdmin',
  'blingGet', 'blingWrite', 'lerReservas', 'locCache', 'localizacaoDeProduto', 'salvarLoc',
  'montarSeparacao', 'montarSeparacaoPorPedido',
  'lerIndiceEan', 'getIdxStatus', 'produtoDetalhe', 'detalhePedido', 'backfillNFLocal',
  'mlSyncFees', 'shopeeKeepAlive', 'shopeeSessaoLer',
  'moverSituacao', 'arquivarFinalizado', 'sincronizarConferidos', 'rodarCiclo',
  'RESERVAS_FILE', 'LOC_LOG_FILE', 'CONFERIDOS_FILE', 'MANIFEST_FILE', 'SHOPEE_ENV_COOKIE',
  'SIT_VERIFICADO', 'SYNC_ON',
  'statusValores', 'statusDetalhes', 'statusMlSync',
  'fullJaDespachado', 'FULL_VAI_DESPACHADOS',
];

function criar(empresa, P, opts) {
  /* opts.registro: só pros testes simularem uma empresa NOVA (como em lib/checkout/config-empresa) */
  const cfg = require('./config-empresa').configCheckout(empresa, opts);
  for (const n of PECAS) {
    if (!P || P[n] === undefined) throw new Error('lib/checkout/rotas-operacao (' + cfg.id + '): falta a peça ' + n);
  }
  const prefixo = '/' + cfg.modulo;
  const {
    readBody, tag, marca,
    json, readJson, writeJson, ensureDir, sleep, PAUSA_MS, VERSAO, CACHE_DIR,
    validarSessao, ehAdmin, lerAdmins, lerChaveAdmin,
    blingGet, blingWrite, lerReservas, locCache, localizacaoDeProduto, salvarLoc,
    montarSeparacao, montarSeparacaoPorPedido,
    lerIndiceEan, getIdxStatus, produtoDetalhe, detalhePedido, backfillNFLocal,
    mlSyncFees, shopeeKeepAlive, shopeeSessaoLer,
    moverSituacao, arquivarFinalizado, sincronizarConferidos, rodarCiclo,
    RESERVAS_FILE, LOC_LOG_FILE, CONFERIDOS_FILE, MANIFEST_FILE, SHOPEE_ENV_COOKIE,
    SIT_VERIFICADO, SYNC_ON,
    fullJaDespachado, FULL_VAI_DESPACHADOS,
  } = P;

  const _rotasSeparacao = require('./rotas-separacao').criar({
    prefixo, tag, json, readBody, readJson, writeJson, blingGet, blingWrite, lerReservas,
    locCache, localizacaoDeProduto, salvarLoc, montarSeparacao, montarSeparacaoPorPedido,
    RESERVAS_FILE, LOC_LOG_FILE,
  });

  /* 22/09 — CONTAGEM DE ESTOQUE (registro interno). Pedido do dono: tela pro funcionário achar o produto por SKU, EAN
     ou parte do nome, ver nome completo e foto, e lançar o que contou. O funcionário informa e o dono aprova. */
  const _rotasContagem = require('./rotas-contagem').criar({
    prefixo, json, validarSessao, lerIndiceEan,
    /* pra a busca distinguir "índice vazio" de "catálogo nunca indexado" */
    getIdxStatus,
    CACHE_DIR, readJson, writeJson, readBody, blingGet,
    /* pra /contagem-saldo resolver a localização sob demanda, no foco do card (Codex #522 P2) */
    produtoDetalhe, localizacaoDeProduto, locCache,
    /* 24/09 — pra APLICAR a entrada no estoque do Bling: blingWrite faz o POST, ehAdmin decide quem pode.
       Codex #524 (P1): `ehAdmin` sozinho libera todo mundo quando a lista de admins da empresa está vazia — `lerAdmins`
       vai junto pra a rota poder EXIGIR admin configurado nesta escrita irreversível, em vez de herdar o
       "vazio = sem restrição" de rotas menos arriscadas. */
    blingWrite, ehAdmin, lerAdmins,
    /* Codex #526 (P2, r4): cada item lançado faz até 3 chamadas ao Bling seguidas (busca, cadastro, POST) — sem pausa
       ENTRE elas, só depois do item inteiro. A conta é limitada a ~3 req/s (o mesmo PAUSA_MS de 350ms do resto);
       espaçar as chamadas de dentro de um item evita fabricar os próprios 429 do lote. */
    PAUSA_MS, sleep,
    /* 27/10: a TELA da contagem é a peça única (lib/checkout/painel/contagem) com a marca do painel da empresa */
    marca,
    empresa: {
      pasta: cfg.modulo,
      /* o depósito é POR EMPRESA (o da GOOD é 4956031259; a rota /contagem-depositos lista os ids pra preencher a env).
         Sem a env, a entrada no Bling é RECUSADA em vez de chutar um depósito. */
      envDeposito: cfg.tag + '_DEPOSITO_GERAL',
    },
  });

  const _rotasBackfill = require('./rotas-backfill').criar({
    prefixo, json, readJson, writeJson, ehAdmin, lerChaveAdmin,
    detalhePedido, backfillNFLocal,
    /* a peça chama de `dorme`; nos arquivos das empresas é o `sleep` */
    dorme: sleep, CONFERIDOS_FILE,
    statusValores: P.statusValores, statusDetalhes: P.statusDetalhes,   /* a MESMA referência — não copiar */
  });

  const _rotasNfAnexar = require('./rotas-nf-anexar').criar({
    prefixo, empresaId: cfg.loja, json, readBody, readJson, writeJson, ensureDir, ehAdmin,
    lerChaveAdmin, mlSyncFees, shopeeKeepAlive, shopeeSessaoLer, CACHE_DIR, MANIFEST_FILE,
    SHOPEE_ENV_COOKIE, VERSAO, statusMlSync: P.statusMlSync,            /* a MESMA referência — não copiar */
  });

  const _rotasConferido = require('./rotas-conferido').criar({
    prefixo, tag, json, readBody, readJson, writeJson, lerReservas, moverSituacao,
    arquivarFinalizado, sincronizarConferidos, rodarCiclo, CONFERIDOS_FILE, RESERVAS_FILE,
    CACHE_DIR, SIT_VERIFICADO, SYNC_ON, VERSAO,
    /* o Full conferido só vai pra DESPACHADOS onde o ciclo da empresa o leva pra lá (#701); com o destino 0 a opção sai
       false e ele segue pro VERIFICADO, pra Expedição (Codex #702). A opção e o bloco do ciclo andam JUNTOS — por isso
       quem decide é o arquivo da empresa (`!!require('./base').SIT_DESPACHADOS`), não esta peça. */
    fullJaDespachado,
    FULL_VAI_DESPACHADOS,
  });

  /* a ordem e os argumentos de cada chamada são os que as três tinham no `routes` */
  return async function rotasOperacao(req, res, urlObj, method) {
    if (await _rotasContagem(req, res, urlObj, method)) return true;
    if (await _rotasSeparacao(req, res, urlObj, method)) return true;
    if (await _rotasBackfill(req, res, urlObj, method, validarSessao)) return true;
    if (await _rotasNfAnexar(req, res, urlObj, method, validarSessao)) return true;
    if (await _rotasConferido(req, res, urlObj, method, validarSessao)) return true;
    return false;
  };
}

module.exports = { criar, PECAS };
