'use strict';
/* 공격해 보고 막은 곳들: 깨진 입력, 잠금 악용, 약한 비밀번호, 개설 코드 추측, 응답 머리말 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/server');

const start = async (opts = {}) => {
  const app = createApp({ dbPath: ':memory:', ...opts });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  /** 주소·머리말을 다듬지 않고 그대로 보낸다. from 은 접속하는 쪽 주소(다른 사람인 척) */
  const send = (method, path, { headers = {}, body, from } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, localAddress: from, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let json; try { json = JSON.parse(d); } catch { json = d; } resolve({ status: res.statusCode, data: json, headers: res.headers }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  const stop = () => { app.server.closeAllConnections(); app.server.close(); };
  return { app, send, stop };
};
const cookieOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

test('깨진 주소와 읽을 수 없는 Origin 은 서버 오류(500)가 아니라 거절된다', async () => {
  const { send, stop } = await start();
  try {
    assert.equal((await send('GET', '/api/public/rounds/%E0%A4%A')).status, 400);
    assert.equal((await send('GET', '/api/teacher/rounds/%')).status, 400);
    for (const origin of ['null', '%%%', 'http://evil.example']) {
      assert.equal((await send('POST', '/api/student/login', { headers: { Origin: origin }, body: {} })).status, 403);
    }
  } finally { stop(); }
});

test('응답 머리말: 기기 기능 차단·창 분리, HTTPS 일 때만 HSTS', async () => {
  const plain = await start();
  const secure = await start({ secureCookie: true });
  try {
    const h = (await plain.send('GET', '/teacher')).headers;
    assert.match(h['permissions-policy'], /camera=\(\)/);
    assert.equal(h['cross-origin-opener-policy'], 'same-origin');
    assert.equal(h['strict-transport-security'], undefined);
    assert.match((await secure.send('GET', '/teacher')).headers['strict-transport-security'], /max-age=\d+/);
  } finally { plain.stop(); secure.stop(); }
});

test('가입: 추측하기 쉬운 비밀번호는 받지 않는다', async () => {
  const { send, stop } = await start();
  try {
    const signup = (loginId, password) => send('POST', '/api/teacher/signup', { body: { schoolName: '가상중', name: '김교사', loginId, password } });
    for (const pw of ['1234567890', 'aaaaaaaaaa', 'teacher01-pw', 'password1234', 'ababababab']) assert.equal((await signup('teacher01', pw)).status, 400, pw);
    assert.equal((await signup('teacher01', 'x'.repeat(201))).status, 400);
    assert.equal((await signup('teacher01', 'password-1234')).status, 200);
  } finally { stop(); }
});

test('가입: 개설 확인 코드는 열 번 틀리면 더 추측할 수 없다', async () => {
  const { send, stop } = await start({ signupCode: 'open-sesame-77' });
  try {
    const signup = (i, signupCode) => send('POST', '/api/teacher/signup', { body: { schoolName: '가상중', name: '김교사', loginId: 'guess' + i, password: 'password-1234', signupCode } });
    for (let i = 0; i < 10; i++) assert.equal((await signup(i, 'guess-' + i)).status, 403);
    assert.equal((await signup(11, 'guess-11')).status, 429);
    assert.equal((await signup(12, 'open-sesame-77')).status, 429); // 잠긴 동안에는 맞는 코드도 받지 않는다(추측 성공을 알려 주지 않는다)
  } finally { stop(); }
});

test('잠금: 남이 일부러 틀려도 본인은 들어온다(다른 곳에서 접속한 경우)', async (t) => {
  const { send, stop } = await start();
  try {
    try { await send('GET', '/teacher', { from: '127.0.0.2' }); } catch { return t.skip('이 컴퓨터에서는 다른 접속 주소(127.0.0.2)를 흉내 낼 수 없다'); }
    const teacher = cookieOf(await send('POST', '/api/teacher/signup', { body: { schoolName: '가상중', name: '김교사', loginId: 'locktest', password: 'password-1234' } }));
    const T = (method, path, body) => send(method, path, { headers: { Cookie: teacher }, body });
    const { id } = (await T('POST', '/api/teacher/rounds', { title: '동아리', year: 2026 })).data;
    await T('PUT', `/api/teacher/rounds/${id}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,김하늘', programs: [{ name: '축구', target: 1 }] });
    await T('PUT', `/api/teacher/rounds/${id}/auth`, { authMode: 'NAME' });
    await T('POST', `/api/teacher/rounds/${id}/open`, {});
    const slug = (await T('GET', `/api/teacher/rounds/${id}`)).data.joinUrl.split('/r/')[1];
    const student = (name, from) => send('POST', '/api/student/login', { from, body: { slug, grade: 1, class: 1, number: 1, name } });

    // 공격자(127.0.0.2)가 여섯 번 틀린다 → 공격자는 잠기고, 본인(127.0.0.1)은 들어온다
    for (let i = 0; i < 5; i++) assert.equal((await student('틀린이름', '127.0.0.2')).status, 401);
    assert.equal((await student('김하늘', '127.0.0.2')).status, 429);
    assert.equal((await student('김하늘')).status, 200);

    // 교사 로그인도 같다
    const login = (password, from) => send('POST', '/api/teacher/login', { from, body: { loginId: 'locktest', password } });
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong-password', '127.0.0.2')).status, 401);
    assert.equal((await login('password-1234', '127.0.0.2')).status, 429);
    assert.equal((await login('password-1234')).status, 200);

    // 여러 곳에서 나눠 틀려도 한 학번에 서른 번이면 모두 잠긴다
    for (const from of ['127.0.0.3', '127.0.0.4', '127.0.0.5', '127.0.0.6', '127.0.0.7']) for (let i = 0; i < 5; i++) await student('틀린이름', from);
    assert.equal((await student('김하늘', '127.0.0.8')).status, 429);
  } finally { stop(); }
});
