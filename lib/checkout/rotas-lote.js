'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ROTAS DE LOTE DO CHECKOUT — PEÇA ÚNICA (30/10/2026; eram só da GOOD, good-checkout-offline/index.js):
   · POST <prefixo>/etiquetas-zpl-massa — anexa etiquetas em MASSA: o ZIP/.txt da Shopee (decodifica a chave da NF de
     dentro de cada etiqueta) ou { etiquetas: [{ nf, tracking, zpl_base64 }] }; casa pelo número da NF no manifesto
     (NF duplicada = ambígua, não casa às cegas), grava a etiqueta.zpl na pasta do pedido e marca etiqueta_anexada;
   · GET <prefixo>/etiquetas-massa — a página de envio do arquivo;
   · GET <prefixo>/danfes-lote?nfs=… — um PDF só com as DANFEs dos pedidos (até 120; ?json=1 só confere).
   Só admin. criarRotasLote({ prefixo, tag, empresaAviso, CACHE_DIR, MANIFEST_FILE, ETIQ_FORMATO, json, readBody,
   readJson, writeJson, ensureDir, manifest, validarSessao, ehAdmin, baixarDanfe }) → { handle(req, res, p, method, urlObj) }
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const { lerZipEntradas } = require('./zip-etiquetas');
const { decodificarZplShopee } = require('./decodificar-zpl-shopee');

