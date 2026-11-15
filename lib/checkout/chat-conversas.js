'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   AS CONVERSAS GUARDADAS DO CHAT DE ANÁLISE (14/11/2026) — por empresa, no disco dela.

   Pedido do dono: poder voltar numa conversa do chat — revisitar, com título, renomear e apagar.

   O QUE É GUARDADO: a pergunta do dono e a resposta que o chat deu, na ordem, com a hora e o custo estimado de cada
   troca. É o MESMO texto que já apareceu na tela dele — agregados de venda, nada de cliente (a regra do chat). Fica em
   `<cache da empresa>/_chat-analise-conversas.json`, e só o admin lê (a rota é a do chat).

   QUEM GRAVA É O SERVIDOR, quando a resposta termina — não a tela. Assim a conversa guardada é o que foi respondido de
   verdade (resposta que caiu no meio não entra), e fechar a aba não perde a troca que já tinha terminado.

   LIMITES (o arquivo não cresce sem fim): no máximo MAX_CONVERSAS conversas (a mais antiga sai), MAX_TROCAS trocas por
   conversa (as mais antigas saem) e MAX_TEXTO caracteres por mensagem.

   O ID vem de fora (a tela manda de volta o que recebeu): só passa se tiver o formato exato que esta peça gera. Ele nunca
   vira nome de arquivo nem chave de objeto — as conversas ficam numa LISTA e são achadas por comparação.
   ───────────────────────────────────────────────────────────────────────────── */

const path = require('path');

const ARQUIVO = '_chat-analise-conversas.json';
const MAX_CONVERSAS = 60;
const MAX_TROCAS = 40;
const MAX_TEXTO = 8000;
const MAX_TITULO = 80;
const ID = /^c[a-z0-9]{6,12}-[a-z0-9]{6}$/;   /* 'c' + a hora (base 36) + '-' + 6 de sorteio — o hífen no meio deixa de fora qualquer palavra comum (`constructor`…) */

const idValido = (id) => typeof id === 'string' && ID.test(id);
const cortar = (t, n) => { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n) + ' […]' : t; };
/* título: uma linha só, sem espaço sobrando, com teto */
function limparTitulo(t) {
  const s = String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > MAX_TITULO ? s.slice(0, MAX_TITULO - 1).trimEnd() + '…' : s;
}
function novoId(agora) { return 'c' + Math.floor(Number(agora)).toString(36) + '-' + Math.random().toString(36).slice(2, 8).padEnd(6, '0'); }

function criar(o) {
  for (const n of ['CACHE_DIR', 'readJson', 'writeJson']) if (!o || o[n] == null) throw new Error('lib/checkout/chat-conversas: falta ' + n);
  const arq = () => path.join(o.CACHE_DIR, ARQUIVO);
  const agora = () => (typeof o.agora === 'function' ? o.agora() : Date.now());

  /* o arquivo, sempre num formato são: { conversas: [ { id, titulo, criada_em, atualizada_em, trocas: [...] } ] } */
  function ler() {
    const a = o.readJson(arq(), null);
    const lista = (a && Array.isArray(a.conversas)) ? a.conversas : [];
    return lista.filter((c) => c && idValido(c.id) && Array.isArray(c.trocas));
  }
  function gravar(lista) {
    lista.sort((a, b) => String(b.atualizada_em || '').localeCompare(String(a.atualizada_em || '')));
    o.writeJson(arq(), { conversas: lista.slice(0, MAX_CONVERSAS) });
  }
  const resumoDe = (c) => ({ id: c.id, titulo: c.titulo || '(sem título)', criada_em: c.criada_em || null, atualizada_em: c.atualizada_em || null, trocas: c.trocas.length,
    usd_estimado: c.trocas.some((t) => t && t.usd_estimado != null) ? Math.round(c.trocas.reduce((s, t) => s + (Number(t && t.usd_estimado) || 0), 0) * 10000) / 10000 : null });

  return {
    /* as conversas, da mais recente pra mais antiga — sem o texto (a lista é leve) */
    listar() { return ler().sort((a, b) => String(b.atualizada_em || '').localeCompare(String(a.atualizada_em || ''))).map(resumoDe); },

    /* uma conversa inteira, ou null */
    abrir(id) {
      if (!idValido(id)) return null;
      const c = ler().find((x) => x.id === id);
      return c ? Object.assign(resumoDe(c), { trocas: c.trocas.map((t) => ({ em: t.em || null, pergunta: String(t.pergunta || ''), resposta: String(t.resposta || ''), usd_estimado: t.usd_estimado != null ? t.usd_estimado : null })) }) : null;
    },

    /* acrescenta UMA troca terminada. `id` ausente/desconhecido/inválido → conversa nova (o título é a 1ª pergunta).
       Devolve { id, titulo, nova } — ou null se não havia o que guardar. Falha de disco LANÇA (quem chama decide). */
    registrar(id, troca) {
      const pergunta = String((troca && troca.pergunta) || '').trim(), resposta = String((troca && troca.resposta) || '').trim();
      if (!pergunta || !resposta) return null;
      const lista = ler();
      const em = new Date(agora()).toISOString();
      let c = idValido(id) ? lista.find((x) => x.id === id) : null;
      const nova = !c;
      if (!c) { c = { id: novoId(agora()), titulo: limparTitulo(pergunta) || '(sem título)', criada_em: em, atualizada_em: em, trocas: [] }; lista.push(c); }
      const usd = troca.usd_estimado != null && Number.isFinite(Number(troca.usd_estimado)) ? Number(troca.usd_estimado) : null;
      c.trocas.push({ em, pergunta: cortar(pergunta, MAX_TEXTO), resposta: cortar(resposta, MAX_TEXTO), usd_estimado: usd });
      if (c.trocas.length > MAX_TROCAS) c.trocas = c.trocas.slice(-MAX_TROCAS);
      c.atualizada_em = em;
      gravar(lista);
      return { id: c.id, titulo: c.titulo, nova };
    },

    /* muda o título. true se mudou; false se a conversa não existe ou o título veio vazio */
    renomear(id, titulo) {
      const t = limparTitulo(titulo);
      if (!idValido(id) || !t) return false;
      const lista = ler(); const c = lista.find((x) => x.id === id);
      if (!c) return false;
      c.titulo = t;   /* (não mexe em `atualizada_em`: renomear não é conversar — a ordem da lista não muda) */
      gravar(lista);
      return true;
    },

    /* apaga. true se existia */
    apagar(id) {
      if (!idValido(id)) return false;
      const lista = ler(); const resto = lista.filter((x) => x.id !== id);
      if (resto.length === lista.length) return false;
      gravar(resto);
      return true;
    },
  };
}

module.exports = { criar, idValido, limparTitulo, ARQUIVO, MAX_CONVERSAS, MAX_TROCAS, MAX_TEXTO, MAX_TITULO };
