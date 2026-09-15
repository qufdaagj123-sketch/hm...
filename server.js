/**
 * NightHub - Discord Bot Host
 * Hỗ trợ Node.js + Python | Dán code / Upload file
 * Chạy: npm install && npm start → http://localhost:3000
 *
 * LƯU Ý: Bản này không có đăng nhập (dùng local / VPS riêng).
 * Không public internet nếu chưa thêm bảo mật.
 */

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const archiver = require('archiver');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const BOTS_DIR = path.join(ROOT, 'bots');
const DATA_FILE = path.join(ROOT, 'data', 'bots.json');

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(path.join(ROOT, 'data'))) fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '{}');

app.use(cors());
app.use(bodyParser.json({ limit: '12mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(ROOT, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

const running = new Map(); // id -> { process }
const botLogs = new Map(); // id -> [{ type, text, time }]  (giữ log cả khi bot stop)

function readBots() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}
function writeBots(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function pushLog(id, type, text) {
  if (!botLogs.has(id)) botLogs.set(id, []);
  const logs = botLogs.get(id);
  logs.push({ type, text: String(text).replace(/\r/g, ''), time: Date.now() });
  if (logs.length > 400) logs.shift();
}

const NODE_SAMPLE = `const { Client, GatewayIntentBits } = require('discord.js');

// Dán token của bạn vào đây
const TOKEN = 'PASTE_YOUR_BOT_TOKEN_HERE';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once('ready', () => {
  console.log('✅ Bot online: ' + client.user.tag);
});

client.on('messageCreate', (msg) => {
  if (msg.author.bot) return;
  if (msg.content === '!ping') msg.reply('Pong! 🏓 (NightHub Node.js)');
  if (msg.content === '!help') msg.reply('Lệnh: !ping, !help');
});

client.login(TOKEN);
`;

const PYTHON_SAMPLE = `import discord
from discord.ext import commands

# Dán token của bạn vào đây
TOKEN = "PASTE_YOUR_BOT_TOKEN_HERE"

intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix="!", intents=intents)

@bot.event
async def on_ready():
    print(f"✅ Bot online: {bot.user}")

@bot.command()
async def ping(ctx):
    await ctx.send("Pong! 🏓 (NightHub Python)")

@bot.command()
async def help(ctx):
    await ctx.send("Lệnh: !ping, !help")

bot.run(TOKEN)
`;

// ===== API =====
app.get('/api/bots', (req, res) => {
  const meta = readBots();
  const list = Object.values(meta).map(b => ({
    ...b,
    running: running.has(b.id)
  }));
  res.json(list);
});

app.post('/api/bots', (req, res) => {
  try {
    const { name, language, code, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Thiếu tên bot' });
    const lang = (language || 'node').toLowerCase();
    if (!['node', 'python'].includes(lang)) {
      return res.status(400).json({ error: 'Chỉ hỗ trợ node hoặc python' });
    }

    const id = uuidv4();
    const botDir = path.join(BOTS_DIR, id);
    fs.mkdirSync(botDir, { recursive: true });

    const finalCode = (typeof code === 'string' && code.trim())
      ? code
      : (lang === 'python' ? PYTHON_SAMPLE : NODE_SAMPLE);

    if (lang === 'node') {
      fs.writeFileSync(path.join(botDir, 'index.js'), finalCode);
      fs.writeFileSync(path.join(botDir, 'package.json'), JSON.stringify({
        name: String(name).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'bot',
        version: '1.0.0',
        main: 'index.js',
        dependencies: { 'discord.js': '^14.16.3' }
      }, null, 2));
    } else {
      fs.writeFileSync(path.join(botDir, 'bot.py'), finalCode);
      fs.writeFileSync(path.join(botDir, 'requirements.txt'), 'discord.py>=2.3.2\n');
    }

    const meta = readBots();
    meta[id] = {
      id,
      name,
      language: lang,
      description: description || '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'stopped'
    };
    writeBots(meta);
    res.json({ success: true, bot: { id, name, language: lang } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Tạo bot thất bại' });
  }
});

// Upload file .js / .py
app.post('/api/bots/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Chưa chọn file' });
    const original = req.file.originalname || '';
    const ext = path.extname(original).toLowerCase();
    let lang = 'node';
    if (ext === '.py') lang = 'python';
    else if (ext === '.js' || ext === '.mjs' || ext === '.cjs') lang = 'node';
    else return res.status(400).json({ error: 'Chỉ chấp nhận .js hoặc .py' });

    const name = (req.body.name || original.replace(ext, '') || 'Uploaded Bot').slice(0, 60);
    const code = req.file.buffer.toString('utf8');

    const id = uuidv4();
    const botDir = path.join(BOTS_DIR, id);
    fs.mkdirSync(botDir, { recursive: true });

    if (lang === 'node') {
      fs.writeFileSync(path.join(botDir, 'index.js'), code);
      fs.writeFileSync(path.join(botDir, 'package.json'), JSON.stringify({
        name: 'uploaded-bot',
        version: '1.0.0',
        main: 'index.js',
        dependencies: { 'discord.js': '^14.16.3' }
      }, null, 2));
    } else {
      fs.writeFileSync(path.join(botDir, 'bot.py'), code);
      fs.writeFileSync(path.join(botDir, 'requirements.txt'), 'discord.py>=2.3.2\n');
    }

    const meta = readBots();
    meta[id] = {
      id,
      name,
      language: lang,
      description: 'Uploaded: ' + original,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'stopped'
    };
    writeBots(meta);
    res.json({ success: true, bot: { id, name, language: lang } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload thất bại' });
  }
});

app.get('/api/bots/:id', (req, res) => {
  const meta = readBots();
  const bot = meta[req.params.id];
  if (!bot) return res.status(404).json({ error: 'Không tìm thấy bot' });
  const botDir = path.join(BOTS_DIR, bot.id);
  let code = '', filename = 'index.js';
  if (bot.language === 'python') {
    filename = 'bot.py';
    const p = path.join(botDir, 'bot.py');
    if (fs.existsSync(p)) code = fs.readFileSync(p, 'utf8');
  } else {
    const p = path.join(botDir, 'index.js');
    if (fs.existsSync(p)) code = fs.readFileSync(p, 'utf8');
  }
  res.json({ ...bot, code, filename, running: running.has(bot.id) });
});

app.put('/api/bots/:id/code', (req, res) => {
  const meta = readBots();
  const bot = meta[req.params.id];
  if (!bot) return res.status(404).json({ error: 'Không tìm thấy bot' });
  const { code } = req.body;
  if (typeof code !== 'string') return res.status(400).json({ error: 'Code không hợp lệ' });
  const file = bot.language === 'python' ? 'bot.py' : 'index.js';
  fs.writeFileSync(path.join(BOTS_DIR, bot.id, file), code);
  bot.updatedAt = Date.now();
  writeBots(meta);
  res.json({ success: true });
});

app.put('/api/bots/:id', (req, res) => {
  const meta = readBots();
  const bot = meta[req.params.id];
  if (!bot) return res.status(404).json({ error: 'Không tìm thấy bot' });
  if (req.body.name) bot.name = req.body.name;
  if (req.body.description !== undefined) bot.description = req.body.description;
  bot.updatedAt = Date.now();
  writeBots(meta);
  res.json({ success: true });
});

app.delete('/api/bots/:id', (req, res) => {
  const meta = readBots();
  const bot = meta[req.params.id];
  if (!bot) return res.status(404).json({ error: 'Không tìm thấy bot' });
  if (running.has(bot.id)) {
    try { running.get(bot.id).process.kill('SIGTERM'); } catch {}
    running.delete(bot.id);
  }
  const dir = path.join(BOTS_DIR, bot.id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  delete meta[bot.id];
  writeBots(meta);
  res.json({ success: true });
});

app.post('/api/bots/:id/start', (req, res) => {
  const meta = readBots();
  const bot = meta[req.params.id];
  if (!bot) return res.status(404).json({ error: 'Không tìm thấy bot' });
  if (running.has(bot.id)) return res.status(400).json({ error: 'Bot đang chạy' });

  const botDir = path.join(BOTS_DIR, bot.id);

  try {
    // Xóa log cũ khi start mới (tuỳ chọn: comment nếu muốn giữ full history)
    botLogs.set(bot.id, []);
    pushLog(bot.id, 'sys', `▶ Đang start bot (${bot.language})...`);

    if (bot.language === 'node') {
      const indexPath = path.join(botDir, 'index.js');
      if (!fs.existsSync(indexPath)) {
        pushLog(bot.id, 'err', 'Không tìm thấy index.js');
        return res.status(400).json({ error: 'Không tìm thấy index.js' });
      }
      if (!fs.existsSync(path.join(botDir, 'node_modules'))) {
        pushLog(bot.id, 'sys', 'Đang npm install (lần đầu có thể mất 30–60s)...');
        try {
          execSync('npm install --omit=dev', { cwd: botDir, stdio: 'pipe', timeout: 180000 });
          pushLog(bot.id, 'sys', 'npm install xong');
        } catch (e) {
          pushLog(bot.id, 'err', 'npm install lỗi: ' + (e.message || e).toString().slice(0, 200));
        }
      }
      const child = spawn('node', ['index.js'], {
        cwd: botDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      running.set(bot.id, { process: child });
      child.stdout.on('data', d => pushLog(bot.id, 'out', d));
      child.stderr.on('data', d => pushLog(bot.id, 'err', d));
      child.on('close', code => {
        pushLog(bot.id, 'sys', `Process exited với code ${code}`);
        running.delete(bot.id);
        bot.status = 'stopped';
        writeBots(meta);
      });
      child.on('error', err => {
        pushLog(bot.id, 'err', 'Start failed: ' + err.message);
        running.delete(bot.id);
        bot.status = 'stopped';
        writeBots(meta);
      });
    } else {
      const pyPath = path.join(botDir, 'bot.py');
      if (!fs.existsSync(pyPath)) {
        pushLog(bot.id, 'err', 'Không tìm thấy bot.py');
        return res.status(400).json({ error: 'Không tìm thấy bot.py' });
      }
      try {
        if (fs.existsSync(path.join(botDir, 'requirements.txt'))) {
          pushLog(bot.id, 'sys', 'Đang pip install...');
          execSync('pip3 install -r requirements.txt --user -q', {
            cwd: botDir, stdio: 'pipe', timeout: 180000
          });
          pushLog(bot.id, 'sys', 'pip install xong');
        }
      } catch (e) {
        pushLog(bot.id, 'err', 'pip install cảnh báo: ' + (e.message || '').toString().slice(0, 150));
      }

      const py = process.platform === 'win32' ? 'python' : 'python3';
      const child = spawn(py, ['bot.py'], {
        cwd: botDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      running.set(bot.id, { process: child });
      child.stdout.on('data', d => pushLog(bot.id, 'out', d));
      child.stderr.on('data', d => pushLog(bot.id, 'err', d));
      child.on('close', code => {
        pushLog(bot.id, 'sys', `Process exited với code ${code}`);
        running.delete(bot.id);
        bot.status = 'stopped';
        writeBots(meta);
      });
      child.on('error', err => {
        pushLog(bot.id, 'err', 'Start failed: ' + err.message + ' (đã cài Python chưa?)');
        running.delete(bot.id);
        bot.status = 'stopped';
        writeBots(meta);
      });
    }

    bot.status = 'running';
    writeBots(meta);
    pushLog(bot.id, 'sys', 'Process đã được tạo. Đợi bot login Discord...');
    pushLog(bot.id, 'sys', 'Nếu không thấy "Bot online" → kiểm tra TOKEN trong code.');
    res.json({ success: true });
  } catch (e) {
    pushLog(req.params.id, 'err', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bots/:id/stop', (req, res) => {
  const meta = readBots();
  const bot = meta[req.params.id];
  if (!bot) return res.status(404).json({ error: 'Không tìm thấy bot' });
  if (!running.has(bot.id)) return res.status(400).json({ error: 'Bot không chạy' });
  pushLog(bot.id, 'sys', '■ Đang stop...');
  try { running.get(bot.id).process.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (running.has(bot.id)) {
      try { running.get(bot.id).process.kill('SIGKILL'); } catch {}
      running.delete(bot.id);
    }
  }, 2000);
  running.delete(bot.id);
  bot.status = 'stopped';
  writeBots(meta);
  pushLog(bot.id, 'sys', '■ Đã stop');
  res.json({ success: true });
});

app.get('/api/bots/:id/logs', (req, res) => {
  const meta = readBots();
  if (!meta[req.params.id]) return res.status(404).json({ error: 'Không tìm thấy' });
  res.json(botLogs.get(req.params.id) || []);
});

app.get('/api/bots/:id/download', (req, res) => {
  const meta = readBots();
  const bot = meta[req.params.id];
  if (!bot) return res.status(404).json({ error: 'Không tìm thấy' });
  const botDir = path.join(BOTS_DIR, bot.id);
  if (!fs.existsSync(botDir)) return res.status(404).json({ error: 'Không có file' });

  const safe = (bot.name || 'bot').replace(/[^a-zA-Z0-9-_]/g, '_');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-${bot.language}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', () => res.status(500).end());
  archive.pipe(res);
  archive.glob('**/*', {
    cwd: botDir,
    ignore: ['node_modules/**', '**/__pycache__/**', '**/*.pyc']
  });
  archive.finalize();
});

app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🌙 NightHub đang chạy: http://localhost:${PORT}\n`);
});
