'use strict';
/* Toolbox — a tela da CENTRAL (2.1.14): empresa, chaves e "atualizar e validar tudo". A lógica mora em tb-acoes.js
   (testada sem navegador); aqui só a tela. */
const T = self.tbAcoes;
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let EMP = '';
const ESTADO = {};   /* id → { estado, msg, site } */
let RODANDO = false;   /* Codex #845: enquanto roda (tudo ou um), NADA dispara outra rodada — e o redesenho não reabilita os botões */
/* Codex #845 (2): um resultado pode chegar DEPOIS (o Madeira passa dos 90 s e segue sendo acompanhado). Ele só vale pra
   empresa e pra rodada DAQUELE módulo que o pediu: trocar de empresa, ou rodar o mesmo módulo de novo, descarta o velho
   — senão o resultado da GOOD pintava de verde a linha da Girassol. */
const VEZ = {};   /* id → nº da última rodada daquele módulo */
/* Codex #845 (3): enquanto uma rodada AINDA ANDA lá no site (o Madeira depois do aviso), a EMPRESA NÃO PODE MUDAR — o
   fundo da extensão lê a empresa só na hora de mandar os lotes pro servidor, e trocar no meio mandaria os lotes da GOOD
   pro checkout da Girassol. O módulo fica marcado até o fim de verdade chegar (resultado ou limite). */
const ANDANDO = {};   /* id → true enquanto o fim daquela rodada ainda vai chegar */
const temAndando = () => Object.keys(ANDANDO).some((k) => ANDANDO[k]);
const marcar = (id, r) => { ANDANDO[id] = !!(r && r.andando); };
const novaVez = (id) => { VEZ[id] = (VEZ[id] || 0) + 1; return VEZ[id]; };
const ehOk = (e) => e === 'ok' || e === 'info';
const contaCerta = () => confirm('Os sites abertos neste navegador (Shopee, Bling, Madeira…) estão logados nas contas da ' + T.NOME[EMP] + '?');

function desenhar() {
  const itens = EMP ? T.itensDa(EMP) : [];
  $('cx_mm').style.display = itens.some((i) => i.id === 'mm') ? '' : 'none';
  $('tudo').disabled = !EMP || RODANDO || temAndando(); $('emp').disabled = RODANDO || temAndando(); $('salvar').disabled = RODANDO;
  $('itens').innerHTML = itens.length ? itens.map((i) => {
    const e = ESTADO[i.id] || { estado: '', msg: 'ainda não conferido nesta tela' };
    return '<div class="item ' + esc(e.estado) + '" data-id="' + i.id + '"><div class="bola"></div>' +
      '<div><div class="nome">' + esc(i.nome) + '</div><div class="oque">' + esc(i.oque) + '</div><div class="msg">' + esc(e.msg) + '</div></div>' +
      '<div class="acoes">' + (e.site ? '<button class="sec abrir" data-url="' + esc(e.site) + '">abrir o site</button>' : '') +
      '<button class="sec so" data-id="' + i.id + '"' + ((RODANDO || ANDANDO[i.id]) ? ' disabled' : '') + '>só este</button></div></div>';
  }).join('') : '<div class="dim">Escolha a empresa desta instalação pra ver os módulos.</div>';
  for (const b of document.querySelectorAll('button.abrir')) b.onclick = () => chrome.tabs.create({ url: b.dataset.url });
  for (const b of document.querySelectorAll('button.so')) b.onclick = () => rodarUm(b.dataset.id);
}

async function salvarChaves() {
  await T.gravarChaves({ admin: $('k_admin').value, toolbox: $('k_toolbox').value, mm: $('k_mm').value, respostas: $('k_respostas').value }, EMP);
  $('salvo').textContent = 'chaves salvas ✔'; setTimeout(() => { $('salvo').textContent = ''; }, 2500);
}

function resumir() {
  const itens = T.itensDa(EMP).map((i) => ESTADO[i.id]).filter(Boolean);
  if (!itens.length) { $('resumo').textContent = ''; return; }
  const pend = itens.filter((e) => !ehOk(e.estado));
  $('resumo').innerHTML = pend.length
    ? '<span style="color:#fcd34d">' + (itens.length - pend.length) + ' de ' + itens.length + ' certos — falta resolver ' + pend.length + ' (veja acima o que cada um pede) e clicar de novo.</span>'
    : '<span style="color:#86efac">✅ tudo certo: ' + itens.length + ' módulos conferidos.</span>';
}

