/* =====================================================================
   GOOD - Alerta Produto Frágil — Painel admin v3.0
   ===================================================================== */

const VERSAO = "v3.0";
const $ = (id) => document.getElementById(id);

// ----- Storage de sessão -----
const SESSION_KEY = "fragil_admin_session";
function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
}
function setSession(s) { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
function clearSession() { sessionStorage.removeItem(SESSION_KEY); }

// ----- HTTP helpers -----
async function api(path, options = {}) {
  const sess = getSession();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (sess?.token) headers["X-Session-Token"] = sess.token;
  const r = await fetch(path, { ...options, headers });
  if (r.status === 401) {
    clearSession();
    mostrarLogin();
    throw new Error("Sessão expirada. Faça login novamente.");
  }
  let data = {};
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) throw new Error(data.erro || ("HTTP " + r.status));
  return data;
}

// ============================================================
// LOGIN
// ============================================================
async function inicializar() {
  // Verifica se já tem sessão válida
  const sess = getSession();
  if (sess?.token) {
    try {
      const me = await api("/fragil/api/me");
      if (me.ok) {
        setSession({ ...sess, ...me });
        mostrarConteudo();
        return;
      }
    } catch (_) {
      clearSession();
    }
  }
  mostrarLogin();
}

async function mostrarLogin() {
  $("conteudo").classList.add("escondido");
  $("login-tela").classList.add("visivel");
  // Avisa se for chave-mestra
  try {
    const r = await fetch("/fragil/health");
    const j = await r.json();
    if (j.chaveMestraAtiva) $("login-aviso-mestra").style.display = "block";
  } catch (_) {}
  setTimeout(() => $("login-usuario").focus(), 100);
}

