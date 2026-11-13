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

test('자유학기 묶음: 시간대마다 따로 내고, 같은 영역에서는 네 시간대 모두 다른 프로그램을 받는다', async () => {
  const { client, stop } = await boot();
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'group1', password: 'password-1234' });
    assert.equal((await t('POST', '/api/teacher/groups', { title: '자유학기', year: 2026, terms: 1, topics: 1, careers: 0 })).status, 400); // 시간대 하나는 일반 모집으로
    const made = (await t('POST', '/api/teacher/groups', { title: '자유학기', year: 2026, terms: 2, topics: 2, careers: 1 })).data;
    assert.equal(made.ids.length, 6);
    const list = (await t('GET', '/api/teacher/rounds')).data.rounds.filter((r) => r.groupKey === made.key).sort((x, y) => x.groupSort - y.groupSort);
    assert.deepEqual(list.map((r) => r.slotLabel), ['1기 주제선택 A', '1기 주제선택 B', '1기 진로탐색', '2기 주제선택 A', '2기 주제선택 B', '2기 진로탐색']);
    const R = (r) => `/api/teacher/rounds/${r.id}`;
    const topics = list.filter((r) => r.slotLabel.includes('주제선택'));
    const careers = list.filter((r) => r.slotLabel.includes('진로탐색'));

    // 같은 영역의 앞 시간대와만 겹치지 않게 걸려 있다
    assert.deepEqual((await t('GET', R(topics[3]))).data.avoid.map((x) => x.id), topics.slice(0, 3).map((r) => r.id));
    assert.deepEqual((await t('GET', R(careers[1]))).data.avoid.map((x) => x.id), [careers[0].id]);

    // 명부·입장 방법·안내문은 한 시간대에만 넣어도 묶음 전체에 들어간다
    assert.equal((await t('PUT', `${R(list[0])}/auth`, { authMode: 'CODE' })).status, 400);
    assert.equal((await t('PUT', `${R(list[0])}/roster`, { csv: ROSTER })).status, 200);
    assert.equal((await t('PUT', `${R(list[0])}/notice`, { notice: '시간대마다 내세요' })).status, 200);
    for (const r of list) {
      const d = (await t('GET', R(r))).data;
      assert.equal(d.students.length, 4, r.slotLabel);
      assert.equal(d.round.notice, '시간대마다 내세요');
      assert.equal(d.round.authMode, 'NAME');
      assert.equal((await t('PUT', `${R(r)}/programs`, { programs: PROGRAMS })).status, 200);
      assert.equal((await t('POST', `${R(r)}/open`, {})).status, 200);
    }

    // 학생: 묶음 주소로 시간대 목록을 보고, 한 번만 본인 확인하면 다른 시간대에도 들어간다
    const pub = (await client()('GET', `/api/public/groups/${made.key}`)).data;
    assert.equal(pub.slots.length, 6);
    assert.equal(pub.student, null);
    const slugs = pub.slots.map((s) => s.slug);
    for (let n = 1; n <= 4; n++) {
      const s = client();
      assert.equal((await s('POST', '/api/student/login', { slug: slugs[0], grade: 1, class: 1, number: n, name: NAMES[n - 1] })).status, 200);
      for (const slug of slugs) {
        const me = (await s('GET', `/api/student/me?slug=${slug}`)).data;
        assert.equal(me.round.slug, slug);
        assert.equal(me.group.key, made.key);
        const wish = me.programs.find((p) => p.name === '축구'); // 모든 시간대에서 축구를 1지망으로
        const rest = me.programs.filter((p) => p.name !== '축구').slice(0, 2).map((p) => p.id);
        assert.equal((await s('POST', '/api/student/application', { prefs: [wish.id, ...rest], requestId: rid(), baseVersion: 0 })).status, 200);
      }
      if (n === 1) {
        const mine = (await s('GET', `/api/public/groups/${made.key}`)).data;
        assert.equal(mine.student.name, '김하늘');
        assert.ok(mine.slots.every((x) => x.submitted === true));
      }
    }
    // 묶음 밖 모집에는 본인 확인이 이어지지 않는다
    const outside = (await t('POST', '/api/teacher/rounds', { title: '다른 모집', year: 2026 })).data.id;
    await t('PUT', `/api/teacher/rounds/${outside}/bundle`, { csv: ROSTER, programs: PROGRAMS });
    const outSlug = (await t('GET', `/api/teacher/rounds/${outside}`)).data.joinUrl.split('/r/')[1];
    const s9 = client();
    await s9('POST', '/api/student/login', { slug: slugs[0], grade: 1, class: 1, number: 1, name: '김하늘' });
    assert.equal((await s9('GET', `/api/student/me?slug=${outSlug}`)).data.round.slug, slugs[0]);

    for (const r of list) assert.equal((await t('POST', `${R(r)}/close`, {})).status, 200);
    // 배정은 앞 시간대부터: 뒤 시간대를 먼저 배정할 수 없다
    assert.equal((await t('POST', `${R(topics[1])}/allocate`, {})).status, 409);
    for (const r of list) assert.equal((await t('POST', `${R(r)}/allocate`, {})).status, 200, r.slotLabel);

    // 주제선택 네 시간대: 학생마다 모두 다른 프로그램. 진로탐색 두 시간대도 서로 다르다.
    const table = (await t('GET', `/api/teacher/groups/${made.key}/table`)).data;
    assert.equal(table.rows.length, 4);
    assert.deepEqual(table.pending, []);
    for (const row of table.rows) {
      const got = topics.map((r) => row.programs[r.slotLabel]);
      assert.equal(new Set(got).size, 4, `${row.name}: ${got.join(', ')}`);
      assert.ok(got.includes('축구')); // 네 번 가운데 한 번은 축구
      assert.notEqual(row.programs[careers[0].slotLabel], row.programs[careers[1].slotLabel]);
    }
    for (const r of list) assert.ok((await t('GET', R(r))).data.run, r.slotLabel);

    // 앞 시간대 배정은 뒤 시간대 배정을 취소한 다음에만 취소할 수 있다
    assert.equal((await t('POST', `${R(topics[0])}/unallocate`, {})).status, 409);

    // 공개하면 학생의 시간대 목록에 배정 결과가 함께 보인다
    for (const r of list) {
      const d = (await t('GET', R(r))).data;
      assert.equal((await t('POST', `${R(r)}/publish`, { runId: d.run.id })).status, 200);
    }
    const s1 = client();
    await s1('POST', '/api/student/login', { slug: slugs[0], grade: 1, class: 1, number: 1, name: '김하늘' });
    const after = (await s1('GET', `/api/public/groups/${made.key}`)).data;
    assert.ok(after.slots.every((x) => x.status === 'published' && x.result && x.result.programName));
  } finally {
    stop();
  }
});
