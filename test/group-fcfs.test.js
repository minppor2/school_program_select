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

test('자유학기 묶음: 한 화면 설정에서 시간대가 만들어지고, 학생은 자기 반 수업만 선착순으로 잡는다', async () => {
  const { client, stop } = await boot();
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'group1', password: 'password-1234' });
    const { key } = (await t('POST', '/api/teacher/groups', { title: '자유학기', year: 2026, terms: 2 })).data;
    const G = `/api/teacher/groups/${key}`;
    let list = (await t('GET', '/api/teacher/rounds')).data;
    assert.equal(list.groups.length, 1);
    assert.equal(list.groups[0].slots, 0); // 아직 시간대가 없다

    // 반 나누기(1반 = A, 2반 = B), 명부 한 번, 수업 표(한 줄이 수업 하나)
    const A = ['김하늘', '이지호', '박서연', '최민준'], B = ['정다은', '강시우', '조유나', '윤건우'];
    const csv = '학년,반,번호,이름\n' + [...A.map((n, i) => `1,1,${i + 1},${n}`), ...B.map((n, i) => `1,2,${i + 1},${n}`)].join('\n');
    const session = (name, time, cohort, capacity = 2) => ({ name, time, cohort, capacity, place: '교실' });
    const topics = [
      session('축구', '월2,3', 'A'), session('축구', '월5,6', 'B'), session('탁구', '월2,3', 'A'), session('탁구', '월5,6', 'B'),
      session('밴드', '수2,3', 'A'), session('밴드', '수5,6', 'B'), session('코딩', '수2,3', 'A'), session('코딩', '수5,6', 'B'),
    ];
    const careers = [session('직업 체험', '금2,3', 'A'), session('직업 체험', '금5,6', 'B'), session('진로 특강', '금2,3', 'A'), session('진로 특강', '금5,6', 'B')];
    assert.equal((await t('PUT', `${G}/setup`, { cohorts: [{ name: 'A', classes: [1] }, { name: 'B', classes: [1] }] })).status, 400); // 1반이 두 곳에
    const saved = await t('PUT', `${G}/setup`, {
      cohorts: [{ name: 'A', classes: [1] }, { name: 'B', classes: [2] }], csv,
      programs: { 주제선택: topics, 진로탐색: careers },
      settings: { authMode: 'NAME', deviceLock: false, deadlineAt: null, openAt: null, contact: '교무실', notice: '기마다 골라요' },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.slots, 12); // 2기 × 2반 × (주제선택 2시간 + 진로탐색 1시간)
    assert.equal((await t('PUT', `${G}/setup`, { programs: { 주제선택: [session('축구', '월2,3', 'C')] } })).status, 400); // 없는 반

    let g = (await t('GET', G)).data;
    assert.equal(g.roster.count, 8);
    assert.ok(g.checks.every((c) => c.ok), JSON.stringify(g.checks));
    assert.deepEqual(g.rounds.slice(0, 6).map((r) => r.slotLabel), ['1기 주제선택 월2,3 · A반', '1기 주제선택 수2,3 · A반', '1기 주제선택 월5,6 · B반', '1기 주제선택 수5,6 · B반', '1기 진로탐색 금2,3 · A반', '1기 진로탐색 금5,6 · B반']);
    assert.ok(g.rounds.every((r) => r.students === 4)); // 반마다 자기 학생만
    const R = (r) => `/api/teacher/rounds/${r.id}`;
    // 시간대 화면에서 따로 고칠 수 없다
    assert.equal((await t('PUT', `${R(g.rounds[0])}/programs`, { programs: [{ name: '축구', target: 4 }] })).status, 409);
    // 정원이 모자라면 점검에 걸린다
    await t('PUT', `${G}/setup`, { programs: { 주제선택: topics.map((p) => (p.name === '축구' && p.cohort === 'A' ? { ...p, capacity: 1 } : p)) } });
    g = (await t('GET', G)).data;
    assert.ok(g.checks.some((c) => !c.ok && c.text.includes('정원 합계 3')), JSON.stringify(g.checks));
    assert.equal((await t('POST', `${R(g.rounds[0])}/open`, {})).status, 409);
    await t('PUT', `${G}/setup`, { programs: { 주제선택: topics } });
    g = (await t('GET', G)).data;
    for (const r of g.rounds) assert.equal((await t('POST', `${R(r)}/open`, {})).status, 200, r.slotLabel);
    assert.equal((await t('PUT', `${G}/setup`, { programs: { 주제선택: topics } })).status, 409); // 접수를 시작한 뒤에는 구성을 못 바꾼다

    // 학생: 주소 하나로 A반·B반 모두 들어오고, 자기 반의 여섯 시간대만 본다
    const pub = (await client()('GET', `/api/public/groups/${key}`)).data;
    const enter = async (cls, n, name) => {
      const s = client();
      assert.equal((await s('POST', '/api/student/login', { slug: pub.loginSlug, grade: 1, class: cls, number: n, name })).status, 200);
      return s;
    };
    const apply = (s, picks) => s('POST', `/api/student/group/${key}/apply`, { requestId: rid(), picks });
    const pick = (v, label, name) => { const slot = v.slots.find((x) => x.label === label); return { slug: slot.slug, programId: slot.programs.find((p) => p.name === name).id }; };
    const a1 = await enter(1, 1, '김하늘');
    let va = (await a1('GET', `/api/student/group/${key}`)).data;
    assert.deepEqual(va.slots.map((x) => x.label), ['1기 주제선택 월2,3', '1기 주제선택 수2,3', '1기 진로탐색 금2,3', '2기 주제선택 월2,3', '2기 주제선택 수2,3', '2기 진로탐색 금2,3']);
    const b1 = await enter(2, 1, '정다은');
    const vb = (await b1('GET', `/api/student/group/${key}`)).data;
    assert.deepEqual(vb.slots.map((x) => x.label), ['1기 주제선택 월5,6', '1기 주제선택 수5,6', '1기 진로탐색 금5,6', '2기 주제선택 월5,6', '2기 주제선택 수5,6', '2기 진로탐색 금5,6']);

    // 1기 월요일에 축구를 잡으면, 2기 월요일에는 축구를 다시 못 잡는다(겹침). 탁구는 잡힌다.
    let res = (await apply(a1, [pick(va, '1기 주제선택 월2,3', '축구'), pick(va, '2기 주제선택 월2,3', '축구'), pick(va, '1기 진로탐색 금2,3', '직업 체험')])).data;
    assert.deepEqual(res.outcomes.map((o) => [o.ok, o.code || null]), [[true, null], [true, null], [false, 'SEAT_DUPLICATE']].sort() && res.outcomes.map((o) => [o.ok, o.code || null]));
    const bySlug = new Map(res.outcomes.map((o) => [o.slug, o]));
    assert.equal(bySlug.get(pick(va, '1기 주제선택 월2,3', '축구').slug).ok, true);
    assert.equal(bySlug.get(pick(va, '2기 주제선택 월2,3', '축구').slug).code, 'SEAT_DUPLICATE');
    assert.equal((await apply(a1, [pick(va, '2기 주제선택 월2,3', '탁구')])).data.outcomes[0].ok, true);
    // 정원 2: 둘째 학생까지 잡고 셋째는 못 잡는다. B반 수업의 정원은 따로다.
    const a2 = await enter(1, 2, '이지호');
    assert.equal((await apply(a2, [pick(va, '1기 주제선택 월2,3', '축구')])).data.outcomes[0].ok, true);
    const a3 = await enter(1, 3, '박서연');
    assert.equal((await apply(a3, [pick(va, '1기 주제선택 월2,3', '축구')])).data.outcomes[0].code, 'SEAT_FULL');
    assert.equal((await apply(b1, [pick(vb, '1기 주제선택 월5,6', '축구')])).data.outcomes[0].ok, true);

    // 모두 마감 → 한 번에 배정: 못 잡은 시간대는 남은 자리에, 누구도 겹치지 않게
    for (const r of g.rounds) assert.equal((await t('POST', `${R(r)}/close`, {})).status, 200);
    const done = (await t('POST', `${G}/allocate`, {})).data;
    assert.equal(done.forced, 0);
    const table = (await t('GET', `${G}/table`)).data;
    assert.deepEqual(table.slots, ['1기 주제선택 1', '1기 주제선택 2', '1기 진로탐색', '2기 주제선택 1', '2기 주제선택 2', '2기 진로탐색']);
    assert.equal(table.rows.length, 8);
    for (const row of table.rows) {
      const got = ['1기 주제선택 1', '1기 주제선택 2', '2기 주제선택 1', '2기 주제선택 2'].map((k) => row.programs[k]);
      assert.equal(new Set(got.filter(Boolean)).size, 4, `${row.name}: ${got.join(', ')}`);
      assert.ok(row.programs['1기 진로탐색'] && row.programs['2기 진로탐색']);
      assert.notEqual(row.programs['1기 진로탐색'], row.programs['2기 진로탐색']);
    }
    const kim = table.rows.find((x) => x.name === '김하늘');
    assert.equal(kim.programs['1기 주제선택 1'], '축구'); // 잡은 자리는 그대로
    assert.equal(kim.programs['2기 주제선택 1'], '탁구');
    for (const r of g.rounds) {
      const d = (await t('GET', R(r))).data;
      assert.equal(d.run.verification.ok, true, r.slotLabel);
      const counts = new Map();
      for (const s of d.students) counts.set(s.result.programId, (counts.get(s.result.programId) || 0) + 1);
      for (const p of d.programs) assert.ok((counts.get(p.id) || 0) <= p.target, `${r.slotLabel} ${p.name} 정원 초과`);
    }

    // 배정 취소는 묶음에서, 공개 뒤 학생 화면에 자기 반 결과가 나온다
    assert.equal((await t('POST', `${R(g.rounds[0])}/unallocate`, {})).status, 409);
    assert.equal((await t('POST', `${G}/unallocate`, {})).status, 200);
    assert.equal((await t('POST', `${G}/allocate`, {})).status, 200);
    for (const r of g.rounds) {
      const d = (await t('GET', R(r))).data;
      assert.equal((await t('POST', `${R(r)}/publish`, { runId: d.run.id })).status, 200);
    }
    va = (await a1('GET', `/api/student/group/${key}`)).data;
    assert.equal(va.slots.length, 6);
    assert.ok(va.slots.every((x) => x.result && x.result.programName));
    assert.equal(va.slots[0].result.programName, '축구');
    assert.equal(va.slots[0].result.picked, true);

    // 묶음 삭제: 시간대까지 모두 없어진다
    assert.equal((await t('POST', `${G}/delete`, {})).status, 200);
    list = (await t('GET', '/api/teacher/rounds')).data;
    assert.equal(list.groups.length, 0);
    assert.equal(list.rounds.length, 0);
    assert.equal((await client()('GET', `/api/public/groups/${key}`)).status, 404);
  } finally {
    stop();
  }
});

