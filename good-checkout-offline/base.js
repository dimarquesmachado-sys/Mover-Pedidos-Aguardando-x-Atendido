'use strict';
// base.js — fundação compartilhada: configs, helpers, leitura de arquivos, auth e chamadas ao Bling.
// Todos os outros módulos importam daqui. NÃO depende de nenhum módulo do projeto (evita import circular).

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const { garantirToken } = require('../good/tokenManager');

const BLING_BASE = 'https://api.bling.com.br/Api/v3';

const CACHE_DIR     = process.env.GOODBKP_CACHE_DIR    || '/data/cache-offline/good';
const SIT_ATENDIDO  = Number(process.env.GOODBKP_SIT_ATENDIDO  || 9);              // ATENDIDO
const SIT_DESPACHADOS = Number(process.env.GOODBKP_SIT_DESPACHADOS || 0);          // DESPACHADOS do Full — 0 = move DESLIGADO até configurar o id desta conta
const SIT_VERIFICADO = Number(process.env.GOODBKP_SIT_VERIFICADO || 24);           // VERIFICADO (destino do sync Fase 3)
const SYNC_ON       = process.env.GOODBKP_SYNC_ON === '1';                          // liga o sync automático no cron (Fase 3)
const JANELA_DIAS   = Number(process.env.GOODBKP_JANELA_DIAS   || 60);   /* 26/08: 60d reais (decisão do dono, porte do #213) — antes o valor era decorativo, o filtro nem chegava no Bling */
const PAUSA_MS      = Number(process.env.GOODBKP_PAUSA_MS      || 350);            // ~3 req/s
const RETENCAO_DIAS = Number(process.env.GOODBKP_RETENCAO_DIAS || 7);
const ETIQ_FORMATO  = (process.env.GOODBKP_ETIQ_FORMATO || 'ZPL').toUpperCase();   // ZPL | PDF
const CRON_EXPR     = process.env.GOODBKP_CRON || '5,15,25,35,45,55 6-23 * * *';   // off do F3

const MANIFEST_FILE = path.join(CACHE_DIR, 'manifest.json');
const SKU_EAN_FILE  = path.join(CACHE_DIR, 'sku-ean.json');
const CONFERIDOS_FILE = path.join(CACHE_DIR, 'conferidos.json');
const RESERVAS_FILE   = path.join(CACHE_DIR, 'reservas.json');
const RESERVA_TTL_MS  = 8 * 60 * 1000;   // reserva expira em 8 min sem heartbeat (PC largado libera o pedido sozinho)
const KIT_CACHE_FILE  = path.join(CACHE_DIR, 'kit-estrutura.json');  // kits já resolvidos
const LOC_FILE        = path.join(CACHE_DIR, 'sku-localizacao.json'); // localização (depósito) por SKU
const LOC_LOG_FILE    = path.join(CACHE_DIR, 'localizacao-log.json'); // auditoria: quem editou localização, de→para, quando
const EAN_INDEX_FILE  = path.join(CACHE_DIR, 'ean-indice.json');      // índice EAN→{sku,nome,id} que cresce sozinho + indexação total
const ARQUIVO_DIR   = process.env.GOODBKP_ARQUIVO_DIR  || '/data/arquivo-good';   // etiqueta+meta dos FINALIZADOS (reimprimir/reenviar) — separado do cache, NÃO é limpo pela reconciliação
const ARQUIVO_DIAS  = parseInt(process.env.GOODBKP_ARQUIVO_DIAS || '45', 10);          // retenção do arquivo (dias)
const SMTP_HOST  = process.env.GOODBKP_SMTP_HOST || '';
const SMTP_PORT  = parseInt(process.env.GOODBKP_SMTP_PORT || '465', 10);
const EMAIL_USER = process.env.GOODBKP_EMAIL_USER || '';   // conta da GOOD que ENVIA (login)
const EMAIL_PASS = process.env.GOODBKP_EMAIL_PASS || '';   // senha normal dessa conta
const EMAIL_DEST = process.env.GOODBKP_EMAIL_DEST || '';   // destino (estoquista) — SEM padrão cravado: configure a env no Render (aceita lista com vírgula)
const SCHEMA = 6;  // versão do snapshot — bump força re-cache dos pedidos antigos (24/08: un_id passa a guardar SÓ a unidade da LOJA)

// loja → marketplace (GOOD Import). Lojas confirmadas via diagnostico.
// Pode adicionar/sobrescrever por env GOODBKP_LOJA_MKT no formato "idLoja:mkt,idLoja:mkt".
const LOJA_MKT = (function () {
  const map = {
    '203296034': 'ml',
    '203583539': 'shopee',
    '203764162': 'amazon',
    '203381869': 'magalu',
    '205773174': 'tiktok',
    '205557785': 'madeira',
    '205594320': 'leroy',
    '203344795': 'carrefour',
    '203402885': 'olist',
    '203345742': 'b2w',
    '204349867': 'mercadoshops'
  };
  (process.env.GOODBKP_LOJA_MKT || '').split(',').forEach(function (par) {
    const kv = par.split(':');
    const id = (kv[0] || '').trim(), mkt = (kv[1] || '').trim().toLowerCase();
    if (id && mkt) map[id] = mkt;
  });
  return map;
})();
const MKT_NOME = { ml: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', magalu: 'Magalu', tiktok: 'TikTok Shop', madeira: 'Madeira Madeira', leroy: 'Leroy Merlin', carrefour: 'Carrefour', olist: 'Olist', b2w: 'Americanas', mercadoshops: 'MercadoShops', outro: 'Outro' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 14/09 — as funções deste arquivo foram pra lib/checkout/base-funcoes.js: eram 91 linhas
   iguais nas três empresas, com exatamente DUAS envs diferentes. O que fica aqui é a
   CONFIGURAÇÃO desta empresa — envs, situações do Bling, janelas, pausas —, que é o que a
   torna ela mesma e não se unifica. Os caches em memória foram junto com as funções, porque
   é quem os lê e escreve: separar os dois quebrou o boot na primeira tentativa. */
const _fn = require('../lib/checkout/base-funcoes').criar({
  tag: 'GOODBKP',
  envOperadores: 'GOODBKP_OPERADORES',
  envAdmin: 'GOODBKP_ADMIN',
  BLING_BASE, garantirToken, PAUSA_MS,
  MANIFEST_FILE, SKU_EAN_FILE, LOC_FILE, EAN_INDEX_FILE, RESERVAS_FILE, RESERVA_TTL_MS,
  sleep,
});
const { ensureDir, readJson, writeJson, dataISO, json, html, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao, manifest, salvarManifest, skuEanCache, locCache, salvarLoc, salvarSkuEan, lerIndiceEan } = _fn;

module.exports = {
  /* 15/09 — o `tag` já existia aqui, passado pro base-funcoes, mas não era EXPORTADO:
     quem lia `base.tag` recebia undefined, e o boot morria na primeira empresa a montar.
     Exportar é o conserto na origem — a informação já estava no lugar certo. */
  tag: 'GOODBKP',
  fs, path, fetch, garantirToken, BLING_BASE,
  CACHE_DIR, SIT_ATENDIDO, SIT_DESPACHADOS, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS,
  KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE, ARQUIVO_DIR, ARQUIVO_DIAS,
  SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html,
  manifest, salvarManifest, skuEanCache, locCache, salvarLoc, salvarSkuEan, lerIndiceEan,
  lerReservas, lerOperadores, lerAdmins, ehAdmin,
  blingGet, blingWrite, moverSituacao,
};
