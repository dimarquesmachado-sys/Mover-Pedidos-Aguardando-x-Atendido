'use strict';
/* Toolbox — a tela da CENTRAL (2.1.14): empresa, chaves e "atualizar e validar tudo". A lógica mora em tb-acoes.js
   (testada sem navegador); aqui só a tela. */
const T = self.tbAcoes;
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let EMP = '';
const ESTADO = {};   /* id → { estado, msg, site } */

function desenhar() {
  const itens = EMP ? T.itensDa(EMP) : [];
  $('cx_mm').style.display = itens.some((i) => i.id === 'mm') ? '' : 'none';
  $('tudo').disabled = !EMP;
  $('itens').innerHTML = itens.length ? itens.map((i) => {
    const e = ESTADO[i.id] || { estado: '', msg: 'ainda não conferido nesta tela' };
    return '<div class="item ' + esc(e.estado) + '" data-id="' + i.id + '"><div class="bola"></div>' +
      '<div><div class="nome">' + esc(i.nome) + '</div><div class="oque">' + esc(i.oque) + '</div><div class="msg">' + esc(e.msg) + '</div></div>' +
      '<div class="acoes">' + (e.site ? '<button class="sec abrir" data-url="' + esc(e.site) + '">abrir o site</button>' : '') +
      '<button class="sec so" data-id="' + i.id + '">só este</button></div></div>';
  }).join('') : '<div class="dim">Escolha a empresa desta instalação pra ver os módulos.</div>';
  for (const b of document.querySelectorAll('button.abrir')) b.onclick = () => chrome.tabs.create({ url: b.dataset.url });
  for (const b of document.querySelectorAll('button.so')) b.onclick = () => rodarUm(b.dataset.id);
}

async function salvarChaves() {
  await T.gravarChaves({ admin: $('k_admin').value, toolbox: $('k_toolbox').value, mm: $('k_mm').value, respostas: $('k_respostas').value }, EMP);
  $('salvo').textContent = 'chaves salvas ✔'; setTimeout(() => { $('salvo').textContent = ''; }, 2500);
}

async function rodarUm(id) {
  if (!EMP) return;
  await salvarChaves();
  ESTADO[id] = { estado: 'rodando', msg: 'conferindo…' }; desenhar();
  let r; try { r = await T.ACOES[id](EMP); } catch (e) { r = { estado: 'erro', msg: String((e && e.message) || e) }; }
  ESTADO[id] = r; desenhar();
}

async function rodarTudo() {
  if (!EMP) return;
  /* uma confirmação só, no começo: a sessão que vai pro servidor é a dos sites logados NESTE navegador */
  if (!confirm('Os sites abertos neste navegador (Shopee, Bling, Madeira…) estão logados nas contas da ' + T.NOME[EMP] + '?')) return;
  await salvarChaves();
  $('tudo').disabled = true; $('resumo').textContent = 'conferindo os módulos, um por vez…';
  const saida = await T.atualizarTudo(EMP, (id, r) => { ESTADO[id] = r; desenhar(); });
  const ok = saida.filter((x) => x.estado === 'ok' || x.estado === 'info').length;
  const pend = saida.filter((x) => x.estado !== 'ok' && x.estado !== 'info');
  $('resumo').innerHTML = pend.length
    ? '<span style="color:#fcd34d">' + ok + ' de ' + saida.length + ' certos — falta resolver ' + pend.length + ' (veja acima o que cada um pede) e clicar de novo.</span>'
    : '<span style="color:#86efac">✅ tudo certo: ' + saida.length + ' módulos conferidos.</span>';
  $('tudo').disabled = false;
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
  if (EMP && nova !== EMP && !confirm('Trocar a empresa desta instalação? Os módulos passam a agir pela nova empresa (as chaves continuam guardadas).')) { $('emp').value = EMP; return; }
  EMP = nova;
  if (EMP) await chrome.storage.local.set({ tb_empresa: EMP }); else await chrome.storage.local.remove('tb_empresa');
  for (const k of Object.keys(ESTADO)) delete ESTADO[k];
  $('resumo').textContent = '';
  desenhar();
});
$('salvar').addEventListener('click', salvarChaves);
$('tudo').addEventListener('click', rodarTudo);
iniciar();
