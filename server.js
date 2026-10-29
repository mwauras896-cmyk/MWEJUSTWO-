// MWEJUSTWO backend: registration, directory, M-Pesa STK push, chairman admin.
const express = require('express'), cors = require('cors'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express(); app.use(cors()); app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Lets the Android app (APK) open full screen without a browser bar: paste the JSON from PWABuilder into the ASSETLINKS_JSON setting in Render.
app.get('/.well-known/assetlinks.json', (_, res) => process.env.ASSETLINKS_JSON ? res.type('json').send(process.env.ASSETLINKS_JSON) : res.sendStatus(404));

// --- storage (JSON file). On Render free tier disk resets: attach a disk or swap for Supabase/MongoDB.
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');   // only used if Supabase is not configured
const ZONES = ['Thiba', 'Murinduko'];
const DEFAULT_LEADERS = [
  { name: 'Samuel Mwangi', role: 'Chairman', phone: '0728065957' }, { name: 'Ellah Muthoni', role: 'Vice Chairperson', phone: '0704710176' },
  { name: 'Dennis Bundi', role: 'Secretary', phone: '0717829021' }, { name: 'Sarah Muringo', role: 'Vice Secretary', phone: '0707422653' },
  { name: 'Edwin Njagi', role: 'Treasurer', phone: '0704436780' }, { name: 'Bonface Ndambiri', role: 'Organizing Secretary', phone: '0728508108' },
  { name: 'Jane Muriithi', role: 'Thiba Zone Representative', phone: '0729668617' }, { name: 'Antony Ndumbi', role: 'Murinduko Zone Representative', phone: '0748793533' },
  { name: 'Charles Kariuki', role: 'PLWD Representative', phone: '0751577974' }];

// --- storage: Supabase (permanent) via REST. Whole app data is one JSON row in mwe_store; certificate photos go in mwe_files.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), SB_KEY = process.env.SUPABASE_KEY || '', USE_SB = !!(SB_URL && SB_KEY);
const sb = async (p, opts = {}) => {
  const r = await fetch(SB_URL + '/rest/v1/' + p, { ...opts, headers: { apikey: SB_KEY, ...(SB_KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + SB_KEY } : {}), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error('Supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json().catch(() => null);
};
let db = { members: [], payments: [], cases: [] };
async function loadDb() {
  if (USE_SB) { const rows = await sb('mwe_store?key=eq.main&select=value'); if (rows && rows[0]) db = rows[0].value; console.log('Data loaded from Supabase'); }
  else { console.log('WARNING: SUPABASE_URL / SUPABASE_KEY not set. Using a local file; data is LOST when Render redeploys.'); if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE)); }
  db.members = db.members || []; db.payments = db.payments || []; db.cases = db.cases || []; db.certNames = db.certNames || []; db.posts = db.posts || []; db.ledger = db.ledger || []; db.postImgs = db.postImgs || []; db.idNames = db.idNames || []; db.leaders = db.leaders || DEFAULT_LEADERS; db.caseSubmissions = db.caseSubmissions || []; db.caseRequests = db.caseRequests || []; db.caseRequests = db.caseRequests || []; db.caseRequests = db.caseRequests || [];
  let newIds = false; db.leaders.forEach(l => { if (!l.id) { l.id = crypto.randomUUID(); newIds = true; } }); if (newIds) save();
}
let dirty = false, saving = false, timer = null;
async function flush() {
  if (saving) return; saving = true;
  try { while (dirty) { dirty = false;
    if (USE_SB) await sb('mwe_store', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'main', value: db }) });
    else fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); } }
  catch (e) { console.error('SAVE FAILED:', e.message); dirty = true; setTimeout(flush, 5000); }
  saving = false;
}
const save = () => { dirty = true; clearTimeout(timer); timer = setTimeout(flush, 300); };
process.on('SIGTERM', async () => { clearTimeout(timer); while (saving) await new Promise(r => setTimeout(r, 100)); await flush(); process.exit(0); });

const normPhone = p => { p = String(p || '').replace(/\D/g, ''); if (/^0[17]\d{8}$/.test(p)) return '254' + p.slice(1); if (/^254[17]\d{8}$/.test(p)) return p; return null; };
const clean = s => String(s || '').trim().replace(/[<>]/g, '').slice(0, 80);

// --- admin sessions (roles: chairman, treasurer)
const sessions = new Map();
const admin = (...roles) => (req, res, next) => {
  const x = sessions.get(req.headers['x-admin-token']);
  if (x && x.exp > Date.now() && roles.includes(x.role) && (x.role !== 'leader' || db.leaders.some(l => l.id === x.lid && !l.dismissed))) { req.role = x.role; req.sess = x; return next(); }
  res.status(401).json({ error: 'Not allowed for your role' });
};
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
let fails = 0, lockUntil = 0;
app.post('/api/admin/login', (req, res) => {
  if (Date.now() < lockUntil) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const pin = String(req.body.pin || ''), pins = { chairman: String(process.env.ADMIN_PIN || ''), treasurer: String(process.env.TREASURER_PIN || '') };
  const role = ['chairman', 'treasurer'].find(r => pins[r] && same(pin, pins[r]));
  if (!role) { if (++fails >= 5) { lockUntil = Date.now() + 5 * 60000; fails = 0; } return res.status(403).json({ error: 'Wrong PIN' }); }
  fails = 0; const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, { role, exp: Date.now() + 2 * 3600e3 }); res.json({ token: t, role });
});

