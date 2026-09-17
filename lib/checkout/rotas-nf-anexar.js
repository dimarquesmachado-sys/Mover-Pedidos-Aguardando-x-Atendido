'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   ROTAS DE NF ANEXADA E SESSÃO DOS MARKETPLACES — 4ª fatia do passo 4 (16/09/2026).

   `nf-anexar` era a maior das rotas idênticas que restavam (80 linhas), e a única
   com diferença real entre as empresas: o ID DA EMPRESA no aviso ao serviço de
   Devoluções. Isso é configuração, não regra — virou parâmetro (`empresaId`).
   Junto vieram `shopee-sessao` e `ml-sync-fees`, idênticas e do mesmo assunto
   (estado vivo das integrações que o checkout consulta).

   ⚠️ Este handler NÃO valida sessão: quem registra precisa fazê-lo DEPOIS do
   portão do módulo (lição do #480, travada em teste).
   ──────────────────────────────────────────────────────────────────────────── */

function criar(cfg) {
  /* o lint listou o resto: `_mls` é ESTADO VIVO (status do sync de tarifas do ML, lido e
     escrito enquanto roda) e entra por REFERÊNCIA, como o `_bf` da fatia anterior; o resto é
     caminho e rótulo da empresa. Copiar o status faria a rota reportar progresso que não é o
     do sync de verdade. */
  for (const n of ['prefixo', 'empresaId', 'json', 'readBody', 'readJson', 'writeJson',
                   'ensureDir', 'ehAdmin', 'lerChaveAdmin', 'mlSyncFees',
                   'shopeeKeepAlive', 'shopeeSessaoLer', 'CACHE_DIR', 'MANIFEST_FILE',
                   'SHOPEE_ENV_COOKIE', 'VERSAO', 'statusMlSync']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/rotas-nf-anexar: falta ' + n);
  }
  const { prefixo, empresaId, json, readBody, readJson, writeJson, ensureDir, ehAdmin,
          lerChaveAdmin, mlSyncFees, shopeeKeepAlive, shopeeSessaoLer, CACHE_DIR,
          MANIFEST_FILE, SHOPEE_ENV_COOKIE, VERSAO } = cfg;
  const _mls = cfg.statusMlSync;            /* MESMA referência do módulo — não copiar */
  const fs = require('fs');
  const path = require('path');
  const { inflateRawSync } = require('zlib');
  const { writeFileSync, unlinkSync } = fs;

  return async function handle(req, res, urlObj, method, validarSessao) {
    const p = urlObj.pathname;

    if (method === 'POST' && p === (prefixo + '/nf-anexar')) {
      const opN = validarSessao(req.headers['cookie']);
      if (!opN || !ehAdmin(opN)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      let bodyN = {}; try { const _rn = await readBody(req); bodyN = (_rn && typeof _rn === 'object') ? _rn : JSON.parse(_rn || '{}'); } catch (e) {}
      const idN = String(bodyN.id || '').trim();
      const b64N = String(bodyN.pdf_base64 || '').replace(/^data:[^,]*,/, '');
      if (!idN || !b64N) { json(res, 400, { ok: false, erro: 'faltou o id do pedido ou o arquivo' }); return true; }
      let bufN = null; try { bufN = Buffer.from(b64N, 'base64'); } catch (e) {}
      if (!bufN || bufN.length < 100) { json(res, 400, { ok: false, erro: 'arquivo vazio ou inválido' }); return true; }
      const ehPdfN = b => !!(b && b.length > 100 && b.slice(0, 4).toString('utf8') === '%PDF');
      const ehXmlN = b => { if (!b || b.length < 80) return false; const s = b.slice(0, 4000).toString('utf8'); return /<\s*(nfeProc|NFe|infNFe)[\s>]/i.test(s); };
      let pdfN = null, xmlN = null;
      if (ehPdfN(bufN)) pdfN = bufN;
      else if (ehXmlN(bufN)) xmlN = bufN;
      else if (bufN[0] === 0x50 && bufN[1] === 0x4B) {
        try {   // reaproveita a leitura de zip da etiqueta? não: aquela vive dentro do outro if. Aqui é uma leitura simples do diretório central.
          const zl = require('zlib');
          let eo = -1;
          for (let x = bufN.length - 22; x >= 0 && x > bufN.length - 66000; x--) { if (bufN.readUInt32LE(x) === 0x06054b50) { eo = x; break; } }
          if (eo >= 0) {
            const qt = bufN.readUInt16LE(eo + 10); let of = bufN.readUInt32LE(eo + 16);
            for (let k = 0; k < qt && of + 46 < bufN.length; k++) {
              if (bufN.readUInt32LE(of) !== 0x02014b50) break;
              const mt = bufN.readUInt16LE(of + 10), tc = bufN.readUInt32LE(of + 20);
              const fn = bufN.readUInt16LE(of + 28), ex = bufN.readUInt16LE(of + 30), cm = bufN.readUInt16LE(of + 32);
              const lc = bufN.readUInt32LE(of + 42);
              const lf = bufN.readUInt16LE(lc + 26), le = bufN.readUInt16LE(lc + 28);
              const ini = lc + 30 + lf + le;
              const dd = tc > 0 ? bufN.slice(ini, ini + tc) : bufN.slice(ini);
              let conteudo = null;
              try { conteudo = mt === 0 ? dd : zl.inflateRawSync(dd, { finishFlush: zl.constants.Z_SYNC_FLUSH }); } catch (e) {}
              if (conteudo) { if (!pdfN && ehPdfN(conteudo)) pdfN = conteudo; else if (!xmlN && ehXmlN(conteudo)) xmlN = conteudo; }
              of += 46 + fn + ex + cm;
            }
          }
        } catch (e) {}
      }
      if (!pdfN && !xmlN) { json(res, 400, { ok: false, erro: 'não reconheci o arquivo — mande a NF em PDF (DANFE) ou XML' }); return true; }
      const dirN = path.join(CACHE_DIR, String(idN));
      let numeroNF = null, chaveNF = null, emissaoNF = null;
      try {
        ensureDir(dirN);
        // 09/08 (b137, Codex): mata o `nf-simp.json` NA HORA DO ANEXO. A auto-cura do ciclo
        // só apagava quando o ID da NF MUDAVA no Bling — e no caso comum a associação
        // cancelada mantém o mesmo id, então o arquivo da nota velha sobrevivia e a Zebra
        // seguia imprimindo os dados fiscais dela.
        try { fs.unlinkSync(path.join(dirN, 'nf-simp.json')); } catch (e) {}
        // 10/08 (Codex, PR#5): anexo SÓ DE XML também descarta a DANFE anterior — ela é
        // da nota velha (do Bling ou de um anexo passado) e o /danfe//imprimir a serviriam.
        // Vale a última subida: sem PDF novo, melhor SEM danfe (guardas seguram o Bling)
        // do que com a cancelada.
        if (xmlN && !pdfN) { try { fs.unlinkSync(path.join(dirN, 'danfe.pdf')); } catch (e) {} }
        if (pdfN) fs.writeFileSync(path.join(dirN, 'danfe.pdf'), pdfN);
        if (xmlN) {
          fs.writeFileSync(path.join(dirN, 'nf.xml'), xmlN);
          const s = xmlN.toString('utf8');
          const mN = s.match(/<nNF>\s*(\d+)\s*<\/nNF>/i);           if (mN) numeroNF = mN[1];
          const mC = s.match(/(?:<chNFe>\s*|Id="NFe)(\d{44})/i);      if (mC) chaveNF = mC[1];
          const mD = s.match(/<dhEmi>\s*([0-9T:+\-]{19})/i) || s.match(/<dEmi>\s*(\d{4}-\d{2}-\d{2})/i);
          if (mD) emissaoNF = mD[1].replace('T', ' ').slice(0, 19);
        }
      } catch (e) { json(res, 500, { ok: false, erro: 'não consegui salvar o arquivo' }); return true; }
      const aplica = o => {
        if (!o) return o;
        if (pdfN) o.tem_danfe = true;
        if (numeroNF) { o.nf_numero = numeroNF; o.tem_nf = true; }
        if (emissaoNF) o.nf_emissao = emissaoNF;
        if (chaveNF) { o.nf = Object.assign({}, o.nf || {}, { chave: chaveNF, numero: numeroNF || (o.nf && o.nf.numero) }); }
        o.nf_anexada = true;
        return o;
      };
      try { const mm = readJson(MANIFEST_FILE, {}); if (mm[idN]) { aplica(mm[idN]); writeJson(MANIFEST_FILE, mm); } } catch (e) {}
      try { const sn = readJson(path.join(dirN, 'pedido.json'), null); if (sn) writeJson(path.join(dirN, 'pedido.json'), aplica(sn)); } catch (e) {}
      console.log(`[AMBBKP] NF ANEXADA na mão no pedido ${idN} (${pdfN ? 'PDF' : ''}${pdfN && xmlN ? '+' : ''}${xmlN ? 'XML' : ''}${numeroNF ? ', nº ' + numeroNF : ''}) por ${opN}`);
      // ev1 - registra a NF anexada no app DEVOLUCOES (pesquisavel pelo
      // nº da NF e tambem pelo pedido). Fire-and-forget, nunca atrapalha.
      try { require('../lib/avisar-devolucoes')(empresaId, 'nf_anexada', numeroNF || idN, { pedido: idN, chave: chaveNF || '', emissao: emissaoNF || '', quem: (typeof opN === 'string' ? opN : '') || '' }); } catch (e) {}
      json(res, 200, { ok: true, pdf: !!pdfN, xml: !!xmlN, nf_numero: numeroNF, chave: chaveNF, emissao: emissaoNF });
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/shopee-sessao')) {
      const opSh = validarSessao(req.headers['cookie']);
      if (!opSh || !ehAdmin(opSh)) { json(res, 403, { ok: false, erro: 'apenas admin' }); return true; }
      const antes = shopeeSessaoLer();
      const teste = await shopeeKeepAlive();
      const dep   = shopeeSessaoLer();
      json(res, 200, {
        ok: !!teste.ok,
        empresa: 'amb-checkout-offline',
        env_semente: SHOPEE_ENV_COOKIE,
        tem_cookie: !!antes.cookie,
        tam_cookie: (antes.cookie || '').length,
        origem: dep.origem || null,
        atualizado: dep.atualizado || null,
        renovacoes: dep.renovacoes || 0,
        teste,
        versao: VERSAO
      });
      return true;
    }
    if ((method === 'POST' || method === 'GET') && p === (prefixo + '/ml-sync-fees')) {
      const k = lerChaveAdmin(req, urlObj);
      const sessA = validarSessao(req.headers['cookie']);
      const autorizado = (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessA && ehAdmin(sessA));
      if (!autorizado) { json(res, 404, { error: 'not found' }); return true; }
      const soStatus = (urlObj.searchParams && urlObj.searchParams.get('status')) === '1';
      if (_mls.rodando || soStatus) { json(res, 200, { ok: true, rodando: !!_mls.rodando, progresso: _mls.feitos + '/' + _mls.total, ok_ate_agora: _mls.ok, falhas: _mls.falhas, ultimo_inicio: _mls.iniciado_em, erros: _mls.erros || {}, amostras: _mls.amostras || [] }); return true; }
      const dias = Number(urlObj.searchParams.get('dias') || 14);
      mlSyncFees(dias).catch(() => {});
      json(res, 200, { ok: true, iniciado: true, dias, mensagem: 'pesca ML rodando em background — chame de novo p/ ver o progresso' });
      return true;
    }
    return false;
  };
}

module.exports = { criar };
