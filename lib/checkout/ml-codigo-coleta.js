'use strict';
/* 09/11 (pedido do dono) — CÓDIGO DE AUTORIZAÇÃO DA COLETA DO ML → E-MAIL DO ESTOQUE.

   O Mercado Livre não tem API pra esse código (conferido em 09/11: só aparece no painel, em Vendas e em
   Preferências de venda; vale 24 horas). Quem o lê é a Toolbox, logada no ML da empresa: ela abre a página de
   vendas 1x por dia (7h de Brasília, e tenta de novo até conseguir) e manda o código pra cá. Aqui ele vai por
   e-mail pro estoque da empresa — o mesmo e-mail que o checkout já usa pra mandar etiqueta pra reimprimir
   (<TAG>_EMAIL_DEST), ou um só pra isso (<TAG>_EMAIL_CODIGO_COLETA), se existir.

   Saídas de receber() (cada uma com o motivo em `via`):
     · codigo_invalido   — não tem a cara do código (letras e números, 6 a 12) → nada é enviado;
     · sem_destino       — a empresa não tem e-mail do estoque configurado → diz qual env criar;
     · email_nao_configurado — falta a conta que envia (<TAG>_EMAIL_USER / _PASS);
     · ja_enviado        — o MESMO código já foi pro estoque hoje → não manda de novo (a Toolbox lê o código
                           toda vez que a página de vendas abre);
     · limite_dia        — já foram 3 códigos DIFERENTES hoje → recusa (o código é um só por dia; mais que isso é
                           leitura errada ou abuso, e o estoque não pode receber uma enxurrada);
     · falha_envio       — o servidor de e-mail recusou/caiu → NÃO marca como enviado (a Toolbox tenta de novo);
     · enviado           — foi; o dia, o código e pra quem ficam guardados.
     · reenviado         — (09/11) o dono apertou "Mandar agora" com o código já enviado: vai de novo (até 3× no dia);
     · limite_reenvio    — já foram 3 reenvios desse código hoje → nada enviado.
     · atualizado        — (2.1.11) o MESMO código já tinha ido SEM motorista/placa (o ML ainda não tinha definido) e
                           agora eles apareceram → manda UM segundo e-mail com eles; depois disso, ja_enviado.
   Os DETALHES (horário, status, motorista, placa, depósito) vêm do painel "Detalhes das coletas" que a Toolbox lê; o que
   não veio fica de fora do e-mail — nunca inventado.
   O "dia" é o de BRASÍLIA (o código é "para hoje" no Brasil, e o dono roda a Toolbox de outro fuso). */

const LIMITE_CODIGOS_DIA = 3;

function diaBR(agora) {
  const d = new Date(typeof agora === 'number' ? agora : Date.now());
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const v = (t) => (p.find((x) => x.type === t) || {}).value;
  return v('year') + '-' + v('month') + '-' + v('day');
}

function validarCodigo(c) {
  const s = String(c == null ? '' : c).trim().toUpperCase();
  return /^[A-Z0-9]{6,12}$/.test(s) ? s : null;
}

function limparDetalhes(det) {
  const o = {};
  const d = det && typeof det === 'object' ? det : {};
  for (const [k, max] of [['horario', 30], ['status', 30], ['motorista', 80], ['placa', 8], ['deposito', 60]]) {
    const v = String(d[k] == null ? '' : d[k]).replace(/\s+/g, ' ').trim().slice(0, max);
    if (v) o[k] = k === 'placa' ? v.toUpperCase() : v;
  }
  return o;
}
const completo = (det) => !!(det && det.motorista && det.placa);
/* Codex #830: o que a leitura NOVA trouxe substitui o antigo (horário, status, depósito mudam ao longo do dia); motorista e
   placa andam em PAR — só a leitura nova com os dois troca o par guardado (nunca mistura motorista de um com placa de outro) */
