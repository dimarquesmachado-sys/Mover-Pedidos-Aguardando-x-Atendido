'use strict';
/* Toolbox — AS AÇÕES DA CENTRAL (2.1.14, 11/11 — pedido do dono: "toda vez que subo, tenho que ficar um por um do toolbox
   validando... ter uma tela só que liste tudo, mostre qual precisa de senha, login, e 1 único botão que mande e valide
   tudo de uma vez — e que já deixe definir qual empresa").

   Cada módulo que precisava de um clique próprio (Sessão Shopee, Cookie Bling, Madeira Madeira, Respostas Rápidas,
   Alerta Frágil, código da coleta) vira aqui UMA AÇÃO que devolve sempre o mesmo formato:
       { estado: 'ok' | 'login' | 'chave' | 'abrir' | 'pendente' | 'erro' | 'info', msg, site? }
   · 'login'  = falta entrar no site (a Central mostra o atalho pra abrir);
   · 'chave'  = falta a chave (a Central mostra qual campo preencher);
   · 'abrir'  = o site precisa estar aberto numa aba (Madeira, Vendas do ML);
   · 'pendente' = começou e ainda não terminou, ou terminou faltando parte (etiqueta do Madeira não entregue);
   · 'info'   = não há o que mandar agora — só o estado (o código da coleta NÃO é reenviado pelo "atualizar tudo").
   Nenhuma ação abre página, clica ou navega sozinha (Termos do ML, cláusula 12; e o mesmo cuidado nos outros sites):
   elas leem os cookies do site em que o dono JÁ está logado e mandam pro NOSSO servidor — como as telas de cada módulo
   já faziam, uma por uma. As telas antigas continuam funcionando.

   Sem DOM aqui: dá pra testar num navegador de mentira (scripts/teste-toolbox-central.js). */