// --- members
app.get('/api/health', (_, res) => res.json({ ok: true, storage: USE_SB ? 'supabase' : 'local file (not permanent)' }));
app.get('/api/members', (_, res) => res.json(db.members.filter(m => m.status !== 'Dismissed').map(m => ({ id: m.id, name: m.name, school: m.school, zone: m.zone || '', status: m.status }))));
// Public tally: every registered member who has not been dismissed, plus any official who is not registered as a member (officials are members too). Numbers only.
app.get('/api/stats', (_, res) => {
  const ms = db.members.filter(m => m.status !== 'Dismissed'), phones = new Set(ms.flatMap(m => phonesOf(m)));
  const extra = db.leaders.filter(l => !l.dismissed && !phones.has(normPhone(l.phone))).length;
  res.json({ members: ms.length + extra, verified: ms.filter(m => m.status === 'Verified').length });
});
app.post('/api/members', async (req, res) => {
  const name = clean(req.body.name), school = clean(req.body.school), phone = normPhone(req.body.phone);
  if (name.length < 3 || !school) return res.status(400).json({ error: 'Enter your full name and school/zone.' });
  if (!phone) return res.status(400).json({ error: 'Enter a valid Safaricom/Airtel number, e.g. 0712345678.' });
  const zone = ZONES.includes(req.body.zone) ? req.body.zone : null;
  if (!zone) return res.status(400).json({ error: 'Choose your zone: Thiba or Murinduko.' });
  const regNo = clean(req.body.regNo).toUpperCase().slice(0, 20), idNo = clean(req.body.idNo).replace(/\s/g, '').slice(0, 15);
  if (regNo.length < 3) return res.status(400).json({ error: 'Enter your registration number.' });
  if (!/^\d{6,10}$/.test(idNo)) return res.status(400).json({ error: 'Enter your national ID number (digits only).' });
  const pin = String(req.body.pin || '');
  if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'Choose a PIN of 4 to 6 digits. You will use it to edit your next of kin.' });
  if (!req.body.idFront || !req.body.idBack) return res.status(400).json({ error: 'Take clear photos of the front and back of your ID card.' });
  if (db.members.some(m => m.phone === phone)) return res.status(409).json({ error: 'This phone number is already registered.' });
  if (db.members.some(m => m.idNo === idNo)) return res.status(409).json({ error: 'This ID number is already registered.' });
  if (db.members.some(m => m.regNo === regNo)) return res.status(409).json({ error: 'This registration number is already registered.' });
  let idFront = '', idBack = '';
  try { idFront = await putId(req.body.idFront); idBack = await putId(req.body.idBack); }
  catch (e) { await dropId(idFront); return res.status(400).json({ error: idErr(e) }); }
  db.members.push({ id: crypto.randomUUID(), name, school, zone, phone, regNo, idNo, idFront, idBack, idAt: new Date().toISOString(), status: 'Pending', pinHash: hashPin(pin), kin: [], kinLocked: false, created: new Date().toISOString() }); save();
  res.json({ message: 'Registered. The Chairman will verify your membership.' });
});
app.get('/api/admin/members', admin('chairman'), (_, res) => res.json(db.members.map(({ pinHash, kin, ...m }) => ({ ...m, kinCount: (kin || []).length, kinLocked: !!m.kinLocked }))));
app.post('/api/admin/members/:id/edit', admin('chairman'), (req, res) => {
  const m = db.members.find(x => x.id === req.params.id); if (!m) return res.sendStatus(404);
  const name = clean(req.body.name), school = clean(req.body.school), phone = normPhone(req.body.phone), zone = ZONES.includes(req.body.zone) ? req.body.zone : null;
  const regNo = clean(req.body.regNo).toUpperCase().slice(0, 20), idNo = clean(req.body.idNo).replace(/\s/g, '').slice(0, 15);
  if (name.length < 3 || !school) return res.status(400).json({ error: 'Enter the full name and working station.' });
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number.' });
  if (!zone) return res.status(400).json({ error: 'Choose Thiba or Murinduko.' });
  if (regNo.length < 3) return res.status(400).json({ error: 'Enter the registration number.' });
  if (!/^\d{6,10}$/.test(idNo)) return res.status(400).json({ error: 'Enter the national ID number (digits only).' });
  const others = db.members.filter(x => x !== m);
  if (others.some(x => phonesOf(x).includes(phone))) return res.status(409).json({ error: 'Another member already uses this phone number.' });
  if (others.some(x => x.idNo === idNo)) return res.status(409).json({ error: 'Another member already has this ID number.' });
  if (others.some(x => x.regNo === regNo)) return res.status(409).json({ error: 'Another member already has this registration number.' });
  if (phone !== m.phone) { m.prevPhones = [...new Set([...(m.prevPhones || []), m.phone])]; m.phone = phone; }   // old number kept so payment history still matches
  Object.assign(m, { name, school, zone, regNo, idNo }); save(); res.json({ ok: true });
});
app.post('/api/admin/members/:id/dismiss', admin('chairman'), (req, res) => { const m = db.members.find(x => x.id === req.params.id); if (!m) return res.sendStatus(404); m.status = 'Dismissed'; m.dismissedAt = new Date().toISOString(); m.dismissReason = clean(req.body.reason); save(); res.json({ ok: true }); });
app.post('/api/admin/members/:id/reinstate', admin('chairman'), (req, res) => { const m = db.members.find(x => x.id === req.params.id); if (!m) return res.sendStatus(404); m.status = 'Verified'; delete m.dismissedAt; delete m.dismissReason; save(); res.json({ ok: true }); });
app.post('/api/admin/members/:id/verify', admin('chairman'), (req, res) => { const m = db.members.find(x => x.id === req.params.id); if (!m) return res.sendStatus(404); m.status = 'Verified'; save(); res.json(m); });
app.delete('/api/admin/members/:id', admin('chairman'), async (req, res) => { const m = db.members.find(x => x.id === req.params.id); if (m) { await dropId(m.idFront); await dropId(m.idBack); } db.members = db.members.filter(x => x.id !== req.params.id); save(); res.json({ ok: true }); });
app.get('/api/admin/payments', admin('chairman', 'treasurer', 'vicechair'), (_, res) => res.json(db.payments.slice().reverse()));

