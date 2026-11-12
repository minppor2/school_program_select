'use strict';
/* 미제출 학생이 있어도 교사가 "미제출 포함"을 고르면 배정된다. 미제출 학생은 남은 자리로 간다. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

test('미제출 포함 배정: 교사가 분명히 고른 경우에만 진행하고, 미제출 학생은 남은 자리에 배정되며 그렇게 기록된다', async () => {
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
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'unsub1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '미제출 시험', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    const names = ['김하늘', '이지호', '박보람', '최도윤', '정다온', '강바다'];
    await t('PUT', `${R}/bundle`, { csv: '학년,반,번호,이름\n' + names.map((n, i) => `1,1,${i + 1},${n}`).join('\n'), programs: [{ name: '축구', target: 2 }, { name: '탁구', target: 2 }, { name: '줄넘기', target: 2 }] });
    await t('PUT', `${R}/auth`, { authMode: 'NAME' });
    await t('POST', `${R}/open`, {});
    let d = (await t('GET', R)).data;
    const slug = d.joinUrl.split('/r/')[1];
    const pid = Object.fromEntries(d.programs.map((p) => [p.name, p.id]));
    const students = [];
    for (let i = 0; i < 6; i++) {
      const s = client();
      await s('POST', '/api/student/login', { slug, grade: 1, class: 1, number: i + 1, name: names[i] });
      students.push(s);
      if (i < 4) await s('POST', '/api/student/application', { prefs: [pid['축구']], requestId: `unsub-test-000${i}`, baseVersion: 0 }); // 5·6번은 미제출
    }
    await t('POST', `${R}/close`, {});

    // 아무 표시 없이 누르면 여전히 막는다(실수로 넘어가지 않게). 막힌 뒤에는 아무것도 바뀌지 않는다
    assert.equal((await t('POST', `${R}/allocate`, {})).data.error.code, 'UNRESOLVED');
    assert.equal((await t('POST', `${R}/allocate`, { includeUnsubmitted: 'yes' })).status, 409);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM applications').n, 4);

    const run = await t('POST', `${R}/allocate`, { includeUnsubmitted: true });
    assert.equal(run.status, 200);
    d = (await t('GET', R)).data;
    assert.equal(d.round.status, 'REVIEW');
    assert.ok(d.run.verification.ok);
    // 전원 배정·정원 충족, 미제출 2명은 남은 자리 단계에서 배정
    const counts = {};
    for (const s of d.students) counts[s.result.programId] = (counts[s.result.programId] || 0) + 1;
    assert.deepEqual(Object.values(counts), [2, 2, 2]);
    assert.deepEqual(d.students.slice(4).map((s) => s.result.stage), ['R', 'R']);
    assert.ok(d.students.slice(4).every((s) => s.app.kind === 'NO_PREFERENCE_CONFIRMED' && s.app.note.startsWith('미제출') && s.app.enteredBy === '김교사'));
    assert.equal(app.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'UNSUBMITTED_INCLUDED'").n, 1);
    // 다시 눌러도 같은 결과 하나(미제출 처리가 두 번 쌓이지 않는다)
    assert.equal((await t('POST', `${R}/allocate`, { includeUnsubmitted: true })).data.runId, run.data.runId);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM application_versions').n, 6);

    // 학생 화면: 미제출 학생에게 "접수 완료"라고 하지 않고, 발표 뒤 설명도 신청하지 않았다고 말한다
    let me = (await students[5]('GET', '/api/student/me')).data;
    assert.equal(me.application.unsubmitted, true);
    assert.equal(me.result, null);
    await t('POST', `${R}/publish`, { runId: run.data.runId });
    me = (await students[5]('GET', '/api/student/me')).data;
    assert.deepEqual(me.result.reasons, ['신청하지 않음 · 남은 자리 배정']);
    me = (await students[0]('GET', '/api/student/me')).data;
    assert.equal(me.application.unsubmitted, false);
    assert.ok(!me.result.reasons.join().includes('신청하지 않음'));
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});

test('미제출 포함 배정이 실패하면(정원 문제 등) 미제출 처리도 함께 취소된다', async () => {
  const app = createApp({ dbPath: ':memory:' });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const t = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, data: await res.json() };
  };
  try {
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'unsub2', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '실패 시험', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    await t('PUT', `${R}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호', programs: [{ name: '축구', target: 1 }, { name: '탁구', target: 1 }] });
    await t('PUT', `${R}/auth`, { authMode: 'NAME' });
    await t('POST', `${R}/open`, {});
    await t('POST', `${R}/close`, {});
    // 마감 뒤 누군가 DB 의 정원을 깨뜨린 상황을 흉내 낸다(합계 ≠ 학생 수)
    app.db.run('UPDATE programs SET target = 5 WHERE round_id = ? AND name = ?', id, '축구');
    const failed = await t('POST', `${R}/allocate`, { includeUnsubmitted: true });
    assert.equal(failed.status, 422);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM applications').n, 0);
    assert.equal(app.db.get('SELECT COUNT(*) AS n FROM application_versions').n, 0);
    assert.equal((await t('GET', R)).data.round.status, 'CLOSED');
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