(function (root) {
  const HOST = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
  const CHECKOUT = { girassol: 'girassol-backup-offline', good: 'good-checkout-offline', amb: 'amb-checkout-offline' };
  const NOME = { girassol: 'Magazine Girassol', good: 'GOOD Import', amb: 'AMBTotal' };
  /* Codex #845 (P1): os identificadores de loja do SERVIDOR das Respostas são MAIÚSCULOS (os mesmos de respostas.js) — os
     minúsculos são só o caminho do painel; com eles a API devolvia zero respostas e o painel do ML ficava vazio */
  const LOJA_RESPOSTAS = { girassol: 'GIRASSOL', good: 'GIMPO', amb: 'AMBTOTAL' };

  /* o que cada empresa tem — a mesma tabela do menu (popup.js) */
  const ITENS = [
    { id: 'shopee', nome: '🍊 Sessão Shopee', oque: 'cookies do Seller Center pro checkout', emp: ['girassol', 'good', 'amb'], chave: 'admin', site: 'https://seller.shopee.com.br/', sessao: true },
    { id: 'bling', nome: '🍪 Cookie Bling', oque: 'sessão do Bling pro importador de NF do Magalu Full', emp: ['good', 'amb'], chave: 'admin', site: 'https://www.bling.com.br/', sessao: true },
    { id: 'mm', nome: '🪵 Etiquetas Madeira Madeira', oque: 'sincroniza os lotes do painel MM', emp: ['girassol', 'good'], chave: 'mm', site: 'https://painelmarketplace.madeiramadeira.com.br/', sessao: true },
    { id: 'respostas', nome: '💬 Respostas Rápidas ML', oque: 'confere a conexão com o servidor das respostas', emp: ['girassol', 'good', 'amb'], chave: 'respostas' },
    { id: 'fragil', nome: '⚠️ Alerta Frágil', oque: 'baixa a lista de SKUs frágeis', emp: ['girassol', 'good', 'amb'] },
    { id: 'coleta', nome: '🔐 Código da coleta ML', oque: 'chave e último envio (não reenvia)', emp: ['girassol', 'good', 'amb'], chave: 'toolbox' },
  ];
  function itensDa(emp) { return ITENS.filter((i) => i.emp.indexOf(emp) !== -1); }

  const local = (ks) => chrome.storage.local.get(ks);
  const sync = (ks) => new Promise((ok) => { try { chrome.storage.sync.get(ks, (v) => ok(v || {})); } catch (e) { ok({}); } });
  const curto = (t) => String(t == null ? '' : t).slice(0, 220);

  /* Firefox (AMB): as permissões de host não vêm concedidas na instalação — sem elas o cookie volta vazio */
  async function garantirPermissao(origins) {
    try {
      if (!chrome.permissions || !chrome.permissions.contains) return true;
      if (await chrome.permissions.contains({ origins })) return true;
      return !!(await chrome.permissions.request({ origins }));
    } catch (e) { return true; }
  }
  async function postJson(url, corpo, cabecalhos) {
    const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, cabecalhos || {}), body: JSON.stringify(corpo) });
    let d = null; try { d = await r.json(); } catch (e) { d = null; }
    return { r, d };
  }

  /* ── as chaves, num lugar só (cada módulo continua lendo a SUA chave de sempre) ── */
  async function lerChaves() {
    const l = await local(['sceKey', 'tbBlingKey', 'coleta_key', 'syncKey', 'renderBase']);
    const s = await sync(['apiUrl', 'apiKey', 'loja']);
    return { admin: l.sceKey || l.tbBlingKey || '', toolbox: l.coleta_key || '', mm: l.syncKey || '', respostas: s.apiKey || '', respostasUrl: s.apiUrl || '' };
  }
  async function gravarChaves(c, emp) {
    const g = {};
    if (c.admin != null) { g.sceKey = String(c.admin).trim(); g.tbBlingKey = String(c.admin).trim(); }
    if (c.toolbox != null) g.coleta_key = String(c.toolbox).trim();
    if (c.mm != null) g.syncKey = String(c.mm).trim();
    await chrome.storage.local.set(g);
    if (c.respostas != null) {
      const atual = await sync(['apiUrl', 'loja']);
      /* a loja que já estava salva (escolhida na tela das Respostas) NÃO é sobrescrita; só preenche a que falta */
      await new Promise((ok) => chrome.storage.sync.set({ apiKey: String(c.respostas).trim(), apiUrl: atual.apiUrl || HOST, loja: atual.loja || LOJA_RESPOSTAS[emp] || '' }, ok));
    }
  }

  /* ── as ações ── */
  async function shopee(emp) {
    const dir = CHECKOUT[emp]; if (!dir) return { estado: 'erro', msg: 'escolha a empresa desta instalação' };
    const key = (await lerChaves()).admin; if (!key) return { estado: 'chave', msg: 'falta a ADMIN_KEY' };
    if (!(await garantirPermissao(['https://*.shopee.com.br/*', HOST + '/*']))) return { estado: 'erro', msg: 'sem permissão de acesso aos sites — aceite o pedido da extensão' };
    const todos = await chrome.cookies.getAll({ url: 'https://seller.shopee.com.br/' });
    if (!todos || !todos.length) return { estado: 'login', msg: 'entre no Seller Center da Shopee (conta da ' + NOME[emp] + ')', site: 'https://seller.shopee.com.br/' };
    const porNome = new Map(); for (const c of todos) porNome.set(c.name, c);
    const cookie = Array.from(porNome.values()).map((c) => c.name + '=' + c.value).join('; ');
    const { r, d } = await postJson(HOST + '/' + dir + '/shopee-sessao-cookies?k=' + encodeURIComponent(key), { cookie }, { 'X-Admin-Key': key });
    if (r.status === 401 || r.status === 403 || r.status === 404) return { estado: 'chave', msg: 'o servidor recusou a ADMIN_KEY (HTTP ' + r.status + ')' };
    if (!(r.ok && d && d.ok)) return { estado: 'erro', msg: curto((d && d.erro) || ('HTTP ' + r.status)) };
    if (!d.viva) return { estado: 'login', msg: 'sessão gravada, mas o teste não confirmou' + (d.teste && d.teste.motivo ? ' (' + curto(d.teste.motivo) + ')' : '') + ' — entre de novo no Seller Center', site: 'https://seller.shopee.com.br/' };
    return { estado: 'ok', msg: 'sessão gravada e VIVA (' + porNome.size + ' cookies)' };
  }

  async function bling(emp) {
    if (emp !== 'good' && emp !== 'amb') return { estado: 'info', msg: 'não se aplica a esta empresa' };
    const key = (await lerChaves()).admin; if (!key) return { estado: 'chave', msg: 'falta a ADMIN_KEY' };
    if (!(await garantirPermissao(['https://www.bling.com.br/*', HOST + '/*']))) return { estado: 'erro', msg: 'sem permissão de acesso aos sites — aceite o pedido da extensão' };
    const cookies = await chrome.cookies.getAll({ url: 'https://www.bling.com.br/' });
    if (!cookies || !cookies.length) return { estado: 'login', msg: 'entre no Bling (conta da ' + NOME[emp] + ')', site: 'https://www.bling.com.br/' };
    const header = cookies.map((c) => c.name + '=' + c.value).join('; ');
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    const { r, d } = await postJson(HOST + '/magalu/nf-full/cookie?empresa=' + emp + '&k=' + encodeURIComponent(key), { texto: 'cookie: ' + header + '\nuser-agent: ' + ua });
    if (r.status === 401 || r.status === 403 || r.status === 404) return { estado: 'chave', msg: 'o servidor recusou a ADMIN_KEY (HTTP ' + r.status + ')' };
    if (!(r.ok && d && d.ok)) return { estado: 'erro', msg: curto((d && d.erro) || ('HTTP ' + r.status)) };
    if (!d.tem_phpsessid) return { estado: 'login', msg: 'cookie salvo, mas sem a sessão (PHPSESSID) — entre de novo no Bling', site: 'https://www.bling.com.br/' };
    /* Codex #845: salvar o cookie NÃO prova que a sessão vale — o Bling pode tê-la derrubado do lado dele com o navegador
       ainda guardando o PHPSESSID. O servidor tem o teste de verdade (/cookie-testar abre a página do importador com o
       cookie salvo): só fica verde com `viva`. Três desfechos: viva → ok; o Bling recusou → login; o teste em si não
       rodou (rede, configuração) → erro dizendo que NÃO foi possível testar (não é o mesmo que "sessão ruim"). */
    let rt = null, dt = null;
    try { rt = await fetch(HOST + '/magalu/nf-full/cookie-testar?empresa=' + emp + '&k=' + encodeURIComponent(key)); dt = await rt.json(); } catch (e) { dt = null; }
    if (dt && dt.viva) return { estado: 'ok', msg: 'cookie salvo e sessão do Bling VIVA (' + d.caracteres + ' caracteres)' };
    if (dt && dt.ok && dt.viva === false) return { estado: 'login', msg: 'cookie salvo, mas o Bling recusou a sessão' + (dt.motivo ? ' (' + curto(dt.motivo) + ')' : '') + ' — entre de novo no Bling', site: 'https://www.bling.com.br/' };
    return { estado: 'erro', msg: 'cookie salvo, mas não consegui testar a sessão: ' + curto((dt && dt.erro) || (rt ? 'HTTP ' + rt.status : 'sem resposta do servidor')) };
  }

  async function respostas(emp) {
    const s = await sync(['apiUrl', 'apiKey', 'loja']);
    const apiUrl = String(s.apiUrl || HOST).replace(/\/$/, '');
    const loja = s.loja || LOJA_RESPOSTAS[emp] || '';
    if (!s.apiKey) return { estado: 'chave', msg: 'falta a chave das Respostas Rápidas' };
    const r = await fetch(apiUrl + '/respostas-rapidas/api/respostas?loja=' + encodeURIComponent(loja), { headers: { 'X-API-Key': s.apiKey } });
    if (r.status === 401 || r.status === 403) return { estado: 'chave', msg: 'o servidor recusou a chave das Respostas (HTTP ' + r.status + ')' };
    if (!r.ok) return { estado: 'erro', msg: 'HTTP ' + r.status };
    let d = null; try { d = await r.json(); } catch (e) { d = null; }
    return { estado: 'ok', msg: ((d && d.respostas) || []).length + ' respostas para ' + loja };
  }

  /* o Frágil já sincroniza sozinho; aqui pede uma rodada agora. Sem o endereço do servidor configurado (instalação nova),
     usa o de produção — é o mesmo do atalho "Painel Frágil" do menu. */
  async function fragil() {
    const g = await local(['extension_config']);
    const cfg = g.extension_config || {};
    if (!cfg.servidorUrl) await chrome.storage.local.set({ extension_config: Object.assign({ intervaloMin: 5 }, cfg, { servidorUrl: HOST }) });
    const resp = await new Promise((ok) => { try { chrome.runtime.sendMessage({ type: 'SYNC_AGORA' }, (x) => { void chrome.runtime.lastError; ok(x); }); } catch (e) { ok(null); } });
    if (resp && resp.ok) return { estado: 'ok', msg: resp.skus + ' SKU(s) frágeis na lista' };
    if (resp && resp.ok === false) return { estado: 'erro', msg: curto(resp.erro || 'a sincronização falhou') };
    const d = (await local(['fragile_data'])).fragile_data;
    if (d && d.skus) return { estado: 'ok', msg: Object.keys(d.skus).length + ' SKU(s) frágeis na lista (da última sincronização)' };
    return { estado: 'erro', msg: 'sem resposta da sincronização — recarregue a extensão e tente de novo' };
  }

  /* o Madeira precisa da aba do painel aberta e logada (a página é quem lê os lotes) */
  async function mm(emp, opc) {
    if (emp !== 'girassol' && emp !== 'good') return { estado: 'info', msg: 'não se aplica a esta empresa' };
    const c = await local(['syncKey', 'tb_empresa']); if (!c.syncKey) return { estado: 'chave', msg: 'falta a chave do Madeira Madeira' };
    /* Codex #845 (4): o fundo da extensão manda os lotes pra empresa GRAVADA na hora do envio — se outra tela (popup, outra
       aba da Central) trocou a empresa, a confirmada aqui não é mais o destino: não começa */
    if (c.tb_empresa && c.tb_empresa !== emp) return { estado: 'erro', msg: 'a empresa desta instalação mudou em outra tela — recarregue a Central e confira a empresa antes de sincronizar o Madeira' };
    let tabs = [];
    try { tabs = await chrome.tabs.query({ url: 'https://painelmarketplace.madeiramadeira.com.br/*' }); } catch (e) { tabs = []; }
    if (!tabs || !tabs.length) return { estado: 'abrir', msg: 'abra o painel do Madeira Madeira e faça login', site: 'https://painelmarketplace.madeiramadeira.com.br/' };
    const pedido = Date.now() + '-' + Math.random().toString(36).slice(2);
    const meu = (s) => !!s && s.motivo === 'manual' && Array.isArray(s.pedidos) && s.pedidos.indexOf(pedido) !== -1;
    const esperaMs = (opc && opc.esperaMs) || 90000;
    const limiteMs = (opc && opc.limiteMs) || 10 * 60000;
    /* Codex #845: a rodada do Madeira pode passar dos 90 s (60 s por etiqueta, 200 s por rodada, e fila atrás de uma rodada
       automática) — depois do aviso o ouvinte CONTINUA (até 10 min) e o resultado de verdade substitui o aviso, pelo
       `opc.depois`. Sem isso uma sincronização boa deixava a tela vermelha pra sempre. */
    let avisou = false, tAviso = null, tLimite = null, resolver = null;
    const fim = new Promise((ok) => { resolver = ok; });
    const ouvinte = (mud, area) => {
      /* empresa trocada por outra tela no meio da rodada = o destino dos lotes mudou: o resultado não vale pra empresa pedida */
      if (area === 'local' && mud.tb_empresa && mud.tb_empresa.newValue && mud.tb_empresa.newValue !== emp) {
        chrome.storage.onChanged.removeListener(ouvinte); clearTimeout(tAviso); clearTimeout(tLimite);
        const r = { estado: 'erro', msg: 'a empresa foi trocada em outra tela durante a sincronização — os lotes podem ter ido pra outra empresa; confira e sincronize de novo' };
        if (avisou) { if (opc && typeof opc.depois === 'function') opc.depois(r); } else resolver({ __empresa: r });
        return;
      }
      if (area !== 'local' || !mud.ultimoStatus) return;
      const nv = mud.ultimoStatus.newValue || {};
      if (!meu(nv)) return;
      chrome.storage.onChanged.removeListener(ouvinte); clearTimeout(tAviso); clearTimeout(tLimite);
      if (avisou) { if (opc && typeof opc.depois === 'function') opc.depois(lerResultadoMM(nv)); } else resolver(nv);
    };
    chrome.storage.onChanged.addListener(ouvinte);
    tAviso = setTimeout(() => { avisou = true; resolver(null); }, esperaMs);
    tLimite = setTimeout(() => { chrome.storage.onChanged.removeListener(ouvinte); if (opc && typeof opc.depois === 'function') opc.depois({ estado: 'erro', msg: 'a sincronização não terminou em ' + Math.round(limiteMs / 60000) + ' min — VPN ligada? painel logado? Recarregue a página do Madeira (F5) e tente de novo' }); }, limiteMs);
    const entregue = await new Promise((ok) => { try { chrome.tabs.sendMessage(tabs[0].id, { tipo: 'MM_SYNC_AGORA', pedido }, () => ok(!chrome.runtime.lastError)); } catch (e) { ok(false); } });
    if (!entregue) {
      chrome.storage.onChanged.removeListener(ouvinte); clearTimeout(tAviso); clearTimeout(tLimite);
      return { estado: 'abrir', msg: 'recarregue a página do Madeira Madeira (F5) e tente de novo', site: 'https://painelmarketplace.madeiramadeira.com.br/' };
    }
    const s = await fim;
    if (s && s.__empresa) return s.__empresa;
    /* `andando: true` = a rodada CONTINUA lá na página do Madeira; o fim chega pelo `opc.depois` (resultado ou limite) */
    if (!s) return { estado: 'pendente', andando: true, msg: 'ainda sincronizando (lendo os lotes e baixando as etiquetas — pode levar alguns minutos); o resultado aparece aqui quando terminar' };
    return lerResultadoMM(s);
  }
  /* o resultado de uma rodada do Madeira, no formato da Central. Codex #845: lote lido com ETIQUETA NÃO ENTREGUE não é
     "tudo certo" — o bg-mm grava ok:true com `zpl_falhas`, e a tela do módulo já mostrava; aqui também. */
  function lerResultadoMM(s) {
    if (s.etapa === 'ler_mm') return { estado: 'login', msg: 'não consegui ler os lotes (status ' + (s.status || '?') + ') — o painel está logado?', site: 'https://painelmarketplace.madeiramadeira.com.br/' };
    if (!s.ok) return { estado: 'erro', msg: curto(s.erro || ('status ' + s.status)) };
    const base = 'lidos ' + (s.lidos || 0) + ', prontos ' + (s.prontos || 0) + (s.etiquetas ? ', etiquetas ' + s.etiquetas : '');
    const falhas = Array.isArray(s.zpl_falhas) ? s.zpl_falhas : [];
    if (falhas.length) return { estado: 'pendente', msg: 'sincronizado (' + base + '), mas ' + falhas.length + ' etiqueta(s) ainda não entregue(s): ' + curto(falhas.map((f) => 'lote ' + f.batch + ' — ' + f.motivo + (f.esperando ? ' (tenta de novo sozinho)' : '')).join('; ')) };
    return { estado: 'ok', msg: 'sincronizado: ' + base };
  }

  /* o código da coleta NÃO é reenviado pelo "atualizar tudo" (cada reenvio manda e-mail pro estoque): só o estado */
  async function coleta(emp) {
    const c = await local(['coleta_key', 'coleta_ok', 'coleta_status']);
    if (!c.coleta_key) return { estado: 'chave', msg: 'falta a TOOLBOX_KEY' };
    const ok = c.coleta_ok && c.coleta_ok.empresa === emp ? c.coleta_ok : null;
    return { estado: 'info', msg: 'chave salva · último código entregue: ' + (ok ? ok.dia.split('-').reverse().join('/') : 'nenhum ainda') + ' (vai sozinho quando alguém abre a página de Vendas do ML)' };
  }

  const ACOES = { shopee, bling, mm, respostas, fragil, coleta };

  /* O "ATUALIZAR E VALIDAR TUDO": uma ação por vez, na ordem da lista da empresa; uma que falha não derruba as outras */
  async function atualizarTudo(emp, aoAndar, acoes) {
    const A = acoes || ACOES; const saida = [];
    for (const item of itensDa(emp)) {
      if (aoAndar) aoAndar(item.id, { estado: 'rodando', msg: 'conferindo…' });
      let r;
      try { r = await A[item.id](emp, { depois: (r2) => { if (aoAndar && r2 && r2.estado) aoAndar(item.id, r2, true); } }); } catch (e) { r = { estado: 'erro', msg: curto((e && e.message) || e) }; }
      if (!r || !r.estado) r = { estado: 'erro', msg: 'sem resposta' };
      saida.push(Object.assign({ id: item.id }, r));
      if (aoAndar) aoAndar(item.id, r);
    }
    return saida;
  }

  root.tbAcoes = { HOST, CHECKOUT, NOME, LOJA_RESPOSTAS, ITENS, itensDa, lerChaves, gravarChaves, ACOES, atualizarTudo, lerResultadoMM };
})(typeof self !== 'undefined' ? self : this);