function juntarDetalhes(antigos, novos) {
  const a = antigos || {}, n = novos || {};
  const r = Object.assign({}, a, n);
  if (completo(n)) { r.motorista = n.motorista; r.placa = n.placa; }
  else if (completo(a)) { r.motorista = a.motorista; r.placa = a.placa; }
  else { delete r.motorista; delete r.placa; }
  return r;
}

/* 09/11 (pedido do dono): o horário como se escreve — "15 h - 17 h" vira "15h - 17h", "15:00 h - 17:30 h" vira "15h - 17h30".
   É o MESMO horário que o painel do ML mostra (lido da página), só a escrita muda. */
function horarioBonito(h) {
  return String(h || '').replace(/(\d{1,2})(?::(\d{2}))?\s*h\b/gi, (_, hh, mm) => hh + 'h' + (mm && mm !== '00' ? mm : '')).replace(/\s+/g, ' ').trim();
}

function montarTexto(dia, codigo, det, nomeEmpresa, atualizacao) {
  const [a, m, dd] = dia.split('-');
  const L = [];
  if (atualizacao) L.push('O Mercado Livre definiu o motorista da coleta de hoje.', '');
  const semT = DIAS_SEMANA[new Date(Date.UTC(Number(a), Number(m) - 1, Number(dd))).getUTCDay()];
  L.push('Código de autorização para hoje (' + dd + '/' + m + '/' + a + '):', codigo, 'vale só hoje — ' + semT + ', ' + dd + '/' + m + '/' + a, '');   /* 09/11: o código sozinho na linha; embaixo, o dia */
  if (det.horario) L.push('Coleta: ' + horarioBonito(det.horario) + (det.status ? ' (' + det.status + ')' : ''));
  if (completo(det)) { L.push('Motorista: ' + det.motorista, 'Placa: ' + det.placa); }
  else L.push('Motorista e placa: ainda não definidos pelo Mercado Livre', '(chega outro e-mail quando aparecerem)');
  if (det.deposito) L.push(det.deposito);
  L.push('', 'Confira o motorista e a placa antes de entregar os pacotes. Use o código pra confirmar a coleta quando o motorista mostrar o QR code. Ele vale só hoje.', '', 'Enviado automaticamente pela Toolbox (' + nomeEmpresa + ').');
  return L.join('\n');
}

/* 09/11 (pedido do dono): o ASSUNTO — "Código Coleta MLIVRE — GIRASSOL — 09/11/2026 (segunda-feira)"; o segundo e-mail
   (motorista e placa) leva o mesmo assunto com " — motorista e placa" no fim, pra ficar junto na caixa de entrada */
