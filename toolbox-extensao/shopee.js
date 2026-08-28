/* 27/08 — captura os cookies da sessão logada (.shopee.com.br) e envia pro serviço.
   Dedupe por NOME preferindo o domínio mais específico (seller.shopee.com.br vence
   .shopee.com.br) — o jar do serviço funde por nome do mesmo jeito. */
const HOST = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
const $ = (id) => document.getElementById(id);

/* Toolbox 2.0: o default segue a EMPRESA da instância (tb_empresa); o seletor continua
   disponível pra casos excepcionais. */
const MAPA_EMP = { girassol: 'girassol-backup-offline', good: 'good-checkout-offline', amb: 'amb-checkout-offline' };
chrome.storage.local.get(['sceKey', 'sceEmp', 'tb_empresa'], (v) => {
  $('emp').value = v.sceEmp || MAPA_EMP[v.tb_empresa] || 'good-checkout-offline';
  if (v.sceKey) $('key').value = v.sceKey;
});

$('btn').addEventListener('click', async () => {
  const key = $('key').value.trim();
  const emp = $('emp').value;
  const res = $('res');
  if (!key) { res.innerHTML = '<span class="err">cole a ADMIN_KEY primeiro</span>'; return; }
  chrome.storage.local.set({ sceKey: key, sceEmp: emp });
  $('btn').disabled = true;
  res.textContent = '⏳ capturando cookies…';
  try {
    /* Codex #236 r5: captura pelo URL do Seller Center — o navegador resolve dominio/path e
       devolve SO o que seria enviado ao seller (cookie de outro subdominio fica fora). */
    const todos = await chrome.cookies.getAll({ url: 'https://seller.shopee.com.br/' });
    if (!todos || !todos.length) { res.innerHTML = '<span class="err">nenhum cookie da Shopee — entre no seller.shopee.com.br primeiro</span>'; $('btn').disabled = false; return; }
    const porNome = new Map();
    for (const c of todos) porNome.set(c.name, c);
    const cookie = Array.from(porNome.values()).map(c => c.name + '=' + c.value).join('; ');
    /* Codex #236 r5 (P1, mitigacao): o teste do servidor confirma que a sessao esta VIVA, nao
       QUAL conta e — enviar a conta de uma empresa pra outra passaria verde. Validacao real
       (shop_id da sessao x esperado por empresa) e do lado do servidor e esta anotada como
       melhoria; aqui, confirmacao explicita antes de enviar. */
    const nomeEmp = { 'girassol-backup-offline': 'GIRASSOL', 'amb-checkout-offline': 'AMB', 'good-checkout-offline': 'GOOD' }[emp] || emp;
    if (!confirm('A conta logada no Seller Center desta janela é a da ' + nomeEmp + '?')) { res.textContent = ''; $('btn').disabled = false; return; }
    res.textContent = '⏳ enviando ' + porNome.size + ' cookies…';
    /* a chave vai na QUERY: o guard global do app valida por ?k= antes das rotas */
    const r = await fetch(HOST + '/' + emp + '/shopee-sessao-cookies?k=' + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify({ cookie })
    });
    const d = await r.json().catch(() => null);
    if (r.ok && d && d.ok) {
      res.innerHTML = d.viva
        ? '<span class="ok">✅ sessão gravada e VIVA (' + porNome.size + ' cookies)</span>'
        : '<span class="err">⚠ gravada, mas o teste não confirmou a sessão' + (d.teste && d.teste.motivo ? (' — ' + d.teste.motivo) : '') + '. Confere se a conta logada é a da empresa escolhida.</span>';
    } else {
      res.innerHTML = '<span class="err">falhou: ' + ((d && d.erro) || ('HTTP ' + r.status)) + '</span>';
    }
  } catch (e) {
    res.innerHTML = '<span class="err">erro: ' + (e.message || e) + '</span>';
  }
  $('btn').disabled = false;
});
