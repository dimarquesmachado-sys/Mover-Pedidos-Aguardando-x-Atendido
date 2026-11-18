# Histórico — o /backfill-status escrito à mão em cada arquivo (até 17/11/2026)

Norte C, `montarCheckout(empresa)`, passo 21: o `/backfill-status` virou a peça única `lib/checkout/rota-backfill-status` — a trava (chave OU sessão de admin; sem as duas, 404) e o prefixo do contrato. A Girassol e a AMB mostram o mesmo `{ ok, status, plano }`; a GOOD mostra o que mostrava (pelos `extras`) e ganha o `ok` e o `status` do registro. Abaixo, o que cada arquivo tinha, tirado do código sem tocar no texto.

## girassol (`girassol-backup-offline/gbo-app.js`)

```js
  async function _rotaBackfillStatus(req, res, urlObj, method, p) {
    if (!(method === 'GET' && p === '/girassol-backup-offline/backfill-status')) return false;
    const kD = lerChaveAdmin(req, urlObj);
    const sessD = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
    json(res, 200, { ok: true, status: _backfill,
      plano: _planoGir.status() });   /* 11/11 (4e): + o plano em fatias; 15/11: o ano É o plano (o `ano` em memória saiu) */
    return true;
  }
```

## amb (`amb-checkout-offline/index.js`)

```js
  async function _rotaBackfillStatus(req, res, urlObj, method, p) {
    if (!(method === 'GET' && p === '/amb-checkout-offline/backfill-status')) return false;
    const kD = lerChaveAdmin(req, urlObj);
    const sessD = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
    json(res, 200, { ok: true, status: _backfill,
      plano: _planoAmb.status() });   /* 11/11 (4e): + o plano em fatias; 15/11: o ano É o plano (o `ano` em memória saiu) */
    return true;
  }
```

## good (`good-checkout-offline/index.js`)

```js
  async function _rotaBackfillStatus(req, res, urlObj, method, p) {
    if (!(method === 'GET' && p === '/good-checkout-offline/backfill-status')) return false;
    /* 17/09 — a AMB e a Girassol aceitam chave OU sessão de admin nesta rota; a GOOD aceitava
       só chave. É a mesma capacidade do #492, ao contrário: lá o admin logado não alcançava
       rotas que só aceitavam sessão; aqui ele não alcança uma que só aceita chave — abrir o
       painel e consultar o backfill não funcionava na GOOD sem colar a chave na URL.
       (O 404 em vez de 403 é proposital e fica: rota de diagnóstico não confirma que existe
       pra quem não tem credencial.) */
    const kS = lerChaveAdmin(req, urlObj);
    const sessS = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && kS === process.env.ADMIN_KEY) || (sessS && ehAdmin(sessS)))) { json(res, 404, { error: 'not found' }); return true; }
    const _stG = _bfGood || { estado: 'nunca rodou neste processo' };   // + o ANO e o progresso VIVO
    /* 14/10: + a rotina diária do histórico (campo `diario`) */
    json(res, 200, _statusBackfillGood(_stG));   /* 15/10: + diário e o plano automático */
    return true;
  }
```

## good (o corpo) (`good-checkout-offline/index.js`)

```js
/* o que o /backfill-status mostra: o backfill manual, a rotina diária e o plano automático */
function _statusBackfillGood(st) {
  return Object.assign({}, _bfStatusComProgresso(st), { diario: _diarioGoodParaStatus(),
    plano: Object.assign({}, _fatGood.resumo(_fatGood.ler(CACHE_DIR)), { motor: _motorPlanoGood.estado() }) });
}
```
