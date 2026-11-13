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

const travaPesada = require('./trava-pesada');

function criar(deps) {
  const { CUSTO_FILE, readJson, escrever, estadoSync, custoSync, blingGet,
          registrarCustoVigente, lerVigenciaDe, gravarVigenciaDe } = deps;
  /* quem aparece no aviso quando a outra empresa é adiada — sem isso, o log diria só
     "outra rotina" e ninguém saberia qual esperar */
  const empresaRotulo = deps.empresa || String(CUSTO_FILE || '').split('/').slice(-2, -1)[0] || '?';
  for (const [nome, v] of Object.entries({ CUSTO_FILE, readJson, escrever, estadoSync, custoSync, blingGet })) {
    if (v == null) throw new Error('lib/checkout/custo-diario: falta a dependência ' + nome);
  }
  /* o estado do sync é lido por FUNÇÃO, não capturado: o host recria o objeto a cada
     varredura, e guardar a referência aqui congelaria um retrato velho. */
  const _cstDiario = { rodando: false, ultimo: null };
  /* 13/11 (o dono prefere corrigir o custo no Bling): a rotina relia o custo e abria a faixa nova a partir do dia da
     mudança, mas as vendas JÁ GRAVADAS no histórico ficavam com o custo antigo — o Mês/Ano mostrava o número velho até
     alguém lançar o custo à mão. Agora, no fim de cada rodada, a rotina compara os custos vigentes com a FOTO guardada da
     rodada anterior e manda recalcular as vendas de cada SKU cujo custo mudou (a mesma fila do "lançar custo": em fundo,
     um SKU por vez, só o banco de vendas). O desenho (fechado depois de três rodadas de revisão do Codex no #861):
     · a base é a foto GRAVADA (arquivo próprio, ao lado do de custos) — mudança que a sincronização das 6h registrou antes
       das 23h também aparece; só na 1ª vez, sem foto, vale a tirada no início da rodada;
     · o recálculo é desde a mudança MAIS ANTIGA ainda não aplicada (a 1ª faixa depois da que estava na foto), não desde a
       última — duas mudanças em dias diferentes entre duas rodadas não deixam o dia do meio pra trás;
     · cada mudança vira uma PENDÊNCIA gravada, que só sai quando a fila confirma que recalculou com sucesso; falhou (banco
       fora, servidor reiniciou) → é pedida de novo na rodada seguinte;
     · no máximo TETO_RECALCULO pedidos por rodada (as pendências mais antigas primeiro); o resto fica pra próxima;
     · a "semente" (1ª noite de uma empresa: milhares de SKUs ganhando custo de uma vez, sem venda antiga a corrigir) não
       enfileira nada.
     As peças são opcionais: empresa que não as passa segue como sempre. */
  const TETO_RECALCULO = 300;
  /* pendência já pedida há pouco fica ESPERANDO a confirmação em vez de ser pedida de novo: a rotina é chamada de minuto em
     minuto enquanto a releitura do Bling não fecha (até 3 tentativas), e o recálculo pedido no tique anterior ainda roda */
  const ESPERA_REPEDIR_MS = deps.esperaRepedirMs == null ? 6 * 3600000 : deps.esperaRepedirMs;
  const _temRecalculo = typeof deps.lerVigencias === 'function' && typeof deps.pedirRecalculo === 'function';
  const _dia = (x) => String(x || '').slice(0, 10);
  const _sigFaixa = (f) => (f && f.de) ? _dia(f.de) + '|' + Number(f.custo) : null;
  /* arquivo próprio: dentro do arquivo de custos a foto o engordaria em ~40% numa empresa de 9 mil SKUs, e ele é lido inteiro
     em quase toda tela (o servidor já caiu por memória uma vez, em 13/09) */
  const FOTO_FILE = require('path').join(require('path').dirname(String(CUSTO_FILE)), '_custo-diario-foto.json');
  function _fotoDeAgora() {
    const v = deps.lerVigencias() || {}, foto = {};
    for (const k of Object.keys(v)) { const l = v[k]; const sig = (Array.isArray(l) && l.length) ? _sigFaixa(l[l.length - 1]) : null; if (sig) foto[k] = sig; }
    return { v, foto };
  }
  function _lerEstadoFoto() {
    try { const j = readJson(FOTO_FILE, null); if (j && typeof j === 'object' && j.foto && typeof j.foto === 'object') return { existe: true, foto: j.foto, pendentes: (j.pendentes && typeof j.pendentes === 'object') ? j.pendentes : {} }; } catch (e) {}
    return { existe: false, foto: null, pendentes: {} };
  }
  /* desde que dia o custo deste SKU mudou em relação à foto? null = não mudou */
  function _desdeQuandoMudou(lista, sigSalva) {
    if (!Array.isArray(lista) || !lista.length) return null;
    if (!sigSalva) return _dia(lista[0].de) || null;                          /* SKU novo: desde a 1ª faixa dele */
    const i = lista.findIndex((f) => _sigFaixa(f) === sigSalva);
    if (i === lista.length - 1) return null;                                  /* a última faixa é a da foto: nada mudou */
    if (i >= 0) return _dia(lista[i + 1].de) || null;                         /* a 1ª faixa DEPOIS da que estava na foto */
    return _dia(String(sigSalva).split('|')[0]) || null;                      /* a faixa da foto sumiu ou mudou no lugar: desde o começo dela */
  }
  /* a foto do início da rodada (só serve na 1ª vez, quando ainda não há foto gravada) */
  function _fotoInicial() { if (!_temRecalculo) return null; try { return _fotoDeAgora().foto; } catch (e) { return null; } }
  function _processarRecalculo(fotoInicio, st, ehSemente) {
    if (!_temRecalculo) return;
    let agora; try { agora = _fotoDeAgora(); } catch (e) { return; }
    const est = _lerEstadoFoto();
    const base = est.existe ? est.foto : (fotoInicio || {});
    const pend = Object.assign({}, est.pendentes);
    const agoraISO = new Date().toISOString();
    const confirma = typeof deps.estadoRecalculo === 'function';
    /* 1) sai da lista o que a fila confirma que recalculou COM SUCESSO, numa execução iniciada depois do pedido e cobrindo a
       data pedida */
    if (confirma) for (const sku of Object.keys(pend)) {
      const p = pend[sku]; if (!p || !p.pedido_em) continue;
      let u = null; try { u = (deps.estadoRecalculo(sku) || {}).ultimo || null; } catch (e) { u = null; }
      /* Codex #861 (4): só confirma a execução que COMEÇOU depois do pedido. Uma execução mais antiga do mesmo SKU (um
         "lançar custo" que já estava rodando) pode TERMINAR depois do pedido tendo usado o custo de antes — ela não vale. */
      if (u && u.ok && _dia(u.de) && _dia(u.de) <= _dia(p.de) && String(u.inicio || '') >= String(p.pedido_em)) delete pend[sku];
    }
    /* 2) o que mudou desde a foto entra como pendência, desde a data mais antiga */
    let mudados = 0;
    for (const k of Object.keys(agora.v)) {
      const de = _desdeQuandoMudou(agora.v[k], base[k]); if (!de) continue;
      mudados++;
      const ja = pend[k];
      pend[k] = { de: (ja && ja.de && _dia(ja.de) < de) ? _dia(ja.de) : de, pedido_em: null };
    }
    st.custos_mudados = mudados;
    /* a semente DE VERDADE — a rodada que semeou os custos da empresa (o arquivo de custos ainda não tinha o carimbo de
       semente completa quando ela começou), sem foto gravada e com mudança demais: não há venda antiga a corrigir; só
       guarda a foto. Codex #861 (3): NÃO basta faltar a foto — numa empresa já em operação, a 1ª rodada depois deste
       deploy também não tem foto, e um reajuste em massa nesse dia viraria "semente" e se perderia. Aí vale a regra
       normal: tudo vira pendência e sai aos poucos, o teto por rodada. */
    if (ehSemente && !est.existe && mudados > TETO_RECALCULO) {
      for (const k of Object.keys(pend)) delete pend[k];
      st.recalculo = mudados + ' SKUs ganharam custo de uma vez na 1ª rodada (semente) — nada a recalcular';
    } else {
      /* 3) pede até o teto da rodada. A vez RODA: primeiro quem NUNCA foi pedido, depois quem foi pedido há mais tempo (e,
         no empate, a mudança mais antiga) — senão, com mais pendências que o teto e a fila sem confirmar, as mesmas
         primeiras gastariam o teto toda noite e as últimas nunca teriam vez */
      const ordem = Object.keys(pend).sort((a, b) => String(pend[a].pedido_em || '').localeCompare(String(pend[b].pedido_em || '')) || _dia(pend[a].de).localeCompare(_dia(pend[b].de)) || a.localeCompare(b));
      let pedidos = 0, falhas = 0;
      let esperando = 0;
      const aPedir = ordem.filter((sku) => { const p = pend[sku]; const t = p.pedido_em ? Date.parse(p.pedido_em) : NaN; if (isFinite(t) && Date.now() - t < ESPERA_REPEDIR_MS) { esperando++; return false; } return true; });
      for (const sku of aPedir.slice(0, TETO_RECALCULO)) {
        try { deps.pedirRecalculo(sku, _dia(pend[sku].de)); pedidos++; if (confirma) pend[sku].pedido_em = agoraISO; else delete pend[sku]; }
        catch (e) { falhas++; }
      }
      const ficam = Object.keys(pend).length;
      if (pedidos || falhas || ficam) st.recalculo = 'recálculo das vendas pedido pra ' + pedidos + ' SKU(s), desde a mudança mais antiga de cada um'
        + (falhas ? ' · ' + falhas + ' não entraram na fila (tento na próxima rodada)' : '')
        + (esperando ? ' · ' + esperando + ' já pedido(s), esperando a fila confirmar' : '')
        + (aPedir.length > TETO_RECALCULO ? ' · ' + (aPedir.length - TETO_RECALCULO) + ' ficaram pra próxima rodada (teto de ' + TETO_RECALCULO + ')' : '');
      st.recalculo_pendentes = ficam;
    }
    try { escrever(FOTO_FILE, { foto: agora.foto, pendentes: pend }); } catch (e) {}
  }

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
  /* Codex #387 (P1): a rotina sempre derivava o dia sozinha (ontem, antes das 23h), então
     o disparo manual com ?dia= só limpava o carimbo e rodava OUTRO dia — anunciando que
     tinha refeito o pedido. Agora o dia pode ser IMPOSTO pelo chamador manual; o relógio
     segue derivando como antes. */
  async function custoDiario(diaForcado) {
    /* Codex #358 r3: adiado no último tick das 23h morria à meia-noite (data nova) e o
       dia útil ficava sem scan até o TTL. Antes das 23h o dia-alvo é ONTEM (janela de
       recuperação da madrugada); o filtro dataAlteracaoInicial pega de lá até agora. */
    const ag0 = new Date();
    const d0 = (diaForcado && /^\d{4}-\d{2}-\d{2}$/.test(String(diaForcado))) ? String(diaForcado) : (ag0.getHours() >= 23)
      ? _diaLocalHoje()
      : new Date(ag0.getTime() - ag0.getTimezoneOffset() * 60000 - 86400000).toISOString().slice(0, 10);
    if (_cstDiario.rodando) return;
    if (estadoSync().rodando) { _cstDiario.ultimo = { adiado: 'custo-sync em curso — novo tick tenta de novo', em: new Date().toISOString() }; return; }
    let cc = readJson(CUSTO_FILE, {});
    if (cc._custoDiarioDia === d0) return; /* já concluiu hoje (sobrevive a restart) */

    /* 14/09 — TRAVA DO PROCESSO, não da empresa. O 503 de 13/09 às 23:16 foi sobreposição:
       a rodada da AMB (23h00) ainda estava em pé quando a da Girassol (23h15) começou, e as
       duas dividiram um heap de 340MB — o log mostra "6.848 linhas" de uma alternando com
       "28.410 linhas / 1.768 SKU(s)" da outra. Cada empresa só conhecia a PRÓPRIA trava.
       Adiar em vez de enfileirar: o relógio tenta de novo em 1 min, e enfileirar guardaria
       o trabalho na memória, que é justamente o recurso que faltou. */
    const _trava = travaPesada.tentarEntrar('custo-diario:' + empresaRotulo);
    if (!_trava.ok) {
      _cstDiario.ultimo = {
        adiado: 'outra rotina pesada em curso (' + _trava.ocupadoPor + ', há ' + _trava.haMin + ' min) — novo tick tenta de novo',
        em: new Date().toISOString(),
      };
      return;
    }
    _cstDiario.rodando = true;
    const st = { iniciado: new Date().toISOString(), dia: d0, modo: 'incremental', alterados_no_bling: 0, alvo: 0, kits_dependentes: 0 };
    _cstDiario.ultimo = st;
    const concluirDia = () => { try { const c2 = readJson(CUSTO_FILE, {}); c2._custoDiarioDia = d0; escrever(CUSTO_FILE, (c2)); } catch (e) {} };
    const _fotoAntes = _fotoInicial();   /* 13/11: os custos vigentes ANTES de reler o Bling (só é a base na 1ª vez) */
    const _eraSemente = !cc._sementeCompleta;   /* esta rodada é a que semeia os custos da empresa? */
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
    finally {
      try { _processarRecalculo(_fotoAntes, st, _eraSemente); } catch (eR) {}   /* 13/11: o que mudou de custo recalcula as vendas já gravadas */
      _cstDiario.rodando = false;
      gravarVigenciaDe(null);
      travaPesada.sair('custo-diario:' + empresaRotulo);   /* soltar SEMPRE, inclusive em erro */
    }
  }

  return { custoDiario, estado: () => _cstDiario.ultimo, _diaLocalHoje, _diaFechadoDoDisco, _cstDiario };
}

module.exports = { criar };
