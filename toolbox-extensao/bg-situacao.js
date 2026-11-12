/* Toolbox — fundo do "Consultar situação" (2.1.17): decide QUANDO roda (uma rodada por empresa a cada 10 min, uma aba por
   vez), busca no servidor as notas paradas desta empresa, guarda o resultado pra Central e devolve o resultado ao
   servidor (que avisa no checkout do admin o que não destravou). A consulta em si é feita pela página do Bling
   (ct-situacao.js), na sessão do dono. */
'use strict';
const SIT_HOST = 'https://mover-pedidos-aguardando-x-atendido.onrender.com';
const SIT_PREFIXO = { girassol: '', good: '/good', amb: '/amb' };   /* o prefixo do módulo fiscal de cada empresa */
const SIT_INTERVALO_MS = 10 * 60000;
const SIT_VEZ_MS = 3 * 60000;      /* uma aba segura a vez por até 3 min */
const SIT_MAX = 10;
let _sitFila = Promise.resolve();
function sitEmFila(fn) { _sitFila = _sitFila.then(fn, fn); return _sitFila; }
async function sitStatus(s) { await chrome.storage.local.set({ sit_status: Object.assign({ quando: Date.now() }, s) }); }

async function situacaoPedir(forcar) {
  const c = await chrome.storage.local.get(['tb_empresa', 'sceKey', 'tbBlingKey', 'sit_ultima', 'sit_vez']);
  const emp = c.tb_empresa, key = c.sceKey || c.tbBlingKey || '';
  if (!emp || !(emp in SIT_PREFIXO)) return { rodar: false, motivo: 'sem_empresa' };
  if (!key) { await sitStatus({ ok: false, empresa: emp, via: 'sem_chave', msg: 'falta a ADMIN_KEY (preencha na Central)' }); return { rodar: false, motivo: 'sem_chave' }; }
  const agora = Date.now();
  if (!forcar && c.sit_ultima && c.sit_ultima.empresa === emp && agora - c.sit_ultima.quando < SIT_INTERVALO_MS) return { rodar: false, motivo: 'cedo' };
  if (c.sit_vez && agora - c.sit_vez < SIT_VEZ_MS) return { rodar: false, motivo: 'outra_aba' };
  await chrome.storage.local.set({ sit_vez: agora });
  let r = null, d = null;
  try { r = await fetch(SIT_HOST + SIT_PREFIXO[emp] + '/robo/nfs-consultar-situacao?k=' + encodeURIComponent(key)); d = await r.json(); } catch (e) { d = null; }
  if (!r || !r.ok || !d || !Array.isArray(d.nfs)) {
    await chrome.storage.local.remove('sit_vez');
    const recusou = r && (r.status === 401 || r.status === 403 || r.status === 404);
    await sitStatus({ ok: false, empresa: emp, via: recusou ? 'chave_recusada' : 'servidor', msg: recusou ? 'o servidor recusou a ADMIN_KEY (HTTP ' + r.status + ')' : 'não consegui a lista do servidor' + (r ? ' (HTTP ' + r.status + (d && d.error ? ': ' + String(d.error).slice(0, 120) : '') + ')' : '') });
    return { rodar: false, motivo: 'servidor' };   /* não marca a rodada: tenta de novo na próxima */
  }
  await chrome.storage.local.set({ sit_ultima: { empresa: emp, quando: agora, total: d.nfs.length } });
  if (!d.nfs.length) {
    await chrome.storage.local.remove('sit_vez');
    await sitStatus({ ok: true, empresa: emp, via: 'vazio', msg: 'nenhuma nota em "Consultar situação"' });
    return { rodar: false, motivo: 'vazio' };
  }
  return { rodar: true, empresa: emp, nfs: d.nfs.slice(0, SIT_MAX).map((n) => ({ id: n.id, numero: n.numero })) };
}

async function situacaoResultado(msg) {
  const c = await chrome.storage.local.get(['tb_empresa', 'sceKey', 'tbBlingKey']);
  const emp = c.tb_empresa, key = c.sceKey || c.tbBlingKey || '';
  await chrome.storage.local.remove('sit_vez');
  const res = Array.isArray(msg.resultados) ? msg.resultados : [];
  if (msg.empresa !== emp) { await sitStatus({ ok: false, empresa: emp, via: 'empresa_mudou', msg: 'a empresa desta instalação mudou no meio da rodada — resultado descartado' }); return; }
  const n = (v) => res.filter((x) => x.via === v).length;
  const validadas = n('validada'), naoLog = n('nao_logado'), outras = res.length - validadas - naoLog;
  const pend = res.filter((x) => x.via !== 'validada' && x.via !== 'nao_logado').map((x) => 'NF ' + (x.numero || x.id) + ': ' + (x.via === 'nao_autorizada' ? 'a SEFAZ respondeu ' + x.cStat + ' — ' + x.xMotivo : (x.erro || x.via))).slice(0, 5).join('; ');
  await sitStatus({ ok: !naoLog && !outras, empresa: emp, via: naoLog ? 'nao_logado' : (outras ? 'pendente' : 'validadas'), validadas, pendentes: outras,
    msg: naoLog ? 'o Bling não está logado neste navegador — entre na conta da empresa' : (validadas + ' nota(s) destravada(s)' + (outras ? '; ' + outras + ' não destravou: ' + pend : '')) });
  /* devolve ao servidor (ele avisa no checkout do admin o que não destravou). Rota nova no servidor: se ainda não existir,
     o resultado fica só aqui — a lista do servidor continua sendo a verdade (a nota que destravou some dela sozinha). */
  if (!key || !res.length) return;
  try {
    await fetch(SIT_HOST + SIT_PREFIXO[emp] + '/robo/nfs-consultar-situacao/resultado?k=' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origem: 'toolbox', versao: (chrome.runtime.getManifest() || {}).version, resultados: res }) });
  } catch (e) { /* servidor fora: a próxima rodada reporta de novo */ }
}

/* a Central pede uma rodada AGORA: libera o intervalo e chama as abas do Bling abertas */
async function situacaoAgora() {
  await chrome.storage.local.remove(['sit_ultima', 'sit_vez']);
  let abas = [];
  try { abas = await chrome.tabs.query({ url: ['https://www.bling.com.br/*'] }); } catch (e) { abas = []; }
  let chamou = 0;
  for (const a of abas) { try { const r = await chrome.tabs.sendMessage(a.id, { tipo: 'SITUACAO_RODAR' }); if (r && r.ok) { chamou++; break; } } catch (e) { /* aba sem o leitor */ } }
  return { abas: abas.length, chamou };
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || (msg.tipo !== 'SITUACAO_PEDIR' && msg.tipo !== 'SITUACAO_RESULTADO' && msg.tipo !== 'SITUACAO_AGORA')) return;
  sitEmFila(async () => {
    try {
      if (msg.tipo === 'SITUACAO_PEDIR') sendResponse(await situacaoPedir(!!msg.forcar));
      else if (msg.tipo === 'SITUACAO_RESULTADO') { await situacaoResultado(msg); sendResponse({ ok: true }); }
      else sendResponse(await situacaoAgora());
    } catch (e) { try { sendResponse({ rodar: false, motivo: 'erro', erro: String((e && e.message) || e) }); } catch (e2) { /* canal fechado */ } }
  });
  return true;
});
