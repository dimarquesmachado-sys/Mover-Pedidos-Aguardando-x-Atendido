'use strict';
/* 07/11 (rotas comuns, passo 9a) — O /sku-info NIVELADO (a união das duas versões, igual nas três empresas).
   Roda o CÓDIGO DE VERDADE da rota de cada empresa (o trecho do arquivo dela) com o Bling e o banco de custos de mentira:
   · produto com COMPOSIÇÃO (kit): o custo do fornecedor (20,40) NÃO é o custo do kit — fica o do banco (34,00), que o
     custo-sync calcula somando a estrutura (da Girassol/AMB; a GOOD devolvia 20,40);
   · o NOME do produto vem na resposta (da Girassol/AMB; a GOOD não devolvia);
   · cadastro todo EXCLUÍDO no Bling: o custo velho (do cadastro apagado) NÃO volta — nem no meio, nem na proteção do fim
     (Codex #497 P1, da GOOD; a Girassol/AMB restauravam pelo fim);
   · a busca que FALHA (429/timeout) cai no custo do banco (Codex #186 / b20 — as duas versões protegiam isso). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

function bloco(src, ini) {
  let n = 0, j = src.indexOf('{', ini);
  for (; j < src.length; j++) { const c = src[j]; if (c === '{') n++; else if (c === '}') { n--; if (!n) break; } }
  return j + 1;
}
function rotaDe(arq, pfx) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const m = new RegExp("[ \\t]*if \\([^\\n]*p === '" + pfx.replace(/[-/]/g, '\\$&') + "/sku-info'").exec(s);
  assert.ok(m, arq + ': não achei a rota /sku-info');
  const ini = s.lastIndexOf('\n', m.index) + 1;
  return s.slice(ini, bloco(s, m.index));
}
const LIVRES = ['validarSessao', 'lerChaveAdmin', 'ehAdmin', 'json', 'readBody', 'path', 'CACHE_DIR', 'readJson', 'writeJson', '_custoLib', '_ctxCusto', 'comCustosManuais', 'blingGet', 'resolverProdutoPorSku', 'fs', 'setTimeout'];
async function rodar(rota, pfx, cenario) {
  const fabrica = new Function(...LIVRES, 'let _skuInfoCache = null;\nreturn async function (req, res, p, method, urlObj) {\n' + rota + '\nreturn false; };');
  let resposta = null;
  const banco = cenario.banco;
  const h = fabrica(
    () => null, () => 'k-adm', () => false,
    (res, code, body) => { resposta = { code, body }; },
    async () => ({ skus: Object.keys(cenario.resolver), fresh: true }),
    path, '/nao-existe', (f, d) => (/_custos\.json$/.test(f) ? JSON.parse(JSON.stringify(banco)) : d), () => {},
    { custoDeSku: (cc, sku) => cc[sku] || null, epocaCusto: () => 1 }, {}, (m) => m,
    async (pth) => {
      let mm = /^\/produtos\/(\d+)$/.exec(pth);
      if (mm) return { ok: true, data: { data: cenario.detalhe[mm[1]] } };
      if (/^\/estoques\/saldos/.test(pth)) return { ok: true, data: { data: [] } };
      if (/^\/produtos\/fornecedores/.test(pth)) return { ok: true, data: { data: [] } };
      return { ok: false };
    },
    async (sku) => cenario.resolver[sku], fs, (fn) => { fn(); return 0; });
  const metodo = /method === 'GET'/.test(rota.split('\n')[0]) ? 'GET' : 'POST';
  await h({ method: metodo, headers: {} }, {}, pfx + '/sku-info', metodo, new URL('http://h' + pfx + '/sku-info?k=k-adm'));
  return resposta;
}
const CENARIO = {
  resolver: { KIT1: { produto: { id: 1 } }, NORMAL: { produto: { id: 2 } }, APAGADO: { produto: null, todosExcluidos: true }, FALHA429: { produto: null, todosExcluidos: false } },
  detalhe: { 1: { id: 1, nome: 'Kit de 3 lixas', preco: 50, fornecedor: { precoCusto: 20.4 }, estrutura: { componentes: [{ produto: { id: 11 }, quantidade: 1 }] } },
             2: { id: 2, nome: 'Pendente LTJ30', preco: 10, fornecedor: { precoCusto: 4.5 } } },
  banco: { KIT1: { id: 1, custo: 34, ts: 0 }, APAGADO: { id: 9, custo: 50, ts: 0 }, FALHA429: { id: 7, custo: 12, ts: 0, nome: 'Velho' } },
};
(async () => {
  process.env.ADMIN_KEY = 'k-adm';
  for (const [arq, pfx] of [['girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'], ['amb-checkout-offline/index.js', '/amb-checkout-offline'], ['good-checkout-offline/index.js', '/good-checkout-offline']]) {
    const r = await rodar(rotaDe(arq, pfx), pfx, CENARIO);
    assert.ok(r && r.code === 200 && r.body && r.body.skus, arq + ': a rota não respondeu: ' + JSON.stringify(r));
    const s = r.body.skus;
    assert.strictEqual(s.KIT1.custo, 34, arq + ': kit — o custo do fornecedor não é o do kit; tinha que ficar o do banco (34): ' + JSON.stringify(s.KIT1));
    assert.strictEqual(s.KIT1.nome, 'Kit de 3 lixas', arq + ': o nome do produto não veio');
    assert.ok(s.NORMAL.custo === 4.5 && s.NORMAL.nome === 'Pendente LTJ30', arq + ': produto normal errado: ' + JSON.stringify(s.NORMAL));
    assert.strictEqual(s.APAGADO.custo, null, arq + ': cadastro todo EXCLUÍDO — o custo velho (do cadastro apagado) voltou: ' + JSON.stringify(s.APAGADO));
    assert.strictEqual(s.FALHA429.custo, 12, arq + ': busca que falhou tinha que cair no custo do banco: ' + JSON.stringify(s.FALHA429));
  }
  console.log('ok — /sku-info nivelado nas três: kit fica com o custo do banco (não o do fornecedor), o nome vem, cadastro excluído não ressuscita custo velho, busca que falha usa o banco');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
