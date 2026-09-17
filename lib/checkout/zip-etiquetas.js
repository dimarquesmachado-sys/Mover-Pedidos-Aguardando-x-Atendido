'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   LEITOR DE ZIP DE ETIQUETAS — uma cópia para as três (17/09/2026).

   Lê o zip pelo DIRETÓRIO CENTRAL, e não pelos cabeçalhos locais, porque o zip que
   os marketplaces devolvem vem em modo streaming: os tamanhos no header local vêm
   ZERADOS, e um parser ingênuo devolve entrada vazia sem erro nenhum.

   As três empresas tinham as MESMAS 22 linhas. A GOOD já as havia movido pro escopo
   do módulo (`lerZipEntradas`, reusada pela rota de etiquetas em massa); a AMB e a
   Girassol carregavam a cópia inline dentro da rota. Aqui a GOOD estava À FRENTE —
   o que faltava era levar as outras duas ao mesmo ponto, não o contrário.
   ──────────────────────────────────────────────────────────────────────────── */

const zlib = require('zlib');

function lerZipEntradas(buf) {   // lê pelo DIRETÓRIO CENTRAL (o zip vem em modo streaming, tamanhos zerados no header local)
  let eocd = -1;
  for (let x = buf.length - 22; x >= 0 && x > buf.length - 66000; x--) { if (buf.readUInt32LE(x) === 0x06054b50) { eocd = x; break; } }
  if (eocd < 0) return [];
  const qtd = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const saida = [];
  for (let k = 0; k < qtd && off + 46 < buf.length; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(off + 10), tamComp = buf.readUInt32LE(off + 20);
    const fnLen = buf.readUInt16LE(off + 28), exLen = buf.readUInt16LE(off + 30), cmLen = buf.readUInt16LE(off + 32);
    const nome = buf.slice(off + 46, off + 46 + fnLen).toString('utf8');
    const loc = buf.readUInt32LE(off + 42);
    const lfn = buf.readUInt16LE(loc + 26), lex = buf.readUInt16LE(loc + 28);
    const ini = loc + 30 + lfn + lex;
    const dados = tamComp > 0 ? buf.slice(ini, ini + tamComp) : buf.slice(ini);
    try { saida.push({ nome, conteudo: metodo === 0 ? dados : zlib.inflateRawSync(dados, { finishFlush: zlib.constants.Z_SYNC_FLUSH }) }); } catch (e) {}
    off += 46 + fnLen + exLen + cmLen;
  }
  return saida;
}

module.exports = { lerZipEntradas };
