'use strict';
/* 지난 모집과 겹치지 않게, 자유학기 묶음(시간대마다 모집 하나) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

async function boot() {
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
  const stop = () => { app.server.closeAllConnections(); app.server.close(); };
  return { app, client, stop };
}
const ROSTER = '학년,반,번호,이름\n1,1,1,김하늘\n1,1,2,이지호\n1,1,3,박서연\n1,1,4,최민준';
const NAMES = ['김하늘', '이지호', '박서연', '최민준'];
const PROGRAMS = ['축구', '탁구', '밴드', '코딩'].map((name) => ({ name, target: 1 }));
let seq = 0;
const rid = () => `avoid-test-${String(++seq).padStart(4, '0')}`;

test('2학기 모집에서 1학기에 배정받은 프로그램은 고를 수도, 배정받을 수도 없다', async () => {
  const { client, stop } = await boot();
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'avoid1', password: 'password-1234' });
    const make = async (title) => {
      const { id } = (await t('POST', '/api/teacher/rounds', { title, year: 2026 })).data;
      await t('PUT', `/api/teacher/rounds/${id}/bundle`, { csv: ROSTER, programs: PROGRAMS });
      await t('PUT', `/api/teacher/rounds/${id}/auth`, { authMode: 'NAME' });
      return id;
    };
    const login = async (id, number) => {
      const s = client();
      const slug = (await t('GET', `/api/teacher/rounds/${id}`)).data.joinUrl.split('/r/')[1];
      assert.equal((await s('POST', '/api/student/login', { slug, grade: 1, class: 1, number, name: NAMES[number - 1] })).status, 200);
      return s;
    };
    // 1학기: 모두 배정까지
    const a = await make('1학기 동아리');
    const A = `/api/teacher/rounds/${a}`;
    await t('POST', `${A}/open`, {});
    await t('POST', `${A}/close`, {});
    assert.equal((await t('POST', `${A}/allocate`, { includeUnsubmitted: true })).status, 200);
    const first = (await t('GET', A)).data;
    const gotBefore = new Map(first.students.map((s) => [s.number, first.programs.find((p) => p.id === s.result.programId).name]));

    // 2학기: 1학기와 겹치지 않게
    const b = await make('2학기 동아리');
    const B = `/api/teacher/rounds/${b}`;
    assert.equal((await t('PUT', `${B}/avoid`, { ids: [b] })).status, 400); // 자기 자신은 안 된다
    assert.equal((await t('PUT', `${B}/avoid`, { ids: [a] })).status, 200);
    assert.equal((await t('PUT', `${A.replace(String(a), String(a))}/avoid`, { ids: [b] })).status, 409); // 1학기는 이미 준비 단계가 아니다
    let d = (await t('GET', B)).data;
    assert.deepEqual(d.avoid.map((x) => x.id), [a]);
    assert.equal(d.avoidCount, 4); // 학생 4명 × 지난번 프로그램 1개
    assert.equal((await t('POST', `${B}/open`, {})).status, 200);

    // 학생 화면: 지난번 프로그램은 목록에서 빠지고, 억지로 내도 받지 않는다
    const s1 = await login(b, 1);
    const me = (await s1('GET', '/api/student/me')).data;
    assert.deepEqual(me.taken, [gotBefore.get(1)]);
    assert.ok(!me.programs.some((p) => p.name === gotBefore.get(1)));
    assert.equal(me.programs.length, 3);
    const banned = d.programs.find((p) => p.name === gotBefore.get(1)).id;
    assert.equal((await s1('POST', '/api/student/application', { prefs: [banned], requestId: rid(), baseVersion: 0 })).status, 400);
    assert.equal((await s1('POST', '/api/student/application', { prefs: [me.programs[0].id], requestId: rid(), baseVersion: 0 })).status, 200);

    await t('POST', `${B}/close`, {});
    assert.equal((await t('POST', `${B}/allocate`, { includeUnsubmitted: true })).status, 200);
    d = (await t('GET', B)).data;
    for (const s of d.students) assert.notEqual(d.programs.find((p) => p.id === s.result.programId).name, gotBefore.get(s.number), `${s.number}번이 지난번과 같은 곳에 배정됨`);
    assert.ok(d.run.verification.ok !== false);

    // 2학기가 1학기 결과를 기준으로 배정된 뒤에는 1학기 배정을 먼저 취소할 수 없다
    assert.equal((await t('POST', `${A}/unallocate`, {})).status, 409);
    assert.equal((await t('POST', `${B}/unallocate`, {})).status, 200);
    assert.equal((await t('POST', `${A}/unallocate`, {})).status, 200);
  } finally {
    stop();
  }
});
