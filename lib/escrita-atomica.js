'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   ESCRITA ATÔMICA DE ARQUIVO (14/10/2026) — parecer do Codex, item 6.7.

   `fs.writeFileSync(arquivo_final, ...)` TRUNCA o arquivo antes de escrever. Se a escrita falha
   no meio (disco cheio/ENOSPC, processo morto num deploy), o arquivo ANTERIOR fica truncado ou
   ilegível. Reproduzido pelo Codex no gerenciador de token da NF: resposta OAuth válida, falha
   de escrita — e o token que funcionava virou JSON quebrado. Pra token é perder a credencial
   (no ML o refresh é de uso único: não há segunda chance sem reautorizar à mão).

   Aqui: grava num temporário no MESMO diretório e só então troca com `rename` (atômico no mesmo
   sistema de arquivos). Falhou no meio, o arquivo anterior fica intacto, o temporário é apagado
   e o erro SOBE — o chamador decide o que fazer, como já decidia antes.
   `sincronizar: true` faz fsync antes da troca (tokens: pequenos e raros); caches frequentes não
   pagam esse custo. `modo` define a permissão do arquivo novo (tokens: 0o600).
   ──────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

let _seq = 0;

function gravarAtomico(arquivo, conteudo, opts) {
  const o = opts || {};
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = arquivo + '.tmp-' + process.pid + '-' + (++_seq) + '-' + Date.now().toString(36);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w', o.modo != null ? o.modo : 0o666);
    const buf = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), 'utf8');
    let escrito = 0;
    while (escrito < buf.length) {
      const n = fs.writeSync(fd, buf, escrito, buf.length - escrito);
      if (!(n > 0)) throw new Error('escrita não avançou em ' + tmp);
      escrito += n;
    }
    if (o.sincronizar) fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, arquivo);
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

module.exports = { gravarAtomico };
