'use strict';
// ══════════════════════════════════════════════════════════════════════
//  NF-e FULFILLMENT MAGALU -> BLING  (extensao — Edge e Firefox)
// ══════════════════════════════════════════════════════════════════════
//  POR QUE EXTENSAO, E NAO ROBO NO SERVIDOR:
//  o Bling nao tem endpoint de API pra importar XML — conferido na spec
//  oficial (openapi-D-189jcU.json): existe GET /nfe, POST /nfe (que EMITE
//  nota nova), GET /nfe/documento/{chave}, lancar-contas, lancar-estoque...
//  e nenhum "importar". O unico caminho e a tela.
//
//  Tentar a tela DO SERVIDOR exige copiar cookie de sessao — e a sessao do
//  Bling e recusada de fora (redirect pro /login). Aqui dentro da aba nao
//  existe esse problema: a requisicao SAI DA SUA SESSAO, com seu cookie,
//  seu IP, seu navegador. Nao contorna nada — o problema deixa de existir.
//
//  O QUE ELA FAZ:
//   1. Le /importador.notas.fiscais.lote.php e pega o initForm(idEmpresa)
//      -> descobre em QUAL conta Bling voce esta logado agora
//   2. Pergunta ao servidor o que esta pendente pra essa empresa
//   3. Baixa do servidor o ZIP so com as notas de SAIDA (tpNF=1)
//   4. Faz os dois passos do importador, igual a tela faz:
//        POST /upload.restore.php?idEmpresa=...  (multipart, campo "qqfile")
//        POST /services/importador.notas.fiscais.lote.server.php
//             ?f=validarArquivoNotasFiscais   (formato do xajax 0.2.5)
//   5. Le a resposta e avisa o servidor do que aconteceu
//
//  Lancar Contas: SIM.  Lancar Estoque: NAO (o estoque do Full esta no CD
//  da Magalu, nao no galpao — dar baixa aqui seria baixa dupla).
// ══════════════════════════════════════════════════════════════════════

