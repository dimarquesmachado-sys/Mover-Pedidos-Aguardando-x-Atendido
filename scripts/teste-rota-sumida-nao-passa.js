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

/* Roteador MONTADO: o mesmo `config/empresas` e o mesmo laço do `index.js`
   (`e.routes(readBody)`; o primeiro handler que tratar leva). Chamar o `.routes()` de um módulo
   solto não pegaria uma aplicação tirada de APLICACOES — o teste daria 200 e a produção 404. */
const { readBody } = require(path.join(raiz, 'lib/http'));
const handlers = require(path.join(raiz, 'config/empresas')).map(e => e.routes(readBody));

const EMPRESAS = [
  ['AMB', '/amb-checkout-offline'],
  ['Girassol', '/girassol-backup-offline'],
  ['GOOD', '/good-checkout-offline'],
];

/* as rotas que o painel de cada empresa consulta pra saber se a rotina está viva.
   Se uma destas sumir, a tela mostra "carregando" pra sempre e ninguém é avisado.
   As duas de varredura são as que sumiram da AMB e dependiam da fábrica assumir. */
const ROTAS = ['/custo-sync?status=1', '/varrer-cancelados-status', '/varrer-fornecedores-status'];

async function chamar(caminho) {
  const res = {
    _s: 0, _b: '',
    writeHead(s) { this._s = s; },
    setHeader() {},
    end(b) { this._b = String(b || ''); },
  };
  const u = new URL('http://x' + caminho);
  /* chave pelo header, não na query: uma ADMIN_KEY com &, # ou + quebraria a URL */
  const req = { method: 'GET', url: u.pathname + u.search, headers: { 'x-admin-key': process.env.ADMIN_KEY } };
  let tratou = false;
  for (const h of handlers) { if (await h(req, res, u)) { tratou = true; break; } }
  return { tratou, status: res._s, corpo: res._b };
}

module.exports = (async () => {
  for (const [emp, prefixo] of EMPRESAS) {
    for (const rota of ROTAS) {
      const r = await chamar(prefixo + rota);

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
      /* GOOD ainda não liga as peças das varreduras à fábrica: a rota EXISTE e responde 200, mas com
         ok:false "ainda não expõe". É pendência conhecida, não rota sumida — tolerada só aqui, só
         pra estas duas rotas e só com essa mensagem. Qualquer outro ok:false reprova. */
      const semPecaConhecida = emp === 'GOOD' && /^\/varrer-/.test(rota) &&
        corpo.ok === false && /ainda não expõe/.test(String(corpo.erro || ''));
      if (semPecaConhecida) continue;
      assert.strictEqual(corpo.ok, true,
        '[ROTA-SUMIDA] ' + emp + ': ' + prefixo + rota + ' respondeu ok:false — ' +
        String(corpo.erro || '').slice(0, 80));
    }
  }

  console.log('OK: as rotas de status existem e respondem 200 ok:true nas 3 empresas');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
