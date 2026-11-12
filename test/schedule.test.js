'use strict';
/* 접수 시작 예약: 교사가 시작 시각을 정해 두고 '접수 예약'을 누르면, 그 시각부터 자동으로 신청이 열린다. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

test('시작 예약: 예약 시각 전에는 들어와도 신청할 수 없고, 시각이 되면 자동으로 열리며, 마감 시각에 자동으로 닫힌다', async () => {
  const clock = { t: new Date('2026-11-12T08:00:00.000Z') }; // 교사가 퇴근 전 예약
  const app = createApp({ dbPath: ':memory:', now: () => new Date(clock.t) });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, p, body) => {
      const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      return { status: res.status, data: await res.json() };
    };
  };
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'sched1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '예약 시험', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    await t('PUT', `${R}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호', programs: [{ name: '축구', target: 1 }, { name: '탁구', target: 1 }] });
    await t('PUT', `${R}/auth`, { authMode: 'NAME' });
    const settings = (openAt, deadlineAt) => t('PUT', `${R}/settings`, { title: '예약 시험', year: 2026, contact: '', openAt, deadlineAt, allowNoPref: false });
    // 시작이 마감보다 뒤면 저장되지 않는다
    assert.equal((await settings('2026-11-12T12:00:00.000Z', '2026-11-12T10:00:00.000Z')).status, 400);
    assert.equal((await settings('2026-11-12T10:00:00.000Z', '2026-11-12T10:30:00.000Z')).status, 200); // 10시 시작, 10시 30분 마감
    let d = (await t('GET', R)).data;
    assert.equal(d.round.openAt, '2026-11-12T10:00:00.000Z');
    const slug = d.joinUrl.split('/r/')[1];
    const pid = d.programs[0].id;
    const pub = async () => (await client()('GET', `/api/public/rounds/${slug}`)).data.round;

    // 교사가 '접수 예약'을 누른다(= 접수 시작). 아직 시각 전이므로 '시작 예정'
    assert.equal((await t('POST', `${R}/open`, {})).status, 200);
    d = (await t('GET', R)).data;
    assert.equal(d.round.status, 'OPEN');
    assert.equal(d.round.scheduled, true);
    assert.equal((await pub()).status, 'scheduled');
    assert.equal((await pub()).openAt, '2026-11-12T10:00:00.000Z');

    // 학생은 미리 들어와 기다릴 수 있지만 신청은 받지 않는다(1초 전까지)
    clock.t = new Date('2026-11-12T09:59:59.999Z');
    const s = client();
    assert.equal((await s('POST', '/api/student/login', { slug, grade: 1, class: 1, number: 1, name: '김하늘' })).status, 200);
    assert.equal((await s('GET', '/api/student/me')).data.round.status, 'scheduled');
    const early = await s('POST', '/api/student/application', { prefs: [pid], requestId: 'sched-test-0001', baseVersion: 0 });
    assert.equal(early.status, 403);
    assert.equal(early.data.error.code, 'NOT_YET');

    // 시각이 되면(정각 포함) 아무도 누르지 않아도 열린다
    clock.t = new Date('2026-11-12T10:00:00.000Z');
    assert.equal((await pub()).status, 'open');
    assert.equal((await s('GET', '/api/student/me')).data.round.status, 'open');
    assert.equal((await s('POST', '/api/student/application', { prefs: [pid], requestId: 'sched-test-0002', baseVersion: 0 })).status, 200);
    assert.equal((await t('GET', R)).data.round.scheduled, false);

    // 마감 시각이 되면 자동으로 닫힌다
    clock.t = new Date('2026-11-12T10:30:00.000Z');
    assert.equal((await pub()).status, 'closed');
    assert.equal((await s('POST', '/api/student/application', { prefs: [pid], requestId: 'sched-test-0003', baseVersion: 1 })).data.error.code, 'CLOSED');
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
