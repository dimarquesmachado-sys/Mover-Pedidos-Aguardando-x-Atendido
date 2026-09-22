'use strict';
// base.js — fundação compartilhada: configs, helpers, leitura de arquivos, auth e chamadas ao Bling.
// Todos os outros módulos importam daqui. NÃO depende de nenhum módulo do projeto (evita import circular).

const fs    = require('fs');
const path  = require('path');
const fetch = require('node-fetch');
const { garantirToken } = require('../ambtotal/tokenManager');

const BLING_BASE = 'https://api.bling.com.br/Api/v3';

const CACHE_DIR     = process.env.AMBBKP_CACHE_DIR    || '/data/cache-offline/ambtotal';
const SIT_ATENDIDO  = Number(process.env.AMBBKP_SIT_ATENDIDO  || 9);              // ATENDIDO
const SIT_DESPACHADOS = Number(process.env.AMBBKP_SIT_DESPACHADOS || 745123);     // DESPACHADOS (destino do Full: já saiu pela Shopee)
const SIT_VERIFICADO = Number(process.env.AMBBKP_SIT_VERIFICADO || 24);           // VERIFICADO (destino do sync Fase 3)
const SYNC_ON       = process.env.AMBBKP_SYNC_ON === '1';                          // liga o sync automático no cron (Fase 3)
const JANELA_DIAS   = Number(process.env.AMBBKP_JANELA_DIAS   || 60)   /* 26/08: 60d reais (decisão do dono) — antes o valor era decorativo, o filtro nem chegava no Bling */;
const PAUSA_MS      = Number(process.env.AMBBKP_PAUSA_MS      || 350);            // ~3 req/s
const RETENCAO_DIAS = Number(process.env.AMBBKP_RETENCAO_DIAS || 7);
const ETIQ_FORMATO  = (process.env.AMBBKP_ETIQ_FORMATO || 'ZPL').toUpperCase();   // ZPL | PDF
const CRON_EXPR     = process.env.AMBBKP_CRON || '5,15,25,35,45,55 6-23 * * *';   // off do F3

const MANIFEST_FILE = path.join(CACHE_DIR, 'manifest.json');
const SKU_EAN_FILE  = path.join(CACHE_DIR, 'sku-ean.json');
const CONFERIDOS_FILE = path.join(CACHE_DIR, 'conferidos.json');
const RESERVAS_FILE   = path.join(CACHE_DIR, 'reservas.json');
const RESERVA_TTL_MS  = 8 * 60 * 1000;   // reserva expira em 8 min sem heartbeat (PC largado libera o pedido sozinho)
const KIT_CACHE_FILE  = path.join(CACHE_DIR, 'kit-estrutura.json');  // kits já resolvidos
const LOC_FILE        = path.join(CACHE_DIR, 'sku-localizacao.json'); // localização (depósito) por SKU
const LOC_LOG_FILE    = path.join(CACHE_DIR, 'localizacao-log.json'); // auditoria: quem editou localização, de→para, quando
const EAN_INDEX_FILE  = path.join(CACHE_DIR, 'ean-indice.json');      // índice EAN→{sku,nome,id} que cresce sozinho + indexação total
const EAN_INDEX_STATUS_FILE = path.join(CACHE_DIR, 'ean-indice-status.json'); // Codex #510 (P2): só o "fim" da indexação completa, sobrevive a restart (idxStatus é memória de processo)
const ARQUIVO_DIR   = process.env.AMBBKP_ARQUIVO_DIR  || '/data/arquivo-ambtotal';   // etiqueta+meta dos FINALIZADOS (reimprimir/reenviar) — separado do cache, NÃO é limpo pela reconciliação
const ARQUIVO_DIAS  = parseInt(process.env.AMBBKP_ARQUIVO_DIAS || '45', 10);          // retenção do arquivo (dias)
const SMTP_HOST  = process.env.AMBBKP_SMTP_HOST || 'mail.ambtotal.com.br';
const SMTP_PORT  = parseInt(process.env.AMBBKP_SMTP_PORT || '465', 10);
const EMAIL_USER = process.env.AMBBKP_EMAIL_USER || '';   // conta @ambtotal que ENVIA (login)
const EMAIL_PASS = process.env.AMBBKP_EMAIL_PASS || '';   // senha normal dessa conta
const EMAIL_DEST = process.env.AMBBKP_EMAIL_DEST || '';   // destino (estoquista) — SEM padrão cravado: configure a env no Render (aceita lista com vírgula)
const SCHEMA = 6;  // versão do snapshot — bump força re-cache dos pedidos antigos (24/08: un_id passa a guardar SÓ a unidade da LOJA)