(function () {
  const CFG_PADRAO = {
    servidor: 'https://mover-pedidos-aguardando-x-atendido.onrender.com',
    chave: '',
    automatico: true
  };

  const LOJA = { good: '203381869', amb: '206018666' };
  const UNIDADE = { good: '1726045', amb: '2920232' };
  const NOME = { good: 'GOOD Import', amb: 'AMBTotal' };

  let cfg = null;
  let ocupado = false;

  // ── config ──────────────────────────────────────────────────────────
  //  FUNCIONA NO EDGE E NO FIREFOX. O Firefox expoe "browser" com Promise;
  //  o Edge/Chrome expoe "chrome" com callback. Este trecho aceita os dois
  //  sem precisar de dois arquivos.
  const API = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;

  function lerCfg() {
    return new Promise(ok => {
      try {
        const r = API.storage.local.get(CFG_PADRAO, v => ok(Object.assign({}, CFG_PADRAO, v || {})));
        if (r && typeof r.then === 'function') r.then(v => ok(Object.assign({}, CFG_PADRAO, v || {})));
      } catch (e) { ok(Object.assign({}, CFG_PADRAO)); }
    });
  }
  function salvarCfg(v) {
    return new Promise(ok => {
      try {
        const r = API.storage.local.set(v, ok);
        if (r && typeof r.then === 'function') r.then(ok, ok);
      } catch (e) { ok(); }
    });
  }

  // ── painel flutuante ────────────────────────────────────────────────
  let elPainel, elMsg, elBtn;

  function montarPainel() {
    if (document.getElementById('nfmagalu-painel')) return;

    const wrap = document.createElement('div');
    wrap.id = 'nfmagalu-painel';
    wrap.innerHTML = `
      <style>
        #nfmagalu-painel{position:fixed;right:16px;bottom:16px;z-index:999999;display:none;
          font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
          background:#181b21;color:#e8eaed;border:1px solid #2a2f3a;border-radius:10px;
          width:290px;box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden}
        #nfmagalu-painel.visivel{display:block}
        #nfmagalu-painel .cab{background:#0f1115;padding:10px 12px;font-weight:600;
          display:flex;align-items:center;justify-content:space-between;cursor:pointer}
        #nfmagalu-painel .corpo{padding:12px;display:none}
        #nfmagalu-painel.aberto .corpo{display:block}
        #nfmagalu-painel button{width:100%;background:#0f9d58;color:#fff;border:0;
          padding:10px;border-radius:7px;font:inherit;font-weight:600;cursor:pointer;margin-top:8px}
        #nfmagalu-painel button.cinza{background:#2a2f3a;color:#e8eaed}
        #nfmagalu-painel button:disabled{opacity:.5;cursor:default}
        #nfmagalu-painel input{width:100%;background:#0f1115;color:#e8eaed;border:1px solid #2a2f3a;
          border-radius:6px;padding:8px;font:inherit;margin-top:6px}
        #nfmagalu-painel label{font-size:11px;color:#9aa0a6;display:block;margin-top:8px}
        #nfmagalu-msg{margin-top:10px;font-size:12px;color:#9aa0a6;white-space:pre-wrap;
          max-height:190px;overflow:auto}
        #nfmagalu-painel .cfg{display:none;border-top:1px solid #2a2f3a;margin-top:10px;padding-top:6px}
        #nfmagalu-painel.cfg-aberta .cfg{display:block}
        #nfmagalu-painel a{color:#8ab4f8;font-size:11px;text-decoration:none}
      </style>
      <div class="cab"><span>NF-e Magalu → Bling</span><span><span id="nfmagalu-seta">▾</span> <span id="nfmagalu-fechar" title="fechar (Ctrl+Alt+M para chamar de volta)" style="opacity:.6;padding-left:6px">✕</span></span></div>
      <div class="corpo">
        <div id="nfmagalu-msg">Verificando…</div>
        <button id="nfmagalu-btn" disabled>Aguarde…</button>
        <button id="nfmagalu-cfgbtn" class="cinza">Configurar</button>
        <div class="cfg">
          <label>Servidor</label><input id="nfmagalu-serv" placeholder="https://...onrender.com">
          <label>ADMIN_KEY</label><input id="nfmagalu-chave" type="password" placeholder="cole a chave">
          <label style="display:flex;align-items:center;gap:6px;margin-top:10px">
            <input type="checkbox" id="nfmagalu-auto" style="width:auto;margin:0"> importar sozinho 1x por dia
          </label>
          <button id="nfmagalu-salvar" class="cinza">Salvar</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    elPainel = wrap;
    elMsg = wrap.querySelector('#nfmagalu-msg');
    elBtn = wrap.querySelector('#nfmagalu-btn');

    wrap.querySelector('.cab').addEventListener('click', () => wrap.classList.toggle('aberto'));
    wrap.querySelector('#nfmagalu-cfgbtn').addEventListener('click', () => wrap.classList.toggle('cfg-aberta'));
    wrap.querySelector('#nfmagalu-salvar').addEventListener('click', async () => {
      await salvarCfg({
        servidor: wrap.querySelector('#nfmagalu-serv').value.trim().replace(/\/+$/, ''),
        chave: wrap.querySelector('#nfmagalu-chave').value.trim(),
        automatico: wrap.querySelector('#nfmagalu-auto').checked
      });
      cfg = await lerCfg();
      wrap.classList.remove('cfg-aberta');
      msg('Configuração salva. Verificando…');
      verificar();
    });
    elBtn.addEventListener('click', () => rodar(true));
    wrap.querySelector('#nfmagalu-fechar').addEventListener('click', ev => { ev.stopPropagation(); esconder(); });

    // Ctrl + Alt + M chama o painel a qualquer momento (mesma ideia do
    // Ctrl+Alt+V da extensao de etiquetas).
    document.addEventListener('keydown', ev => {
      if (ev.ctrlKey && ev.altKey && (ev.key === 'm' || ev.key === 'M')) {
        ev.preventDefault();
        if (elPainel.classList.contains('visivel')) esconder();
        else { mostrar(true); verificar(); }
      }
    });
  }

  function msg(t, cor) {
    if (!elMsg) return;
    elMsg.textContent = t;
    elMsg.style.color = cor || '#9aa0a6';
  }
  // O painel fica ESCONDIDO por padrao. So aparece quando tem algo pra
  // dizer: esta trabalhando, deu erro, ou falta configurar. Depois que
  // termina bem, some sozinho em 8 segundos.
  function mostrar(abre) {
    if (!elPainel) return;
    elPainel.classList.add('visivel');
    if (abre) elPainel.classList.add('aberto');
    clearTimeout(sumirEm);
  }
  function esconder() { if (elPainel) elPainel.classList.remove('visivel', 'aberto'); }
  function sumirDepois(ms) {
    clearTimeout(sumirEm);
    sumirEm = setTimeout(esconder, ms);
  }
  function abrir() { mostrar(true); }
  let sumirEm = null;

  // ── passo 0: descobrir em qual conta Bling estamos ──────────────────
  //  A propria pagina do importador chama initForm(<idEmpresa>). E a fonte
  //  mais confiavel: se voce trocar de conta, o numero muda junto.
  async function descobrirIdEmpresa() {
    const r = await fetch('/importador.notas.fiscais.lote.php', { credentials: 'include' });
    const txt = await r.text();
    if (/location\.href\s*=\s*["'][^"']*\/login/i.test(txt)) throw new Error('SESSAO: você não está logado no Bling');
    const m = /initForm\s*\(\s*(\d+)/.exec(txt);
    if (!m) throw new Error('não achei o idEmpresa na página do importador');
    return m[1];
  }

  // ── passo 1: upload do ZIP ──────────────────────────────────────────
  //  Campo "qqfile" — e o nome que o proprio fileuploader.js do Bling usa
  //  (data.append("qqfile", file)).
  async function subirZip(idEmpresa, nomeArquivo, blob) {
    const fd = new FormData();
    fd.append('qqfile', blob, nomeArquivo);
    const r = await fetch('/upload.restore.php?idEmpresa=' + encodeURIComponent(idEmpresa), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json, text/javascript',
        'X-Requested-With': 'XMLHttpRequest',
        'X-File-Name': encodeURIComponent(nomeArquivo)
      },
      body: fd
    });
    const txt = await r.text();
    if (/location\.href\s*=\s*["'][^"']*\/login/i.test(txt)) throw new Error('SESSAO: o Bling pediu login no meio do upload');
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    if (!j || !j.success || !j.tmp) throw new Error('upload não devolveu o tmp: ' + txt.slice(0, 160));
    return j.tmp;
  }

  // ── passo 2: mandar processar (formato do xajax 0.2.5) ──────────────
  //  postData = "xajax="+funcao + "&xajaxr="+timestamp + um "&xajaxargs[]="
  //  por argumento. Ordem dos argumentos: a de validarArquivo() do Bling —
  //  (nomeArquivo, tipo, loja, unidadeNegocio, lancarContas, lancarEstoque)
  //  tipo 'S' = saida (vendas e remessas)  |  'E' = entrada (retorno simbolico)
  //  LANCAR CONTAS so na SAIDA. Numa nota de ENTRADA isso criaria conta a
  //  PAGAR — e retorno simbolico de deposito nao tem pagamento nenhum, e
  //  so movimentacao fiscal. Marcar ali inventaria divida no financeiro.
  //  Lancar estoque nunca: o estoque do Full esta no CD da Magalu.
  async function processar(tmp, empresa, tipo) {
    const lancarContas = (tipo === 'E') ? 'false' : 'true';
    const args = [tmp, tipo, LOJA[empresa], UNIDADE[empresa], lancarContas, 'false'];
    let corpo = 'xajax=' + encodeURIComponent('validarArquivoNotasFiscais') + '&xajaxr=' + Date.now();
    args.forEach(a => { corpo += '&xajaxargs[]=' + encodeURIComponent(a); });

    const r = await fetch('/services/importador.notas.fiscais.lote.server.php?f=validarArquivoNotasFiscais', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: corpo
    });
    const txt = await r.text();
    if (/location\.href\s*=\s*["'][^"']*\/login/i.test(txt)) throw new Error('SESSAO: o Bling pediu login ao processar');
    return txt;
  }

  function resumir(txt) {
    // tira os marcadores de CDATA antes das tags, senao sobra "]]>" no fim
    const limpo = String(txt || '')
      .replace(/<!\[CDATA\[/g, ' ').replace(/\]\]>/g, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const conta = re => (limpo.match(re) || []).length;
    return {
      ja_registradas: conta(/já está registrada|ja esta registrada/gi),
      eram_de_entrada: conta(/Para importar notas de entrada/gi),
      nao_importados: conta(/XML não importado|XML nao importado/gi),
      trecho: limpo.trim().slice(0, 300)
    };
  }

  // ── verificar o que esta pendente ───────────────────────────────────
  let pendente = null;

  async function verificar() {
    if (!cfg.chave) {
      msg('Falta configurar a ADMIN_KEY. Clique em Configurar.', '#f28b82');
      elBtn.disabled = true; elBtn.textContent = 'Não configurado';
      abrir();
      return;
    }
    try {
      const idEmpresa = await descobrirIdEmpresa();
      const r = await fetch(cfg.servidor + '/magalu/nf-full/ext/estado?k=' + encodeURIComponent(cfg.chave) + '&idEmpresa=' + idEmpresa);
      const j = await r.json();
      if (!j.ok) throw new Error(j.erro || 'servidor recusou');

      pendente = Object.assign({ idEmpresa }, j);
      const quem = NOME[j.empresa] || j.empresa;

      // ── VIGIA DO SERVIDOR ──────────────────────────────────────────
      //  A falha perigosa nao e a que grita: e a silenciosa. Se o cron do
      //  servidor parar (servico fora do ar, OAuth da Magalu caido), o
      //  arquivo mais novo simplesmente para de envelhecer — e a extensao
      //  ficaria dizendo "nada novo pra importar", que e verdade e engana.
      //  Por isso: se o ultimo download tem mais de HORAS_LIMITE, aparece
      //  aviso. O cron roda de 5 em 5 horas no maximo (6/12/18/23), entao
      //  12h sem baixar so acontece se algo quebrou.
      const HORAS_LIMITE = 12;
      // O robo pode rodar e nao baixar nada — quando a empresa nao vendeu no
      // Full naquele periodo, a Magalu nao gera pacote. Isso NAO e defeito.
      // Por isso a saude do robo se mede pela ULTIMA VERIFICACAO (verificado_em),
      // nao pelo ultimo download: senao uma empresa de baixo volume acenderia
      // alarme de "travou" so por nao ter venda.
      const verificado = j.verificado_em ? new Date(j.verificado_em) : null;
      const baixado = j.baixado_em ? new Date(j.baixado_em) : null;
      const referencia = verificado || baixado;
      const horas = referencia ? (Date.now() - referencia.getTime()) / 3600000 : null;

      if (!j.arquivo) {
        msg('⚠ ' + quem + ': o servidor nunca baixou nada da Magalu.\n\n' +
            'Confira o serviço no Render — se ele estiver no ar, use o botão\n' +
            '"só ' + (j.empresa === 'good' ? 'GOOD' : 'AMB') + '" no painel do servidor.', '#fdd663');
        elBtn.disabled = true; elBtn.textContent = 'Nada pra importar';
        abrir();
        return;
      }

      if (horas !== null && horas > HORAS_LIMITE) {
        const quando = referencia.toLocaleString('pt-BR');
        msg('⚠ ' + quem + ': o servidor não verifica a Magalu desde ' + quando +
            ' (' + Math.floor(horas) + 'h atrás).\n\n' +
            'O robô deveria rodar às 6h, 12h, 18h e 23h. Alguma coisa travou —\n' +
            'confira o serviço no Render.' +
            (j.precisa ? '\n\nDá pra importar o que já foi baixado assim mesmo.' : ''), '#fdd663');
        elBtn.disabled = !j.precisa;
        elBtn.textContent = j.precisa ? 'Importar mesmo assim' : 'Nada novo';
        abrir();
        return;   // nao importa sozinho: primeiro voce ve o aviso
      }

      // Robo rodou dentro do prazo e a Magalu nao tinha nota no periodo:
      // situacao normal de empresa com pouco volume no Full. Informa em verde
      // e nao abre o painel — nao ha o que voce fazer.
      if (j.sem_notas_no_periodo && !j.precisa) {
        msg(quem + ': sem notas novas no período (o robô verificou e a Magalu não tinha nada).', '#81c995');
        elBtn.disabled = true; elBtn.textContent = 'Nada novo';
        return;
      }
      if (!j.precisa) {
        const q = j.ja_importado_hoje && j.ja_importado_hoje.resumo;
        msg(quem + ': nada novo pra importar.' + (q ? '\n' + q.ja_registradas + ' já registradas, ' + q.nao_importados + ' não importadas.' : ''), '#81c995');
        elBtn.disabled = false; elBtn.textContent = 'Importar de novo';
        return;   // segue escondido: nao ha nada pra voce fazer
      }
      // Mostra as NOVAS, nao o total do arquivo: o servidor manda so o que
      // ainda nao foi importado, entao dizer "95" quando vai 1 confundiria.
      const qS2 = (typeof j.novas_saida === 'number') ? j.novas_saida : (j.novas || 0);
      const qE2 = (typeof j.novas_entrada === 'number') ? j.novas_entrada : 0;
      const partes = [];
      if (qS2) partes.push(qS2 + ' de saída');
      if (qE2) partes.push(qE2 + ' de entrada');
      msg(quem + ': ' + (partes.length ? partes.join(' e ') : 'nada') + ' pra importar.');
      elBtn.disabled = false; elBtn.textContent = 'Importar agora';
      abrir();
      if (cfg.automatico) rodar(false);
    } catch (e) {
      const t = String(e.message || e);
      msg(t.indexOf('SESSAO') === 0 ? 'Faça login no Bling e recarregue a página.' : 'Erro: ' + t, '#f28b82');
      elBtn.disabled = true; elBtn.textContent = 'Indisponível';
      abrir();   // erro sempre aparece — silencio aqui seria perigoso
    }
  }

  // ── executar ────────────────────────────────────────────────────────
  async function rodar(manual) {
    if (ocupado || !pendente || !pendente.arquivo) return;
    ocupado = true;
    elBtn.disabled = true;
    abrir();
    try {
      const feito = [];

      // Uma rodada por tipo. E a MESMA tela do Bling — o que muda e o campo
      // Tipo (S ou E). Por isso sao dois envios, nao dois importadores.
      async function rodada(tipo, url, quantas, rotulo) {
        if (!quantas) return;
        msg('Baixando ' + quantas + ' nota' + (quantas === 1 ? '' : 's') + ' de ' + rotulo + '…');
        const rz = await fetch(cfg.servidor + url);
        if (!rz.ok) throw new Error('não consegui baixar o ZIP de ' + rotulo + ' (HTTP ' + rz.status + ')');
        const blob = await rz.blob();
        if (blob.size > 3000000) throw new Error('o ZIP de ' + rotulo + ' tem ' + Math.round(blob.size / 1000) + ' KB e o Bling só aceita 3 MB.');

        msg('Enviando ' + rotulo + ' (' + Math.round(blob.size / 1024) + ' KB) pro Bling…');
        const nomeEnv = pendente.arquivo.replace('.zip', '-' + rotulo.toUpperCase() + '.zip');
        const tmp = await subirZip(pendente.idEmpresa, nomeEnv, blob);

        msg('Processando ' + rotulo + '…');
        const res = resumir(await processar(tmp, pendente.empresa, tipo));
        feito.push({ tipo, rotulo, quantas, res });

        /* Codex #236 (P1): so registra o lote como importado quando o Bling NAO recusou nenhum
           XML — antes, 200 com "XML nao importado" no corpo registrava tudo mesmo assim, a nota
           falhada sumia do /ext/estado e nunca re-tentava (o painel dizia "Pronto"). Com falha,
           o lote fica pendente e re-tenta inteiro: as que ja entraram viram "ja esta registrada"
           (inofensivo) e o registro acontece quando a rodada fechar limpa. */
        if (!res.nao_importados) {
          try {
            await fetch(cfg.servidor + '/magalu/nf-full/ext/registrar?k=' + encodeURIComponent(cfg.chave), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ empresa: pendente.empresa, arquivo: pendente.arquivo, tipo: tipo, resumo: res })
            });
          } catch (e) { /* registrar e bonus, nao pode derrubar o resultado */ }
        }
      }

      const qS = (typeof pendente.novas_saida === 'number') ? pendente.novas_saida : (pendente.novas || 0);
      const qE = (typeof pendente.novas_entrada === 'number') ? pendente.novas_entrada : 0;

      await rodada('S', pendente.url_zip_saida, qS, 'saída');
      if (qE && pendente.url_zip_entrada) await rodada('E', pendente.url_zip_entrada, qE, 'entrada');

      const _falhas = feito.reduce((s, f) => s + (f.res.nao_importados || 0), 0);
      msg((_falhas ? '⚠ Quase: ' : '✓ Pronto.') + '\n' + feito.map(f =>
            f.quantas + ' de ' + f.rotulo + ' enviadas' +
            (f.res.ja_registradas ? ' — ' + f.res.ja_registradas + ' já estavam lá' : '') +
            (f.res.nao_importados ? ' — ' + f.res.nao_importados + ' NÃO importadas (vão re-tentar na próxima)' : '')
          ).join('\n'), _falhas ? '#fdd663' : '#81c995');

      elBtn.textContent = 'Importar de novo';
      sumirDepois(8000);   // deu certo: some sozinho, nao fica atrapalhando
    } catch (e) {
      const t = String(e.message || e);
      msg(t.indexOf('SESSAO') === 0 ? 'Sessão do Bling caiu. Faça login e recarregue.' : '✗ ' + t, '#f28b82');
      elBtn.textContent = 'Tentar de novo';
    } finally {
      ocupado = false;
      elBtn.disabled = false;
    }
  }

  // ── inicio ──────────────────────────────────────────────────────────
  (async function () {
    montarPainel();
    cfg = await lerCfg();
    const w = document.getElementById('nfmagalu-painel');
    w.querySelector('#nfmagalu-serv').value = cfg.servidor;
    w.querySelector('#nfmagalu-chave').value = cfg.chave;
    w.querySelector('#nfmagalu-auto').checked = !!cfg.automatico;
    verificar();
  })();
})();

// ══════════════════════════════════════════════════════════════════════
//  NF-e SHOPEE FULL (FBS) -> BLING   (bloco independente, mesma extensao)
// ══════════════════════════════════════════════════════════════════════
//  Bloco SEPARADO do Magalu acima: proprio painel, proprio servidor, IDs
//  proprios. Nao compartilha estado com o Magalu — se um quebrar, o outro
//  segue. A mecanica de importar no Bling e IDENTICA (mesma tela, mesmo
//  upload.restore.php + validarArquivoNotasFiscais); o que muda e a ORIGEM
//  dos XMLs (o servico shopee-nf-sync, via API oficial da Shopee) e a
//  LOJA/UNIDADE no Bling (Shopee / Shopee FULL).
//
//  Shopee Full emite NF em nome da PROPRIA empresa (AMBTotal) — confirmado
//  no XML: emitente CNPJ 64289091000100. Sao notas de SAIDA (venda).
//  Lancar Contas SIM (saida) / NAO (entrada). Estoque NUNCA (esta no CD).
// ══════════════════════════════════════════════════════════════════════
(function () {
  const CFG_PADRAO = {
    sp_servidor: 'https://girassol-shopee-sync-organizar-envio.onrender.com',
    sp_chave: '',
    sp_loja: 'amb',            // a "loja" no caminho do servidor (rota /:loja/fbs/...)
    sp_automatico: true
  };

  // IDs da tela de importar NF do Bling (lidos do HTML 31/07):
  //   loja SHOPEE = 206017368 | unidade "Shopee FULL" = 2920348
  const LOJA_BLING = { amb: '206017368' };
  const UNIDADE_BLING = { amb: '2920348' };
  const NOME = { amb: 'AMBTotal', good: 'GOOD', girassol: 'Girassol' };

  let cfg = null;
  let ocupado = false;
  const API = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;

  function lerCfg() {
    return new Promise(ok => {
      try {
        const r = API.storage.local.get(CFG_PADRAO, v => ok(Object.assign({}, CFG_PADRAO, v || {})));
        if (r && typeof r.then === 'function') r.then(v => ok(Object.assign({}, CFG_PADRAO, v || {})));
      } catch (e) { ok(Object.assign({}, CFG_PADRAO)); }
    });
  }
  function salvarCfg(v) {
    return new Promise(ok => {
      try {
        const r = API.storage.local.set(v, ok);
        if (r && typeof r.then === 'function') r.then(ok, ok);
      } catch (e) { ok(); }
    });
  }

  let elPainel, elMsg, elBtn, sumirEm = null;

  function montarPainel() {
    if (document.getElementById('nfshopee-painel')) return;
    const wrap = document.createElement('div');
    wrap.id = 'nfshopee-painel';
    wrap.innerHTML = `
      <style>
        #nfshopee-painel{position:fixed;left:16px;bottom:16px;z-index:999998;display:none;
          font:13px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
          background:#1a1410;color:#f2e9e4;border:1px solid #3a2f26;border-radius:10px;
          width:290px;box-shadow:0 6px 24px rgba(0,0,0,.35);overflow:hidden}
        #nfshopee-painel.visivel{display:block}
        #nfshopee-painel .cab{background:#12100c;padding:10px 12px;font-weight:600;
          display:flex;align-items:center;justify-content:space-between;cursor:pointer}
        #nfshopee-painel .corpo{padding:12px;display:none}
        #nfshopee-painel.aberto .corpo{display:block}
        #nfshopee-painel button{width:100%;background:#ee4d2d;color:#fff;border:0;
          padding:10px;border-radius:7px;font:inherit;font-weight:600;cursor:pointer;margin-top:8px}
        #nfshopee-painel button.cinza{background:#3a2f26;color:#f2e9e4}
        #nfshopee-painel button:disabled{opacity:.5;cursor:default}
        #nfshopee-painel input{width:100%;background:#12100c;color:#f2e9e4;border:1px solid #3a2f26;
          border-radius:6px;padding:8px;font:inherit;margin-top:6px}
        #nfshopee-painel label{font-size:11px;color:#c9a99a;display:block;margin-top:8px}
        #nfshopee-msg{margin-top:10px;font-size:12px;color:#c9a99a;white-space:pre-wrap;
          max-height:190px;overflow:auto}
        #nfshopee-painel .cfg{display:none;border-top:1px solid #3a2f26;margin-top:10px;padding-top:6px}
        #nfshopee-painel.cfg-aberta .cfg{display:block}
      </style>
      <div class="cab"><span>🛒 NF-e Shopee Full → Bling</span><span><span id="nfshopee-seta">▾</span> <span id="nfshopee-fechar" title="fechar (Ctrl+Alt+S para chamar de volta)" style="opacity:.6;padding-left:6px">✕</span></span></div>
      <div class="corpo">
        <div id="nfshopee-msg">Verificando…</div>
        <button id="nfshopee-btn" disabled>Aguarde…</button>
        <button id="nfshopee-cfgbtn" class="cinza">Configurar</button>
        <div class="cfg">
          <label>Servidor (shopee-nf-sync)</label><input id="nfshopee-serv" placeholder="https://...onrender.com">
          <label>ADMIN_KEY (do shopee-nf-sync)</label><input id="nfshopee-chave" type="password" placeholder="cole a chave">
          <label>Loja no servidor</label><input id="nfshopee-lojak" placeholder="amb">
          <label style="display:flex;align-items:center;gap:6px;margin-top:10px">
            <input type="checkbox" id="nfshopee-auto" style="width:auto;margin:0"> importar sozinho ao abrir o Bling
          </label>
          <button id="nfshopee-salvar" class="cinza">Salvar</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    elPainel = wrap;
    elMsg = wrap.querySelector('#nfshopee-msg');
    elBtn = wrap.querySelector('#nfshopee-btn');

    wrap.querySelector('.cab').addEventListener('click', () => wrap.classList.toggle('aberto'));
    wrap.querySelector('#nfshopee-cfgbtn').addEventListener('click', () => wrap.classList.toggle('cfg-aberta'));
    wrap.querySelector('#nfshopee-salvar').addEventListener('click', async () => {
      await salvarCfg({
        sp_servidor: wrap.querySelector('#nfshopee-serv').value.trim().replace(/\/+$/, ''),
        sp_chave: wrap.querySelector('#nfshopee-chave').value.trim(),
        sp_loja: (wrap.querySelector('#nfshopee-lojak').value.trim() || 'amb').toLowerCase(),
        sp_automatico: wrap.querySelector('#nfshopee-auto').checked
      });
      cfg = await lerCfg();
      wrap.classList.remove('cfg-aberta');
      msg('Configuração salva. Verificando…');
      verificar(true);
    });
    /* Codex #236 r2: com "Buscar de novo" na tela (sem pendencia), o rodar(true) retornava
       cedo e o clique nao fazia NADA — agora sem pendencia o clique re-verifica com busca. */
    elBtn.addEventListener('click', () => { if (pendente && pendente.precisa) rodar(true); else verificar(true); });
    wrap.querySelector('#nfshopee-fechar').addEventListener('click', ev => { ev.stopPropagation(); esconder(); });

    // Ctrl + Alt + S chama o painel Shopee (o Magalu usa Ctrl+Alt+M).
    document.addEventListener('keydown', ev => {
      if (ev.ctrlKey && ev.altKey && (ev.key === 's' || ev.key === 'S')) {
        ev.preventDefault();
        if (elPainel.classList.contains('visivel')) esconder();
        else { mostrar(true); verificar(true); }
      }
    });
  }

  function msg(t, cor) { if (elMsg) { elMsg.textContent = t; elMsg.style.color = cor || '#c9a99a'; } }
  function mostrar(abre) { if (!elPainel) return; elPainel.classList.add('visivel'); if (abre) elPainel.classList.add('aberto'); clearTimeout(sumirEm); }
  function esconder() { if (elPainel) elPainel.classList.remove('visivel', 'aberto'); }
  function abrir() { mostrar(true); }
  function sumirDepois(ms) { clearTimeout(sumirEm); sumirEm = setTimeout(esconder, ms); }

  // ── passo 0: em qual conta Bling estamos (mesma fonte do Magalu) ──
  async function descobrirIdEmpresa() {
    const r = await fetch('/importador.notas.fiscais.lote.php', { credentials: 'include' });
    const txt = await r.text();
    if (/location\.href\s*=\s*["'][^"']*\/login/i.test(txt)) throw new Error('SESSAO: você não está logado no Bling');
    const m = /initForm\s*\(\s*(\d+)/.exec(txt);
    if (!m) throw new Error('não achei o idEmpresa na página do importador');
    return m[1];
  }

  // ── passo 1: upload (idêntico ao Magalu: campo qqfile) ──
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
    if (!j || !j.success || !j.tmp) throw new Error('upload não devolveu o tmp: ' + txt.slice(0, 160));
    return j.tmp;
  }

  // ── passo 2: processar. Loja/unidade SHOPEE. Contas SIM na saída ──
  async function processar(tmp, lojaKey, tipo) {
    const loja = LOJA_BLING[lojaKey] || LOJA_BLING.amb;
    const unidade = UNIDADE_BLING[lojaKey] || UNIDADE_BLING.amb;
    const lancarContas = (tipo === 'E') ? 'false' : 'true';
    const args = [tmp, tipo, loja, unidade, lancarContas, 'false']; // estoque nunca
    let corpo = 'xajax=' + encodeURIComponent('validarArquivoNotasFiscais') + '&xajaxr=' + Date.now();
    args.forEach(a => { corpo += '&xajaxargs[]=' + encodeURIComponent(a); });
    const r = await fetch('/services/importador.notas.fiscais.lote.server.php?f=validarArquivoNotasFiscais', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: corpo
    });
    const txt = await r.text();
    if (/location\.href\s*=\s*["'][^"']*\/login/i.test(txt)) throw new Error('SESSAO: o Bling pediu login ao processar');
    return txt;
  }

  function resumir(txt) {
    const limpo = String(txt || '').replace(/<!\[CDATA\[/g, ' ').replace(/\]\]>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const conta = re => (limpo.match(re) || []).length;
    return {
      ja_registradas: conta(/já está registrada|ja esta registrada/gi),
      eram_de_entrada: conta(/Para importar notas de entrada/gi),
      nao_importados: conta(/XML não importado|XML nao importado/gi),
      trecho: limpo.trim().slice(0, 300)
    };
  }

  // ── verificar o que há de novo (fala o dialeto /fbs/ext/estado) ──
  let pendente = null;
  async function verificar(forcado) {
    if (!cfg.sp_chave) {
      // sem chave: só mostra o aviso se você chamou na mão (Ctrl+Alt+S).
      // Ao abrir o Bling normalmente, fica quieto pra não incomodar.
      if (forcado) {
        msg('Falta configurar a ADMIN_KEY do shopee-nf-sync. Clique em Configurar.', '#f28b82');
        elBtn.disabled = true; elBtn.textContent = 'Não configurado'; abrir();
      }
      return;
    }
    try {
      const idEmpresa = await descobrirIdEmpresa();

      // Se você chamou na mão (Ctrl+Alt+S), dispara a busca na Shopee pra pegar
      // o que houver de mais novo AGORA. No modo automático (abrir o Bling), NÃO
      // busca — só lê o que o cron do servidor (6h/12h/18h/23h) já deixou pronto.
      // Assim abrir o Bling é instantâneo e não fica pesando.
      if (forcado) {
        msg('Buscando notas na Shopee… (pode levar ~1 min)');
        abrir();
        try {
          await fetch(cfg.sp_servidor + '/' + encodeURIComponent(cfg.sp_loja) + '/fbs/ext/buscar?k=' + encodeURIComponent(cfg.sp_chave));
        } catch (e) { /* se a busca falhar, ainda lê o que já há em disco */ }
      }

      /* Codex #236 r2 — TRAVA DE CONTA (o Magalu ja tinha, aqui faltava): no mesmo navegador
         com outra conta do Bling logada, a config sp_loja mandaria processar o ZIP da OUTRA
         empresa nesta sessao. O vinculo loja→idEmpresa e APRENDIDO na 1a importacao que dá
         certo; sessao diferente do vinculo = recusa com aviso. O idEmpresa tambem segue na
         query do estado, como no Magalu, pra validacao do lado do servidor. */
      try {
        const _vk = 'sp_vinculo_' + cfg.sp_loja;
        const _vv = (await chrome.storage.local.get([_vk]))[_vk];
        if (_vv && String(_vv) !== String(idEmpresa)) {
          msg('⛔ Esta sessão do Bling (empresa ' + idEmpresa + ') NÃO é a da loja configurada (' + cfg.sp_loja + ', vinculada à empresa ' + _vv + ').\nConfira a loja em Configurar antes de importar aqui.', '#f28b82');
          elBtn.disabled = true; elBtn.textContent = 'Conta errada';
          if (forcado) abrir();
          return;
        }
      } catch (eV) {}
      // lê o estado (instantâneo: só conta as novas do ZIP que o cron já baixou)
      const r = await fetch(cfg.sp_servidor + '/' + encodeURIComponent(cfg.sp_loja) + '/fbs/ext/estado?k=' + encodeURIComponent(cfg.sp_chave) + '&idEmpresa=' + encodeURIComponent(idEmpresa));
      const j = await r.json();
      if (!j.ok) throw new Error(j.erro || j.motivo || 'servidor recusou');
      pendente = Object.assign({ idEmpresa }, j);
      const quem = NOME[j.empresa] || j.empresa;

      if (!j.precisa) {
        // NADA novo pra importar → fica INVISÍVEL (não chama abrir()). Só
        // atualiza a mensagem interna, pra quando você abrir com Ctrl+Alt+S.
        // É assim que o Magalu funciona: só aparece quando há trabalho.
        msg(quem + ': nada novo pra importar da Shopee Full.', '#81c995');
        elBtn.disabled = false; elBtn.textContent = 'Buscar de novo';
        if (forcado) abrir();   // se você chamou na mão, mostra (pra ver que está tudo ok)
        return;
      }

      // TEM nota nova → aparece (é o único caso em que ele surge sozinho).
      const partes = [];
      if (j.novas_saida) partes.push(j.novas_saida + ' de saída');
      if (j.novas_entrada) partes.push(j.novas_entrada + ' de entrada');
      msg(quem + ': ' + (partes.length ? partes.join(' e ') : 'nada') + ' pra importar.');
      elBtn.disabled = false; elBtn.textContent = 'Importar agora';
      abrir();
      if (cfg.sp_automatico) rodar(false);
    } catch (e) {
      const t = String(e.message || e);
      // erro só aparece se você chamou na mão — no automático fica quieto pra
      // não poluir a tela (o cron do servidor é a real rede de segurança).
      if (forcado) {
        msg(t.indexOf('SESSAO') === 0 ? 'Faça login no Bling e recarregue a página.' : 'Erro: ' + t, '#f28b82');
        elBtn.disabled = true; elBtn.textContent = 'Indisponível'; abrir();
      }
    }
  }

  async function rodar(manual) {
    if (ocupado || !pendente || !pendente.precisa) return;
    ocupado = true; elBtn.disabled = true; abrir();
    try {
      const feito = [];
      async function rodada(tipo, url, quantas, rotulo) {
        if (!quantas || !url) return;
        msg('Baixando ' + quantas + ' nota' + (quantas === 1 ? '' : 's') + ' de ' + rotulo + '…');
        const rz = await fetch(cfg.sp_servidor + url);
        if (!rz.ok) throw new Error('não consegui baixar o ZIP de ' + rotulo + ' (HTTP ' + rz.status + ')');
        const blob = await rz.blob();
        if (blob.size > 3000000) throw new Error('o ZIP de ' + rotulo + ' tem ' + Math.round(blob.size / 1000) + ' KB e o Bling só aceita 3 MB.');
        msg('Enviando ' + rotulo + ' (' + Math.round(blob.size / 1024) + ' KB) pro Bling…');
        const nomeBase = (tipo === 'E' && pendente.url_zip_entrada) ? pendente.url_zip_entrada : pendente.arquivo;
        const nomeEnv = (pendente.arquivo || 'shopee.zip').replace(/\.zip$/, '') + '-' + rotulo.toUpperCase() + '.zip';
        const tmp = await subirZip(pendente.idEmpresa, nomeEnv, blob);
        msg('Processando ' + rotulo + '…');
        const res = resumir(await processar(tmp, pendente.empresa, tipo));
        feito.push({ tipo, rotulo, quantas, res });
        // marca as chaves como importadas (extrai o nome do arquivo da própria URL)
        // Codex #236 (P1): SO quando o Bling nao recusou nenhum XML — com falha o lote fica
        // pendente e re-tenta (as ja importadas viram "ja esta registrada", inofensivo).
        if (!res.nao_importados) {
          try {
            const nomeArq = decodeURIComponent((url.split('/fbs/zip/')[1] || '').split('?')[0]);
            if (nomeArq) await fetch(cfg.sp_servidor + '/' + encodeURIComponent(cfg.sp_loja) + '/fbs/ext/registrar?k=' + encodeURIComponent(cfg.sp_chave) + '&arquivo=' + encodeURIComponent(nomeArq));
          } catch (e) { /* registrar é bônus */ }
        }
      }
      await rodada('S', pendente.url_zip_saida, pendente.novas_saida, 'saída');
      if (pendente.novas_entrada && pendente.url_zip_entrada) await rodada('E', pendente.url_zip_entrada, pendente.novas_entrada, 'entrada');

      try { await chrome.storage.local.set({ ['sp_vinculo_' + cfg.sp_loja]: String(pendente.idEmpresa) }); } catch (eV2) {}   // Codex #236 r2: aprende o vinculo loja→empresa na 1a importacao ok
      const _falhasS = feito.reduce((s, f) => s + (f.res.nao_importados || 0), 0);
      msg((_falhasS ? '⚠ Quase: ' : '✓ Pronto.') + '\n' + feito.map(f => f.quantas + ' de ' + f.rotulo + ' enviadas' + (f.res.ja_registradas ? ' — ' + f.res.ja_registradas + ' já estavam lá' : '') + (f.res.nao_importados ? ' — ' + f.res.nao_importados + ' NÃO importadas (vão re-tentar)' : '')).join('\n'), _falhasS ? '#fdd663' : '#81c995');
      elBtn.textContent = 'Importar de novo';
      sumirDepois(8000);
    } catch (e) {
      const t = String(e.message || e);
      msg(t.indexOf('SESSAO') === 0 ? 'Sessão do Bling caiu. Faça login e recarregue.' : '✗ ' + t, '#f28b82');
      elBtn.textContent = 'Tentar de novo';
    } finally {
      ocupado = false; elBtn.disabled = false;
    }
  }

  (async function () {
    montarPainel();
    cfg = await lerCfg();
    const w = document.getElementById('nfshopee-painel');
    w.querySelector('#nfshopee-serv').value = cfg.sp_servidor;
    w.querySelector('#nfshopee-chave').value = cfg.sp_chave;
    w.querySelector('#nfshopee-lojak').value = cfg.sp_loja;
    w.querySelector('#nfshopee-auto').checked = !!cfg.sp_automatico;
    // Ao abrir o Bling: só faz algo se "importar sozinho" estiver marcado. E
    // mesmo assim é SILENCIOSO (verificar(false)) — só lê o que o cron já
    // baixou e aparece SE houver nota nova. Se a caixinha estiver desmarcada,
    // não faz nada ao abrir: o painel só surge com Ctrl+Alt+S. Isso resolve o
    // "fica aparecendo toda hora": sem nota nova, ele nunca aparece sozinho.
    if (cfg.sp_automatico) verificar(false);
  })();
})();
