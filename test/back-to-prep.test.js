'use strict';
/* 접수 중 → 준비 단계로 돌아가기: 학생은 볼 수만 있고, 교사가 고쳐도 영향 없는 신청은 그대로 남는다. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

test('미제출이 있어도 마감되고, 준비 단계로 돌아가면 학생은 볼 수만 있으며, 고친 뒤 이어서 받는다', async () => {
  const app = createApp({ dbPath: ':memory:' });
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
  let seq = 0;
  const rid = () => `back-test-${String(++seq).padStart(4, '0')}`;
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'back1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '되돌리기 시험', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    const csv = (rows) => '학년,반,번호,이름\n' + rows.map((r) => r.join(',')).join('\n');
    await t('PUT', `${R}/bundle`, { csv: csv([[1, 1, 1, '김하늘'], [1, 1, 2, '이지호'], [1, 1, 3, '박보람'], [1, 1, 4, '최도윤']]), programs: [{ name: '축구', target: 2 }, { name: '탁구', target: 1 }, { name: '줄넘기', target: 1 }] });
    await t('PUT', `${R}/auth`, { authMode: 'NAME' });
    const dash = async () => (await t('GET', R)).data;
    const slug = (await dash()).joinUrl.split('/r/')[1];
    const pid = Object.fromEntries((await dash()).programs.map((p) => [p.name, p.id]));
    const pub = async () => (await client()('GET', `/api/public/rounds/${slug}`)).data.round.status;
    assert.equal(await pub(), 'before');
    assert.equal((await t('POST', `${R}/pause`, {})).status, 409); // 접수 중일 때만 돌아갈 수 있다
    await t('POST', `${R}/open`, {});
    const seed = app.db.get('SELECT lottery_seed FROM rounds WHERE id = ?', id).lottery_seed;

    const login = async (n, name) => { const c = client(); assert.equal((await c('POST', '/api/student/login', { slug, grade: 1, class: 1, number: n, name })).status, 200); return c; };
    const s1 = await login(1, '김하늘');
    const s2 = await login(2, '이지호');
    const s3 = await login(3, '박보람');
    await s1('POST', '/api/student/application', { prefs: [pid['축구']], requestId: rid(), baseVersion: 0 });
    await s2('POST', '/api/student/application', { prefs: [pid['탁구'], pid['축구']], requestId: rid(), baseVersion: 0 });
    await s3('POST', '/api/student/application', { prefs: [pid['줄넘기']], requestId: rid(), baseVersion: 0 });

    // 준비 단계로 돌아가기: 학생은 자기 신청을 볼 수 있지만 고치거나 새로 낼 수 없다
    assert.equal((await t('POST', `${R}/pause`, {})).status, 200);
    let d = await dash();
    assert.equal(d.round.status, 'PREP');
    assert.equal(d.paused, true);
    assert.equal(await pub(), 'paused');
    let me = (await s1('GET', '/api/student/me')).data;
    assert.equal(me.round.status, 'paused');
    assert.deepEqual(me.application.prefs, [pid['축구']]);
    assert.equal((await s1('POST', '/api/student/application', { prefs: [pid['탁구']], requestId: rid(), baseVersion: 1 })).data.error.code, 'CLOSED');
    const s4 = await login(4, '최도윤'); // 멈춘 동안에도 들어와 볼 수는 있다
    assert.equal((await s4('POST', '/api/student/application', { prefs: [pid['축구']], requestId: rid(), baseVersion: 0 })).status, 403);

    // 명부를 고친다: 학년·반·번호가 같은 학생의 신청은 그대로, 이름 수정 반영, 빠진 학생(4번)만 지워지고 새 학생(5번) 추가
    const roster = await t('PUT', `${R}/roster`, { csv: csv([[1, 1, 1, '김하늘'], [1, 1, 2, '이지후'], [1, 1, 3, '박보람'], [1, 1, 5, '정다온']]) });
    assert.deepEqual({ added: roster.data.added, removed: roster.data.removed, reset: roster.data.reset }, { added: 1, removed: 1, reset: 0 });
    d = await dash();
    assert.deepEqual(d.students.map((s) => [s.number, s.name, !!s.app]), [[1, '김하늘', true], [2, '이지후', true], [3, '박보람', true], [5, '정다온', false]]);
    assert.deepEqual((await s2('GET', '/api/student/me')).data.student.name, '이지후'); // 접속도 유지

    // 프로그램을 고친다: 줄넘기를 없애면 줄넘기를 고른 학생(3번)만 미제출로 돌아간다. 순위를 몰래 당기지 않는다
    const programs = d.programs.filter((p) => p.name !== '줄넘기').map((p) => ({ ...p, target: 2 }));
    const saved = await t('PUT', `${R}/programs`, { programs });
    assert.equal(saved.data.reset, 1);
    d = await dash();
    assert.deepEqual(d.students.map((s) => !!s.app), [true, true, false, false]);
    assert.deepEqual(d.students[1].app.prefs, [pid['탁구'], pid['축구']]);
    // 참여 제한을 건다: 2번은 탁구 불가 → 탁구를 1지망으로 낸 2번의 신청이 미제출로 돌아간다
    const limit = await t('PUT', `${R}/restrictions`, { pairs: [{ studentId: d.students[1].id, programId: pid['탁구'] }] });
    assert.equal(limit.data.reset, 1);
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'APPLICATION_RESET'").n, 2);

    // 다시 접수 시작: 추첨 기준은 그대로, 남은 신청은 이어지고, 되돌려진 학생은 다시 낼 수 있다(이력 버전이 겹치지 않는다)
    assert.equal((await t('POST', `${R}/open`, {})).status, 200);
    assert.equal(app.db.get('SELECT lottery_seed FROM rounds WHERE id = ?', id).lottery_seed, seed);
    me = (await s1('GET', '/api/student/me')).data;
    assert.equal(me.round.status, 'open');
    assert.deepEqual(me.application.prefs, [pid['축구']]);
    me = (await s3('GET', '/api/student/me')).data;
    assert.equal(me.application, null);
    assert.deepEqual(me.programs.map((p) => p.name), ['축구', '탁구']);
    const again = await s3('POST', '/api/student/application', { prefs: [pid['축구']], requestId: rid(), baseVersion: 0 });
    assert.equal(again.status, 200);
    assert.equal(again.data.version, 2);

    // 미제출이 있어도 접수 마감은 된다(배정은 미제출을 채워야 가능)
    assert.equal((await t('POST', `${R}/close`, {})).status, 200);
    d = await dash();
    assert.equal(d.round.status, 'CLOSED');
    assert.equal(d.students.filter((s) => !s.app).length, 2);
    assert.equal((await t('POST', `${R}/allocate`, {})).data.error.code, 'UNRESOLVED');
    assert.equal((await t('POST', `${R}/pause`, {})).status, 409); // 마감 뒤에는 '접수 다시 열기'를 거쳐야 한다
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
