'use strict';
/* 입장 방법(모집마다 선택): 개인 신청코드 / 학번+이름 / 학번+이름+입장 번호, 그리고 첫 접속 기기 고정. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

const apps = [];
test.after(() => { for (const a of apps) a.server.closeAllConnections(), a.server.close(); });

async function setup(auth) {
  const app = createApp({ dbPath: ':memory:' });
  apps.push(app);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    const jar = new Map(); // 기기 하나 = 쿠키 통 하나
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: body ? JSON.stringify(body) : undefined });
      for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(';')[0].split('='); if (v) jar.set(k, v); else jar.delete(k); }
      return { status: res.status, data: await res.json() };
    };
  };
  const t = client();
  await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'auth-' + Math.random().toString(36).slice(2, 8), password: 'password-1234' });
  const { id } = (await t('POST', '/api/teacher/rounds', { title: '입장 시험', year: 2026 })).data;
  await t('PUT', `/api/teacher/rounds/${id}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호\n1,1,3,박 보람\n', programs: [{ name: '축구', target: 2 }, { name: '탁구', target: 1 }] });
  if (auth) assert.equal((await t('PUT', `/api/teacher/rounds/${id}/auth`, auth)).status, 200);
  const dash = async () => (await t('GET', `/api/teacher/rounds/${id}`)).data;
  const slug = (await dash()).joinUrl.split('/r/')[1];
  const login = (c, number, extra) => c('POST', '/api/student/login', { slug, grade: 1, class: 1, number, ...extra });
  return { t, id, slug, client, login, dash, R: `/api/teacher/rounds/${id}` };
}

test('기본값은 개인 신청코드: 코드를 발급해야 접수를 시작할 수 있고, 이름만으로는 들어올 수 없다', async () => {
  const s = await setup();
  assert.equal((await s.dash()).round.authMode, 'CODE');
  assert.equal((await s.t('POST', `${s.R}/open`, {})).status, 409);
  const { codes } = (await s.t('POST', `${s.R}/codes`, { mode: 'missing' })).data;
  assert.equal((await s.t('POST', `${s.R}/open`, {})).status, 200);
  assert.equal((await s.login(s.client(), 1, { name: '김하늘' })).status, 401);
  assert.equal((await s.login(s.client(), 1, { code: codes[0].code })).status, 200);
});

test('학번 + 이름: 코드 없이 접수 시작, 이름이 맞아야 입장(띄어쓰기 차이는 무시)', async () => {
  const s = await setup({ authMode: 'NAME' });
  assert.equal((await s.t('POST', `${s.R}/open`, {})).status, 200); // 학생코드 발급 없이도 시작된다
  const pub = (await s.client()('GET', `/api/public/rounds/${s.slug}`)).data.round;
  assert.equal(pub.auth, 'NAME');
  assert.equal((await s.login(s.client(), 1, { name: '이지호' })).status, 401); // 남의 이름
  assert.equal((await s.login(s.client(), 1, { name: '' })).status, 401);
  assert.equal((await s.login(s.client(), 9, { name: '김하늘' })).status, 401); // 없는 번호
  const c = s.client();
  assert.equal((await s.login(c, 1, { name: ' 김 하늘 ' })).status, 200);
  assert.equal((await c('GET', '/api/student/me')).data.student.name, '김하늘');
  assert.equal((await s.login(s.client(), 3, { name: '박보람' })).status, 200); // 명단에는 "박 보람"
});

test('학번 + 이름 + 입장 번호: 번호는 서버가 만들고 교사에게만 보이며, 틀리면 입장 불가', async () => {
  const s = await setup({ authMode: 'PIN' });
  const pin = (await s.dash()).round.entryPin;
  assert.match(pin, /^\d{4}$/);
  // 저장을 다시 눌러도 번호는 그대로, "번호 바꾸기"를 눌러야 바뀐다
  await s.t('PUT', `${s.R}/auth`, { authMode: 'PIN' });
  assert.equal((await s.dash()).round.entryPin, pin);
  assert.equal((await s.t('POST', `${s.R}/open`, {})).status, 200);
  const pub = (await s.client()('GET', `/api/public/rounds/${s.slug}`)).data;
  assert.equal(pub.round.auth, 'PIN');
  assert.equal(JSON.stringify(pub).includes(pin), false); // 공개 정보에 입장 번호가 새지 않는다
  const wrong = pin === '0000' ? '1111' : '0000';
  assert.equal((await s.login(s.client(), 1, { name: '김하늘', pin: wrong })).status, 401);
  assert.equal((await s.login(s.client(), 1, { name: '김하늘' })).status, 401);
  assert.equal((await s.login(s.client(), 1, { name: '김하늘', pin })).status, 200);
  // 접수 시작 후에는 입장 방법을 바꿀 수 없다
  assert.equal((await s.t('PUT', `${s.R}/auth`, { authMode: 'NAME' })).status, 409);
});

test('여러 번 틀리면 그 학번만 잠깐 잠긴다(이름을 맞혀 보는 시도 제한)', async () => {
  const s = await setup({ authMode: 'NAME' });
  await s.t('POST', `${s.R}/open`, {});
  const c = s.client();
  for (let i = 0; i < 5; i++) assert.equal((await s.login(c, 1, { name: '아무개' })).status, 401);
  assert.equal((await s.login(c, 1, { name: '김하늘' })).status, 429);
  assert.equal((await s.login(c, 2, { name: '이지호' })).status, 200); // 같은 기기·같은 망의 다른 학생은 영향 없음
});

test('첫 접속 기기 고정: 처음 들어온 기기만 계속 쓰고, 다른 기기는 막고 교사에게 표시, 교사가 풀 수 있다', async () => {
  const s = await setup({ authMode: 'NAME', deviceLock: true });
  await s.t('POST', `${s.R}/open`, {});
  const phoneA = s.client();
  const phoneB = s.client();
  assert.equal((await s.login(phoneA, 1, { name: '김하늘' })).status, 200);
  const pid = (await s.dash()).programs[0].id;
  assert.equal((await phoneA('POST', '/api/student/application', { prefs: [pid], requestId: 'device-test-0001', baseVersion: 0 })).status, 200);
  // 같은 기기는 다시 들어올 수 있다
  await phoneA('POST', '/api/student/logout', {});
  assert.equal((await s.login(phoneA, 1, { name: '김하늘' })).status, 200);
  // 다른 기기는 이름을 알아도 막힌다
  const blocked = await s.login(phoneB, 1, { name: '김하늘' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'DEVICE_LOCKED');
  assert.equal((await phoneB('GET', '/api/student/me')).status, 401);
  let st = (await s.dash()).students[0];
  assert.equal(st.hasDevice, true);
  assert.ok(st.blockedAt);
  // 한 기기가 여러 학번을 차지하는 것은 막지 않는다(형제·공용 태블릿). 대신 각 학번은 그 기기에 묶인다
  assert.equal((await s.login(phoneB, 2, { name: '이지호' })).status, 200);
  // 교사가 풀면: 기존 접속은 끊기고, 다음에 들어오는 기기가 새로 고정된다. 신청 내용은 그대로
  assert.equal((await s.t('POST', `${s.R}/students/${st.id}/device-reset`, {})).status, 200);
  assert.equal((await phoneA('GET', '/api/student/me')).status, 401);
  assert.equal((await s.login(phoneB, 1, { name: '김하늘' })).status, 200);
  assert.deepEqual((await phoneB('GET', '/api/student/me')).data.application.prefs, [pid]);
  assert.equal((await s.login(phoneA, 1, { name: '김하늘' })).status, 403);
  st = (await s.dash()).students[0];
  assert.equal(st.hasDevice, true);
  // 다른 학교 교사는 풀 수 없다
  const other = s.client();
  await other('POST', '/api/teacher/signup', { schoolName: '다른중', name: '박교사', loginId: 'other-' + Math.random().toString(36).slice(2, 8), password: 'password-1234' });
  assert.equal((await other('POST', `${s.R}/students/${st.id}/device-reset`, {})).status, 404);
});

test('기기 고정을 끄면 여러 기기에서 들어올 수 있다. 개인 신청코드와 기기 고정을 함께 쓸 수도 있다', async () => {
  const s = await setup({ authMode: 'NAME', deviceLock: false });
  await s.t('POST', `${s.R}/open`, {});
  assert.equal((await s.login(s.client(), 1, { name: '김하늘' })).status, 200);
  assert.equal((await s.login(s.client(), 1, { name: '김하늘' })).status, 200);

  const c = await setup({ authMode: 'CODE', deviceLock: true });
  const { codes } = (await c.t('POST', `${c.R}/codes`, { mode: 'missing' })).data;
  await c.t('POST', `${c.R}/open`, {});
  assert.equal((await c.login(c.client(), 1, { code: codes[0].code })).status, 200);
  assert.equal((await c.login(c.client(), 1, { code: codes[0].code })).status, 403);
});

test('이전에 만든 DB에도 새 칸이 생기고 기존 모집은 개인 신청코드로 남는다', () => {
  const { DatabaseSync } = require('node:sqlite');
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sps-mig-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE schools (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO schools VALUES (1,'옛학교','x');" +
    "CREATE TABLE rounds (id INTEGER PRIMARY KEY, school_id INTEGER NOT NULL, slug TEXT NOT NULL UNIQUE, year INTEGER NOT NULL, title TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', deadline_at TEXT, allow_no_pref INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'PREP', lottery_seed TEXT, active_run_id INTEGER, created_at TEXT NOT NULL);" +
    "INSERT INTO rounds (id, school_id, slug, year, title, created_at) VALUES (1,1,'old-slug',2026,'옛 모집','x');" +
    'CREATE TABLE students (id INTEGER PRIMARY KEY, school_id INTEGER NOT NULL, round_id INTEGER NOT NULL, grade INTEGER NOT NULL, class INTEGER NOT NULL, number INTEGER NOT NULL, name TEXT NOT NULL, code_hash TEXT, code_version INTEGER NOT NULL DEFAULT 0);');
  old.close();
  const app = createApp({ dbPath: file });
  const row = app.db.get('SELECT auth_mode, device_lock, entry_pin, title FROM rounds WHERE id = 1');
  assert.deepEqual({ ...row }, { auth_mode: 'CODE', device_lock: 0, entry_pin: null, title: '옛 모집' });
  app.db.close();
});
