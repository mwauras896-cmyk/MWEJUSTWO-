// MWEJUSTWO backend: registration, directory, M-Pesa STK push, chairman admin.
const express = require('express'), cors = require('cors'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express(); app.use(cors()); app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Lets the Android app (APK) open full screen without a browser bar: paste the JSON from PWABuilder into the ASSETLINKS_JSON setting in Render.
app.get('/.well-known/assetlinks.json', (_, res) => process.env.ASSETLINKS_JSON ? res.type('json').send(process.env.ASSETLINKS_JSON) : res.sendStatus(404));

// --- storage (JSON file). On Render free tier disk resets: attach a disk or swap for Supabase/MongoDB.
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');   // only used if Supabase is not configured
const ZONES = ['Thiba', 'Murinduko'];
// Leaders live in the database. A brand-new install can be seeded with the LEADERS_JSON setting, for example
// [{"name":"A B","role":"Chairman","phone":"07XXXXXXXX"}]. No real names or phone numbers belong in this file:
// the repository may be public.
const DEFAULT_LEADERS = (() => { try { const a = JSON.parse(process.env.LEADERS_JSON || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } })();

// --- storage: Supabase (permanent) via REST. Whole app data is one JSON row in mwe_store; certificate photos go in mwe_files.
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), SB_KEY = process.env.SUPABASE_KEY || '', USE_SB = !!(SB_URL && SB_KEY);
const sb = async (p, opts = {}) => {
  const r = await fetch(SB_URL + '/rest/v1/' + p, { ...opts, headers: { apikey: SB_KEY, ...(SB_KEY.startsWith('eyJ') ? { Authorization: 'Bearer ' + SB_KEY } : {}), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error('Supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json().catch(() => null);
};
let db = { members: [], payments: [], cases: [] };
// Fill in anything missing so older data (or an older backup) still works with the current code.
function normalizeDb() {
  db.members = db.members || []; db.payments = db.payments || []; db.cases = db.cases || []; db.certNames = db.certNames || []; db.posts = db.posts || []; db.ledger = db.ledger || []; db.postImgs = db.postImgs || []; db.idNames = db.idNames || []; db.leaders = db.leaders || DEFAULT_LEADERS; db.audit = db.audit || []; db.settings = db.settings || {}; db.caseRequests = db.caseRequests || []; db.caseRequests = db.caseRequests || []; db.caseRequests = db.caseRequests || [];
  let newIds = false; db.leaders.forEach(l => { if (!l.id) { l.id = crypto.randomUUID(); newIds = true; } }); if (newIds) save();
}
async function loadDb() {
  if (USE_SB) { const rows = await sb('mwe_store?key=eq.main&select=value'); if (rows && rows[0]) db = rows[0].value; console.log('Data loaded from Supabase'); }
  else { console.log('WARNING: SUPABASE_URL / SUPABASE_KEY not set. Using a local file; data is LOST when Render redeploys.'); if (fs.existsSync(FILE)) db = JSON.parse(fs.readFileSync(FILE)); }
  normalizeDb();
}
let dirty = false, saving = false, timer = null;
async function flush() {
  if (saving) return; saving = true;
  try { while (dirty) { dirty = false;
    if (USE_SB) await sb('mwe_store', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'main', value: db }) });
    else fs.writeFileSync(FILE, JSON.stringify(db, null, 2)); } }
  catch (e) { console.error('SAVE FAILED:', e.message); dirty = true; setTimeout(flush, 5000); }
  saving = false;
  maybeAutoBackup();
}
const save = () => { dirty = true; clearTimeout(timer); timer = setTimeout(flush, 300); };
process.on('SIGTERM', async () => { clearTimeout(timer); while (saving) await new Promise(r => setTimeout(r, 100)); await flush(); process.exit(0); });

// --- Backups. Snapshots of all records (not the ID/certificate photos) are kept under their own keys in the same
// mwe_store table, so no new tables are needed. Kinds: auto (about daily), manual (Chairman pressed the button),
// safety (taken automatically before a deletion or a restore). The newest BACKUP_KEEP of each kind are kept.
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 30, BACKUP_EVERY_MS = 24 * 3600e3;
const BACKUP_DIR = path.join(path.dirname(FILE), 'backups');
const BACKUP_KEY = /^backup-(auto|manual|safety)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
let lastBackupAt = 0, backupBusy = false, lastBackupError = '';
const parseBackupKey = key => { const m = BACKUP_KEY.exec(String(key || '')); return m ? { key, kind: m[1], at: m[2] + 'T' + m[3] + ':' + m[4] + ':' + m[5] + '.' + m[6] + 'Z' } : null; };
const backupCounts = d => ({ members: (d.members || []).length, payments: (d.payments || []).length, cases: (d.cases || []).length, ledger: (d.ledger || []).length, posts: (d.posts || []).length });
async function backupList() {
  let keys = [];
  if (USE_SB) keys = (await sb('mwe_store?key=like.backup-*&select=key&order=key.desc&limit=500') || []).map(r => r.key);
  else if (fs.existsSync(BACKUP_DIR)) keys = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  return keys.map(parseBackupKey).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at));
}
async function backupRead(key) {
  if (!parseBackupKey(key)) return null;
  if (USE_SB) { const r = await sb('mwe_store?key=eq.' + encodeURIComponent(key) + '&select=value'); return r && r[0] ? r[0].value : null; }
  const f = path.join(BACKUP_DIR, key + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : null;
}
async function backupDelete(key) {
  if (!parseBackupKey(key)) return;   // only ever touches backup keys, never the live data
  if (USE_SB) await sb('mwe_store?key=eq.' + encodeURIComponent(key), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  else try { fs.unlinkSync(path.join(BACKUP_DIR, key + '.json')); } catch {}
}
async function backupWrite(kind) {
  const at = new Date().toISOString(), key = 'backup-' + kind + '-' + at.replace(/[:.]/g, '-');
  const value = { kind, at, counts: backupCounts(db), data: db };
  const payload = JSON.stringify({ key, value });   // serialised right now, so it captures the records as they are at this moment
  if (USE_SB) await sb('mwe_store', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: payload });
  else { fs.mkdirSync(BACKUP_DIR, { recursive: true }); fs.writeFileSync(path.join(BACKUP_DIR, key + '.json'), JSON.stringify(value)); }
  if (kind === 'auto') lastBackupAt = Date.now();
  try { for (const b of (await backupList()).filter(x => x.kind === kind).slice(BACKUP_KEEP)) await backupDelete(b.key); } catch (e) { console.error('BACKUP PRUNE:', e.message); }
  return { key, kind, at };
}
async function maybeAutoBackup() {
  if (backupBusy || !loaded || Date.now() - lastBackupAt < BACKUP_EVERY_MS) return;
  backupBusy = true;
  try { await backupWrite('auto'); lastBackupError = ''; }
  catch (e) { lastBackupError = e.message; console.error('BACKUP FAILED:', e.message); lastBackupAt = Date.now() - BACKUP_EVERY_MS + 15 * 60e3; }   // try again in 15 minutes
  backupBusy = false;
}
let loaded = false;
async function initBackups() {
  loaded = true;
  try { const newest = (await backupList()).find(b => b.kind === 'auto'); if (newest) lastBackupAt = new Date(newest.at).getTime(); } catch (e) { lastBackupError = e.message; console.error('BACKUP LIST:', e.message); }
  maybeAutoBackup();
  setInterval(maybeAutoBackup, 3600e3);
}
// A copy is made before anything that cannot be undone; if the copy fails, the action is refused.
const safetyCopy = async res => { try { await backupWrite('safety'); return true; } catch (e) { console.error('SAFETY BACKUP FAILED:', e.message); res.status(503).json({ error: 'Could not save a safety copy first, so nothing was changed. Try again.' }); return false; } };

// --- Abuse limits. Limits per connection are best-effort (a connection address can be disguised); the overall
// totals and the pending-members cap hold regardless.
const hitLog = new Map();
const tooMany = (key, max, windowMs) => { const now = Date.now(), a = (hitLog.get(key) || []).filter(t => now - t < windowMs), over = a.length >= max; if (!over) a.push(now); hitLog.set(key, a); return over; };
setInterval(() => { const now = Date.now(); for (const [k, a] of hitLog) { const f = a.filter(t => now - t < 3600e3); if (f.length) hitLog.set(k, f); else hitLog.delete(k); } }, 600e3).unref();
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
const MAX_PENDING_MEMBERS = Number(process.env.MAX_PENDING_MEMBERS) || 150;
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
// The member list is not public: officials with a session, or a verified member through the directory route below.
app.get('/api/members', admin('chairman', 'treasurer', 'vicechair', 'leader'), (_, res) => res.json(db.members.filter(m => m.status !== 'Dismissed').map(m => ({ id: m.id, name: m.name, school: m.school, zone: m.zone || '', status: m.status }))));
app.post('/api/members/directory', (req, res) => {
  const m = memberAuth(req, res); if (!m) return;
  if (m.status !== 'Verified') return res.status(403).json({ error: 'The directory opens once the Chairman has verified your membership.' });
  res.json(db.members.filter(x => x.status !== 'Dismissed').map(x => ({ id: x.id, name: x.name, school: x.school, zone: x.zone || '', status: x.status })));
});
// Public tally: every registered member who has not been dismissed, plus any official who is not registered as a member (officials are members too). Numbers only.
app.get('/api/stats', (_, res) => {
  const ms = db.members.filter(m => m.status !== 'Dismissed'), phones = new Set(ms.flatMap(m => phonesOf(m)));
  const extra = db.leaders.filter(l => !l.dismissed && !phones.has(normPhone(l.phone))).length;
  res.json({ members: ms.length + extra, verified: ms.filter(m => m.status === 'Verified').length });
});
app.post('/api/members', async (req, res) => {
  const ip = clientIp(req);
  if (db.settings.joinCode && !same(String(req.body.joinCode || '').trim().toLowerCase(), db.settings.joinCode.toLowerCase())) {
    if (tooMany('joinfail:' + ip, 10, 3600e3) || tooMany('joinfail:all', 100, 3600e3)) return res.status(429).json({ error: 'Too many wrong codes. Try again later or ask the Chairman.' });
    return res.status(403).json({ error: 'Enter the join code the Chairman shared with members.' });
  }
  if (tooMany('reg:' + ip, 10, 3600e3) || tooMany('reg:all', 60, 3600e3)) return res.status(429).json({ error: 'Too many sign-ups right now. Please try again later or ask the Chairman.' });
  if (db.members.filter(m => m.status === 'Pending').length >= MAX_PENDING_MEMBERS) return res.status(429).json({ error: 'Registration is paused because many sign-ups are waiting for verification. Please ask the Chairman.' });
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
app.post('/api/admin/members/:id/verify', admin('chairman'), (req, res) => { const m = db.members.find(x => x.id === req.params.id); if (!m) return res.sendStatus(404); m.status = 'Verified'; save(); res.json({ ok: true, status: m.status }); });
app.delete('/api/admin/members/:id', admin('chairman'), async (req, res) => { const m = db.members.find(x => x.id === req.params.id); if (m && !(await safetyCopy(res))) return; if (m) { await dropId(m.idFront); await dropId(m.idBack); } db.members = db.members.filter(x => x.id !== req.params.id); save(); res.json({ ok: true }); });
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
    caseSubmissions: db.caseRequests.filter(r => r.memberId === m.id).slice().reverse().map(r => ({ title: r.title, kind: (PAYOUTS[r.type] || [r.type])[0], zone: r.zone || '', routedTo: RECIPIENTS[r.recipient] || r.routedLabel || '', status: r.status, rejectReason: r.reason || r.rejectReason || '', created: r.created })) });
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

// --- Registration join code (Chairman only). When set, new members must type it to register.
app.get('/api/admin/settings', admin('chairman'), (_, res) => res.json({ joinCode: db.settings.joinCode || '' }));
app.post('/api/admin/settings/joincode', admin('chairman'), (req, res) => {
  const code = String(req.body.code || '').trim();
  if (code && !/^[A-Za-z0-9]{4,20}$/.test(code)) return res.status(400).json({ error: 'Use 4 to 20 letters or numbers, with no spaces.' });
  db.settings.joinCode = code; audit(req, 'joincode', { on: !!code }); save(); res.json({ ok: true, joinCode: code });
});

// --- Backups (Chairman only): status, back up now, download, restore.
app.get('/api/admin/backups', admin('chairman'), async (_, res) => {
  try { const list = await backupList(); res.json({ storage: USE_SB ? 'supabase' : 'local', keep: BACKUP_KEEP, lastAutoAt: lastBackupAt ? new Date(lastBackupAt).toISOString() : '', lastError: lastBackupError, backups: list }); }
  catch (e) { res.status(500).json({ error: 'Could not read the list of backups: ' + e.message }); }
});
app.post('/api/admin/backups/run', admin('chairman'), async (req, res) => {
  try { const b = await backupWrite('manual'); audit(req, 'backup_manual', { key: b.key }); save(); res.json({ ok: true, ...b }); }
  catch (e) { res.status(500).json({ error: 'Backup failed: ' + e.message }); }
});
// Download the current records, or a saved copy when ?key= is given. Contains personal details: Chairman only.
app.get('/api/admin/backups/download', admin('chairman'), async (req, res) => {
  try {
    let value;
    if (req.query && req.query.key) { value = await backupRead(String(req.query.key)); if (!value) return res.status(404).json({ error: 'That backup was not found.' }); }
    else value = { kind: 'download', at: new Date().toISOString(), counts: backupCounts(db), data: db };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="MWEJUSTWO-backup-' + String(value.at).slice(0, 10) + '.json"');
    res.send(JSON.stringify(value, null, 1));
  } catch (e) { res.status(500).json({ error: 'Could not prepare the download: ' + e.message }); }
});
// Replace the live records with a saved copy. A safety copy of the current records is saved first, so this can be undone.
app.post('/api/admin/backups/restore', admin('chairman'), async (req, res) => {
  if (String(req.body.confirm || '').toUpperCase() !== 'RESTORE') return res.status(400).json({ error: 'Type RESTORE to confirm.' });
  const key = String(req.body.key || ''); if (!parseBackupKey(key)) return res.status(400).json({ error: 'That is not a backup.' });
  let value; try { value = await backupRead(key); } catch (e) { return res.status(500).json({ error: 'Could not read that backup: ' + e.message }); }
  if (!value) return res.status(404).json({ error: 'That backup was not found. It may have been replaced by newer copies.' });
  const d = value && value.data;
  if (!d || !Array.isArray(d.members) || !Array.isArray(d.payments) || !Array.isArray(d.cases)) return res.status(400).json({ error: 'That backup is empty or damaged, so nothing was changed.' });
  if (!(await safetyCopy(res))) return;
  const before = backupCounts(db);
  db = d; normalizeDb();
  audit(req, 'restore_backup', { key, from: value.at, replaced: before });
  save();
  const c = backupCounts(db);
  res.json({ ok: true, summary: c.members + ' members, ' + c.payments + ' payments, ' + c.cases + ' cases, ' + c.ledger + ' account entries', safetyNote: 'The records before the restore were saved as a safety copy.' });
});

// --- Chairman only: remove pilot/test records. Financial records are normally never deleted (mistakes are
// reversed instead), so every removal here is written to db.audit with who did it and what was removed.
const audit = (req, action, detail) => { const ld = db.leaders.find(x => x.id === (req.sess && req.sess.lid)); db.audit.push({ at: new Date().toISOString(), by: ld ? ld.name : 'Chairman (admin PIN)', action, detail }); };
// Deleting a case also removes the contributions and account entries that belong to it.
app.delete('/api/admin/cases/:id', admin('chairman'), async (req, res) => {
  const c = db.cases.find(x => x.id === req.params.id); if (!c) return res.sendStatus(404);
  if (!(await safetyCopy(res))) return;
  const pays = db.payments.filter(p => p.caseId === c.id), led = db.ledger.filter(e => e.caseId === c.id);
  db.payments = db.payments.filter(p => p.caseId !== c.id); db.ledger = db.ledger.filter(e => e.caseId !== c.id); db.cases = db.cases.filter(x => x.id !== c.id);
  audit(req, 'delete_case', { title: c.title, due: c.due, payments: pays.length, ledgerEntries: led.length });
  save(); res.json({ ok: true, payments: pays.length, ledgerEntries: led.length });
});
app.delete('/api/admin/payments/:id', admin('chairman'), async (req, res) => {
  const p = db.payments.find(x => x.id === req.params.id); if (!p) return res.sendStatus(404);
  if (!(await safetyCopy(res))) return;
  db.payments = db.payments.filter(x => x.id !== p.id);
  audit(req, 'delete_payment', { member: p.member || p.phone, amount: p.amount, code: p.code, caseTitle: p.caseTitle, status: p.status });
  save(); res.json({ ok: true });
});
// An account entry and its reversal are removed together, so the balance never ends up out of step.
app.delete('/api/admin/ledger/:id', admin('chairman'), async (req, res) => {
  const e = db.ledger.find(x => x.id === req.params.id); if (!e) return res.sendStatus(404);
  if (!(await safetyCopy(res))) return;
  const original = e.corrects ? db.ledger.find(x => x.id === e.corrects) || e : e;
  const ids = new Set([original.id, ...db.ledger.filter(x => x.corrects === original.id).map(x => x.id), e.id]);
  const gone = db.ledger.filter(x => ids.has(x.id));
  db.ledger = db.ledger.filter(x => !ids.has(x.id));
  audit(req, 'delete_ledger', { entries: gone.map(x => ({ kind: x.kind, amount: x.amount, desc: x.desc, date: x.date })) });
  save(); res.json({ ok: true, removed: gone.length });
});

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
// Open cases, with the money collected so far. Only payments the Treasurer and Chairman have confirmed ("Paid") count as collected.
const openCases = () => db.cases.filter(c => c.status === 'Open');
const caseFull = c => {
  const mine = db.payments.filter(p => p.caseId === c.id), paid = mine.filter(p => p.status === 'Paid');
  return { id: c.id, title: c.title, due: c.due, levy: c.levy, owed: owed(c), late: owed(c) > c.levy,
    collected: paid.reduce((t, p) => t + p.amount, 0), contributors: new Set(paid.map(p => p.phone)).size, awaiting: mine.filter(p => p.status === 'Pending' || p.status === 'Awaiting Chairman').length };
};
// Public list (the pay-without-login screen): the person a bereavement or other case is for is not shown, and neither are totals.
app.get('/api/cases', (_, res) => res.json(openCases().map(c => ({ id: c.id, title: /^bereavement_/.test(c.type) ? 'Bereavement case' : c.type === 'other' ? 'Welfare case' : c.title, due: c.due, levy: c.levy, owed: owed(c), late: owed(c) > c.levy }))));
app.post('/api/cases/list', (req, res) => { const m = memberAuth(req, res); if (m) res.json(openCases().map(caseFull)); });
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
  const type = req.body.type, titleIn = clean(req.body.title), details = String(req.body.details || '').trim().slice(0, 2000), recipient = req.body.recipient;
  if (!PAYOUTS[type]) return res.status(400).json({ error: 'Choose a case type.' });
  const deceasedName = clean(req.body.deceasedName), forName = clean(req.body.forName);
  const title = /^bereavement_/.test(type) && titleIn.length < 3 && deceasedName ? 'Bereavement: ' + deceasedName : titleIn;
  if (title.length < 3) return res.status(400).json({ error: 'Enter who or what this case is for.' });
  if (!RECIPIENTS[recipient]) return res.status(400).json({ error: 'Choose who to send this request to.' });
  db.caseRequests.push({
    id: crypto.randomUUID(), type, title, details, recipient, deceasedName, forName,
    memberId: m.id, memberName: m.name, memberPhone: m.phone, zone: m.zone || '',
    status: 'Pending', created: new Date().toISOString(),
  });
  save();
  res.json({ message: 'Request sent to the ' + RECIPIENTS[recipient] + '. You will see it on the noticeboard once approved.' });
});
// --- Cover check for bereavement reports: is the person who passed away on the right member's next-of-kin list,
// under the right relationship for the payout asked for, and has the same death already been reported?
// It informs the approver; a failed check needs a deliberate "approve anyway", which is recorded.
const NAME_TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'rev', 'mzee', 'mama', 'baba', 'late', 'the', 'sir', 'madam', 'eng']);
const nameTokens = n => String(n || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !NAME_TITLES.has(t));
function nameMatch(a, b) {   // 'full' = at least two names agree; 'partial' = one name given and it agrees; null = no match
  const A = nameTokens(a), B = nameTokens(b); if (!A.length || !B.length) return null;
  const [sm, lg] = A.length <= B.length ? [A, B] : [B, A], hits = sm.filter(t => lg.includes(t)).length;
  if (hits >= 2 && hits / sm.length >= 0.66) return 'full';
  // Sharing just a surname or a first name is not enough: only a single-name entry (e.g. "Kariuki") can match on one name.
  return sm.length === 1 && hits === 1 ? 'partial' : null;
}
function findMemberByName(name) {
  const c = db.members.map(m => ({ m, q: nameMatch(m.name, name) })).filter(x => x.q), full = c.filter(x => x.q === 'full');
  if (full.length === 1) return { m: full[0].m, q: 'full' };
  if (full.length > 1) return { m: null, note: 'more than one member matches "' + name + '": ' + full.slice(0, 4).map(x => x.m.name).join(', ') + '.' };
  if (c.length === 1) return { m: c[0].m, q: 'partial' };
  if (c.length > 1) return { m: null, note: 'several members share part of that name: ' + c.slice(0, 4).map(x => x.m.name).join(', ') + '.' };
  return { m: null, note: 'no registered member is called "' + name + '".' };
}
// The member whose cover is being claimed: the deceased member (principal), the member named in "for", or the reporter.
function affectedMember(r) {
  if (r.type === 'bereavement_member') return r.deceasedName ? findMemberByName(r.deceasedName).m : null;
  if (r.forName) return findMemberByName(r.forName).m;
  return db.members.find(x => x.id === r.memberId) || null;
}
const COVER_LABEL = { bereavement_member: 'the principal member (KES 1,000)', bereavement_family: 'a nuclear family member (KES 500)', bereavement_parent: "the member's parent (KES 300)" };
function coverCheck(r) {
  const lines = [], add = (level, text) => lines.push({ level, text });
  const payout = (PAYOUTS[r.type] || [])[1];
  const done = () => ({ level: lines.some(l => l.level === 'fail') ? 'fail' : lines.some(l => l.level === 'warn') ? 'warn' : 'ok', lines, payout });
  if (!/^bereavement_/.test(r.type)) return { level: 'na', lines: [], payout };
  const dn = r.deceasedName;
  if (!dn) { add('warn', 'No name was given for the person who passed away, so this could not be checked against the next-of-kin list.'); return done(); }
  let who = null;
  if (r.type === 'bereavement_member') {
    const f = findMemberByName(dn);
    if (!f.m) add('fail', 'Could not identify the member: ' + f.note);
    else {
      who = f.m;
      add(f.q === 'full' ? 'ok' : 'warn', 'Registered member: ' + who.name + ' (' + who.status + (who.zone ? ', ' + who.zone : '') + ').' + (f.q === 'full' ? '' : ' Only part of the name matched, so confirm it is the right person.'));
      if (who.status === 'Dismissed') add('fail', 'This member was dismissed and is no longer covered.');
      else if (who.status !== 'Verified') add('warn', 'This membership has not been verified yet.');
    }
  } else {
    if (r.forName) { const f = findMemberByName(r.forName); if (!f.m) add('fail', 'Could not identify the member this is for: ' + f.note); else who = f.m; }
    else who = db.members.find(x => x.id === r.memberId) || null;
    if (who) {
      const want = r.type === 'bereavement_family' ? 'family' : 'parent', kin = who.kin || [];
      if (!kin.length) add('fail', who.name + ' has no next-of-kin list recorded, so ' + dn + ' cannot be confirmed.');
      else {
        const found = kin.map(k => ({ k, q: nameMatch(k.name, dn) })).filter(x => x.q).sort((a, b) => (a.q === 'full' ? 0 : 1) - (b.q === 'full' ? 0 : 1))[0];
        if (!found) add('fail', dn + ' is not on ' + who.name + "'s next-of-kin list.");
        else {
          const k = found.k;
          add(found.q === 'full' ? 'ok' : 'warn', 'On ' + who.name + "'s list as " + k.relation + ': ' + k.name + '.' + (found.q === 'full' ? '' : ' Only part of the name matched, so confirm identity.'));
          if (k.group === 'self') add('fail', 'This is the member themselves, not a relative. Use "principal member" if the member has passed away.');
          else if (k.group !== want) add('fail', 'Listed as ' + k.relation + ' (' + (k.group === 'family' ? 'nuclear family, KES 500' : 'parent, KES 300') + '), but the case was reported as ' + COVER_LABEL[r.type] + '.');
          if (k.relation === 'Child' && !k.cert) add('warn', 'No birth certificate was uploaded for this child.');
        }
        add(who.kinLocked ? 'ok' : 'warn', who.kinLocked ? 'The next-of-kin list is locked by the Chairman.' : 'The next-of-kin list is not locked, so it can still be edited.');
      }
    }
  }
  // the same death reported before?
  for (const o of db.caseRequests) {
    if (o.id === r.id || o.status === 'Rejected' || !/^bereavement_/.test(o.type) || !o.deceasedName || nameMatch(o.deceasedName, dn) !== 'full') continue;
    if (o.status === 'Pending' && (o.created || '') > (r.created || '')) continue;   // a later report is the one that gets flagged, not the original
    const oa = affectedMember(o), when = (o.created || '').slice(0, 10);
    if (who && oa && oa.id === who.id) add('fail', 'Duplicate: ' + who.name + ' already has this case (reported ' + when + ', ' + o.status + ').');
    else add('warn', 'The same person was also reported by ' + o.memberName + ' on ' + when + ' (' + o.status + '). That is fine if they are relatives who are both members; otherwise it is a duplicate.');
  }
  return done();
}
// Chairperson and Vice Chairperson both see every request, regardless of who it was addressed
// to, since either of them can approve it.
app.get('/api/admin/case-requests', admin('chairman', 'vicechair'), (_, res) => {
  res.json(db.caseRequests.slice().reverse().map(r => ({ ...r, recipientLabel: RECIPIENTS[r.recipient] || r.recipient, cover: r.status === 'Pending' ? coverCheck(r) : (r.cover || null) })));
});
app.post('/api/admin/case-requests/:id/approve', admin('chairman', 'vicechair'), (req, res) => {
  const cr = db.caseRequests.find(x => x.id === req.params.id);
  if (!cr) return res.sendStatus(404);
  if (cr.status !== 'Pending') return res.status(400).json({ error: 'This request has already been ' + cr.status.toLowerCase() + '.' });
  const cc = coverCheck(cr);
  if (cc.level === 'fail' && !req.body.acknowledge) return res.status(409).json({ error: 'COVER CHECK FAILED:\n' + cc.lines.filter(l => l.level === 'fail').map(l => '- ' + l.text).join('\n') });
  const r = openCaseFromInput({ type: cr.type, title: cr.title, levy: req.body.levy, due: req.body.due, payout: req.body.payout });
  if (r.error) return res.status(400).json({ error: r.error });
  cr.cover = cc; if (cc.level === 'fail') cr.coverAcknowledgedBy = (db.leaders.find(x => x.id === (req.sess && req.sess.lid)) || {}).name || (req.role === 'chairman' ? 'Chairman' : 'Vice Chairperson');
  cr.status = 'Approved'; cr.approvedCaseId = r.case.id; cr.approvedBy = req.role; cr.approvedAt = new Date().toISOString();
  // Approval is what puts it on the members' noticeboard: announce the new case in Notices as well as opening it for contributions.
  const ld = db.leaders.find(x => x.id === req.sess.lid);
  db.posts.push({ id: crypto.randomUUID(), type: 'notice', title: 'New welfare case: ' + r.case.title, body: 'A new welfare case has been opened following a member report.\n\nLevy: KES ' + r.case.levy + ' per member\nDue: ' + r.case.due, date: today(), image: '', author: ld ? ld.name : (req.role === 'chairman' ? 'Chairman' : 'Vice Chairperson'), role: ld ? ld.role : (req.role === 'chairman' ? 'Chairman' : 'Vice Chairperson'), zone: 'All', created: new Date().toISOString() });
  save(); res.json({ ok: true, case: r.case });
});
app.post('/api/admin/case-requests/:id/reject', admin('chairman', 'vicechair'), (req, res) => {
  const cr = db.caseRequests.find(x => x.id === req.params.id);
  if (!cr) return res.sendStatus(404);
  if (cr.status !== 'Pending') return res.status(400).json({ error: 'This request has already been ' + cr.status.toLowerCase() + '.' });
  cr.cover = coverCheck(cr); cr.status = 'Rejected'; cr.reason = clean(req.body.reason); cr.rejectedBy = req.role; cr.rejectedAt = new Date().toISOString();
  save(); res.json({ ok: true });
});

