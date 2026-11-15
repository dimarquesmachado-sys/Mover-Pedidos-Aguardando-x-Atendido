/* ─────────────────────────────────────────────────────────────────────────────
   CHAT DE ANÁLISE — o botão e a conversa no dashboard (14/11/2026). Peça compartilhada do painel: as três empresas.

   Pedido do dono: "eu clico num botão do CHAT CLAUDE e pergunto, qual item teve maior queda nas vendas nos últimos 3
   meses… e conseguir interagir em tempo real".

   A tela só CONVERSA: manda a pergunta pra `<prefixo>/chat-analise` (lib/checkout/chat-analise.js, que é quem consulta
   os números e fala com o Claude) e desenha a resposta enquanto ela chega. Nenhuma conta é feita aqui.

   ⚠️ O texto do modelo é desenhado com `textContent`/escape — nunca como HTML cru. O único "formato" aceito é negrito
   (**assim**), itálico de aviso (_assim_) e quebra de linha, aplicados DEPOIS do escape.

   CONVERSAS GUARDADAS (14/11): quem guarda é o SERVIDOR, quando a resposta termina (lib/checkout/chat-conversas.js). A
   tela só manda de volta o id que recebeu no fim de cada resposta, e oferece a lista: abrir, renomear, apagar. O título e
   o texto guardados são desenhados como texto (`textContent`), como o resto.

   ⚠️ O ESPAÇO da peça é o `<div id="chatAnaliseAqui">` do dashboard — que fica FORA do `#app` (o `#app` é redesenhado a
   cada troca de período; a conversa aberta não pode sumir junto). Sem o espaço, a peça não desenha nada.
   ⚠️ A peça não cria nada se já existir (o dashboard redesenha a cada troca de período e injeta os scripts de novo).
   ───────────────────────────────────────────────────────────────────────────── */

'use strict';

const SUGESTOES = [
  'Qual item teve a maior queda de vendas nos últimos 3 meses?',
  'Por que meu faturamento mudou da semana retrasada pra última semana?',
  'Como está este mês comparado com o mês passado?',
  'Quais itens deram menos margem nos últimos 30 dias?',
];

/* O BOTÃO É O 4º QUADRADINHO DA COLUNA LATERAL (14/11, o dono: "deixa só acima ali dos botões 3 que já tem na lateral,
   deixa quadradinho e só o balãozinho de conversa branco e ele azulzinho em volta — aí fica no mesmo layout dos outros 3").
   A peça ENCAIXA o botão dentro da coluna de navegar entre os cards (#navCards, do dashboard), em cima do ▲: ali ele
   herda o tamanho, o espaçamento e a regra do celular dos outros três, sem número copiado.
   Estes números são só a RESERVA — onde o botão fica enquanto a coluna ainda não existe na página (ou se um dia ela
   sair): o MESMO lugar em que ele ficaria dentro dela (px; `celular_ate` é o corte em que o dashboard muda os botões
   laterais de tamanho e de altura). scripts/teste-painel-largura-e-botao-chat.js confere contra o CSS do dashboard. */
const POSICAO_DO_BOTAO = { computador: { right: 14, bottom: 132, largura: 38, altura: 34 }, celular_ate: 720, celular: { right: 10, bottom: 147, largura: 42, altura: 38 } };
/* o balão de conversa, branco (desenho fixo da peça — não é texto de ninguém) */
const BALAO = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="display:block;margin:auto"><path fill="#fff" d="M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/></svg>';

