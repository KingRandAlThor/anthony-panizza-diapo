const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin';

// État : liste de diapos/sondages, index actif, votes
let state = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : {
  polls: [
    { id: 1, question: 'Une machine peut simuler pour vous une vie parfaitement heureuse, sans que vous sachiez que c\'est une simulation. Vous branchez-vous ?', options: ['Oui, je me branche', 'Non, je reste dans la réalité', 'Je ne sais pas'] },
    { id: 2, question: 'Et si votre vie actuelle était déjà dans la machine ?', options: ['Je veux en sortir', 'Je reste dedans', 'Ça ne change rien'] },
    { id: 3, question: 'Pourquoi refuser la machine ? (la raison principale)', options: ['Je veux vivre des choses réelles', 'Je veux agir, pas seulement ressentir', 'Je veux être une certaine personne', 'Je ne refuse pas'] },
    { id: 4, question: 'Le plaisir est-il le seul bien en soi ?', options: ['Oui', 'Non', 'Ça dépend'] },
    { id: 5, question: 'Pour un proche très malheureux, le brancheriez-vous (sans son accord) ?', options: ['Oui', 'Non'] },
  ],
  current: 0, open: true, votes: {}, // votes[pollId] = { optionIndex: count }
};
const voters = {}; // voters[pollId] = Set(clientId) -> un vote par appareil
const save = () => fs.writeFileSync(DATA, JSON.stringify(state, null, 2));

const publicState = () => {
  const p = state.polls[state.current] || null;
  const v = p ? state.votes[p.id] || {} : {};
  return { poll: p, index: state.current, total: state.polls.length, open: state.open,
    counts: p ? p.options.map((_, i) => v[i] || 0) : [] };
};

const clients = new Set();
const broadcast = () => {
  const msg = `data: ${JSON.stringify(publicState())}\n\n`;
  clients.forEach(c => c.write(msg));
};

const lanIP = () => {
  for (const l of Object.values(os.networkInterfaces()))
    for (const i of l) if (i.family === 'IPv4' && !i.internal && (i.address.startsWith('192.168.') || i.address.startsWith('10.') || i.address.startsWith('172.'))) return i.address;
  return 'localhost';
};
const baseUrl = req => {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const host = req?.headers?.host;
  if (host && !/^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(host)) return `${req.headers['x-forwarded-proto'] || 'https'}://${host}`;
  return `http://${lanIP()}:${PORT}`;
};

const body = req => new Promise(r => { let b = ''; req.on('data', d => b += d); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const isAdmin = (req, u) => (req.headers['x-admin-key'] || u.searchParams.get('key')) === ADMIN_KEY;

const pages = { '/': 'vote.html', '/vote': 'vote.html', '/admin': 'admin.html', '/screen': 'screen.html' };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (pages[p]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(__dirname, 'public', pages[p]))); }

  if (p === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }

  if (p === '/qr.svg') {
    const svg = await QRCode.toString(baseUrl(req) + '/vote', { type: 'svg', margin: 1 });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(svg);
  }
  if (p === '/api/info') return json(res, 200, { url: baseUrl(req) + '/vote' });

  if (p === '/api/vote' && req.method === 'POST') {
    const { pollId, option, clientId } = await body(req);
    const cur = state.polls[state.current];
    if (!cur || cur.id !== pollId || !state.open || !clientId || !(option >= 0 && option < cur.options.length))
      return json(res, 400, { error: 'Vote refusé' });
    const set = voters[pollId] ||= new Set();
    if (set.has(clientId)) return json(res, 409, { error: 'Déjà voté' });
    set.add(clientId);
    const v = state.votes[pollId] ||= {};
    v[option] = (v[option] || 0) + 1;
    save(); broadcast(); return json(res, 200, { ok: true });
  }

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req, u)) return json(res, 401, { error: 'Clé admin invalide' });
    if (p === '/api/admin/state') return json(res, 200, { ...publicState(), polls: state.polls });
    const b = await body(req);
    if (p === '/api/admin/goto') state.current = Math.max(0, Math.min(state.polls.length - 1, b.index | 0));
    else if (p === '/api/admin/open') state.open = !!b.open;
    else if (p === '/api/admin/reset') { const id = state.polls[state.current]?.id; delete state.votes[id]; delete voters[id]; }
    else if (p === '/api/admin/polls') {
      state.polls = (b.polls || []).filter(x => x.question && x.options?.length >= 2)
        .map((x, i) => ({ id: x.id || Date.now() + i, question: String(x.question), options: x.options.map(String) }));
      state.current = Math.min(state.current, Math.max(0, state.polls.length - 1));
    } else return json(res, 404, {});
    save(); broadcast(); return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('Not found');
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Écran projeté : http://localhost:${PORT}/screen`);
  console.log(`Contrôle      : http://localhost:${PORT}/admin  (clé: ${ADMIN_KEY})`);
  console.log(`Votants       : ${baseUrl()}/vote`);
});