async function rodarUm(id) {
  if (!EMP || RODANDO || ANDANDO[id]) return;
  const item = T.itensDa(EMP).find((i) => i.id === id); if (!item) return;
  /* Codex #845: quem manda a SESSÃO do navegador (Shopee, Bling, Madeira) pede a confirmação da conta também no "só este"
     — o servidor confere se a sessão está viva, não DE QUEM ela é */
  if (item.sessao && !contaCerta()) return;
  RODANDO = true;
  try {
    await salvarChaves();
    ESTADO[id] = { estado: 'rodando', msg: 'conferindo…' }; desenhar();
    const emp0 = EMP, vez = novaVez(id);
    let r; try { r = await T.ACOES[id](emp0, { depois: (r2) => { if (VEZ[id] === vez) marcar(id, r2); if (EMP !== emp0 || VEZ[id] !== vez) { desenhar(); return; } ESTADO[id] = r2; desenhar(); resumir(); } }); } catch (e) { r = { estado: 'erro', msg: String((e && e.message) || e) }; }
    if (EMP === emp0 && VEZ[id] === vez) { ESTADO[id] = (r && r.estado) ? r : { estado: 'erro', msg: 'sem resposta' }; marcar(id, ESTADO[id]); }
  } finally { RODANDO = false; desenhar(); resumir(); }
}

async function rodarTudo() {
  if (!EMP || RODANDO || temAndando()) return;
  /* uma confirmação só, no começo: a sessão que vai pro servidor é a dos sites logados NESTE navegador */
  if (!contaCerta()) return;
  RODANDO = true; desenhar();
  try {
    await salvarChaves();
    $('resumo').textContent = 'conferindo os módulos, um por vez…';
    const emp0 = EMP, vezes = {};
    for (const i of T.itensDa(emp0)) vezes[i.id] = novaVez(i.id);
    await T.atualizarTudo(emp0, (id, r) => { if (VEZ[id] === vezes[id] && r.estado !== 'rodando') marcar(id, r); if (EMP !== emp0 || VEZ[id] !== vezes[id]) { desenhar(); return; } ESTADO[id] = r; desenhar(); if (!RODANDO) resumir(); });
  } finally { RODANDO = false; desenhar(); resumir(); }
}

async function iniciar() {
  try { $('versao').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) { /* fora da extensão */ }
  const v = await chrome.storage.local.get(['tb_empresa']);
  EMP = v.tb_empresa || ''; $('emp').value = EMP;
  const c = await T.lerChaves();
  $('k_admin').value = c.admin; $('k_toolbox').value = c.toolbox; $('k_mm').value = c.mm; $('k_respostas').value = c.respostas;
  desenhar();
}

$('emp').addEventListener('change', async () => {
  const nova = $('emp').value;
  /* com algo rodando (ou uma rodada ainda andando lá no site) a empresa não muda — ver ANDANDO */
  if (RODANDO || temAndando()) { $('emp').value = EMP; $('resumo').textContent = 'espere a sincronização em andamento terminar pra trocar de empresa'; return; }
  if (EMP && nova !== EMP && !confirm('Trocar a empresa desta instalação? Os módulos passam a agir pela nova empresa (as chaves continuam guardadas).')) { $('emp').value = EMP; return; }
  EMP = nova;
  if (EMP) await chrome.storage.local.set({ tb_empresa: EMP }); else await chrome.storage.local.remove('tb_empresa');
  for (const k of Object.keys(ESTADO)) delete ESTADO[k];
  for (const k of Object.keys(VEZ)) VEZ[k]++;   /* resultado atrasado da empresa anterior não entra na tela da nova */
  $('resumo').textContent = '';
  desenhar();
});
/* Codex #845 (4): outra tela (popup, outra aba da Central) pode trocar a empresa — esta tela acompanha e descarta o estado velho */
try {
  chrome.storage.onChanged.addListener((mud, area) => {
    if (area !== 'local' || !mud.tb_empresa) return;
    const nova = mud.tb_empresa.newValue || '';
    if (nova === EMP) return;
    EMP = nova; $('emp').value = EMP;
    for (const k of Object.keys(ESTADO)) delete ESTADO[k];
    for (const k of Object.keys(VEZ)) VEZ[k]++;
    for (const k of Object.keys(ANDANDO)) delete ANDANDO[k];
    $('resumo').textContent = 'a empresa foi trocada em outra tela — os módulos agora são os desta empresa; confira de novo';
    desenhar();
  });
} catch (e) { /* fora da extensão */ }
$('salvar').addEventListener('click', salvarChaves);
$('tudo').addEventListener('click', rodarTudo);
iniciar();
