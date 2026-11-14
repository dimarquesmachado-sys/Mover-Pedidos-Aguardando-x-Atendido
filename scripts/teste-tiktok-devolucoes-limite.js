'use strict';
/* 14/11 — DEVOLUÇÕES DO TIKTOK: "Too many requests" NO MEIO DA COLETA NÃO DERRUBA MAIS A ETAPA (lib/tiktok-financeiro.js).

   Pego na madrugada real de 14/11, no status que o dono colou (Girassol):
     "devoluções do TikTok (120 dias)": estado "erro" — o TikTok respondeu "Too many requests".
   A coleta varre 120 dias em janelas de 30, página a página; na 1ª resposta de limite de chamadas ela DESISTIA, a etapa
   ficava em erro e as devoluções do dia sem atualizar. Limite de chamadas é passageiro: agora espera e pede a MESMA
   página de novo (5 s, 15 s, 30 s), e só desiste se continuar limitado.

   Aqui roda a coleta de PRODUÇÃO (lib/tiktok-devolucoes-rotina → lib/tiktok-financeiro), com o TikTok de mentira:
   · limite no meio (duas vezes) e depois responde → a coleta TERMINA, com todas as devoluções, pedindo a mesma página de
     novo, e conta quantas vezes esperou (a madrugada mostra);
   · limite que não passa → desiste depois das três esperas, o erro diz que foi o limite, o que já tinha lido fica
     guardado e a coleta NÃO é marcada como completa;
   · limite que vem como HTTP 429, sem mensagem → tratado igual;
   · erro que NÃO é limite (token inválido) → não espera nada, falha na hora, como antes;
   · teto de esperas na mesma coleta (12): a madrugada não fica presa numa conta que está limitada o tempo todo;
   · as esperas de produção são 5 s, 15 s e 30 s, nessa ordem. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const rot = require('../lib/tiktok-devolucoes-rotina');

const AGORA = Math.floor(Date.now() / 1000);
const dev = (id) => ({ return_id: id, order_id: 'O' + id, return_status: 'COMPLETE', create_time: AGORA - 86400, update_time: 1000 });
const OK = (ids, prox) => ({ ok: true, http: 200, corpo: { code: 0, data: { return_orders: ids.map(dev), next_page_token: prox || '' } } });
const LIMITE = { ok: true, http: 200, corpo: { code: 36009004, message: 'Too many requests' } };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-limite-'));
  process.env.TIKTOK_CACHE_DIR = dir;
  /* as esperas viram instantâneas, mas ficam anotadas */
  const _st = global.setTimeout; let dormidas = [];
  global.setTimeout = (fn, ms) => { dormidas.push(ms); return _st(fn, 0); };
  const arq = (emp) => JSON.parse(fs.readFileSync(path.join(dir, '_tiktok_devolucoes_' + emp + '.json'), 'utf8'));
  try {
    /* ── 1) o caso real: limite no meio, duas vezes, e depois responde ── */
    {
      const pedidos = []; let limites = 2;
      const chamar = async (p, params) => {
        const tk = params.page_token || '';
        pedidos.push(tk || 'pag1');
        if (tk === '') return OK(['A1', 'A2'], 'T2');
        if (tk === 'T2') { if (limites > 0) { limites--; return LIMITE; } return OK(['A3'], 'T3'); }
        return OK(['A4'], '');
      };
      dormidas = [];
      const r = await rot.coletar('girassol', 20, { chamar, esperasLimiteMs: [11, 22, 33] });
      assert.ok(r.ok === true && !r.erro, 'limite que passou não pode virar erro da coleta: ' + JSON.stringify(r));
      assert.deepStrictEqual([r.vistas, r.novas, r.guardadas, r.esperas_por_limite], [4, 4, 4, 2]);
      assert.deepStrictEqual(pedidos, ['pag1', 'T2', 'T2', 'T2', 'T3'], 'depois do limite tinha que pedir a MESMA página de novo (nem pular, nem recomeçar)');
      assert.deepStrictEqual(dormidas.filter((ms) => [11, 22, 33].includes(ms)), [11, 22], 'as esperas do limite têm que crescer na ordem dada');
      assert.strictEqual(rot.textoColeta(r), '4 vista(s) · 4 nova(s) · esperou o limite de chamadas do TikTok 2 vez(es)');
      assert.ok(arq('girassol').ok_em && Object.keys(arq('girassol').devolucoes).length === 4, 'a coleta que terminou tinha que ficar marcada como completa');
      /* sem limite nenhum, o texto e o resultado são os de sempre */
      const r0 = await rot.coletar('good', 20, { chamar: async (p, params) => (params.page_token ? OK([], '') : OK(['G1'], '')), esperasLimiteMs: [11] });
      assert.deepStrictEqual([r0.ok, r0.vistas, r0.esperas_por_limite, rot.textoColeta(r0)], [true, 1, 0, '1 vista(s) · 1 nova(s)']);
    }

    /* ── 2) limite que não passa: três esperas e desiste, dizendo o motivo; o que leu fica; não marca completa ── */
    {
      const pedidos = [];
      const chamar = async (p, params) => { pedidos.push(params.page_token || 'pag1'); return params.page_token ? LIMITE : OK(['B1'], 'T2'); };
      const r = await rot.coletar('amb', 20, { chamar, esperasLimiteMs: [1, 2, 3] });
      assert.strictEqual(r.ok, false);
      assert.ok(/returns\/search: Too many requests — limite de chamadas do TikTok \(esperei 3 vez\(es\) e continuou\)/.test(r.erro), 'o erro tem que dizer que foi o limite e quantas vezes esperou: ' + r.erro);
      assert.deepStrictEqual(pedidos, ['pag1', 'T2', 'T2', 'T2', 'T2'], 'eram a página 1 e quatro tentativas da página 2 (a 1ª + três depois de esperar)');
      assert.deepStrictEqual([r.vistas, r.guardadas, r.esperas_por_limite], [1, 1, 3]);
      const g = arq('amb');
      assert.ok(g.devolucoes.B1 && !g.ok_em, 'a coleta interrompida guardou o que leu, mas NÃO pode ficar marcada como completa');
    }

    /* ── 3) o limite como HTTP 429, sem mensagem ── */
    {
      let n = 0;
      const r = await rot.coletar('girassol', 20, { chamar: async () => (++n <= 1 ? { ok: false, http: 429, corpo: null } : OK(['C1'], '')), esperasLimiteMs: [1, 2, 3] });
      assert.ok(r.ok === true && r.esperas_por_limite === 1 && n === 2, 'HTTP 429 tem que ser tratado como limite de chamadas: ' + JSON.stringify(r));
    }

    /* ── 4) erro que NÃO é limite: falha na hora, sem esperar e sem insistir ── */
    {
      let n = 0; dormidas = [];
      const r = await rot.coletar('girassol', 20, { chamar: async () => { n++; return { ok: true, http: 200, corpo: { code: 105001, message: 'access token is invalid' } }; }, esperasLimiteMs: [777, 888, 999] });
      assert.deepStrictEqual([r.ok, r.erro, r.esperas_por_limite, n], [false, 'returns/search: access token is invalid', 0, 1]);
      assert.ok(!dormidas.some((ms) => [777, 888, 999].includes(ms)), 'erro que não é limite não pode gastar espera');
      /* e a chamada que ESTOURA (rede) também */
      const r2 = await rot.coletar('girassol', 20, { chamar: async () => { throw new Error('socket hang up'); }, esperasLimiteMs: [777] });
      assert.deepStrictEqual([r2.ok, r2.erro], [false, 'socket hang up']);
    }

    /* ── 5) teto de esperas na mesma coleta: conta limitada o tempo todo não prende a madrugada ── */
    {
      const visto = {}; let chamadas = 0;
      /* cada página é limitada UMA vez e depois responde — sem teto, isso seguiria pelas 60 páginas */
      const chamar = async (p, params) => {
        chamadas++;
        const n = Number(String(params.page_token || 'P1').slice(1));
        if (!visto[n]) { visto[n] = true; return LIMITE; }
        return OK(['E' + n], 'P' + (n + 1));
      };
      const r = await rot.coletar('good', 20, { chamar, esperasLimiteMs: [1, 2, 3] });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.esperas_por_limite, 12, 'o teto de esperas por coleta é 12: ' + r.esperas_por_limite);
      assert.ok(/esperei 12 vez\(es\) e continuou/.test(r.erro) && r.vistas === 12 && chamadas === 25, 'depois de 12 esperas, a próxima página limitada tem que encerrar a coleta: ' + JSON.stringify(r) + ' · ' + chamadas + ' chamadas');
    }

    /* ── 6) as esperas de PRODUÇÃO: 5 s, 15 s, 30 s ── */
    {
      dormidas = [];
      const r = await rot.coletar('amb', 20, { chamar: async () => LIMITE });
      assert.strictEqual(r.esperas_por_limite, 3);
      assert.deepStrictEqual(dormidas.filter((ms) => ms >= 1000), [5000, 15000, 30000], 'as esperas do limite em produção: ' + JSON.stringify(dormidas));
    }
  } finally { global.setTimeout = _st; fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('ok — devoluções do TikTok: limite de chamadas no meio da coleta espera e pede a mesma página de novo (5/15/30 s); se não passa, desiste dizendo o motivo, sem marcar como completa; erro que não é limite falha na hora; teto de 12 esperas por coleta');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
