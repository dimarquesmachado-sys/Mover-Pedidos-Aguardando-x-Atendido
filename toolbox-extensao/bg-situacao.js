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
const SIT_CONFIRMA_MS = 4000;   /* espera antes de reler a lista pra confirmar o que destravou */
let _sitFila = Promise.resolve();
function sitEmFila(fn) { _sitFila = _sitFila.then(fn, fn); return _sitFila; }
async function sitStatus(s) { await chrome.storage.local.set({ sit_status: Object.assign({ quando: Date.now() }, s) }); }

async function situacaoPedir(forcar, abaId) {
  const c = await chrome.storage.local.get(['tb_empresa', 'sceKey', 'tbBlingKey', 'sit_ultima', 'sit_vez', 'sit_tentadas', 'sit_sem_login']);
  const emp = c.tb_empresa, key = c.sceKey || c.tbBlingKey || '';
  if (!emp || !(emp in SIT_PREFIXO)) return { rodar: false, motivo: 'sem_empresa' };
  if (!key) { await sitStatus({ ok: false, empresa: emp, via: 'sem_chave', msg: 'falta a ADMIN_KEY (preencha na Central)' }); return { rodar: false, motivo: 'sem_chave' }; }
  const agora = Date.now();
  /* Codex #848 (2): uma aba do Bling SEM LOGIN (outro contêiner do Firefox, sessão caída) não pode ficar pegando a vez —
     ela é lembrada e fica de fora por um intervalo, pra aba logada rodar. O "agora" da Central (forcar) tenta de novo. */
  const semLogin = c.sit_sem_login || {};
  if (!forcar && abaId != null && semLogin[abaId] && agora - semLogin[abaId] < SIT_INTERVALO_MS) return { rodar: false, motivo: 'aba_sem_login' };
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
  /* Codex #848: com mais de 10 paradas, pegar sempre "as 10 primeiras" deixava a 11ª em diante sem vez enquanto as primeiras
     não destravassem. A escolha RODA: primeiro as nunca tentadas, depois as tentadas há mais tempo. */
  const tent = (c.sit_tentadas && c.sit_tentadas.empresa === emp && c.sit_tentadas.ids) || {};
  const vivos = {}; for (const n of d.nfs) if (tent[n.id]) vivos[n.id] = tent[n.id];
  await chrome.storage.local.set({ sit_tentadas: { empresa: emp, ids: vivos } });
  const escolhidas = d.nfs.slice().sort((a, b) => (vivos[a.id] || 0) - (vivos[b.id] || 0)).slice(0, SIT_MAX);
  return { rodar: true, empresa: emp, nfs: escolhidas.map((n) => ({ id: n.id, numero: n.numero })) };
}