// --- Manual M-Pesa payments: member pays the welfare number, submits the confirmation code, Chairman approves.
const PAY = { number: process.env.PAY_NUMBER || '0702681009', name: process.env.PAY_NAME || 'Edwin Njagi' };
app.get('/api/config', (_, res) => res.json({ ...PAY, cats: LEDGER_CATS, joinRequired: !!db.settings.joinCode }));
app.get('/api/leader/cases', admin('leader'), (_, res) => res.json(db.cases.map(c => ({ id: c.id, title: c.title, status: c.status })).reverse()));
app.post('/api/pay', (req, res) => {
  if (tooMany('pay:' + clientIp(req), 40, 3600e3) || tooMany('pay:all', 300, 3600e3)) return res.status(429).json({ error: 'Too many payments were submitted just now. Please try again in a while.' });
  const phone = normPhone(req.body.phone), amount = Math.round(Number(req.body.amount)), code = String(req.body.code || '').trim().toUpperCase();
  if (!phone) return res.status(400).json({ error: 'Enter the phone number you paid from.' });
  if (!(amount >= 1 && amount <= 150000)) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (!/^[A-Z0-9]{10}$/.test(code)) return res.status(400).json({ error: 'M-Pesa code is 10 letters/numbers, e.g. SGH7K2L9QX.' });
  if (db.payments.some(p => p.code === code)) return res.status(409).json({ error: 'This M-Pesa code was already submitted.' });
  if (db.payments.filter(p => p.phone === phone && (p.status === 'Pending' || p.status === 'Awaiting Chairman')).length >= 5) return res.status(429).json({ error: 'You already have 5 payments waiting for confirmation. Please wait for the Treasurer to confirm them.' });
  if (db.payments.filter(p => p.status === 'Pending').length >= 500) return res.status(503).json({ error: 'The payment queue is full. Please contact the Treasurer.' });
  const c = req.body.caseId ? db.cases.find(x => x.id === req.body.caseId && x.status === 'Open') : null;
  if (req.body.caseId && !c) return res.status(400).json({ error: 'That welfare case is closed or not found.' });
  const member = db.members.find(m => phonesOf(m).includes(phone));
  db.payments.push({ id: crypto.randomUUID(), caseId: c ? c.id : null, caseTitle: c ? c.title : 'General', expected: c ? owed(c) : null, code, phone, amount, member: member ? member.name : null, status: 'Pending', created: new Date().toISOString() }); save();
  res.json({ message: 'Received. The Chairman will confirm your payment.' });
});
// Move a contribution to a different welfare case, or to General. Members sometimes pay without choosing the case,
// so the money is not counted towards it. Chairman or Treasurer; the move is recorded on the payment and in the audit log.
app.post('/api/admin/payments/:id/assign', admin('chairman', 'treasurer'), (req, res) => {
  const p = db.payments.find(x => x.id === req.params.id); if (!p) return res.sendStatus(404);
  if (p.status === 'Failed') return res.status(400).json({ error: 'A rejected payment cannot be moved.' });
  const c = req.body.caseId ? db.cases.find(x => x.id === req.body.caseId) : null;
  if (req.body.caseId && !c) return res.status(400).json({ error: 'That welfare case was not found.' });
  const from = p.caseTitle || 'General', ld = db.leaders.find(x => x.id === (req.sess && req.sess.lid));
  const late = c && new Date(p.created).getTime() > new Date(c.due + 'T23:59:59+03:00').getTime();
  p.caseId = c ? c.id : null; p.caseTitle = c ? c.title : 'General'; p.expected = c ? (late ? Math.ceil(c.levy * 1.5) : c.levy) : null;
  p.movedFrom = from; p.movedBy = ld ? ld.name : (req.role === 'chairman' ? 'Chairman' : 'Treasurer'); p.movedAt = new Date().toISOString();
  audit(req, 'payment_move', { member: p.member || p.phone, amount: p.amount, code: p.code, from, to: p.caseTitle });
  save(); res.json(p);
});
const isOwnPayment = (req, p) => { const ld = db.leaders.find(x => x.id === (req.sess && req.sess.lid)); if (!ld) return false; return normPhone(ld.phone) === p.phone || String(p.member || '').trim().toLowerCase() === ld.name.trim().toLowerCase(); };
// Pending -> (Treasurer confirms) -> Awaiting Chairman -> (Chairman confirms) -> Paid. Either may reject.
app.post('/api/admin/payments/:id/:action', admin('chairman', 'treasurer'), (req, res) => {
  const p = db.payments.find(x => x.id === req.params.id), act = req.params.action;
  if (!p) return res.sendStatus(404);
  if (act === 'reject' && ['Pending', 'Awaiting Chairman'].includes(p.status)) { p.status = 'Failed'; p.rejectedBy = req.role; }
  else if (act === 'confirm' && req.role === 'treasurer' && p.status === 'Pending') { p.status = 'Awaiting Chairman'; p.treasurerAt = new Date().toISOString(); }
  else if (act === 'confirm' && req.role === 'chairman' && p.status === 'Awaiting Chairman') { p.status = 'Paid'; p.chairmanAt = new Date().toISOString(); }
  // Chairman override: approve a payment the Treasurer has not yet confirmed. Needs a written reason, is shown to
  // the Treasurer on the payment, is logged, and cannot be used on the Chairman's own payment.
  else if (act === 'override') {
    if (req.role !== 'chairman') return res.status(403).json({ error: 'Only the Chairman can approve without the Treasurer.' });
    if (p.status !== 'Pending') return res.status(400).json({ error: 'Only a payment still waiting for the Treasurer can be approved this way.' });
    if (isOwnPayment(req, p)) return res.status(403).json({ error: 'You cannot approve your own payment without the Treasurer. Ask the Treasurer to confirm it.' });
    const reason = String(req.body.reason || '').trim().replace(/[<>]/g, '').slice(0, 160);
    if (reason.length < 5) return res.status(400).json({ error: 'Give a reason (at least 5 characters) for approving without the Treasurer.' });
    const ld = db.leaders.find(x => x.id === (req.sess && req.sess.lid));
    p.status = 'Paid'; p.chairmanAt = new Date().toISOString(); p.skippedTreasurer = true; p.overrideReason = reason; p.overrideBy = ld ? ld.name : 'Chairman';
    audit(req, 'payment_override', { member: p.member || p.phone, amount: p.amount, code: p.code, caseTitle: p.caseTitle, reason });
  }
  else return res.status(400).json({ error: p.status === 'Pending' ? 'The Treasurer must confirm first.' : 'This action is not available for this payment.' });
  save(); res.json(p);
});

loadDb().then(() => { initBackups(); return app.listen(process.env.PORT || 3000, () => console.log('MWEJUSTWO running')); }).catch(e => { console.error('Startup failed (not starting with empty data):', e.message); process.exit(1); });
