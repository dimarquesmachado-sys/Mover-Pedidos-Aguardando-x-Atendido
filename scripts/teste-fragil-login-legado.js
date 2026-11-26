'use strict';
/* 26/11 — O LOGIN PRÓPRIO DO FRÁGIL NO BLING É LEGADO: NÃO ACENDE MAIS A TARJA VERMELHA NEM ASSUSTA NO PAINEL.
   O dono: "todo dia aparece token bling vencido. tem q achar pq isso" — e, ao abrir o link de reautorizar, o Bling
   pergunta se autoriza o app "GOOD-…-FRAGIL" na conta da Girassol: "amanhã qdo eu desligar a GOOD… vai acabar perdendo
   tb. não tinha q ter uma estrutura multiempresa, pra não depender da GOOD nisso?".

   O que o código diz: a estrutura multiempresa JÁ existe desde 29/08 — a busca de produtos do painel do Frágil usa o
   token de CADA empresa (buscarNaEmpresa) e o painel sempre manda a empresa. O login próprio do módulo (um app do Bling
   da GOOD) só alimenta o índice antigo, que nenhuma tela consulta. Mas o canário de tokens seguia tratando a quebra
   dele como alerta: a tarja vermelha ficava acesa em todos os painéis, todo dia, pedindo uma reautorização inútil; e o
   painel do Frágil dizia "Bling não está logado. Sem isso, a busca de produtos não funciona".

   O que se prova:
   A. o canário DE PRODUÇÃO (lib/canario-tokens): com a busca por empresa configurada, o login quebrado do Frágil vira
      'dispensado' e não acende a tarja — inclusive com o estado antigo ('quebrado') ainda gravado no disco; sem busca
      por empresa nenhuma, segue sendo quebra; os módulos de Estoque seguem acendendo a tarja como sempre;
   B. o painel do Frágil (public/fragil/app.js, a função de produção num navegador de mentira): com busca por empresa e
      sem login próprio, nada de "Bling logado ❌", contadores do índice antigo ou aviso amarelo; sem busca por empresa,
      ou com o login próprio vivo, tudo aparece como antes;
   C. o painel sempre busca com a empresa, e a busca com empresa nunca cai no índice antigo. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'canario-'));
const ARQ = { estado: path.join(tmp, 'canario.json'), fragil: path.join(tmp, 'fragil.json'), estoque: path.join(tmp, 'estoque.json'), eg: path.join(tmp, 'eg.json') };
process.env.CANARIO_TOKENS_FILE = ARQ.estado; process.env.FRAGIL_TOKEN_FILE = ARQ.fragil; process.env.ESTOQUE_TOKEN_FILE = ARQ.estoque; process.env.ESTOQUE_GIRASSOL_TOKEN_FILE = ARQ.eg;
const ENVS = ['BLING_CLIENT_ID', 'GOOD_BLING_CLIENT_ID', 'AMB_BLING_CLIENT_ID'];
const limpaEnvs = () => ENVS.forEach((e) => { delete process.env[e]; });
limpaEnvs();
const C = require('../lib/canario-tokens');
/* o canário espera 3 s entre módulos: o relógio do teste não espera */
const stReal = global.setTimeout; global.setTimeout = (f, ms, ...a) => stReal(f, ms >= 1000 ? 0 : ms, ...a);
const limpa = () => { for (const f of Object.values(ARQ)) { try { fs.unlinkSync(f); } catch (e) {} } };

