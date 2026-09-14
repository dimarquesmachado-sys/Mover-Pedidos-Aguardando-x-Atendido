'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   LEITURA DA CHAVE DE ADMIN — header primeiro, query como compatibilidade.
   (14/09/2026, auditoria do Codex, P2)

   O problema não é teórico: ontem o dono viu a própria ADMIN_KEY exposta porque o
   serviço a devolvia no link de acompanhamento (PR #399). A chave parou de ser
   ecoada, mas continuava VIAJANDO na URL — e URL aparece em log de proxy, em
   histórico de navegador, em print de tela e em qualquer lugar onde alguém cola um
   link pedindo ajuda. Header não aparece em nenhum desses.

   Por que a query continua aceita: o dono opera pelo navegador, e ele tem dezenas
   de URLs salvas com `&k=`. Cortar de uma vez quebraria o trabalho dele sem avisar.
   A ordem é header → query, então quem já manda header nunca expõe nada, e as URLs
   antigas seguem funcionando até a janela de compatibilidade fechar.

   Aceita `x-admin-key` e `Authorization: Bearer <chave>` — o segundo porque é o que
   ferramenta de linha de comando e integração usam por padrão.
   ──────────────────────────────────────────────────────────────────────────── */

function lerChaveAdmin(req, urlObj) {
  const h = (req && req.headers) || {};
  const doHeader = String(h['x-admin-key'] || '').trim();
  if (doHeader) return doHeader;

  const auth = String(h['authorization'] || '').trim();
  if (/^Bearer\s+/i.test(auth)) {
    const v = auth.replace(/^Bearer\s+/i, '').trim();
    if (v) return v;
  }

  /* compatibilidade: URL salva com &k= continua funcionando */
  try {
    const q = (urlObj && urlObj.searchParams && urlObj.searchParams.get('k')) || '';
    return String(q).trim();
  } catch (e) { return ''; }
}

/** true quando a chave veio por header — quem quiser medir o uso legado olha isto. */
function veioPorHeader(req) {
  const h = (req && req.headers) || {};
  return !!String(h['x-admin-key'] || '').trim() || /^Bearer\s+\S/i.test(String(h['authorization'] || ''));
}

module.exports = { lerChaveAdmin, veioPorHeader };
