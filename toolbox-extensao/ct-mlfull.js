// ═══════════════════════════════════════════════════════════════════════════
//  NF-e do MERCADO LIVRE FULL -> BLING   (multiloja — Toolbox 2.1.6, 02/10)
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
//  MULTILOJA: nenhuma empresa fixa aqui. A instância pergunta ao servidor pela
//  empresa dela (tb_empresa); quem decide se importa é o CONTRATO de empresas
//  (capacidade 'ml-full') e a loja Mercado Livre vem do servidor ou, sem ela,
//  é achada pelo NOME na tela do importador. CNPJ novo = contrato + envs no
//  servidor; esta extensão já funciona nele sem código novo.
//
//  Segurança: a PRIMEIRA importação numa conta do Bling espera o dono confirmar
//  (um clique: "esta conta é da Girassol"); depois, só importa com VÍNCULO de
//  conta — a 1ª importação grava o idEmpresa desta sessão; outra conta do
//  Bling (ex.: GOOD logada no mesmo navegador) = recusa, nada é importado.
//  O servidor confere o mesmo vínculo.
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const CFG_PADRAO = {
    servidor: 'https://mover-pedidos-aguardando-x-atendido.onrender.com',   // mesmo servidor/chave do bloco Magalu
    chave: '',
    mlf_automatico: true,
    mlf_unidade: '',                                 // vazio = descobrir pela tela; numero = forcar
    mlf_loja: ''                                     // idem pra loja (Codex #578: canal ML ambiguo = o dono escolhe 1x)
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

  let cfg = null, empresa = null, nome = '', ocupado = false;

  // ── painel (mesma cara do Magalu; fica à esquerda, acima dele) ──
  let elPainel, elMsg, elBtn, elOpcoes;
  let modoBtn = 'importar';                          // importar | vincular | nada
  function montarPainel() {
    if (document.getElementById('mlfull-painel')) return;
    const w = document.createElement('div');
    w.id = 'mlfull-painel';
    w.innerHTML = `
      <style>
        #mlfull-painel{position:fixed;left:322px;bottom:16px;z-index:999999;display:none;
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
        <div id="mlfull-opcoes"></div>
        <button id="mlfull-btn" disabled>Aguarde…</button>
        <button id="mlfull-cfgbtn" class="cinza">Configurar</button>
        <div class="cfg">
          <label>Servidor (Mover-Pedidos)</label><input id="mlfull-serv">
          <label>ADMIN_KEY do Mover-Pedidos</label><input id="mlfull-chave" type="password" placeholder="cole a chave">
          <label style="display:flex;align-items:center;gap:6px;margin-top:10px"><input type="checkbox" id="mlfull-auto" style="width:auto;margin:0"> importar sozinho ao abrir o Bling</label>
          <label>Loja Mercado Livre no Bling (ID — opcional)</label><input id="mlfull-loja" placeholder="em branco = automático">
          <label>Unidade de negócio (ID — opcional)</label><input id="mlfull-unidade" placeholder="em branco = automático">
          <button id="mlfull-salvar" class="cinza">Salvar</button>
        </div>
      </div>`;
    document.body.appendChild(w);
    elPainel = w; elMsg = w.querySelector('#mlfull-msg'); elBtn = w.querySelector('#mlfull-btn'); elOpcoes = w.querySelector('#mlfull-opcoes');
    w.querySelector('#mlfull-cfgbtn').addEventListener('click', () => w.classList.toggle('cfg-aberta'));
    w.querySelector('#mlfull-fechar').addEventListener('click', () => w.classList.remove('visivel'));
    w.querySelector('#mlfull-salvar').addEventListener('click', async () => {
      const soDigitos = (x) => (/^\d+$/.test(String(x || '').trim()) ? String(x).trim() : '');
      await salvar({
        servidor: w.querySelector('#mlfull-serv').value.trim().replace(/\/+$/, '') || CFG_PADRAO.servidor,
        chave: w.querySelector('#mlfull-chave').value.trim(),
        mlf_automatico: w.querySelector('#mlfull-auto').checked,
        mlf_loja: soDigitos(w.querySelector('#mlfull-loja').value),
        mlf_unidade: soDigitos(w.querySelector('#mlfull-unidade').value)
      });
      cfg = await lerCfg();
      w.classList.remove('cfg-aberta');
      msg('Configuração salva. Verificando…');
      verificar(true);   // so MOSTRA o estado; importa sozinho apenas se o automatico estiver ligado
    });
    elBtn.addEventListener('click', () => {
      if (ocupado) return;
      if (modoBtn === 'vincular') vincular();
      else if (modoBtn === 'importar') rodar();
      else verificar(true);
    });
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
  function botao(texto, ativo, modo) { if (elBtn) { elBtn.textContent = texto; elBtn.disabled = !ativo; } modoBtn = modo || (ativo ? 'importar' : 'nada'); }
  function limparOpcoes() { if (elOpcoes) { elOpcoes.innerHTML = ''; } }
  /* Escolha que o dono faz UMA vez (loja ML ou unidade ambigua): um botao por candidato; o
     clique grava na config desta instancia e retoma a importacao. */
  function oferecerOpcoes(chaveCfg, lista) {
    limparOpcoes();
    lista.forEach(op => {
      const b = document.createElement('button');
      b.className = 'cinza';
      b.textContent = 'Usar: ' + op.texto + ' (' + op.valor + ')';
      b.addEventListener('click', async () => {
        await salvar({ [chaveCfg]: op.valor });
        cfg = await lerCfg();
        const campo = elPainel.querySelector(chaveCfg === 'mlf_loja' ? '#mlfull-loja' : '#mlfull-unidade');
        if (campo) campo.value = op.valor;
        limparOpcoes();
        rodar();
      });
      elOpcoes.appendChild(b);
    });
  }

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
  /* Codex #578 (P1): o fetch SEGUE o redirect HTTP — sessao vencida vira a PAGINA de login com
     status 200 e corpo cheio. Redirect (ou URL final de login, ou formulario de senha) = SESSAO,
     nunca "o Bling respondeu". */
  function ehLogin(r, txt) {
    return !!(r && (r.redirected || /\/login/i.test(String(r.url || '')))) ||
      /location\.href\s*=\s*["'][^"']*\/login/i.test(txt) || /<input[^>]+type=["']?password/i.test(txt);
  }
  async function lerTelaDoImportador() {
    const r = await fetch('/importador.notas.fiscais.lote.php', { credentials: 'include' });
    const html = await r.text();
    if (ehLogin(r, html)) throw new Error('SESSAO: você não está logado no Bling');
    const m = /initForm\s*\(\s*(\d+)/.exec(html);
    if (!m) throw new Error('não achei o idEmpresa na tela do importador do Bling');
    return { idEmpresa: m[1], html };
  }
  function escolherLoja(html, lojasDoServidor) {
    const ops = opcoesDoSelect(html, /loja/i).filter(o => /^\d+$/.test(o.valor));
    const porValor = new Map(ops.map(o => [o.valor, o]));
    if (cfg.mlf_loja && /^\d+$/.test(String(cfg.mlf_loja))) {
      if (!ops.length || porValor.has(String(cfg.mlf_loja))) return { valor: String(cfg.mlf_loja) };
      return { erro: 'a loja configurada (' + cfg.mlf_loja + ') não aparece na tela de importar do Bling' };
    }
    const doServ = (lojasDoServidor || []).map(String).filter(id => !ops.length || porValor.has(id));
    /* Codex #578 (P2): a env do F1 pode listar MAIS DE UM canal ML e o lote nao e separado por
       canal — escolher o primeiro jogaria nota de um canal no outro. Mais de um = o dono escolhe. */
    if (doServ.length === 1) return { valor: doServ[0] };
    if (doServ.length > 1) return { escolher: doServ.map(id => porValor.get(id) || { valor: id, texto: 'loja ' + id }) };
    if ((lojasDoServidor || []).length && ops.length) return { erro: 'a loja Mercado Livre do servidor (' + lojasDoServidor.join(', ') + ') não aparece na tela de importar do Bling' };
    const ml = ops.filter(o => /mercado\s*livre|mercadolivre/i.test(o.texto));
    if (ml.length === 1) return { valor: ml[0].valor };
    if (ml.length > 1) return { escolher: ml };
    return { erro: 'não achei a loja Mercado Livre na tela de importar do Bling' };
  }
  function escolherUnidade(html) {
    if (cfg.mlf_unidade && /^\d+$/.test(String(cfg.mlf_unidade))) return { valor: String(cfg.mlf_unidade), como: 'configurada' };
    const ops = opcoesDoSelect(html, /unidade/i).filter(o => /^\d+$/.test(o.valor));
    const doFull = ops.filter(o => /full/i.test(o.texto) && /(mercado\s*livre|mlivre|meli|\bml\b)/i.test(o.texto));
    if (doFull.length === 1) return { valor: doFull[0].valor, como: 'Full do ML: ' + doFull[0].texto };
    if (doFull.length > 1) return { ambigua: doFull };
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
    if (ehLogin(r, txt)) throw new Error('SESSAO: o Bling pediu login no meio do upload');
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
    if (ehLogin(r, txt)) throw new Error('SESSAO: o Bling pediu login ao processar — nada foi registrado');
    if (!r.ok) throw new Error('o Bling respondeu HTTP ' + r.status + ' ao processar o lote');
    return txt;
  }

  // ── estado no servidor ──
  async function lerEstado(idEmpresa) {
    const r = await fetch(cfg.servidor + '/ml-full/ext/estado?empresa=' + encodeURIComponent(empresa) + '&idEmpresa=' + encodeURIComponent(idEmpresa) + '&k=' + encodeURIComponent(cfg.chave));
    let j = null; try { j = await r.json(); } catch (e) {}
    if (r.status === 409 && j && j.erro === 'conta_errada') { const e = new Error('CONTA: ' + (j.mensagem || 'esta sessão do Bling não é a da ' + nome)); throw e; }
    if (!r.ok || !j || !j.ok) throw new Error('o servidor não respondeu o estado (HTTP ' + r.status + (j && j.erro ? ' — ' + j.erro : '') + ')');
    return j;
  }

  let tela = null;   // { idEmpresa, html } da última verificação
  async function verificar(forcado) {
    if (ocupado) return;
    limparOpcoes();
    if (!cfg.chave) {
      // multiloja: sem a chave nao da pra perguntar se a empresa usa o Full — pede no maximo 1x por dia
      const hoje = new Date().toISOString().slice(0, 10);
      if (!forcado && (await lerUm('mlf_pediu_chave_em')) === hoje) return;
      await salvar({ mlf_pediu_chave_em: hoje });
      msg('Para importar sozinho as notas do ML Full que faltarem no Bling, cole a ADMIN_KEY do Mover-Pedidos em Configurar (uma vez só).', '#fdd663');
      botao('Não configurado', false);
      elPainel.classList.add('cfg-aberta');
      abrir();
      return;
    }
    try {
      tela = await lerTelaDoImportador();
      const j = await lerEstado(tela.idEmpresa);
      if (j.nome) nome = j.nome;
      if (!j.habilitada) { if (forcado) { msg(nome + ': o Full do ML não está habilitado para esta empresa no servidor.'); botao('Nada pra importar', false); abrir(); sumirDepois(6000); } return; }
      /* Codex #578 (P1): a 1a importacao so acontece depois de o DONO confirmar que esta conta do
         Bling e a da empresa — sem isso, abrir o Bling de outra empresa no mesmo navegador
         importaria la. Um clique, uma vez; o servidor guarda e confere dali em diante. */
      if (j.vinculo_pendente) {
        if (!j.precisa && !forcado) return;           // nada esperando: nem pergunta ainda
        msg((j.precisa ? (j.saida + j.entrada) + ' nota(s) do ML Full esperando para entrar no Bling.\n\n' : '') +
            'Primeira vez nesta conta do Bling (nº ' + tela.idEmpresa + '). Esta conta é da ' + nome + '?\nSó importo depois da sua confirmação — uma vez só.', '#fdd663');
        botao('Sim, esta conta é da ' + nome, true, 'vincular');
        abrir();
        return;
      }
      if (!j.precisa) {
        msg(nome + ': nenhuma nota do ML Full faltando no Bling.', '#81c995');
        botao('Nada pra importar', false);
        if (forcado) { abrir(); sumirDepois(6000); }
        return;                                       // nada pendente: fica invisivel
      }
      msg(nome + ': ' + [j.saida ? j.saida + ' de saída' : '', j.entrada ? j.entrada + ' de entrada' : ''].filter(Boolean).join(' e ') + ' do ML Full faltando no Bling.');
      botao('Importar agora', true, 'importar');
      abrir();
      // Codex #578 (P2): importa sozinho SO com o automatico ligado — abrir na mao ou salvar a config so mostra
      if (cfg.mlf_automatico) rodar();
    } catch (e) {
      const t = String(e.message || e);
      if (t.indexOf('SESSAO') === 0) { if (forcado) { msg('Faça login no Bling e recarregue a página.', '#f28b82'); abrir(); } return; }
      msg((t.indexOf('CONTA') === 0 ? '⛔ ' + t.slice(7) : '⚠️ ' + t), '#f28b82');
      botao('Tentar de novo', true, 'verificar');
      abrir();                                         // erro sempre aparece — silencio aqui seria perigoso
    }
  }

  async function vincular() {
    if (ocupado || !tela) return;
    ocupado = true; botao('Confirmando…', false);
    try {
      const r = await fetch(cfg.servidor + '/ml-full/ext/vincular?k=' + encodeURIComponent(cfg.chave), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ empresa, idEmpresa: tela.idEmpresa })
      });
      let j = null; try { j = await r.json(); } catch (e) {}
      if (r.status === 409) throw new Error('CONTA: o servidor já tem OUTRA conta do Bling ligada à ' + nome + ' (nº ' + ((j && j.idEmpresa_vinculado) || '?') + '). Nada foi importado.');
      if (!r.ok || !j || !j.ok) throw new Error('não consegui confirmar a conta no servidor (HTTP ' + r.status + ') — tente de novo');
    } catch (e) {
      const t = String(e.message || e);
      msg(t.indexOf('CONTA') === 0 ? '⛔ ' + t.slice(7) : '⚠️ ' + t, '#f28b82');
      botao('Tentar de novo', true, 'verificar');
      ocupado = false;
      return;
    }
    ocupado = false;
    msg('Conta confirmada. Verificando…');
    await verificar(true);
    if (modoBtn === 'importar' && !ocupado) rodar();   // o dono acabou de confirmar: importa o que estava esperando
  }

  async function rodar() {
    if (ocupado) return;
    ocupado = true;
    /* Codex #578: trava entre ABAS do Bling (o content script roda em todas) — storage compartilhado, com validade. */
    const meuLock = Date.now() + ':' + Math.random().toString(36).slice(2);
    const lk = await lerUm('mlf_lock');
    if (lk && lk.t && Date.now() - lk.t < 10 * 60 * 1000) { ocupado = false; return; }   // outra aba esta importando
    await salvar({ mlf_lock: { id: meuLock, t: Date.now() } });
    await new Promise(r => setTimeout(r, 250));
    const lk2 = await lerUm('mlf_lock');
    if (!lk2 || lk2.id !== meuLock) { ocupado = false; return; }                           // perdi a corrida
    botao('Importando…', false); abrir(); clearTimeout(sumirEm);
    let importadas = 0, jaTinha = 0;
    try {
      limparOpcoes();
      if (!tela) tela = await lerTelaDoImportador();
      const est0 = await lerEstado(tela.idEmpresa);
      if (!est0.habilitada) { msg(nome + ': o Full do ML não está habilitado para esta empresa no servidor.'); botao('Nada pra importar', false); return; }
      if (est0.vinculo_pendente) { ocupado = false; await verificar(true); return; }   // confirma a conta antes
      const lj = escolherLoja(tela.html, est0.lojas_ml);
      if (lj.escolher) {
        msg('Há mais de uma loja Mercado Livre no Bling desta conta. Em qual entram as notas do Full? (escolha uma vez)', '#fdd663');
        oferecerOpcoes('mlf_loja', lj.escolher); botao('Aguardando a escolha', false); return;
      }
      if (lj.erro) throw new Error(lj.erro + ' — nada foi importado. Avise o Claude.');
      const loja = lj.valor;
      const un = escolherUnidade(tela.html);
      if (un.ambigua) {
        msg('A conta tem mais de uma unidade "Full" do Mercado Livre. Em qual entram as notas? (escolha uma vez)', '#fdd663');
        oferecerOpcoes('mlf_unidade', un.ambigua); botao('Aguardando a escolha', false); return;
      }
      for (let volta = 0; volta < MAX_VOLTAS; volta++) {
        const est = await lerEstado(tela.idEmpresa);
        const fila = [];
        if (est.url_zip_saida) fila.push({ tipo: 'S', url: est.url_zip_saida, rotulo: 'saída' });
        if (est.url_zip_entrada) fila.push({ tipo: 'E', url: est.url_zip_entrada, rotulo: 'entrada' });
        if (!fila.length) break;
        for (const lote of fila) {
          /* Codex #578 (P1): ZIP acima de 3 MB nao trava a fila — o lote cai pela metade ate caber
             (a URL do estado vem com &max=; aqui ela e reescrita). */
          let tam = parseInt((/[?&]max=(\d+)/.exec(lote.url) || [])[1] || '100', 10) || 100;
          let rz = null, blob = null, chaves = [];
          for (;;) {
            msg('Baixando o lote de ' + lote.rotulo + ' (até ' + tam + ' notas)…');
            const url = /[?&]max=\d+/.test(lote.url) ? lote.url.replace(/([?&])max=\d+/, '$1max=' + tam) : lote.url + '&max=' + tam;
            rz = await fetch(cfg.servidor + url);
            if (!rz.ok) throw new Error('não consegui baixar o ZIP de ' + lote.rotulo + ' (HTTP ' + rz.status + ')');
            if (!/zip/i.test(rz.headers.get('Content-Type') || '')) { blob = null; break; }   // o lote esvaziou entre o estado e o download
            chaves = String(rz.headers.get('X-Chaves') || '').split(',').map(s => s.trim()).filter(s => /^\d{44}$/.test(s));
            if (!chaves.length) throw new Error('o servidor não disse quais notas vieram no ZIP (X-Chaves) — nada foi registrado');
            blob = await rz.blob();
            if (blob.size <= 3000000) break;
            if (tam <= 1) throw new Error('uma única nota de ' + lote.rotulo + ' passa de 3 MB — o Bling não aceita; avise o Claude');
            tam = Math.max(1, Math.floor(tam / 2));
          }
          if (!blob) continue;
          msg('Enviando ' + chaves.length + ' nota' + (chaves.length === 1 ? '' : 's') + ' de ' + lote.rotulo + ' pro Bling…');
          const tmp = await subirZip(tela.idEmpresa, 'ml-full-' + empresa + '-' + (lote.tipo === 'S' ? 'SAIDA' : 'ENTRADA') + '-' + Date.now() + '.zip', blob);
          const res = resumirImportacaoBling(await processar(tmp, lote.tipo, loja, un.valor));
          if (res.corpo_vazio) throw new Error('o Bling devolveu resposta VAZIA ao processar — nada foi registrado; tente de novo');
          if (res.eram_de_entrada) throw new Error(res.eram_de_entrada + ' nota(s) de ' + lote.rotulo + ' o Bling reconheceu como ENTRADA ("Para importar notas de entrada") — nada foi registrado; avise o Claude.');
          if (res.falhas_reais) throw new Error(res.falhas_reais + ' nota(s) de ' + lote.rotulo + ' o Bling NÃO importou:\n' + String(res.trecho || '').slice(0, 220) + '\nNada foi tirado da fila — vão tentar de novo na próxima abertura.');
          const rr = await fetch(cfg.servidor + '/ml-full/ext/registrar?k=' + encodeURIComponent(cfg.chave), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ empresa, idEmpresa: tela.idEmpresa, importadas: chaves })
          });
          let jr = null; try { jr = await rr.json(); } catch (e) {}
          if (!rr.ok || !jr || !jr.ok) throw new Error('as notas ENTRARAM no Bling, mas o servidor não registrou (HTTP ' + rr.status + ') — elas vão reaparecer e o Bling vai dizer que já existem (sem duplicar)');
          // trava de laco: registrar que nao tira NADA da fila faria a proxima volta reimportar o mesmo lote
          if (!jr.arquivadas) throw new Error('o servidor não tirou essas notas da fila (não achou ' + ((jr.nao_achadas || []).length) + ') — parei pra não repetir o mesmo lote');
          jaTinha += Math.min(res.ja_registradas || 0, chaves.length);
          importadas += Math.max(0, chaves.length - (res.ja_registradas || 0));
        }
      }
      msg('✅ ' + nome + ': ' + importadas + ' nota' + (importadas === 1 ? '' : 's') + ' do ML Full importada' + (importadas === 1 ? '' : 's') + ' no Bling' + (jaTinha ? ' (' + jaTinha + ' já estavam lá)' : '') + '.', '#81c995');
      botao('Pronto', false);
      sumirDepois(10000);
    } catch (e) {
      const t = String(e.message || e);
      msg((t.indexOf('SESSAO') === 0 ? 'A sessão do Bling caiu. Faça login e recarregue.' : t.indexOf('CONTA') === 0 ? '⛔ ' + t.slice(7) : '⚠️ ' + t) +
          (importadas || jaTinha ? '\n(antes disso: ' + importadas + ' importada(s), ' + jaTinha + ' já estavam)' : ''), '#f28b82');
      botao('Tentar de novo', true, 'importar');
    } finally {
      await salvar({ mlf_lock: null });
      ocupado = false;
    }
  }

  // ── início ──
  (async function () {
    const tbEmp = await lerUm('tb_empresa');
    if (!tbEmp) return;                                    // instancia sem empresa escolhida: nada a fazer
    empresa = String(tbEmp); nome = empresa.charAt(0).toUpperCase() + empresa.slice(1);
    if (typeof resumirImportacaoBling !== 'function') return;   // tb-importacao.js e carregado antes (manifest)
    montarPainel();
    cfg = await lerCfg();
    elPainel.querySelector('#mlfull-serv').value = cfg.servidor;
    elPainel.querySelector('#mlfull-chave').value = cfg.chave;
    elPainel.querySelector('#mlfull-auto').checked = !!cfg.mlf_automatico;
    elPainel.querySelector('#mlfull-loja').value = cfg.mlf_loja || '';
    elPainel.querySelector('#mlfull-unidade').value = cfg.mlf_unidade || '';
    verificar(false);
  })();
})();
