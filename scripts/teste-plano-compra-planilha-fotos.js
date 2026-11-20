'use strict';
/* 20/11 — PLANO DE COMPRA: A PLANILHA COM A FOTO DO PRODUTO EM CADA LINHA (pedido do dono):
   "podia deixar a planilha igual é hoje, mas adicionar uma imagemzinha, algo de 300x300px em cada linha... colocar entre
   B e C coluna a imagem". E o aviso do Excel em toda abertura ("o formato de arquivo e a extensão... não correspondem"):
   a planilha era um XML com nome .xls; agora é .xlsx de verdade.

   O que se prova (o código de produção):
   A. a peça que escreve o .xlsx (lib/checkout/painel/planilha-xlsx-fotos): o arquivo é um zip íntegro com as partes que o
      Excel exige; número é número e texto é texto (nunca fórmula); a foto de cada linha fica presa à célula DA LINHA
      DELA, na coluna pedida, no tamanho pedido; linha sem foto não quebra nem desloca as outras;
   B. a busca das fotos: poucas por vez, na ordem, e foto que falha vira "sem foto" — não derruba a planilha;
   C. a rota que serve a foto (lib/checkout/rota-plano-foto): só admin, só pelo SKU, e só busca endereço https de máquina
      de verdade (nada de IP, localhost, nome interno — nem por redirecionamento), só imagem, com teto de tamanho;
   D. o botão "baixar planilha", com o script de produção num navegador de mentira: 15 colunas (as 14 de sempre + a Foto
      na C), arquivo .xlsx, e se a planilha com fotos falhar sai a antiga — nunca fica sem planilha;
   E. a fábrica entrega as duas peças no mesmo script, nas três empresas. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const raiz = path.join(__dirname, '..');
const X = require('../lib/checkout/painel/planilha-xlsx-fotos');

const jpeg = (n) => { const b = new Uint8Array(40 + n); b[0] = 0xFF; b[1] = 0xD8; for (let i = 2; i < b.length; i++) b[i] = (i * 7 + n) & 0xFF; return b; };
const CAB = ['SKU', 'Produto', 'Foto', 'Imagem (URL)', 'Curva', 'Vendidas', 'Media'];
const LINHAS = [['KP5', 'Kit & <b>"aspas"</b>', '', 'https://x/a.jpg', 'A', 120, 1.33], ['=CMD()', 'parece fórmula\u0001', '', '', 'B', 40, ''], ['G12', 'Globo', '', 'https://x/c.jpg', 'A', 0, 0.9], ['SEM', null, '', '', 'C', -3, 2e-7]];

(async () => {
  /* ═══ A. o .xlsx ═══ */
  {
    const fotos = [{ bytes: jpeg(1), w: 300, h: 300 }, null, { bytes: jpeg(3), w: 140, h: 300 }, null];
    const bytes = X.montar({ cab: CAB, linhas: LINHAS, colFoto: 2, fotos, lado: 300 });
    assert.ok(bytes instanceof Uint8Array && bytes[0] === 0x50 && bytes[1] === 0x4B, 'não é um zip');
    const z = new AdmZip(Buffer.from(bytes));
    const nomes = z.getEntries().map((e) => e.entryName);
    assert.deepStrictEqual(nomes, ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml',
      'xl/worksheets/_rels/sheet1.xml.rels', 'xl/drawings/drawing1.xml', 'xl/drawings/_rels/drawing1.xml.rels', 'xl/media/image1.jpeg', 'xl/media/image2.jpeg'], 'as partes do .xlsx: ' + nomes.join(', '));
    const le = (n) => z.readAsText(n);   /* o adm-zip confere o CRC de cada parte ao ler */
    for (const n of nomes) assert.ok(z.getEntry(n).getData().length > 0, n + ' vazio ou com CRC errado');
    assert.deepStrictEqual([Buffer.compare(z.getEntry('xl/media/image1.jpeg').getData(), Buffer.from(jpeg(1))), Buffer.compare(z.getEntry('xl/media/image2.jpeg').getData(), Buffer.from(jpeg(3)))], [0, 0], 'os bytes da foto têm que chegar inteiros');
    const tipos = le('[Content_Types].xml');
    assert.ok(/Extension="jpeg" ContentType="image\/jpeg"/.test(tipos) && /\/xl\/drawings\/drawing1\.xml/.test(tipos) && /spreadsheetml\.sheet\.main\+xml/.test(tipos) && /\/xl\/styles\.xml/.test(tipos));
    assert.ok(/<cellStyle name="Normal"/.test(le('xl/styles.xml')), 'sem o estilo Normal o Excel reclama do arquivo');
    const f = le('xl/worksheets/sheet1.xml');
    for (const n of nomes.filter((x) => /\.xml$|\.rels$/.test(x))) { const t = le(n); assert.ok(t.startsWith('<?xml version="1.0" encoding="UTF-8"') && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t), n + ': cabeçalho ou caractere proibido'); }
    /* cabeçalho, congelado; número é número; texto é texto — inclusive o que parece fórmula */
    assert.ok(/<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/.test(f), 'a linha de títulos não fica presa');
    assert.ok(/<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">SKU<\/t>/.test(f) && /<c r="C1" s="1" t="inlineStr"><is><t xml:space="preserve">Foto<\/t>/.test(f));
    assert.ok(/<c r="F2" s="2"><v>120<\/v><\/c><c r="G2" s="2"><v>1\.33<\/v><\/c>/.test(f), 'número tem que ir como número: ' + f.slice(f.indexOf('<row r="2"'), f.indexOf('<row r="3"')));
    assert.ok(/<c r="F4" s="2"><v>0<\/v><\/c>/.test(f) && /<c r="F5" s="2"><v>-3<\/v><\/c><c r="G5" s="2"><v>2e-7<\/v><\/c>/.test(f), 'zero e negativo são números (zero não é "vazio")');
    assert.ok(/<c r="A3" s="2" t="inlineStr"><is><t xml:space="preserve">=CMD\(\)<\/t>/.test(f) && !/<f>/.test(f), 'texto que parece fórmula vai como TEXTO');
    assert.ok(/Kit &amp; &lt;b&gt;&quot;aspas&quot;&lt;\/b&gt;/.test(f) && /parece fórmula<\/t>/.test(f), 'o texto vai escapado e sem caractere de controle');
    assert.ok(/<c r="G3" s="2"\/>/.test(f) && /<c r="B5" s="2"\/>/.test(f), 'vazio e nulo viram célula vazia');
    for (const r of [2, 3, 4, 5]) assert.ok(new RegExp('<c r="C' + r + '" s="2"/>').test(f), 'a célula da foto fica vazia (a imagem vai por cima): C' + r);
    assert.ok(/<row r="2" ht="231" customHeight="1">/.test(f) && /<row r="5" ht="231" customHeight="1">/.test(f) && /<col min="3" max="3" width="44" customWidth="1"\/>/.test(f), 'a linha e a coluna têm o tamanho da foto (300 px + folga)');
    assert.ok(/<drawing r:id="rId1"\/><\/worksheet>$/.test(f) && /drawing1\.xml/.test(le('xl/worksheets/_rels/sheet1.xml.rels')));
    /* cada foto na linha DELA (a 1ª na linha 2 da planilha; a 3ª na linha 4), coluna C, do tamanho que veio, centrada */
    const d = le('xl/drawings/drawing1.xml');
    const ancoras = [...d.matchAll(/<xdr:col>(\d+)<\/xdr:col><xdr:colOff>(\d+)<\/xdr:colOff><xdr:row>(\d+)<\/xdr:row><xdr:rowOff>(\d+)<\/xdr:rowOff><\/xdr:from><xdr:ext cx="(\d+)" cy="(\d+)"\/>.*?r:embed="(rId\d+)"/g)].map((m) => m.slice(1, 8).map((v) => (/^\d+$/.test(v) ? Number(v) : v)));
    assert.deepStrictEqual(ancoras, [[2, 4 * 9525, 1, 4 * 9525, 300 * 9525, 300 * 9525, 'rId1'], [2, 84 * 9525, 3, 4 * 9525, 140 * 9525, 300 * 9525, 'rId2']], 'as fotos, cada uma na célula da linha dela: ' + JSON.stringify(ancoras));
    const rd = le('xl/drawings/_rels/drawing1.xml.rels');
    assert.ok(/Id="rId1"[^>]*Target="\.\.\/media\/image1\.jpeg"/.test(rd) && /Id="rId2"[^>]*Target="\.\.\/media\/image2\.jpeg"/.test(rd));

    /* o que vier escrito na coluna da foto não aparece: a célula é da imagem */
    const comTexto = new AdmZip(Buffer.from(X.montar({ cab: CAB, linhas: [['A', 'B', 'texto na coluna da foto', 'u', 'A', 1, 2]], colFoto: 2, fotos: [{ bytes: jpeg(1), w: 10, h: 10 }] }))).readAsText('xl/worksheets/sheet1.xml');
    assert.ok(/<c r="C2" s="2"\/>/.test(comTexto) && !/texto na coluna da foto/.test(comTexto) && /<c r="C1" s="1" t="inlineStr">/.test(comTexto), 'a célula da foto fica vazia mesmo se a linha trouxer texto ali (o título da coluna fica)');
    /* sem foto nenhuma: planilha normal, sem as partes de desenho e sem linhas altas */
    for (const semFotos of [[], [null, null, null, null], undefined, [{ bytes: new Uint8Array(0), w: 10, h: 10 }, { bytes: jpeg(1), w: 0, h: 10 }, { w: 10, h: 10 }, { bytes: jpeg(1), w: 10 }]]) {
      const z2 = new AdmZip(Buffer.from(X.montar({ cab: CAB, linhas: LINHAS, colFoto: 2, fotos: semFotos })));
      const n2 = z2.getEntries().map((e) => e.entryName);
      assert.ok(!n2.some((n) => /drawing|media/.test(n)) && n2.length === 6, 'foto que não é foto não entra: ' + n2.join(', '));
      const f2 = z2.readAsText('xl/worksheets/sheet1.xml');
      assert.ok(!/<drawing/.test(f2) && /<row r="2">/.test(f2) && !/jpeg/.test(z2.readAsText('[Content_Types].xml')) && /<c r="F2" s="2"><v>120<\/v>/.test(f2));
    }
    /* coluna da foto inválida: sai a planilha, sem foto */
    for (const col of [undefined, -1, 99, 1.5, 'x']) assert.ok(!new AdmZip(Buffer.from(X.montar({ cab: CAB, linhas: LINHAS, colFoto: col, fotos }))).getEntries().some((e) => /media/.test(e.entryName)), 'colFoto ' + col);
    /* foto maior que o quadrado é presa ao quadrado; lado diferente muda linha e coluna */
    const d3 = new AdmZip(Buffer.from(X.montar({ cab: CAB, linhas: LINHAS.slice(0, 1), colFoto: 2, fotos: [{ bytes: jpeg(1), w: 900, h: 450.4 }], lado: 100 })));
    assert.ok(/<xdr:ext cx="952500" cy="952500"\/>/.test(d3.readAsText('xl/drawings/drawing1.xml')) && /<row r="2" ht="81" customHeight="1">/.test(d3.readAsText('xl/worksheets/sheet1.xml')), 'a foto não passa do quadrado pedido');
    assert.deepStrictEqual([X.letra(0), X.letra(25), X.letra(26), X.letra(27), X.letra(701), X.letra(702)], ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
    assert.strictEqual(X.crc32(new Uint8Array([49, 50, 51, 52, 53, 54, 55, 56, 57])), 0xCBF43926, 'CRC-32 de "123456789"');
    assert.ok(new AdmZip(Buffer.from(X.montar({ cab: [], linhas: [] }))).getEntries().length === 6, 'planilha vazia ainda é um arquivo válido');
  }

  /* ═══ B. a busca das fotos ═══ */
  {
    let juntas = 0, pico = 0; const pedidas = []; const avancos = [];
    const buscar = async (u) => { pedidas.push(u); juntas++; pico = Math.max(pico, juntas); await new Promise((r) => setTimeout(r, 3)); juntas--;
      if (/erro/.test(u)) throw new Error('rede'); if (/404/.test(u)) return { ok: false, blob: async () => 'x' }; return { ok: true, blob: async () => 'blob:' + u }; };
    const encolher = async (b, lado) => { if (/quebra/.test(b)) throw new Error('não é imagem'); if (/lixo/.test(b)) return { bytes: new Uint8Array(0), w: 1, h: 1 }; return { bytes: jpeg(1), w: lado, h: lado - 1, de: b }; };
    const ends = ['a', '', 'erro1', '404x', 'quebra', 'lixo', 'b', 'c', 'd', 'e', 'f', 'g'];
    const fotos = await X.baixarFotos(ends, { fetch: buscar, encolher, lado: 300, simultaneas: 3, aoAvancar: (f, t) => avancos.push(f + '/' + t) });
    assert.deepStrictEqual(fotos.map((f) => (f ? f.de : null)), ['blob:a', null, null, null, null, null, 'blob:b', 'blob:c', 'blob:d', 'blob:e', 'blob:f', 'blob:g'], 'cada foto na posição da linha dela; a que falhou vira null');
    assert.deepStrictEqual([fotos[0].w, fotos[0].h], [300, 299]);
    assert.ok(!pedidas.includes('') && pedidas.length === 11, 'linha sem endereço de foto não vai ao servidor');
    assert.ok(pico <= 3 && pico >= 2, 'poucas por vez (pediu 3): pico ' + pico);
    assert.deepStrictEqual([avancos.length, avancos[avancos.length - 1]], [12, '12/12'], 'o andamento conta todas as linhas');
    assert.deepStrictEqual(await X.baixarFotos([], { fetch: buscar, encolher }), []);
    let p2 = 0, j2 = 0; await X.baixarFotos(Array(30).fill('z'), { fetch: async () => { j2++; p2 = Math.max(p2, j2); await new Promise((r) => setTimeout(r, 1)); j2--; return { ok: true, blob: async () => 'b' }; }, encolher, simultaneas: 99 });
    assert.ok(p2 <= 8, 'o pedido de simultâneas tem teto: ' + p2);
    const estoura = await X.baixarFotos(['a'], { fetch: buscar, encolher, aoAvancar: () => { throw new Error('tela sumiu'); } });
    assert.ok(estoura[0], 'erro em quem mostra o andamento não derruba a busca');
  }

  /* ═══ C. a rota da foto ═══ */
  const chamadas = [];
  let roteiro = {};
  const nfetch = require.resolve('node-fetch');
  const resp = (st, tipo, corpo, extra) => ({ status: st, headers: { get: (h) => Object.assign({ 'content-type': tipo, 'content-length': corpo ? String(corpo.length) : null }, extra || {})[h.toLowerCase()] || null }, arrayBuffer: async () => { const b = Buffer.from(corpo || ''); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  require.cache[nfetch] = { id: nfetch, filename: nfetch, loaded: true, exports: async (url, opts) => { chamadas.push([String(url), opts && opts.redirect]); const r = roteiro[String(url)]; if (!r) throw new Error('rede bloqueada no teste: ' + url); if (r === 'TRAVA') return new Promise((ok, erro) => { opts.signal.addEventListener('abort', () => erro(new Error('abortado'))); }); return typeof r === 'function' ? r() : r; } };
  for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
  global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
  const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'plano-fotos-'));
  process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });
  process.env.ADMIN_KEY = 'chave-foto';
  for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; fs.mkdirSync(path.join(PASTAS, e), { recursive: true }); }
  const F = require('../lib/checkout/rota-plano-foto');
  const CE = require('../lib/checkout/config-empresa');
  {
    for (const ok of ['https://img.exemplo.com.br/a.jpg', 'https://s3.amazonaws.com/b/c.png?x=1', 'https://LH3.googleusercontent.com/d', 'https://a.b:443/c', ' https://a.bc/d ']) assert.ok(F.enderecoPermitido(ok), 'devia poder: ' + ok);
    for (const nao of ['http://img.exemplo.com.br/a.jpg', 'ftp://a.bc/d', 'file:///etc/passwd', 'https://localhost/a', 'https://bling/a', 'https://127.0.0.1/a', 'https://10.0.0.5/a', 'https://169.254.169.254/latest', 'https://[::1]/a',
      'https://[fd00::1]/a', 'https://servico.internal/a', 'https://impressora.local/a', 'https://a.localhost/x', 'https://user:senha@a.bc/d', 'https://a.bc:8443/d', 'https://2130706433/a', 'https://0x7f000001/a', 'https://a.0x7f/b', 'https://a.b.123/c',
      'javascript:alert(1)', 'data:image/png;base64,AAAA', '', null, undefined, 'não é endereço', '//a.bc/d', 'https://a.corp/x', 'https://x.test/y']) assert.strictEqual(F.enderecoPermitido(nao), null, 'NÃO devia poder: ' + nao);
  }
  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    for (const emp of ['girassol', 'amb', 'good']) {
      const pref = CE.prefixoDe(emp);
      const cache = { 'KP5': { img: 'https://img.exemplo.com.br/kp5.jpg', saldo: 3 }, 'SEM': { saldo: 1 }, 'RUIM': { img: 'http://10.0.0.1/a.jpg' }, 'A B/Ç': { img: 'https://img.exemplo.com.br/ab.png' }, 'VOLTA': { img: 'https://img.exemplo.com.br/vai' },
        'INTERNO': { img: 'https://img.exemplo.com.br/pra-dentro' }, 'HTML': { img: 'https://img.exemplo.com.br/pagina' }, 'SVG': { img: 'https://img.exemplo.com.br/desenho.svg' }, 'GRANDE': { img: 'https://img.exemplo.com.br/grande' }, 'MENTE': { img: 'https://img.exemplo.com.br/mente' },
        'CAIU': { img: 'https://img.exemplo.com.br/caiu' }, 'E500': { img: 'https://img.exemplo.com.br/e500' }, 'VAZIA': { img: 'https://img.exemplo.com.br/vazia' }, 'RODA': { img: 'https://img.exemplo.com.br/r0' }, 'LENTA': { img: 'https://img.exemplo.com.br/lenta' } };
      roteiro = { 'https://img.exemplo.com.br/kp5.jpg': resp(200, 'image/jpeg; charset=binary', Buffer.from(jpeg(5))), 'https://img.exemplo.com.br/ab.png': resp(200, 'IMAGE/PNG', Buffer.from('png!')),
        'https://img.exemplo.com.br/vai': resp(302, '', '', { location: '/final.jpg' }), 'https://img.exemplo.com.br/final.jpg': resp(301, '', '', { location: 'https://cdn.outro.com/f.webp' }), 'https://cdn.outro.com/f.webp': resp(200, 'image/webp', Buffer.from('webp')),
        'https://img.exemplo.com.br/pra-dentro': resp(302, '', '', { location: 'http://169.254.169.254/latest/meta-data' }), 'https://img.exemplo.com.br/pagina': resp(200, 'text/html', Buffer.from('<html>')), 'https://img.exemplo.com.br/desenho.svg': resp(200, 'image/svg+xml', Buffer.from('<svg/>')),
        'https://img.exemplo.com.br/grande': resp(200, 'image/jpeg', Buffer.from('x'), { 'content-length': '999999999' }), 'https://img.exemplo.com.br/mente': resp(200, 'image/jpeg', Buffer.alloc(300), { 'content-length': '10' }),
        'https://img.exemplo.com.br/e500': resp(500, 'image/jpeg', Buffer.from('x')), 'https://img.exemplo.com.br/vazia': resp(200, 'image/jpeg', Buffer.alloc(0)), 'https://img.exemplo.com.br/lenta': 'TRAVA',
        'https://img.exemplo.com.br/r0': resp(302, '', '', { location: '/r1' }), 'https://img.exemplo.com.br/r1': resp(302, '', '', { location: '/r2' }), 'https://img.exemplo.com.br/r2': resp(302, '', '', { location: '/r3' }), 'https://img.exemplo.com.br/r3': resp(302, '', '', { location: '/r4' }), 'https://img.exemplo.com.br/r4': resp(200, 'image/jpeg', Buffer.from('x')) };
      let leituras = 0;
      const rota = F.criar({ empresa: emp, tetoBytes: 200, prazoMs: 40, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '', validarSessao: (c) => (c === 'adm' ? { admin: true } : (c === 'est' ? { admin: false } : null)), ehAdmin: (s) => !!s.admin,
        lerCacheDeProdutos: () => { leituras++; return cache; } });
      const pedir = async (qs, cookie) => { const u = new URL('http://x' + pref + '/plano-compra/foto' + qs); const res = { _s: 0, _o: null, _h: null, _b: null, writeHead(s, h) { this._s = s; this._h = h; }, end(b) { this._b = b; } }; const t = await rota({ method: 'GET', headers: { cookie } }, res, u, 'GET', u.pathname); return Object.assign(res, { _t: t }); };
      assert.strictEqual(F.atende(pref, 'POST', pref + '/plano-compra/foto'), false); assert.strictEqual(F.atende(pref, 'GET', pref + '/plano-compra'), false);
      /* só admin (chave ou sessão); o estoquista logado não busca */
      chamadas.length = 0;
      for (const [qs, ck] of [['?sku=KP5', undefined], ['?sku=KP5&k=errada', undefined], ['?sku=KP5', 'est']]) { const r = await pedir(qs, ck); assert.deepStrictEqual([r._s, r._o], [404, { error: 'not found' }], emp + ': sem ser admin'); }
      assert.deepStrictEqual([chamadas.length, leituras], [0, 0], emp + ': sem credencial não lê o cache nem vai à rede');
      const r1 = await pedir('?sku=KP5', 'adm');
      assert.deepStrictEqual([r1._t, r1._s, r1._h['Content-Type'], r1._h['Content-Length'], r1._h['X-Content-Type-Options'], Buffer.compare(r1._b, Buffer.from(jpeg(5)))], [true, 200, 'image/jpeg', 45, 'nosniff', 0], emp + ': a foto, pelos bytes');
      assert.deepStrictEqual(chamadas, [['https://img.exemplo.com.br/kp5.jpg', 'manual']], emp + ': busca o endereço que o PLANO guardou, sem seguir redirecionamento sozinho');
      assert.strictEqual((await pedir('?k=chave-foto&sku=' + encodeURIComponent('A B/Ç')))._h['Content-Type'], 'image/png', emp + ': pela chave, SKU com espaço/barra/acento');
      /* o que não é foto pra buscar: cada um com a sua resposta, sem ir à rede */
      chamadas.length = 0;
      for (const [qs, st, re] of [['', 400, /use \?sku=/], ['?sku=', 400, /use \?sku=/], ['?sku=' + 'x'.repeat(121), 400, /use \?sku=/], ['?sku=NAOEXISTE', 404, /sem foto guardada/], ['?sku=SEM', 404, /sem foto guardada/],
        ['?sku=__proto__', 404, /sem foto guardada/], ['?sku=constructor', 404, /sem foto guardada/], ['?sku=RUIM', 422, /não pode ser buscado/]]) {
        const r = await pedir(qs, 'adm'); assert.ok(r._s === st && r._o.ok === false && re.test(r._o.erro), emp + ': ' + qs + ' → ' + r._s + ' ' + JSON.stringify(r._o));
      }
      assert.strictEqual(chamadas.length, 0, emp + ': SKU sem foto ou com endereço proibido não vai à rede');
      /* quem chama NÃO escolhe o endereço */
      const inj = await pedir('?sku=NAOEXISTE&u=https://img.exemplo.com.br/kp5.jpg&url=https://img.exemplo.com.br/kp5.jpg&img=https://img.exemplo.com.br/kp5.jpg', 'adm');
      assert.deepStrictEqual([inj._s, chamadas.length], [404, 0], emp + ': endereço passado por quem chama é ignorado');
      /* redirecionamento: seguido à mão, cada salto pelas mesmas regras */
      chamadas.length = 0;
      const rv = await pedir('?sku=VOLTA', 'adm');
      assert.deepStrictEqual([rv._s, rv._h['Content-Type'], chamadas.map((c) => c[0])], [200, 'image/webp', ['https://img.exemplo.com.br/vai', 'https://img.exemplo.com.br/final.jpg', 'https://cdn.outro.com/f.webp']]);
      chamadas.length = 0;
      const ri = await pedir('?sku=INTERNO', 'adm');
      assert.ok(ri._s === 502 && /redirecionamento/.test(ri._o.erro) && chamadas.length === 1, emp + ': redirecionamento pra dentro da rede NÃO é seguido: ' + JSON.stringify(chamadas));
      chamadas.length = 0;
      const rr = await pedir('?sku=RODA', 'adm');
      assert.ok(rr._s === 502 && /redirecionamentos demais/.test(rr._o.erro) && chamadas.length === 4, emp + ': no máximo 3 saltos: ' + chamadas.length);
      /* só imagem, com teto; falha de rede e demora não derrubam */
      for (const [sku, re] of [['HTML', /não é imagem/], ['SVG', /não é imagem/], ['GRANDE', /grande demais/], ['MENTE', /grande demais/], ['E500', /respondeu 500/], ['VAZIA', /foto vazia/], ['CAIU', /não consegui buscar/], ['LENTA', /demorou demais/]]) {
        const r = await pedir('?sku=' + sku, 'adm'); assert.ok(r._s === 502 && r._o.ok === false && re.test(r._o.erro) && r._b == null, emp + ': ' + sku + ' → ' + r._s + ' ' + JSON.stringify(r._o));
      }
      const semCache = F.criar({ empresa: emp, json: (res, st, o) => { res._s = st; res._o = o; }, lerChaveAdmin: () => 'chave-foto', validarSessao: () => null, ehAdmin: () => false, lerCacheDeProdutos: () => { throw new Error('disco'); } });
      const uS = new URL('http://x' + pref + '/plano-compra/foto?sku=KP5'); const resS = {}; await semCache({ method: 'GET', headers: {} }, resS, uS, 'GET', uS.pathname);
      assert.strictEqual(resS._s, 404, emp + ': cache ilegível é "sem foto", não erro');

      /* pelo routes REAL da empresa: a rota existe, pede credencial, e lê o cache do plano DESTA empresa */
      const arq = { girassol: 'girassol-backup-offline/gbo-app.js', amb: 'amb-checkout-offline/index.js', good: 'good-checkout-offline/index.js' }[emp];
      fs.writeFileSync(path.join(PASTAS, emp, '_prod_compra.json'), JSON.stringify({ ['SKU-' + emp]: { img: 'https://img.exemplo.com.br/kp5.jpg' } }));
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const real = async (qs) => { const u = new URL('http://x' + pref + qs); const res = { _s: 0, _b: null, _h: null, writeHead(s, hd) { this._s = s; this._h = hd; }, setHeader() {}, end(b) { this._b = b; } }; await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u); return res; };
      chamadas.length = 0;
      const semK = await real('/plano-compra/foto?sku=SKU-' + emp);
      assert.ok((semK._s === 404 || semK._s === 401) && chamadas.length === 0, emp + ': sem credencial, o routes real respondeu ' + semK._s);
      const comK = await real('/plano-compra/foto?k=chave-foto&sku=SKU-' + emp);
      assert.ok(comK._s === 200 && Buffer.compare(Buffer.from(comK._b), Buffer.from(jpeg(5))) === 0, emp + ': o routes real não entregou a foto do cache do plano: ' + comK._s + ' ' + String(comK._b).slice(0, 120));
      const outra = await real('/plano-compra/foto?k=chave-foto&sku=SKU-' + (emp === 'amb' ? 'good' : 'amb'));
      assert.strictEqual(outra._s, 404, emp + ': SKU do cache de OUTRA empresa não pode responder aqui');

      /* ═══ E. a fábrica entrega a peça do .xlsx e o plano no MESMO script ═══ */
      const js = await real('/js/plano-compra.js');
      const corpo = String(js._b || '');
      assert.ok(js._s === 200 && corpo.indexOf('PlanilhaXlsxFotos') > 0 && corpo.indexOf('PlanilhaXlsxFotos') < corpo.indexOf('planoCompraAqui'), emp + ': a peça do .xlsx tem que vir antes do plano, no mesmo script');
      assert.ok(corpo.includes(pref + "'") || corpo.includes('"' + pref + '"'), emp + ': o script não leva o prefixo da empresa');
      assert.doesNotThrow(() => new Function('window', 'document', corpo.replace(/\(function \(\) \{\s*'use strict';\s*var BASE/, '(function () { return; var BASE')), emp + ': o script servido não compila');
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }

  /* ═══ D. o botão "baixar planilha" ═══ */
  {
    const { scriptDoPlano } = require('../lib/checkout/painel-plano-compra');
    const ITENS = [{ sku: 'PT 06/Ç', nome: 'Abajur', img: 'https://x/pt.jpg', curva: 'A', un: 42, md: 1.4, saldo: 3, acaba_em: 12, precisa: 50, comprar: 47, custo_un: 10.5, investir: 493.5, mc_un: 4, risco: 700 },
      { sku: 'GLOBO12', nome: 'Globo', img: null, curva: 'B', un: 0, md: 0, saldo: null, acaba_em: null, precisa: 0, comprar: 0, custo_un: null, investir: null, mc_un: 0, risco: 200 },
      { sku: 'KP5', nome: 'Kit', img: 'https://x/kp.jpg', curva: 'A', un: 5, md: 0.2, saldo: 0, acaba_em: 0, precisa: 9, comprar: 9, custo_un: 2, investir: 18, mc_un: 1, risco: 9 }];
    const cena = async (janela) => {
      const els = {}; const obs = { blobs: [], baixados: [], montar: [], salvar: [], fotos: [] };
      const novo = (id) => ({ id, innerHTML: '', textContent: id === 'pcCsv' ? 'baixar planilha' : '', value: '', disabled: false, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, click() { return this._ev.click && this._ev.click(); } });
      els.planoCompraAqui = novo('planoCompraAqui');
      const doc = { getElementById: (id) => els[id] || (els[id] = novo(id)), createElement: () => ({ click() { obs.baixados.push(this.download); }, href: '', download: '' }) };
      const sandbox = new Function('document', 'window', 'fetch', 'URL', 'Blob', 'setTimeout', scriptDoPlano('/emp'));
      sandbox(doc, janela, async () => ({ json: async () => ({ ok: true, skus: 3, totais: { investir: 1, risco: 1, skus_a_comprar: 2 }, itens: ITENS }) }),
        { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }, function (partes, op) { obs.blobs.push([String(partes[0]).length, op && op.type]); }, (f) => setImmediate(f));
      els.pcCalc.click(); for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
      assert.ok(/<table/.test(els.pcTab.innerHTML), 'o plano não desenhou');
      return { els, obs };
    };
    const falsoX = (obs, op) => ({
      baixarFotos: (ends, o) => { obs.fotos.push({ ends, lado: o.lado }); if (op && op.trava) return new Promise((ok) => { obs.soltar = () => ok(ends.map(() => null)); }); o.aoAvancar(1, ends.length); obs.rotuloNoMeio = obs.btn.textContent; obs.travadoNoMeio = obs.btn.disabled;
        if (op && op.estoura) return Promise.reject(new Error('sem memória')); return Promise.resolve(ends.map((e, i) => (e && !(op && op.falta === i) ? { bytes: jpeg(i), w: 300, h: 300 } : null))); },
      montar: (a) => { obs.montar.push(a); if (op && op.montarEstoura) throw new Error('xlsx'); return new Uint8Array([1, 2, 3]); },
      salvar: (bytes, nome) => obs.salvar.push([bytes.length, nome]) });
    const fim = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

    /* com a peça: .xlsx, 15 colunas, a Foto na C, as 14 de sempre em volta, fotos pedidas pelo SKU */
    const jan = { createImageBitmap() {} }; const c = await cena(jan); jan.PlanilhaXlsxFotos = falsoX(c.obs); c.obs.btn = c.els.pcCsv;
    await c.els.pcCsv.click(); await fim();
    assert.deepStrictEqual(c.obs.fotos, [{ ends: ['/emp/plano-compra/foto?sku=PT%2006%2F%C3%87', '', '/emp/plano-compra/foto?sku=KP5'], lado: 300 }], 'as fotos são pedidas ao servidor pelo SKU (codificado); item sem foto não pede');
    const m = c.obs.montar[0];
    assert.deepStrictEqual(m.cab, ['SKU', 'Produto', 'Foto', 'Imagem (URL)', 'Curva', 'Vendidas na base', 'Media por dia', 'Saldo hoje', 'Acaba em (dias)', 'Precisa ate o proximo ciclo', 'COMPRAR', 'Custo unitario', 'Investimento', 'Margem por unidade', 'Lucro em risco'], 'as 14 colunas de sempre, com a Foto entre a B e a antiga C');
    assert.deepStrictEqual([m.colFoto, m.lado, m.linhas.length, m.fotos.length, m.fotos.map((f) => !!f)], [2, 300, 3, 3, [true, false, true]]);
    assert.deepStrictEqual(m.linhas[0], ['PT 06/Ç', 'Abajur', '', 'https://x/pt.jpg', 'A', 42, 1.4, 3, 12, 50, 47, 10.5, 493.5, 4, 700]);
    assert.deepStrictEqual(m.linhas[1], ['GLOBO12', 'Globo', '', '', 'B', 0, 0, '', '', 0, 0, '', '', 0, 200], 'sem saldo/custo fica VAZIO (não zero); zero de verdade fica zero');
    assert.ok(c.obs.salvar.length === 1 && c.obs.salvar[0][0] === 3 && /^plano-de-compra-\d{4}-\d{2}-\d{2}\.xlsx$/.test(c.obs.salvar[0][1]), 'o arquivo é .xlsx: ' + JSON.stringify(c.obs.salvar));
    assert.deepStrictEqual([c.obs.blobs.length, c.obs.baixados.length], [0, 0], 'com a planilha nova, a antiga (.xls) não é baixada junto');
    assert.deepStrictEqual([c.obs.rotuloNoMeio, c.obs.travadoNoMeio, c.els.pcCsv.textContent, c.els.pcCsv.disabled, c.els.pcXlsInfo.textContent], ['buscando fotos 1/3…', true, 'baixar planilha', false, 'planilha baixada com 2 foto(s)'], 'mostra o andamento, trava o botão no meio e devolve no fim');
    /* o filtro da tela vale pra planilha */
    c.els.pcFiltro._ev.input({ target: { value: 'kit' } }); await c.els.pcCsv.click(); await fim();
    assert.deepStrictEqual([c.obs.montar[1].linhas.length, c.obs.montar[1].linhas[0][0], c.obs.fotos[1].ends], [1, 'KP5', ['/emp/plano-compra/foto?sku=KP5']]);
    /* foto que não veio: a planilha sai, e a tela diz quantas faltaram */
    const j2 = { createImageBitmap() {} }; const c2 = await cena(j2); j2.PlanilhaXlsxFotos = falsoX(c2.obs, { falta: 2 }); c2.obs.btn = c2.els.pcCsv;
    await c2.els.pcCsv.click(); await fim();
    assert.deepStrictEqual([c2.obs.salvar.length, c2.els.pcXlsInfo.textContent], [1, 'planilha baixada — 1 de 2 foto(s) não vieram (essas linhas ficaram sem imagem)']);
    /* dois cliques: uma planilha */
    const j3 = { createImageBitmap() {} }; const c3 = await cena(j3); j3.PlanilhaXlsxFotos = falsoX(c3.obs, { trava: true }); c3.obs.btn = c3.els.pcCsv;
    c3.els.pcCsv.click(); await fim(); c3.els.pcCsv.click(); await fim();
    assert.deepStrictEqual([c3.obs.fotos.length, c3.els.pcCsv.disabled], [1, true], 'o segundo clique, com a primeira em andamento, não começa outra');
    c3.obs.soltar(); await fim(); assert.deepStrictEqual([c3.obs.salvar.length, c3.els.pcCsv.disabled], [1, false]);
    /* a planilha com fotos falhou (na busca ou na montagem): sai a antiga, e a tela diz */
    for (const op of [{ estoura: true }, { montarEstoura: true }]) {
      const j4 = { createImageBitmap() {} }; const c4 = await cena(j4); j4.PlanilhaXlsxFotos = falsoX(c4.obs, op); c4.obs.btn = c4.els.pcCsv;
      await c4.els.pcCsv.click(); await fim();
      assert.deepStrictEqual([c4.obs.salvar.length, c4.obs.blobs.length, c4.obs.blobs[0][1], /\.xls$/.test(c4.obs.baixados[0]), c4.els.pcCsv.disabled, c4.els.pcCsv.textContent], [0, 1, 'application/vnd.ms-excel;charset=utf-8', true, false, 'baixar planilha'], 'falhou a nova → baixa a antiga: ' + JSON.stringify(op));
      assert.ok(/formato antigo, sem imagem/.test(c4.els.pcXlsInfo.textContent));
    }
    /* sem a peça, ou navegador que não sabe encolher imagem: a planilha antiga, como sempre foi */
    for (const jx of [{}, { createImageBitmap() {} }, { PlanilhaXlsxFotos: { baixarFotos() { throw new Error('não era pra chamar'); } } }]) {
      const c5 = await cena(jx); await c5.els.pcCsv.click(); await fim();
      assert.deepStrictEqual([c5.obs.blobs.length, /^plano-de-compra-\d{4}-\d{2}-\d{2}\.xls$/.test(c5.obs.baixados[0])], [1, true], 'sem a peça nova, baixa a planilha antiga');
    }
    /* sem linhas: não faz nada */
    const j6 = { createImageBitmap() {} }; const c6 = await cena(j6); j6.PlanilhaXlsxFotos = falsoX(c6.obs); c6.obs.btn = c6.els.pcCsv;
    c6.els.pcFiltro._ev.input({ target: { value: 'nada-casa-com-isso' } }); await c6.els.pcCsv.click(); await fim();
    assert.deepStrictEqual([c6.obs.fotos.length, c6.obs.blobs.length], [0, 0]);
  }
  console.log('ok — Plano de Compra, a planilha com a foto em cada linha: o .xlsx é íntegro (número é número, texto não vira fórmula, cada foto na célula da linha dela), a busca das fotos não derruba a planilha, a rota da foto só busca o que o plano guardou (https, máquina de verdade, só imagem), e o botão baixa .xlsx com as 14 colunas + a Foto na C — ou a planilha antiga, se a nova falhar');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
