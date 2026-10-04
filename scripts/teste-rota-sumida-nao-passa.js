/* 04/10 — ROTA QUE SUMIU TEM QUE DERRUBAR O CHECK.

   Achado numa revisão do Codex sobre os meus testes: o smoke do CI só reprova HTTP >= 500. Uma
   rota APAGADA devolve 404 — e 404 é menor que 500, então passa como verde.

   Isso não é hipótese: HOJE eu removi rotas da AMB (`/varrer-cancelados-status` e
   `/varrer-fornecedores-status`) confiando que a fábrica assumiria. Se não tivesse assumido, o
   CI teria dito "rotas de status respondendo" e o galpão descobriria depois.

   Então aqui a exigência é a de verdade: a rota existe, responde 200 E devolve `ok:true`. Vale
   pras três empresas, chamando o roteador DE PRODUÇÃO — não o texto do arquivo.

   ⚠️ Marcador estável nas mensagens ([ROTA-SUMIDA]) de propósito: quem verifica este teste
   precisa distinguir "a asserção disparou" de "o processo morreu por outro motivo". Erro de
   sintaxe e saída 1 não provam nada. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'teste-rota-sumida';

const EMPRESAS = [
  ['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline'],
  ['Girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'],
  ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline'],
];

/* as rotas que o painel de cada empresa consulta pra saber se a rotina está viva.
   Se uma destas sumir, a tela mostra "carregando" pra sempre e ninguém é avisado. */
const ROTAS = ['/custo-sync?status=1'];

async function chamar(handler, caminho) {
  const res = {
    _s: 0, _b: '',
    writeHead(s) { this._s = s; },
    setHeader() {},
    end(b) { this._b = String(b || ''); },
  };
  const u = new URL('http://x' + caminho);
  const tratou = await handler({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
  return { tratou, status: res._s, corpo: res._b };
}

module.exports = (async () => {
  for (const [emp, mod, prefixo] of EMPRESAS) {
    const handler = require(path.join(raiz, mod)).routes(async () => ({}));

    for (const rota of ROTAS) {
      const caminho = prefixo + rota + '&k=' + process.env.ADMIN_KEY;
      const r = await chamar(handler, caminho);

      /* ⚠️ ESTA é a asserção que o smoke do CI não faz: rota apagada devolve 404 e passa lá. */
      assert.ok(r.tratou === true,
        '[ROTA-SUMIDA] ' + emp + ': ninguém tratou ' + prefixo + rota + ' — a rota SUMIU. ' +
        'O smoke do CI deixaria passar, porque 404 é menor que 500.');

      assert.strictEqual(r.status, 200,
        '[ROTA-SUMIDA] ' + emp + ': ' + prefixo + rota + ' respondeu HTTP ' + r.status +
        ' em vez de 200');

      let corpo;
      try { corpo = JSON.parse(r.corpo); } catch (e) {
        assert.fail('[ROTA-SUMIDA] ' + emp + ': ' + prefixo + rota + ' não devolveu JSON — ' +
          r.corpo.slice(0, 80));
      }
      assert.strictEqual(corpo.ok, true,
        '[ROTA-SUMIDA] ' + emp + ': ' + prefixo + rota + ' respondeu ok:false — ' +
        String(corpo.erro || '').slice(0, 80));
    }
  }

  console.log('OK: as rotas de status existem e respondem 200 ok:true nas 3 empresas');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
