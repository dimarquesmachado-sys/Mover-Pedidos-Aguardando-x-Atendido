'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   UMA FOTO POR DIA (15/11/2026) — o guarda-fotos dos leitores que só sabem o "agora".

   O Mercado Livre e a Shopee dizem como a conta está AGORA (quantos anúncios ativos, a nota da loja…). Pra responder
   "mudou? caiu?" é preciso ter guardado como estava: cada leitura grava a foto do dia num arquivo do cache DA EMPRESA
   (a última leitura do dia vence). Antes da primeira foto NÃO HÁ registro — quem lê diz isso em vez de supor "igual".

   É o mesmo desenho da foto da reputação do ML (lib/checkout/reputacao-ml.js), que continua com o guarda-fotos dela.

   `criar({ arquivo, maxFotos })` → { ler, gravar, historico }, todos recebendo as peças da empresa
   (`{ CACHE_DIR, readJson, writeJson }`):
     · gravar(o, dia, foto) → true se gravou. O gravador de produção (`writeJson` do base-funcoes) NÃO lança quando o
       disco falha — devolve `false` (Codex #886); por isso o retorno é conferido. Falha de disco não derruba quem chamou.
     · historico(o, de, ate) → as fotos do intervalo, da mais antiga pra mais nova, cada uma com o `dia`.
   ───────────────────────────────────────────────────────────────────────────── */

const path = require('path');

const DIA = /^\d{4}-\d{2}-\d{2}$/;

function criar(cfg) {
  if (!cfg || typeof cfg.arquivo !== 'string' || !cfg.arquivo) throw new Error('lib/checkout/fotos-diarias: falta o nome do arquivo');
  const MAX = Number(cfg.maxFotos) > 0 ? Number(cfg.maxFotos) : 400;
  const caminho = (o) => path.join(o.CACHE_DIR, cfg.arquivo);
  function ler(o) {
    const a = o.readJson(caminho(o), null);
    const d = (a && a.dias) || {};
    const out = {};
    for (const k of Object.keys(d)) if (DIA.test(k) && d[k] && typeof d[k] === 'object') out[k] = d[k];
    return out;
  }
  function gravar(o, dia, foto) {
    if (!DIA.test(String(dia || '')) || !foto || typeof foto !== 'object') return false;
    try {
      const dias = ler(o);
      dias[dia] = foto;
      const guardar = {};
      for (const k of Object.keys(dias).sort().slice(-MAX)) guardar[k] = dias[k];
      return o.writeJson(caminho(o), { dias: guardar, atualizado: foto.em || new Date().toISOString() }) !== false;
    } catch (e) { return false; }
  }
  function historico(o, de, ate) {
    const dias = ler(o);
    return Object.keys(dias).sort().filter((k) => k >= de && k <= ate).map((k) => Object.assign({ dia: k }, dias[k]));
  }
  return { ler, gravar, historico, arquivo: cfg.arquivo, maxFotos: MAX };
}

module.exports = { criar };