const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
function montarAssunto(dia, nomeAssunto, atualizacao) {
  const [a, m, dd] = dia.split('-');
  const sem = DIAS_SEMANA[new Date(Date.UTC(Number(a), Number(m) - 1, Number(dd))).getUTCDay()];
  return 'Código Coleta MLIVRE — ' + nomeAssunto + ' — ' + dd + '/' + m + '/' + a + ' (' + sem + ')' + (atualizacao ? ' — motorista e placa' : '');
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/* 09/11 (pedido do dono: "tá meio texto puro, meio feio") — o e-mail em HTML de verdade, feito pra caixa de entrada:
   tabelas e estilo NA LINHA (Gmail/Outlook ignoram CSS de fora), largura até 520 px (lê bem no celular), cabeçalho
   amarelo do Mercado Livre com a empresa e o dia, o CÓDIGO numa caixa grande e em negrito, uma ficha da coleta
   (horário com o status, motorista, placa, depósito) e o lembrete de conferir antes de entregar. O que veio da página
   do ML é ESCAPADO. O texto puro (montarTexto) continua indo junto, pra quem não abre HTML. */
const CORES_STATUS = { 'CONCLUÍDA': ['#e7f6ec', '#1e7b3c'], 'A CAMINHO': ['#e8f1ff', '#1d4fbf'], 'CANCELADA': ['#fdecec', '#b42318'] };
function montarHtml(dia, codigo, det, nomeEmpresa, atualizacao, opts) {
  const o = opts || {};
  const [a, m, dd] = dia.split('-');
  const sem = DIAS_SEMANA[new Date(Date.UTC(Number(a), Number(m) - 1, Number(dd))).getUTCDay()];
  const td = (rot, val) => '<tr><td style="padding:9px 0;border-bottom:1px solid #eef0f3;color:#6b7280;font-size:13px;width:96px;vertical-align:top">' + rot + '</td>'
    + '<td style="padding:9px 0;border-bottom:1px solid #eef0f3;font-size:14px;color:#111827;vertical-align:top">' + val + '</td></tr>';
  const linhas = [];
  if (det.horario || det.status) {
    let v = det.horario ? '<b>' + escHtml(horarioBonito(det.horario)) + '</b>' : '';
    if (det.status) {
      const c = CORES_STATUS[String(det.status).toUpperCase()] || ['#f1f3f5', '#374151'];
      v += (v ? ' &nbsp;' : '') + '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:' + c[0] + ';color:' + c[1] + ';font-size:11px;font-weight:bold;letter-spacing:.5px">' + escHtml(det.status) + '</span>';
    }
    linhas.push(td('Coleta', v));
  }
  if (completo(det)) {
    linhas.push(td('Motorista', '<b>' + escHtml(det.motorista) + '</b>'));
    linhas.push(td('Placa', '<span style="display:inline-block;padding:3px 10px;border:2px solid #111827;border-radius:6px;font-family:\'Courier New\',monospace;font-size:16px;font-weight:bold;letter-spacing:2px;background:#f9fafb">' + escHtml(det.placa) + '</span>'));
  } else {
    linhas.push(td('Motorista', '<span style="color:#b45309">ainda não definido pelo Mercado Livre</span><br><span style="color:#6b7280;font-size:12px">chega outro e-mail quando aparecer</span>'));
  }
  if (det.deposito) linhas.push(td('Depósito', escHtml(String(det.deposito).replace(/^Dep[óo]sito\s+/i, ''))));
  const aviso = atualizacao
    ? '<tr><td style="padding:14px 22px 0"><div style="background:#e7f6ec;color:#1e7b3c;border-radius:8px;padding:10px 12px;font-size:14px;font-weight:bold">✅ O Mercado Livre definiu o motorista da coleta de hoje.</div></td></tr>'
    : (o.reenvio ? '<tr><td style="padding:14px 22px 0"><div style="background:#f1f3f5;color:#374151;border-radius:8px;padding:8px 12px;font-size:12px">↻ Reenvio do código de hoje.</div></td></tr>' : '');
  return '<div style="background:#f2f4f7;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#1f2937">'
    + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;border-collapse:separate;overflow:hidden">'
    + '<tr><td style="background:#ffe600;padding:16px 22px">'
    + '<div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#4b5563">Coleta Mercado Livre</div>'
    + '<div style="font-size:21px;font-weight:bold;color:#111827;margin-top:3px">' + escHtml(nomeEmpresa) + '</div>'
    + '<div style="font-size:13px;color:#374151;margin-top:2px">' + sem + ', ' + dd + '/' + m + '/' + a + '</div>'
    + '</td></tr>'
    + aviso
    + '<tr><td align="center" style="padding:22px 22px 8px">'
    + '<div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#6b7280">Código de autorização</div>'
    + '<div style="display:inline-block;margin:10px 0 6px;padding:12px 24px;border:2px dashed #3483fa;border-radius:10px;background:#f0f6ff;font-family:\'Courier New\',monospace;font-size:44px;font-weight:bold;letter-spacing:6px;color:#111827">' + escHtml(codigo) + '</div>'
    + '<div style="font-size:12px;color:#6b7280">vale só hoje — ' + sem + ', ' + dd + '/' + m + '/' + a + '</div>'
    + '</td></tr>'
    + '<tr><td style="padding:10px 22px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">' + linhas.join('') + '</table></td></tr>'
    + '<tr><td style="padding:14px 22px 20px"><div style="background:#fff8e1;border-left:4px solid #f59e0b;border-radius:6px;padding:10px 12px;font-size:13px;color:#374151;line-height:1.45">'
    + 'Confira o <b>motorista</b> e a <b>placa</b> antes de entregar os pacotes. Use o código pra confirmar a coleta quando o motorista mostrar o QR code.</div></td></tr>'
    + '<tr><td style="padding:12px 22px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">Enviado automaticamente pela Toolbox · ' + escHtml(nomeEmpresa) + '</td></tr>'
    + '</table></div>';
}

function destinoDe(email, tag) {
  const proprio = String(process.env[tag + '_EMAIL_CODIGO_COLETA'] || '').trim();
  return proprio || String((email && email.EMAIL_DEST) || '').trim();
}

/* Codex #824: duas chegadas ao mesmo tempo (a página aberta na mão + a aba das 7h) liam o mesmo estado, passavam as
   duas pela conferência e mandavam DOIS e-mails (e furavam o teto). Agora ler → conferir → enviar → gravar acontece EM
   FILA por arquivo de estado (= por empresa): a segunda espera a primeira e vê o que ela gravou. */
const _filas = new Map();
/* Codex #825: o gravar do disco pode FALHAR (disco cheio) e o writeJson de produção devolve false em vez de lançar — aí o
   e-mail ia, mas o estado não ficava, e a próxima chegada mandava de novo (e furava o teto). O estado do dia agora fica
   TAMBÉM na memória do processo (por arquivo = por empresa) e é ele que vale enquanto o processo vive; o disco é o que
   sobrevive a um reinício. Falha no disco vira `persistido: false` na resposta e uma linha no log. */
const _memoria = new Map();
/* 12/11 (pergunta do dono: "se eu deixar a página aberta e amanhã a extensão ler o código, ela vai saber que é de ontem?")
   — NÃO sabia: o estado zerava a cada dia e o código de ontem, lido de uma página que ficou aberta sem atualizar, saía por
   e-mail como se fosse o de hoje. Agora o estado do dia carrega os códigos dos ÚLTIMOS DIAS EM QUE HOUVE ENVIO
   (`anteriores`, até 7 — a página pode ficar aberta o fim de semana inteiro), e um código que já foi enviado em outro
   dia é recusado (ver `codigo_de_outro_dia` no _receber). */
const DIAS_LEMBRADOS = 7;
function lerEstado(d, dia) {
  const m = _memoria.get(d.arquivo);
  if (m && m.dia === dia) return m;
  const disco = d.readJson(d.arquivo, {}) || {};
  if (disco.dia === dia && Array.isArray(disco.enviados)) return disco;
  /* virou o dia: o que a MEMÓRIA e o DISCO sabem dos dias anteriores vira história — JUNTOS (Codex #846: se o disco
     falhou ao gravar o 2º código de ontem, só a memória o tem; ficar com um dos dois perdia código e o de ontem saía
     como "enviado"). Por dia, a união dos códigos; os mais recentes primeiro; até DIAS_LEMBRADOS dias. */
  const porDia = new Map();
  const junta = (d2, cods) => {
    if (!d2 || d2 === dia || !Array.isArray(cods)) return;
    const conj = porDia.get(d2) || new Set();
    for (const c of cods) if (c) conj.add(c);
    porDia.set(d2, conj);
  };
  for (const fonte of [m, disco]) {
    if (!fonte || !fonte.dia || fonte.dia === dia) continue;
    junta(fonte.dia, (Array.isArray(fonte.enviados) ? fonte.enviados : []).map((x) => x && x.codigo));
    for (const a of (Array.isArray(fonte.anteriores) ? fonte.anteriores : [])) junta(a && a.dia, a && a.codigos);
  }
  const anteriores = [...porDia.entries()].filter((e) => e[1].size).sort((a, b) => (a[0] < b[0] ? 1 : (a[0] > b[0] ? -1 : 0))).slice(0, DIAS_LEMBRADOS).map((e) => ({ dia: e[0], codigos: [...e[1]] }));
  return anteriores.length ? { dia, enviados: [], anteriores } : { dia, enviados: [] };
}
function gravarEstado(d, est) {
  _memoria.set(d.arquivo, est);
  const ok = d.writeJson(d.arquivo, est) !== false;
  if (!ok) console.log('[COLETA] ⚠️ não consegui gravar ' + d.arquivo + ' no disco — o estado do dia segue na memória até o próximo reinício');
  return ok;
}
function emFila(chave, fn) {
  const antes = _filas.get(chave) || Promise.resolve();
  const agora = antes.then(fn, fn);
  const fim = agora.catch(() => {});
  _filas.set(chave, fim);
  fim.then(() => { if (_filas.get(chave) === fim) _filas.delete(chave); });
  return agora;
}

/* d: { arquivo, readJson, writeJson, enviarEmail, email:{SMTP_HOST,SMTP_PORT,EMAIL_USER,EMAIL_PASS,EMAIL_DEST}, tag, nomeEmpresa, nomeAssunto?, agora? } */
function receber(entrada, d) { return emFila(d.arquivo, () => _receber(entrada, d)); }

async function _receber(entrada, d) {
  const codigo = validarCodigo(entrada && entrada.codigo);
  if (!codigo) return { ok: false, via: 'codigo_invalido', erro: 'o código não tem o formato do Mercado Livre (letras e números, 6 a 12)' };
  const para = destinoDe(d.email, d.tag);
  if (!para) return { ok: false, via: 'sem_destino', erro: 'sem e-mail do estoque: crie a env ' + d.tag + '_EMAIL_CODIGO_COLETA (ou ' + d.tag + '_EMAIL_DEST, a que o checkout usa) no Render' };
  if (!d.email || !d.email.EMAIL_USER || !d.email.EMAIL_PASS) return { ok: false, via: 'email_nao_configurado', erro: 'a conta que envia não está configurada: faltam ' + d.tag + '_EMAIL_USER / ' + d.tag + '_EMAIL_PASS no Render' };
  const agora = typeof d.agora === 'function' ? d.agora() : Date.now();
  const dia = diaBR(agora);
  const est = lerEstado(d, dia);
  const hoje = est.enviados;
  const guardar = (enviados) => gravarEstado(d, est.anteriores ? { dia, enviados, anteriores: est.anteriores } : { dia, enviados });
  const det = limparDetalhes(entrada && entrada.detalhes);
  const ja = hoje.find((x) => x && x.codigo === codigo);
  /* 12/11: código que JÁ FOI ENVIADO EM OUTRO DIA = a página de Vendas ficou aberta sem atualizar e o que está na tela é
     o código velho. Não vai (nem com o "Mandar agora": reenviar o código errado é pior que não enviar) — e a resposta
     diz o que fazer. O código do ML vale só o dia; o de hoje é outro. */
  const velho = !ja && (est.anteriores || []).find((x) => x.codigos.indexOf(codigo) !== -1);
  if (velho) {
    const [aA, mA, dA] = String(velho.dia).split('-');
    return { ok: false, via: 'codigo_de_outro_dia', dia_do_codigo: velho.dia, erro: 'este é o código de ' + dA + '/' + mA + '/' + aA + ', não o de hoje — a página de Vendas do Mercado Livre ficou aberta sem atualizar. Recarregue a página (F5) pra ler o código de hoje' };
  }
  if (ja && entrada && entrada.forcar === true) {
    /* 09/11 (pedido do dono): o "Mandar agora" da Toolbox REENVIA, mesmo o código já tendo ido hoje — até 3 reenvios por
       código no dia (o estoque não pode receber uma enxurrada). Os detalhes mais completos que houver vão junto. */
    if ((ja.reenvios || 0) >= 3) return { ok: false, via: 'limite_reenvio', erro: 'este código já foi reenviado 3 vezes hoje — nada enviado' };
    const detR = juntarDetalhes(ja.detalhes, det);
    try {
      await d.enviarEmail({ to: para, subject: montarAssunto(dia, d.nomeAssunto || d.nomeEmpresa, false) + ' — reenvio', text: montarTexto(dia, codigo, detR, d.nomeEmpresa, false), html: montarHtml(dia, codigo, detR, d.nomeEmpresa, false, { reenvio: true }) });
    } catch (e) {
      return { ok: false, via: 'falha_envio', erro: 'o servidor de e-mail não aceitou: ' + String((e && e.message) || e).slice(0, 200) };
    }
    const novoCompleto = !!ja.completo || completo(detR);
    const atualR = hoje.map((x) => (x === ja ? Object.assign({}, ja, { detalhes: detR, completo: novoCompleto, reenvios: (ja.reenvios || 0) + 1, reenviado_em: new Date(agora).toISOString() }) : x));
    const persistidoR = guardar(atualR);
    return { ok: true, via: 'reenviado', dia, para, completo: novoCompleto, persistido: persistidoR };
  }
  if (ja) {
    /* o mesmo código já foi: só manda de novo UMA vez, quando motorista e placa aparecem depois */
    if (ja.completo || !completo(det)) return { ok: true, via: 'ja_enviado', dia, para: ja.para, enviado_em: ja.em, completo: !!ja.completo };
    const detA = juntarDetalhes(ja.detalhes, det);   /* Codex #830: o horário já conhecido não some no e-mail do motorista */
    try {
      await d.enviarEmail({ to: para, subject: montarAssunto(dia, d.nomeAssunto || d.nomeEmpresa, true), text: montarTexto(dia, codigo, detA, d.nomeEmpresa, true), html: montarHtml(dia, codigo, detA, d.nomeEmpresa, true) });
    } catch (e) {
      return { ok: false, via: 'falha_envio', erro: 'o servidor de e-mail não aceitou: ' + String((e && e.message) || e).slice(0, 200) };
    }
    const atual = hoje.map((x) => (x === ja ? Object.assign({}, ja, { detalhes: detA, completo: true, atualizado_em: new Date(agora).toISOString() }) : x));
    const persistidoA = guardar(atual);
    return { ok: true, via: 'atualizado', dia, para, completo: true, persistido: persistidoA };
  }
  if (hoje.length >= LIMITE_CODIGOS_DIA) return { ok: false, via: 'limite_dia', erro: 'já foram ' + hoje.length + ' códigos diferentes hoje — nada enviado' };
  try {
    await d.enviarEmail({
      to: para,
      subject: montarAssunto(dia, d.nomeAssunto || d.nomeEmpresa, false),
      text: montarTexto(dia, codigo, det, d.nomeEmpresa, false),
      html: montarHtml(dia, codigo, det, d.nomeEmpresa, false),
    });
  } catch (e) {
    return { ok: false, via: 'falha_envio', erro: 'o servidor de e-mail não aceitou: ' + String((e && e.message) || e).slice(0, 200) };
  }
  const reg = { codigo, para, em: new Date(agora).toISOString(), origem: String((entrada && entrada.origem) || '').slice(0, 40), detalhes: det, completo: completo(det) };
  const persistido = guardar(hoje.concat([reg]));
  return { ok: true, via: 'enviado', dia, para, completo: completo(det), persistido };
}

/* o e-mail de verdade: a conta e o servidor de e-mail DA EMPRESA (os mesmos do e-mail da etiqueta) */
function enviarPorSmtp(email) {
  return async ({ to, subject, text, html }) => {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: email.SMTP_HOST, port: email.SMTP_PORT, secure: email.SMTP_PORT === 465, auth: { user: email.EMAIL_USER, pass: email.EMAIL_PASS } });
    await t.sendMail({ from: email.EMAIL_USER, to, subject, text, html });
  };
}

module.exports = { receber, diaBR, validarCodigo, destinoDe, enviarPorSmtp, limparDetalhes, juntarDetalhes, montarTexto, montarHtml, montarAssunto, horarioBonito, LIMITE_CODIGOS_DIA };
