const BASE = process.env.BASE ?? 'http://127.0.0.1:3000/api/v1';
async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  return { status: res.status, json: j };
}
const login = await call('POST', '/auth/login', { body: { identifier: 'ADMIN001', secret: 'AdminPass!2026', app: 'ADMIN_WEB' } });
const token = login.json?.accessToken;
if (!token) { console.log('admin login failed', login.status, login.json); process.exit(1); }
const created = await call('POST', '/users', { token, body: { name: 'TEST_WORKER', employeeCode: 'TEST_WORKER', email: 'TEST_WORKER@test.local', password: 'TestWorker!2024', roles: ['RECEIVING_WORKER'], isActive: true } });
console.log('create TEST_WORKER:', created.status, JSON.stringify(created.json).slice(0, 200));
const stations = await call('GET', '/stations', { token });
const rec = (stations.json ?? []).find((s) => s.code === 'ST-REC-02') ?? (stations.json ?? []).find((s) => s.code === 'ST-REC-01');
let wid = created.json?.id ?? created.json?.user?.id;
if (!wid) {
  const users = await call('GET', '/users?search=TEST_WORKER', { token });
  const list = Array.isArray(users.json) ? users.json : users.json?.items ?? users.json?.data ?? [];
  wid = list.find((u) => u.employeeCode === 'TEST_WORKER')?.id;
}
console.log('worker id:', wid, 'station:', rec?.code, rec?.id);
const asg = await call('POST', `/stations/${rec.id}/assign`, { token, body: { workerId: wid } });
console.log('assign:', asg.status, JSON.stringify(asg.json).slice(0, 200));
const wl = await call('POST', '/auth/login', { body: { identifier: 'TEST_WORKER', secret: 'TestWorker!2024', app: 'WORKER_NATIVE' } });
console.log('worker login:', wl.status);
const home = await call('GET', '/terminal/home', { token: wl.json?.accessToken });
console.log('terminal home:', home.status, JSON.stringify(home.json).slice(0, 600));