// --- Chairman reports: registration list and next-of-kin list, as downloadable CSV, plus
// full next-of-kin data for every member (used by the printable report page in officials.html).
const csvEscape = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = rows => rows.map(r => r.map(csvEscape).join(',')).join('\r\n');
app.get('/api/admin/export/members.csv', admin('chairman'), (_, res) => {
  const header = ['Name', 'Registration No.', 'ID Number', 'Phone', 'Zone', 'Working Station', 'Status', 'Registered On'];
  const rows = db.members.map(m => [m.name, m.regNo || '', m.idNo || '', '0' + m.phone.slice(3), m.zone || '', m.school, m.status, (m.created || '').slice(0, 10)]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="MWEJUSTWO-Registration-List.csv"');
  res.send(toCsv([header, ...rows]));
});
app.get('/api/admin/export/kin.csv', admin('chairman'), (_, res) => {
  const header = ['Member Name', 'Member Phone', 'Member Zone', 'Relationship', 'Kin Full Name', 'Kin ID/Cert No.', 'Kin Phone', 'Birth Certificate Uploaded'];
  const rows = [];
  db.members.forEach(m => (m.kin || []).forEach(k => rows.push([m.name, '0' + m.phone.slice(3), m.zone || '', k.relation, k.name, k.idNo || '', k.phone || '', k.cert ? 'Yes' : 'No'])));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="MWEJUSTWO-Next-of-Kin-List.csv"');
  res.send(toCsv([header, ...rows]));
});
app.get('/api/admin/kin/all', admin('chairman'), (_, res) => {
  res.json(db.members.map(m => ({ name: m.name, phone: '0' + m.phone.slice(3), zone: m.zone || '', school: m.school, kinLocked: !!m.kinLocked, kin: m.kin || [] })));
});

// --- Next of kin: members edit with phone + PIN until the Chairman locks the list.
const hashPin = (pin, salt = crypto.randomBytes(8).toString('hex')) => salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
const checkPin = (pin, h) => { if (!h) return false; const [salt, hex] = h.split(':'); return same(crypto.scryptSync(String(pin), salt, 32).toString('hex'), hex); };
const KIN = { self: ['Principal member'], family: ['Spouse', 'Child', 'Other nuclear family'], parent: ['Father', 'Mother', 'Guardian'] };
const pinFails = new Map();
function memberAuth(req, res) {
  const phone = normPhone(req.body.phone), f = pinFails.get(phone);
  if (f && f.until > Date.now()) { res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' }); return null; }
  const m = db.members.find(x => x.phone === phone);
  if (m && !m.pinHash) { res.status(403).json({ error: 'No PIN set for you yet. Ask the Chairman to set one.' }); return null; }
  if (!m || !checkPin(req.body.pin, m.pinHash)) { const n = ((f && f.n) || 0) + 1; pinFails.set(phone, { n: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 600000 : 0 }); res.status(403).json({ error: 'Wrong phone number or PIN.' }); return null; }
  if (m.status === 'Dismissed') { res.status(403).json({ error: 'This membership has ended. Please contact the Chairman.' }); return null; }
  pinFails.delete(phone); return m;
}
app.post('/api/kin/get', (req, res) => { const m = memberAuth(req, res); if (m) res.json({ name: m.name, locked: !!m.kinLocked, kin: m.kin || [] }); });
app.post('/api/kin/save', (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  if (m.kinLocked) return res.status(403).json({ error: 'The Chairman has locked your list. Contact him for changes.' });
  const out = [];
  for (const k of (Array.isArray(req.body.kin) ? req.body.kin.slice(0, 30) : [])) {
    if (!KIN[k.group] || !KIN[k.group].includes(k.relation)) return res.status(400).json({ error: 'Invalid relationship.' });
    const name = clean(k.name); if (name.length < 3) return res.status(400).json({ error: 'Enter the full name of everyone you list.' });
    const cert = certOk(k.cert) ? k.cert : '';
    if (k.relation === 'Child' && !cert) return res.status(400).json({ error: 'Upload the birth certificate for ' + name + ' (child).' });
    out.push({ group: k.group, relation: k.relation, name, idNo: clean(k.idNo).slice(0, 20), phone: clean(k.phone).slice(0, 15), cert });
  }
  m.kin = out; save(); res.json({ message: 'Saved. You can keep editing until the Chairman locks the list.' });
});
const CERT_DIR = path.join(path.dirname(FILE), 'certs');
const certOk = f => typeof f === 'string' && /^[a-f0-9-]{36}\.(jpg|png)$/.test(f) && (db.certNames || []).includes(f);

// --- National ID photos (front and back): stored privately, only the Chairman can view them.
const idOk = f => typeof f === 'string' && /^[a-f0-9-]{36}\.jpg$/.test(f) && (db.idNames || []).includes(f);
const idErr = e => /^(Take|ID photo|The ID)/.test(e.message) ? e.message : 'Could not store the ID photos. Try again.';
async function putId(dataUrl) {
  const mt = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!mt) throw new Error('Take clear photos of the front and back of your ID card.');
  const buf = Buffer.from(mt[1], 'base64');
  if (buf.length > 1500000) throw new Error('ID photo too large. Retake it a little further from the card.');
  if (buf.length < 5000) throw new Error('The ID photo looks empty. Retake it.');
  const f = crypto.randomUUID() + '.jpg';
  if (USE_SB) await sb('mwe_files', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ name: f, mime: 'image/jpeg', data: mt[1] }) });
  else { fs.mkdirSync(CERT_DIR, { recursive: true }); fs.writeFileSync(path.join(CERT_DIR, f), buf); }
  db.idNames.push(f); return f;
}
async function dropId(f) {
  if (!f) return;
  db.idNames = db.idNames.filter(x => x !== f);
  try { if (USE_SB) await sb('mwe_files?name=eq.' + f, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); else fs.unlinkSync(path.join(CERT_DIR, f)); }
  catch (e) { console.error('ID DELETE:', e.message); }
}
async function replaceId(owner, body) {   // owner: a member or leader record
  let a = '', b = '';
  try { a = await putId(body.idFront); b = await putId(body.idBack); }
  catch (e) { await dropId(a); throw e; }
  await dropId(owner.idFront); await dropId(owner.idBack);
  owner.idFront = a; owner.idBack = b; owner.idAt = new Date().toISOString(); save();
}
app.post('/api/member/id', async (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  try { await replaceId(m, req.body); res.json({ message: 'ID saved. Thank you.' }); } catch (e) { res.status(400).json({ error: idErr(e) }); }
});
app.post('/api/leader/id', admin('leader'), async (req, res) => {
  const l = leaderOf(req); if (!l) return res.sendStatus(403);
  try { await replaceId(l, req.body); res.json({ message: 'ID saved. Thank you.' }); } catch (e) { res.status(400).json({ error: idErr(e) }); }
});
app.get('/api/admin/id/:file', admin('chairman'), async (req, res) => {
  if (!idOk(req.params.file)) return res.sendStatus(404);
  try {
    if (USE_SB) { const r = await sb('mwe_files?name=eq.' + req.params.file + '&select=mime,data'); if (!r || !r[0]) return res.sendStatus(404); res.type(r[0].mime).send(Buffer.from(r[0].data, 'base64')); }
    else res.sendFile(path.join(CERT_DIR, req.params.file));
  } catch (e) { console.error(e.message); res.sendStatus(500); }
});
app.post('/api/kin/cert', async (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  if (m.kinLocked) return res.status(403).json({ error: 'The Chairman has locked your list.' });
  const mt = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image || ''));
  if (!mt) return res.status(400).json({ error: 'Upload a photo (JPG or PNG).' });
  const buf = Buffer.from(mt[2], 'base64'); if (buf.length > 1500000) return res.status(413).json({ error: 'Image too large. Try a smaller photo.' });
  const f = crypto.randomUUID() + (mt[1] === 'png' ? '.png' : '.jpg');
  try {
    if (USE_SB) await sb('mwe_files', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ name: f, mime: 'image/' + (mt[1] === 'png' ? 'png' : 'jpeg'), data: mt[2] }) });
    else { fs.mkdirSync(CERT_DIR, { recursive: true }); fs.writeFileSync(path.join(CERT_DIR, f), buf); }
  } catch (e) { console.error('CERT STORE FAILED:', e.message); return res.status(500).json({ error: 'Could not store the image. Try again.' }); }
  db.certNames.push(f); save(); res.json({ cert: f });
});
app.get('/api/admin/cert/:file', admin('chairman'), async (req, res) => {
  if (!certOk(req.params.file)) return res.sendStatus(404);
  try {
    if (USE_SB) { const r = await sb('mwe_files?name=eq.' + req.params.file + '&select=mime,data'); if (!r || !r[0]) return res.sendStatus(404); res.type(r[0].mime).send(Buffer.from(r[0].data, 'base64')); }
    else res.sendFile(path.join(CERT_DIR, req.params.file));
  } catch (e) { console.error(e.message); res.sendStatus(500); }
});
const memberById = (req, res) => { const m = db.members.find(x => x.id === req.params.id); if (!m) res.sendStatus(404); return m; };
app.get('/api/admin/members/:id/kin', admin('chairman'), (req, res) => { const m = memberById(req, res); if (m) res.json({ name: m.name, locked: !!m.kinLocked, kin: m.kin || [] }); });
app.post('/api/admin/members/:id/lock', admin('chairman'), (req, res) => { const m = memberById(req, res); if (m) { m.kinLocked = !!req.body.locked; save(); res.json({ ok: true }); } });
app.post('/api/admin/kin/lockall', admin('chairman'), (_, res) => { db.members.forEach(m => m.kinLocked = true); save(); res.json({ ok: true }); });
app.post('/api/admin/members/:id/resetpin', admin('chairman'), (req, res) => {
  const m = memberById(req, res); if (!m) return;
  if (!/^\d{4,6}$/.test(String(req.body.pin || ''))) return res.status(400).json({ error: 'PIN must be 4 to 6 digits.' });
  m.pinHash = hashPin(req.body.pin); save(); res.json({ ok: true });
});

