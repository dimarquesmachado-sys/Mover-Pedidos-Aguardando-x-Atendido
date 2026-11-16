'use strict';
/* 16/11 — O CUSTO DA EMPRESA NUMA PEÇA (docs/NORTE-2026-11.md, item C — `montarCheckout`, passo 5).

   Os três arquivos de entrada montavam, cada um, o MESMO bloco: o contexto do `lib/custo` (`_ctxCusto`: pastas, leitura e
   gravação de JSON, Bling, o cache do sku-info por getter), vinte e tantos atalhos pras funções de custo manual, vigência,
   de-para de SKU e nome do produto, e o contexto do `lib/vendas-ops` (`_ctxOps`: + a empresa e o cache do histórico por getter)
   com o recálculo de custo, a varredura de fornecedores e os estados dos dois. Idênticos na Girassol e na AMB; a GOOD tinha
   parte (sem `resolverNomeSku`, `carregarCatalogoDePara`, `buscarDevolucoesML` por aqui).

   Agora a peça monta tudo com o que é da empresa e devolve os mesmos nomes — o arquivo da empresa desestrutura e segue
   igual. O que é da empresa chega por getter quando nasce depois no arquivo (`skuInfoCache`, `histCache`), como já era.

   criar({ empresa, CACHE_DIR, path, fs, readJson, writeJson, blingGet, skuInfoCache: () => …, histCache: () => … })
     → { _ctxCusto, _ctxOps, _vigenciaDeRef, lerCustosManuais, gravarCustosManuais, custoManualDe, comCustosManuais,
         parsearCustosColados, telaCustosManuais, lerVigencias, gravarVigencias, registrarCustoVigente, custoVigenteEm,
         lerDeParaSku, gravarDeParaSku, resolverDeParaSku, sugerirDeParaSku, resolverNomeSku, carregarCatalogoDePara,
         _hojeISO, _ontemISO, _diaAntes, buscarDevolucoesML, varrerFornecedores, reaplicarCusto, estadoReapCusto, estadoVarrerForn } */

const PECAS = ['empresa', 'CACHE_DIR', 'path', 'fs', 'readJson', 'writeJson', 'blingGet', 'skuInfoCache', 'histCache'];

function criar(o) {
  const falta = PECAS.filter((k) => !o || o[k] == null);
  if (falta.length) throw new Error('lib/checkout/custo-empresa: falta ' + falta.join(', '));
  if (typeof o.skuInfoCache !== 'function' || typeof o.histCache !== 'function') throw new Error('lib/checkout/custo-empresa: skuInfoCache e histCache têm que ser funções (o cache nasce depois no arquivo da empresa)');
  const { empresa, CACHE_DIR, path, fs, readJson, writeJson, blingGet } = o;
  const _custoLib = require('../custo');
  const _ops = require('../vendas-ops');

  const _ctxCusto = { CACHE_DIR, path, fs, readJson, writeJson, blingGet,
                      get skuInfoCache() { const c = o.skuInfoCache(); return c === undefined ? null : c; } };
  const _vigenciaDeRef = { valor: null }; /* a janela de recuperação seta o dia varrido */
  const custoVigenteEm = (sku, data) => _custoLib.custoVigenteEm(_ctxCusto, sku, data);
  const _ctxOps = { blingGet, CACHE_DIR, path, readJson, custoVigenteEm, empresa,
    /* getter de propósito: o cache do histórico é declarado mais abaixo no arquivo da empresa; só resolve na hora do uso */
    get histCache() { return o.histCache(); } };

  return {
    _ctxCusto, _ctxOps, _vigenciaDeRef,
    lerCustosManuais:       ()            => _custoLib.lerCustosManuais(_ctxCusto),
    gravarCustosManuais:    (c)           => _custoLib.gravarCustosManuais(_ctxCusto, c),
    custoManualDe:          (sku, b)      => _custoLib.custoManualDe(_ctxCusto, sku, b),
    comCustosManuais:       (m)           => _custoLib.comCustosManuais(_ctxCusto, m),
    parsearCustosColados:   (t)           => _custoLib.parsearCustosColados(t),
    telaCustosManuais:      (nome, mod)   => _custoLib.telaCustosManuais(nome, mod),
    lerVigencias:           ()            => _custoLib.lerVigencias(_ctxCusto),
    gravarVigencias:        (c)           => _custoLib.gravarVigencias(_ctxCusto, c),
    registrarCustoVigente:  (sku, v, org) => _custoLib.registrarCustoVigente(_ctxCusto, sku, v, org, _vigenciaDeRef.valor),
    custoVigenteEm,
    lerDeParaSku:           ()            => _custoLib.lerDeParaSku(_ctxCusto),
    gravarDeParaSku:        (c)           => _custoLib.gravarDeParaSku(_ctxCusto, c),
    resolverDeParaSku:      (sku)         => _custoLib.resolverDeParaSku(_ctxCusto, sku),
    sugerirDeParaSku:       (v, cods)     => _custoLib.sugerirDeParaSku(_ctxCusto, v, cods),
    resolverNomeSku:        (d)           => _custoLib.resolverNomeSku(_ctxCusto, d),
    carregarCatalogoDePara: ()            => _custoLib.carregarCatalogoDePara(_ctxCusto),
    _hojeISO: _custoLib._hojeISO, _ontemISO: _custoLib._ontemISO, _diaAntes: _custoLib._diaAntes,
    buscarDevolucoesML: (tokenML, dorme)         => _ops.buscarDevolucoesML(tokenML, dorme),
    varrerFornecedores: (max)                    => _ops.varrerFornecedores(_ctxOps, max),
    reaplicarCusto:     (de, ate, emp, opts)     => _ops.reaplicarCusto(_ctxOps, de, ate, emp, opts),
    estadoReapCusto:    ()                       => _ops.estadoReaplicar(empresa),
    estadoVarrerForn:   ()                       => _ops.estadoVarrerFornecedores(empresa),
  };
}

module.exports = { criar, PECAS };