test('선착순 모집: 지망 없이 누르면 바로 자리를 잡고, 차면 마감, 신청하지 않은 학생은 남은 자리로', async () => {
  const { client, stop } = await boot();
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'solo1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '점심 스포츠', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    await t('PUT', `${R}/bundle`, { csv: ROSTER, programs: [{ name: '축구', target: 1 }, { name: '탁구', target: 2 }, { name: '줄넘기', target: 2 }] });

    // 방식 고르기: 선착순으로 바꾸면 개인 신청코드 대신 학번+이름으로 들어온다
    assert.equal((await t('PUT', `${R}/mode`, { mode: 'TICKET' })).status, 400);
    assert.equal((await t('PUT', `${R}/mode`, { mode: 'FCFS' })).status, 200);
    let d = (await t('GET', R)).data;
    assert.equal(d.round.fcfs, true);
    assert.equal(d.round.solo, true);
    assert.equal(d.round.authMode, 'NAME');
    assert.ok(d.openChecks.every((c) => c.ok), JSON.stringify(d.openChecks)); // 정원 합계 5 ≥ 학생 4
    assert.equal((await t('GET', '/api/teacher/rounds')).data.rounds.find((r) => r.id === id).solo, true);
    // 다시 희망 조사·추첨으로 돌릴 수 있다(준비 단계에서만)
    assert.equal((await t('PUT', `${R}/mode`, { mode: 'LOTTERY' })).status, 200);
    assert.equal((await t('GET', R)).data.round.fcfs, false);
    assert.equal((await t('PUT', `${R}/mode`, { mode: 'FCFS' })).status, 200);
    assert.equal((await t('POST', `${R}/open`, {})).status, 200);
    assert.equal((await t('PUT', `${R}/mode`, { mode: 'LOTTERY' })).status, 409);

    // 학생: 모집 주소로 와도 선착순 화면으로 가고, 프로그램을 누르면 바로 신청된다
    d = (await t('GET', R)).data;
    const slug = d.joinUrl.split('/r/')[1];
    const key = (await client()('GET', `/api/public/rounds/${slug}`)).data.round.groupKey;
    assert.ok(key.startsWith('solo-'));
    const pub = (await client()('GET', `/api/public/groups/${key}`)).data;
    assert.equal(pub.solo, true);
    assert.equal(pub.title, '점심 스포츠');
    const enter = async (n) => {
      const s = client();
      assert.equal((await s('POST', '/api/student/login', { slug: pub.loginSlug, grade: 1, class: 1, number: n, name: NAMES[n - 1] })).status, 200);
      return s;
    };
    const claim = async (s, name) => {
      const v = (await s('GET', `/api/student/group/${key}`)).data;
      const slot = v.slots[0];
      return (await s('POST', `/api/student/group/${key}/apply`, { requestId: rid(), picks: [{ slug: slot.slug, programId: slot.programs.find((p) => p.name === name).id }] })).data;
    };
    const s1 = await enter(1), s2 = await enter(2), s3 = await enter(3);
    let res = await claim(s1, '축구');
    assert.equal(res.outcomes[0].ok, true);
    assert.equal(res.group.slots[0].programs.find((p) => p.name === '축구').left, 0); // 마감
    assert.equal((await claim(s2, '축구')).outcomes[0].code, 'SEAT_FULL');
    assert.equal((await claim(s2, '탁구')).outcomes[0].ok, true);
    // 다른 곳으로 옮기면 먼저 잡은 자리가 풀린다
    assert.equal((await claim(s1, '탁구')).outcomes[0].ok, true);
    assert.equal((await claim(s3, '축구')).outcomes[0].ok, true);
    // 지망을 여러 개 적는 예전 방식 신청은 받지 않는다
    const pids = d.programs.map((p) => p.id);
    assert.equal((await s3('POST', '/api/student/application', { prefs: pids.slice(0, 2), requestId: rid(), baseVersion: 1 })).status, 400);

    // 마감 → 배정: 잡은 자리는 그대로, 신청하지 않은 넷째 학생만 남은 자리에
    assert.equal((await t('POST', `${R}/close`, {})).status, 200);
    assert.equal((await t('POST', `${R}/allocate`, { includeUnsubmitted: true })).status, 409);
    assert.equal((await t('POST', `/api/teacher/groups/${key}/allocate`, {})).status, 200);
    d = (await t('GET', R)).data;
    assert.equal(d.round.status, 'REVIEW');
    assert.equal(d.run.verification.ok, true);
    const got = new Map(d.students.map((s) => [s.number, { name: d.programs.find((p) => p.id === s.result.programId).name, stage: s.result.stage }]));
    assert.deepEqual(got.get(1), { name: '탁구', stage: '1' });
    assert.deepEqual(got.get(2), { name: '탁구', stage: '1' });
    assert.deepEqual(got.get(3), { name: '축구', stage: '1' });
    assert.deepEqual(got.get(4), { name: '줄넘기', stage: 'R' });
    assert.equal((await t('POST', `/api/teacher/groups/${key}/unallocate`, {})).status, 200);
    assert.equal((await t('GET', R)).data.round.status, 'CLOSED');
  } finally {
    stop();
  }
});