app.post('/api/member/summary', (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  const ph = phonesOf(m), mine = db.payments.filter(p => ph.includes(p.phone)).slice().reverse();
  const asLeader = db.leaders.find(l => !l.dismissed && ph.includes(normPhone(l.phone)));
  res.json({ name: m.name, school: m.school, zone: m.zone || '', phone: m.phone, regNo: m.regNo || '', status: m.status, kinLocked: !!m.kinLocked, hasId: !!(m.idFront && m.idBack), title: asLeader ? asLeader.role : '',
    paidTotal: mine.filter(p => p.status === 'Paid').reduce((t, p) => t + p.amount, 0), pending: mine.filter(p => p.status !== 'Paid' && p.status !== 'Failed').length,
    payments: mine.slice(0, 30).map(p => ({ amount: p.amount, status: p.status, caseTitle: p.caseTitle || 'General', code: p.code, created: p.created })),
    caseSubmissions: mySubmissions(m).map(s => ({ title: s.title, kind: s.kind, zone: s.zone, routedTo: ROUTES[s.routedTo], status: s.status, rejectReason: s.rejectReason || '', created: s.created })) });
});

// --- Leaders: own login (phone + PIN set by the Chairman), posting of minutes, notices and accounts.
const canPost = l => ({ minutes: /secretary/i.test(l.role) && !/organi[sz]ing/i.test(l.role), accounts: /treasurer/i.test(l.role), notice: true });
const zoneOf = l => /thiba/i.test(l.role) ? 'Thiba' : /murinduko/i.test(l.role) ? 'Murinduko' : 'All';
const leaderFails = new Map();
const leaderOf = req => db.leaders.find(l => l.id === req.sess.lid && !l.dismissed);
app.post('/api/leader/login', (req, res) => {
  const phone = normPhone(req.body.phone), f = leaderFails.get(phone);
  if (f && f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in 10 minutes.' });
  const l = db.leaders.find(x => !x.dismissed && normPhone(x.phone) === phone);
  if (!l) return res.status(403).json({ error: 'Wrong phone number or PIN. If you have no PIN yet, ask the Chairman.' });   // ordinary members: not counted as a failed attempt
  if (!l.pinHash || !checkPin(req.body.pin, l.pinHash)) { const n = ((f && f.n) || 0) + 1; leaderFails.set(phone, { n: n >= 5 ? 0 : n, until: n >= 5 ? Date.now() + 600000 : 0 }); return res.status(403).json({ error: 'Wrong phone number or PIN. If you have no PIN yet, ask the Chairman.' }); }
  leaderFails.delete(phone);
  const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, { role: 'leader', lid: l.id, exp: Date.now() + 2 * 3600e3 });
  const ar = { Chairman: 'chairman', Treasurer: 'treasurer', 'Vice Chairperson': 'vicechair' }[l.role]; let adminSess;   // the Chairman and Treasurer also get their officials session, so one login opens everything. The Vice Chairperson gets a limited 'vicechair' session: enough to approve/reject case requests, nothing more.
  if (ar) { const at = crypto.randomBytes(24).toString('hex'); sessions.set(at, { role: ar, lid: l.id, exp: Date.now() + 2 * 3600e3 }); adminSess = { token: at, role: ar }; }
  res.json({ token: t, name: l.name, title: l.role, can: { ...canPost(l), remind: !!remindScope(l) }, hasId: !!(l.idFront && l.idBack), admin: adminSess });
});
async function saveImage(dataUrl) {
  const mt = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || '')); if (!mt) return '';
  const buf = Buffer.from(mt[2], 'base64'); if (buf.length > 1500000) throw new Error('Image too large. Try a smaller photo.');
  const f = crypto.randomUUID() + (mt[1] === 'png' ? '.png' : '.jpg');
  if (USE_SB) await sb('mwe_files', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ name: f, mime: 'image/' + (mt[1] === 'png' ? 'png' : 'jpeg'), data: mt[2] }) });
  else { fs.mkdirSync(CERT_DIR, { recursive: true }); fs.writeFileSync(path.join(CERT_DIR, f), buf); }
  db.postImgs.push(f); return f;
}
async function sendImage(res, f) {
  if (USE_SB) { const r = await sb('mwe_files?name=eq.' + f + '&select=mime,data'); if (!r || !r[0]) return res.sendStatus(404); return res.type(r[0].mime).send(Buffer.from(r[0].data, 'base64')); }
  res.sendFile(path.join(CERT_DIR, f));
}
const today = () => new Date().toISOString().slice(0, 10), okDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : today();
app.post('/api/leader/post', admin('leader'), async (req, res) => {
  try {
    const l = leaderOf(req), type = req.body.type;
    if (!['minutes', 'notice'].includes(type) || !canPost(l)[type]) return res.status(403).json({ error: 'Your role cannot post this.' });
    const title = clean(req.body.title), body = String(req.body.body || '').trim().slice(0, 6000);
    if (title.length < 3) return res.status(400).json({ error: 'Enter a title.' });
    if (body.length < 3 && !req.body.image) return res.status(400).json({ error: 'Write the details or attach a photo.' });
    const image = await saveImage(req.body.image);
    db.posts.push({ id: crypto.randomUUID(), type, title, body, date: okDate(req.body.date), image, author: l.name, role: l.role, zone: type === 'notice' ? zoneOf(l) : 'All', created: new Date().toISOString() });
    save(); res.json({ ok: true });
  } catch (e) { console.error('POST FAILED:', e.message); res.status(400).json({ error: e.message.startsWith('Image') ? e.message : 'Could not post. Try again.' }); }
});
// Leaders see their own posts; the Chairman sees every leader's posts.
app.get('/api/leader/posts', admin('leader'), (req, res) => {
  const l = leaderOf(req), chair = /^chairman$/i.test(l.role);
  res.json(db.posts.filter(p => chair || p.author === l.name).slice(-50).reverse().map(({ image, ...p }) => ({ ...p, hasImage: !!image })));
});
async function dropImage(f) {
  db.postImgs = db.postImgs.filter(x => x !== f);
  try {
    if (USE_SB) await sb('mwe_files?name=eq.' + f, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    else fs.unlinkSync(path.join(CERT_DIR, f));
  } catch (e) { console.error('IMAGE DELETE:', e.message); }
}
function postAccess(req, res) {
  const l = leaderOf(req), p = db.posts.find(x => x.id === req.params.id);
  if (!p) { res.status(404).json({ error: 'Post not found.' }); return null; }
  if (p.author !== l.name && !/^chairman$/i.test(l.role)) { res.status(403).json({ error: 'You can only change your own posts.' }); return null; }
  return p;
}
app.post('/api/leader/post/:id/edit', admin('leader'), async (req, res) => {
  try {
    const p = postAccess(req, res); if (!p) return;
    const title = clean(req.body.title), body = String(req.body.body || '').trim().slice(0, 6000), old = p.image;
    if (title.length < 3) return res.status(400).json({ error: 'Enter a title.' });
    let image = old;
    if (req.body.image) image = await saveImage(req.body.image);
    else if (req.body.removeImage) image = '';
    if (body.length < 3 && !image) return res.status(400).json({ error: 'Write the details or keep a photo.' });
    Object.assign(p, { title, body, image, edited: new Date().toISOString() });
    if (old && old !== image) await dropImage(old);
    save(); res.json({ ok: true });
  } catch (e) { console.error('EDIT FAILED:', e.message); res.status(400).json({ error: e.message.startsWith('Image') ? e.message : 'Could not save. Try again.' }); }
});
app.post('/api/leader/post/:id/delete', admin('leader'), async (req, res) => {
  const p = postAccess(req, res); if (!p) return;
  const img = p.image;
  db.posts = db.posts.filter(x => x.id !== p.id);
  if (img) await dropImage(img);
  save(); res.json({ ok: true });
});
const LEDGER_CATS = { in: ['Levy collected', 'Joining / registration fee', 'Donation', 'Other income'], out: ['Case payout', 'Meeting / admin expense', 'Bank / M-Pesa charges', 'Other expense'] };
const caseSummary = () => db.cases.map(c => {
  const paid = db.payments.filter(p => p.caseId === c.id && p.status === 'Paid');
  const net = db.ledger.filter(e => e.caseId === c.id && e.category === 'Case payout').reduce((t, e) => t + (e.kind === 'out' ? e.amount : -e.amount), 0);
  return { id: c.id, title: c.title, kind: c.kind, levy: c.levy, due: c.due, status: c.status, payoutDue: c.payout, contributions: paid.reduce((t, p) => t + p.amount, 0), contributors: paid.length, payoutPaid: net };
}).reverse();
const ledgerView = () => { const e = db.ledger.slice().sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created)); const t = k => e.filter(x => x.kind === k).reduce((s, x) => s + x.amount, 0); return { totalIn: t('in'), totalOut: t('out'), balance: t('in') - t('out'), entries: e.slice(0, 2000), cases: caseSummary() }; };
app.get('/api/leader/ledger', admin('leader'), (req, res) => canPost(leaderOf(req)).accounts ? res.json(ledgerView()) : res.status(403).json({ error: 'Treasurer only.' }));
app.post('/api/leader/ledger', admin('leader'), (req, res) => {
  const l = leaderOf(req); if (!canPost(l).accounts) return res.status(403).json({ error: 'Only the Treasurer posts accounts.' });
  const kind = ['in', 'out'].includes(req.body.kind) ? req.body.kind : null, amount = Math.round(Number(req.body.amount)), desc = clean(req.body.desc);
  if (!kind) return res.status(400).json({ error: 'Choose money in or money out.' });
  if (!(amount >= 1 && amount <= 10000000)) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (desc.length < 3) return res.status(400).json({ error: 'Describe the entry.' });
  const category = LEDGER_CATS[kind].includes(req.body.category) ? req.body.category : null;
  if (!category) return res.status(400).json({ error: 'Choose a category.' });
  const cs = req.body.caseId ? db.cases.find(c => c.id === req.body.caseId) : null;
  if (req.body.caseId && !cs) return res.status(400).json({ error: 'That welfare case was not found.' });
  db.ledger.push({ id: crypto.randomUUID(), date: okDate(req.body.date), kind, amount, desc, category, caseId: cs ? cs.id : '', caseTitle: cs ? cs.title : '', author: l.name, created: new Date().toISOString(), signed: false }); save(); res.json({ ok: true });
});
// Entries are never deleted: a mistake is reversed by a new opposite entry.
app.post('/api/leader/ledger/:id/reverse', admin('leader'), (req, res) => {
  const l = leaderOf(req); if (!canPost(l).accounts) return res.status(403).json({ error: 'Only the Treasurer can do this.' });
  const e = db.ledger.find(x => x.id === req.params.id); if (!e || e.reversed || e.corrects) return res.status(400).json({ error: 'This entry cannot be reversed.' });
  e.reversed = true;
  db.ledger.push({ id: crypto.randomUUID(), date: today(), kind: e.kind === 'in' ? 'out' : 'in', amount: e.amount, desc: 'Reversal of: ' + e.desc, category: e.category || '', caseId: e.caseId || '', caseTitle: e.caseTitle || '', corrects: e.id, author: l.name, created: new Date().toISOString(), signed: false }); save(); res.json({ ok: true });
});
const phonesOf = m => [m.phone, ...(m.prevPhones || [])];
const dropSessions = id => { for (const [t, x] of sessions) if (x.lid === id) sessions.delete(t); };
const unique = r => /^(chairman|treasurer)$/i.test(r);
function leaderFields(b, self) {
  const name = clean(b.name), role = clean(b.role).slice(0, 40), phone = normPhone(b.phone);
  if (name.length < 3) return { error: "Enter the official's full name." };
  if (role.length < 3) return { error: "Enter the official's position." };
  if (!phone) return { error: 'Enter a valid phone number.' };
  const others = db.leaders.filter(l => !l.dismissed && l !== self);
  if (others.some(l => normPhone(l.phone) === phone)) return { error: 'Another official already uses this phone number.' };
  if (unique(role) && others.some(l => l.role.toLowerCase() === role.toLowerCase())) return { error: 'There is already a ' + role + '. Edit that person instead.' };
  return { name, role, phone: '0' + phone.slice(3) };
}
const leaderById = (req, res) => { const l = db.leaders.find(x => x.id === req.params.id); if (!l) res.sendStatus(404); return l; };
app.get('/api/admin/leaders', admin('chairman'), (_, res) => res.json(db.leaders.map(l => ({ id: l.id, name: l.name, role: l.role, phone: l.phone, hasPin: !!l.pinHash, idFront: l.idFront || '', idBack: l.idBack || '', dismissed: !!l.dismissed, dismissReason: l.dismissReason || '' }))));
app.post('/api/admin/leaders', admin('chairman'), (req, res) => {
  const f = leaderFields(req.body, null); if (f.error) return res.status(400).json({ error: f.error });
  db.leaders.push({ id: crypto.randomUUID(), ...f }); save(); res.json({ ok: true });
});
app.post('/api/admin/leaders/:id/edit', admin('chairman'), (req, res) => {
  const l = leaderById(req, res); if (!l) return;
  const f = leaderFields(req.body, l); if (f.error) return res.status(400).json({ error: f.error });
  if (/^chairman$/i.test(l.role) && !/^chairman$/i.test(f.role)) return res.status(400).json({ error: 'The Chairman position cannot be removed. To hand over, change this record to the new Chairman.' });
  const person = f.name !== l.name || f.phone !== l.phone;
  Object.assign(l, f);
  if (person) { delete l.pinHash; dropSessions(l.id); }   // a new person must get a new PIN
  save(); res.json({ ok: true });
});
app.post('/api/admin/leaders/:id/setpin', admin('chairman'), (req, res) => {
  const l = leaderById(req, res); if (!l) return;
  if (l.dismissed) return res.status(400).json({ error: 'This official has been dismissed.' });
  if (!/^\d{4,6}$/.test(String(req.body.pin || ''))) return res.status(400).json({ error: 'PIN must be 4 to 6 digits.' });
  l.pinHash = hashPin(req.body.pin); save(); res.json({ ok: true });
});
app.post('/api/admin/leaders/:id/dismiss', admin('chairman'), (req, res) => {
  const l = leaderById(req, res); if (!l) return;
  if (/^chairman$/i.test(l.role)) return res.status(400).json({ error: 'The Chairman cannot be dismissed here. To hand over, edit this record to the new Chairman.' });
  l.dismissed = true; l.dismissedAt = new Date().toISOString(); l.dismissReason = clean(req.body.reason); delete l.pinHash; dropSessions(l.id); save(); res.json({ ok: true });
});
app.post('/api/admin/leaders/:id/reinstate', admin('chairman'), (req, res) => {
  const l = leaderById(req, res); if (!l) return;
  const f = leaderFields(l, l); if (f.error) return res.status(400).json({ error: f.error });
  l.dismissed = false; delete l.dismissedAt; delete l.dismissReason; save(); res.json({ ok: true });
});
app.get('/api/admin/ledger', admin('chairman'), (_, res) => res.json(ledgerView()));
app.post('/api/admin/ledger/:id/signoff', admin('chairman'), (req, res) => { const e = db.ledger.find(x => x.id === req.params.id); if (!e) return res.sendStatus(404); e.signed = true; e.signedAt = new Date().toISOString(); save(); res.json({ ok: true }); });

