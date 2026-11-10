'use strict';
/* 09/11 — AS CÓPIAS QUE SAÍRAM (plano, Fase 3 4c). Cada rota que a Girassol e a AMB tinham em CÓPIA e que passou a ser a
   da FÁBRICA (lib/checkout/fabrica-rotas-painel + rotas-painel-ml) tem que: (1) não ter mais cópia no arquivo da empresa
   (a cópia atenderia no lugar da fábrica); (2) não estar em rotasProprias (a fábrica cederia a vez e NINGUÉM atenderia);
   (3) receber da empresa TODA peça que a rota da fábrica exige (as guardas semPeca da própria rota — rota nova que peça
   outra peça cai aqui) e as que ela usa sem guarda (senão perderia o que a cópia fazia: as situações de cancelado
   descobertas, a inferência do canal pelo número da loja).
   Os grupos de backfill, custos e ML têm testes de comportamento próprios; este trava a configuração de todos. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const FAB = ['fabrica-rotas-painel.js', 'rotas-painel-ml.js'].map((f) => fs.readFileSync(path.join(raiz, 'lib', 'checkout', f), 'utf8'));

function bloco(src, ini) { let n = 0, j = src.indexOf('{', ini); for (; j < src.length; j++) { const c = src[j]; if (c === '{') n++; else if (c === '}') { n--; if (!n) break; } } return j + 1; }
function corpoNaFabrica(rota) {
  for (const s of FAB) {
    const i = s.search(new RegExp("p === \\(PREFIXO \\+ '/" + rota.replace(/[-/]/g, '\\$&') + "'\\)"));
    if (i > 0) return s.slice(i, bloco(s, i));
  }
  return null;
}
const USADAS_SEM_GUARDA = ['sitCancel', '_inferCanal'];
const SAIRAM = {
  'girassol-backup-offline/gbo-app.js': ['/girassol-backup-offline', [
    'backfill', 'backfill-conferir', 'backfill-limpar', 'backfill-teste',
    'reaplicar-custo', 'custo-diario', 'custos-manuais', 'varrer-fornecedores', 'reaplicar-imposto',
    'ml-billing', 'ml-vendas-faltando', 'ml-billing-status', 'ml-faltantes-classificar', 'ml-devolucoes', 'ml-devolucoes-coletar', 'ml-vendas-do-dia', 'raio-x-venda',
    'bling-cru', 'config-frete-magalu', 'tiktok-completar-tarifa', 'vendas-sync', 'varrer-cancelados', 'varrer-cancelados-status', 'completar-detalhes',
    'status-mkt', 'sku-repara', 'plano-compra']],
  'amb-checkout-offline/index.js': ['/amb-checkout-offline', [
    'backfill', 'backfill-limpar', 'backfill-teste',
    'reaplicar-custo', 'varrer-fornecedores', 'reaplicar-imposto',
    'ml-billing', 'ml-vendas-faltando', 'raio-x-venda', 'ml-creditos-flex', 'ml-flex-debug', 'ml-billing-status', 'ml-faltantes-classificar', 'ml-devolucoes', 'ml-devolucoes-coletar', 'ml-vendas-do-dia', 'setup-ml', 'ml-trocar-code',
    'bling-cru', 'config-frete-magalu', 'tiktok-completar-tarifa', 'vendas-sync', 'completar-detalhes', 'despachados-por-engano', 'sku-orfaos', 'magalu-caca', 'magalu-debug',
    'status-mkt', 'sku-repara', 'plano-compra']],
};
let total = 0;
for (const [arq, [pfx, rotas]] of Object.entries(SAIRAM)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const ch = s.slice(s.indexOf('criarRotasPainel({'), s.indexOf('\n        });', s.indexOf('criarRotasPainel({')));
  const prop = new Set([...(/rotasProprias:\s*\[([^\]]*)\]/.exec(ch) || ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const pecas = ch.slice(ch.indexOf('pecas:')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rt of rotas) {
    const corpo = corpoNaFabrica(rt);
    assert.ok(corpo, 'a fábrica não trata /' + rt + ' — a empresa ficaria SEM a rota');
    assert.ok(!new RegExp("p === '" + pfx.replace(/[-/]/g, '\\$&') + '/' + rt + "'").test(s), arq + ': sobrou cópia de /' + rt + ' (ela atenderia no lugar da fábrica)');
    assert.ok(!prop.has(rt), arq + ': /' + rt + ' continua em rotasProprias — a fábrica cederia a vez e ninguém atenderia');
    const exige = new Set([...corpo.matchAll(/semPeca\(res, '([^']+)'\)/g)].map((m) => m[1]));
    for (const n of USADAS_SEM_GUARDA) if (new RegExp('\\b' + n + '\\b').test(corpo)) exige.add(n);
    for (const n of exige) {
      if (n.includes('.')) {
        const [obj, fn] = n.split('.');
        const mm = new RegExp('get ' + obj + "\\(\\) \\{ return require\\('([^']+)'\\); \\}").exec(pecas);
        assert.ok(mm, arq + ': /' + rt + ' exige ' + obj + ', que não chega à fábrica');
        assert.ok(typeof require(path.join(raiz, path.dirname(arq), mm[1]))[fn] === 'function', arq + ': o ' + obj + ' entregue não tem ' + fn);
      } else {
        assert.ok(new RegExp('(^|[^A-Za-z0-9_$.])' + n.replace(/\$/g, '\\$') + '([^A-Za-z0-9_$]|$)').test(pecas), arq + ': /' + rt + ' exige a peça ' + n + ', que não chega à fábrica (responderia "falta peça" ou perderia o que a cópia fazia)');
      }
    }
    total++;
  }
}
console.log('ok — ' + total + ' rotas que eram cópia na Girassol e na AMB: nenhuma cópia, nenhuma nas próprias, e toda peça que a rota da fábrica pede chega');
