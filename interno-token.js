'use strict';
/* ROTA INTERNA DE LEITURA DE TOKEN — passo 2 do contrato de empresas (v4).
   O Mover-Pedidos é o DONO ELEITO de todos os tokens; o Devoluções passa a LER o
   vigente em vez de renovar (o refresh do ML é de uso único — dois renovadores é
   corrida ativa). Mecânica combinada entre os dois serviços; a formalização no
   contrato (passo_2_eleicao.mecanica) chega com o PR #354, que sincroniza a
   versão nova — o contrato desta árvore ainda é o anterior, de propósito:

     GET /interno/token/:empresa/:integracao
     Auth: ADMIN_TOKEN_LEITURA_KEY SÓ pelo header x-token-leitura (Codex #355: credencial
     em querystring fica em log de proxy/acesso/trace e em URL copiada — pra uma
     rota que entrega SEGREDOS vivos, não existe forma tolerável na URL)
     → { access, expira_em, versao }

   Decisões respondidas ao Devoluções (INSTRUCAO-5):
   - :empresa aceita o id canônico ('ambtotal') E os aliases do contrato ('amb') —
     normaliza pro canônico na resposta;
   - empresa sem a integração (GOOD/tiktok) → 404, como eles preferiram — difícil
     de confundir com token vazio;
   - bling_nfe exposta desde o dia 1, como pediram;
   - magalu/tiktok: 501 declarado até existir leitor (o dono_hoje já é só daqui —
     não há corrida a matar nesses eixos, e rota sem consumidor é superfície à toa).
   Sem ADMIN_TOKEN_LEITURA_KEY no ambiente a rota responde 503: nasce DESLIGADA. */
const crypto = require('crypto');
const CONTRATO = require('./contrato-empresas.json');

/* Codex #355 (P1 ×2): chamar a fábrica direto reintroduzia DENTRO da rota a corrida
   que ela existe pra matar — duas leituras concorrentes de /ml disparariam dois
   renovarTokenML no refresh de USO ÚNICO; e o await sem teto deixava a resposta HTTP
   pendurada num refresh travado (os managers não têm timeout por design — o teto é
   do chamador). Aquisição vira PROMESSA ÚNICA por (empresa, integração) com prazo
   próprio da rota; o refresh segue vivo em background e persiste o token novo. */
const _emVoo = new Map();
const _TTL_EM_VOO = { ms: 90000 };
function _adquirirUnica(chave, fab) {
  let p = _emVoo.get(chave);
  if (!p) {
    p = Promise.resolve().then(fab);
    p.catch(() => {});
    /* Codex #355 r2: promessa PENDURADA (validação sem timeout no manager) ficava no
       mapa pra sempre — toda leitura futura coalescia num 502 eterno. A entrada tem
       prazo de vida: estourou, sai do mapa e a próxima tentativa cria aquisição nova
       (a velha, se acordar, só persiste token — e o lock central do manager impede
       refresh concorrente entre a velha e a nova). */
    const vida = setTimeout(() => { if (_emVoo.get(chave) === p) _emVoo.delete(chave); }, _TTL_EM_VOO.ms);
    /* o finally cria promessa DERIVADA — sem catch próprio ela vira unhandled quando
       a fábrica rejeita (o crash foi visto no teste antes deste catch existir) */
    p.finally(() => { clearTimeout(vida); if (_emVoo.get(chave) === p) _emVoo.delete(chave); }).catch(() => {});
    _emVoo.set(chave, p);
  }
  return p;
}
function _comPrazo(promessa, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('prazo de ' + ms + 'ms estourado — a renovação segue em background; re-peça em instantes')), ms);
    promessa.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
  });
}

const _fabricasRef = { map: null };
function _fabricas() {
  if (!_fabricasRef.map) {
    _fabricasRef.map = {};
    for (const id of Object.keys(CONTRATO.empresas)) {
      _fabricasRef.map[id] = {
        bling:     () => require('./' + id + '/tokenManager').garantirToken(),
        ml:        () => require('./' + id + '/mlTokenManager').garantirTokenML(),
        bling_nfe: () => require('./' + id + '/nfTokenManager').garantirTokenNF(),
      };
    }
  }
  return _fabricasRef.map;
}

function _norm(x) { return String(x || '').toLowerCase().trim(); }

function canonicoDe(nome) {
  const n = _norm(decodeURIComponent(String(nome || '')));
  for (const [id, e] of Object.entries(CONTRATO.empresas)) {
    if ((e.aliases || []).some(a => _norm(a) === n)) return id;
  }
  return null;
}

