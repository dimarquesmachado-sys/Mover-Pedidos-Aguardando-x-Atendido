'use strict';
/* 16/11 — NORTE C, `montarCheckout(empresa)`, passo 6: AS ROTINAS DE CUSTO DA EMPRESA SÃO UMA PEÇA.

   Os três arquivos de entrada montavam, cada um, o MESMO bloco (~60 linhas de código e ~50 de comentário histórico):
     · o estado do sync de custo (`_cst`, de lib/checkout/estado-rotinas) e a anotação da falha (`_anotarFalhaCusto`);
     · o sync de custo (lib/checkout/custo-sync), com 15 peças por acessor;
     · o sync "travado" e a re-tentativa (lib/checkout/custo-sync-travado), com a trava pesada do processo;
     · o custo diário das 23 h (lib/checkout/custo-diario), com a vigência retroativa, o arquivo `_custos.json` e a fila de
       recálculo (lib/checkout/custo-recalculo) que refaz as vendas já gravadas desde o dia da mudança.
   Na Girassol e na AMB, byte a byte iguais tirando o nome da empresa; na GOOD também, mais as três opções do sync que só
   ela declara (`seletor`, `fornecedorEstrito`, `histSkusDoArquivo` — lib/checkout/custo-sync explica cada uma).

   Agora `criar({ empresa, opcoesCustoSync?, pecas })` monta tudo isso e devolve os MESMOS nomes que os arquivos usavam.
   O que é da empresa chega por `pecas`, um objeto de ACESSORES lidos na hora da chamada (o arquivo da empresa declara as
   peças depois desta linha — era o padrão de sempre do custo-sync):
     CACHE_DIR, CONFERIDOS_FILE, _histCache, _limparSkuInfo, blingGet, readJson, writeJson, resolverProdutoPorSku e
     `custoEmpresa` (a peça lib/checkout/custo-empresa DESTA empresa: registro e leitura das vigências, de-para de SKU e o
     recálculo do custo das vendas gravadas).
   O que é igual pra todas sai daqui: a trava pesada do processo, a decisão de custo por composição (lib/custo-composicao),
   a configuração do Supabase da empresa (lib/supabase.cfg), o estado e a anotação da falha.

   Nivelado por cima: a limpeza do cache do sku-info depois de reler um custo era protegida (`try`) só na GOOD — uma falha
   ao limpar o OUTRO cache não pode derrubar o custo do SKU. Agora vale pras três. */
const path = require('path');

