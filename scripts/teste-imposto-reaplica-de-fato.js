/* 04/10 — A REAPLICAÇÃO DE IMPOSTO PODIA SUMIR E A RESPOSTA CONTINUAVA DIZENDO QUE OCORREU.

   Achado nº 4 da auditoria do Codex. `teste-reaplicar-imposto-paridade.js` procura
   `reaplicarImposto(` no arquivo — e ACHA, no invólucro de `good-checkout-offline/index.js`.
   Apagar a chamada efetiva dentro do POST `/config-fiscal` deixa o teste VERDE.

   O estrago é silencioso e vale dinheiro: o dono corrige a alíquota de um mês, a tela responde
   `reaplicando: ['2026-01']`, e o histórico NUNCA é recalculado. A margem do mês segue errada —
   e "número errado é pior que número ausente" é a regra da casa.

   Aqui a verificação é COMPORTAMENTAL: roda o POST com a função de reaplicação sob controle e
   conta QUANTAS vezes foi chamada e COM QUÊ. Achar o nome no arquivo não prova que a chamada
   acontece.

   ⚠️ Não chamo a rota de produção com disco real: escrevo a configuração num GOODBKP_CACHE_DIR temporário
   e devolvo tudo ao fim. Teste que suja o estado do serviço é pior que teste ausente.

   Marcador estável [IMPOSTO-REAL] pra separar "a asserção disparou" de "o processo morreu". */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const raiz = path.join(__dirname, '..');
const fonte = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');

/* ── 1) a chamada efetiva existe DENTRO do POST, não só no invólucro ──────────────────────
   Esta parte é textual de propósito e sozinha não bastaria — é a trava barata. A prova real
   vem no bloco 2, que executa. */
{
  const iRota = fonte.indexOf("p === '/good-checkout-offline/config-fiscal'");
  assert.ok(iRota > 0, '[IMPOSTO-REAL] não achei a rota /config-fiscal');

  const fim = fonte.indexOf('\n    if (method', iRota + 10);
  const corpoRota = fonte.slice(iRota, fim > iRota ? fim : iRota + 4000);

  assert.ok(/reaplicarImposto\s*\(/.test(corpoRota),
    '[IMPOSTO-REAL] o POST /config-fiscal não chama mais reaplicarImposto — a alíquota muda, a ' +
    'resposta anuncia "reaplicando", e o histórico NUNCA é recalculado');

  /* ⚠️ e a chamada tem que receber os meses que mudaram: chamar com lista vazia "passaria" no
     teste textual e não recalcularia nada */
  assert.ok(/reaplicarImposto\s*\(\s*_mudou\s*\)/.test(corpoRota),
    '[IMPOSTO-REAL] reaplicarImposto não recebe mais `_mudou` — recalcularia o período errado, ' +
    'ou nenhum');
}

/* ── 2) a rota de verdade chama, UMA vez, com o mês que mudou ─────────────────────────── */
module.exports = (async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imposto-real-'));
  process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-imposto';
  /* ⚠️ a GOOD lê o cache de GOODBKP_CACHE_DIR (good-checkout-offline/base.js), não de CACHE_DIR —
     tem que ser setado ANTES do require, senão a rota leria/gravaria o cache real do serviço */
  process.env.GOODBKP_CACHE_DIR = dir;

  const CFG = path.join(dir, '_config-fiscal.json');
  fs.writeFileSync(CFG, JSON.stringify({ aliquotas: { '2026-01': 10 } }));

  const chamadas = [];
  /* a rota chama `_impLibGood.reaplicarImposto(...)` no objeto exportado da lib, resolvido na hora
     da chamada — trocar a propriedade AQUI é o ponto que a rota de fato usa. Não vai ao Supabase. */
  const lib = require(path.join(raiz, 'lib', 'imposto-cancelados.js'));
  assert.strictEqual(typeof lib.reaplicarImposto, 'function',
    '[IMPOSTO-REAL] lib/imposto-cancelados não exporta mais reaplicarImposto');
  lib.reaplicarImposto = async (_ctx, meses) => { chamadas.push(meses); return { ok: true }; };

  const mod = require(path.join(raiz, 'good-checkout-offline', 'index.js'));

  const handler = mod.routes(async () => ({ aliquotas: { '2026-01': 15 } }));
  const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
  const u = new URL('http://x/good-checkout-offline/config-fiscal?k=' + process.env.ADMIN_KEY);
  await handler({ method: 'POST', url: u.pathname + u.search, headers: {} }, res, u);

  assert.strictEqual(chamadas.length, 1,
    '[IMPOSTO-REAL] mudei a alíquota de 10% pra 15% e a reaplicação foi chamada ' +
    chamadas.length + ' vez(es) — a resposta anuncia "reaplicando" e o histórico fica errado');
  assert.ok(Array.isArray(chamadas[0]) && chamadas[0].includes('2026-01'),
    '[IMPOSTO-REAL] a reaplicação não recebeu 2026-01, o mês que mudou → ' + JSON.stringify(chamadas[0]));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('OK: o POST /config-fiscal CHAMA a reaplicacao, uma vez, com o mes que mudou');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
