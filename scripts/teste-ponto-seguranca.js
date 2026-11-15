'use strict';
/* 15/11 — PONTO: OS DOIS P1 DA AUDITORIA DO CODEX (15/11/2026), PELO MÓDULO REAL, COM O SUPABASE DE MENTIRA.

   P1 nº 1 — a foto do funcionário virava HTML no painel do gestor: o servidor só olhava o prefixo `data:image` e o painel
   interpolava em innerHTML. Agora:
     A. `bater-ponto` só grava foto que É imagem (JPEG/PNG/WEBP em base64, assinatura conferida); o resto entra como
        "foto pulada", sem gravar nada em `fotos_batida`;
     B. `/admin/foto/:id` NÃO serve o que já estava guardado e não passa na validação (404);
     C. o painel (`public/ponto/admin.html`) não tem mais `<img src="${…}">` interpolado — monta com createElement — e os
        campos vindos de gente passam por `esc()` ou `textContent`.
   P1 nº 2 — a primeira senha (e a senha depois do reset) era de quem soubesse o e-mail. Agora:
     D. cadastrar e resetar devolvem um CÓDIGO DE CONVITE (uso único, 72 h); `criar-senha` sem código, com código errado,
        vencido ou já usado é recusado; com o código certo cria a senha e o código morre;
     E. o token de sessão carrega a versão da senha: depois do reset, a sessão antiga NÃO entra mais (antes durava 30 dias);
        token do formato antigo (sem versão) também não entra;
     F. se o banco falhar ao gravar a senha, o convite volta (o funcionário não perde o código por erro nosso).
   G. a peça de convites sozinha: código sem caracteres ambíguos, hash no disco (nunca o código), vencimento, uso único,
      gravação atômica, arquivo corrompido = sem convite. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const raiz = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ponto-seg-'));
process.env.PONTO_DATA_DIR = TMP;
process.env.PONTO_ADMIN_TOKEN = 'admin-teste-ponto';
process.env.PONTO_SESSION_SECRET = 'segredo-teste';
process.env.PONTO_SUPABASE_URL = 'https://ponto.supabase.teste';
process.env.PONTO_SUPABASE_SERVICE_KEY = 'k';
process.env.PONTO_FOTO_PROB_ENTRADA = '1';   /* toda entrada pede foto — o cenário da auditoria */
process.env.PONTO_FOTO_PROB_OUTROS = '1';

/* ── Supabase REST de mentira: tabelas em memória, só os filtros que o módulo usa ── */
const db = {
  funcionarios: [{ id: 7, nome: 'Zé do Galpão', matricula: '7', email: 'ze@galpao.local', cargo: 'estoque', setor: 'A', ativo: true, senha_definida: false, senha_hash: null }],
  config: [{ id: 1, latitude: -23.6, longitude: -46.7, raio_metros: 300, almoco_minimo: 60, ips_galpao: '' }],
  batidas: [], fotos_batida: [], aprovacoes: [], solicitacoes_batida: [],
};
let proxId = 100;
let falharPatch = false;   /* F: o banco recusa a gravação da senha */
let segurarPatch = null;   /* H: o PATCH que GRAVA senha fica preso até alguém soltar (a corrida do Codex #895) */
const chamadas = [];
function filtrar(rows, qs) {
  let out = rows.slice();
  for (const [k, v] of qs) {
    if (k === 'select' || k === 'order') continue;
    const m = /^(eq|ilike|is)\.(.*)$/.exec(v); if (!m) continue;
    out = out.filter((r) => {
      const x = r[k];
      if (m[1] === 'eq') return String(x) === String(m[2]);
      if (m[1] === 'is') return m[2] === 'false' ? !x : m[2] === 'true' ? !!x : x == null;
      if (m[1] === 'ilike') return String(x || '').toLowerCase() === decodeURIComponent(m[2]).toLowerCase();
      return true;
    });
  }
  return out;
}
const resp = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => (body == null ? '' : JSON.stringify(body)) });
async function sbFake(url, opts) {
  const u = new URL(url); const metodo = (opts && opts.method) || 'GET';
  const tabela = u.pathname.replace('/rest/v1/', '');
  const qs = [...u.searchParams.entries()];
  chamadas.push(metodo + ' ' + tabela + (qs.length ? '?' + qs.map(([k, v]) => k + '=' + v).join('&') : ''));
  if (!db[tabela]) return resp(404, { message: 'tabela ' + tabela });
  if (metodo === 'GET') return resp(200, filtrar(db[tabela], qs));
  if (metodo === 'POST') { const b = JSON.parse(opts.body); const row = Object.assign({ id: proxId++ }, tabela === 'funcionarios' ? { ativo: true, senha_hash: null } : {}, b); db[tabela].push(row); return resp(201, [row]); }   /* `ativo` tem default true no banco */
  if (metodo === 'PATCH') { if (falharPatch) return resp(503, { message: 'banco fora' }); if (segurarPatch && /"senha_definida":true/.test(opts.body)) await segurarPatch; const b = JSON.parse(opts.body); const alvo = filtrar(db[tabela], qs); for (const r of alvo) Object.assign(r, b); return resp(200, alvo); }
  return resp(405, {});
}
{ const k = require.resolve('node-fetch'); require.cache[k] = { id: k, filename: k, loaded: true, exports: sbFake }; }