const PECAS = ['CACHE_DIR', 'CONFERIDOS_FILE', '_histCache', '_limparSkuInfo', 'blingGet', 'readJson', 'writeJson', 'resolverProdutoPorSku', 'custoEmpresa'];
const OPCOES = ['seletor', 'fornecedorEstrito', 'histSkusDoArquivo'];

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rotinas-custo-empresa: falta empresa');
  const P = o.pecas;
  if (!P || typeof P !== 'object') throw new Error('lib/checkout/rotinas-custo-empresa: falta pecas');
  for (const n of PECAS) if (!(n in P)) throw new Error('lib/checkout/rotinas-custo-empresa: falta ' + n);
  const opc = o.opcoesCustoSync || {};
  for (const n of Object.keys(opc)) if (!OPCOES.includes(n)) throw new Error('lib/checkout/rotinas-custo-empresa: opção desconhecida do custo-sync: ' + n);
  const empresa = String(o.empresa);
  const CE = () => P.custoEmpresa;

  const travaPesada = require('./trava-pesada');
  const _custoComp = require('../custo-composicao');
  /* o MESMO objeto que `estadoDe(empresa).custo` devolve a quem mais o lê (o status do painel, o diagnóstico) */
  const _cst = require('./estado-rotinas').estadoDe(empresa).custo;
  const _anotarFalhaCusto = (sku, motivo) => require('./estado-rotinas').anotarFalhaCusto(_cst, sku, motivo);

  /* o sync de custo — as peças lidas a cada rodada */
  const _custoSyncPeca = require('./custo-sync').criar({
    empresa,
    seletor: opc.seletor,
    fornecedorEstrito: opc.fornecedorEstrito,
    histSkusDoArquivo: opc.histSkusDoArquivo,
    get CACHE_DIR() { return P.CACHE_DIR; },
    get CONFERIDOS_FILE() { return P.CONFERIDOS_FILE; },
    get _anotarFalhaCusto() { return _anotarFalhaCusto; },
    get _cst() { return _cst; },
    get _custoComp() { return _custoComp; },
    get _histCache() { return P._histCache; },
    /* nivelado pela GOOD: falha ao limpar o outro cache não derruba o custo do SKU */
    get _limparSkuInfo() { return (sku) => { try { P._limparSkuInfo(sku); } catch (e) {} }; },
    get blingGet() { return P.blingGet; },
    get readJson() { return P.readJson; },
    get registrarCustoVigente() { return CE().registrarCustoVigente; },
    get resolverDeParaSku() { return CE().resolverDeParaSku; },
    get resolverProdutoPorSku() { return P.resolverProdutoPorSku; },
    get supaCfg() { return (e) => require('../supabase').cfg(e, empresa); },
    get travaPesada() { return travaPesada; },
    get writeJson() { return P.writeJson; },
  });
  const custoSync = (fresh) => _custoSyncPeca(fresh);

  /* o sync "travado" (tartaruga pós-boot, manutenção de 6 h, disparo manual, gatilho do histórico com `retentar`) */
  const _custoTravadoPeca = require('./custo-sync-travado').criar({
    empresa,
    travaPesada,
    custoSync: (fresh) => custoSync(fresh),
    get _cst() { return _cst; },
    get _histCache() { return P._histCache; },
  });
  const custoRetryPendente = () => _custoTravadoPeca.custoRetryPendente();
  const custoSyncTravado = (fresh, retentar) => _custoTravadoPeca.custoSyncTravado(fresh, retentar);

  /* o custo diário das 23 h — o mesmo `_custos.json` que o custoSync monta */
  const CUSTO_FILE_DIARIO = path.join(P.CACHE_DIR, '_custos.json');
  let _custoDiarioMod = null;
  /* a fila de recálculo desta empresa (a mesma do "lançar custo" — uma por empresa no processo) */
  const _filaRecalculoCusto = () => require('./custo-recalculo').daEmpresa({ empresa, reaplicar: (de, ate, emp, opts) => CE().reaplicarCusto(de, ate, emp, opts), hoje: () => _custoDiarioMod._diaLocalHoje() });
  _custoDiarioMod = require('./custo-diario').criar({
    empresa,                                       /* identifica quem segura a trava pesada */
    CUSTO_FILE: CUSTO_FILE_DIARIO,
    readJson: (...a) => P.readJson(...a),
    /* 01/11 (auditoria do Codex, F11): gravação SEGURA (temporário + troca) */
    escrever: (p, o) => require('../escrita-atomica').gravarAtomico(p, JSON.stringify(o)),
    estadoSync: () => _cst,
    custoSync: (...a) => custoSync(...a),
    blingGet: (...a) => P.blingGet(...a),
    registrarCustoVigente: (...a) => CE().registrarCustoVigente(...a),
    lerVigenciaDe: () => CE()._vigenciaDeRef.valor,
    gravarVigenciaDe: (v) => { CE()._vigenciaDeRef.valor = v; },
    /* 13/11: custo que mudou no Bling recalcula as vendas JÁ GRAVADAS desde o dia da mudança */
    lerVigencias: () => CE().lerVigencias(),
    pedirRecalculo: (sku, dia) => _filaRecalculoCusto().pedir(sku, dia),
    /* a rotina só dá a mudança por aplicada quando o recálculo terminou bem */
    estadoRecalculo: (sku) => _filaRecalculoCusto().estado(sku),
  });
  const custoDiario = (...a) => _custoDiarioMod.custoDiario(...a);

  return {
    _cst, _anotarFalhaCusto, travaPesada, CUSTO_FILE_DIARIO,
    custoSync, custoSyncTravado, custoRetryPendente,
    custoDiario, _cstDiario: _custoDiarioMod._cstDiario, _diaFechadoDoDisco: _custoDiarioMod._diaFechadoDoDisco,
    _filaRecalculoCusto,
  };
}

module.exports = { criar, PECAS, OPCOES };