// --- Tap-to-send reminders: who has not yet paid each open case. Officers see all members; zone reps see their own zone.
const remindScope = l => /treasurer|chairman|chairperson|secretary/i.test(l.role) ? 'All' : (zoneOf(l) !== 'All' ? zoneOf(l) : null);
app.get('/api/leader/reminders', admin('leader'), (req, res) => {
  const scope = remindScope(leaderOf(req));
  if (!scope) return res.status(403).json({ error: 'Your role does not send reminders.' });
  const ms = db.members.filter(m => m.status === 'Verified' && (scope === 'All' || m.zone === scope));
  const cases = db.cases.filter(c => c.status === 'Open').map(c => {
    const done = new Set(db.payments.filter(p => p.caseId === c.id && p.status !== 'Failed').map(p => p.phone));
    return { id: c.id, title: c.title, due: c.due, levy: c.levy, owed: owed(c), late: owed(c) > c.levy, total: ms.length, unpaid: ms.filter(m => !phonesOf(m).some(p => done.has(p))).map(m => ({ name: m.name, zone: m.zone || '', phone: m.phone })) };
  });
  res.json({ scope, payNo: PAY.number, payName: PAY.name, cases });
});

// --- A member's full statement (all their payments; the app filters by date and builds the PDF).
app.post('/api/member/statement', (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  const ph = phonesOf(m), mine = db.payments.filter(p => ph.includes(p.phone)).slice().reverse().slice(0, 500);
  res.json({ member: { name: m.name, regNo: m.regNo || '', zone: m.zone || '', school: m.school, phone: '0' + m.phone.slice(3) }, payments: mine.map(p => ({ amount: p.amount, status: p.status, caseTitle: p.caseTitle || 'General', code: p.code, created: p.created })) });
});