function criarRotasLote(o) {
  const NECESSARIAS = ['prefixo', 'tag', 'empresaAviso', 'CACHE_DIR', 'MANIFEST_FILE', 'json', 'readBody', 'readJson', 'writeJson', 'ensureDir', 'manifest', 'validarSessao', 'ehAdmin', 'baixarDanfe'];
  const falta = NECESSARIAS.filter((k) => o == null || o[k] == null);
  if (falta.length) throw new Error('lib/checkout/rotas-lote: falta peça da empresa: ' + falta.join(', '));
  const PREFIXO = o.prefixo, TAG = o.tag, EMPRESA_AVISO = o.empresaAviso;
  const NOME = o.nome || o.tag;   /* o nome da empresa no título da página de envio */
  const { CACHE_DIR, MANIFEST_FILE, json, readBody, readJson, writeJson, ensureDir, manifest, validarSessao, ehAdmin, baixarDanfe } = o;
  const ETIQ_FORMATO = o.ETIQ_FORMATO || 'zpl';

  async function handle(req, res, p, method, urlObj) {
        if (method === 'POST' && p === PREFIXO + '/etiquetas-zpl-massa') {
          // sessão de admin, igual à irmã individual (a trava central do módulo já exige login
          // antes de chegar aqui; chave por query não passa pelo gate, então nem oferecemos)
          const opSessM = validarSessao(req.headers['cookie']);
          if (!opSessM || !ehAdmin(opSessM)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
          let bodyM = {}; try { const _rm = await readBody(req); bodyM = (_rm && typeof _rm === 'object') ? _rm : JSON.parse(_rm || '{}'); } catch (e) { json(res, 400, { ok: false, erro: 'body inválido' }); return true; }
          let lista = Array.isArray(bodyM.etiquetas) ? bodyM.etiquetas : [];
          let decodificadas = null, sem_codigo = 0;
          // b18: aceita o ARQUIVO CRU da Shopee (zip ou o .txt do ZPL agregado) — o servidor
          // fatia e decodifica os códigos de dentro do bitmap (chave NF + tracking) sozinho
          if (!lista.length && bodyM.arquivo_base64) {
            let bufU = null; try { bufU = Buffer.from(String(bodyM.arquivo_base64).replace(/^data:[^,]*,/, ''), 'base64'); } catch (e) {}
            if (!bufU || bufU.length < 200) { json(res, 400, { ok: false, erro: 'arquivo vazio ou inválido' }); return true; }
            if (bufU.length > 12 * 1024 * 1024) { json(res, 400, { ok: false, erro: 'arquivo acima de 12MB — divida em partes' }); return true; }
            let txtU = null;
            if (bufU[0] === 0x50 && bufU[1] === 0x4B && bufU[2] === 0x03 && bufU[3] === 0x04) {
              try {
                const entsU = lerZipEntradas(bufU);
                const zplU = entsU.find(e2 => /zpl/i.test(e2.nome) || /\.txt$/i.test(e2.nome) || (e2.conteudo && e2.conteudo.slice(0, 30000).toString('latin1').indexOf('~DG') >= 0));
                if (zplU) txtU = zplU.conteudo.toString('latin1');
              } catch (e) {}
            } else {
              const cab = bufU.slice(0, 30000).toString('latin1');
              if (cab.indexOf('~DG') >= 0 || cab.indexOf('^XA') >= 0) txtU = bufU.toString('latin1');
            }
            if (!txtU) { json(res, 400, { ok: false, erro: 'não reconheci o arquivo — mande o ZIP da Shopee, o .txt do ZPL ou o JSON identificado' }); return true; }
            let itensU = [];
            try { itensU = await decodificarZplShopee(txtU); }
            catch (e) { json(res, 500, { ok: false, erro: 'decodificador indisponível: ' + String(e.message || e).slice(0, 160) }); return true; }
            if (!itensU.length) { json(res, 400, { ok: false, erro: 'nenhuma etiqueta (~DG) encontrada no arquivo' }); return true; }
            if (itensU.length > 120) { json(res, 400, { ok: false, erro: itensU.length + ' etiquetas num arquivo só — divida em arquivos de até 120 (a decodificação roda dentro da requisição)' }); return true; }
            decodificadas = itensU.length;
            lista = [];
            for (const it2 of itensU) {
              if (!it2.nf) { sem_codigo++; continue; }
              lista.push({ nf: it2.nf, tracking: it2.tracking, zpl_base64: Buffer.from(it2.zpl, 'latin1').toString('base64') });
            }
            if (!lista.length) { json(res, 200, { ok: false, erro: 'decodifiquei ' + decodificadas + ' etiqueta(s) mas nenhuma trouxe a chave da NF legível', decodificadas, sem_codigo }); return true; }
          }
          if (!lista.length) { json(res, 400, { ok: false, erro: 'mande { arquivo_base64 } (zip/txt da Shopee) ou { etiquetas: [{ nf, tracking, zpl_base64 }] }' }); return true; }
          if (lista.length > 300) { json(res, 400, { ok: false, erro: 'máximo de 300 etiquetas por chamada' }); return true; }
          const _ehZplM = b => { if (!b || b.length < 50) return false; const s = b.slice(0, 30000).toString('latin1'); return s.indexOf('^XA') >= 0 || s.indexOf('~DG') >= 0; };
          const manM = readJson(MANIFEST_FILE, {});
          // índice nf_numero → id (e tracking → id como reserva, se o snapshot tiver rastreio)
          const porNF = {};
          for (const [idX, mX] of Object.entries(manM)) {
            const nfX = Number(mX && mX.nf_numero);
            if (isFinite(nfX) && nfX > 0 && porNF[nfX] === undefined) porNF[nfX] = idX;
            else if (isFinite(nfX) && nfX > 0 && porNF[nfX] !== undefined) porNF[nfX] = null;   // NF duplicada no manifesto: ambígua, não casa às cegas
          }
          const casadas = [], sem_pedido = [], invalidas = [], ambiguas = [];
          let mudouMan = false;
          const quemM = (typeof opSessM === 'string' ? opSessM : (opSessM && (opSessM.usuario || opSessM.nome || opSessM.login))) || '';
          for (const et of lista) {
            const nfN = Number(et && et.nf);
            let bufM = null; try { bufM = Buffer.from(String((et && et.zpl_base64) || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch (e) {}
            if (!isFinite(nfN) || nfN <= 0 || !bufM || bufM.length < 200 || !_ehZplM(bufM)) { invalidas.push(et && et.nf); continue; }
            const idM = porNF[nfN];
            if (idM === null) { ambiguas.push(nfN); continue; }
            if (!idM) { sem_pedido.push(nfN); continue; }
            const dirM = path.join(CACHE_DIR, String(idM));
            const alvoM = path.join(dirM, 'etiqueta.' + String(ETIQ_FORMATO || 'zpl').toLowerCase());
            try {
              ensureDir(dirM);
              const _outroM = path.join(dirM, 'etiqueta.pdf');
              fs.writeFileSync(alvoM, bufM);   // grava-primeiro (b136): só remove o PDF depois que o ZPL está no disco
              // Codex PR#35: com GOODBKP_ETIQ_FORMATO=PDF os dois caminhos coincidem — sem o guard,
              // apagaríamos o arquivo que acabamos de gravar (a irmã individual sempre teve o guard)
              if (_outroM !== alvoM && fs.existsSync(_outroM)) { try { fs.unlinkSync(_outroM); } catch (e) {} }
            } catch (e) { invalidas.push(nfN); continue; }
            if (manM[idM]) { manM[idM].etiqueta_anexada = true; manM[idM].tem_etiqueta = true; manM[idM].etiqueta_pdf = false; manM[idM].etiqueta_formato = ETIQ_FORMATO; mudouMan = true; }
            try {
              const snapM = readJson(path.join(dirM, 'pedido.json'), null);
              if (snapM) { snapM.etiqueta_anexada = true; snapM.tem_etiqueta = true; snapM.etiqueta_pdf = false; snapM.etiqueta_formato = ETIQ_FORMATO; writeJson(path.join(dirM, 'pedido.json'), snapM); }
            } catch (e) {}
            try { require('../avisar-devolucoes')(EMPRESA_AVISO, 'etiqueta_anexada', idM, { formato: 'zpl', quem: quemM, massa: true }); } catch (e) {}
            casadas.push({ nf: nfN, id: idM, numero: (manM[idM] && manM[idM].numero) || null, bytes: bufM.length });
          }
          // Codex PR#35: o ciclo pode salvar um manifesto ANTIGO por cima (ele carrega o dele em
          // memória no começo da rodada). Re-lemos AGORA e carimbamos a cópia fresca — a janela de
          // corrida cai de minutos pra milissegundos; e se ainda assim o ciclo atropelar, o próximo
          // reconstrói do snapshot (que também carimbamos), então o estado se auto-repara.
          if (mudouMan) {
            try {
              const manF = readJson(MANIFEST_FILE, {});
              for (const c of casadas) { if (manF[c.id]) { manF[c.id].etiqueta_anexada = true; manF[c.id].tem_etiqueta = true; manF[c.id].etiqueta_pdf = false; manF[c.id].etiqueta_formato = ETIQ_FORMATO; } }
              writeJson(MANIFEST_FILE, manF);
            } catch (e) {}
          }
          console.log('[' + TAG + '] etiquetas em MASSA: ' + casadas.length + ' anexada(s), ' + sem_pedido.length + ' sem pedido, ' + invalidas.length + ' inválida(s) — por ' + quemM);
          json(res, 200, { ok: true, total: lista.length, decodificadas, sem_codigo, anexadas: casadas.length, casadas, sem_pedido, ambiguas, invalidas });
          return true;
        }

        // ── DANFEs em LOTE (12/08, caso das 29 DANFEs trocadas pela Shopee): junta as NFs
        // corretas de N pedidos num PDF único pro galpão imprimir 1 arquivo e colar sobre o
        // rodapé errado das etiquetas. Fonte: danfe.pdf do cache; fallback baixarDanfe com a
        // MESMA guarda do /imprimir (nunca baixa NF velha por cima de nota anexada — PR#5).
        if (method === 'GET' && p === PREFIXO + '/danfes-lote') {
          const opSessDL = validarSessao(req.headers['cookie']);
          if (!opSessDL || !ehAdmin(opSessDL)) { res.writeHead(302, { Location: PREFIXO + '/' }); res.end(); return true; }
          const idsTodos = String(urlObj.searchParams.get('nfs') || urlObj.searchParams.get('pedidos') || '').split(',').map(s => s.trim()).filter(Boolean);
          if (!idsTodos.length) { json(res, 400, { ok: false, erro: 'use ?nfs=77488,77491,… (números das NFs)' }); return true; }
          if (idsTodos.length > 120) { json(res, 400, { ok: false, erro: 'máximo 120 pedidos por lote (recebi ' + idsTodos.length + ') — divida em dois' }); return true; }   // Codex PR#41: nunca cortar em silêncio
          // 12/08 (achado no 1º uso real): o galpão/o Diego digita o NÚMERO da venda (74816), mas a
          // pasta do cache usa a CHAVE do Bling — mesma tradução do /debug-nf-simp: sem pasta, procura
          // o numero (e o numero_loja) no manifesto. Assim a rota aceita os dois formatos.
          // 12/08 (regra do Diego): NF EXATA ou não pega — nada de cascata/adivinhação. Aceita a
          // chave da pasta do cache (uso interno) ou o NÚMERO DA NF; dois pedidos com a mesma NF
          // (não deve existir) não escolhem nenhum — cai em faltando com o motivo.
          const resolveDL = (x) => {
            // Codex PR#42: o manifesto e RELIDO a cada item — o ciclo de fundo pode reassociar a
            // NF de um pedido enquanto o lote roda, e um mapa velho entregaria a NF B sob o rotulo A
            const manDL = manifest();
            const s = String(x).replace(/^0+/, '');   // 077488 e 77488 sao a mesma NF
            try { if (fs.existsSync(path.join(CACHE_DIR, String(x), 'pedido.json')) || fs.existsSync(path.join(CACHE_DIR, String(x), 'danfe.pdf'))) return { id: String(x) }; } catch (e) {}
            // Codex PR#42: '0'/'00' normaliza pra vazio e casaria com todo pedido SEM nf_numero
            if (!s) return { id: null, ambiguo: 'número de NF inválido' };
            const hits = Object.keys(manDL).filter(k2 => {
              const nfk = String((manDL[k2] || {}).nf_numero || '').replace(/^0+/, '');
              return nfk && nfk === s;
            });
            if (hits.length > 1) return { id: null, ambiguo: 'NF ' + s + ' aparece em ' + hits.length + ' pedidos' };
            if (hits.length === 1) {
              // Codex PR#42: NF anexada à mão pelo caminho só-PDF não atualiza o nf_numero do
              // manifesto — o número velho (cancelado) apontaria pra DANFE nova. Sem número
              // verificado, a rota NÃO entrega: o admin imprime esse pelo 📎 NF do card.
              // Codex PR#42: anexo COM XML tem numero confirmado (o /nf-anexar le o nNF e grava
              // no snapshot) — vale. So o anexo SO-PDF fica sem numero verificado e e recusado.
              const snapV = readJson(path.join(CACHE_DIR, String(hits[0]), 'pedido.json'), null);
              if (snapV && snapV.nf_anexada) {
                const numV = String((snapV.nf && snapV.nf.numero) || snapV.nf_numero || '').replace(/^0+/, '');
                if (numV !== s) return { id: null, ambiguo: 'NF anexada sem numero confirmado - imprima pelo botao NF do pedido' };
              }
              return { id: hits[0] };
            }
            return { id: null };
          };
          const ambiguos = [];
          const { PDFDocument } = require('pdf-lib');
          const docs = [], achadas = [], faltando = [];
          // Codex PR#42: resolver TUDO antes do loop deixava a janela dos awaits — outro admin
          // podia trocar a NF de um pedido ainda nao lido e a gente entregaria o PDF novo sob o
          // numero velho. Cada item e resolvido no instante em que vai ser lido.
          for (let iDL = 0; iDL < idsTodos.length; iDL++) {
            const rotuloDL = idsTodos[iDL];
            const rDL = resolveDL(rotuloDL);
            const idL = rDL.id;
            if (!idL) { faltando.push(rotuloDL); if (rDL.ambiguo) ambiguos.push(rotuloDL + ' (' + rDL.ambiguo + ')'); continue; }
            const dirL = path.join(CACHE_DIR, String(idL));
            let nfB = null;
            try { nfB = fs.readFileSync(path.join(dirL, 'danfe.pdf')); } catch (e) {}
            if (!nfB) {
              const snapL = readJson(path.join(dirL, 'pedido.json'), null);
              if (snapL && !snapL.nf_anexada && snapL.nf && snapL.nf.id) {
                const baixado = await baixarDanfe(snapL.nf.id);
                // Codex PR#41 (P1): um admin pode ter ANEXADO a NF corrigida enquanto o download
                // rodava — re-lê o snapshot e o disco DEPOIS do await; anexo novo vence o Bling velho
                const snapL2 = readJson(path.join(dirL, 'pedido.json'), null);
                if (snapL2 && snapL2.nf_anexada) {
                  try { nfB = fs.readFileSync(path.join(dirL, 'danfe.pdf')); } catch (e) {}
                } else if (baixado) {
                  nfB = baixado;
                  try { ensureDir(dirL); fs.writeFileSync(path.join(dirL, 'danfe.pdf'), nfB); } catch (e) {}
                }
              }
            }
            // Codex PR#41: valida o PDF JÁ NA COLETA — truncado/cifrado não vira "achada"
            let docL = null;
            if (nfB) { try { docL = await PDFDocument.load(nfB); } catch (e) { docL = null; } }
            if (docL && docL.getPageCount() > 0) { docs.push([rotuloDL, docL]); achadas.push(rotuloDL); } else faltando.push(rotuloDL);
          }
          if (urlObj.searchParams.get('json')) { json(res, 200, { ok: true, pedidas: idsTodos.length, achadas, faltando, ambiguos }); return true; }
          if (!docs.length) { json(res, 404, { ok: false, erro: 'nenhuma DANFE válida encontrada', faltando, ambiguos }); return true; }
          try {
            const outDL = await PDFDocument.create();
            for (const [idL, srcDL] of docs) {
              try { const pgs = await outDL.copyPages(srcDL, srcDL.getPageIndices()); pgs.forEach(pg => outDL.addPage(pg)); }
              catch (e) { faltando.push(idL); }
            }
            if (!outDL.getPageCount()) { json(res, 422, { ok: false, erro: 'nenhuma página copiada', faltando }); return true; }   // Codex PR#41: nunca 200 com PDF vazio
            const mergedDL = Buffer.from(await outDL.save());
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="danfes-lote.pdf"', 'X-Faltando': faltando.join(','), 'X-Ambiguos': ambiguos.map(a9 => String(a9).split(' (')[0]).join(',') });   // Codex PR#42: header e Latin-1 — motivo (com acento/emoji) so no ?json=1
            res.end(mergedDL);
          } catch (e) { json(res, 500, { ok: false, erro: 'pdf-lib: ' + String(e.message || e).slice(0, 120), faltando }); }
          return true;
        }

        // ─── página do upload em massa (admin logado) ─────────────────────────────────────────
        if (method === 'GET' && p === PREFIXO + '/etiquetas-massa') {
          const opSessP2 = validarSessao(req.headers['cookie']);
          if (!opSessP2 || !ehAdmin(opSessP2)) { res.writeHead(302, { Location: PREFIXO + '/' }); res.end(); return true; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>Etiquetas em massa · ' + NOME + '</title><body style="font-family:system-ui;max-width:680px;margin:32px auto;padding:0 16px">' +
            '<h2>📎 Etiquetas em massa — ' + NOME + '</h2>' +
            '<p>Selecione o <b>ZIP baixado da Shopee</b> (ou o .txt do ZPL, ou um JSON já identificado). O servidor lê a <b>chave da NF</b> de dentro de cada etiqueta e anexa no pedido certo.</p>' +
            '<input type="file" id="f" accept=".zip,.txt,.json,application/json,application/zip,text/plain"> <button id="b" style="padding:8px 18px">Enviar</button>' +
            '<pre id="o" style="background:#f5f5f5;padding:12px;white-space:pre-wrap"></pre>' +
            '<script>document.getElementById("b").onclick=async()=>{const f=document.getElementById("f").files[0];const o=document.getElementById("o");if(!f){o.textContent="escolha o arquivo";return}try{const nome=(f.name||"").toLowerCase();if(nome.endsWith(".json")){const dados=JSON.parse(await f.text());const todas=Array.isArray(dados.etiquetas)?dados.etiquetas:[];if(!todas.length){o.textContent="o JSON não tem etiquetas";return}const TAM=60;const agg={total:todas.length,anexadas:0,casadas:[],sem_pedido:[],ambiguas:[],invalidas:[]};for(let i=0;i<todas.length;i+=TAM){o.textContent="enviando "+Math.min(i+TAM,todas.length)+" de "+todas.length+"…";const r=await fetch("' + PREFIXO + '/etiquetas-zpl-massa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({etiquetas:todas.slice(i,i+TAM)})});const j=await r.json();if(!j.ok){o.textContent="erro no lote: "+JSON.stringify(j);return}agg.anexadas+=j.anexadas;agg.casadas.push(...j.casadas);agg.sem_pedido.push(...j.sem_pedido);agg.ambiguas.push(...j.ambiguas);agg.invalidas.push(...j.invalidas)}o.textContent=JSON.stringify(agg,null,2);return}o.textContent="enviando e decodificando (uns segundos)…";const buf=await f.arrayBuffer();let b64="";const u8=new Uint8Array(buf);for(let i=0;i<u8.length;i+=32768){b64+=String.fromCharCode.apply(null,u8.subarray(i,i+32768))}b64=btoa(b64);const r=await fetch("' + PREFIXO + '/etiquetas-zpl-massa",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({arquivo_base64:b64})});const j=await r.json();o.textContent=JSON.stringify(j,null,2)}catch(e){o.textContent="erro: "+e.message}};</script>' +
            '</body></html>');
          return true;
        }
    return false;
  }

  return { handle };
}

module.exports = { criarRotasLote };
