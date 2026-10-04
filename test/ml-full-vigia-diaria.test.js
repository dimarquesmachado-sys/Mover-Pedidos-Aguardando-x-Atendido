'use strict';
// b8 — VIGIA DIARIA do Full do ML. Exercita vigiaJanela/vigiaDiaria/vigiaEmpresas DE
// PRODUCAO (iniciarSerie com varrerLote falso e sleep que nao espera).
const fs = require('fs');
const os = require('os');
const path = require('path');
let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-full-vigia-'));
process.env.ML_FULL_DIR = dir;
delete require.cache[require.resolve('../ml-full.js')];
const mf = require('../ml-full.js');
const I = mf._interno;
const esperarFim = async (e) => { for (let i = 0; i < 4000 && I._serie[e] && I._serie[e].rodando; i++) await new Promise((r) => setImmediate(r)); return I._serie[e]; };
I._serieDeps.sleep = () => Promise.resolve();

(async () => {
  // ── a janela: a semana que terminou ANTEONTEM, no dia de Sao Paulo ──
  {
    // 02/10/2026 03:00 em SP = 06:00 UTC
    const j = I.vigiaJanela(Date.UTC(2026, 9, 2, 6, 0));
    ok(j.de === '20260924' && j.ate === '20260930', `⚠️ rodando 02/10 03:00 (SP): confere 24/09 a 30/09 — 7 dias terminando ANTEONTEM (${j.de}→${j.ate})`);
    // 02/10 00:30 em SP = 03:30 UTC (ja e dia 02 em SP)
    const j2 = I.vigiaJanela(Date.UTC(2026, 9, 2, 3, 30));
    ok(j2.ate === '20260930', '  00:30 de SP ja conta como o dia novo (fuso -3)');
    // 01/10 23:30 em SP = 02/10 02:30 UTC (ainda e dia 01 em SP)
    const j3 = I.vigiaJanela(Date.UTC(2026, 9, 2, 2, 30));
    ok(j3.ate === '20260929', '⚠️ 23:30 de SP ainda e o dia anterior, mesmo ja sendo dia seguinte em UTC');
    // virada de mes/ano
    const j4 = I.vigiaJanela(Date.UTC(2027, 0, 2, 6, 0));
    ok(j4.de === '20261225' && j4.ate === '20261231', `  virada de ano: ${j4.de}→${j4.ate}`);
  }
  // ── as empresas: padrao so a Girassol; env amplia; vazio = nenhuma ──
  {
    const antes = process.env.ML_FULL_VIGIA_EMPRESAS;
    delete process.env.ML_FULL_VIGIA_EMPRESAS;
    ok(JSON.stringify(I.vigiaEmpresas()) === '["girassol"]', '⚠️ sem env: so a Girassol (o pedido)');
    process.env.ML_FULL_VIGIA_EMPRESAS = 'Girassol, AMB ,good';
    ok(JSON.stringify(I.vigiaEmpresas()) === '["girassol","amb","good"]', '  env amplia (espacos e maiusculas toleradas)');
    process.env.ML_FULL_VIGIA_EMPRESAS = '';
    ok(I.vigiaEmpresas().length === 0, '  env vazia = nenhuma (desliga)');
    if (antes === undefined) delete process.env.ML_FULL_VIGIA_EMPRESAS; else process.env.ML_FULL_VIGIA_EMPRESAS = antes;
  }
  // ── a rodada: inicia a serie da janela, marcada como vigia ──
  {
    const chamadas = [];
    I._serieDeps.varrerLote = async (emp, de, ate) => { chamadas.push(emp + ':' + de + '→' + ate); return { ok: true, ja_no_bling: 2, pendentes_novas: 0, nao_conferidas: 0, novas: [] }; };
    const r = I.vigiaDiaria(['girassol', 'xpto'], Date.UTC(2026, 9, 2, 6, 0));
    ok(r[0].empresa === 'girassol' && r[0].ok && r[0].resultado === 'iniciada' && r[0].de === '20260924', '⚠️ girassol: serie iniciada na janela da vigia');
    ok(r[1].resultado === 'empresa_desconhecida' && !r[1].ok, '  empresa desconhecida: pula, declarada');
    const st = await esperarFim('girassol');
    ok(st.origem === 'vigia' && st.completa === true && chamadas.length === 4, `  serie marcada origem:vigia, 4 pedacos (7 dias de 2 em 2), completa (${chamadas.length})`);
    ok(chamadas[0] === 'girassol:20260924→20260925' && chamadas[3] === 'girassol:20260930→20260930', '  pedacos certos (o ultimo e so anteontem)');
  }
  // ── serie ja rodando: a vigia pula (nao atropela uma manual) ──
  {
    I._serieDeps.varrerLote = () => new Promise(() => {});   // pendura: a serie fica rodando
    I.iniciarSerie('amb', '20260101', '20260102', { passo: 2, teto: 60, respiroS: 0 });
    const r = I.vigiaDiaria(['amb'], Date.UTC(2026, 9, 2, 6, 0));
    ok(!r[0].ok && r[0].resultado === 'ja_ha_serie_em_andamento' && I._serie.amb.origem === 'manual', '⚠️ serie manual rodando: a vigia PULA e nao a atropela (a janela movel cobre amanha)');
  }
  // ── Codex #570: noite pulada nao some — a memoria em disco alarga a janela seguinte ──
  {
    delete I._serie.amb;   // solta a serie pendurada do caso anterior
    const agora = Date.UTC(2026, 9, 2, 6, 0);
    const jMem = I.vigiaJanela(agora, '20260915');
    ok(jMem.de === '20260915' && jMem.ate === '20260930', `⚠️ memoria mais antiga que 7 dias alarga a janela (${jMem.de}→${jMem.ate})`);
    ok(I.vigiaJanela(agora, '20250101').de === '20260901', '  alargamento tem teto de 30 dias');
    ok(I.vigiaJanela(agora, '20260930').de === '20260924', '  memoria recente nao encurta a janela de 7 dias');
    I._serieDeps.varrerLote = () => new Promise(() => {});
    I.iniciarSerie('good', '20260101', '20260102', { passo: 2, teto: 60, respiroS: 0 });
    I.vigiaDiaria(['good'], agora, { uptimeS: 99999 });
    ok(I._lerVigia('good').cobrir_desde === '20260924' && I._lerVigia('good').coberto_ate === undefined, '⚠️ pulada por serie em andamento: a memoria nasce mas NAO avanca');
    delete I._serie.good;
    I._serieDeps.varrerLote = async () => ({ ok: true, ja_no_bling: 1, pendentes_novas: 0, nao_conferidas: 0, novas: [] });
    I._salvarVigia('girassol', { cobrir_desde: '20260901' });
    I.vigiaDiaria(['girassol'], agora, { uptimeS: 99999 });
    await esperarFim('girassol');
    ok(I._lerVigia('girassol').cobrir_desde === '20261001' && I._lerVigia('girassol').coberto_ate === '20260930', '  rodada COMPLETA avanca a memoria pro dia seguinte ao `ate`');
    I._serieDeps.varrerLote = async () => ({ ok: false, resultado: 'erro_lote_500' });
    I._salvarVigia('girassol', { cobrir_desde: '20260901' });
    I.vigiaDiaria(['girassol'], agora, { uptimeS: 99999 });
    await esperarFim('girassol');
    ok(I._lerVigia('girassol').cobrir_desde === '20260901', '⚠️ rodada INCOMPLETA nao avanca a memoria');
  }
  // ── Codex #570: reinicio recente com serie interrompida so no checkpoint: a vigia NAO a sobrescreve ──
  {
    const agora = Date.UTC(2026, 9, 2, 6, 0);
    I._salvarSerie('amb', { rodando: true, origem: 'vigia', janela: { de: '20260923', ate: '20260929' }, passo: 2, teto: 200, respiro_s: 0, passada: 1,
      resultados: [{ de: '20260923', ate: '20260924', ok: true, ja_no_bling: 1, pendentes_novas: 0, nao_conferidas: 0 }] });
    const antes = fs.readFileSync(I._arqSerie('amb'), 'utf8');
    const r = I.vigiaDiaria(['amb'], agora, { uptimeS: 120 });
    ok(r[0].resultado === 'retomada_pendente_no_boot' && !I._serie.amb && fs.readFileSync(I._arqSerie('amb'), 'utf8') === antes, '⚠️ 2 min apos o boot: pula e o checkpoint interrompido segue intacto pra retomada do boot');
    I._serieDeps.varrerLote = async () => ({ ok: true, ja_no_bling: 0, pendentes_novas: 0, nao_conferidas: 0, novas: [] });
    const r2 = I.vigiaDiaria(['amb'], agora, { uptimeS: 3600 });
    ok(r2[0].resultado === 'iniciada', '  passada a janela de graca do boot a vigia segue normal (retomada nao fica bloqueando pra sempre)');
    await esperarFim('amb');
  }
  // ── Codex #570: XML salvo que ja saiu da janela e o Bling ja importou: a vigia arquiva ──
  {
    const chave = '35260912345678000190550020000012341000012345';
    const xml = '<nfeProc><NFe><infNFe Id="NFe' + chave + '"><ide><tpNF>1</tpNF></ide></infNFe></NFe></nfeProc>';
    fs.mkdirSync(path.join(dir, 'saida'), { recursive: true });
    const arq = path.join(dir, 'saida', 'girassol-999-' + chave + '.xml');
    fs.writeFileSync(arq, xml);
    I._trocarBlingTokensParaTeste({ girassol: () => ({ garantirToken: async () => 'tok' }) });
    let estaNoBling = false;
    I._trocarFetchParaTeste(async (url) => {
      const corpo = /\/nfe\/\d+/.test(url) ? { data: { chaveAcesso: chave } } : { data: estaNoBling ? [{ id: 55 }] : [] };
      return { status: 200, text: async () => JSON.stringify(corpo) };
    });
    const r1 = await I.reconciliarSalvas('girassol', 60);
    ok(r1.salvas === 1 && r1.arquivadas === 0 && fs.existsSync(arq), '⚠️ ainda ausente no Bling: o XML segue no ZIP');
    estaNoBling = true;
    const r2 = await I.reconciliarSalvas('girassol', 60);
    ok(r2.arquivadas === 1 && !fs.existsSync(arq) && fs.existsSync(path.join(dir, 'importadas', 'girassol-999-' + chave + '.xml')), '⚠️ importado no Bling DEPOIS de sair da janela: a vigia arquiva (sai do ZIP, sem import em duplicidade)');
    let chamou = 0;
    I._serieDeps.varrerLote = async () => ({ ok: true, ja_no_bling: 0, pendentes_novas: 0, nao_conferidas: 0, novas: [] });
    I._serieDeps.reconciliarSalvas = async () => { chamou++; return { salvas: 1 }; };
    I.vigiaDiaria(['girassol'], Date.UTC(2026, 9, 2, 6, 0), { uptimeS: 99999 });
    const st = await esperarFim('girassol');
    ok(chamou === 1 && st.reconciliadas && st.reconciliadas.salvas === 1, '  a serie da vigia chama a reconciliacao ao fim e deixa o resultado no status');
  }
  // ── a retomada apos reinicio preserva origem:vigia ──
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ml-full.js'), 'utf8');
    ok(/origem: j\.origem,   \/\/ b8/.test(src), '  a retomada apos reinicio passa a origem adiante (vigia continua vigia)');
  }
  // ── o index.js agenda: 03:00 SP por padrao, env pra desligar, valida a expressao ──
  {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    ok(/process\.env\.ML_FULL_VIGIA_CRON \|\| '0 3 \* \* \*'/.test(idx), '⚠️ index.js: 03:00 por padrao');
    ok(/\{ timezone: TZ \}/.test(idx.slice(idx.indexOf('VIGIA DIARIA'))), '  no fuso de Sao Paulo');
    ok(/exprVigia\.toLowerCase\(\) !== 'off'/.test(idx) && /cron\.validate\(exprVigia\)/.test(idx), '  =off desliga; expressao invalida nao agenda (e avisa)');
    ok(/vigiaDiaria\(empresasVigia\)/.test(idx), '  chama vigiaDiaria com as empresas da env');
    ok(/empresas\.lojas/.test(idx.slice(idx.indexOf('VIGIA DIARIA'))) && /vigiaSelecionar\(/.test(idx), '⚠️ so agenda empresas ATIVAS (EMPRESAS/SKIP_EMPRESAS) — loja desligada nao acorda');
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log('');
  console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
  process.exit(falhas ? 1 : 0);
})();
