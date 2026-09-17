'use strict';
/* 17/09 — as 22 linhas que leem o zip de etiquetas eram IDÊNTICAS nas três empresas, e aqui a
   GOOD estava À FRENTE: ela já havia movido o parser pro escopo do módulo (a rota de etiquetas
   em massa reusa), enquanto a AMB e a Girassol carregavam a cópia inline dentro da rota. O
   trabalho foi levar as duas ao ponto dela, não o contrário.

   O parser lê pelo DIRETÓRIO CENTRAL do zip, não pelos cabeçalhos locais, e esse detalhe é a
   razão de ele existir: o zip que os marketplaces devolvem vem em modo streaming, com os
   tamanhos ZERADOS no header local. Um parser ingênuo não quebra — devolve entrada vazia, e a
   etiqueta some sem erro nenhum.

   Por isso este teste exercita a função com um ZIP DE VERDADE, montado aqui: procurar texto no
   arquivo provaria que o código existe, não que ele lê. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { lerZipEntradas } = require('../lib/checkout/zip-etiquetas');
const raiz = path.join(__dirname, '..');

/* monta um zip mínimo (sem dependência externa): 2 arquivos deflacionados */
function montarZip(arquivos) {
  const locais = [];
  const central = [];
  let off = 0;
  for (const [nome, conteudo] of arquivos) {
    const nomeBuf = Buffer.from(nome, 'utf8');
    const dados = zlib.deflateRawSync(conteudo);
    const crc = require('zlib').crc32 ? require('zlib').crc32(conteudo) : 0;
    /* Codex #496 (P2): o fixture PRECISA ser em modo streaming, senão não reproduz o zip do
       marketplace — e um parser ingênuo (que lê os tamanhos do header local) passaria no
       teste. Em streaming, crc e tamanhos ficam ZERADOS aqui e só existem no diretório
       central; é exatamente por isso que o parser lê de lá. */
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x08, 6);          // flag bit 3: tamanhos no descritor, não aqui
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(0, 18); lh.writeUInt32LE(0, 22);   // ZERADOS
    lh.writeUInt16LE(nomeBuf.length, 26);
    locais.push(Buffer.concat([lh, nomeBuf, dados]));

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x08, 8);          // a mesma flag, espelhada no diretório central
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(dados.length, 20);
    ch.writeUInt32LE(conteudo.length, 24); ch.writeUInt16LE(nomeBuf.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(Buffer.concat([ch, nomeBuf]));
    off += 30 + nomeBuf.length + dados.length;
  }
  const corpo = Buffer.concat(locais);
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(arquivos.length, 8); eocd.writeUInt16LE(arquivos.length, 10);
  eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(corpo.length, 16);
  return Buffer.concat([corpo, dir, eocd]);
}

/* LÊ DE VERDADE: nomes e conteúdos, descomprimidos */
{
  const zip = montarZip([
    ['etiqueta1.pdf', Buffer.from('%PDF-1.4 conteudo da etiqueta um')],
    ['etiqueta2.pdf', Buffer.from('%PDF-1.4 conteudo da etiqueta dois')],
  ]);
  const ents = lerZipEntradas(zip);
  assert.strictEqual(ents.length, 2, 'esperava 2 entradas, veio ' + ents.length);
  assert.strictEqual(ents[0].nome, 'etiqueta1.pdf');
  assert.ok(ents[0].conteudo.toString().includes('etiqueta um'), 'o conteúdo não foi descomprimido');
  assert.ok(ents[1].conteudo.toString().includes('etiqueta dois'));
}

/* Codex #496 (P2) — A PROVA QUE FALTAVA: um parser INGÊNUO (que lê os tamanhos do header
   local) tem que FALHAR neste fixture. Sem isso, o teste só provava que o nosso funciona, não
   que o formato do marketplace é o que exige ler o diretório central — e uma regressão que
   trocasse a leitura passaria despercebida. */
{
  const zip = montarZip([['etq.pdf', Buffer.from('%PDF-1.4 etiqueta em streaming')]]);

  /* o ingênuo: pega tamanho comprimido do header local (offset 18) */
  const tamNoHeaderLocal = zip.readUInt32LE(18);
  assert.strictEqual(tamNoHeaderLocal, 0,
    'o fixture não está em modo streaming — com os tamanhos preenchidos aqui, um parser ' +
    'ingênuo passaria e o teste não provaria nada sobre o formato do marketplace');

  /* e o nosso, lendo o diretório central, acha o conteúdo de verdade */
  const ents = lerZipEntradas(zip);
  assert.strictEqual(ents.length, 1);
  assert.ok(ents[0].conteudo.toString().includes('etiqueta em streaming'),
    'o parser não descomprimiu a entrada em modo streaming — é exatamente o caso do marketplace');
}

/* entrada inválida devolve lista vazia em vez de explodir: a rota chama isso com o que o
   marketplace mandar, e um throw aqui derrubaria o anexo inteiro */
for (const ruim of [Buffer.alloc(0), Buffer.alloc(10), require('crypto').randomBytes(500)]) {
  assert.deepStrictEqual(lerZipEntradas(ruim), [], 'buffer inválido tem que devolver [] sem lançar');
}

/* e nenhuma empresa pode voltar a carregar a cópia inline */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(!/=\s*buf\s*=>\s*\{[\s\S]{0,200}0x06054b50/.test(s),
    arq + ': a cópia inline do parser de zip voltou — é por aí que a divergência entre as três retorna');
  assert.ok(/require\('\.\.\/lib\/checkout\/zip-etiquetas'\)/.test(s),
    arq + ': não usa a lib do parser de zip');
}

console.log('OK: zip de etiquetas — uma lib para as três, lê zip real pelo diretório central e devolve [] em entrada inválida');