/* comparação em tempo constante — hash iguala os tamanhos antes do timingSafeEqual */
function chaveConfere(informada, esperada) {
  const h = (x) => crypto.createHash('sha256').update(String(x)).digest();
  return crypto.timingSafeEqual(h(informada), h(esperada));
}

const INTEGRACOES_CONHECIDAS = (() => {
  const s = new Set();
  for (const e of Object.values(CONTRATO.empresas)) {
    for (const k of Object.keys(e.dono_hoje || {})) if (!k.startsWith('_')) s.add(k);
  }
  return s;
})();

async function responder(caminho, chaveInformada, prazoMs) {
  const KEY = process.env.ADMIN_TOKEN_LEITURA_KEY || '';
  if (!KEY) return { status: 503, corpo: { ok: false, erro: 'rota desligada — configure ADMIN_TOKEN_LEITURA_KEY no serviço (chave dedicada de leitura, não a ADMIN_KEY)' } };
  if (!chaveInformada || !chaveConfere(chaveInformada, KEY)) return { status: 401, corpo: { ok: false, erro: 'chave de leitura inválida' } };

  const m = String(caminho || '').match(/^\/interno\/token\/([^/]+)\/([^/]+)$/);
  if (!m) return { status: 400, corpo: { ok: false, erro: 'use GET /interno/token/:empresa/:integracao', exemplo: '/interno/token/ambtotal/ml' } };

  const canonico = canonicoDe(m[1]);
  if (!canonico) return { status: 404, corpo: { ok: false, erro: 'empresa fora do contrato: ' + decodeURIComponent(m[1]) } };

  const integ = _norm(decodeURIComponent(m[2]));
  const emp = CONTRATO.empresas[canonico];
  if (!INTEGRACOES_CONHECIDAS.has(integ)) {
    return { status: 400, corpo: { ok: false, erro: 'integração desconhecida: ' + integ, conhecidas: [...INTEGRACOES_CONHECIDAS].sort() } };
  }
  if (!Object.prototype.hasOwnProperty.call(emp.dono_hoje || {}, integ)) {
    /* GOOD sem TikTok cai aqui: 404 como o Devoluções preferiu — nunca {access:null} */
    return { status: 404, corpo: { ok: false, erro: canonico + ' não tem a integração "' + integ + '" (contrato)' } };
  }

  const fab = _fabricas()[canonico] && _fabricas()[canonico][integ];
  if (!fab) return { status: 501, corpo: { ok: false, erro: 'integração "' + integ + '" ainda não exposta pela rota — entra quando houver leitor (hoje: bling, ml, bling_nfe)' } };

  let access;
  try { access = await _comPrazo(_adquirirUnica(canonico + '|' + integ, fab), prazoMs || 25000); }
  catch (e) { return { status: 502, corpo: { ok: false, erro: 'aquisição do token falhou: ' + String(e.message || e).slice(0, 160) } }; }
  if (!access) return { status: 502, corpo: { ok: false, erro: 'manager devolveu token vazio' } };

  return {
    status: 200,
    corpo: {
      ok: true,
      empresa: canonico,
      integracao: integ,
      access,
      /* os managers renovam por 401 e não expõem o instante de expiração; o contrato
         de leitura combinado cobre isso (401 no marketplace → re-pedir a rota). O campo
         passa a vir preenchido quando os managers expuserem o dado. */
      expira_em: null,
      versao: crypto.createHash('sha1').update(String(access)).digest('hex').slice(0, 10),
    },
  };
}

async function tratar(req, res, urlObj, json) {
  const p = urlObj.pathname;
  if (!p.startsWith('/interno/token/')) return false;
  /* Codex #355 r2: intermediário que cacheia GET por heurística poderia REPLAY do
     access pra requisição sem chave (o header custom não entra na cache key). Toda
     resposta desta rota é no-store, e Vary declara o header por redundância. */
  res.setHeader('Cache-Control', 'no-store, no-cache, private');
  res.setHeader('Vary', 'x-token-leitura');
  if (req.method !== 'GET') { json(res, 405, { ok: false, erro: 'só GET' }); return true; }
  /* Codex #355 (P1): SÓ header — ?k= aqui iria pra log de proxy e URL copiada */
  if (urlObj.searchParams.get('k')) { json(res, 400, { ok: false, erro: 'credencial na URL não é aceita nesta rota — use o header x-token-leitura' }); return true; }
  const chave = req.headers['x-token-leitura'] || '';
  const r = await responder(p, chave);
  json(res, r.status, r.corpo);
  return true;
}

module.exports = {
  tratar,
  _interno: {
    responder, canonicoDe, chaveConfere,
    _trocarFabricasParaTeste(m) { _fabricasRef.map = m; },
    _ttlEmVoo: _TTL_EM_VOO,
  },
};