function scriptDoChatAnalise(base) {
  const BASE = JSON.stringify(String(base || ''));
  const SUG = JSON.stringify(SUGESTOES);
  return `(function () {
  'use strict';
  var BASE = ${BASE};
  var SUGESTOES = ${SUG};
  var alvo = document.getElementById('chatAnaliseAqui');
  if (!alvo) return;
  if (document.getElementById('chatAnaliseBotao')) return;

  function esc(x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  /* escape PRIMEIRO; só depois o negrito, o itálico de aviso e as quebras de linha */
  function formatar(t) {
    return esc(t).replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<b>$1</b>').replace(/(^|[\\s(])_([^_\\n]+)_(?=$|[\\s).,;:!?])/gm, '$1<i>$2</i>').replace(/\\n/g, '<br>');
  }
  function chaveQ() {
    try { var v = new URLSearchParams(window.location.search).get('k'); return v ? ('?k=' + encodeURIComponent(v)) : ''; }
    catch (e) { return ''; }
  }
  function el(tag, css, txt) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; }
  function nUS(v) { return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 }); }
  function nInt(v) { return Number(v).toLocaleString('pt-BR'); }

  var historico = [];      /* as trocas já concluídas: [{ role, content }] */
  var conversaId = null;   /* a conversa guardada em que esta troca entra (o servidor devolve no fim de cada resposta) */
  var naLista = false;     /* a tela está mostrando a LISTA das conversas, e não uma conversa */
  var vez = 0;             /* cada troca de tela (lista, abrir, perguntar, nova conversa) avança este número: a resposta de um pedido ANTIGO
                              que chega depois é ignorada — senão a lista que demorou apagava da tela a pergunta em andamento */
  var ocupado = false, ligado = true;
  /* Codex #873 r2: o histórico vai junto em cada pergunta, e o servidor recusa pedido acima de 64 KiB. Depois de algumas
     respostas longas, 12 mensagens inteiras passavam disso — a pergunta seguinte era recusada, o histórico grande
     continuava lá e a conversa ficava presa até "nova conversa". Agora cada mensagem guardada tem teto de tamanho e, na
     hora de enviar, as trocas mais ANTIGAS saem até o pedido caber (medido em bytes, como o servidor mede). */
  var MAX_MSG = 4000, MAX_PEDIDO_BYTES = 40000;
  function cortar(t) { t = String(t); return t.length > MAX_MSG ? t.slice(0, MAX_MSG) + ' [\u2026]' : t; }
  function bytes(o) { var s = JSON.stringify(o); try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 3; } }
  function historicoQueCabe(pergunta) {
    var h = historico.slice();
    while (h.length && bytes({ pergunta: pergunta, historico: h }) > MAX_PEDIDO_BYTES) h = h.slice(2);
    return h;
  }

  /* o botão: um quadradinho azul com o balão branco, do tamanho dos botões laterais do dashboard. Todo o visual vai na
     FOLHA DE ESTILO (nada no "style" do botão): dentro da coluna (#navCards) valem o tamanho e o espaçamento dela — no
     computador e no celular —, e a peça só pinta de azul; fora da coluna vale a reserva, no mesmo lugar. */
  var P = ${JSON.stringify(POSICAO_DO_BOTAO)};
  var estilo = el('style', null,
    '#chatAnaliseBotao{position:fixed;z-index:9990;right:' + P.computador.right + 'px;bottom:' + P.computador.bottom + 'px;width:' + P.computador.largura + 'px;height:' + P.computador.altura + 'px;'
    + 'padding:0;border-radius:9px;border:1px solid #60a5fa;background:#2563eb;cursor:pointer;line-height:1;box-shadow:0 3px 10px rgba(0,0,0,.4)}'
    + '#chatAnaliseBotao:hover{background:#1d4ed8}'
    + '@media(max-width:' + P.celular_ate + 'px){#chatAnaliseBotao{right:' + P.celular.right + 'px;bottom:' + P.celular.bottom + 'px;width:' + P.celular.largura + 'px;height:' + P.celular.altura + 'px}}'
    /* dentro da coluna: sai do "fixo" e entra na fila dos outros. SEM largura nem altura aqui: quem dá o tamanho é a
       regra da coluna pros botões dela (no computador e no celular) — declarar aqui passaria por cima dela */
    + '#navCards #chatAnaliseBotao{position:static;z-index:auto;padding:0;border:1px solid #60a5fa;background:#2563eb;box-shadow:0 3px 10px rgba(0,0,0,.4)}'
    + '#navCards #chatAnaliseBotao:hover{background:#1d4ed8;border-color:#93c5fd}');
  estilo.id = 'chatAnaliseEstilo';
  var botao = el('button');
  botao.id = 'chatAnaliseBotao';
  botao.title = 'Perguntar ao Claude sobre as vendas desta loja';
  botao.setAttribute('aria-label', 'Perguntar ao Claude sobre as vendas desta loja');
  botao.innerHTML = ${JSON.stringify(BALAO)};

  var painel = el('div', 'position:fixed;right:0;bottom:0;z-index:9991;width:min(460px,100vw);height:min(720px,100vh);display:none;flex-direction:column;background:#0d1326;color:#e7ecf6;border:1px solid #2d3a5e;border-radius:14px 14px 0 0;box-shadow:0 10px 40px rgba(0,0,0,.6);font:14px/1.5 system-ui,sans-serif');
  painel.id = 'chatAnalisePainel';
  var topo = el('div', 'display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #232d4a');
  var titulo = el('div', 'flex:1;font-weight:700', '\\uD83D\\uDCAC Análise com o Claude');
  var nova = el('button', 'border:1px solid #2d3a5e;background:transparent;color:#8b96b3;border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer', 'nova conversa');
  var fechar = el('button', 'border:0;background:transparent;color:#8b96b3;font-size:20px;line-height:1;cursor:pointer;padding:0 4px', '\\u00D7');
  fechar.title = 'Fechar';
  var guardadas = el('button', 'border:1px solid #2d3a5e;background:transparent;color:#8b96b3;border-radius:8px;padding:4px 8px;font-size:12px;cursor:pointer', 'conversas');
  guardadas.id = 'chatAnaliseConversas';
  guardadas.title = 'As conversas guardadas desta loja';
  topo.appendChild(titulo); topo.appendChild(guardadas); topo.appendChild(nova); topo.appendChild(fechar);
  var lista = el('div', 'flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px');
  var rodape = el('div', 'padding:10px 12px;border-top:1px solid #232d4a');
  var caixa = el('textarea', 'width:100%;box-sizing:border-box;resize:none;height:64px;border-radius:10px;border:1px solid #2d3a5e;background:#131a30;color:#e7ecf6;padding:9px 10px;font:14px/1.4 system-ui,sans-serif;outline:none');
  caixa.placeholder = 'Pergunte sobre as vendas desta loja…';
  caixa.maxLength = 2000;
  var linha = el('div', 'display:flex;align-items:center;gap:8px;margin-top:6px');
  var nota = el('div', 'flex:1;color:#5a6485;font-size:11px', 'Os números vêm do histórico do dashboard. Enter envia.');
  var enviar = el('button', 'border:0;border-radius:10px;padding:8px 16px;font:600 13px system-ui,sans-serif;color:#fff;background:#6366f1;cursor:pointer', 'Enviar');
  linha.appendChild(nota); linha.appendChild(enviar);
  rodape.appendChild(caixa); rodape.appendChild(linha);
  painel.appendChild(topo); painel.appendChild(lista); painel.appendChild(rodape);

  function rolar() { lista.scrollTop = lista.scrollHeight; }
  function bolha(quem) {
    var b = el('div', quem === 'user'
      ? 'align-self:flex-end;max-width:88%;background:#6366f1;color:#fff;border-radius:12px 12px 2px 12px;padding:8px 11px;white-space:pre-wrap;word-break:break-word'
      : 'align-self:flex-start;max-width:94%;background:#131a30;border:1px solid #232d4a;border-radius:12px 12px 12px 2px;padding:9px 12px;word-break:break-word');
    lista.appendChild(b); rolar(); return b;
  }
  function aviso(txt, cor) { var a = el('div', 'align-self:center;max-width:94%;color:' + (cor || '#f59e0b') + ';font-size:12px;text-align:center', txt); lista.appendChild(a); rolar(); return a; }

  /* o rodapé: perguntas de hoje e o gasto ESTIMADO de hoje e do mês (a conta de verdade é a do Console da Anthropic) */
  function rodapeDoUso(hoje, mes) {
    if (!hoje) return;
    var t = 'Hoje: ' + nInt(hoje.perguntas || 0) + ' de ' + nInt(hoje.limite_perguntas) + ' perguntas';
    if (hoje.usd_estimado) t += ' \u00B7 \u2248 US$ ' + nUS(hoje.usd_estimado);
    if (mes && mes.usd_estimado) t += ' \u00B7 m\u00EAs \u2248 US$ ' + nUS(mes.usd_estimado);
    nota.textContent = t + '. Enter envia.';
    nota.title = 'Gasto estimado pela tabela de pre\u00E7os do modelo; o valor cobrado \u00E9 o do Console da Anthropic.';
  }

  /* ── as conversas guardadas ── */
  function pedirJson(url, corpo) {
    var o = { credentials: 'same-origin' };
    if (corpo) { o.method = 'POST'; o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(corpo); }
    return fetch(url, o).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function quando(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  function desenharConversas(conversas) {
    lista.textContent = '';
    var cab = el('div', 'color:#8b96b3;font-size:12px', conversas.length ? 'Conversas guardadas desta loja (toque pra abrir):' : 'Nenhuma conversa guardada ainda. Cada pergunta respondida fica guardada aqui.');
    lista.appendChild(cab);
    conversas.forEach(function (c) {
      var linha = el('div', 'display:flex;align-items:center;gap:6px;border:1px solid #232d4a;border-radius:10px;padding:8px 10px;background:#131a30');
      var abre = el('button', 'flex:1;min-width:0;text-align:left;border:0;background:transparent;color:#e7ecf6;font:13px system-ui,sans-serif;cursor:pointer;padding:0');
      var nome = el('div', 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600', c.titulo);
      var sub = el('div', 'color:#5a6485;font-size:11px', quando(c.atualizada_em) + ' \u00B7 ' + nInt(c.trocas) + (c.trocas === 1 ? ' pergunta' : ' perguntas') + (c.usd_estimado != null ? ' \u00B7 \u2248 US$ ' + nUS(c.usd_estimado) : ''));
      abre.appendChild(nome); abre.appendChild(sub);
      abre.onclick = function () { abrirConversa(c.id); };
      var bt = 'border:1px solid #2d3a5e;background:transparent;color:#8b96b3;border-radius:8px;padding:4px 7px;font-size:12px;cursor:pointer';
      var renomeia = el('button', bt, 'renomear'), apaga = el('button', bt, 'apagar');
      renomeia.onclick = function () {
        var campo = el('input', 'flex:1;min-width:0;border-radius:8px;border:1px solid #2d3a5e;background:#0d1326;color:#e7ecf6;padding:5px 8px;font:13px system-ui,sans-serif');
        campo.value = c.titulo; campo.maxLength = 80;
        var ok = el('button', bt, 'salvar'), nao = el('button', bt, 'cancelar');
        linha.textContent = ''; linha.appendChild(campo); linha.appendChild(ok); linha.appendChild(nao);
        nao.onclick = function () { desenharConversas(conversas); };
        ok.onclick = function () {
          var vezDoRenomear = ++vez;
          pedirJson(BASE + '/chat-analise' + chaveQ(), { acao: 'renomear', id: c.id, titulo: campo.value }).then(function (j) {
            if (vezDoRenomear !== vez) return;
            if (j && j.ok) desenharConversas(j.conversas || []); else { desenharConversas((j && j.conversas) || conversas); aviso((j && j.erro) || 'N\u00E3o consegui renomear.', '#ef4444'); }
          });
        };
        campo.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ok.onclick(); } });
        campo.focus();
      };
      apaga.onclick = function () {
        /* confirmação na própria linha (sem janela do navegador) */
        var certeza = el('div', 'flex:1;color:#f59e0b;font-size:12px', 'Apagar esta conversa?');
        var sim = el('button', bt + ';color:#ef4444;border-color:#ef4444', 'apagar'), nao = el('button', bt, 'cancelar');
        linha.textContent = ''; linha.appendChild(certeza); linha.appendChild(sim); linha.appendChild(nao);
        nao.onclick = function () { desenharConversas(conversas); };
        sim.onclick = function () {
          var vezDoApagar = ++vez;
          pedirJson(BASE + '/chat-analise' + chaveQ(), { acao: 'apagar', id: c.id }).then(function (j) {
            if (vezDoApagar !== vez) return;
            /* n\u00E3o apagou: a tela mostra a lista como o servidor diz que est\u00E1 (ou a que tinha) \u2014 nunca some o que n\u00E3o foi apagado */
            if (j && j.ok) desenharConversas(j.conversas || []); else { desenharConversas((j && j.conversas) || conversas); aviso((j && j.erro) || 'N\u00E3o consegui apagar.', '#ef4444'); }
          });
        };
      };
      linha.appendChild(abre); linha.appendChild(renomeia); linha.appendChild(apaga);
      lista.appendChild(linha);
    });
    lista.scrollTop = 0;
  }
  function listarConversas() {
    if (ocupado) return;
    /* abrir a lista é SAIR da conversa que estava na tela (ela está guardada: dá pra reabrir). O que o chat recebe de
       contexto é sempre o que está na tela — perguntar daqui começa uma conversa nova. */
    naLista = true; conversaId = null; historico = [];
    var vezDaLista = ++vez;
    lista.textContent = '';
    aviso('Carregando as conversas\u2026', '#8b96b3');
    pedirJson(BASE + '/chat-analise' + (chaveQ() ? chaveQ() + '&' : '?') + 'conversas=1').then(function (j) {
      if (vezDaLista !== vez) return;
      if (!j || !j.ok) { lista.textContent = ''; aviso('N\u00E3o consegui carregar as conversas guardadas.', '#ef4444'); return; }
      desenharConversas(j.conversas || []);
    });
  }
  function abrirConversa(id) {
    if (ocupado) return;
    var vezDoAbrir = ++vez;
    pedirJson(BASE + '/chat-analise' + (chaveQ() ? chaveQ() + '&' : '?') + 'conversa=' + encodeURIComponent(id)).then(function (j) {
      if (vezDoAbrir !== vez) return;
      if (!j || !j.ok || !j.conversa) { aviso((j && j.erro) || 'N\u00E3o consegui abrir essa conversa.', '#ef4444'); return; }
      lista.textContent = ''; naLista = false;
      conversaId = j.conversa.id; historico = [];
      aviso('\uD83D\uDCC1 ' + j.conversa.titulo, '#8b96b3');
      (j.conversa.trocas || []).forEach(function (t) {
        bolha('user').textContent = t.pergunta;
        bolha('assistant').innerHTML = formatar(t.resposta);
        historico.push({ role: 'user', content: cortar(t.pergunta) }); historico.push({ role: 'assistant', content: cortar(t.resposta) });
      });
      if (historico.length > 12) historico = historico.slice(-12);
      rolar(); caixa.focus();
    });
  }

  function abertura() {
    lista.textContent = ''; naLista = false; vez++;
    var oi = bolha('assistant');
    oi.textContent = 'Oi! Pergunte sobre as vendas desta loja: quedas e altas, comparação entre períodos, itens, canais, margem. Eu consulto os mesmos números do dashboard e digo o que é fato e o que é hipótese.';
    var chips = el('div', 'display:flex;flex-direction:column;gap:6px;margin-top:2px');
    chips.id = 'chatAnaliseSugestoes';
    SUGESTOES.forEach(function (s) {
      var c = el('button', 'text-align:left;border:1px solid #2d3a5e;background:transparent;color:#818cf8;border-radius:10px;padding:7px 10px;font:13px system-ui,sans-serif;cursor:pointer', s);
      c.onclick = function () { perguntar(s); };
      chips.appendChild(c);
    });
    lista.appendChild(chips);
  }

  function estado() {
    fetch(BASE + '/chat-analise' + chaveQ(), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ok) return;
        if (!j.configurado) {
          ligado = false; caixa.disabled = true; enviar.disabled = true; enviar.style.opacity = '.5';
          aviso('O chat ainda não está ligado: falta a variável ' + j.env + ' no serviço (Render \\u2192 Environment).');
        } else if (j.hoje) {
          rodapeDoUso(j.hoje, j.mes);
        }
      }).catch(function () {});
  }

  function perguntar(texto) {
    texto = String(texto || '').trim();
    if (!texto || ocupado || !ligado) return;
    vez++;
    if (naLista) { naLista = false; lista.textContent = ''; }   /* perguntou com a lista na tela: a lista sai e a conversa nova começa limpa */
    var sug = document.getElementById('chatAnaliseSugestoes'); if (sug) sug.remove();
    ocupado = true; enviar.disabled = true; enviar.style.opacity = '.5'; caixa.value = '';
    bolha('user').textContent = texto;
    var resp = bolha('assistant');
    var corpo = el('div'); var passo = el('div', 'color:#8b96b3;font-size:12px', 'Pensando…'); var pe = el('div', 'margin-top:6px;color:#5a6485;font-size:11px;display:none');
    resp.appendChild(corpo); resp.appendChild(passo); resp.appendChild(pe);
    var bruto = '', falhou = false, chegouFim = false;

    function tratar(ev) {
      if (ev.t === 'texto') { bruto += ev.d || ''; corpo.innerHTML = formatar(bruto); passo.style.display = 'none'; rolar(); }
      else if (ev.t === 'passo') { passo.style.display = ''; passo.textContent = '\\uD83D\\uDD0E ' + ev.texto + '…'; rolar(); }
      else if (ev.t === 'erro') { falhou = true; passo.style.display = ''; passo.style.color = '#ef4444'; passo.textContent = '\\u26A0\\uFE0F ' + ev.erro;
        /* a pergunta que falhou depois de gastar mostra o que gastou */
        if (ev.uso && (ev.uso.tokens_entrada || ev.uso.tokens_saida)) { pe.style.display = ''; pe.textContent = 'gastou ' + nInt((ev.uso.tokens_entrada || 0) + (ev.uso.tokens_saida || 0)) + ' tokens antes de falhar' + (ev.uso.usd_estimado != null ? ' \\u00B7 \\u2248 US$ ' + nUS(ev.uso.usd_estimado) : ''); }
        rodapeDoUso(ev.hoje, ev.mes);
        rolar(); }
      else if (ev.t === 'fim') {
        chegouFim = true;
        passo.style.display = 'none';
        var u = ev.uso || {}, partes = [];
        if (u.consultas != null) partes.push(nInt(u.consultas) + (u.consultas === 1 ? ' consulta' : ' consultas'));
        if (u.tokens_entrada != null) partes.push(nInt((u.tokens_entrada || 0) + (u.tokens_saida || 0)) + ' tokens');
        if (u.usd_estimado != null) partes.push('\\u2248 US$ ' + nUS(u.usd_estimado));
        if (partes.length) { pe.style.display = ''; pe.textContent = partes.join(' \\u00B7 '); }
        rodapeDoUso(ev.hoje, ev.mes);
        /* a troca ficou guardada nesta conversa: a próxima pergunta entra nela */
        if (ev.conversa && ev.conversa.id) conversaId = ev.conversa.id;
      }
    }
    function acabar() {
      ocupado = false; enviar.disabled = false; enviar.style.opacity = '1';
      /* Codex #873 r4: a conexão com o servidor pode fechar "limpa" no meio (um intermediário corta a resposta). Resposta
         só está completa quando chegou o evento de FIM; sem ele (e sem erro), o que apareceu é um pedaço — avisa e NÃO
         guarda no histórico. É a mesma conferência que o servidor faz no fluxo que vem da API, na outra ponta. */
      if (!falhou && !chegouFim) { falhou = true; passo.style.display = ''; passo.style.color = '#ef4444'; passo.textContent = '\\u26A0\\uFE0F A resposta foi interrompida antes do fim (a conexão caiu). Tente de novo.'; rolar(); }
      if (!falhou && bruto.trim()) { historico.push({ role: 'user', content: cortar(texto) }); historico.push({ role: 'assistant', content: cortar(bruto) }); if (historico.length > 12) historico = historico.slice(-12); }
      else if (!falhou && !bruto.trim()) { passo.style.display = ''; passo.style.color = '#ef4444'; passo.textContent = '\\u26A0\\uFE0F A resposta veio vazia. Tente de novo.'; }
      caixa.focus();
    }

    fetch(BASE + '/chat-analise' + chaveQ(), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pergunta: texto, historico: historicoQueCabe(texto), conversa: conversaId || undefined }) })
      .then(function (r) {
        var tipo = (r.headers.get('content-type') || '');
        if (tipo.indexOf('text/event-stream') < 0) {
          return r.json().catch(function () { return null; }).then(function (j) {
            tratar({ t: 'erro', erro: (j && (j.erro || j.error)) || (r.status === 401 ? 'Sua sessão expirou: entre de novo no dashboard.' : r.status === 404 ? 'O chat é só pro administrador.' : 'O servidor respondeu ' + r.status + '.') });
          });
        }
        var leitor = r.body.getReader(), dec = new TextDecoder(), buf = '';
        function ler() {
          return leitor.read().then(function (x) {
            if (x.done) return;
            buf += dec.decode(x.value, { stream: true });
            var i;
            while ((i = buf.indexOf('\\n\\n')) >= 0) {
              var bloco = buf.slice(0, i); buf = buf.slice(i + 2);
              bloco.split('\\n').forEach(function (l) {
                if (l.indexOf('data:') !== 0) return;
                var ev = null; try { ev = JSON.parse(l.slice(5)); } catch (e) {}
                if (ev) tratar(ev);
              });
            }
            return ler();
          });
        }
        return ler();
      })
      /* a conexão com o servidor caiu (o navegador diz "NetworkError" / "Failed to fetch"). O caso mais comum é o sistema
         ter sido atualizado naquele instante — o serviço reinicia e corta o que estava no meio */
      .catch(function (e) { tratar({ t: 'erro', erro: 'A conexão com o servidor caiu antes de a resposta terminar. Se o sistema acabou de ser atualizado, espere um minuto e pergunte de novo. (' + String((e && e.message) || e).slice(0, 80) + ')' }); })
      .then(acabar);
  }

  botao.onclick = function () { painel.style.display = 'flex'; botao.style.display = 'none'; if (!lista.firstChild) { abertura(); estado(); } caixa.focus(); };
  fechar.onclick = function () { painel.style.display = 'none'; botao.style.display = ''; };
  nova.onclick = function () { if (ocupado) return; historico = []; conversaId = null; abertura(); };
  guardadas.onclick = listarConversas;
  enviar.onclick = function () { perguntar(caixa.value); };
  caixa.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); perguntar(caixa.value); } });

  /* encaixa o botão na coluna lateral, EM CIMA dos três que já estão lá. O dashboard monta a coluna antes de pedir esta
     peça; se ainda não existir, o botão nasce na reserva (no mesmo lugar) e a peça tenta de novo por alguns segundos. */
  function encaixar() {
    var nav = document.getElementById('navCards');
    if (!nav) return false;
    if (botao.parentNode !== nav) nav.insertBefore(botao, nav.firstChild);
    return true;
  }
  alvo.appendChild(estilo);
  alvo.appendChild(painel);
  if (!encaixar()) {
    alvo.appendChild(botao);
    var tentativas = 0;
    (function denovo() { if (encaixar() || ++tentativas >= 40) return; setTimeout(denovo, 250); })();
  }
})();`;
}

module.exports = { scriptDoChatAnalise, SUGESTOES, POSICAO_DO_BOTAO, BALAO };
