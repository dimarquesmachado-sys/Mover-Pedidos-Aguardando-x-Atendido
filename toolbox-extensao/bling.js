/* Cookie Bling → Render (modulo da GIRASSOL — a rota /cookie-setup e da raiz).
   Codigo original da Extensao-cookie-bling, agora dentro da Toolbox. */
'use strict';
const RENDER = 'https://mover-pedidos-aguardando-x-atendido.onrender.com/cookie-setup';

document.getElementById('b').addEventListener('click', async () => {
  const st = document.getElementById('st');
  st.textContent = 'Pegando cookie do Bling...';
  try {
    const cookies = await chrome.cookies.getAll({ domain: 'bling.com.br' });
    if (!cookies.length) {
      st.textContent = '❌ Nenhum cookie do Bling encontrado. Você está logado em bling.com.br?';
      return;
    }
    const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    st.textContent = 'Enviando pro Render (' + cookies.length + ' cookies)...';
    const r = await fetch(RENDER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ curl: header })
    });
    const d = await r.json();
    st.textContent = d.ok
      ? '✅ Cookie enviado (' + d.tamanho + ' caracteres)! O importador já está usando.'
      : '❌ ' + (d.erro || 'erro ao salvar');
  } catch (e) {
    st.textContent = '❌ ' + e.message;
  }
});
