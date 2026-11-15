'use strict';
/* 15/11 — AS SITUAÇÕES DE CANCELAMENTO DO BLING, POR EMPRESA (norte C: zero `require` cruzado entre pastas de empresa).

   O Bling de cada empresa tem as suas situações; as "de cancelamento" são descobertas pelo nome (módulo de vendas →
   situações com "cancel") e guardadas 12 h. Isso morava em girassol-backup-offline/gbo-app.js (`garantirSitCancel`) e a
   GOOD/AMB chamavam a Girassol pra descobrir as DELAS. Agora é esta peça: `garantirSitCancel(bg, empresa)` com o blingGet da
   empresa; o objeto por empresa é estável (`alvo(empresa)`) — a fábrica da Girassol e o /varrer-cancelados-status leem o
   dela por referência, como antes. O env de contorno (`GIRABKP_SIT_CANCELADO`) continua valendo só pra Girassol. */
const _por = {};
const ENV_FIXO = { girassol: 'GIRABKP_SIT_CANCELADO' };

function alvo(empresa) { const k = String(empresa || 'girassol'); return (_por[k] = _por[k] || { ids: [], nomes: [], ts: 0, erro: null }); }

async function garantirSitCancel(bg, empresa) {
  const _emp = String(empresa || 'girassol');
  const _alvo = alvo(_emp);
  if (_alvo.ids.length && (Date.now() - _alvo.ts) < 12 * 3600 * 1000) return _alvo;
  try {
    const rm = await bg('/situacoes/modulos');
    const mods = (rm.ok && rm.data && rm.data.data) || [];
    const modVenda = mods.find(m => /venda/i.test(String(m.nome || m.descricao || ''))) || mods[0];
    if (modVenda && modVenda.id) {
      const rs = await bg('/situacoes/modulos/' + modVenda.id);
      const sits = (rs.ok && rs.data && rs.data.data) || [];
      const canc = sits.filter(x => /cancel/i.test(String(x.nome || x.descricao || '')));
      if (canc.length) {
        Object.assign(_alvo, { ids: canc.map(x => Number(x.id)).filter(Boolean), nomes: canc.map(x => x.nome), ts: Date.now(), erro: null });
        console.log('[CANCEL] (' + _emp + ') situações de cancelamento no Bling: ' + _alvo.nomes.join(', ') + ' (ids ' + _alvo.ids.join(',') + ')');
        return _alvo;
      }
      _alvo.erro = 'nenhuma situação com "cancel" no nome (módulo ' + (modVenda.nome || modVenda.id) + ')';
    } else _alvo.erro = 'não achei o módulo de vendas';
  } catch (e) { _alvo.erro = String(e.message || e); }
  // fallback: permite fixar na mão por env, se um dia a descoberta falhar
  const envFixo = ENV_FIXO[_emp];
  if (envFixo && !_alvo.ids.length && process.env[envFixo]) {
    _alvo.ids = String(process.env[envFixo]).split(',').map(x => Number(x.trim())).filter(Boolean);
    _alvo.nomes = ['(definido em ' + envFixo + ')'];
  }
  _alvo.ts = Date.now();
  if (_alvo.erro) console.log('[CANCEL] (' + _emp + ') ⚠️ ' + _alvo.erro);
  return _alvo;
}

module.exports = { garantirSitCancel, alvo, ENV_FIXO };