// --- What members see: notices, minutes (own zone + all) and the accounts (everyone).
app.post('/api/feed', (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  const posts = db.posts.filter(p => p.zone === 'All' || p.zone === m.zone).slice(-80).reverse().map(({ image, ...p }) => ({ ...p, hasImage: !!image }));
  res.json({ posts, ledger: ledgerView() });
});
app.post('/api/feed/image/:id', async (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  const p = db.posts.find(x => x.id === req.params.id && (x.zone === 'All' || x.zone === m.zone));
  if (!p || !p.image || !db.postImgs.includes(p.image)) return res.sendStatus(404);
  try { await sendImage(res, p.image); } catch (e) { console.error(e.message); res.sendStatus(500); }
});

// --- Leadership list: visible to logged-in members only (phone + PIN).
app.post('/api/leaders', (req, res) => { const m = memberAuth(req, res); if (m) res.json(db.leaders.filter(l => !l.dismissed).map(({ name, role, phone }) => ({ name, role, phone }))); });

// --- Welfare cases: levy per case; late remittance (after the due date) attracts 50% interest on the principal.
const PAYOUTS = { bereavement_member: ['Bereavement: principal member', 1000], bereavement_family: ['Bereavement: nuclear family member', 500], bereavement_parent: ['Bereavement: parent of principal member', 300], wedding: ['Wedding / dowry / parental blessing', 1000], other: ['Other case', 0] };
const owed = c => Date.now() > new Date(c.due + 'T23:59:59+03:00').getTime() ? Math.ceil(c.levy * 1.5) : c.levy;
app.get('/api/cases', (_, res) => res.json(db.cases.filter(c => c.status === 'Open').map(c => ({ id: c.id, title: c.title, due: c.due, levy: c.levy, owed: owed(c), late: owed(c) > c.levy }))));
app.get('/api/admin/cases', admin('chairman', 'treasurer', 'vicechair'), (_, res) => res.json(db.cases.slice().reverse().map(c => ({ ...c, owed: owed(c), collected: db.payments.filter(p => p.caseId === c.id && p.status === 'Paid').reduce((t, p) => t + p.amount, 0), pending: db.payments.filter(p => p.caseId === c.id && p.status !== 'Paid' && p.status !== 'Failed').length }))));
// Shared validation + creation, used both by the Chairman's direct "Open case" form
// and by approving a member's case request — so both paths enforce identical rules.
function openCaseFromInput(body) {
  const t = PAYOUTS[body.type], title = clean(body.title), levy = Math.round(Number(body.levy)), due = String(body.due || '');
  if (!t || title.length < 3) return { error: 'Choose a case type and enter who/what it is for.' };
  if (!(levy >= 1 && levy <= 100000)) return { error: 'Enter the levy per member in KES.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return { error: 'Choose the due date.' };
  const payout = body.type === 'other' ? Math.round(Number(body.payout) || 0) : t[1];
  const c = { id: crypto.randomUUID(), type: body.type, kind: t[0], title, levy, due, payout, status: 'Open', created: new Date().toISOString() };
  db.cases.push(c); save();
  return { case: c };
}
app.post('/api/admin/cases', admin('chairman'), (req, res) => {
  const r = openCaseFromInput(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r.case);
});
app.post('/api/admin/cases/:id/close', admin('chairman'), (req, res) => { const c = db.cases.find(x => x.id === req.params.id); if (!c) return res.sendStatus(404); c.status = 'Closed'; save(); res.json(c); });

// --- Member-submitted welfare cases: a member reports a case directly to the Chairperson,
// Vice Chairperson, or either zone representative. Only the Chairperson or Vice Chairperson
// can approve it; approval opens the real case (so members can contribute) and posts a notice.
// Zone representatives can see what was routed to them but cannot approve.
const ROUTES = { chairman: 'Chairman', vicechair: 'Vice Chairperson', thiba: 'Thiba Zone Representative', murinduko: 'Murinduko Zone Representative' };
const isChair = l => /^chairman$/i.test(l.role);
const isViceChair = l => /vice\s*chair/i.test(l.role);
const canApproveSubmission = l => isChair(l) || isViceChair(l);
const leaderZoneTag = l => zoneOf(l) === 'Thiba' ? 'thiba' : zoneOf(l) === 'Murinduko' ? 'murinduko' : null;

app.post('/api/case-submissions', (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  const t = PAYOUTS[req.body.type], title = clean(req.body.title), details = String(req.body.details || '').trim().slice(0, 2000);
  const zone = ZONES.includes(req.body.zone) ? req.body.zone : (m.zone || null);
  const routedTo = Object.keys(ROUTES).includes(req.body.routedTo) ? req.body.routedTo : null;
  if (!t || title.length < 3) return res.status(400).json({ error: 'Choose a case type and say who it is for.' });
  if (req.body.type === 'bereavement_member' || req.body.type === 'bereavement_family' || req.body.type === 'bereavement_parent') { /* tiers already encode the relation */ }
  if (!zone) return res.status(400).json({ error: 'Choose a zone.' });
  if (!routedTo) return res.status(400).json({ error: 'Choose who to send this to: Chairperson, Vice Chairperson, or your zone representative.' });
  const sub = { id: crypto.randomUUID(), memberId: m.id, memberName: m.name, memberPhone: m.phone, type: req.body.type, kind: t[0], title, details, zone, routedTo, status: 'Pending', created: new Date().toISOString() };
  db.caseSubmissions.push(sub); save();
  res.json({ message: 'Sent to ' + ROUTES[routedTo] + '. You will see it move to "Approved" once a case is opened.' });
});

// A member's own submissions, for their own status-checking (merged into /api/member/summary below too).
const mySubmissions = m => db.caseSubmissions.filter(s => s.memberId === m.id).slice().reverse();

app.get('/api/leader/case-submissions', admin('leader'), (req, res) => {
  const l = leaderOf(req);
  const canAll = canApproveSubmission(l), myTag = leaderZoneTag(l);
  if (!canAll && !myTag) return res.status(403).json({ error: 'Your role does not receive case submissions.' });
  const visible = db.caseSubmissions.filter(s => canAll || s.routedTo === myTag);
  res.json(visible.slice().reverse().map(s => ({ ...s, routedToLabel: ROUTES[s.routedTo], canApprove: canAll })));
});

app.post('/api/leader/case-submissions/:id/decide', admin('leader'), (req, res) => {
  const l = leaderOf(req);
  if (!canApproveSubmission(l)) return res.status(403).json({ error: 'Only the Chairperson or Vice Chairperson can decide on case submissions.' });
  const sub = db.caseSubmissions.find(x => x.id === req.params.id);
  if (!sub) return res.sendStatus(404);
  if (sub.status !== 'Pending') return res.status(400).json({ error: 'This submission was already decided.' });
  const action = req.body.action;
  if (action === 'reject') {
    sub.status = 'Rejected'; sub.decidedBy = l.name; sub.decidedAt = new Date().toISOString(); sub.rejectReason = clean(req.body.reason);
    save(); return res.json({ ok: true });
  }
  if (action !== 'approve') return res.status(400).json({ error: 'Choose approve or reject.' });
  const due = String(req.body.due || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: 'Choose the contribution due date.' });
  const t = PAYOUTS[sub.type];
  const levy = Math.round(Number(req.body.levy));
  if (!(levy >= 1 && levy <= 100000)) return res.status(400).json({ error: 'Enter the levy per member in KES.' });
  const payout = sub.type === 'other' ? Math.round(Number(req.body.payout) || 0) : t[1];
  const c = { id: crypto.randomUUID(), type: sub.type, kind: t[0], title: sub.title, levy, due, payout, status: 'Open', created: new Date().toISOString(), fromSubmission: sub.id };
  db.cases.push(c);
  sub.status = 'Approved'; sub.decidedBy = l.name; sub.decidedAt = new Date().toISOString(); sub.caseId = c.id;
  db.posts.push({ id: crypto.randomUUID(), type: 'notice', title: 'New welfare case: ' + sub.title, body: `A new welfare case has been opened following a member report.\n\nLevy: KES ${levy} per member\nDue: ${due}`, date: today(), image: '', author: l.name, role: l.role, zone: 'All', created: new Date().toISOString() });
  save(); res.json({ ok: true, case: c });
});

