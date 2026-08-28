/* Cookie Bling → importador de NF Magalu Full (GOOD e AMB — a rota do magalu-oauth so
   aceita essas duas; a antiga /cookie-setup da Girassol nunca esteve montada no servidor).
   Manda o header de cookies + user-agent no formato que o blingExtrairCookie/UA entendem. */
'use strict';
const HOST = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['tb_empresa', 'tbBlingKey', 'sceKey'], (v) => {
  $('emp').textContent = v.tb_empresa === 'amb' ? 'AMBTotal' : 'GOOD Import';
  $('key').value = v.tbBlingKey || v.sceKey || '';   // mesma ADMIN_KEY do painel Shopee
});

$('b').addEventListener('click', async () => {
  const st = $('st');
  const key = $('key').value.trim();
  if (!key) { st.textContent = '❌ cole a ADMIN_KEY primeiro'; return; }
  chrome.storage.local.set({ tbBlingKey: key });
  st.textContent = 'Pegando cookie do Bling...';
  try {
    const emp = (await new Promise(ok => chrome.storage.local.get(['tb_empresa'], v => ok(v.tb_empresa)))) === 'amb' ? 'amb' : 'good';
    const cookies = await chrome.cookies.getAll({ url: 'https://www.bling.com.br/' });
    if (!cookies.length) {
      st.textContent = '❌ Nenhum cookie do Bling encontrado. Você está logado em www.bling.com.br?';
      return;
    }
    const header = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    st.textContent = 'Enviando pro importador (' + cookies.length + ' cookies)...';
    const r = await fetch(HOST + '/magalu/nf-full/cookie?empresa=' + emp + '&k=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texto: 'cookie: ' + header + '\nuser-agent: ' + navigator.userAgent })
    });
    const d = await r.json().catch(() => null);
    st.textContent = (r.ok && d && d.ok)
      ? '✅ Cookie salvo pra ' + emp.toUpperCase() + ' (' + d.caracteres + ' caracteres' + (d.tem_phpsessid ? ', com PHPSESSID' : ', ⚠ sem PHPSESSID') + ')! O importador já usa.'
      : '❌ ' + ((d && d.erro) || ('HTTP ' + r.status));
  } catch (e) {
    st.textContent = '❌ ' + e.message;
  }
});
