'use strict';

/**
 * driveApi.js — Google Drive (Service Account) para /good-drive-imagens
 *
 * Env vars:
 *   GOODIMG_GOOGLE_SA_JSON   → JSON da service account (string)
 *   GOODIMG_DRIVE_FOLDER_ID  → ID da pasta-mãe com as subpastas de SKU
 */

const { google } = require('googleapis');

let driveClient = null;

function getCliente() {
  if (driveClient) return driveClient;
  const json = process.env.GOODIMG_GOOGLE_SA_JSON;
  if (!json) throw new Error('GOODIMG_GOOGLE_SA_JSON não configurado');
  let credentials;
  try {
    credentials = JSON.parse(json);
  } catch (e) {
    throw new Error('GOODIMG_GOOGLE_SA_JSON com JSON inválido: ' + e.message);
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive']
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

function estaConfigurado() {
  return !!process.env.GOODIMG_GOOGLE_SA_JSON && !!process.env.GOODIMG_DRIVE_FOLDER_ID;
}

function pastaMae() {
  return process.env.GOODIMG_DRIVE_FOLDER_ID || null;
}

async function listarSubpastas(folderId) {
  const drive = getCliente();
  const resp = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name, createdTime, modifiedTime)',
    pageSize: 1000,
    orderBy: 'name'
  });
  return resp.data.files || [];
}

// Retorna { imagens, subpastas } numa varredura só (detecta variações)
async function listarConteudoCompleto(folderId) {
  const drive = getCliente();
  const resp = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, createdTime, modifiedTime)',
    pageSize: 1000,
    orderBy: 'name'
  });
  const arquivos = resp.data.files || [];
  const imagens = arquivos.filter(f => (f.mimeType || '').startsWith('image/'));
  const subpastas = arquivos.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  return { imagens, subpastas };
}

async function tornarPublico(fileId) {
  const drive = getCliente();
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });
  return true;
}

module.exports = {
  estaConfigurado,
  pastaMae,
  listarSubpastas,
  listarConteudoCompleto,
  tornarPublico
};
