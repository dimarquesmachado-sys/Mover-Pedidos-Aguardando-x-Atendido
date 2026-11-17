'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   O ARQUIVO DO CHECKOUT — peça única das empresas (17/11/2026, norte C, `montarCheckout`, passo 14).

   O `arquivo.js` de cada pasta (purgar o cache velho, arquivar o pedido finalizado, podar o arquivo e os conferidos) era
   CÓPIA nas três — a diferença era só a tag do log — e, ao contrário do nf.js, nem estava na lista dos espelhados do
   verificador: um conserto feito numa pasta não acusava nada nas outras, e a empresa nova teria que copiar mais um
   arquivo. Agora a regra mora aqui; o `arquivo.js` da pasta é só a fachada com a empresa e o base dela.

   Da empresa:
     · a tag do log sai do contrato (lib/checkout/config-empresa: GIRABKP, AMBBKP, GOODBKP; empresa nova, a convenção);
     · as pastas, os prazos e os leitores saem do base DA PASTA (cada uma tem o seu) — entra por injeção, porque o require
       relativo apontaria pra dentro da lib. Lidos no carregamento, como o arquivo de antes fazia.
   ───────────────────────────────────────────────────────────────────────────── */

function criar(cfg) {
  if (!cfg || !cfg.empresa) throw new Error('lib/checkout/arquivo-empresa: falta empresa');
  if (!cfg.base || typeof cfg.base !== 'object') throw new Error('lib/checkout/arquivo-empresa: falta base');
  const TAG = require('./config-empresa').configCheckout(cfg.empresa).tag;   /* empresa fora do contrato derruba no boot */
  const fs   = require('fs');
  const path = require('path');
  const { CACHE_DIR, RETENCAO_DIAS, ETIQ_FORMATO, CONFERIDOS_FILE, ARQUIVO_DIR, ARQUIVO_DIAS, ensureDir, readJson, writeJson } = cfg.base;

  function purgar(man) {
    const limite = Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000;
    for (const id of Object.keys(man)) {
      const t = Date.parse(man[id].cacheado_em || 0) || 0;
      if (t && t < limite) {
        try { fs.rmSync(path.join(CACHE_DIR, String(id)), { recursive: true, force: true }); } catch (e) {}
        delete man[id];
      }
    }
  }

  function arquivarFinalizado(id) {
    try {
      const src = path.join(CACHE_DIR, String(id));
      const dst = path.join(ARQUIVO_DIR, String(id));
      ensureDir(dst);
      const fmt = ETIQ_FORMATO.toLowerCase();
      const etq = path.join(src, `etiqueta.${fmt}`);
      if (fs.existsSync(etq)) fs.copyFileSync(etq, path.join(dst, `etiqueta.${fmt}`));
      const etqPdf = path.join(src, 'etiqueta.pdf');   // etiqueta PDF (Amazon/Madeira) — capturada cedo; email usa mesmo após despacho
      if (fs.existsSync(etqPdf)) fs.copyFileSync(etqPdf, path.join(dst, 'etiqueta.pdf'));
      const zplMM = path.join(src, 'etiqueta-correios.zpl');   // Madeira: ZPL público do ciclo (o A4 arquivado converte dele)
      if (fs.existsSync(zplMM)) fs.copyFileSync(zplMM, path.join(dst, 'etiqueta-correios.zpl'));
      const ped = path.join(src, 'pedido.json');
      if (fs.existsSync(ped)) fs.copyFileSync(ped, path.join(dst, 'pedido.json'));
      const nfs = path.join(src, 'nf-simp.json');   // dados do DANFE simplificado (se já gerado) → email usa sem re-buscar
      if (fs.existsSync(nfs)) fs.copyFileSync(nfs, path.join(dst, 'nf-simp.json'));
    } catch (e) { console.log('[' + TAG + '] falha ao arquivar', id, e.message); }
  }

  function purgarArquivo() {
    try {
      if (!fs.existsSync(ARQUIVO_DIR)) return;
      const limite = Date.now() - ARQUIVO_DIAS * 86400000;
      for (const d of fs.readdirSync(ARQUIVO_DIR)) {
        const dir = path.join(ARQUIVO_DIR, d);
        try { const st = fs.statSync(dir); if (st.isDirectory() && st.mtimeMs < limite) fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      }
    } catch (e) {}
  }

  function purgarConferidos() {
    const conf = readJson(CONFERIDOS_FILE, {});
    const limite = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let mudou = false;
    for (const id of Object.keys(conf)) {
      const c = conf[id];
      const t = Date.parse((c && c.conferido_em) || 0) || 0;
      if (c && c.sincronizado && t && t < limite) { delete conf[id]; mudou = true; }
    }
    if (mudou) writeJson(CONFERIDOS_FILE, conf);
  }

  return { purgar, arquivarFinalizado, purgarArquivo, purgarConferidos };
}

module.exports = { criar };