// --- Member-submitted welfare case requests. A member proposes a case and routes it to
// the Chairman, Vice Chairperson, or their own zone representative. Only the Chairman or
// Vice Chairperson may approve or reject it (whoever it was routed to) — approval sets the
// levy and due date and turns it into a real, open case visible to every member. A zone
// representative can see requests sent to them, but cannot approve.
const ROUTE_TO = { chairman: 'Chairman', vice_chairman: 'Vice Chairperson', thiba_rep: 'Thiba Zone Representative', murinduko_rep: 'Murinduko Zone Representative' };
const canApproveCases = l => /^chairman$/i.test(l.role) || /vice[\s-]?chair/i.test(l.role);

app.post('/api/member/case-requests', (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  const type = req.body.type, title = clean(req.body.title), details = String(req.body.details || '').trim().slice(0, 2000), routedTo = req.body.routedTo;
  if (!PAYOUTS[type] || type === 'other') return res.status(400).json({ error: 'Choose the type of case.' });
  if (title.length < 3) return res.status(400).json({ error: 'Enter who the case is for, e.g. "My father" or "Myself".' });
  if (!ROUTE_TO[routedTo]) return res.status(400).json({ error: 'Choose who to send this case to.' });
  if (details.length < 5) return res.status(400).json({ error: 'Add a short description of the case.' });
  db.caseRequests.push({ id: crypto.randomUUID(), memberId: m.id, memberName: m.name, memberPhone: m.phone, zone: m.zone || '', type, title, details, routedTo, routedLabel: ROUTE_TO[routedTo], status: 'Pending', created: new Date().toISOString() });
  save();
  res.json({ message: 'Sent to ' + ROUTE_TO[routedTo] + '. The Chairman or Vice Chairperson will review and approve it before it is posted for members.' });
});

app.post('/api/member/case-requests/mine', (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  res.json(db.caseRequests.filter(r => r.memberId === m.id).slice().reverse().map(({ memberId, memberPhone, ...r }) => r));
});

app.get('/api/leader/case-requests', admin('leader'), (req, res) => {
  const l = leaderOf(req); if (!l) return res.sendStatus(403);
  const canApprove = canApproveCases(l);
  const visible = canApprove ? db.caseRequests : db.caseRequests.filter(r => r.routedLabel === l.role);
  res.json({ canApprove, requests: visible.slice().reverse() });
});