async function fazerLogin() {
  const usuario = $("login-usuario").value.trim();
  const senha = $("login-senha").value;
  $("login-erro").textContent = "";
  if (!usuario || !senha) {
    $("login-erro").textContent = "Preencha usuário e senha.";
    return;
  }
  $("btn-login").disabled = true;
  $("btn-login").textContent = "Entrando...";
  try {
    const r = await fetch("/fragil/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.erro || "Falha no login");
    setSession(j);
    $("login-tela").classList.remove("visivel");
    $("login-senha").value = "";
    mostrarConteudo();
  } catch (e) {
    $("login-erro").textContent = e.message;
  } finally {
    $("btn-login").disabled = false;
    $("btn-login").textContent = "Entrar";
  }
}

async function logout() {
  try { await api("/fragil/api/logout", { method: "POST" }); } catch (_) {}
  clearSession();
  location.reload();
}

// ============================================================
// CONTEÚDO PRINCIPAL
// ============================================================
function mostrarConteudo() {
  const sess = getSession();
  $("user-nome").textContent = sess?.nome || sess?.usuario || "?";
  if (sess?.chaveMestra) {
    $("user-nome").textContent += " (chave-mestra)";
  }
  $("conteudo").classList.remove("escondido");
  carregarStatus();
  carregar();
  carregarUsuarios();
}

// ============================================================
// STATUS DO SISTEMA
// ============================================================
async function carregarStatus() {
  try {
    const r = await fetch("/fragil/health");
    const h = await r.json();
    let cache = null;
    try {
      const r2 = await fetch("/fragil/api/cache-status");
      cache = await r2.json();
    } catch (_) {}

    const itens = [];
    itens.push(badge(h.blingConfigurado ? "ok" : "erro", "Bling configurado", h.blingConfigurado ? "✅ Sim" : "❌ Não"));
    itens.push(badge(h.blingLogado ? "ok" : "erro", "Bling logado", h.blingLogado ? "✅ Sim" : "❌ Não"));
    if (cache) {
      const skuStatus = cache.skusIndexados > 0 ? "ok" : "aviso";
      itens.push(badge(skuStatus, "SKUs no cache", cache.skusIndexados));
      const detStatus = cache.eansCarregados ? "ok" : "aviso";
      const det = `${cache.detalhesEmCache}/${cache.skusIndexados}` + (cache.eansCarregados ? " ✅" : " ⏳");
      itens.push(badge(detStatus, "Detalhes (nome+EAN+imagem)", det));
    }
    itens.push(badge("ok", "Usuários cadastrados", h.usuariosCadastrados));
    itens.push(badge("ok", "SKUs frágeis", h.skusFrageis));

    $("status-painel").innerHTML = itens.join("");
    $("versao-info").textContent = `${VERSAO} · ${h.atualizadoEm ? "atualizado " + new Date(h.atualizadoEm).toLocaleString("pt-BR") : "sem dados ainda"}`;

    // Alerta se Bling não está logado
    const $alerta = $("alerta-bling");
    if (!h.blingLogado) {
      $alerta.innerHTML = `⚠️ <b>Bling não está logado.</b> Sem isso, a busca de produtos não funciona. <a href="/fragil/auth/bling" target="_blank">Clique aqui pra fazer login no Bling</a> (uma vez só).`;
      $alerta.style.display = "block";
    } else if (cache && cache.skusIndexados === 0) {
      $alerta.innerHTML = `⏳ Bling logado, carregando produtos do cache... aguarde ~30 segundos e atualize a página.`;
      $alerta.style.display = "block";
    } else if (cache && !cache.eansCarregados) {
      $alerta.innerHTML = `⏳ Carregando detalhes (nomes, imagens, EANs) em segundo plano: ${cache.detalhesEmCache}/${cache.skusIndexados}. Busca por SKU já funciona; busca por nome/EAN fica completa em ~${Math.ceil((cache.skusIndexados - cache.detalhesEmCache) / 60)} min.`;
      $alerta.style.display = "block";
    } else {
      $alerta.style.display = "none";
    }
  } catch (e) {
    $("status-painel").innerHTML = `<span class="erro">Erro ao carregar status: ${e.message}</span>`;
  }
}

function badge(cls, label, valor) {
  return `<div><b>${label}:</b> <span class="badge-status badge-${cls}">${valor}</span></div>`;
}

// Atualiza o status a cada 30s
setInterval(() => {
  if (!$("conteudo").classList.contains("escondido")) carregarStatus();
}, 30000);

// ============================================================
// TABELA DE SKUs FRÁGEIS
// ============================================================
const $tbody = () => $("tbody-skus");
const $contador = () => $("contador");
const $filtro = () => $("filtro");

// Mapa local: SKU → { nome, imagem, ean, mensagem }
let skusEnriquecidos = {};

function adicionarLinha(sku = "", msg = "", info = {}, focar = false) {
  if (!sku && !msg) {
    const linhas = $tbody().querySelectorAll("tr");
    for (const tr of linhas) {
      const skuInput = tr.querySelector(".input-sku");
      if (skuInput && !skuInput.value.trim()) {
        skuInput.focus();
        atualizarContador();
        return;
      }
    }
  }
  const tr = document.createElement("tr");
  const imgHtml = info.imagem
    ? `<img src="${escapeHtml(info.imagem)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';" /><span class="sem-img" style="display:none;">📦</span>`
    : `<span class="sem-img">📦</span>`;
  tr.innerHTML = `
    <td class="col-img">${imgHtml}</td>
    <td class="col-sku"><input type="text" class="input-sku" placeholder="Ex: KJDD-E-187" /></td>
    <td class="col-nome"><span class="span-nome">${escapeHtml(info.nome || "")}</span></td>
    <td class="col-msg"><input type="text" class="input-msg" placeholder="Deixe em branco pra usar a mensagem padrão" maxlength="500" /></td>
    <td class="col-acao"><button type="button" class="btn-remover" title="Remover">✕</button></td>
  `;
  const skuInput = tr.querySelector(".input-sku");
  const msgInput = tr.querySelector(".input-msg");
  const btnRemover = tr.querySelector(".btn-remover");
  skuInput.value = sku;
  msgInput.value = msg;
  // Guarda info original no dataset
  if (info.imagem) tr.dataset.imagem = info.imagem;
  if (info.nome) tr.dataset.nome = info.nome;

  skuInput.addEventListener("input", atualizarContador);
  skuInput.addEventListener("input", aplicarFiltro);
  msgInput.addEventListener("input", aplicarFiltro);
  msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); adicionarLinha("", "", {}, true); }
  });
  skuInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); msgInput.focus(); }
  });
  btnRemover.addEventListener("click", () => {
    if (skuInput.value.trim() || msgInput.value.trim()) {
      if (!confirm(`Remover o SKU "${skuInput.value}"?`)) return;
    }
    tr.remove();
    atualizarContador();
    if ($tbody().children.length === 0) adicionarLinha();
  });
  $tbody().appendChild(tr);
  if (focar) skuInput.focus();
  atualizarContador();
}

function lerTabelaParaMapa() {
  const mapa = {};
  const linhas = $tbody().querySelectorAll("tr");
  for (const tr of linhas) {
    const sku = tr.querySelector(".input-sku")?.value.trim() || "";
    const msg = tr.querySelector(".input-msg")?.value.trim() || "";
    if (sku) mapa[sku] = msg;
  }
  return mapa;
}

function preencherTabelaDoMapa(mapa) {
  $tbody().innerHTML = "";
  const skus = Object.keys(mapa || {});
  if (skus.length === 0) { adicionarLinha(); return; }
  skus.sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));
  for (const sku of skus) {
    const enriq = skusEnriquecidos[sku] || {};
    adicionarLinha(sku, mapa[sku] || "", enriq);
  }
}

function atualizarContador() {
  const mapa = lerTabelaParaMapa();
  const n = Object.keys(mapa).length;
  $contador().textContent = n + " SKU" + (n === 1 ? "" : "s");
}