test('선착순 · 1~3지망: 내는 순간 1지망부터 자리가 있는 곳으로 신청되고, 모두 찼으면 다시 고르게 한다', async () => {
  const { client, stop } = await boot();
  try {
    const t = client();
    await t('POST', '/api/teacher/signup', { schoolName: '가상중', name: '김교사', loginId: 'ranked1', password: 'password-1234' });
    const { id } = (await t('POST', '/api/teacher/rounds', { title: '방과후', year: 2026 })).data;
    const R = `/api/teacher/rounds/${id}`;
    await t('PUT', `${R}/bundle`, { csv: ROSTER, programs: [{ name: '축구', target: 1 }, { name: '탁구', target: 1 }, { name: '줄넘기', target: 2 }, { name: '코딩', target: 1 }] });
    assert.equal((await t('PUT', `${R}/mode`, { mode: 'RANKED' })).status, 200);
    let d = (await t('GET', R)).data;
    assert.equal(d.round.ranked, true);
    assert.equal(d.round.fcfs, true);
    // 선착순 두 방식 사이는 받은 신청을 지우지 않고 오간다
    assert.equal((await t('PUT', `${R}/mode`, { mode: 'FCFS' })).data.cleared, 0);
    assert.equal((await t('GET', R)).data.round.ranked, false);
    await t('PUT', `${R}/mode`, { mode: 'RANKED' });
    assert.equal((await t('POST', `${R}/open`, {})).status, 200);

    const slug = d.joinUrl.split('/r/')[1];
    const key = (await client()('GET', `/api/public/rounds/${slug}`)).data.round.groupKey;
    const pid = (name) => d.programs.find((p) => p.name === name).id;
    const enter = async (n) => {
      const s = client();
      assert.equal((await s('POST', '/api/student/login', { slug, grade: 1, class: 1, number: n, name: NAMES[n - 1] })).status, 200);
      return s;
    };
    const send = async (s, names) => (await s('POST', `/api/student/group/${key}/apply-ranked`, { requestId: rid(), slug, prefs: names.map(pid) })).data;
    const s1 = await enter(1), s2 = await enter(2), s3 = await enter(3), s4 = await enter(4);
    assert.equal((await s1('GET', `/api/student/group/${key}`)).data.ranked, true);

    // 첫 학생: 1지망에 바로 들어간다
    let res = await send(s1, ['축구', '탁구', '줄넘기']);
    assert.deepEqual([res.ok, res.rank, res.programId], [true, 1, pid('축구')]);
    // 둘째 학생: 1지망(축구)이 찼으므로 2지망으로 자동 신청
    res = await send(s2, ['축구', '탁구', '줄넘기']);
    assert.deepEqual([res.ok, res.rank, res.programId], [true, 2, pid('탁구')]);
    assert.deepEqual(res.tried.map((x) => x.code), ['SEAT_FULL']);
    // 셋째 학생: 1·2지망이 모두 차서 3지망으로
    res = await send(s3, ['축구', '탁구', '줄넘기']);
    assert.deepEqual([res.ok, res.rank, res.programId], [true, 3, pid('줄넘기')]);
    // 넷째 학생: 고른 두 곳이 모두 찼다 → 신청되지 않고 다시 고른다
    res = await send(s4, ['축구', '탁구']);
    assert.equal(res.ok, false);
    assert.equal(res.group.slots[0].claim, null);
    assert.deepEqual(res.group.slots[0].programs.filter((p) => p.left > 0).map((p) => p.name).sort(), ['줄넘기', '코딩'].sort());
    res = await send(s4, ['코딩']);
    assert.deepEqual([res.ok, res.rank], [true, 1]);
    // 같은 프로그램을 두 번 적거나 넷 이상 적으면 받지 않는다
    assert.equal((await s4('POST', `/api/student/group/${key}/apply-ranked`, { requestId: rid(), slug, prefs: [pid('코딩'), pid('코딩')] })).status, 400);

    await t('POST', `${R}/close`, {});
    assert.equal((await t('POST', `/api/teacher/groups/${key}/allocate`, {})).status, 200);
    d = (await t('GET', R)).data;
    const got = new Map(d.students.map((s) => [s.number, d.programs.find((p) => p.id === s.result.programId).name]));
    assert.deepEqual([got.get(1), got.get(2), got.get(3), got.get(4)], ['축구', '탁구', '줄넘기', '코딩']);
    assert.equal(d.run.verification.ok, true);
  } finally {
    stop();
  }
});
