'use strict';
/* 05/11 — GERAR A NF: O PRAZO COBRE TAMBÉM A LEITURA DA RESPOSTA (auditoria do Codex no SHA 208fdb7d, achado F07). O
   gerarNFeDoPedido (lib/fiscal/bling-api) desarmava o prazo assim que chegavam os CABEÇALHOS e lia o corpo sem prazo: um
   Bling que manda o cabeçalho e não termina o corpo prendia o F2 (o guarda de "rodando") até reiniciar o servidor. Prova
   com a função DE PRODUÇÃO e a rede trocada (a leitura do corpo só termina se o prazo abortar):
   · 2xx com o corpo pendurado → volta no prazo, ok:true sem o id (a nota foi criada);
   · 5xx com o corpo pendurado → volta no prazo, AMBÍGUO (a nota pode ter sido criada);
   · 4xx com o corpo pendurado → volta no prazo, erro (sem ambíguo);
   · 2xx com o corpo normal → ok:true com o id da NF (nada mudou no caminho feliz). */
const assert = require('assert');
const Module = require('module');

let modo = null;
const _load = Module._load;
Module._load = function (req) {
  if (req === 'node-fetch') return async (url, opts) => {
    const sinal = opts && opts.signal;
    const pendurado = () => new Promise((res, rej) => { if (sinal) sinal.addEventListener('abort', () => rej(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))); });
    const { status, corpo } = modo;
    return { status, ok: status >= 200 && status < 300, headers: { get: () => null },
      text: async () => (corpo === null ? pendurado() : corpo), json: async () => (corpo === null ? pendurado() : JSON.parse(corpo)) };
  };
  return _load.apply(this, arguments);
};
process.env.GERAR_NFE_TIMEOUT_MS = '150';
process.env.T_PAUSA = '0'; process.env.T_GETPAUSA = '0';
const { criarBlingApi } = require('../lib/fiscal/bling-api');
const api = criarBlingApi({ rotulo: 'TESTE', envPausaMs: 'T_PAUSA', envGetPausaMs: 'T_GETPAUSA', envMaxPaginas: 'T_MP', envMaxPaginasNfe: 'T_MPN',
  envJanelaUltimosDias: 'T_JAN', envMeLojaIds: 'T_ME', envSituacaoAguardando: 'T_SIT' });

const guarda = setTimeout(() => { console.error('FALHOU: o gerarNFeDoPedido ficou PENDURADO esperando o corpo (o prazo não cobre a leitura)'); process.exit(1); }, 5000);
async function caso(status, corpo) { modo = { status, corpo }; const t0 = Date.now(); const r = await api.gerarNFeDoPedido('tok', 555); return { r, ms: Date.now() - t0 }; }
(async () => {
  let x = await caso(200, null);
  assert.ok(x.r.ok === true && x.r.nfId === null && x.ms < 3000, '2xx com o corpo pendurado: ' + JSON.stringify(x));
  x = await caso(502, null);
  assert.ok(x.r.ok === false && x.r.ambiguo === true && x.r.status === 502, '5xx com o corpo pendurado tinha que ser AMBÍGUO: ' + JSON.stringify(x.r));
  x = await caso(422, null);
  assert.ok(x.r.ok === false && !x.r.ambiguo && x.r.status === 422, '4xx com o corpo pendurado tinha que ser erro: ' + JSON.stringify(x.r));
  x = await caso(201, JSON.stringify({ data: { id: 98765 } }));
  assert.ok(x.r.ok === true && String(x.r.nfId) === '98765', 'o caminho feliz mudou: ' + JSON.stringify(x.r));
  clearTimeout(guarda); Module._load = _load;
  console.log('ok — gerar a NF: o prazo cobre a leitura da resposta (corpo pendurado volta no prazo: 2xx criada, 5xx ambíguo, 4xx erro); o caminho feliz não mudou');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