function aplicarFiltro() {
  const termo = ($filtro().value || "").trim().toLowerCase();
  const linhas = $tbody().querySelectorAll("tr");
  for (const tr of linhas) {
    const sku = tr.querySelector(".input-sku")?.value.toLowerCase() || "";
    const msg = tr.querySelector(".input-msg")?.value.toLowerCase() || "";
    const nome = (tr.dataset.nome || "").toLowerCase();
    const visivel = !termo || sku.includes(termo) || msg.includes(termo) || nome.includes(termo);
    tr.style.display = visivel ? "" : "none";
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ============================================================
// BUSCA NO BLING (modal)
// ============================================================
let resultadosBusca = [];
let selecionados = new Map(); // SKU → { sku, nome, imagem, ean }

async function abrirModalBusca() {
  $("modal-busca").classList.add("visivel");
  $("busca-input").value = "";
  $("busca-resultados").innerHTML = `<div class="busca-vazio">Digite algo acima e clique em <b>Buscar</b>.</div>`;
  $("busca-info-total").textContent = "";
  $("status-busca").textContent = "";
  selecionados.clear();
  atualizarBotaoAdicionar();
  setTimeout(() => $("busca-input").focus(), 100);
}
function fecharModalBusca() { $("modal-busca").classList.remove("visivel"); }

async function executarBusca() {
  const q = $("busca-input").value.trim();
  if (!q) { $("status-busca").textContent = "Digite algo pra buscar"; $("status-busca").className = "aviso"; return; }
  if (q.length < 2) { $("status-busca").textContent = "Digite pelo menos 2 caracteres"; $("status-busca").className = "aviso"; return; }
  $("busca-btn").disabled = true;
  $("busca-btn").textContent = "Buscando...";
  $("status-busca").textContent = "";
  try {
    const data = await api("/fragil/api/buscar?q=" + encodeURIComponent(q) + "&limite=100");
    resultadosBusca = data.resultados || [];
    renderResultadosBusca();
    const cs = data.cacheStatus || {};
    $("busca-info-total").textContent =
      `${data.total} resultado(s) · cache: ${cs.detalhesEmCache}/${cs.skusIndexados}` +
      (cs.eansCarregados ? " (completo)" : " (carregando...)");
  } catch (e) {
    $("status-busca").textContent = "Erro: " + e.message;
    $("status-busca").className = "erro";
  } finally {
    $("busca-btn").disabled = false;
    $("busca-btn").textContent = "Buscar";
  }
}

function renderResultadosBusca() {
  if (resultadosBusca.length === 0) {
    $("busca-resultados").innerHTML = `<div class="busca-vazio">Nenhum produto encontrado.</div>`;
    return;
  }
  // Marca quais SKUs já estão na lista de Frágeis pra avisar
  const ja = new Set(Object.keys(lerTabelaParaMapa()));
  const html = resultadosBusca.map((p, i) => {
    const sku = p.codigo || "";
    const jaTem = ja.has(sku);
    const checked = selecionados.has(sku) ? "checked" : "";
    const imgHtml = p.imagem
      ? `<img src="${escapeHtml(p.imagem)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';" /><span class="sem-img" style="display:none;">📦</span>`
      : `<span class="sem-img">📦</span>`;
    return `
      <label class="busca-item" ${jaTem ? 'style="opacity:0.55;background:#f8f9fa;"' : ""}>
        <input type="checkbox" data-i="${i}" ${checked} ${jaTem ? 'disabled' : ''} />
        ${imgHtml}
        <div class="busca-item-info">
          <div class="sku">${escapeHtml(sku)}${jaTem ? ' <small style="color:#dc3545;font-weight:bold;">(já cadastrado)</small>' : ""}</div>
          <div class="nome">${escapeHtml(p.nome || "(sem nome)")}</div>
          ${p.ean ? `<div class="ean">EAN: ${escapeHtml(p.ean)}</div>` : ""}
        </div>
      </label>
    `;
  }).join("");
  $("busca-resultados").innerHTML = html;
  $("busca-resultados").querySelectorAll('input[type=checkbox]:not([disabled])').forEach(cb => {
    cb.addEventListener("change", () => {
      const idx = parseInt(cb.dataset.i, 10);
      const p = resultadosBusca[idx];
      if (cb.checked) selecionados.set(p.codigo, p);
      else selecionados.delete(p.codigo);
      atualizarBotaoAdicionar();
    });
  });
}

function atualizarBotaoAdicionar() {
  const n = selecionados.size;
  $("busca-adicionar").textContent = `Adicionar selecionados (${n})`;
  $("busca-adicionar").disabled = n === 0;
}

function adicionarSelecionados() {
  let novos = 0;
  for (const [sku, p] of selecionados) {
    skusEnriquecidos[sku] = { nome: p.nome, imagem: p.imagem, ean: p.ean };
    adicionarLinha(sku, "", { nome: p.nome, imagem: p.imagem });
    novos++;
  }
  fecharModalBusca();
  status(`✓ ${novos} SKU(s) adicionado(s) à lista. Não esqueça de clicar em SALVAR TUDO.`, true);
}

// ============================================================
// USUÁRIOS
// ============================================================
async function carregarUsuarios() {
  try {
    const data = await api("/fragil/api/usuarios");
    const lista = data.usuarios || [];
    if (lista.length === 0) {
      $("lista-usuarios-area").innerHTML = `
        <div class="alerta">⚠️ Nenhum usuário cadastrado ainda. Clique em "Novo usuário" pra criar o primeiro. A chave-mestra ficará desativada após criar o primeiro usuário.</div>
      `;
      return;
    }
    const sess = getSession();
    const eh_eu = (u) => sess && sess.usuario && u.usuario.toLowerCase() === sess.usuario.toLowerCase();
    const html = `
      <table class="lista-usuarios">
        <thead><tr><th>Usuário</th><th>Nome</th><th>Perfil</th><th style="text-align:center;">Ações</th></tr></thead>
        <tbody>
          ${lista.map(u => `
            <tr>
              <td><b>${escapeHtml(u.usuario)}</b>${eh_eu(u) ? ' <small style="color:#28a745;">(você)</small>' : ""}</td>
              <td>${escapeHtml(u.nome || "")}</td>
              <td><span class="badge-perfil">${escapeHtml(u.perfil || "admin")}</span></td>
              <td style="text-align:center;">
                <button class="btn-secundario" data-acao="senha" data-user="${escapeHtml(u.usuario)}">Trocar senha</button>
                ${!eh_eu(u) ? `<button class="btn-perigo" data-acao="remover" data-user="${escapeHtml(u.usuario)}">Remover</button>` : ""}
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    $("lista-usuarios-area").innerHTML = html;
    $("lista-usuarios-area").querySelectorAll("button[data-acao]").forEach(btn => {
      btn.addEventListener("click", () => {
        const acao = btn.dataset.acao;
        const user = btn.dataset.user;
        if (acao === "senha") trocarSenhaUsuario(user);
        if (acao === "remover") removerUsuario(user);
      });
    });
  } catch (e) {
    $("lista-usuarios-area").innerHTML = `<span class="erro">Erro: ${e.message}</span>`;
  }
}

function abrirModalNovoUsuario() {
  $("novo-usuario").value = "";
  $("novo-nome").value = "";
  $("novo-senha").value = "";
  $("status-usuario").textContent = "";
  $("modal-usuario").classList.add("visivel");
  setTimeout(() => $("novo-usuario").focus(), 100);
}
function fecharModalNovoUsuario() { $("modal-usuario").classList.remove("visivel"); }

async function criarUsuario() {
  const usuario = $("novo-usuario").value.trim();
  const nome = $("novo-nome").value.trim();
  const senha = $("novo-senha").value;
  if (!usuario || !senha) {
    $("status-usuario").textContent = "Preencha usuário e senha.";
    $("status-usuario").className = "erro";
    return;
  }
  if (senha.length < 6) {
    $("status-usuario").textContent = "Senha deve ter pelo menos 6 caracteres.";
    $("status-usuario").className = "erro";
    return;
  }
  $("usuario-criar").disabled = true;
  try {
    await api("/fragil/api/usuarios", {
      method: "POST",
      body: JSON.stringify({ usuario, senha, nome, perfil: "admin" })
    });
    fecharModalNovoUsuario();
    status(`✓ Usuário "${usuario}" criado`, true);
    carregarUsuarios();
    carregarStatus();
  } catch (e) {
    $("status-usuario").textContent = e.message;
    $("status-usuario").className = "erro";
  } finally {
    $("usuario-criar").disabled = false;
  }
}

async function trocarSenhaUsuario(usuario) {
  const novaSenha = prompt(`Nova senha para "${usuario}" (mín. 6 caracteres):`);
  if (!novaSenha) return;
  if (novaSenha.length < 6) { alert("Senha muito curta"); return; }
  try {
    await api(`/fragil/api/usuarios/${encodeURIComponent(usuario)}/senha`, {
      method: "POST",
      body: JSON.stringify({ novaSenha })
    });
    status(`✓ Senha de "${usuario}" alterada`, true);
  } catch (e) {
    status("Erro: " + e.message, false);
  }
}

async function removerUsuario(usuario) {
  if (!confirm(`Remover usuário "${usuario}"? Essa ação não pode ser desfeita.`)) return;
  try {
    await api(`/fragil/api/usuarios/${encodeURIComponent(usuario)}`, { method: "DELETE" });
    status(`✓ Usuário "${usuario}" removido`, true);
    carregarUsuarios();
    carregarStatus();
  } catch (e) {
    status("Erro: " + e.message, false);
  }
}

// ============================================================
// VOZES
// ============================================================
let vozesDisponiveis = [];

function popularDropdownVozes() {
  if (!("speechSynthesis" in window)) return;
  vozesDisponiveis = window.speechSynthesis.getVoices();
  const $sel = $("nomeVoz");
  if (!$sel) return;
  // Filtra vozes pt e ordena: pt-BR primeiro, depois pt geral
  const ptBr = vozesDisponiveis.filter(v => /pt[-_]br/i.test(v.lang));
  const ptOutras = vozesDisponiveis.filter(v => /^pt/i.test(v.lang) && !/pt[-_]br/i.test(v.lang));
  const valorAtual = $sel.value || "";
  // Mantém apenas a primeira option (a "padrão"), remove as antigas
  while ($sel.options.length > 1) $sel.remove(1);
  for (const v of ptBr) {
    const opt = document.createElement("option");
    opt.value = v.name;
    opt.textContent = `${v.name} (pt-BR)`;
    $sel.appendChild(opt);
  }
  if (ptOutras.length > 0) {
    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "─── Outras vozes em português ───";
    $sel.appendChild(sep);
    for (const v of ptOutras) {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})`;
      $sel.appendChild(opt);
    }
  }
  // Restaura valor selecionado se ainda existir nas options
  $sel.value = valorAtual;
}

if ("speechSynthesis" in window) {
  popularDropdownVozes();
  window.speechSynthesis.onvoiceschanged = popularDropdownVozes;
}

function testarVoz() {
  if (!("speechSynthesis" in window)) {
    alert("Seu navegador não suporta síntese de voz.");
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(
      $("msgPadrao").value || "Atenção. Produto frágil. Embalar com plástico bolha e reforçar a caixa."
    );
    u.lang = "pt-BR";
    u.rate = parseFloat($("velocidade").value) || 1.2;
    u.pitch = 1; u.volume = 1;
    const nomeEscolhido = $("nomeVoz").value;
    if (nomeEscolhido) {
      const voz = vozesDisponiveis.find(v => v.name === nomeEscolhido);
      if (voz) u.voice = voz;
    } else {
      const voz = vozesDisponiveis.find(v => /pt[-_]br/i.test(v.lang)) || vozesDisponiveis.find(v => /^pt/i.test(v.lang));
      if (voz) u.voice = voz;
    }
    window.speechSynthesis.speak(u);
  } catch (e) {
    console.warn("Erro ao testar voz:", e);
  }
}

// ============================================================
// IMPORTAR / EXPORTAR PLANILHA
// ============================================================
let pendentesNovos = [];        // [{sku, msg}] — SKUs que não existiam
let pendentesAtualizar = [];    // [{sku, msgNova, msgAtual}] — SKUs já cadastrados
let modoDuplicados = "ignorar"; // "ignorar" | "atualizar"

function abrirModalImport() {
  $("modal-import").classList.add("visivel");
  $("preview-import").style.display = "none";
  $("preview-import").innerHTML = "";
  $("import-confirmar").disabled = true;
  $("import-info").textContent = "";
  $("upload-arquivo").value = "";
  $("bulk-textarea").value = "";
  pendentesNovos = [];
  pendentesAtualizar = [];
  modoDuplicados = "ignorar";
}
function fecharModalImport() {
  $("modal-import").classList.remove("visivel");
}

function alternarTabImport(nome) {
  document.querySelectorAll(".modal-import .tab-btn").forEach(b => {
    b.classList.toggle("ativo", b.dataset.tab === nome);
  });
  document.querySelectorAll(".modal-import .tab-conteudo").forEach(c => {
    c.classList.toggle("ativo", c.dataset.tab === nome);
  });
}

// Detecta se uma linha é cabeçalho
function ehCabecalho(linha) {
  if (!linha || linha.length === 0) return false;
  const txt = (linha[0] || "").toString().trim().toLowerCase();
  return /^(sku|c[oó]digo|cod\.?|item|produto)$/i.test(txt);
}

function processarLinhas(linhas) {
  if (linhas.length > 0 && ehCabecalho(linhas[0])) linhas = linhas.slice(1);

  const novos = [];
  const atualizar = [];
  const dupsPlanilha = [];
  const mapaAtual = lerTabelaParaMapa();
  const skusVistos = new Set();

  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha || linha.length === 0) continue;
    const sku = (linha[0] || "").toString().trim();
    const msg = ((linha[1] || "") + "").trim();
    if (!sku) continue;

    if (skusVistos.has(sku.toLowerCase())) {
      dupsPlanilha.push({ linha: i + 1, sku });
      continue;
    }
    skusVistos.add(sku.toLowerCase());

    if (Object.prototype.hasOwnProperty.call(mapaAtual, sku)) {
      atualizar.push({ sku, msgNova: msg, msgAtual: mapaAtual[sku] || "" });
    } else {
      novos.push({ sku, msg });
    }
  }
  return { novos, atualizar, dupsPlanilha };
}

function mostrarPreview(novos, atualizar, dupsPlanilha) {
  const $p = $("preview-import");
  $p.style.display = "block";

  // Conta quantos atualizações realmente mudam algo
  const atualizarComMudanca = atualizar.filter(a => a.msgNova !== a.msgAtual);
  const atualizarSemMudanca = atualizar.length - atualizarComMudanca.length;

  let html = "";

  if (novos.length > 0) {
    html += `<div><b>✅ ${novos.length} SKU(s) novo(s) — serão adicionados:</b></div>`;
    const amostra = novos.slice(0, 20);
    for (const v of amostra) {
      html += `<div class="ok-line">• ${escapeHtml(v.sku)}${v.msg ? " — " + escapeHtml(v.msg) : ""}</div>`;
    }
    if (novos.length > 20) html += `<div class="ok-line">... e mais ${novos.length - 20}</div>`;
  }

  // SE TEM SKUs JÁ CADASTRADOS, MOSTRA OPÇÃO DE ESCOLHA
  if (atualizar.length > 0) {
    html += `<div style="margin-top:14px; padding:12px; background:#fff3cd; border-radius:6px;">`;
    html += `<b>⚠️ ${atualizar.length} SKU(s) já cadastrado(s) na lista`;
    if (atualizarComMudanca.length > 0) {
      html += ` — ${atualizarComMudanca.length} com mensagem diferente da planilha</b>`;
    } else {
      html += ` (todos com mensagens iguais às da planilha)</b>`;
    }
    html += `<div style="margin-top:10px;">O que fazer com eles?</div>`;
    html += `<div style="margin-top:6px;">`;
    html += `<label style="display:block; cursor:pointer; padding:6px;"><input type="radio" name="modo-dup" value="ignorar" ${modoDuplicados === "ignorar" ? "checked" : ""} /> <b>Ignorar</b> — manter mensagens atuais (recomendado pra cadastros novos)</label>`;
    html += `<label style="display:block; cursor:pointer; padding:6px;"><input type="radio" name="modo-dup" value="atualizar" ${modoDuplicados === "atualizar" ? "checked" : ""} /> <b>Atualizar</b> — sobrescrever pelas mensagens da planilha (use pra editar em massa)</label>`;
    html += `</div>`;

    // Mostra preview do que vai mudar quando "atualizar" estiver marcado
    if (modoDuplicados === "atualizar" && atualizarComMudanca.length > 0) {
      html += `<div style="margin-top:10px;"><b>Mudanças que vão acontecer:</b></div>`;
      const amostra = atualizarComMudanca.slice(0, 10);
      for (const a of amostra) {
        const antes = a.msgAtual || "<i>(em branco)</i>";
        const depois = a.msgNova || "<i>(em branco)</i>";
        html += `<div class="aviso-line" style="margin-top:4px;">• <b>${escapeHtml(a.sku)}</b>:<br>&nbsp;&nbsp;${antes} <b>→</b> ${depois}</div>`;
      }
      if (atualizarComMudanca.length > 10) {
        html += `<div class="aviso-line">... e mais ${atualizarComMudanca.length - 10}</div>`;
      }
    }

    if (atualizarSemMudanca > 0 && modoDuplicados === "atualizar") {
      html += `<div style="margin-top:8px; font-size:12px; color:#6c757d;">(${atualizarSemMudanca} já têm a mesma mensagem — sem alterações)</div>`;
    }

    html += `</div>`;
  }

  if (dupsPlanilha.length > 0) {
    html += `<div style="margin-top:10px;" class="aviso-line">⚠️ ${dupsPlanilha.length} duplicado(s) na própria planilha (ignorados): ${dupsPlanilha.slice(0, 8).map(e => escapeHtml(e.sku)).join(", ")}${dupsPlanilha.length > 8 ? "..." : ""}</div>`;
  }

  if (novos.length === 0 && atualizar.length === 0) {
    html = `<div class="erro-line">Nenhum SKU encontrado no arquivo. Verifique o formato.</div>`;
  }

  $p.innerHTML = html;

  // Listener nos rádios — re-renderiza pra atualizar info e preview
  $p.querySelectorAll('input[name="modo-dup"]').forEach(r => {
    r.addEventListener("change", () => {
      modoDuplicados = r.value;
      mostrarPreview(novos, atualizar, dupsPlanilha);
      atualizarBotaoConfirmar(novos, atualizar);
    });
  });

  pendentesNovos = novos;
  pendentesAtualizar = atualizar;
  atualizarBotaoConfirmar(novos, atualizar);
}

function atualizarBotaoConfirmar(novos, atualizar) {
  const atualizarComMudanca = atualizar.filter(a => a.msgNova !== a.msgAtual);
  let totalEfetivo = novos.length;
  if (modoDuplicados === "atualizar") totalEfetivo += atualizarComMudanca.length;

  $("import-confirmar").disabled = totalEfetivo === 0;

  let texto = `${novos.length} novo(s)`;
  if (modoDuplicados === "atualizar" && atualizarComMudanca.length > 0) {
    texto += ` · ${atualizarComMudanca.length} atualizar`;
  } else if (atualizar.length > 0) {
    texto += ` · ${atualizar.length} ignorar`;
  }
  $("import-info").textContent = texto;
}

function processarTextoBulk() {
  const txt = $("bulk-textarea").value.trim();
  if (!txt) { alert("Cole algum texto antes de processar."); return; }
  const linhasRaw = txt.split(/\r?\n/).filter(l => l.trim());
  const linhas = linhasRaw.map(l => {
    if (l.includes("\t")) return l.split("\t");
    if (l.includes("|")) return l.split("|");
    if (l.includes(";")) return l.split(";");
    return [l];
  });
  const { novos, atualizar, dupsPlanilha } = processarLinhas(linhas);
  modoDuplicados = "ignorar";
  mostrarPreview(novos, atualizar, dupsPlanilha);
}

function processarArquivoExcel(file) {
  if (!window.XLSX) { alert("Biblioteca XLSX ainda carregando, aguarde 2s e tente de novo."); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array" });
      const aba = wb.SheetNames[0];
      const ws = wb.Sheets[aba];
      const linhas = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
      const { novos, atualizar, dupsPlanilha } = processarLinhas(linhas);
      modoDuplicados = "ignorar";
      mostrarPreview(novos, atualizar, dupsPlanilha);
    } catch (err) {
      alert("Erro lendo arquivo: " + err.message);
    }
  };
  reader.onerror = () => alert("Erro lendo arquivo.");
  reader.readAsArrayBuffer(file);
}

function confirmarImport() {
  let nNovos = 0;
  let nAtualizados = 0;

  // 1. Adiciona SKUs novos
  for (const item of pendentesNovos) {
    adicionarLinha(item.sku, item.msg, {});
    nNovos++;
  }

  // 2. Atualiza SKUs existentes (se modo "atualizar")
  if (modoDuplicados === "atualizar") {
    for (const item of pendentesAtualizar) {
      if (item.msgNova === item.msgAtual) continue; // pula sem mudança
      const linhas = $tbody().querySelectorAll("tr");
      for (const tr of linhas) {
        const skuLinha = tr.querySelector(".input-sku")?.value.trim() || "";
        if (skuLinha === item.sku) {
          const $msg = tr.querySelector(".input-msg");
          if ($msg) {
            $msg.value = item.msgNova;
            nAtualizados++;
          }
          break;
        }
      }
    }
  }

  fecharModalImport();
  let msg = "✓ ";
  if (nNovos > 0) msg += `${nNovos} novo(s)`;
  if (nNovos > 0 && nAtualizados > 0) msg += " e ";
  if (nAtualizados > 0) msg += `${nAtualizados} atualizado(s)`;
  msg += ". Não esqueça de SALVAR TUDO.";
  status(msg, true);
}

function exportarExcel() {
  if (!window.XLSX) { alert("Biblioteca XLSX ainda carregando, aguarde."); return; }
  const linhas = $tbody().querySelectorAll("tr");
  const dados = [["SKU", "Mensagem"]];
  for (const tr of linhas) {
    const sku = tr.querySelector(".input-sku")?.value.trim() || "";
    const msg = tr.querySelector(".input-msg")?.value.trim() || "";
    if (!sku) continue;
    dados.push([sku, msg]);
  }
  if (dados.length === 1) { alert("Lista vazia, nada pra exportar."); return; }
  const ws = XLSX.utils.aoa_to_sheet(dados);
  ws["!cols"] = [{ wch: 22 }, { wch: 60 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "SKUs Frágeis");
  const data = new Date();
  const nome = `skus-frageis-${data.toISOString().slice(0, 10).replace(/-/g, "")}.xlsx`;
  XLSX.writeFile(wb, nome);
  status(`✓ ${dados.length - 1} SKU(s) exportados para ${nome}`, true);
}

// ============================================================
// SALVAR / CARREGAR
// ============================================================
function status(txt, ok) {
  $("status").textContent = txt;
  $("status").className = ok ? "ok" : "erro";
  if (txt) setTimeout(() => { $("status").textContent = ""; $("status").className = ""; }, 4000);
}

async function carregar() {
  try {
    const r = await fetch("/fragil/api/skus");
    const j = await r.json();
    preencherTabelaDoMapa(j.skus || {});
    $("tempo").value = j.config?.tempoMinimoSegundos ?? 2;
    $("msgPadrao").value = j.config?.mensagemPadrao || "";
    $("repetir").checked = !!j.config?.repetirVoz;
    const vel = j.config?.velocidadeVoz ?? 1.2;
    $("velocidade").value = vel;
    $("velocidade-valor").textContent = vel.toFixed(1) + "x";
    if ($("nomeVoz")) $("nomeVoz").value = j.config?.nomeVoz || "";
    if (j.atualizadoEm) {
      const por = j.atualizadoPor ? ` por ${j.atualizadoPor}` : "";
      $("atualizadoEm").textContent = "Última atualização: " + new Date(j.atualizadoEm).toLocaleString("pt-BR") + por;
    } else {
      $("atualizadoEm").textContent = "Sem dados ainda — preencha e salve.";
    }
  } catch (e) {
    status("Erro ao carregar: " + e.message, false);
  }
}

async function salvar() {
  $("btn-salvar").disabled = true;
  try {
    const linhas = $tbody().querySelectorAll("tr");
    const vistos = new Set();
    const duplicados = [];
    for (const tr of linhas) {
      const sku = tr.querySelector(".input-sku")?.value.trim() || "";
      if (!sku) continue;
      if (vistos.has(sku)) duplicados.push(sku);
      vistos.add(sku);
    }
    if (duplicados.length > 0) {
      const ok = confirm("⚠️ SKUs duplicados: " + duplicados.join(", ") + "\n\nVai manter apenas a última de cada. Continuar?");
      if (!ok) { $("btn-salvar").disabled = false; return; }
    }
    const corpo = {
      config: {
        tempoMinimoSegundos: parseInt($("tempo").value, 10) || 0,
        mensagemPadrao: $("msgPadrao").value.trim(),
        repetirVoz: !!$("repetir").checked,
        velocidadeVoz: parseFloat($("velocidade").value) || 1.2,
        nomeVoz: $("nomeVoz") ? ($("nomeVoz").value || "") : ""
      },
      skus: lerTabelaParaMapa()
    };
    const j = await api("/fragil/api/skus", { method: "POST", body: JSON.stringify(corpo) });
    if (j.atualizadoEm) {
      const por = j.atualizadoPor ? ` por ${j.atualizadoPor}` : "";
      $("atualizadoEm").textContent = "Última atualização: " + new Date(j.atualizadoEm).toLocaleString("pt-BR") + por;
    }
    status("✓ Salvo! " + Object.keys(j.skus).length + " SKUs ativos", true);
  } catch (e) {
    status("Erro ao salvar: " + e.message, false);
  } finally {
    $("btn-salvar").disabled = false;
  }
}

// ============================================================
// EVENT LISTENERS
// ============================================================
$("btn-login").addEventListener("click", fazerLogin);
$("login-senha").addEventListener("keydown", (e) => { if (e.key === "Enter") fazerLogin(); });
$("login-usuario").addEventListener("keydown", (e) => { if (e.key === "Enter") $("login-senha").focus(); });
$("btn-logout").addEventListener("click", logout);

$("btn-salvar").addEventListener("click", salvar);
$("btn-recarregar").addEventListener("click", () => { carregar(); carregarStatus(); });
$("btn-add-manual").addEventListener("click", () => adicionarLinha("", "", {}, true));
$("filtro").addEventListener("input", aplicarFiltro);

// Atualiza o label do slider de velocidade em tempo real + permite testar
$("velocidade").addEventListener("input", () => {
  const v = parseFloat($("velocidade").value);
  $("velocidade-valor").textContent = v.toFixed(1) + "x";
});
$("velocidade").addEventListener("change", testarVoz);
$("nomeVoz")?.addEventListener("change", testarVoz);
$("btn-testar-voz")?.addEventListener("click", testarVoz);

$("btn-abrir-busca").addEventListener("click", abrirModalBusca);
$("busca-fechar").addEventListener("click", fecharModalBusca);
$("busca-cancelar").addEventListener("click", fecharModalBusca);
$("busca-btn").addEventListener("click", executarBusca);
$("busca-input").addEventListener("keydown", (e) => { if (e.key === "Enter") executarBusca(); });
$("busca-adicionar").addEventListener("click", adicionarSelecionados);

$("btn-novo-usuario").addEventListener("click", abrirModalNovoUsuario);
$("usuario-fechar").addEventListener("click", fecharModalNovoUsuario);
$("usuario-cancelar").addEventListener("click", fecharModalNovoUsuario);
$("usuario-criar").addEventListener("click", criarUsuario);
$("novo-senha").addEventListener("keydown", (e) => { if (e.key === "Enter") criarUsuario(); });

// IMPORT/EXPORT
$("btn-importar").addEventListener("click", abrirModalImport);
$("btn-exportar").addEventListener("click", exportarExcel);
$("import-fechar").addEventListener("click", fecharModalImport);
$("import-cancelar").addEventListener("click", fecharModalImport);
$("import-confirmar").addEventListener("click", confirmarImport);
$("bulk-processar").addEventListener("click", processarTextoBulk);

document.querySelectorAll(".modal-import .tab-btn").forEach(b => {
  b.addEventListener("click", () => alternarTabImport(b.dataset.tab));
});

// Upload de arquivo (clique e drag-n-drop)
$("upload-arquivo").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f) processarArquivoExcel(f);
});
const $up = $("upload-area");
$up.addEventListener("dragover", (e) => { e.preventDefault(); $up.classList.add("dragover"); });
$up.addEventListener("dragleave", () => $up.classList.remove("dragover"));
$up.addEventListener("drop", (e) => {
  e.preventDefault();
  $up.classList.remove("dragover");
  const f = e.dataTransfer.files[0];
  if (f) processarArquivoExcel(f);
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!$("conteudo").classList.contains("escondido")) salvar();
  }
  if (e.key === "Escape") {
    if ($("modal-busca").classList.contains("visivel")) fecharModalBusca();
    if ($("modal-usuario").classList.contains("visivel")) fecharModalNovoUsuario();
    if ($("modal-import").classList.contains("visivel")) fecharModalImport();
  }
});

// Cards colapsáveis (Configurações, Usuários)
document.querySelectorAll(".card-collapse h2").forEach(h => {
  h.addEventListener("click", (e) => {
    // Não colapsa se clicou em algo interativo dentro do header
    if (e.target.tagName === "INPUT" || e.target.tagName === "BUTTON") return;
    h.parentElement.classList.toggle("collapsed");
  });
});

// ============================================================
// INIT
// ============================================================
inicializar();
