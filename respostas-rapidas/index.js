// ============================================================
// MÓDULO: Respostas Rápidas Mercado Livre
// ============================================================
// Sistema multi-loja (AMBTOTAL, GIRASSOL, GIMPO) para gerenciar
// respostas rápidas usadas pela extensão Chrome no ML.
//
// Rotas montadas em /respostas-rapidas no server.js principal.
// ============================================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const router = express.Router();

// ============================================================
// CONFIGURAÇÃO (lê do process.env do Mover-Pedidos)
// ============================================================

const JWT_SECRET = process.env.RESPOSTAS_JWT_SECRET || process.env.JWT_SECRET || 'troque-este-secret';
const API_KEY = process.env.RESPOSTAS_API_KEY || 'troque-esta-apikey';
const DATA_DIR = process.env.RESPOSTAS_DATA_DIR || '/data/respostas-rapidas';
const DATA_FILE = path.join(DATA_DIR, 'respostas.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const LOJAS_VALIDAS = ['AMBTOTAL', 'GIRASSOL', 'GIMPO'];
const CATEGORIAS_VALIDAS = ['mensagens', 'reclamacoes', 'pos-venda', 'geral'];

// ============================================================
// INICIALIZAÇÃO DE ARQUIVOS
// ============================================================

function inicializar() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[respostas-rapidas] Diretório criado: ${DATA_DIR}`);
  }

  if (!fs.existsSync(DATA_FILE)) {
    const inicial = {
      respostas: [
        {
          id: Date.now().toString(),
          loja: 'AMBTOTAL',
          categoria: 'mensagens',
          titulo: 'Exemplo - Apague depois',
          texto: 'Olá! Obrigado pelo contato. Vou verificar e retorno em breve.',
          ordem: 0,
          criadoEm: new Date().toISOString()
        }
      ]
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(inicial, null, 2));
    console.log(`[respostas-rapidas] Arquivo de dados inicial criado`);
  }

  if (!fs.existsSync(USERS_FILE)) {
    const senhaPadrao = bcrypt.hashSync('admin123', 10);
    const users = {
      users: [
        { username: 'admin', passwordHash: senhaPadrao, role: 'admin' }
      ]
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    console.log('[respostas-rapidas] ⚠️  Usuário inicial: admin / admin123 - TROQUE A SENHA!');
  }
}

inicializar();

// ============================================================
// HELPERS
// ============================================================

function lerRespostas() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    return { respostas: [] };
  }
}

function salvarRespostas(dados) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(dados, null, 2));
}

function lerUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    return { users: [] };
  }
}

function salvarUsers(dados) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(dados, null, 2));
}

// ============================================================
// MIDDLEWARES
// ============================================================

// Auth via JWT (painel web)
function autenticarJWT(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ erro: 'Token ausente' });
  }
  const token = auth.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.respostasUser = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ erro: 'Token inválido' });
  }
}

// Auth via API_KEY (extensão Chrome)
function autenticarApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (apiKey !== API_KEY) {
    return res.status(401).json({ erro: 'API key inválida' });
  }
  next();
}

// ============================================================
// ROTAS - AUTH
// ============================================================

router.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ erro: 'username e password obrigatórios' });
  }
  const { users } = lerUsers();
  const user = users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ erro: 'Credenciais inválidas' });
  }
  const token = jwt.sign(
    { username: user.username, role: user.role, modulo: 'respostas-rapidas' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ token, username: user.username, role: user.role });
});

router.post('/api/trocar-senha', autenticarJWT, (req, res) => {
  const { senhaAtual, senhaNova } = req.body || {};
  if (!senhaAtual || !senhaNova) {
    return res.status(400).json({ erro: 'senhaAtual e senhaNova obrigatórios' });
  }
  if (senhaNova.length < 6) {
    return res.status(400).json({ erro: 'Senha nova deve ter ao menos 6 caracteres' });
  }
  const dados = lerUsers();
  const user = dados.users.find(u => u.username === req.respostasUser.username);
  if (!user || !bcrypt.compareSync(senhaAtual, user.passwordHash)) {
    return res.status(401).json({ erro: 'Senha atual incorreta' });
  }
  user.passwordHash = bcrypt.hashSync(senhaNova, 10);
  salvarUsers(dados);
  res.json({ ok: true });
});

// ============================================================
// ROTAS - PAINEL (JWT)
// ============================================================

router.get('/api/admin/respostas', autenticarJWT, (req, res) => {
  const { respostas } = lerRespostas();
  res.json({ respostas });
});

router.post('/api/admin/respostas', autenticarJWT, (req, res) => {
  const { loja, categoria, titulo, texto } = req.body || {};
  if (!loja || !categoria || !titulo || !texto) {
    return res.status(400).json({ erro: 'loja, categoria, titulo e texto são obrigatórios' });
  }
  if (!LOJAS_VALIDAS.includes(loja)) {
    return res.status(400).json({ erro: `Loja inválida. Use: ${LOJAS_VALIDAS.join(', ')}` });
  }
  if (!CATEGORIAS_VALIDAS.includes(categoria)) {
    return res.status(400).json({ erro: `Categoria inválida. Use: ${CATEGORIAS_VALIDAS.join(', ')}` });
  }
  const dados = lerRespostas();
  const novaOrdem = dados.respostas
    .filter(r => r.loja === loja && r.categoria === categoria)
    .length;
  const nova = {
    id: Date.now().toString(),
    loja,
    categoria,
    titulo: titulo.trim(),
    texto: texto.trim(),
    ordem: novaOrdem,
    criadoEm: new Date().toISOString()
  };
  dados.respostas.push(nova);
  salvarRespostas(dados);
  res.json(nova);
});

router.put('/api/admin/respostas/:id', autenticarJWT, (req, res) => {
  const { id } = req.params;
  const { loja, categoria, titulo, texto, ordem } = req.body || {};
  const dados = lerRespostas();
  const idx = dados.respostas.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ erro: 'Resposta não encontrada' });
  if (loja !== undefined) {
    if (!LOJAS_VALIDAS.includes(loja)) return res.status(400).json({ erro: 'Loja inválida' });
    dados.respostas[idx].loja = loja;
  }
  if (categoria !== undefined) {
    if (!CATEGORIAS_VALIDAS.includes(categoria)) return res.status(400).json({ erro: 'Categoria inválida' });
    dados.respostas[idx].categoria = categoria;
  }
  if (titulo !== undefined) dados.respostas[idx].titulo = titulo.trim();
  if (texto !== undefined) dados.respostas[idx].texto = texto.trim();
  if (ordem !== undefined) dados.respostas[idx].ordem = Number(ordem);
  dados.respostas[idx].editadoEm = new Date().toISOString();
  salvarRespostas(dados);
  res.json(dados.respostas[idx]);
});

router.delete('/api/admin/respostas/:id', autenticarJWT, (req, res) => {
  const { id } = req.params;
  const dados = lerRespostas();
  const tamanhoAntes = dados.respostas.length;
  dados.respostas = dados.respostas.filter(r => r.id !== id);
  if (dados.respostas.length === tamanhoAntes) {
    return res.status(404).json({ erro: 'Resposta não encontrada' });
  }
  salvarRespostas(dados);
  res.json({ ok: true });
});

router.post('/api/admin/respostas/reordenar', autenticarJWT, (req, res) => {
  const { ids } = req.body || {};
  if (!Array.isArray(ids)) return res.status(400).json({ erro: 'ids deve ser array' });
  const dados = lerRespostas();
  ids.forEach((id, ordem) => {
    const r = dados.respostas.find(x => x.id === id);
    if (r) r.ordem = ordem;
  });
  salvarRespostas(dados);
  res.json({ ok: true });
});

// ============================================================
// ROTAS - API PÚBLICA (extensão Chrome, API_KEY)
// ============================================================

router.get('/api/respostas', autenticarApiKey, (req, res) => {
  const { loja, categoria } = req.query;
  if (!loja) return res.status(400).json({ erro: 'parâmetro loja obrigatório' });
  const { respostas } = lerRespostas();
  let filtradas = respostas.filter(r => r.loja === loja);
  if (categoria) {
    filtradas = filtradas.filter(r => r.categoria === categoria || r.categoria === 'geral');
  }
  filtradas.sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
  res.json({ respostas: filtradas });
});

// ============================================================
// PAINEL WEB - serve estaticamente
// ============================================================

router.use('/painel', express.static(path.join(__dirname, 'painel')));

// Healthcheck do módulo
router.get('/healthz', (req, res) => {
  res.json({ ok: true, modulo: 'respostas-rapidas', ts: Date.now() });
});

// Root → redireciona pro painel
router.get('/', (req, res) => {
  res.redirect('/respostas-rapidas/painel/');
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;