(async () => {
  assert.deepStrictEqual(C.ENVS_BUSCA_POR_EMPRESA, ENVS, 'as mesmas envs que o /fragil/health confere');
  const fi = fs.readFileSync(path.join(raiz, 'fragil/index.js'), 'utf8');
  for (const e of ENVS) assert.ok(new RegExp("\\['(girassol|good|ambtotal)', '" + e + "'\\]").test(fi), 'o /fragil/health confere ' + e);

  /* ═══ A. o canário ═══ */
  /* o estado de produção de hoje: o arquivo do Frágil existe e está sem refresh_token; os de Estoque nunca foram autorizados aqui */
  limpa(); fs.writeFileSync(ARQ.fragil, '{}');
  /* sem busca por empresa nenhuma: o login próprio é o que resta — quebra é quebra */
  let e = await C.verificarTodos();
  assert.deepStrictEqual([e.modulos.fragil.estado, e.modulos.fragil.ok, /reautorize em \/fragil\/auth\/bling/.test(e.modulos.fragil.erro), e.modulos.estoque.estado, C.temAlerta()], ['quebrado', false, true, 'nao_autorizado', true], JSON.stringify(e.modulos));
  /* com a busca por empresa (basta uma empresa configurada): dispensado, sem tarja — NA HORA, com o 'quebrado' ainda no disco */
  for (const env of ENVS) {
    limpaEnvs(); process.env[env] = 'x';
    assert.strictEqual(JSON.parse(fs.readFileSync(ARQ.estado, 'utf8')).modulos.fragil.estado, 'quebrado', 'o disco ainda diz quebrado');
    assert.strictEqual(C.temAlerta(), false, env + ': a tarja apaga sem esperar a verificação do dia seguinte');
    limpaEnvs(); assert.strictEqual(C.temAlerta(), true, 'sem a env, volta a ser alerta');
  }
  process.env.BLING_CLIENT_ID = 'x';
  e = await C.verificarTodos();
  assert.deepStrictEqual([e.modulos.fragil.estado, e.modulos.fragil.ok, e.modulos.fragil.erro, e.modulos.fragil.jaAutorizado, C.temAlerta()], ['dispensado', false, C.MSG_DISPENSADO, true, false], JSON.stringify(e.modulos.fragil));
  assert.ok(/não é mais necessário/.test(C.MSG_DISPENSADO) && /nada a fazer/.test(C.MSG_DISPENSADO) && !/reautorize/.test(C.MSG_DISPENSADO), 'a mensagem não manda reautorizar');
  /* o arquivo sumiu depois de já ter sido autorizado: também é dispensado */
  fs.unlinkSync(ARQ.fragil);
  e = await C.verificarTodos();
  assert.deepStrictEqual([e.modulos.fragil.estado, C.temAlerta()], ['dispensado', false]);
  /* a dispensa é SÓ do Frágil: Estoque quebrado acende a tarja mesmo com a busca por empresa configurada */
  fs.writeFileSync(ARQ.estoque, '{}');
  e = await C.verificarTodos();
  assert.deepStrictEqual([e.modulos.estoque.estado, e.modulos.fragil.estado, C.temAlerta()], ['quebrado', 'dispensado', true], 'Estoque não é dispensável');
  fs.unlinkSync(ARQ.estoque); fs.writeFileSync(ARQ.eg, '{}');
  e = await C.verificarTodos();
  assert.deepStrictEqual([e.modulos['estoque-girassol'].estado, C.temAlerta()], ['quebrado', true], 'Estoque Girassol não é dispensável');
  assert.deepStrictEqual(C.MODULOS.map((m) => [m.id, typeof m.dispensavel]), [['estoque', 'undefined'], ['estoque-girassol', 'undefined'], ['fragil', 'function']]);
  /* estado de módulo desconhecido gravado no disco (versão futura/antiga) com quebra: segue alertando, e não estoura */
  limpa(); fs.writeFileSync(ARQ.estado, JSON.stringify({ modulos: { outro: { estado: 'quebrado' }, torto: null, fragil: { estado: 'quebrado' } } }));
  assert.strictEqual(C.temAlerta(), true);
  fs.writeFileSync(ARQ.estado, JSON.stringify({ modulos: { torto: null, fragil: { estado: 'quebrado' }, estoque: { estado: 'ok' } } }));
  assert.strictEqual(C.temAlerta(), false);
  limpaEnvs(); global.setTimeout = stReal;

  /* ═══ B. o painel do Frágil ═══ */
  {
    const fonte = fs.readFileSync(path.join(raiz, 'public/fragil/app.js'), 'utf8');
    const ini = fonte.indexOf('async function carregarStatus() {'), fimF = fonte.indexOf('function badge(cls, label, valor) {');
    assert.ok(ini > 0 && fimF > ini, 'achei a função de status');
    const fimBadge = fonte.indexOf('\n}', fimF) + 2;
    const painel = async (health, cache) => {
      const els = {}; const el = (id) => els[id] || (els[id] = { innerHTML: '', textContent: '', style: { display: 'INICIAL' } });
      const f = new Function('$', 'fetch', 'VERSAO', fonte.slice(ini, fimBadge) + '\nreturn carregarStatus;')(el, async (u) => ({ json: async () => { if (/cache-status/.test(u)) { if (!cache) throw new Error('x'); return cache; } return health; } }), 'vT');
      await f();
      return { status: els['status-painel'].innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), alerta: el('alerta-bling') };
    };
    const base = { skusFrageis: 104, usuariosCadastrados: 2, blingConfigurado: true, atualizadoEm: null };
    const cacheVazio = { skusIndexados: 0, detalhesEmCache: 0, eansCarregados: false };
    /* o caso do dono: 3 empresas na busca, login próprio morto — nada do legado aparece */
    let p = await painel(Object.assign({}, base, { buscaPorEmpresa: ['girassol', 'good', 'ambtotal'], blingLogado: false }), cacheVazio);
    assert.ok(/Busca por empresa: ✅ 3 empresa\(s\)/.test(p.status) && /SKUs frágeis: 104/.test(p.status) && /Usuários cadastrados: 2/.test(p.status), p.status);
    assert.ok(!/Bling logado/.test(p.status) && !/SKUs no cache/.test(p.status) && !/Detalhes/.test(p.status), 'nada do índice antigo: ' + p.status);
    assert.deepStrictEqual([p.alerta.style.display, p.alerta.innerHTML], ['none', ''], 'sem aviso amarelo mandando logar');
    /* uma empresa só na busca já basta */
    p = await painel(Object.assign({}, base, { buscaPorEmpresa: ['girassol'], blingLogado: false }), cacheVazio);
    assert.ok(!/Bling logado/.test(p.status) && p.alerta.style.display === 'none', p.status);
    /* sem busca por empresa: o login próprio é o que resta — tudo como antes */
    for (const bpe of [[], undefined]) {
      p = await painel(Object.assign({}, base, { buscaPorEmpresa: bpe, blingLogado: false }), cacheVazio);
      assert.ok(/Bling logado: ❌ Não/.test(p.status) && /SKUs no cache: 0/.test(p.status) && /Detalhes \(nome\+EAN\+imagem\): 0\/0 ⏳/.test(p.status), p.status);
      assert.ok(p.alerta.style.display === 'block' && /Bling não está logado/.test(p.alerta.innerHTML) && /\/fragil\/auth\/bling/.test(p.alerta.innerHTML));
    }
    /* com busca por empresa E login próprio vivo: o índice antigo aparece (existe), com os avisos dele */
    p = await painel(Object.assign({}, base, { buscaPorEmpresa: ['girassol'], blingLogado: true }), cacheVazio);
    assert.ok(/Bling logado: ✅ Sim/.test(p.status) && /SKUs no cache: 0/.test(p.status) && p.alerta.style.display === 'block' && /carregando produtos do cache/.test(p.alerta.innerHTML), p.status);
    p = await painel(Object.assign({}, base, { buscaPorEmpresa: ['girassol'], blingLogado: true }), { skusIndexados: 50, detalhesEmCache: 50, eansCarregados: true });
    assert.ok(/Detalhes \(nome\+EAN\+imagem\): 50\/50 ✅/.test(p.status) && p.alerta.style.display === 'none', p.status);
    /* a rota do cache falhou: o resto do status sai */
    p = await painel(Object.assign({}, base, { buscaPorEmpresa: [], blingLogado: false }), null);
    assert.ok(/Bling logado: ❌ Não/.test(p.status) && !/SKUs no cache/.test(p.status) && p.alerta.style.display === 'block');
    /* mexeu no .js do front: a versão aparece e o HTML pede o arquivo novo */
    assert.ok(/const VERSAO = "v3\.1";/.test(fonte) && fs.readFileSync(path.join(raiz, 'public/fragil/index.html'), 'utf8').includes('<script src="app.js?v=3.1"></script>'));

    /* ═══ C. ninguém consulta o índice antigo ═══ */
    assert.ok(/const empBusca = empresaAtiva\(\);\s+const data = await api\("\/fragil\/api\/buscar\?q=" \+ encodeURIComponent\(q\) \+ "&limite=100" \+\s+\(empBusca \? "&empresa=" \+ encodeURIComponent\(empBusca\) : ""\)\);/.test(fonte), 'o painel busca com a empresa ativa');
    assert.strictEqual((fonte.match(/\/fragil\/api\/buscar/g) || []).length, 1, 'uma chamada só à busca');
    const ext = fs.readdirSync(path.join(raiz, 'toolbox-extensao')).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(raiz, 'toolbox-extensao', f), 'utf8')).join('\n');
    assert.ok(!/fragil\/api\/buscar/.test(ext), 'a extensão não usa a busca do Frágil');
    assert.ok(/const rEmpresa = await blingProdutos\.buscarNaEmpresa\(empBusca, termo, limite\);/.test(fi) && /json\(res, 200, \{ ok: true, total: 0, resultados: \[\], empresa: empBusca,/.test(fi), 'com empresa: token da empresa; se falhar, lista vazia com aviso — nunca o índice antigo');
    const bp = fs.readFileSync(path.join(raiz, 'fragil/blingProdutos.js'), 'utf8');
    assert.ok(/girassol: '\.\.\/girassol\/tokenManager',\s+good:\s+'\.\.\/good\/tokenManager',\s+ambtotal: '\.\.\/ambtotal\/tokenManager',/.test(bp), 'cada empresa busca com o token DELA');
  }

  terminou = true; process.exitCode = 0;
  console.log('ok — o login próprio do Frágil no Bling é legado: com a busca por empresa configurada, a quebra dele vira "dispensado" e não acende a tarja (na hora, mesmo com o estado antigo no disco); sem busca por empresa segue sendo quebra; Estoque e Estoque Girassol seguem alertando; o painel do Frágil não mostra mais "Bling logado ❌" nem manda logar quando a busca por empresa existe; ninguém consulta o índice antigo');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
