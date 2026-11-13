'use strict';
/* 모집 삭제, 접수 중 마감 시각 바꾸기 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

test('접수 중에 마감 시각을 늦출 수 있고, 모집을 지우면 딸린 자료와 학생 접속이 모두 없어진다', async () => {
  let clock = new Date('2026-11-13T00:00:00Z');
  const app = createApp({ dbPath: ':memory:', now: () => clock });
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
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'del1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '지울 모집', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    await t('PUT', `${R}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호', programs: [{ name: '축구', target: 1 }, { name: '탁구', target: 1 }], deadlineAt: '2026-11-13T01:00:00Z' });
    await t('PUT', `${R}/auth`, { authMode: 'NAME' });
    assert.equal((await t('PUT', `${R}/deadline`, { deadlineAt: '2026-11-13T05:00:00Z' })).status, 409); // 준비 단계에서는 설정에서 바꾼다
    assert.equal((await t('POST', `${R}/open`, {})).status, 200);
    let d = (await t('GET', R)).data;
    const slug = d.joinUrl.split('/r/')[1];
    const pid = d.programs[0].id;

    // 마감 시각이 지나면 학생은 낼 수 없고, 교사 화면에도 지났다고 알려 준다
    clock = new Date('2026-11-13T02:00:00Z');
    const s = client();
    assert.equal((await s('POST', '/api/student/login', { slug, grade: 1, class: 1, number: 1, name: '김하늘' })).status, 200);
    assert.equal((await s('POST', '/api/student/application', { prefs: [pid], requestId: 'deadline-test-1', baseVersion: 0 })).status, 403);
    d = (await t('GET', R)).data;
    assert.equal(d.round.status, 'OPEN');
    assert.equal(d.round.deadlinePassed, true);

    // 접수를 멈추지 않고 마감 시각을 늦춘다. 지난 시각으로는 바꿀 수 없다
    assert.equal((await t('PUT', `${R}/deadline`, { deadlineAt: '2026-11-13T01:30:00Z' })).status, 400);
    assert.equal((await t('PUT', `${R}/deadline`, { deadlineAt: '2026-11-13T05:00:00Z' })).status, 200);
    assert.equal((await t('GET', R)).data.round.deadlinePassed, false);
    assert.equal((await s('POST', '/api/student/application', { prefs: [pid], requestId: 'deadline-test-2', baseVersion: 0 })).status, 200);
    assert.equal((await t('PUT', `${R}/deadline`, { deadlineAt: null })).status, 200); // 비우면 직접 마감할 때까지

    // 다른 학교 교사는 지울 수 없다
    const other = client();
    await other('POST', '/api/teacher/signup', { schoolName: '다른중', name: '박교사', loginId: 'del2', password: 'password-1234' });
    assert.equal((await other('POST', `${R}/delete`, {})).status, 404);

    // 삭제: 모집·명부·신청이 없어지고, 학생 접속과 주소도 끊긴다
    assert.equal((await t('POST', `${R}/delete`, {})).status, 200);
    assert.equal((await t('GET', R)).status, 404);
    assert.equal((await t('GET', '/api/teacher/rounds')).data.rounds.length, 0);
    assert.equal((await s('GET', '/api/student/me')).status, 401);
    assert.equal((await s('GET', `/api/public/rounds/${slug}`)).status, 404);
    for (const table of ['students', 'programs', 'applications', 'application_versions']) assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM ${table}`).n, 0, table);
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
