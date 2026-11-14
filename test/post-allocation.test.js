'use strict';
/* 배정 뒤 고치기(배정 바꾸기·전출·전입), 학교 공통 학생 주소 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

test('배정 뒤 전출·전입·배정 바꾸기를 해도 공개할 수 있고, 공통 주소에는 접수 중·발표된 모집만 나온다', async () => {
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
      return { status: res.status, data, headers: res.headers };
    };
  };
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'post1', password: 'password-1234' });
    const make = async (title, grade) => {
      const { id } = (await t('POST', '/api/teacher/rounds', { title, year: 2026, grade })).data;
      await t('PUT', `/api/teacher/rounds/${id}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호\n1,1,3,박서연\n1,1,4,최민준', programs: [{ name: '축구', target: 2 }, { name: '탁구', target: 2 }] });
      await t('PUT', `/api/teacher/rounds/${id}/auth`, { authMode: 'NAME' });
      return id;
    };
    assert.equal((await t('POST', '/api/teacher/rounds', { title: '잘못된 학년', year: 2026, grade: 9 })).status, 400);
    const id = await make('동아리', 1);
    const R = `/api/teacher/rounds/${id}`;

    // 공통 주소: 준비 단계 모집은 나오지 않는다
    const list = (await t('GET', '/api/teacher/rounds')).data;
    const slug = list.schoolUrl.split('/s/')[1];
    assert.ok(slug);
    let portal = (await client()('GET', `/api/public/schools/${slug}`)).data;
    assert.equal(portal.schoolName, '가상중');
    assert.deepEqual(portal.items, []);
    assert.equal((await client()('GET', '/api/public/schools/no-such-school')).status, 404);

    await t('POST', `${R}/open`, {});
    portal = (await client()('GET', `/api/public/schools/${slug}`)).data;
    assert.deepEqual(portal.items.map((x) => [x.title, x.status, x.grade]), [['동아리', 'open', 1]]);
    // 학생 화면에서 목록으로 돌아갈 주소와 대상 학년을 알려 준다
    const pubRound = (await client()('GET', portal.items[0].url.replace('/r/', '/api/public/rounds/'))).data.round;
    assert.equal(pubRound.schoolSlug, slug);
    assert.equal(pubRound.grade, 1);
    assert.ok(portal.items[0].url.startsWith('/r/'));
    await t('POST', `${R}/close`, {});
    assert.deepEqual((await client()('GET', `/api/public/schools/${slug}`)).data.items, []); // 마감~검토 중에는 숨긴다

    // 배정 전에는 고칠 수 없다
    let d = (await t('GET', R)).data;
    assert.equal((await t('POST', `${R}/transfer-in`, { grade: 1, class: 1, number: 9, name: '전입생', programId: d.programs[0].id })).status, 409);
    assert.equal((await t('POST', `${R}/allocate`, { includeUnsubmitted: true })).status, 200);
    d = (await t('GET', R)).data;
    const soccer = d.programs.find((p) => p.name === '축구'), pingpong = d.programs.find((p) => p.name === '탁구');
    const inSoccer = d.students.filter((s) => s.result.programId === soccer.id);
    assert.equal(inSoccer.length, 2);

    // 배정 바꾸기: 축구 → 탁구
    const moved = inSoccer[0];
    assert.equal((await t('PUT', `${R}/students/${moved.id}/result`, { programId: 999999 })).status, 400);
    assert.equal((await t('PUT', `${R}/students/${moved.id}/result`, { programId: pingpong.id })).status, 200);
    d = (await t('GET', R)).data;
    assert.equal(d.students.find((s) => s.id === moved.id).result.programId, pingpong.id);
    assert.equal(d.run.verification.manual, 1);
    assert.ok(d.run.verification.checks.some((c) => c.name === 'TARGETS_MET' && !c.ok)); // 인원이 달라졌다고 알려 준다

    // 전출: 명단과 결과에서 빠진다
    const gone = d.students.find((s) => s.result.programId === pingpong.id && s.id !== moved.id);
    assert.equal((await t('POST', `${R}/students/${gone.id}/transfer-out`, {})).status, 200);
    d = (await t('GET', R)).data;
    assert.equal(d.students.length, 3);
    assert.ok(!d.students.some((s) => s.id === gone.id));

    // 전입: 명단에 더하고 바로 배정. 같은 학번은 받지 않는다.
    assert.equal((await t('POST', `${R}/transfer-in`, { grade: 1, class: 1, number: d.students[0].number, name: '중복', programId: soccer.id })).status, 409); // 남아 있는 학생의 번호
    assert.equal((await t('POST', `${R}/transfer-in`, { grade: 1, class: 1, number: 9, name: '', programId: soccer.id })).status, 400);
    assert.equal((await t('POST', `${R}/transfer-in`, { grade: 1, class: 1, number: 9, name: '전입생', programId: soccer.id })).status, 200);
    d = (await t('GET', R)).data;
    assert.equal(d.students.length, 4);
    const fresh = d.students.find((s) => s.number === 9);
    assert.equal(fresh.result.programId, soccer.id);
    assert.equal(d.run.verification.manual, 3);
    assert.ok(d.run.verification.checks.every((c) => c.ok), JSON.stringify(d.run.verification.checks)); // 다시 2명씩

    // 고친 뒤에도 공개할 수 있고, 명단 내보내기에 반영된다
    assert.equal((await t('POST', `${R}/publish`, { runId: d.run.id })).status, 200);
    const out = (await t('GET', `${R}/export?by=class&format=json`)).data;
    assert.deepEqual(out.rows.map((r) => r.name).sort(), d.students.map((s) => s.name).sort());
    assert.equal(out.rows.find((r) => r.name === '전입생').program, '축구');

    // 전입생도 같은 주소로 들어와 결과를 본다. 공개 뒤에도 고칠 수 있다.
    const s = client();
    const roundSlug = d.joinUrl.split('/r/')[1];
    assert.equal((await s('POST', '/api/student/login', { slug: roundSlug, grade: 1, class: 1, number: 9, name: '전입생' })).status, 200);
    assert.equal((await s('GET', '/api/student/me')).data.result.programName, '축구');
    assert.equal((await t('PUT', `${R}/students/${fresh.id}/result`, { programId: pingpong.id })).status, 200);
    assert.equal((await s('GET', '/api/student/me')).data.result.programName, '탁구');

    // 공통 주소: 발표된 모집과 새로 접수 중인 모집이 함께 나온다
    const id2 = await make('스포츠클럽'); // 대상을 정하지 않으면 전교생
    assert.equal((await t('GET', `/api/teacher/rounds/${id2}`)).data.round.grade, 0);
    // 준비 단계에서 대상을 바꿀 수 있다
    const r2 = (await t('GET', `/api/teacher/rounds/${id2}`)).data.round;
    assert.equal((await t('PUT', `/api/teacher/rounds/${id2}/settings`, { title: r2.title, year: r2.year, grade: 2, contact: '', deadlineAt: null, openAt: null, allowNoPref: false })).status, 200);
    assert.equal((await t('GET', `/api/teacher/rounds/${id2}`)).data.round.grade, 2);
    await t('POST', `/api/teacher/rounds/${id2}/open`, {});
    portal = (await client()('GET', `/api/public/schools/${slug}`)).data;
    assert.deepEqual(portal.items.map((x) => [x.title, x.status, x.grade]), [['스포츠클럽', 'open', 2], ['동아리', 'published', 1]]);
    // 공통 화면은 같은 사이트의 미리보기 틀 안에서만 열린다
    const page = await client()('GET', `/s/${slug}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
