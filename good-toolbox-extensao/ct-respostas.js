// AMB Respostas Rápidas ML - Content Script
(function() {
  'use strict';
  if (window.__ambRRInjected) return;
  window.__ambRRInjected = true;

  // Retorna 'mensagens', 'reclamacoes', ou null se não for página relevante
  function detectarCategoria() {
    const url = window.location.href;
    // Apenas estas URLs ativam o painel:
    // /vendas/novo/mensagens/<id>                            → mensagens
    // /vendas/novo/mensagens/<id>/reclamacao/<id>            → reclamacoes
    // /vendas/novo/mensagens/<id>/mediacao/<id>              → reclamacoes
    const matchMensagens = /\/vendas\/novo\/mensagens\/\d+/i.test(url);
    if (!matchMensagens) return null;
    if (/\/reclamacao\//i.test(url) || /\/mediacao\//i.test(url)) {
      return 'reclamacoes';
    }
    return 'mensagens';
  }

  function detectarLoja() {
    const seletores = [
      '[class*="nav-header-user"]',
      '[class*="user-nickname"]',
      '[data-link-id="user"]',
      'header [class*="username"]',
      '.nav-header-username'
    ];
    const lojasMap = {
      'AMBTOTAL': 'AMBTOTAL',
      'MAGAZINEGIRASSOL': 'GIRASSOL',
      'GIMPO': 'GIMPO'
    };
    for (const sel of seletores) {
      const el = document.querySelector(sel);
      if (el) {
        const txt = (el.textContent || '').toUpperCase().replace(/\s+/g, '');
        for (const [chave, valor] of Object.entries(lojasMap)) {
          if (txt.includes(chave)) return valor;
        }
      }
    }
    const header = document.querySelector('header, [class*="header"]');
    if (header) {
      const txt = header.textContent.toUpperCase().replace(/\s+/g, '');
      for (const [chave, valor] of Object.entries(lojasMap)) {
        if (txt.includes(chave)) return valor;
      }
    }
    return null;
  }

  function montarPainel(loja, categoria) {
    const antigo = document.getElementById('amb-rr-panel');
    if (antigo) antigo.remove();
    const painel = document.createElement('div');
    painel.id = 'amb-rr-panel';
    painel.innerHTML = `
      <div class="amb-rr-header" id="amb-rr-header">
        <div class="amb-rr-title">
          <span>💬</span>
          <span class="amb-rr-title-text">Respostas Rápidas</span>
        </div>
        <button class="amb-rr-toggle" id="amb-rr-toggle">−</button>
      </div>
      <div class="amb-rr-context">
        <span class="amb-rr-context-tag loja">${loja || '???'}</span>
        <span class="amb-rr-context-tag">${categoria}</span>
      </div>
      <div class="amb-rr-body" id="amb-rr-body">
        <div class="amb-rr-loading">Carregando...</div>
      </div>
    `;
    document.body.appendChild(painel);

    // Restaurar posição salva (se houver) via chrome.storage.local
    try {
      chrome.storage.local.get(['amb-rr-pos'], (result) => {
        const saved = result && result['amb-rr-pos'];
        if (saved) {
          if (saved.left) painel.style.setProperty('left', saved.left, 'important');
          if (saved.top) painel.style.setProperty('top', saved.top, 'important');
          painel.style.setProperty('right', 'auto', 'important');
          painel.style.setProperty('bottom', 'auto', 'important');
        }
      });
    } catch (e) { /* ignora */ }

    const toggle = document.getElementById('amb-rr-toggle');
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      painel.classList.toggle('collapsed');
      toggle.textContent = painel.classList.contains('collapsed') ? '💬' : '−';
    });
    habilitarDrag(painel, document.getElementById('amb-rr-header'));
  }

  function habilitarDrag(painel, handle) {
    let drag = false, offsetX = 0, offsetY = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.id === 'amb-rr-toggle') return;
      drag = true;
      offsetX = e.clientX - painel.getBoundingClientRect().left;
      offsetY = e.clientY - painel.getBoundingClientRect().top;
      document.body.style.userSelect = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!drag) return;
      painel.style.setProperty('left', (e.clientX - offsetX) + 'px', 'important');
      painel.style.setProperty('top', (e.clientY - offsetY) + 'px', 'important');
      painel.style.setProperty('right', 'auto', 'important');
      painel.style.setProperty('bottom', 'auto', 'important');
    });
    document.addEventListener('mouseup', () => {
      if (drag) {
        // Salva a posição final pra restaurar na próxima vez (via chrome.storage.local)
        try {
          const pos = {
            left: painel.style.left,
            top: painel.style.top
          };
          chrome.storage.local.set({ 'amb-rr-pos': pos });
        } catch (e) { /* ignora */ }
      }
      drag = false;
      document.body.style.userSelect = '';
    });
  }

  async function buscarRespostas(cfg, loja, categoria) {
    const url = `${cfg.apiUrl}/respostas-rapidas/api/respostas?loja=${encodeURIComponent(loja)}&categoria=${encodeURIComponent(categoria)}`;
    const r = await fetch(url, { headers: { 'X-API-Key': cfg.apiKey } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    return data.respostas || [];
  }

  function renderizarBotoes(respostas) {
    const body = document.getElementById('amb-rr-body');
    if (!body) return;
    if (respostas.length === 0) {
      body.innerHTML = '<div class="amb-rr-empty">Nenhuma resposta cadastrada. Cadastre no painel web.</div>';
      return;
    }
    body.innerHTML = '';
    respostas.forEach(r => {
      const btn = document.createElement('button');
      btn.className = 'amb-rr-btn';
      // Normalizar categoria 'geral' antigo para 'ambos'
      const cat = r.categoria === 'geral' ? 'ambos' : r.categoria;
      btn.setAttribute('data-categoria', cat);
      btn.title = r.texto;
      btn.textContent = r.titulo;
      btn.addEventListener('click', () => colarTexto(r.texto));
      body.appendChild(btn);
    });
  }

  function encontrarCampoMensagem() {
    const seletores = [
      'textarea[placeholder*="comprador" i]',
      'textarea[placeholder*="escreva" i]',
      'textarea[placeholder*="mensagem" i]',
      'input[placeholder*="comprador" i]',
      'input[placeholder*="escreva" i]',
      'textarea[name*="message" i]',
      'textarea[id*="message" i]',
      '[contenteditable="true"]',
      'textarea'
    ];
    for (const sel of seletores) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 20 && !el.disabled && !el.readOnly) {
          return el;
        }
      }
    }
    return null;
  }

  async function colarTexto(texto) {
    const campo = encontrarCampoMensagem();
    if (!campo) {
      try {
        await navigator.clipboard.writeText(texto);
        showToast('📋 Campo não encontrado. Texto copiado - cole com Ctrl+V', false);
      } catch (e) {
        showToast('❌ Erro: ' + e.message, true);
      }
      return;
    }
    campo.focus();
    if (campo.tagName === 'TEXTAREA' || campo.tagName === 'INPUT') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        campo.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value'
      ).set;
      nativeSetter.call(campo, texto);
      campo.dispatchEvent(new Event('input', { bubbles: true }));
      campo.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (campo.isContentEditable) {
      campo.textContent = texto;
      campo.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    showToast('✅ Texto colado! Revise e envie.', false);
    try { await navigator.clipboard.writeText(texto); } catch (e) {}
  }

  function showToast(msg, erro) {
    const existing = document.querySelector('.amb-rr-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = 'amb-rr-toast' + (erro ? ' err' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  async function init() {
    const categoria = detectarCategoria();

    // Se a URL atual não for de mensagens/reclamação, remover painel e sair
    if (!categoria) {
      const antigo = document.getElementById('amb-rr-panel');
      if (antigo) antigo.remove();
      return;
    }

    const cfg = await new Promise(resolve => {
      chrome.storage.sync.get(['apiUrl', 'apiKey', 'loja', 'detectarAuto'], resolve);
    });
    if (!cfg.apiUrl || !cfg.apiKey) {
      montarPainel('?', categoria);
      const body = document.getElementById('amb-rr-body');
      if (body) {
        body.innerHTML = '<div class="amb-rr-error">⚙️ Configure URL e API Key clicando no ícone da extensão.</div>';
      }
      return;
    }
    let loja = cfg.loja || 'AMBTOTAL';
    if (cfg.detectarAuto !== false) {
      const detectada = detectarLoja();
      if (detectada) loja = detectada;
    }
    montarPainel(loja, categoria);
    try {
      const respostas = await buscarRespostas(cfg, loja, categoria);
      renderizarBotoes(respostas);
    } catch (e) {
      const body = document.getElementById('amb-rr-body');
      if (body) {
        body.innerHTML = `<div class="amb-rr-error">❌ Erro ao carregar: ${e.message}</div>`;
      }
    }
  }

  let urlAtual = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== urlAtual) {
      urlAtual = location.href;
      setTimeout(init, 600);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(init, 500);
})();
