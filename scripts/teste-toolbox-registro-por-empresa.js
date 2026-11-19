/* 15/11 — 2.1.19: A EMPRESA MANDA EM TODAS AS ETAPAS DA PONTE DE DEVOLUÇÕES (P1-06 da auditoria do Codex no
   repo Devoluções, item que vive AQUI porque a extensão viva é a Toolbox — a pasta extensao-bridge/ de lá está
   congelada desde 28/08).

   O que estava errado: os ids fiscais já vinham da empresa certa (ENDERECO_IDS), mas o PUT do auto-registro
   usava `indexOf('amb') === 0 ? '/amb' : ''` em quatro lugares — a GIRASSOL caía na RAIZ, a tabela da GOOD:
      GET /girassol/api/ids-fiscais  →  PUT /api/admin/registrar-devolucao-gerada/42   ← devolução 42 da GOOD
   Com uma sessão admin da GOOD aberta no mesmo navegador e um id coincidente, a NF da Girassol era gravada numa
   devolução da GOOD. E a aba do Bling escolhida (a primeira que a extensão acha) nunca era conferida contra a
   empresa pedida.

   Aqui o bg-devolucoes.js REAL roda num `chrome` simulado (tabs, scripting, storage, runtime) com fetch
   simulado: a cena da auditoria, AMB/GOOD, falha de registro que fica na fila e é entregue ao painel, empresa
   desconhecida, e a recusa por identidade da conta logada. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const raiz = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-devolucoes.js'), 'utf8');

function montar({ respostaRegistro, respostaPagina, storageInicial }) {
  const chamadas = { fetch: [], exec: [] };
  const storage = Object.assign({}, storageInicial || {});
  const listeners = [];
  const chrome = {
    runtime: { onMessage: { addListener: fn => listeners.push(fn) }, onInstalled: { addListener() {} }, sendMessage: async () => ({}), id: 'ext', getManifest: () => ({ version: 'teste' }) },
    webRequest: { onSendHeaders: { addListener() {} }, onBeforeSendHeaders: { addListener() {} } },
    storage: {
      session: { get: async () => ({}), set: async () => {} },
      local: { get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) o[x] = storage[x]; return o; }, set: async (o) => Object.assign(storage, o) },
    },
    tabs: { query: async () => [{ id: 7, url: 'https://www.bling.com.br/notas.php', windowId: 1 }], update: async () => {}, get: async () => ({ id: 7 }) },
    windows: { update: async () => {} },
    scripting: {
      executeScript: async (opts) => {
        const arg = opts.args[0];
        chamadas.exec.push(arg);
        setTimeout(() => { for (const l of listeners) l({ tipo: 'BLING_DEVOLUCAO_RESULTADO_PAGINA', execId: arg.execId, ...respostaPagina(arg) }, {}, () => {}); }, 5);
        return [{ result: null }];
      },
    },
  };
  const IDS = { good: { idEmpresaControl: '4956030980', idNaturezaOperacao: '5776118802' }, girassol: { idEmpresaControl: '933846821', idNaturezaOperacao: '1044537822' }, ambtotal: { idEmpresaControl: '14901993834', idNaturezaOperacao: '15110128838' } };
  const ctx = {
    chrome, console: { log() {}, warn() {}, error() {} }, Date, String, Number, JSON, Promise, Map, Set, Math, Array, Object, Error, setTimeout, clearTimeout, encodeURIComponent,
    fetch: async (url, opts) => {
      chamadas.fetch.push({ url: String(url).replace(/^https:\/\/[^/]+/, ''), method: (opts && opts.method) || 'GET' });
      const u = String(url);
      if (/ids-fiscais/.test(u)) { const emp = /\/girassol\//.test(u) ? 'girassol' : /\/amb\//.test(u) ? 'ambtotal' : 'good'; return { ok: true, json: async () => ({ ok: true, ...IDS[emp] }) }; }
      if (/registrar-devolucao-gerada/.test(u)) return respostaRegistro(u);
      return { ok: false, status: 404, json: async () => ({}) };
    },
  };
  vm.createContext(ctx);
  /* 2.1.21: a ficha das empresas vem antes */ vm.runInContext(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'tb-empresas.js'), 'utf8'), ctx); vm.runInContext(SRC, ctx);
  const mensagem = (msg) => new Promise((resolve) => { for (const l of listeners) { if (l(msg, { tab: { id: 1 } }, resolve) === true) return; } resolve(null); });
  return { chamadas, storage, mensagem };
}
const OK200 = async () => ({ ok: true, status: 200 });
const NF = () => ({ ok: true, resultado: { idNotaDevolucao: '555', numero: '127999', emitida: true } });