const ponto = require(path.join(raiz, 'ponto', 'index.js'));
const CV = require(path.join(raiz, 'ponto', 'ponto-convites.js'));
const handle = ponto.routes(async (req) => req._corpo || {});
async function pedir(metodo, caminho, corpo, headers) {
  const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b == null ? '' : b); } };
  const u = new URL('http://x' + caminho);
  const tratou = await handle({ method: metodo, url: caminho, headers: Object.assign({}, headers || {}), socket: { remoteAddress: '10.0.0.9' }, _corpo: corpo }, res, u);
  let j = null; try { j = JSON.parse(res._b); } catch (e) {}
  return { tratou, status: res._s, j, corpo: res._b };
}
const ADM = { 'x-admin-token': 'admin-teste-ponto' };
const PNG_1x1 = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(60, 1)]).toString('base64');
const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(40, 2)]).toString('base64');
const WEBP = 'data:image/webp;base64,' + Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(20, 3)]).toString('base64');

(async () => {
  /* ───────── G. a peça de convites, sozinha ───────── */
  {
    let t = 1000; const c = CV.criar({ arquivo: path.join(TMP, 'peca', 'c.json'), agora: () => t });
    const g = c.gerar(7);
    assert.ok(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(g.codigo) && !/[01OIL]/.test(g.codigo), 'código legível, sem 0/1/O/I/L: ' + g.codigo);
    const disco = fs.readFileSync(path.join(TMP, 'peca', 'c.json'), 'utf8');
    assert.ok(!disco.includes(g.codigo.replace('-', '')) && !disco.includes(g.codigo), 'o código EM CLARO não pode estar no disco');
    assert.deepStrictEqual(c.pendente(7), { expira: 1000 + CV.VALIDADE_MS, vencido: false });
    assert.deepStrictEqual(c.consumir(7, ''), { ok: false, motivo: 'sem_codigo' });
    assert.deepStrictEqual(c.consumir(7, 'AAAA-AAAA'), { ok: false, motivo: 'nao_confere' });
    assert.deepStrictEqual(c.consumir(8, g.codigo), { ok: false, motivo: 'sem_convite' }, 'convite é por funcionário');
    assert.ok(c.pendente(7), 'errar o código não apaga o convite');
    assert.deepStrictEqual(c.consumir(7, g.codigo.toLowerCase().replace('-', ' ')), { ok: true, expira: 1000 + CV.VALIDADE_MS }, 'minúsculas e sem o hífen valem');
    assert.deepStrictEqual(c.consumir(7, g.codigo), { ok: false, motivo: 'sem_convite' }, 'uso ÚNICO');
    const g2 = c.gerar(7); t = 1000 + CV.VALIDADE_MS + 1;
    assert.deepStrictEqual(c.consumir(7, g2.codigo), { ok: false, motivo: 'vencido' }, '72 h depois: vencido');
    assert.strictEqual(c.pendente(7), null, 'o vencido saiu do disco');
    const g3 = c.gerar(7); const g4 = c.gerar(7);
    assert.deepStrictEqual(c.consumir(7, g3.codigo), { ok: false, motivo: 'nao_confere' }, 'convite novo substitui o anterior');
    c.devolver(7, g4.codigo, t + 10); assert.deepStrictEqual(c.consumir(7, g4.codigo), { ok: true, expira: t + 10 }, 'devolvido volta a valer, com o vencimento de antes');
    fs.writeFileSync(path.join(TMP, 'peca', 'c.json'), '{corrompido'); assert.deepStrictEqual(c.consumir(7, g4.codigo), { ok: false, motivo: 'sem_convite' }, 'arquivo corrompido = sem convite (não explode)');
    assert.ok(!fs.readdirSync(path.join(TMP, 'peca')).some((f) => f.includes('.tmp-')), 'a gravação é atômica (sem temporário sobrando)');
    assert.throws(() => CV.criar({}), /falta o arquivo/);
  }

  /* ───────── D. cadastrar devolve o convite; criar-senha exige o código ───────── */
  const cad = await pedir('POST', '/ponto/admin/funcionarios', { nome: 'Maria', matricula: '8', email: 'maria@galpao.local' }, ADM);
  assert.ok(cad.status === 200 && cad.j && cad.j.id && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(cad.j.convite || '') && cad.j.convite_expira, 'o cadastro devolve o código de convite pro gestor: ' + cad.corpo.slice(0, 200));
  const idMaria = cad.j.id, codMaria = cad.j.convite;
  let r = await pedir('POST', '/ponto/login', { email: 'maria@galpao.local' });
  assert.deepStrictEqual([r.status, r.j.precisa_criar_senha], [200, true], 'o login diz que precisa criar senha');
  r = await pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: '1234' });
  assert.ok(r.status === 403 && r.j.motivo === 'sem_codigo' && !db.funcionarios.find((f) => f.id === idMaria).senha_definida, 'SEM código não cria senha — era o P1: só o e-mail bastava');
  r = await pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: '1234', codigo: 'ZZZZ-ZZZZ' });
  assert.ok(r.status === 403 && r.j.motivo === 'nao_confere', 'código errado: recusado');
  r = await pedir('POST', '/ponto/criar-senha', { email: 'ze@galpao.local', senha: '1234', codigo: codMaria });
  assert.ok(r.status === 403 && r.j.motivo === 'sem_convite', 'o código da Maria não serve pro Zé (sem convite pendente)');
  /* F: o banco falha na gravação — o convite volta */
  falharPatch = true;
  r = await pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: '1234', codigo: codMaria });
  assert.ok(r.status >= 500, 'banco fora: erro, não sucesso (' + r.status + ')');
  falharPatch = false;
  r = await pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: '1234', codigo: codMaria });
  assert.ok(r.status === 200 && r.j.ok && r.j.token, 'depois da falha do banco o MESMO código ainda vale (foi devolvido): ' + r.corpo.slice(0, 120));
  const tokenMaria1 = r.j.token;
  assert.ok(db.funcionarios.find((f) => f.id === idMaria).senha_definida === true);
  r = await pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: '9999', codigo: codMaria });
  assert.strictEqual(r.status, 409, 'senha já criada: 409 (e o código já morreu de qualquer jeito)');
  r = await pedir('POST', '/ponto/login', { email: 'maria@galpao.local', senha: '1234' });
  assert.ok(r.status === 200 && r.j.token, 'login com a senha criada');
  { const l = await pedir('POST', '/ponto/minhas-batidas', { token: r.j.token }); assert.strictEqual(l.status, 200, 'o token do LOGIN também vale (leva a versão da senha certa)'); }
  { const disco = JSON.parse(fs.readFileSync(path.join(TMP, '_convites.json'), 'utf8')); assert.ok(!disco[String(idMaria)], 'depois de criar a senha o convite SAIU do disco (consumido antes de gravar, não devolvido no sucesso)'); }
  r = await pedir('POST', '/ponto/minhas-batidas', { token: tokenMaria1 });
  assert.strictEqual(r.status, 200, 'a sessão do criar-senha vale');

  /* ───────── E. reset: convite novo, sessão antiga morre, token antigo (sem versão) não entra ───────── */
  const rs = await pedir('POST', '/ponto/admin/funcionarios/' + idMaria + '/reset-senha', {}, ADM);
  assert.ok(rs.status === 200 && /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rs.j.convite || '') && rs.j.convite !== codMaria, 'o reset devolve um convite NOVO');
  r = await pedir('POST', '/ponto/minhas-batidas', { token: tokenMaria1 });
  assert.strictEqual(r.status, 401, 'depois do reset, a sessão antiga NÃO entra (antes durava 30 dias)');
  r = await pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: '5678', codigo: codMaria });
  assert.ok(r.status === 403 && r.j.motivo === 'nao_confere', 'o convite antigo não vale depois do reset');
  r = await pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: '5678', codigo: rs.j.convite });
  assert.ok(r.status === 200 && r.j.token, 'com o convite novo, senha nova');
  let tokenMaria2 = r.j.token;
  {   /* token no formato ANTIGO (id.exp sem versão), assinado com o segredo certo: não entra */
    const p = idMaria + '.' + (Date.now() + 3600000);
    const sig = crypto.createHmac('sha256', 'segredo-teste').update(p).digest('hex');
    const velho = Buffer.from(p).toString('base64') + '.' + sig;
    r = await pedir('POST', '/ponto/minhas-batidas', { token: velho });
    assert.strictEqual(r.status, 401, 'token do formato antigo (sem a versão da senha) não entra');
    /* e um token forjado com versão errada também não */
    const p2 = idMaria + '.' + (Date.now() + 3600000) + '.000000000000';
    const sig2 = crypto.createHmac('sha256', 'segredo-teste').update(p2).digest('hex');
    r = await pedir('POST', '/ponto/minhas-batidas', { token: Buffer.from(p2).toString('base64') + '.' + sig2 });
    assert.strictEqual(r.status, 401, 'versão da senha errada não entra');
    /* assinatura errada com o payload CERTO (copiado do token válido): não entra */
    const [b64ok] = tokenMaria2.split('.');
    r = await pedir('POST', '/ponto/minhas-batidas', { token: b64ok + '.' + crypto.createHmac('sha256', 'outro-segredo').update(Buffer.from(b64ok, 'base64').toString()).digest('hex') });
    assert.strictEqual(r.status, 401, 'assinatura com outro segredo não entra');
  }
  /* ───────── H. a corrida do Codex #895: criar-senha com o PATCH preso + reset no meio ───────── */
  {
    const rs2 = await pedir('POST', '/ponto/admin/funcionarios/' + idMaria + '/reset-senha', {}, ADM);
    assert.strictEqual(rs2.status, 200);
    let soltar; segurarPatch = new Promise((ok) => { soltar = ok; });
    const emCurso = pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: 'abcd', codigo: rs2.j.convite });
    await new Promise((ok) => setTimeout(ok, 20));   /* o criar-senha já consumiu o convite e está esperando o banco */
    const rs3 = await pedir('POST', '/ponto/admin/funcionarios/' + idMaria + '/reset-senha', {}, ADM);
    assert.deepStrictEqual([rs3.status, rs3.j.motivo], [409, 'em_curso'], 'reset DURANTE a criação da senha tem que esperar (409) — senão o PATCH atrasado desfaz o reset (Codex #895)');
    soltar(); segurarPatch = null;
    const fim = await emCurso;
    assert.ok(fim.status === 200 && fim.j.token, 'a criação em curso termina normalmente');
    const rs4 = await pedir('POST', '/ponto/admin/funcionarios/' + idMaria + '/reset-senha', {}, ADM);
    assert.strictEqual(rs4.status, 200, 'depois que a criação terminou, o reset volta a funcionar');
    r = await pedir('POST', '/ponto/minhas-batidas', { token: fim.j.token }); assert.strictEqual(r.status, 401, 'e derruba a sessão que acabou de nascer');
    /* duas criações ao mesmo tempo com o mesmo convite: a segunda espera (409), a primeira vence */
    segurarPatch = new Promise((ok) => { soltar = ok; });
    const c1 = pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: 'abcd', codigo: rs4.j.convite });
    await new Promise((ok) => setTimeout(ok, 20));
    const c2 = await pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: 'efgh', codigo: rs4.j.convite });
    assert.deepStrictEqual([c2.status, c2.j.motivo], [409, 'em_curso'], 'segunda criação ao mesmo tempo: 409');
    soltar(); segurarPatch = null;
    const c1r = await c1; assert.ok(c1r.status === 200 && c1r.j.token);
    r = await pedir('POST', '/ponto/login', { email: 'maria@galpao.local', senha: 'abcd' }); assert.strictEqual(r.status, 200, 'vale a senha da criação que entrou primeiro');
    /* a trava é SOLTA no fim (sucesso ou erro): o reset normal volta a valer pros passos seguintes */
    const rs5 = await pedir('POST', '/ponto/admin/funcionarios/' + idMaria + '/reset-senha', {}, ADM); assert.strictEqual(rs5.status, 200);
    r = await pedir('POST', '/ponto/criar-senha', { email: 'maria@galpao.local', senha: '5678', codigo: rs5.j.convite }); assert.ok(r.status === 200 && r.j.token, 'depois da corrida, criar senha volta ao normal: ' + r.corpo.slice(0, 100));
    tokenMaria2 = r.j.token;
  }
  /* reset sem ser admin: não */
  r = await pedir('POST', '/ponto/admin/funcionarios/' + idMaria + '/reset-senha', {});
  assert.strictEqual(r.status, 401);

  /* ───────── A. a foto na batida: só imagem de verdade ───────── */
  /* cada tentativa é a ENTRADA de um dia limpo (são 4 batidas por dia; limpar evita o 409 do 5º ponto) */
  const bater = (foto) => { db.batidas.length = 0; return pedir('POST', '/ponto/bater-ponto', { token: tokenMaria2, latitude: -23.6, longitude: -46.7, foto }); };
  const ANTES = db.fotos_batida.length;
  r = await bater('data:image/x" onerror="alert(1)');
  assert.ok(r.status === 200 && r.j.ok, 'a batida entra mesmo sem foto válida (a foto é best-effort): ' + r.corpo.slice(0, 120));
  let ult = db.batidas[db.batidas.length - 1];
  assert.deepStrictEqual([ult.tem_foto, ult.foto_pulada, db.fotos_batida.length], [false, true, ANTES], 'o payload da auditoria é recusado: tem_foto=false, foto_pulada=true, nada gravado em fotos_batida');
  for (const ruim of ['data:image/svg+xml;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64'), 'data:image/png;base64,' + Buffer.alloc(40, 7).toString('base64') /* diz PNG, não é */,
    'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4E, 0x47]).toString('base64') /* curto demais */, 'data:image/png;base64,abc$%^', 'data:text/html;base64,PGI+', 'https://x/y.png', 42, { a: 1 },
    'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF]).toString('base64') /* assinatura certa, 3 bytes: curto demais */,
    'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0x00, 0x11, 0x22, 0x33]), Buffer.alloc(40, 2)]).toString('base64') /* diz JPEG, não é */,
    'data:image/webp;base64,' + Buffer.concat([Buffer.from('RIFX'), Buffer.alloc(4, 0), Buffer.from('WEBX'), Buffer.alloc(20, 3)]).toString('base64') /* diz WEBP, não é */,
    'data:image/gif;base64,' + Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(30, 4)]).toString('base64') /* GIF não é aceito (não é raster do celular) */,
    PNG_1x1 + '" onerror="alert(1)' /* PNG válido com HTML colado no fim: a regex tem que ir até o FIM */]) {
    r = await bater(ruim);
    ult = db.batidas[db.batidas.length - 1];
    assert.ok(r.status === 200 && ult.tem_foto === false && db.fotos_batida.length === ANTES, 'tinha que recusar a foto: ' + String(ruim).slice(0, 40));
  }
  for (const boa of [PNG_1x1, JPEG, WEBP]) {
    r = await bater(boa);
    ult = db.batidas[db.batidas.length - 1];
    assert.ok(r.status === 200 && ult.tem_foto === true && db.fotos_batida[db.fotos_batida.length - 1].imagem === boa, 'imagem válida tinha que entrar: ' + boa.slice(0, 30));
  }
  r = await bater('data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(400 * 1024, 1)]).toString('base64'));
  assert.ok(r.status === 200 && db.batidas[db.batidas.length - 1].tem_foto === false, 'acima do teto de bytes: pulada');

  /* ───────── B. o que já estava guardado e não é imagem não é servido ───────── */
  db.fotos_batida.push({ id: 900, batida_id: 900, imagem: 'data:image/x" onerror="alert(1)', criado_em: '2026-11-01' });
  r = await pedir('GET', '/ponto/admin/foto/900', null, ADM);
  assert.ok(r.status === 404 && !r.corpo.includes('onerror'), 'foto guardada ANTES da validação, inválida: 404, e o conteúdo não sai: ' + r.corpo.slice(0, 100));
  const boaId = db.fotos_batida.find((f) => f.imagem === JPEG).batida_id;
  r = await pedir('GET', '/ponto/admin/foto/' + boaId, null, ADM);
  assert.ok(r.status === 200 && r.j.imagem === JPEG, 'foto válida é servida');
  r = await pedir('GET', '/ponto/admin/foto/' + boaId, null, {});
  assert.strictEqual(r.status, 401, 'foto só pro gestor');

  /* ───────── C. o painel não interpola a imagem nem campos de gente ───────── */
  const adm = fs.readFileSync(path.join(raiz, 'public', 'ponto', 'admin.html'), 'utf8');
  assert.ok(!/<img src="\$\{/.test(adm) && !/img=`<img/.test(adm), 'o painel ainda monta <img> por interpolação de string');
  assert.ok(/im\.src=imagem/.test(adm) && /FOTO_OK\.test\(j\.imagem\)/.test(adm), 'o painel monta a imagem por propriedade e só aceita data URI de imagem');
  assert.ok(!/\$\{j\.ip_atual\}/.test(adm) && !/\$\{l\.observacao\|\|/.test(adm) && !/<code class="tagb">\$\{ip\}/.test(adm), 'campos vindos de fora passam por esc()');
  assert.ok(!/resetSenha\(\$\{f\.id\},'/.test(adm), 'o nome não vai mais dentro do onclick');
  assert.ok(/id="conviteBox"/.test(adm) && /mostrarConvite\(body\.nome, j\)/.test(adm) && /carregarFuncionarios\(\); mostrarConvite\(nome, j\);/.test(adm), 'o gestor vê o código de convite na tela — no cadastro E no reset');
  const idx = fs.readFileSync(path.join(raiz, 'public', 'ponto', 'index.html'), 'utf8');
  assert.ok(/id="codigoAcesso"/.test(idx) && /senha:s1, codigo\}/.test(idx), 'a tela do funcionário pede e manda o código');

  console.log('ok — Ponto: foto só entra (e só sai) se for imagem de verdade; o painel não interpola conteúdo de gente; a primeira senha e o reset exigem o código de convite (uso único, 72 h, devolvido se o banco falhar); o reset derruba as sessões antigas; token sem versão não entra');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
