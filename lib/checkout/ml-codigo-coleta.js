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

function destinoDe(email, tag) {
  const proprio = String(process.env[tag + '_EMAIL_CODIGO_COLETA'] || '').trim();
  return proprio || String((email && email.EMAIL_DEST) || '').trim();
}

/* d: { arquivo, readJson, writeJson, enviarEmail, email:{SMTP_HOST,SMTP_PORT,EMAIL_USER,EMAIL_PASS,EMAIL_DEST}, tag, nomeEmpresa, agora? } */
async function receber(entrada, d) {
  const codigo = validarCodigo(entrada && entrada.codigo);
  if (!codigo) return { ok: false, via: 'codigo_invalido', erro: 'o código não tem o formato do Mercado Livre (letras e números, 6 a 12)' };
  const para = destinoDe(d.email, d.tag);
  if (!para) return { ok: false, via: 'sem_destino', erro: 'sem e-mail do estoque: crie a env ' + d.tag + '_EMAIL_CODIGO_COLETA (ou ' + d.tag + '_EMAIL_DEST, a que o checkout usa) no Render' };
  if (!d.email || !d.email.EMAIL_USER || !d.email.EMAIL_PASS) return { ok: false, via: 'email_nao_configurado', erro: 'a conta que envia não está configurada: faltam ' + d.tag + '_EMAIL_USER / ' + d.tag + '_EMAIL_PASS no Render' };
  const agora = typeof d.agora === 'function' ? d.agora() : Date.now();
  const dia = diaBR(agora);
  const est = d.readJson(d.arquivo, {}) || {};
  const hoje = (est.dia === dia && Array.isArray(est.enviados)) ? est.enviados : [];
  const ja = hoje.find((x) => x && x.codigo === codigo);
  if (ja) return { ok: true, via: 'ja_enviado', dia, para: ja.para, enviado_em: ja.em };
  if (hoje.length >= LIMITE_CODIGOS_DIA) return { ok: false, via: 'limite_dia', erro: 'já foram ' + hoje.length + ' códigos diferentes hoje — nada enviado' };
  const [a, m, dd] = dia.split('-');
  try {
    await d.enviarEmail({
      to: para,
      subject: 'Código de autorização da coleta ML — ' + d.nomeEmpresa + ' — ' + dd + '/' + m,
      text: 'Código de autorização para hoje (' + dd + '/' + m + '/' + a + '): ' + codigo + '\n\n'
        + 'Use este código pra confirmar a coleta do Mercado Livre quando o motorista mostrar o QR code. Ele vale só hoje.\n\n'
        + 'Enviado automaticamente pela Toolbox (' + d.nomeEmpresa + ').',
    });
  } catch (e) {
    return { ok: false, via: 'falha_envio', erro: 'o servidor de e-mail não aceitou: ' + String((e && e.message) || e).slice(0, 200) };
  }
  const reg = { codigo, para, em: new Date(agora).toISOString(), origem: String((entrada && entrada.origem) || '').slice(0, 40) };
  d.writeJson(d.arquivo, { dia, enviados: hoje.concat([reg]) });
  return { ok: true, via: 'enviado', dia, para };
}

/* o e-mail de verdade: a conta e o servidor de e-mail DA EMPRESA (os mesmos do e-mail da etiqueta) */
function enviarPorSmtp(email) {
  return async ({ to, subject, text }) => {
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({ host: email.SMTP_HOST, port: email.SMTP_PORT, secure: email.SMTP_PORT === 465, auth: { user: email.EMAIL_USER, pass: email.EMAIL_PASS } });
    await t.sendMail({ from: email.EMAIL_USER, to, subject, text });
  };
}

module.exports = { receber, diaBR, validarCodigo, destinoDe, enviarPorSmtp, LIMITE_CODIGOS_DIA };
