'use strict';
/* 학생 안내문(입장 전 팝업)과 결과 열람 종료 시각. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

test('안내문과 열람 기간: 발표 뒤 기한까지만 학생에게 보이고, 교사 화면에는 계속 남는다', async () => {
  const clock = { t: new Date('2026-11-12T00:00:00.000Z') };
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
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'notice1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '열람 시험', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    await t('PUT', `${R}/bundle`, { csv: '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호\n', programs: [{ name: '축구', target: 1 }, { name: '탁구', target: 1 }] });
    await t('PUT', `${R}/auth`, { authMode: 'NAME' });
    const slug = (await t('GET', R)).data.joinUrl.split('/r/')[1];
    const pub = async () => (await client()('GET', `/api/public/rounds/${slug}`)).data.round;

    // 안내문: 준비·접수 중 언제든 고칠 수 있고, 학생은 입장 전에 본다. 스크립트는 글자 그대로 저장된다(화면은 textContent 로만 출력)
    assert.equal((await pub()).notice, '');
    assert.equal((await t('PUT', `${R}/notice`, { notice: '신청 기간: 11/20 3교시 ~ 11/21 16시\r\n<b>1지망은 꼭!</b>' })).status, 200);
    assert.equal((await pub()).notice, '신청 기간: 11/20 3교시 ~ 11/21 16시\n<b>1지망은 꼭!</b>');
    assert.equal((await t('PUT', `${R}/notice`, { notice: 'x'.repeat(601) })).status, 400);
    await t('POST', `${R}/open`, {});
    assert.equal((await t('PUT', `${R}/notice`, { notice: '수정된 안내' })).status, 200);
    assert.equal((await pub()).notice, '수정된 안내');

    const pid = (await t('GET', R)).data.programs.map((p) => p.id);
    const students = [];
    for (const [n, name] of [[1, '김하늘'], [2, '이지호']]) {
      const s = client();
      await s('POST', '/api/student/login', { slug, grade: 1, class: 1, number: n, name });
      await s('POST', '/api/student/application', { prefs: [pid[0]], requestId: `view-test-000${n}`, baseVersion: 0 });
      students.push(s);
    }
    await t('POST', `${R}/close`, {});
    const runId = (await t('POST', `${R}/allocate`, {})).data.runId;

    // 열람 종료는 지난 시각으로 정할 수 없고, 발표 전에는 학생 공개 정보에 나오지 않는다
    assert.equal((await t('PUT', `${R}/view-until`, { viewUntil: '2026-11-11T00:00:00.000Z' })).status, 400);
    assert.equal((await t('PUT', `${R}/view-until`, { viewUntil: '2026-11-12T06:00:00.000Z' })).status, 200);
    assert.equal((await pub()).viewUntil, null);
    await t('POST', `${R}/publish`, { runId });

    clock.t = new Date('2026-11-12T00:30:00.000Z');
    let me = (await students[0]('GET', '/api/student/me')).data;
    assert.equal(me.round.status, 'published');
    assert.equal(me.round.viewUntil, '2026-11-12T06:00:00.000Z');
    assert.ok(me.result.programName);
    assert.deepEqual(me.application.prefs, [pid[0]]); // 발표 뒤에도 내가 낸 희망을 함께 본다

    // 기한이 지나면(정각 포함) 새로 들어와도 결과·신청이 보이지 않는다
    clock.t = new Date('2026-11-12T06:00:00.000Z');
    const late = client();
    assert.equal((await late('POST', '/api/student/login', { slug, grade: 1, class: 1, number: 1, name: '김하늘' })).status, 200);
    me = (await late('GET', '/api/student/me')).data;
    assert.equal(me.round.status, 'ended');
    assert.equal(me.result, null);
    assert.equal(me.application, null);
    assert.equal((await pub()).status, 'ended');
    // 교사 화면과 명단 내려받기는 그대로
    const d = (await t('GET', R)).data;
    assert.equal(d.round.viewEnded, true);
    assert.ok(d.students.every((s) => s.result));
    // 기한을 늦추거나 없애면 다시 보인다
    assert.equal((await t('PUT', `${R}/view-until`, { viewUntil: null })).status, 200);
    assert.ok((await late('GET', '/api/student/me')).data.result.programName);
    // 다른 학교 교사는 바꿀 수 없다
    const other = client();
    await other('POST', '/api/teacher/signup', { schoolName: '다른중', name: '박교사', loginId: 'notice2', password: 'password-1234' });
    assert.equal((await other('PUT', `${R}/view-until`, { viewUntil: null })).status, 404);
    assert.equal((await other('PUT', `${R}/notice`, { notice: 'x' })).status, 404);
  } finally {
    app.server.closeAllConnections();
    app.server.close();
  }
});