app.post('/api/leader/case-requests/:id/approve', admin('leader'), (req, res) => {
  const l = leaderOf(req); if (!l) return res.sendStatus(403);
  if (!canApproveCases(l)) return res.status(403).json({ error: 'Only the Chairman or Vice Chairperson can approve a case.' });
  const r = db.caseRequests.find(x => x.id === req.params.id); if (!r) return res.sendStatus(404);
  if (r.status !== 'Pending') return res.status(400).json({ error: 'This request was already reviewed.' });
  const t = PAYOUTS[r.type], levy = Math.round(Number(req.body.levy)), due = String(req.body.due || '');
  if (!(levy >= 1 && levy <= 100000)) return res.status(400).json({ error: 'Enter the levy per member in KES.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: 'Choose the due date.' });
  const c = { id: crypto.randomUUID(), type: r.type, kind: t[0], title: r.title, levy, due, payout: t[1], status: 'Open', fromRequestId: r.id, created: new Date().toISOString() };
  db.cases.push(c);
  r.status = 'Approved'; r.reviewedBy = l.name; r.reviewedRole = l.role; r.reviewedAt = new Date().toISOString(); r.caseId = c.id;
  save(); res.json({ ok: true, case: c });
});

app.post('/api/leader/case-requests/:id/reject', admin('leader'), (req, res) => {
  const l = leaderOf(req); if (!l) return res.sendStatus(403);
  if (!canApproveCases(l)) return res.status(403).json({ error: 'Only the Chairman or Vice Chairperson can reject a case.' });
  const r = db.caseRequests.find(x => x.id === req.params.id); if (!r) return res.sendStatus(404);
  if (r.status !== 'Pending') return res.status(400).json({ error: 'This request was already reviewed.' });
  r.status = 'Rejected'; r.reviewedBy = l.name; r.reviewedRole = l.role; r.reviewedAt = new Date().toISOString(); r.rejectReason = clean(req.body.reason);
  save(); res.json({ ok: true });
});

// --- Member case requests: a member submits a welfare case addressed to the Chairperson,
// Vice Chairperson, or either zone representative. Only the Chairperson or Vice Chairperson
// can approve it — approval is what publishes it as an Open case on the members' noticeboard.
const RECIPIENTS = { chairman: 'Chairperson', vicechair: 'Vice Chairperson', thiba: 'Thiba Zone Representative', murinduko: 'Murinduko Zone Representative' };
app.post('/api/cases/request', (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  const type = req.body.type, title = clean(req.body.title), details = String(req.body.details || '').trim().slice(0, 2000), recipient = req.body.recipient;
  if (!PAYOUTS[type]) return res.status(400).json({ error: 'Choose a case type.' });
  if (title.length < 3) return res.status(400).json({ error: 'Enter who or what this case is for.' });
  if (!RECIPIENTS[recipient]) return res.status(400).json({ error: 'Choose who to send this request to.' });
  db.caseRequests.push({
    id: crypto.randomUUID(), type, title, details, recipient,
    memberId: m.id, memberName: m.name, memberPhone: m.phone, zone: m.zone || '',
    status: 'Pending', created: new Date().toISOString(),
  });
  save();
  res.json({ message: 'Request sent to the ' + RECIPIENTS[recipient] + '. You will see it on the noticeboard once approved.' });
});
// Chairperson and Vice Chairperson both see every request, regardless of who it was addressed
// to, since either of them can approve it.
app.get('/api/admin/case-requests', admin('chairman', 'vicechair'), (_, res) => {
  res.json(db.caseRequests.slice().reverse().map(r => ({ ...r, recipientLabel: RECIPIENTS[r.recipient] || r.recipient })));
});
app.post('/api/admin/case-requests/:id/approve', admin('chairman', 'vicechair'), (req, res) => {
  const cr = db.caseRequests.find(x => x.id === req.params.id);
  if (!cr) return res.sendStatus(404);
  if (cr.status !== 'Pending') return res.status(400).json({ error: 'This request has already been ' + cr.status.toLowerCase() + '.' });
  const r = openCaseFromInput({ type: cr.type, title: cr.title, levy: req.body.levy, due: req.body.due, payout: req.body.payout });
  if (r.error) return res.status(400).json({ error: r.error });
  cr.status = 'Approved'; cr.approvedCaseId = r.case.id; cr.approvedBy = req.role; cr.approvedAt = new Date().toISOString();
  save(); res.json({ ok: true, case: r.case });
});
app.post('/api/admin/case-requests/:id/reject', admin('chairman', 'vicechair'), (req, res) => {
  const cr = db.caseRequests.find(x => x.id === req.params.id);
  if (!cr) return res.sendStatus(404);
  if (cr.status !== 'Pending') return res.status(400).json({ error: 'This request has already been ' + cr.status.toLowerCase() + '.' });
  cr.status = 'Rejected'; cr.reason = clean(req.body.reason); cr.rejectedBy = req.role; cr.rejectedAt = new Date().toISOString();
  save(); res.json({ ok: true });
});

// --- Manual M-Pesa payments: member pays the welfare number, submits the confirmation code, Chairman approves.
const PAY = { number: process.env.PAY_NUMBER || '0702681009', name: process.env.PAY_NAME || 'Edwin Njagi' };
app.get('/api/config', (_, res) => res.json({ ...PAY, cats: LEDGER_CATS }));
app.get('/api/leader/cases', admin('leader'), (_, res) => res.json(db.cases.map(c => ({ id: c.id, title: c.title, status: c.status })).reverse()));
app.post('/api/pay', (req, res) => {
  const phone = normPhone(req.body.phone), amount = Math.round(Number(req.body.amount)), code = String(req.body.code || '').trim().toUpperCase();
  if (!phone) return res.status(400).json({ error: 'Enter the phone number you paid from.' });
  if (!(amount >= 1 && amount <= 150000)) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (!/^[A-Z0-9]{10}$/.test(code)) return res.status(400).json({ error: 'M-Pesa code is 10 letters/numbers, e.g. SGH7K2L9QX.' });
  if (db.payments.some(p => p.code === code)) return res.status(409).json({ error: 'This M-Pesa code was already submitted.' });
  const c = req.body.caseId ? db.cases.find(x => x.id === req.body.caseId && x.status === 'Open') : null;
  if (req.body.caseId && !c) return res.status(400).json({ error: 'That welfare case is closed or not found.' });
  const member = db.members.find(m => phonesOf(m).includes(phone));
  db.payments.push({ id: crypto.randomUUID(), caseId: c ? c.id : null, caseTitle: c ? c.title : 'General', expected: c ? owed(c) : null, code, phone, amount, member: member ? member.name : null, status: 'Pending', created: new Date().toISOString() }); save();
  res.json({ message: 'Received. The Chairman will confirm your payment.' });
});
// Pending -> (Treasurer confirms) -> Awaiting Chairman -> (Chairman confirms) -> Paid. Either may reject.
app.post('/api/admin/payments/:id/:action', admin('chairman', 'treasurer'), (req, res) => {
  const p = db.payments.find(x => x.id === req.params.id), act = req.params.action;
  if (!p) return res.sendStatus(404);
  if (act === 'reject' && ['Pending', 'Awaiting Chairman'].includes(p.status)) { p.status = 'Failed'; p.rejectedBy = req.role; }
  else if (act === 'confirm' && req.role === 'treasurer' && p.status === 'Pending') { p.status = 'Awaiting Chairman'; p.treasurerAt = new Date().toISOString(); }
  else if (act === 'confirm' && req.role === 'chairman' && p.status === 'Awaiting Chairman') { p.status = 'Paid'; p.chairmanAt = new Date().toISOString(); }
  else return res.status(400).json({ error: p.status === 'Pending' ? 'The Treasurer must confirm first.' : 'This action is not available for this payment.' });
  save(); res.json(p);
});

loadDb().then(() => app.listen(process.env.PORT || 3000, () => console.log('MWEJUSTWO running'))).catch(e => { console.error('Startup failed (not starting with empty data):', e.message); process.exit(1); });
