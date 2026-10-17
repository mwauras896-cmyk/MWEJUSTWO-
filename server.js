// MWEJUSTWO backend: registration, directory, M-Pesa STK push, chairman admin.
const express = require('express'), cors = require('cors'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const app = express(); app.use(cors()); app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- storage (JSON file). On Render free tier disk resets: attach a disk or swap for Supabase/MongoDB.
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE)) : { members: [], payments: [], cases: [] };
db.cases = db.cases || [];
const save = () => fs.writeFileSync(FILE, JSON.stringify(db, null, 2));

const normPhone = p => { p = String(p || '').replace(/\D/g, ''); if (/^0[17]\d{8}$/.test(p)) return '254' + p.slice(1); if (/^254[17]\d{8}$/.test(p)) return p; return null; };
const clean = s => String(s || '').trim().replace(/[<>]/g, '').slice(0, 80);

// --- admin sessions (roles: chairman, treasurer)
const sessions = new Map();
const admin = (...roles) => (req, res, next) => {
  const x = sessions.get(req.headers['x-admin-token']);
  if (x && x.exp > Date.now() && roles.includes(x.role)) { req.role = x.role; return next(); }
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
app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/members', (_, res) => res.json(db.members.map(m => ({ id: m.id, name: m.name, school: m.school, status: m.status }))));
app.post('/api/members', (req, res) => {
  const name = clean(req.body.name), school = clean(req.body.school), phone = normPhone(req.body.phone);
  if (name.length < 3 || !school) return res.status(400).json({ error: 'Enter your full name and school/zone.' });
  if (!phone) return res.status(400).json({ error: 'Enter a valid Safaricom/Airtel number, e.g. 0712345678.' });
  const pin = String(req.body.pin || '');
  if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: 'Choose a PIN of 4 to 6 digits. You will use it to edit your next of kin.' });
  if (db.members.some(m => m.phone === phone)) return res.status(409).json({ error: 'This phone number is already registered.' });
  db.members.push({ id: crypto.randomUUID(), name, school, phone, status: 'Pending', pinHash: hashPin(pin), kin: [], kinLocked: false, created: new Date().toISOString() }); save();
  res.json({ message: 'Registered. The Chairman will verify your membership.' });
});
app.get('/api/admin/members', admin('chairman'), (_, res) => res.json(db.members.map(({ pinHash, kin, ...m }) => ({ ...m, kinCount: (kin || []).length, kinLocked: !!m.kinLocked }))));
app.post('/api/admin/members/:id/verify', admin('chairman'), (req, res) => { const m = db.members.find(x => x.id === req.params.id); if (!m) return res.sendStatus(404); m.status = 'Verified'; save(); res.json(m); });
app.delete('/api/admin/members/:id', admin('chairman'), (req, res) => { db.members = db.members.filter(x => x.id !== req.params.id); save(); res.json({ ok: true }); });
app.get('/api/admin/payments', admin('chairman', 'treasurer'), (_, res) => res.json(db.payments.slice().reverse()));

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
    out.push({ group: k.group, relation: k.relation, name, idNo: clean(k.idNo).slice(0, 20), phone: clean(k.phone).slice(0, 15) });
  }
  m.kin = out; save(); res.json({ message: 'Saved. You can keep editing until the Chairman locks the list.' });
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

// --- Welfare cases: levy per case; late remittance (after the due date) attracts 50% interest on the principal.
const PAYOUTS = { bereavement_member: ['Bereavement: principal member', 1000], bereavement_family: ['Bereavement: nuclear family member', 500], bereavement_parent: ['Bereavement: parent of principal member', 300], wedding: ['Wedding / dowry / parental blessing', 1000], other: ['Other case', 0] };
const owed = c => Date.now() > new Date(c.due + 'T23:59:59+03:00').getTime() ? Math.ceil(c.levy * 1.5) : c.levy;
app.get('/api/cases', (_, res) => res.json(db.cases.filter(c => c.status === 'Open').map(c => ({ id: c.id, title: c.title, due: c.due, levy: c.levy, owed: owed(c), late: owed(c) > c.levy }))));
app.get('/api/admin/cases', admin('chairman', 'treasurer'), (_, res) => res.json(db.cases.slice().reverse().map(c => ({ ...c, owed: owed(c), collected: db.payments.filter(p => p.caseId === c.id && p.status === 'Paid').reduce((t, p) => t + p.amount, 0), pending: db.payments.filter(p => p.caseId === c.id && p.status !== 'Paid' && p.status !== 'Failed').length }))));
app.post('/api/admin/cases', admin('chairman'), (req, res) => {
  const t = PAYOUTS[req.body.type], title = clean(req.body.title), levy = Math.round(Number(req.body.levy)), due = String(req.body.due || '');
  if (!t || title.length < 3) return res.status(400).json({ error: 'Choose a case type and enter who/what it is for.' });
  if (!(levy >= 1 && levy <= 100000)) return res.status(400).json({ error: 'Enter the levy per member in KES.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return res.status(400).json({ error: 'Choose the due date.' });
  const payout = req.body.type === 'other' ? Math.round(Number(req.body.payout) || 0) : t[1];
  const c = { id: crypto.randomUUID(), type: req.body.type, kind: t[0], title, levy, due, payout, status: 'Open', created: new Date().toISOString() };
  db.cases.push(c); save(); res.json(c);
});
app.post('/api/admin/cases/:id/close', admin('chairman'), (req, res) => { const c = db.cases.find(x => x.id === req.params.id); if (!c) return res.sendStatus(404); c.status = 'Closed'; save(); res.json(c); });

// --- Manual M-Pesa payments: member pays the welfare number, submits the confirmation code, Chairman approves.
const PAY = { number: process.env.PAY_NUMBER || '0702681009', name: process.env.PAY_NAME || 'Edwin Njagi' };
app.get('/api/config', (_, res) => res.json(PAY));
app.post('/api/pay', (req, res) => {
  const phone = normPhone(req.body.phone), amount = Math.round(Number(req.body.amount)), code = String(req.body.code || '').trim().toUpperCase();
  if (!phone) return res.status(400).json({ error: 'Enter the phone number you paid from.' });
  if (!(amount >= 1 && amount <= 150000)) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (!/^[A-Z0-9]{10}$/.test(code)) return res.status(400).json({ error: 'M-Pesa code is 10 letters/numbers, e.g. SGH7K2L9QX.' });
  if (db.payments.some(p => p.code === code)) return res.status(409).json({ error: 'This M-Pesa code was already submitted.' });
  const c = req.body.caseId ? db.cases.find(x => x.id === req.body.caseId && x.status === 'Open') : null;
  if (req.body.caseId && !c) return res.status(400).json({ error: 'That welfare case is closed or not found.' });
  const member = db.members.find(m => m.phone === phone);
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

app.listen(process.env.PORT || 3000, () => console.log('MWEJUSTWO running'));