// loja → marketplace (lojas da AMBTotal no Bling)
const LOJA_MKT = {
  '206017293': 'ml', '206017368': 'shopee', '206018666': 'magalu',
  '206027680': 'tiktok', '206079990': 'amazon'
};
const MKT_NOME = { ml: 'Mercado Livre', shopee: 'Shopee', amazon: 'Amazon', magalu: 'Magalu', tiktok: 'TikTok Shop', shein: 'Shein', leroy: 'Leroy Merlin', madeira: 'Madeira Madeira', outro: 'Outro' };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* 14/09 — as funções deste arquivo foram pra lib/checkout/base-funcoes.js: eram 91 linhas
   iguais nas três empresas, com exatamente DUAS envs diferentes. O que fica aqui é a
   CONFIGURAÇÃO desta empresa — envs, situações do Bling, janelas, pausas —, que é o que a
   torna ela mesma e não se unifica. Os caches em memória foram junto com as funções, porque
   é quem os lê e escreve: separar os dois quebrou o boot na primeira tentativa. */
const _fn = require('../lib/checkout/base-funcoes').criar({
  tag: 'AMBBKP',
  envOperadores: 'AMBBKP_OPERADORES',
  envAdmin: 'AMBBKP_ADMIN',
  BLING_BASE, garantirToken, PAUSA_MS,
  MANIFEST_FILE, SKU_EAN_FILE, LOC_FILE, EAN_INDEX_FILE, RESERVAS_FILE, RESERVA_TTL_MS,
  sleep,
});
const { ensureDir, readJson, writeJson, dataISO, json, html, lerReservas, lerOperadores, lerAdmins, ehAdmin, blingGet, blingWrite, moverSituacao, manifest, salvarManifest, skuEanCache, locCache, salvarLoc, salvarSkuEan, lerIndiceEan } = _fn;

module.exports = {
  /* 15/09 — o `tag` já existia aqui, passado pro base-funcoes, mas não era EXPORTADO:
     quem lia `base.tag` recebia undefined, e o boot morria na primeira empresa a montar.
     Exportar é o conserto na origem — a informação já estava no lugar certo. */
  tag: 'AMBBKP',
  fs, path, fetch, garantirToken, BLING_BASE,
  CACHE_DIR, SIT_ATENDIDO, SIT_DESPACHADOS, SIT_VERIFICADO, SYNC_ON, JANELA_DIAS, PAUSA_MS, RETENCAO_DIAS, ETIQ_FORMATO, CRON_EXPR,
  MANIFEST_FILE, SKU_EAN_FILE, CONFERIDOS_FILE, RESERVAS_FILE, RESERVA_TTL_MS,
  KIT_CACHE_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE, EAN_INDEX_STATUS_FILE, ARQUIVO_DIR, ARQUIVO_DIAS,
  SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_DEST, SCHEMA, LOJA_MKT, MKT_NOME,
  sleep, ensureDir, readJson, writeJson, dataISO, json, html,
  manifest, salvarManifest, skuEanCache, locCache, salvarLoc, salvarSkuEan, lerIndiceEan,
  lerReservas, lerOperadores, lerAdmins, ehAdmin,
  blingGet, blingWrite, moverSituacao,
};
