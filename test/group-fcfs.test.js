'use strict';
/* 자유학기 묶음(선착순): 한 번에 신청, 정원·겹침 판정, 남은 자리 무작위 배정 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');
const fcfs = require('../src/fcfs');
const { runScenario } = require('../scripts/simulate-fcfs');

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
  return { app, client, stop: () => { app.server.closeAllConnections(); app.server.close(); } };
}
const NAMES = ['김하늘', '이지호', '박서연', '최민준'];
const ROSTER = '학년,반,번호,이름\n' + NAMES.map((n, i) => `1,1,${i + 1},${n}`).join('\n');
const PROGRAMS = ['축구', '탁구', '밴드', '코딩'].map((name) => ({ name, target: 1 }));
let seq = 0;
const rid = () => `fcfs-test-${String(++seq).padStart(4, '0')}`;

test('계산: 자리를 잡을 때마다 남은 학생이 갈 곳을 지키고, 마감 뒤 전원을 겹치지 않게 채운다', () => {
  // 두 시간대, 프로그램 둘, 정원 1씩, 학생 둘 — 가장 빡빡한 경우
  const input = {
    slots: [{ id: 1, area: '주제선택', students: ['a', 'b'] }, { id: 2, area: '주제선택', students: ['a', 'b'] }],
    programs: [{ id: 11, slot: 1, key: 'x', capacity: 1 }, { id: 12, slot: 1, key: 'y', capacity: 1 }, { id: 21, slot: 2, key: 'x', capacity: 1 }, { id: 22, slot: 2, key: 'y', capacity: 1 }],
    claims: [], forbidden: [],
  };
  const first = fcfs.tryClaim(input, 'a', 1, 11);
  assert.equal(first.ok, true);
  const state = { ...input, claims: first.claims };
  assert.equal(fcfs.tryClaim(state, 'b', 1, 11).code, 'FULL'); // 정원이 참
  assert.equal(fcfs.tryClaim(state, 'a', 2, 21).code, 'DUPLICATE'); // 같은 영역에서 같은 프로그램
  // b 가 둘째 시간대의 y 를 잡으면 a 는 둘째 시간대에 갈 곳이 없어진다(x 는 이미 받았으므로) → 남겨 둔다
  assert.equal(fcfs.tryClaim(state, 'b', 2, 22).code, 'HELD');
  assert.equal(fcfs.tryClaim(state, 'b', 2, 21).ok, true);
  const out = fcfs.fill(state, 'seed');
  assert.notEqual(out.method, 'FORCED');
  assert.equal(fcfs.verify(state, out.fills).ok, true);
  assert.deepEqual(out.fills.map((f) => f.join('/')).sort(), ['a/2/22', 'b/1/12', 'b/2/21']);
  // 여러 상황을 무작위로 만들어 끝까지: 갈 곳 없는 학생·겹침·정원 초과가 없어야 한다
  for (const kind of ['small', 'latin']) {
    for (let seed = 0; seed < (kind === 'small' ? 8 : 2); seed++) {
      const r = runScenario(seed, kind, true);
      if (r.skipped) continue;
      assert.equal(r.ok, true, `${kind}#${seed} ${JSON.stringify(r.checks)}`);
      assert.notEqual(r.method, 'FORCED', `${kind}#${seed}`);
    }
  }
});

test('자유학기 묶음: 한 화면에서 선착순으로 잡고, 못 잡은 시간대는 남은 자리에 겹치지 않게 배정된다', async () => {
  const { client, stop } = await boot();
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'group1', password: 'password-1234' });
    assert.equal((await t('POST', '/api/teacher/groups', { title: '자유학기', year: 2026, terms: 1, topics: 1, careers: 0 })).status, 400); // 시간대 하나는 일반 모집으로
    const made = (await t('POST', '/api/teacher/groups', { title: '자유학기', year: 2026, terms: 2, topics: 2, careers: 1 })).data;
    const G = `/api/teacher/groups/${made.key}`;
    const list = (await t('GET', '/api/teacher/rounds')).data.rounds.filter((r) => r.groupKey === made.key).sort((x, y) => x.groupSort - y.groupSort);
    assert.deepEqual(list.map((r) => r.slotLabel), ['1기 주제선택 A', '1기 주제선택 B', '1기 진로탐색', '2기 주제선택 A', '2기 주제선택 B', '2기 진로탐색']);
    assert.ok(list.every((r) => r.groupMode === 'FCFS'));
    const R = (r) => `/api/teacher/rounds/${r.id}`;
    const topics = list.filter((r) => r.slotLabel.includes('주제선택'));
    const careers = list.filter((r) => r.slotLabel.includes('진로탐색'));

    // 한 번에 준비: 명부는 한 시간대에 넣으면 전체에, 프로그램은 묶음에서 고른 시간대들에
    assert.equal((await t('PUT', `${R(list[0])}/auth`, { authMode: 'CODE' })).status, 400);
    assert.equal((await t('PUT', `${R(list[0])}/roster`, { csv: ROSTER })).status, 200);
    assert.equal((await t('POST', `${R(list[0])}/open`, {})).status, 409); // 프로그램이 아직 없다
    assert.equal((await t('PUT', `${G}/programs`, { roundIds: topics.map((r) => r.id), programs: PROGRAMS })).data.applied, 4);
    let d = (await t('GET', R(topics[0]))).data;
    assert.equal(d.round.fcfs, true);
    assert.ok(d.openChecks.some((c) => !c.ok && c.text.includes('프로그램 없는 시간대'))); // 진로탐색이 비어 있어 아직 열 수 없다
    assert.equal((await t('PUT', `${G}/programs`, { roundIds: careers.map((r) => r.id), programs: [{ name: '직업 체험', target: 2 }, { name: '진로 특강', target: 2 }] })).data.applied, 2);
    for (const r of list) {
      assert.equal((await t('GET', R(r))).data.students.length, 4, r.slotLabel);
      assert.equal((await t('POST', `${R(r)}/open`, {})).status, 200, r.slotLabel);
    }

    // 학생: 묶음 주소 하나, 본인 확인 한 번, 한 화면에서 모든 시간대
    const pub = (await client()('GET', `/api/public/groups/${made.key}`)).data;
    assert.equal(pub.mode, 'FCFS');
    assert.equal((await client()('GET', `/api/public/rounds/${pub.slots[0].slug}`)).data.round.groupKey, made.key); // 시간대 주소로 와도 묶음 화면으로 보낸다
    const enter = async (n) => {
      const s = client();
      assert.equal((await s('GET', `/api/student/group/${made.key}`)).status, 401);
      assert.equal((await s('POST', '/api/student/login', { slug: pub.loginSlug, grade: 1, class: 1, number: n, name: NAMES[n - 1] })).status, 200);
      return s;
    };
    const apply = (s, picks) => s('POST', `/api/student/group/${made.key}/apply`, { requestId: rid(), picks });
    const idOf = (view, label, name) => view.slots.find((x) => x.label === label).programs.find((p) => p.name === name).id;
    const slugOf = (view, label) => view.slots.find((x) => x.label === label).slug;

    const s1 = await enter(1);
    let v = (await s1('GET', `/api/student/group/${made.key}`)).data;
    assert.equal(v.slots.length, 6);
    assert.ok(v.slots.every((x) => x.status === 'open' && x.claim === null));
    assert.equal(v.slots[0].programs[0].left, 1);
    // 한 번에 여러 시간대: 1기 A 축구, 1기 B 축구(같은 영역에서 겹침 → 그것만 거절), 1기 진로탐색
    let res = (await apply(s1, [
      { slug: slugOf(v, '1기 주제선택 A'), programId: idOf(v, '1기 주제선택 A', '축구') },
      { slug: slugOf(v, '1기 주제선택 B'), programId: idOf(v, '1기 주제선택 B', '축구') },
      { slug: slugOf(v, '1기 진로탐색'), programId: idOf(v, '1기 진로탐색', '직업 체험') },
    ])).data;
    assert.deepEqual(res.outcomes.map((o) => [o.ok, o.code || null]), [[true, null], [false, 'SEAT_DUPLICATE'], [true, null]]);
    assert.equal(res.group.slots[0].claim, idOf(v, '1기 주제선택 A', '축구'));
    assert.equal(res.group.slots[0].programs.find((p) => p.name === '축구').left, 0);

    // 둘째 학생: 찬 곳은 못 잡고(선착순), 다른 곳은 잡는다
    const s2 = await enter(2);
    res = (await apply(s2, [
      { slug: slugOf(v, '1기 주제선택 A'), programId: idOf(v, '1기 주제선택 A', '축구') },
      { slug: slugOf(v, '2기 주제선택 A'), programId: idOf(v, '2기 주제선택 A', '축구') },
    ])).data;
    assert.deepEqual(res.outcomes.map((o) => [o.ok, o.code || null]), [[false, 'SEAT_FULL'], [true, null]]);
    // 마음을 바꿔 다른 프로그램으로 옮기면 먼저 잡은 자리가 풀린다
    assert.equal((await apply(s2, [{ slug: slugOf(v, '2기 주제선택 A'), programId: idOf(v, '2기 주제선택 A', '밴드') }])).data.outcomes[0].ok, true);
    v = (await s2('GET', `/api/student/group/${made.key}`)).data;
    assert.equal(v.slots.find((x) => x.label === '2기 주제선택 A').programs.find((p) => p.name === '축구').left, 1);

    // 교사 대신 입력도 같은 규칙(하나만, 정원 이내)
    d = (await t('GET', R(topics[0]))).data;
    const third = d.students.find((s) => s.number === 3);
    const soccer = d.programs.find((p) => p.name === '축구').id, pingpong = d.programs.find((p) => p.name === '탁구').id;
    assert.equal((await t('POST', `${R(topics[0])}/students/${third.id}/application`, { prefs: [pingpong, soccer], requestId: rid(), baseVersion: 0 })).status, 400);
    assert.equal((await t('POST', `${R(topics[0])}/students/${third.id}/application`, { prefs: [soccer], requestId: rid(), baseVersion: 0 })).status, 409);
    assert.equal((await t('POST', `${R(topics[0])}/students/${third.id}/application`, { prefs: [pingpong], requestId: rid(), baseVersion: 0 })).status, 200);

    // 배정은 묶음에서 한 번에: 시간대 하나만 배정할 수 없고, 모두 마감해야 한다
    assert.equal((await t('POST', `${G}/allocate`, {})).status, 409);
    for (const r of list) assert.equal((await t('POST', `${R(r)}/close`, {})).status, 200);
    assert.equal((await t('POST', `${R(topics[0])}/allocate`, { includeUnsubmitted: true })).status, 409);
    const done = (await t('POST', `${G}/allocate`, {})).data;
    assert.equal(done.forced, 0);
    assert.equal((await t('POST', `${G}/allocate`, {})).status, 200); // 다시 눌러도 결과는 하나

    // 넷째 학생은 아무것도 내지 않았지만 모든 시간대에 배정되고, 누구도 같은 영역에서 겹치지 않는다
    const table = (await t('GET', `${G}/table`)).data;
    assert.equal(table.rows.length, 4);
    for (const row of table.rows) {
      const got = topics.map((r) => row.programs[r.slotLabel]);
      assert.ok(got.every(Boolean), `${row.name}: ${got.join(', ')}`);
      assert.equal(new Set(got).size, 4, `${row.name}: ${got.join(', ')}`);
      assert.notEqual(row.programs['1기 진로탐색'], row.programs['2기 진로탐색']);
    }
    const kim = table.rows.find((x) => x.name === '김하늘');
    assert.equal(kim.programs['1기 주제선택 A'], '축구'); // 잡은 자리는 그대로
    assert.equal(kim.programs['1기 진로탐색'], '직업 체험');
    assert.equal(table.rows.find((x) => x.name === '이지호').programs['2기 주제선택 A'], '밴드');
    for (const r of list) {
      d = (await t('GET', R(r))).data;
      assert.equal(d.round.status, 'REVIEW');
      assert.equal(d.run.verification.ok, true, r.slotLabel);
      const counts = new Map();
      for (const s of d.students) counts.set(s.result.programId, (counts.get(s.result.programId) || 0) + 1);
      for (const p of d.programs) assert.ok((counts.get(p.id) || 0) <= p.target, `${r.slotLabel} ${p.name} 정원 초과`);
    }
    d = (await t('GET', R(topics[0]))).data;
    assert.equal(d.students.find((s) => s.number === 1).result.stage, '1'); // 잡은 자리
    assert.equal(d.students.find((s) => s.number === 4).result.stage, 'R'); // 남은 자리

    // 배정 취소도 묶음에서 한 번에: 잡은 자리는 남고, 무작위로 채운 자리만 지워진다
    assert.equal((await t('POST', `${R(topics[0])}/unallocate`, {})).status, 409);
    assert.equal((await t('POST', `${G}/unallocate`, {})).status, 200);
    d = (await t('GET', R(topics[0]))).data;
    assert.equal(d.round.status, 'CLOSED');
    assert.equal(d.students.find((s) => s.number === 1).app.kind, 'SUBMITTED');
    assert.equal(d.students.find((s) => s.number === 4).app, null);
    assert.equal((await t('POST', `${G}/allocate`, {})).status, 200);

    // 공개하면 학생의 한 화면에 시간대별 결과가 보인다
    for (const r of list) {
      d = (await t('GET', R(r))).data;
      assert.equal((await t('POST', `${R(r)}/publish`, { runId: d.run.id })).status, 200);
    }
    const s4 = await enter(4);
    v = (await s4('GET', `/api/student/group/${made.key}`)).data;
    assert.ok(v.slots.every((x) => x.status === 'published' && x.result && x.result.programName && x.result.picked === false));
    v = (await s1('GET', `/api/student/group/${made.key}`)).data;
    assert.equal(v.slots[0].result.programName, '축구');
    assert.equal(v.slots[0].result.picked, true);
  } finally {
    stop();
  }
});
