'use strict';
/* 16/11 — NORTE C, `montarCheckout(empresa)`, passo 8: A VENDA DO DIA DA EMPRESA É UMA PEÇA.

   Os três arquivos de entrada montavam, cada um, o MESMO bloco da venda do dia e das tarifas do ML:
     · o estado da venda do dia (`_vsy`, de lib/checkout/estado-rotinas), o canal pelo número (inferir-canal) e a pesca dos
       dados do ML (lib/ml-pesca);
     · o frete da Magalu (lib/checkout/magalu-frete: tabela, cubagem e o banco por SKU);
     · a FASE DIRETA (lib/checkout/fase-direta: as vendas do dia direto no ML, na Shopee e na Magalu), com o token do ML e
       o serviço da Shopee escritos à mão em cada arquivo (as envs com o prefixo de cada um);
     · a venda do dia (lib/checkout/vendas-dia), montada na primeira chamada com as mesmas 16 peças;
     · a pesca das tarifas reais do ML nos pedidos conferidos (lib/checkout/ml-sync-fees), com o estado `_mls`.
   Iguais nas três, tirando o nome da empresa, as envs da Shopee, o caminho do token do ML e a versão do marcador de custos
   que cada uma grava (`versaoCustos`: 2 na Girassol e na GOOD, 1 na AMB — declarada por quem monta, como era).

   Agora `criar({ empresa, versaoCustos, pecas })` monta tudo isso e devolve os MESMOS nomes. O serviço da Shopee e o token
   do ML saem da configuração da empresa (lib/checkout/config-empresa: `faseDireta`, `mlTokenManager`) — a 4ª empresa não
   escreve env à mão. O que é do arquivo da empresa chega por `pecas`, um objeto de ACESSORES lidos na hora:
     CACHE_DIR, CONFERIDOS_FILE, LOJA_MKT, blingGet, readJson, writeJson, json, nfDoPedido, resolverProdutoPorSku,
     custoEmpresa (a peça lib/checkout/custo-empresa DESTA empresa: as devoluções do ML) e `_mls` (com leitura E escrita:
     a pesca troca o objeto do estado a cada rodada e as rotas de status leem o do arquivo). */
const path = require('path');

const PECAS = ['CACHE_DIR', 'CONFERIDOS_FILE', 'LOJA_MKT', 'blingGet', 'readJson', 'writeJson', 'json', 'nfDoPedido', 'resolverProdutoPorSku', 'custoEmpresa', '_mls'];
const RAIZ = path.join(__dirname, '..', '..');

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/vendas-dia-empresa: falta empresa');
  if (!(Number(o.versaoCustos) >= 1)) throw new Error('lib/checkout/vendas-dia-empresa: falta versaoCustos (1 ou mais)');
  const P = o.pecas;
  if (!P || typeof P !== 'object') throw new Error('lib/checkout/vendas-dia-empresa: falta pecas');
  for (const n of PECAS) if (!(n in P)) throw new Error('lib/checkout/vendas-dia-empresa: falta ' + n);
  const empresa = String(o.empresa);
  const cfg = (o.configCheckout || require('./config-empresa').configCheckout)(empresa);   /* empresa fora do contrato derruba no boot */
  const fetch = o.fetch || require('node-fetch');   /* Codex P2 (fase direta): o node-fetch, que respeita o `timeout` dos canais */
  const log = o.log || console.log;
  /* o token do ML DESTA empresa — o módulo do contrato (relativo à raiz do repo), carregado na hora da chamada, como era */
  const tokenML = () => require(path.join(RAIZ, cfg.mlTokenManager));

  const _vsy = require('./estado-rotinas').estadoDe(empresa).vendas;
  const _inferCanal = require('./inferir-canal').inferirCanal;
  const { pescarDadosML } = require('../ml-pesca');

  /* o frete da Magalu (o resolvedor de produto é preguiçoso: o arquivo da empresa o declara depois) */
  const _magaluFrete = require('./magalu-frete').criar({
    CACHE_DIR: P.CACHE_DIR,
    readJson: (...a) => P.readJson(...a),
    writeJson: (...a) => P.writeJson(...a),
    blingGet: (...a) => P.blingGet(...a),
    resolverProdutoPorSku: (...a) => P.resolverProdutoPorSku(...a),
  });

  /* a fase direta: o serviço da Shopee pela configuração da empresa (lida aqui, na subida — como as envs eram lidas) */
  const fd = cfg.faseDireta;
  const _faseDireta = require('./fase-direta').criarFaseDireta({
    empresa,
    mlTokenManager: tokenML,
    shopeeKey: cfg.ler(fd.shopeeKey),
    shopeeUrlEnv: cfg.ler(fd.shopeeUrl),
    shopeeLoja: cfg.ler(fd.shopeeLoja),   /* Codex P1 (fase direta): a URL do serviço usa a LOJA configurada, não o nome da empresa */
    adminKey: process.env.ADMIN_KEY || '',
    porta: process.env.PORT || 3000,
    fetch,
    log,
  });

  /* a venda do dia: montada na primeira chamada; as peças entregues na hora da chamada */
  let _vendasDia = null;
  const vendasSync = () => {
    if (!_vendasDia) _vendasDia = require('./vendas-dia').criarVendasSyncDaEmpresa(empresa, {
      deps: () => ({ CACHE_DIR: P.CACHE_DIR, CONFERIDOS_FILE: P.CONFERIDOS_FILE, LOJA_MKT: P.LOJA_MKT, _faseDireta, _inferCanal, _vsy, blingGet: P.blingGet, buscarDevolucoesML: P.custoEmpresa.buscarDevolucoesML, json: P.json, magaluFreteProvisorio: _magaluFrete.magaluFreteProvisorio, magaluFreteSkuGravar: _magaluFrete.magaluFreteSkuGravar, nfDoPedido: P.nfDoPedido, path, pescarDadosML, readJson: P.readJson, writeJson: P.writeJson }),
      fetch,
    });
    return _vendasDia();
  };

  /* a pesca das tarifas reais do ML nos pedidos conferidos — o estado é o do arquivo da empresa (as rotas de status o leem) */
  const _mlSyncFeesPeca = require('./ml-sync-fees').criar({
    empresa,
    versaoCustos: Number(o.versaoCustos),
    garantirTokenML: () => tokenML().garantirTokenML(),
    get _mls() { return P._mls; },
    set _mls(v) { P._mls = v; },
    get CONFERIDOS_FILE() { return P.CONFERIDOS_FILE; },
    get readJson() { return P.readJson; },
    get writeJson() { return P.writeJson; },
  });
  const mlSyncFees = (dias) => _mlSyncFeesPeca(dias);

  return Object.assign({ _vsy, _inferCanal, pescarDadosML, _faseDireta, vendasSync, mlSyncFees }, _magaluFrete);
}

module.exports = { criar, PECAS };
