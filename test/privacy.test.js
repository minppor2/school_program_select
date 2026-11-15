'use strict';
/* 개인정보 처리방침: 교사가 학교별 내용을 적고, 누구나 볼 수 있다 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

test('처리방침: 교사만 고치고, 공개 주소로 누구나 본다', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: res.status, data };
    };
  };
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'priv1', password: 'password-1234' });
    assert.equal((await client()('GET', '/api/teacher/privacy')).status, 401);
    assert.equal((await client()('PUT', '/api/teacher/privacy', { officer: '남' })).status, 401);

    const first = (await t('GET', '/api/teacher/privacy')).data;
    assert.deepEqual(first.settings, { officer: '', manager: '', retention: '', place: '', alternative: '', effective: '' });
    const slug = first.url.split('/privacy/')[1];
    assert.ok(slug);

    assert.equal((await t('PUT', '/api/teacher/privacy', { officer: 'x'.repeat(101) })).status, 400);
    assert.equal((await t('PUT', '/api/teacher/privacy', { officer: ' 가상 교감 · 000-0000 ', retention: '2026학년도 1학기 종료 시', extra: '무시' })).status, 200);

    const pub = await client()('GET', `/api/public/privacy/${slug}`);
    assert.equal(pub.status, 200);
    assert.equal(pub.data.schoolName, '가상중');
    assert.deepEqual(pub.data.settings, { officer: '가상 교감 · 000-0000', manager: '', retention: '2026학년도 1학기 종료 시', place: '', alternative: '', effective: '' });
    assert.equal((await client()('GET', '/api/public/privacy/nope')).status, 404);

    // 화면 주소는 누구나 열 수 있고, 다른 학교 교사는 자기 학교 것만 고친다
    assert.equal((await fetch(`${base}/privacy/${slug}`)).status, 200);
    const other = client();
    await other('POST', '/api/teacher/signup', { schoolName: '다른중', name: '박교사', loginId: 'priv2', password: 'password-1234' });
    await other('PUT', '/api/teacher/privacy', { officer: '다른 교감' });
    assert.equal((await client()('GET', `/api/public/privacy/${slug}`)).data.settings.officer, '가상 교감 · 000-0000');
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