async function situacaoResultado(msg, abaId) {
  const c = await chrome.storage.local.get(['tb_empresa', 'sceKey', 'tbBlingKey', 'sit_tentadas', 'sit_sem_login']);
  const emp = c.tb_empresa, key = c.sceKey || c.tbBlingKey || '';
  const res = Array.isArray(msg.resultados) ? msg.resultados.map((x) => Object.assign({}, x)) : [];
  if (msg.empresa !== emp) { await chrome.storage.local.remove('sit_vez'); await sitStatus({ ok: false, empresa: emp, via: 'empresa_mudou', msg: 'a empresa desta instalação mudou no meio da rodada — resultado descartado' }); return; }
  /* Codex #848 (2): a rodada parou por FALTA DE LOGIN nesta aba → ela não consultou nada: o intervalo da empresa NÃO é
     gasto (outra aba, logada, roda já) e esta aba fica marcada. Rodada com sessão desmarca a aba. */
  const semLogin = Object.assign({}, c.sit_sem_login || {});
  const agoraR = Date.now();
  for (const k of Object.keys(semLogin)) if (agoraR - semLogin[k] > SIT_INTERVALO_MS) delete semLogin[k];
  const parouSemLogin = res.some((x) => x.via === 'nao_logado');
  if (abaId != null) { if (parouSemLogin) semLogin[abaId] = agoraR; else delete semLogin[abaId]; }
  await chrome.storage.local.set({ sit_sem_login: semLogin });
  if (parouSemLogin) await chrome.storage.local.remove('sit_ultima');
  /* quem foi tentado agora vai pro fim da fila da próxima rodada (a que parou no login não foi tentada de verdade) */
  const tent = (c.sit_tentadas && c.sit_tentadas.empresa === emp && c.sit_tentadas.ids) || {};
  for (const x of res) if (x.via !== 'nao_logado') tent[x.id] = Date.now();
  await chrome.storage.local.set({ sit_tentadas: { empresa: emp, ids: tent } });
  /* Codex #848: "o Bling aceitou" não é "destravou". Confirma na lista do servidor: a nota gravada que SAIU de "Consultar
     situação" está destravada; a que continua lá não está (e vira aviso); sem conseguir reler, fica "sem confirmação" —
     não afirma o que não viu. */
  if (res.some((x) => x.via === 'gravada')) {
    let ainda = null;
    if (key) {
      await new Promise((ok) => setTimeout(ok, SIT_CONFIRMA_MS));
      try { const r = await fetch(SIT_HOST + SIT_PREFIXO[emp] + '/robo/nfs-consultar-situacao?k=' + encodeURIComponent(key)); const d = await r.json(); if (r.ok && d && Array.isArray(d.nfs)) ainda = new Set(d.nfs.map((n) => String(n.id))); } catch (e) { ainda = null; }
    }
    for (const x of res) {
      if (x.via !== 'gravada') continue;
      if (!ainda) { x.via = 'sem_confirmacao'; x.erro = 'o Bling aceitou a gravação, mas não deu pra confirmar agora — a próxima rodada confere'; }
      else if (ainda.has(String(x.id))) { x.via = 'nao_confirmada'; x.erro = 'o Bling aceitou a gravação, mas a nota continua em "Consultar situação"'; }
      else x.via = 'validada';
    }
  }
  await chrome.storage.local.remove('sit_vez');
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
  /* Codex #848: libera só o INTERVALO. A vez de uma aba que está no meio de uma rodada fica — senão outra aba pegava as
     mesmas notas e as duas gravavam ao mesmo tempo. Com rodada em andamento, a Central espera o resultado dela. */
  const c = await chrome.storage.local.get(['sit_vez']);
  const ocupado = !!(c.sit_vez && Date.now() - c.sit_vez < SIT_VEZ_MS);
  await chrome.storage.local.remove(['sit_ultima']);
  let abas = [];
  try { abas = await chrome.tabs.query({ url: ['https://www.bling.com.br/*'] }); } catch (e) { abas = []; }
  if (ocupado) return { abas: abas.length, chamou: 0, ocupado: true };
  let chamou = 0;
  for (const a of abas) { try { const r = await chrome.tabs.sendMessage(a.id, { tipo: 'SITUACAO_RODAR' }); if (r && r.ok) { chamou++; break; } } catch (e) { /* aba sem o leitor */ } }
  return { abas: abas.length, chamou };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || (msg.tipo !== 'SITUACAO_PEDIR' && msg.tipo !== 'SITUACAO_RESULTADO' && msg.tipo !== 'SITUACAO_AGORA')) return;
  sitEmFila(async () => {
    try {
      const abaId = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : null;
      if (msg.tipo === 'SITUACAO_PEDIR') sendResponse(await situacaoPedir(!!msg.forcar, abaId));
      else if (msg.tipo === 'SITUACAO_RESULTADO') { await situacaoResultado(msg, abaId); sendResponse({ ok: true }); }
      else sendResponse(await situacaoAgora());
    } catch (e) { try { sendResponse({ rodar: false, motivo: 'erro', erro: String((e && e.message) || e) }); } catch (e2) { /* canal fechado */ } }
  });
  return true;
});
