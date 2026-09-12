'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CUSTO DIÁRIO (23h) — fatia 5 da desduplicação (11/09).

   164 linhas byte a byte iguais nas duas empresas. É a rotina que estreou em
   10/09 e decide a margem do dia seguinte: às 23h ela pergunta ao Bling o que
   mudou de custo no dia, recalcula o que depende disso (kits inclusos) e fecha
   o dia com um carimbo que sobrevive a restart.

   Por ser essa a responsabilidade, ela só saiu do arquivo com TESTE ESCRITO
   ANTES (scripts/teste-custo-diario.js): seis promessas lidas no próprio código
   — dia fechado não re-roda, sync em curso adia, a 1ª noite roda a semente em
   duas passadas, falha não fecha, três tentativas, dia limpo carimba.

   Não conhece empresa: recebe arquivo de custos, leitor/gravador, o estado do
   custo-sync e as funções de acesso por injeção.
   ──────────────────────────────────────────────────────────────────────────── */

function criar(deps) {
  const { CUSTO_FILE, readJson, escrever, estadoSync, custoSync, blingGet,
          registrarCustoVigente, lerVigenciaDe, gravarVigenciaDe } = deps;
  for (const [nome, v] of Object.entries({ CUSTO_FILE, readJson, escrever, estadoSync, custoSync, blingGet })) {
    if (v == null) throw new Error('lib/checkout/custo-diario: falta a dependência ' + nome);
  }
  /* o estado do sync é lido por FUNÇÃO, não capturado: o host recria o objeto a cada
     varredura, e guardar a referência aqui congelaria um retrato velho. */
  const _cstDiario = { rodando: false, ultimo: null };
  const fs = require('fs');
  const path = require('path');

  function _diaFechadoDoDisco() {
    try { return readJson(CUSTO_FILE, {})._custoDiarioDia || null; }
    catch (e) { return null; }
  }
  function _diaLocalHoje() {
    const ag = new Date();
    return new Date(ag.getTime() - ag.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  async function custoDiario() {
    /* Codex #358 r3: adiado no último tick das 23h morria à meia-noite (data nova) e o
       dia útil ficava sem scan até o TTL. Antes das 23h o dia-alvo é ONTEM (janela de
       recuperação da madrugada); o filtro dataAlteracaoInicial pega de lá até agora. */
    const ag0 = new Date();
    const d0 = (ag0.getHours() >= 23)
      ? _diaLocalHoje()
      : new Date(ag0.getTime() - ag0.getTimezoneOffset() * 60000 - 86400000).toISOString().slice(0, 10);
    if (_cstDiario.rodando) return;
    if (estadoSync().rodando) { _cstDiario.ultimo = { adiado: 'custo-sync em curso — novo tick tenta de novo', em: new Date().toISOString() }; return; }
    let cc = readJson(CUSTO_FILE, {});
    if (cc._custoDiarioDia === d0) return; /* já concluiu hoje (sobrevive a restart) */
    _cstDiario.rodando = true;
    const st = { iniciado: new Date().toISOString(), dia: d0, modo: 'incremental', alterados_no_bling: 0, alvo: 0, kits_dependentes: 0 };
    _cstDiario.ultimo = st;
    const concluirDia = () => { try { const c2 = readJson(CUSTO_FILE, {}); c2._custoDiarioDia = d0; escrever(CUSTO_FILE, (c2)); } catch (e) {} };
    try {
      if (!cc._sementeCompleta) {
        /* Codex #358 r2: na 1ª passada o cache legado não tem comps e o sort empata —
           kit antes do componente somaria custo velho. A semente roda em DUAS passadas:
           a 1ª busca tudo e constrói os comps; a 2ª re-busca só os kits (agora com os
           componentes frescos no cache). Custo extra: nº de kits, uma vez na vida. */
        st.modo = 'semente_completa em 2 passadas (1ª noite — constrói o mapa e recalcula kits)';
        await custoSync(true);
        const _falhas1 = estadoSync().falhas; /* Codex #358 r4: a 2ª passada RECRIA o _cst e engolia as falhas da 1ª */
        const c2 = readJson(CUSTO_FILE, {});
        let _kitsSemente = 0;
        for (const sk of Object.keys(c2)) { if (!sk.startsWith('_') && c2[sk] && Array.isArray(c2[sk].comps)) { c2[sk].ts = 0; _kitsSemente++; } }
        escrever(CUSTO_FILE, (c2));
        if (_kitsSemente) await custoSync(false);
        estadoSync().falhas = estadoSync().falhas + (_kitsSemente ? _falhas1 : 0); /* soma das DUAS passadas pro gate abaixo */
        /* Codex #358 r3: semente com FALHAS não fecha — o componente falhado guardou ts
           antigo e ficaria fora dos próximos ciclos como se estivesse fresco. Até 3
           tentativas por noite; na 3ª fecha com as pendências declaradas (TTL cobre). */
        _cstDiario.tentativas = (_cstDiario.tentativas || 0) + 1;
        if (estadoSync().falhas > 0 && _cstDiario.tentativas < 3) {
          st.modo += ' | ' + estadoSync().falhas + ' falhas — semente NÃO fechada; novo tick re-tenta (' + _cstDiario.tentativas + '/3)';
          st.terminou = new Date().toISOString();
          return;
        }
        if (estadoSync().falhas > 0) st.modo += ' | fechada com ' + estadoSync().falhas + ' pendências declaradas (TTL cobre)';
        _cstDiario.tentativas = 0;
        const c3 = readJson(CUSTO_FILE, {});
        c3._sementeCompleta = Date.now();
        escrever(CUSTO_FILE, (c3));
        st.kits_recalculados_na_semente = _kitsSemente;
        concluirDia();
        st.terminou = new Date().toISOString();
        return;
      }
      const alterados = new Set(); /* SEMPRE em minúsculas — cache e Bling divergem de caixa */
      let traiu = false, paginaFalhou = false;
      for (let pg = 1; pg <= 8; pg++) {
        const r = await blingGet('/produtos?dataAlteracaoInicial=' + encodeURIComponent(d0 + ' 00:00:00') + '&pagina=' + pg + '&limite=100');
        if (!r || !r.ok) { paginaFalhou = true; break; }
        const arr = (r.data && Array.isArray(r.data.data)) ? r.data.data : [];
        for (const p2 of arr) {
          if (!p2) continue;
          if (p2.codigo) alterados.add(String(p2.codigo).toLowerCase());
          if (p2.id) alterados.add('id:' + p2.id); /* comps podem estar mapeados por id */
        }
        if (arr.length < 100) break;
        if (pg === 8) traiu = true;
        await new Promise(r2 => setTimeout(r2, 700));
      }
      st.alterados_no_bling = alterados.size;
      if (paginaFalhou) {
        /* dia fica ABERTO — o próximo tick re-varre; parcial calado deixaria mudança
           das páginas seguintes esperando o TTL de 7 dias */
        st.modo = 'parcial — página da lista falhou (429/erro); nova tentativa no próximo tick';
        st.terminou = new Date().toISOString();
        return;
      }
      if (traiu || alterados.size > 600) {
        st.modo = 'fresh_completo (fallback: filtro de data suspeito — ' + alterados.size + '+ alterados no dia)';
        /* Codex #358 r4: o fallback fechava o dia SEM validar o sync — falha por SKU ou
           sync que nem rodou (6h em curso) fechava com custos velhos até o TTL. */
        const _i0f = estadoSync().inicio;
        await custoSync(true);
        const rodouF = estadoSync().inicio !== _i0f;
        const falhouF = rodouF && estadoSync().falhas > 0;
        _cstDiario.tentativas = (_cstDiario.tentativas || 0) + 1;
        if ((!rodouF || falhouF) && _cstDiario.tentativas < 3) {
          st.modo += ' | ' + (rodouF ? estadoSync().falhas + ' falhas' : 'sync ocupado — não rodou') + '; novo tick re-tenta (' + _cstDiario.tentativas + '/3)';
          st.terminou = new Date().toISOString();
          return;
        }
        if (!rodouF || falhouF) st.modo += ' | fechado com pendências declaradas após 3 tentativas (TTL cobre)';
        _cstDiario.tentativas = 0;
        concluirDia();
        st.terminou = new Date().toISOString();
        return;
      }
      const alvo = new Set();
      const marcados = new Set(alterados); /* em minúsculas — cresce com kits pra pegar kit-de-kit */
      for (const sk of Object.keys(cc)) {
        if (sk.startsWith('_')) continue;
        const v = cc[sk];
        if (alterados.has(sk.toLowerCase())) {
          alvo.add(sk);
          /* Codex #358 r2: o Bling reportou alteração num SKU com LÁPIDE = produto
             restaurado/recriado — a lápide cai na hora, senão ficava sem custo 30 dias */
          if (v && v.apagado_em) cc[sk] = { ts: 0 };
        }
      }
      /* Codex #358 r2: expansão TRANSITIVA — kit que contém kit alterado também entra
         (compara contra o conjunto que cresce, até ponto fixo) */
      let _cresceu = true;
      while (_cresceu) {
        _cresceu = false;
        for (const sk of Object.keys(cc)) {
          if (sk.startsWith('_') || alvo.has(sk)) continue;
          const v = cc[sk];
          if (v && Array.isArray(v.comps) && v.comps.some(c => marcados.has(String(c)))) {
            alvo.add(sk); marcados.add(sk.toLowerCase());
            if (v.id) marcados.add('id:' + v.id); /* Codex #358 r4: kit externo mapeado por id do interno também fecha */
            st.kits_dependentes++; _cresceu = true;
          }
        }
      }
      st.alvo = alvo.size;
      if (alvo.size) {
        for (const sk of alvo) { if (cc[sk]) cc[sk].ts = 0; }
        escrever(CUSTO_FILE, (cc));
      }
      /* alterado que ainda NEM está no cache (vendeu hoje, sync das 6h não passou):
         a fila natural do custoSync nasce das VENDAS e pega quem tem custo nulo —
         por isso a rodada roda sempre que houve alteração, mesmo com alvo 0 */
      /* Codex #358 r4: mudança achada na RECUPERAÇÃO valeu no dia varrido (ontem) —
         a vigência nasce datada dele, e o ref volta ao normal no finally. */
      gravarVigenciaDe((d0 !== _diaLocalHoje()) ? d0 : null);   /* acessor do host: o wrapper de custo lê daqui na hora de registrar */
      if (alvo.size || alterados.size) {
        /* Codex #358 r2: o dia só FECHA se o sync rodou de verdade e sem falhas novas —
           sync engolindo 429 (ou nem rodando por concorrência) fechava o dia com custos
           velhos até o TTL. Teto de 3 tentativas por noite, depois fecha DECLARADO. */
        /* Codex #358 r3: custoSync RECRIA o _cst — comparar com o contador da corrida
           anterior mascarava falha igual. A corrida atual fala por si. */
        const _i0 = estadoSync().inicio;
        await custoSync(false);
        const rodou = estadoSync().inicio !== _i0;
        const falhou = rodou && estadoSync().falhas > 0;
        _cstDiario.tentativas = (_cstDiario.tentativas || 0) + 1;
        if ((!rodou || falhou) && _cstDiario.tentativas < 3) {
          st.modo = (rodou ? 'parcial — ' + estadoSync().falhas + ' falhas na re-busca' : 'sync ocupado — não rodou') + '; novo tick re-tenta (tentativa ' + _cstDiario.tentativas + '/3)';
          st.terminou = new Date().toISOString();
          return;
        }
        if (!rodou || falhou) st.modo += ' | fechado com pendências declaradas após 3 tentativas (TTL de 7d cobre)';
        _cstDiario.tentativas = 0;
      }
      concluirDia();
      st.terminou = new Date().toISOString();
    } catch (e) { st.erro = String(e.message || e).slice(0, 200); }
    finally { _cstDiario.rodando = false; gravarVigenciaDe(null); }
  }

  return { custoDiario, estado: () => _cstDiario.ultimo, _diaLocalHoje, _diaFechadoDoDisco, _cstDiario };
}

module.exports = { criar };
