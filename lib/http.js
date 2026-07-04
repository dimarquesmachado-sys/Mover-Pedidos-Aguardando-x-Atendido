'use strict';

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function html(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

// Lê o corpo da requisição COM limite de tamanho.
// Sem limite, um POST gigante (mesmo acidental) acumula tudo na RAM e derruba o
// serviço por falta de memória (OOM). 12 MB cobre folgado os maiores payloads
// legítimos (ex: selfie do ponto em base64) e bloqueia abusos.
const MAX_BODY = 12 * 1024 * 1024; // 12 MB
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    let tam = 0;
    req.on('data', c => {
      tam += c.length;
      if (tam > MAX_BODY) {
        req.destroy(); // corta a conexão antes de estourar a memória
        reject(new Error('payload muito grande'));
        return;
      }
      b += c;
    });
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

module.exports = { json, html, readBody };