(async () => {
  /* 1. a cena da auditoria: girassol → ids da Girassol E registro em /girassol */
  {
    const t = montar({ respostaRegistro: OK200, respostaPagina: NF });
    const r = await t.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: { idNFOriginal: '1', empresa: 'girassol', devolucaoId: '42', emitir: true } });
    assert.strictEqual(r && r.ok, true, 'girassol: fluxo responde ok');
    const urls = t.chamadas.fetch.map(c => c.method + ' ' + c.url);
    assert.ok(urls.includes('GET /girassol/api/ids-fiscais'), 'ids fiscais na area da Girassol');
    assert.ok(urls.includes('PUT /girassol/api/admin/registrar-devolucao-gerada/42'), 'o auto-registro foi em /girassol/…/42 — veio: ' + urls.join(' | '));
    assert.ok(!urls.includes('PUT /api/admin/registrar-devolucao-gerada/42'), 'NADA na raiz (a tabela da GOOD)');
    assert.strictEqual(t.chamadas.exec[0].fixos.idEmpresaControl, '933846821');
    assert.strictEqual(t.chamadas.exec[0].empresa, 'girassol', 'a pagina do Bling sabe qual empresa foi pedida');
    assert.deepStrictEqual({ ok: r.resultado.auto_registro.ok, status: r.resultado.auto_registro.status, empresa: r.resultado.auto_registro.empresa }, { ok: true, status: 200, empresa: 'girassol' }, 'o resultado diz que gravou e onde');
  }
  /* 2. amb (caminho da URL) → /amb; good → raiz */
  {
    const t = montar({ respostaRegistro: OK200, respostaPagina: NF });
    await t.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: { idNFOriginal: '1', empresa: 'amb', devolucaoId: '9' } });
    await t.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: { idNFOriginal: '1', empresa: 'good', devolucaoId: '9' } });
    const puts = t.chamadas.fetch.filter(c => c.method === 'PUT').map(c => c.url);
    assert.deepStrictEqual(puts, ['/amb/api/admin/registrar-devolucao-gerada/9', '/api/admin/registrar-devolucao-gerada/9']);
  }
  /* 3. registro falhou (401): o resultado diz, a pendencia entra na fila com a EMPRESA certa, o painel recebe e limpa */
  {
    const t = montar({ respostaRegistro: async () => ({ ok: false, status: 401 }), respostaPagina: () => ({ ok: true, resultado: { idNotaDevolucao: '777', numero: '128000' } }) });
    const r = await t.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: { idNFOriginal: '1', empresa: 'girassol', devolucaoId: '43' } });
    assert.strictEqual(r.ok, true, 'a NF existe: o fluxo e ok');
    assert.strictEqual(r.resultado.auto_registro.ok, false, 'mas o resultado DIZ que nao gravou');
    const f = await t.mensagem({ tipo: 'BLING_FALHAS_REGISTRO' });
    assert.strictEqual(f.falhas.length, 1);
    assert.deepStrictEqual([f.falhas[0].empresa, f.falhas[0].devolucaoId, f.falhas[0].idNotaDevolucao, f.falhas[0].numero], ['girassol', '43', '777', '128000']);
    assert.ok(/401/.test(f.falhas[0].erro), 'com o motivo');
    const l = await t.mensagem({ tipo: 'BLING_FALHAS_REGISTRO_LIMPAR', chaves: ['girassol:43'] });
    assert.strictEqual(l.restam, 0, 'o painel que gravou limpa pela chave empresa:devolucao');
    /* a drenagem (roda na subida do worker) usa o prefixo da empresa de CADA pendencia; desconhecida fica na fila */
    const t2 = montar({ respostaRegistro: OK200, respostaPagina: NF, storageInicial: { reg_pendentes: [
      { devolucaoId: '50', empresa: 'girassol', id: '1', numero: '2', quando: Date.now() },
      { devolucaoId: '51', empresa: 'ambtotal', id: '1', numero: '2', quando: Date.now() },
      { devolucaoId: '52', empresa: 'quinta', id: '1', numero: '2', quando: Date.now() },
    ] } });
    await new Promise(res => setTimeout(res, 30));
    const putsDren = t2.chamadas.fetch.filter(c => c.method === 'PUT').map(c => c.url).sort();
    assert.deepStrictEqual(putsDren, ['/amb/api/admin/registrar-devolucao-gerada/51', '/girassol/api/admin/registrar-devolucao-gerada/50'], 'drenagem: cada pendencia na area da SUA empresa; a desconhecida nao vai pra raiz');
    assert.strictEqual((t2.storage.reg_pendentes || []).map(x => String(x.devolucaoId)).join(','), '52', 'as gravadas saem da fila; a desconhecida fica (vinculo manual)');
  }
  /* 3b. Codex #904 (P2): limpar do painel no MEIO de um enfileirar nao apaga a pendencia nova — a fila e serializada */
  {
    const soltar = [];   // cada PUT fica pendurado ate o teste soltar — todos falham (500)
    const t = montar({ respostaRegistro: () => new Promise(res => soltar.push(() => res({ ok: false, status: 500 }))), respostaPagina: () => ({ ok: true, resultado: { idNotaDevolucao: '900', numero: '1' } }), storageInicial: { reg_pendentes: [{ devolucaoId: '1', empresa: 'good', id: '1', numero: '1', quando: Date.now() - 10 }] } });
    await new Promise(res => setTimeout(res, 20));          // a drenagem da subida esta pendurada no PUT da pendencia 1 (segura a fila)
    const pFluxo = t.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: { idNFOriginal: '1', empresa: 'girassol', devolucaoId: '77' } });
    await new Promise(res => setTimeout(res, 900));         // o fluxo (que espera 600ms pra acordar a aba) esta pendurado no PUT do registro da 77
    const pLimpar = t.mensagem({ tipo: 'BLING_FALHAS_REGISTRO_LIMPAR', chaves: ['good:1'] });   // o painel limpa a 1 no meio de tudo
    assert.strictEqual(soltar.length, 2, 'drenagem e fluxo estao os dois esperando o servidor (' + soltar.length + ')');
    soltar[1](); await new Promise(res => setTimeout(res, 10));   // o PUT da 77 falha → enfileirar(77) entra na corrente, atras da drenagem
    soltar[0]();                                            // a drenagem termina (1 volta pra fila), depois enfileirar(77), depois limpar(good:1)
    await pFluxo; await pLimpar;
    await new Promise(res => setTimeout(res, 30));
    const ids = (t.storage.reg_pendentes || []).map(x => String(x.empresa) + ':' + x.devolucaoId).sort();
    assert.strictEqual(ids.join(','), 'girassol:77', 'a 1 foi limpa pelo painel; a pendencia nova (girassol:77) NAO foi apagada pelo limpar concorrente — fila: ' + ids.join(','));
  }
  /* 4. empresa desconhecida: nada e feito, nem no Bling nem no servidor */
  {
    const t = montar({ respostaRegistro: OK200, respostaPagina: NF });
    const r = await t.mensagem({ tipo: 'BLING_DEVOLUCAO_CRIAR', payload: { idNFOriginal: '1', empresa: 'quartaempresa', devolucaoId: '1' } });
    assert.strictEqual(r.ok, false); assert.ok(/empresa desconhecida/.test(r.erro));
    assert.strictEqual(t.chamadas.exec.length + t.chamadas.fetch.length, 0);
  }
  /* 5. identidade: a aba logada em OUTRA empresa e recusada dentro da pagina (fonte da funcao injetada) */
  {
    const fonte = SRC.slice(SRC.indexOf('function fluxoDevolucaoNaPagina'));
    assert.ok(/A aba do Bling esta logada em OUTRA empresa/.test(fonte) && /String\(p\.fixos\.idEmpresaControl\) !== idEmpresaDaConta/.test(fonte),
      'fluxoDevolucaoNaPagina recusa quando o id da conta logada difere do id da empresa pedida');
  }
  /* 6. o padrao antigo sumiu; um mapa so; content entrega as pendencias; manifest subiu */
  assert.strictEqual((SRC.match(/indexOf\('amb'\) === 0\) \? '\/amb' : ''/g) || []).length, 0, 'nenhum `indexOf(amb) ? /amb : raiz` sobrou no codigo');
  /* 2.1.21: os dois mapas (ENDERECO_IDS e PREFIXO_REGISTRO) nascem do MESMO laco sobre a ficha (tb-empresas.js) — uma lista so */
  assert.ok(/for \(const _k of tbEmpresas\(\)\) \{[^}]*ENDERECO_IDS\[_f\.canonico\][^}]*PREFIXO_REGISTRO\[_f\.canonico\] = _f\.devolucoes;/s.test(SRC), 'um mapa so, montado da ficha, com as mesmas empresas do ENDERECO_IDS');
  const idsBloco = /const ENDERECO_IDS = \{([\s\S]*?)\};/.exec(SRC)[1];
  const naPonte = [...idsBloco.matchAll(/^\s*(\w+):\s*'/gm)].map(m => m[1]).sort();
  const noRegistro = [...(/const PREFIXO_REGISTRO = \{([^}]*)\}/.exec(SRC)[1]).matchAll(/(\w+):/g)].map(m => m[1]).sort();
  assert.deepStrictEqual(noRegistro, naPonte, 'toda empresa que tem ids tem area de registro (e vice-versa)');
  const CT = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'ct-devolucoes.js'), 'utf8');
  assert.ok(/BLING_FALHAS_REGISTRO/.test(CT) && /GOOD_BRIDGE_FALHAS_REGISTRO/.test(CT) && /GOOD_BRIDGE_FALHAS_LIMPAR/.test(CT), 'ct-devolucoes entrega as pendencias a pagina e repassa o limpar');
  const manifesto = JSON.parse(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'manifest.json'), 'utf8'));
  assert.ok(manifesto.version.split('.').map(Number) >= [2, 1, 19] && manifesto.version !== '2.1.18', 'manifest subiu (2.1.19+): ' + manifesto.version);

  console.log('OK: Toolbox — a empresa manda em todas as etapas da ponte (ids, registro, pendencias, identidade da conta)');
})().catch((e) => { console.error('FALHOU:', e && e.stack || e); process.exit(1); });
