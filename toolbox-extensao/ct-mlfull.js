// ═══════════════════════════════════════════════════════════════════════════
//  NF-e do MERCADO LIVRE FULL -> BLING   (Girassol — Toolbox 2.1.5, 02/10)
// ═══════════════════════════════════════════════════════════════════════════
//  Pedido do dono: "faz igual da AMB — roda automaticamente quando eu entro no
//  Bling e já sobe no Bling. Não quero ficar baixando nada."
//
//  Quem ACHA as notas é o servidor: a vigia das 3h do Mover-Pedidos confere a
//  semana do Full contra o Bling e guarda o XML de toda nota que a integração
//  nativa perdeu. Este bloco, ao abrir o Bling, pergunta o que está pendente,
//  baixa o ZIP (em lotes), sobe no IMPORTADOR DO PRÓPRIO BLING — na sessão real
//  do dono, a mesma tela de "Importar notas fiscais" — e avisa o servidor do
//  que entrou, que tira essas notas da fila.
//
//  Igual ao Magalu/Shopee Full: INVISÍVEL quando não há nada; aparece só
//  quando importa, dá erro ou falta configurar. Ctrl+Alt+L chama na mão.
//
//  Como lança (espelha a nativa do ML Full): loja Mercado Livre, Lançar
//  CONTAS: NÃO, Lançar ESTOQUE: NÃO (o estoque do Full está no CD do ML).
//  Unidade de negócio: a "Full" do Mercado Livre se a conta tiver uma (lida da
//  própria tela do importador); sem ela, nenhuma.
//
//  Segurança: só roda na instância da Girassol (tb_empresa) e com VÍNCULO de
//  conta — a 1ª importação grava o idEmpresa desta sessão; outra conta do
//  Bling (ex.: GOOD logada no mesmo navegador) = recusa, nada é importado.
//  O servidor confere o mesmo vínculo.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const EMPRESAS_ML_FULL = ['girassol'];            // AMB/GOOD: a nativa cobre 100% (medido 08-11/09)
  const LOJA_ML = { girassol: '203146903' };        // loja Mercado Livre no Bling (lib/fiscal/bling-api.js)
  const NOME = { girassol: 'Girassol' };
  const CFG_PADRAO = {
    servidor: 'https://mover-pedidos-aguardando-x-atendido.onrender.com',   // mesmo servidor/chave do bloco Magalu
    chave: '',
    mlf_automatico: true,
    mlf_unidade: ''                                  // vazio = descobrir pela tela; numero = forcar
  };
  const MAX_VOLTAS = 20;                             // lotes por abertura (100 notas cada no servidor)

  const API = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
  function lerCfg() {
    if (API !== chrome) return API.storage.local.get(CFG_PADRAO).then(v => Object.assign({}, CFG_PADRAO, v || {})).catch(() => Object.assign({}, CFG_PADRAO));
    return new Promise(ok => { try { chrome.storage.local.get(CFG_PADRAO, v => ok(Object.assign({}, CFG_PADRAO, v || {}))); } catch (e) { ok(Object.assign({}, CFG_PADRAO)); } });
  }
  function salvar(v) {
    if (API !== chrome) return API.storage.local.set(v).catch(() => {});
    return new Promise(ok => { try { chrome.storage.local.set(v, ok); } catch (e) { ok(); } });
  }
  function lerUm(k) {
    if (API !== chrome) return API.storage.local.get([k]).then(v => (v || {})[k]).catch(() => null);
    return new Promise(ok => { try { chrome.storage.local.get([k], v => ok((v || {})[k])); } catch (e) { ok(null); } });
  }

  let cfg = null, empresa = null, ocupado = false;

  // ── painel (mesma cara do Magalu; fica à esquerda, acima dele) ──
  let elPainel, elMsg, elBtn;
  function montarPainel() {
    if (document.getElementById('mlfull-painel')) return;
    const w = document.createElement('div');
    w.id = 'mlfull-painel';
    w.innerHTML = `
      <style>
        #mlfull-painel{position:fixed;left:16px;bottom:16px;z-index:999999;display:none;
          font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#181b21;color:#e8eaed;
          border:1px solid #2a2f3a;border-radius:10px;width:300px;box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden}
        #mlfull-painel.visivel{display:block}
        #mlfull-painel .cab{background:#0f1115;padding:10px 12px;font-weight:600;display:flex;justify-content:space-between}
        #mlfull-painel .corpo{padding:12px}
        #mlfull-painel button{width:100%;background:#0f9d58;color:#fff;border:0;padding:10px;border-radius:7px;font:inherit;font-weight:600;cursor:pointer;margin-top:8px}
        #mlfull-painel button.cinza{background:#2a2f3a;color:#e8eaed}
        #mlfull-painel button:disabled{opacity:.5;cursor:default}
        #mlfull-painel input{width:100%;box-sizing:border-box;background:#0f1115;color:#e8eaed;border:1px solid #2a2f3a;border-radius:6px;padding:8px;font:inherit;margin-top:6px}
        #mlfull-painel label{font-size:11px;color:#9aa0a6;display:block;margin-top:8px}
        #mlfull-msg{font-size:12px;color:#9aa0a6;white-space:pre-wrap;max-height:220px;overflow:auto}
        #mlfull-painel .cfg{display:none;border-top:1px solid #2a2f3a;margin-top:10px;padding-top:6px}
        #mlfull-painel.cfg-aberta .cfg{display:block}
      </style>
      <div class="cab"><span>NF-e ML Full → Bling</span><span id="mlfull-fechar" style="cursor:pointer" title="fechar (Ctrl+Alt+L chama de volta)">✕</span></div>
      <div class="corpo">
        <div id="mlfull-msg">Verificando…</div>
        <button id="mlfull-btn" disabled>Aguarde…</button>
        <button id="mlfull-cfgbtn" class="cinza">Configurar</button>
        <div class="cfg">
          <label>Servidor (Mover-Pedidos)</label><input id="mlfull-serv">
          <label>ADMIN_KEY do Mover-Pedidos</label><input id="mlfull-chave" type="password" placeholder="cole a chave">
          <label style="display:flex;align-items:center;gap:6px;margin-top:10px"><input type="checkbox" id="mlfull-auto" style="width:auto;margin:0"> importar sozinho ao abrir o Bling</label>
          <button id="mlfull-salvar" class="cinza">Salvar</button>
        </div>
      </div>`;
    document.body.appendChild(w);
    elPainel = w; elMsg = w.querySelector('#mlfull-msg'); elBtn = w.querySelector('#mlfull-btn');
    w.querySelector('#mlfull-cfgbtn').addEventListener('click', () => w.classList.toggle('cfg-aberta'));
    w.querySelector('#mlfull-fechar').addEventListener('click', () => w.classList.remove('visivel'));
    w.querySelector('#mlfull-salvar').addEventListener('click', async () => {
      await salvar({
        servidor: w.querySelector('#mlfull-serv').value.trim().replace(/\/+$/, '') || CFG_PADRAO.servidor,
        chave: w.querySelector('#mlfull-chave').value.trim(),
        mlf_automatico: w.querySelector('#mlfull-auto').checked
      });
      cfg = await lerCfg();
      w.classList.remove('cfg-aberta');
      msg('Configuração salva. Verificando…');
      verificar(true);
    });
    elBtn.addEventListener('click', () => { if (!ocupado) rodar(); });
    document.addEventListener('keydown', ev => {
      if (ev.ctrlKey && ev.altKey && (ev.key === 'l' || ev.key === 'L')) {
        ev.preventDefault();
        if (elPainel.classList.contains('visivel')) elPainel.classList.remove('visivel');
        else { abrir(); verificar(true); }
      }
    });
  }
  function msg(t, cor) { if (elMsg) { elMsg.textContent = t; elMsg.style.color = cor || '#9aa0a6'; } }
  function abrir() { if (elPainel) elPainel.classList.add('visivel'); }
  let sumirEm = null;
  function sumirDepois(ms) { clearTimeout(sumirEm); sumirEm = setTimeout(() => { if (!ocupado && elPainel) elPainel.classList.remove('visivel'); }, ms); }
  function botao(texto, ativo) { if (elBtn) { elBtn.textContent = texto; elBtn.disabled = !ativo; } }

  // ── a tela do importador: conta (idEmpresa), loja e unidade ──
  function opcoesDoSelect(html, reIdOuNome) {
    const ops = [];
    const reSel = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    let m;
    while ((m = reSel.exec(html))) {
      if (!reIdOuNome.test(m[1])) continue;
      const reOp = /<option\b[^>]*value\s*=\s*["']?([^"'\s>]*)["']?[^>]*>([\s\S]*?)<\/option>/gi;
      let o;
      while ((o = reOp.exec(m[2]))) ops.push({ valor: String(o[1]).trim(), texto: String(o[2]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() });
    }
    return ops;
  }
  async function lerTelaDoImportador() {
    const r = await fetch('/importador.notas.fiscais.lote.php', { credentials: 'include' });
    const html = await r.text();
    if (/location\.href\s*=\s*["'][^"']*\/login/i.test(html)) throw new Error('SESSAO: você não está logado no Bling');
    const m = /initForm\s*\(\s*(\d+)/.exec(html);
    if (!m) throw new Error('não achei o idEmpresa na tela do importador do Bling');
    return { idEmpresa: m[1], html };
  }
  function escolherUnidade(html) {
    if (cfg.mlf_unidade && /^\d+$/.test(String(cfg.mlf_unidade))) return { valor: String(cfg.mlf_unidade), como: 'configurada' };
    const ops = opcoesDoSelect(html, /unidade/i).filter(o => /^\d+$/.test(o.valor));
    const doFull = ops.filter(o => /full/i.test(o.texto) && /(mercado\s*livre|mlivre|meli|\bml\b)/i.test(o.texto));
    if (doFull.length === 1) return { valor: doFull[0].valor, como: 'Full do ML: ' + doFull[0].texto };
    if (doFull.length > 1) return { ambigua: doFull.map(o => o.texto + ' (' + o.valor + ')') };
    return { valor: '', como: 'sem unidade (a conta não tem uma "Full" do Mercado Livre)' };
  }

  // ── subir e processar (o mesmo caminho do bloco Magalu) ──
  async function subirZip(idEmpresa, nomeArquivo, blob) {
    const fd = new FormData();
    fd.append('qqfile', blob, nomeArquivo);
    const r = await fetch('/upload.restore.php?idEmpresa=' + encodeURIComponent(idEmpresa), {
      method: 'POST', credentials: 'include',
      headers: { 'Accept': 'application/json, text/javascript', 'X-Requested-With': 'XMLHttpRequest', 'X-File-Name': encodeURIComponent(nomeArquivo) },
      body: fd
    });
    const txt = await r.text();
    if (/location\.href\s*=\s*["'][^"']*\/login/i.test(txt)) throw new Error('SESSAO: o Bling pediu login no meio do upload');
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    if (!j || !j.success || !j.tmp) throw new Error('o upload no Bling não devolveu o arquivo temporário: ' + txt.slice(0, 160));
    return j.tmp;
  }
  // xajax: (nomeArquivo, tipo, loja, unidadeNegocio, lancarContas, lancarEstoque) — tipo 'S' saida | 'E' entrada
  async function processar(tmp, tipo, loja, unidade) {
    const args = [tmp, tipo, loja, unidade, 'false', 'false'];   // contas NAO, estoque NAO (espelha a nativa do Full)
    let corpo = 'xajax=' + encodeURIComponent('validarArquivoNotasFiscais') + '&xajaxr=' + Date.now();
    args.forEach(a => { corpo += '&xajaxargs[]=' + encodeURIComponent(a); });
    const r = await fetch('/services/importador.notas.fiscais.lote.server.php?f=validarArquivoNotasFiscais', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: corpo
    });
    const txt = await r.text();
    if (/location\.href\s*=\s*["'][^"']*\/login/i.test(txt)) throw new Error('SESSAO: o Bling pediu login ao processar');
    if (!r.ok) throw new Error('o Bling respondeu HTTP ' + r.status + ' ao processar o lote');
    return txt;
  }

  // ── estado no servidor ──
  async function lerEstado(idEmpresa) {
    const r = await fetch(cfg.servidor + '/ml-full/ext/estado?empresa=' + encodeURIComponent(empresa) + '&idEmpresa=' + encodeURIComponent(idEmpresa) + '&k=' + encodeURIComponent(cfg.chave));
    let j = null; try { j = await r.json(); } catch (e) {}
    if (r.status === 409 && j && j.erro === 'conta_errada') { const e = new Error('CONTA: ' + (j.mensagem || 'esta sessão do Bling não é a da ' + NOME[empresa])); throw e; }
    if (!r.ok || !j || !j.ok) throw new Error('o servidor não respondeu o estado (HTTP ' + r.status + (j && j.erro ? ' — ' + j.erro : '') + ')');
    return j;
  }

  let tela = null;   // { idEmpresa, html } da última verificação
  async function verificar(forcado) {
    if (ocupado) return;
    if (!cfg.chave) {
      msg('Para importar sozinho as notas do ML Full que faltarem no Bling, cole a ADMIN_KEY do Mover-Pedidos em Configurar (uma vez só).', '#fdd663');
      botao('Não configurado', false);
      elPainel.classList.add('cfg-aberta');
      abrir();
      return;
    }
    try {
      tela = await lerTelaDoImportador();
      const vinc = await lerUm('mlf_vinculo_' + empresa);
      if (vinc && String(vinc) !== String(tela.idEmpresa)) throw new Error('CONTA: esta sessão do Bling (conta ' + tela.idEmpresa + ') NÃO é a da ' + NOME[empresa] + ' (conta ' + vinc + '). Nada foi importado.');
      const j = await lerEstado(tela.idEmpresa);
      if (!j.precisa) {
        msg(NOME[empresa] + ': nenhuma nota do ML Full faltando no Bling.', '#81c995');
        botao('Nada pra importar', false);
        if (forcado) { abrir(); sumirDepois(6000); }
        return;                                       // automatico e nada pendente: fica invisivel
      }
      msg(NOME[empresa] + ': ' + [j.saida ? j.saida + ' de saída' : '', j.entrada ? j.entrada + ' de entrada' : ''].filter(Boolean).join(' e ') + ' do ML Full faltando no Bling.');
      botao('Importar agora', true);
      abrir();
      if (cfg.mlf_automatico || forcado) rodar();
    } catch (e) {
      const t = String(e.message || e);
      if (t.indexOf('SESSAO') === 0) { if (forcado) { msg('Faça login no Bling e recarregue a página.', '#f28b82'); abrir(); } return; }
      msg((t.indexOf('CONTA') === 0 ? '⛔ ' + t.slice(7) : '⚠️ ' + t), '#f28b82');
      botao('Tentar de novo', true);
      abrir();                                         // erro sempre aparece — silencio aqui seria perigoso
    }
  }

  async function rodar() {
    if (ocupado) return;
    ocupado = true; botao('Importando…', false); abrir(); clearTimeout(sumirEm);
    let importadas = 0, jaTinha = 0;
    try {
      if (!tela) tela = await lerTelaDoImportador();
      const loja = LOJA_ML[empresa];
      const lojas = opcoesDoSelect(tela.html, /loja/i).map(o => o.valor);
      if (lojas.length && lojas.indexOf(loja) === -1) throw new Error('a loja Mercado Livre (' + loja + ') não aparece na tela de importar do Bling — nada foi importado. Avise o Claude.');
      const un = escolherUnidade(tela.html);
      if (un.ambigua) throw new Error('a conta tem mais de uma unidade "Full" do Mercado Livre (' + un.ambigua.join(', ') + ') — nada foi importado. Avise o Claude qual é a certa.');
      for (let volta = 0; volta < MAX_VOLTAS; volta++) {
        const est = await lerEstado(tela.idEmpresa);
        const fila = [];
        if (est.url_zip_saida) fila.push({ tipo: 'S', url: est.url_zip_saida, rotulo: 'saída' });
        if (est.url_zip_entrada) fila.push({ tipo: 'E', url: est.url_zip_entrada, rotulo: 'entrada' });
        if (!fila.length) break;
        for (const lote of fila) {
          msg('Baixando o lote de ' + lote.rotulo + '…');
          const rz = await fetch(cfg.servidor + lote.url);
          if (!rz.ok) throw new Error('não consegui baixar o ZIP de ' + lote.rotulo + ' (HTTP ' + rz.status + ')');
          if (!/zip/i.test(rz.headers.get('Content-Type') || '')) continue;   // o lote esvaziou entre o estado e o download
          const chaves = String(rz.headers.get('X-Chaves') || '').split(',').map(s => s.trim()).filter(s => /^\d{44}$/.test(s));
          if (!chaves.length) throw new Error('o servidor não disse quais notas vieram no ZIP (X-Chaves) — nada foi registrado');
          const blob = await rz.blob();
          if (blob.size > 3000000) throw new Error('o lote de ' + lote.rotulo + ' tem ' + Math.round(blob.size / 1000) + ' KB e o Bling só aceita 3 MB');
          msg('Enviando ' + chaves.length + ' nota' + (chaves.length === 1 ? '' : 's') + ' de ' + lote.rotulo + ' pro Bling…');
          const tmp = await subirZip(tela.idEmpresa, 'ml-full-' + empresa + '-' + (lote.tipo === 'S' ? 'SAIDA' : 'ENTRADA') + '-' + Date.now() + '.zip', blob);
          const res = resumirImportacaoBling(await processar(tmp, lote.tipo, loja, un.valor));
          if (res.corpo_vazio) throw new Error('o Bling devolveu resposta VAZIA ao processar — nada foi registrado; tente de novo');
          if (res.falhas_reais) throw new Error(res.falhas_reais + ' nota(s) de ' + lote.rotulo + ' o Bling NÃO importou:\n' + String(res.trecho || '').slice(0, 220) + '\nNada foi tirado da fila — vão tentar de novo na próxima abertura.');
          const rr = await fetch(cfg.servidor + '/ml-full/ext/registrar?k=' + encodeURIComponent(cfg.chave), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ empresa, idEmpresa: tela.idEmpresa, importadas: chaves })
          });
          let jr = null; try { jr = await rr.json(); } catch (e) {}
          if (!rr.ok || !jr || !jr.ok) throw new Error('as notas ENTRARAM no Bling, mas o servidor não registrou (HTTP ' + rr.status + ') — elas vão reaparecer e o Bling vai dizer que já existem (sem duplicar)');
          // trava de laco: registrar que nao tira NADA da fila faria a proxima volta reimportar o mesmo lote
          if (!jr.arquivadas) throw new Error('o servidor não tirou essas notas da fila (não achou ' + ((jr.nao_achadas || []).length) + ') — parei pra não repetir o mesmo lote');
          await salvar({ ['mlf_vinculo_' + empresa]: tela.idEmpresa });   // 1a importacao boa fixa a conta
          jaTinha += Math.min(res.ja_registradas || 0, chaves.length);
          importadas += Math.max(0, chaves.length - (res.ja_registradas || 0));
        }
      }
      msg('✅ ' + NOME[empresa] + ': ' + importadas + ' nota' + (importadas === 1 ? '' : 's') + ' do ML Full importada' + (importadas === 1 ? '' : 's') + ' no Bling' + (jaTinha ? ' (' + jaTinha + ' já estavam lá)' : '') + '.', '#81c995');
      botao('Pronto', false);
      sumirDepois(10000);
    } catch (e) {
      const t = String(e.message || e);
      msg((t.indexOf('SESSAO') === 0 ? 'A sessão do Bling caiu. Faça login e recarregue.' : t.indexOf('CONTA') === 0 ? '⛔ ' + t.slice(7) : '⚠️ ' + t) +
          (importadas || jaTinha ? '\n(antes disso: ' + importadas + ' importada(s), ' + jaTinha + ' já estavam)' : ''), '#f28b82');
      botao('Tentar de novo', true);
    } finally {
      ocupado = false;
    }
  }

  // ── início ──
  (async function () {
    const tbEmp = await lerUm('tb_empresa');
    if (EMPRESAS_ML_FULL.indexOf(tbEmp) === -1) return;   // so a instancia da Girassol acorda
    empresa = tbEmp;
    if (typeof resumirImportacaoBling !== 'function') return;   // tb-importacao.js e carregado antes (manifest)
    montarPainel();
    cfg = await lerCfg();
    elPainel.querySelector('#mlfull-serv').value = cfg.servidor;
    elPainel.querySelector('#mlfull-chave').value = cfg.chave;
    elPainel.querySelector('#mlfull-auto').checked = !!cfg.mlf_automatico;
    verificar(false);
  })();
})();
