'use strict';
/* 저장 계층·권한·상태 전환을 실제 HTTP 로 검증한다(메모리 DB, 가상 데이터). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

const apps = [];
test.after(() => { for (const a of apps) a.server.closeAllConnections(), a.server.close(); });

async function boot(opts = {}) {
  const clock = { t: new Date('2026-11-12T00:00:00.000Z') };
  const app = createApp({ dbPath: ':memory:', now: () => new Date(clock.t), ...opts });
  apps.push(app);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const client = () => {
    let cookie = '';
    const call = async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const set = res.headers.getSetCookie();
      if (set.length) cookie = set.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : await res.text();
      return { status: res.status, data, headers: res.headers };
    };
    return { call, get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
  };
  return { app, base, clock, client };
}

let seq = 0;
async function setupRound(ctx, { n = 6, programs = [['축구', 2], ['농구', 2], ['배드민턴', 2]], settings = {}, restrictions = () => [] } = {}) {
  const t = ctx.client();
  seq++;
  let r = await t.post('/api/teacher/signup', { schoolName: `가상중${seq}`, name: '김교사', loginId: `teacher${seq}`, password: 'password-1234' });
  assert.equal(r.status, 200);
  const id = (await t.post('/api/teacher/rounds', { title: '1학기 스포츠클럽', year: 2026 })).data.id;
  const csv = '학년,반,번호,이름\n' + Array.from({ length: n }, (_, i) => `1,${1 + (i % 2)},${1 + Math.floor(i / 2)},학생${i + 1}`).join('\n');
  r = await t.put(`/api/teacher/rounds/${id}/roster`, { csv });
  assert.equal(r.data.count, n);
  r = await t.put(`/api/teacher/rounds/${id}/programs`, { programs: programs.map(([name, target, maxCapacity]) => ({ name, target, maxCapacity })) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await t.put(`/api/teacher/rounds/${id}/settings`, { title: '1학기 스포츠클럽', year: 2026, contact: '체육부', deadlineAt: null, allowNoPref: false, ...settings });
  let d = (await t.get(`/api/teacher/rounds/${id}`)).data;
  const pairs = restrictions(d);
  if (pairs.length) assert.equal((await t.put(`/api/teacher/rounds/${id}/restrictions`, { pairs })).status, 200);
  const codes = (await t.post(`/api/teacher/rounds/${id}/codes`, { mode: 'missing' })).data.codes;
  assert.equal(codes.length, n);
  d = (await t.get(`/api/teacher/rounds/${id}`)).data;
  const slug = d.joinUrl.split('/r/')[1];
  const login = async (i) => {
    const c = ctx.client();
    const s = codes[i];
    const res = await c.post('/api/student/login', { slug, grade: s.grade, class: s.class, number: s.number, code: s.code });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return c;
  };
  return { t, id, codes, slug, login, d, pid: (name) => d.programs.find((p) => p.name === name).id };
}
const rid = () => 'req-' + Math.random().toString(36).slice(2).padEnd(10, '0');

test('전체 흐름: 개설 → 신청 → 마감 → 배정 → 공개 → 본인 결과·명단', async () => {
  const ctx = await boot();
  const R = await setupRound(ctx);
  // 접수 전에는 신청 불가
  const early = await R.login(0);
  assert.equal((await early.post('/api/student/application', { prefs: [R.pid('축구')], requestId: rid(), baseVersion: 0 })).status, 403);
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/open`)).status, 200);
  // 접수 시작 뒤에는 설정 변경 불가
  assert.equal((await R.t.put(`/api/teacher/rounds/${R.id}/programs`, { programs: [] })).status, 409);

  const students = [];
  for (let i = 0; i < 6; i++) {
    const s = await R.login(i);
    students.push(s);
    const r = await s.post('/api/student/application', { prefs: [R.pid('축구'), R.pid('농구'), null], requestId: rid(), baseVersion: 0 });
    assert.equal(r.status, 200);
    assert.match(r.data.receipt, /^\d{6}-\d{6}$/);
  }
  // 재접속해도 접수 내용이 있다
  const again = await R.login(0);
  const me = (await again.get('/api/student/me')).data;
  assert.deepEqual(me.application.prefs, [R.pid('축구'), R.pid('농구')]);
  assert.equal(me.result, null);

  // 마감 전에는 배정 불가
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/allocate`)).status, 409);
  await R.t.post(`/api/teacher/rounds/${R.id}/close`);
  assert.equal((await students[0].post('/api/student/application', { prefs: [R.pid('농구')], requestId: rid(), baseVersion: 1 })).status, 403);

  // 같은 버튼을 동시에/다시 눌러도 실행은 하나, 결과는 같다
  const [a, b] = await Promise.all([R.t.post(`/api/teacher/rounds/${R.id}/allocate`), R.t.post(`/api/teacher/rounds/${R.id}/allocate`)]);
  assert.equal(a.status, 200);
  assert.equal(a.data.runId, b.data.runId);
  const before = (await R.t.get(`/api/teacher/rounds/${R.id}`)).data;
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/allocate`)).data.runId, a.data.runId);
  const after = (await R.t.get(`/api/teacher/rounds/${R.id}`)).data;
  assert.deepEqual(after.students.map((s) => s.result), before.students.map((s) => s.result));
  assert.equal(ctx.app.db.get('SELECT COUNT(*) AS n FROM runs').n, 1);
  assert.ok(after.run.verification.ok);
  const counts = {};
  for (const s of after.students) counts[s.result.programId] = (counts[s.result.programId] || 0) + 1;
  assert.deepEqual(Object.values(counts), [2, 2, 2]); // 희망 0명인 배드민턴도 2명

  // 공개 전에는 학생에게 결과가 보이지 않는다
  assert.equal((await students[0].get('/api/student/me')).data.result, null);
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/publish`, { runId: 9999 })).status, 409);
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/publish`, { runId: a.data.runId })).status, 200);
  for (let i = 0; i < 6; i++) {
    const m = (await students[i].get('/api/student/me')).data;
    const mine = after.students.find((s) => s.name === m.student.name);
    assert.equal(m.result.programName, after.programs.find((p) => p.id === mine.result.programId).name);
    assert.ok(m.result.reasons.length >= 1);
    assert.equal(JSON.stringify(m).includes('seed'), false);
  }
  // 명단 내보내기
  const csv = await R.t.get(`/api/teacher/rounds/${R.id}/export?by=program`);
  assert.equal(csv.status, 200);
  assert.equal(csv.data.trim().split('\r\n').length, 7);
  assert.ok(ctx.app.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'EXPORTED'").n === 1);
  // 공개 뒤에는 재개·재배정으로 결과가 바뀌지 않는다
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/reopen`, { reason: 'x' })).status, 409);
  await ctx.app.close();
});

test('재클릭·응답 유실·요청 식별자 충돌·버전 충돌', async () => {
  const ctx = await boot();
  const R = await setupRound(ctx);
  await R.t.post(`/api/teacher/rounds/${R.id}/open`);
  const s = await R.login(0);
  const req = { prefs: [R.pid('축구')], requestId: rid(), baseVersion: 0 };
  // 같은 요청 5번 동시 전송(중복 클릭·재시도)
  const rs = await Promise.all(Array.from({ length: 5 }, () => s.post('/api/student/application', req)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(rs.map((r) => r.data.receipt)).size, 1);
  assert.equal(ctx.app.db.get('SELECT COUNT(*) AS n FROM applications').n, 1);
  assert.equal(ctx.app.db.get('SELECT COUNT(*) AS n FROM application_versions').n, 1);
  // 같은 식별자에 다른 내용 → 충돌
  assert.equal((await s.post('/api/student/application', { ...req, prefs: [R.pid('농구')] })).data.error.code, 'REQUEST_ID_CONFLICT');
  // 다른 기기가 먼저 수정 → 오래된 버전의 수정은 덮어쓰지 못한다
  const other = await R.login(0);
  assert.equal((await other.post('/api/student/application', { prefs: [R.pid('농구')], requestId: rid(), baseVersion: 1 })).status, 200);
  const stale = await s.post('/api/student/application', { prefs: [R.pid('배드민턴')], requestId: rid(), baseVersion: 1 });
  assert.equal(stale.data.error.code, 'VERSION_CONFLICT');
  assert.deepEqual(stale.data.error.current.prefs, [R.pid('농구')]);
  assert.deepEqual((await s.get('/api/student/me')).data.application.prefs, [R.pid('농구')]);
  // 마감 뒤에도, 이미 성공한 같은 요청의 재시도는 원래 접수 결과를 돌려준다(새 접수 아님)
  await R.t.post(`/api/teacher/rounds/${R.id}/close`);
  const replay = await s.post('/api/student/application', req);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.receipt, rs[0].data.receipt);
  assert.equal(ctx.app.db.get('SELECT version FROM applications').version, 2);
  await ctx.app.close();
});

test('입력 검증: 지망 중간 누락·중복·다른 모집 프로그램·4개 이상', async () => {
  const ctx = await boot();
  const R = await setupRound(ctx);
  const other = await setupRound(ctx);
  await R.t.post(`/api/teacher/rounds/${R.id}/open`);
  const s = await R.login(0);
  const send = (prefs) => s.post('/api/student/application', { prefs, requestId: rid(), baseVersion: 0 });
  assert.equal((await send([R.pid('축구'), null, R.pid('농구')])).data.error.code, 'PREF_GAP');
  assert.equal((await send([null, R.pid('농구')])).data.error.code, 'PREF_GAP');
  assert.equal((await send([R.pid('축구'), R.pid('축구')])).data.error.code, 'DUPLICATE_PREF');
  assert.equal((await send([other.pid('축구')])).data.error.code, 'BAD_PREFS');
  assert.equal((await send([])).data.error.code, 'BAD_PREFS');
  assert.equal((await send([1, 2, 3, 4])).data.error.code, 'BAD_PREFS');
  assert.equal((await send('x')).data.error.code, 'BAD_PREFS');
  assert.equal(ctx.app.db.get('SELECT COUNT(*) AS n FROM applications').n, 0);
  await ctx.app.close();
});

test('마감 경계: 직전은 접수, 정확히 같은 시각·직후는 거부(서버 시각 기준)', async () => {
  const ctx = await boot();
  const deadline = '2026-11-12T03:00:00.000Z';
  const R = await setupRound(ctx, { settings: { deadlineAt: deadline } });
  await R.t.post(`/api/teacher/rounds/${R.id}/open`);
  ctx.clock.t = new Date('2026-11-12T02:59:59.999Z');
  const s = await R.login(0);
  const ok = await s.post('/api/student/application', { prefs: [R.pid('축구')], requestId: rid(), baseVersion: 0 });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.acceptedAt < deadline);
  ctx.clock.t = new Date(deadline);
  assert.equal((await s.post('/api/student/application', { prefs: [R.pid('농구')], requestId: rid(), baseVersion: 1 })).data.error.code, 'CLOSED');
  ctx.clock.t = new Date('2026-11-12T03:00:00.001Z');
  assert.equal((await s.post('/api/student/application', { prefs: [R.pid('농구')], requestId: rid(), baseVersion: 1 })).data.error.code, 'CLOSED');
  // 거부된 수정이 이전 유효 제출을 지우지 않는다
  assert.deepEqual((await s.get('/api/student/me')).data.application.prefs, [R.pid('축구')]);
  assert.equal((await s.get('/api/student/me')).data.round.status, 'closed');
  await ctx.app.close();
});

test('미제출이 있으면 배정 차단 → 대리 입력(기록)·희망 없음 정책 → 배정', async () => {
  const ctx = await boot();
  const R = await setupRound(ctx, { settings: { allowNoPref: true } });
  const strict = await setupRound(ctx);
  await R.t.post(`/api/teacher/rounds/${R.id}/open`);
  for (let i = 0; i < 4; i++) await (await R.login(i)).post('/api/student/application', { prefs: [R.pid('축구')], requestId: rid(), baseVersion: 0 });
  await R.t.post(`/api/teacher/rounds/${R.id}/close`);
  const blocked = await R.t.post(`/api/teacher/rounds/${R.id}/allocate`);
  assert.equal(blocked.data.error.code, 'UNRESOLVED');
  assert.equal(blocked.data.error.unresolved.length, 2);
  const d = (await R.t.get(`/api/teacher/rounds/${R.id}`)).data;
  const miss = d.students.filter((s) => !s.app);
  // 확인 방법 없이는 대리 입력 불가
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/students/${miss[0].id}/application`, { prefs: [R.pid('농구')], note: '', requestId: rid(), baseVersion: 0 })).status, 400);
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/students/${miss[0].id}/application`, { prefs: [R.pid('농구')], note: '교실에서 직접 확인', requestId: rid(), baseVersion: 0 })).status, 200);
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/students/${miss[1].id}/no-preference`, { note: '담임이 본인에게 확인', requestId: rid(), baseVersion: 0 })).status, 200);
  assert.equal(ctx.app.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('PROXY_ENTRY','NO_PREFERENCE_CONFIRMED')").n, 2);
  const run = await R.t.post(`/api/teacher/rounds/${R.id}/allocate`);
  assert.equal(run.status, 200);
  const after = (await R.t.get(`/api/teacher/rounds/${R.id}`)).data;
  assert.equal(after.students.find((s) => s.id === miss[1].id).result.stage, 'R');
  assert.equal(after.students.find((s) => s.id === miss[0].id).app.enteredBy, '김교사');
  // 정책을 켜지 않은 모집에서는 희망 없음 처리 불가(숨은 우회 없음)
  await strict.t.post(`/api/teacher/rounds/${strict.id}/open`);
  const sd = (await strict.t.get(`/api/teacher/rounds/${strict.id}`)).data;
  assert.equal((await strict.t.post(`/api/teacher/rounds/${strict.id}/students/${sd.students[0].id}/no-preference`, { note: 'x', requestId: rid(), baseVersion: 0 })).data.error.code, 'NO_PREF_POLICY');
  await ctx.app.close();
});

test('권한: 다른 학교·다른 학생·로그인 전 접근 차단', async () => {
  const ctx = await boot();
  const A = await setupRound(ctx);
  const B = await setupRound(ctx);
  await A.t.post(`/api/teacher/rounds/${A.id}/open`);
  // 다른 학교 교사는 조회·수정·배정·내보내기 모두 404
  for (const [m, p, b] of [
    ['GET', `/api/teacher/rounds/${A.id}`], ['GET', `/api/teacher/rounds/${A.id}/export?by=class`], ['GET', `/api/teacher/rounds/${A.id}/qr.svg`],
    ['POST', `/api/teacher/rounds/${A.id}/close`, {}], ['POST', `/api/teacher/rounds/${A.id}/allocate`, {}], ['POST', `/api/teacher/rounds/${A.id}/codes`, { mode: 'all' }],
    ['PUT', `/api/teacher/rounds/${A.id}/roster`, { csv: '1,1,1,침입' }],
    ['POST', `/api/teacher/rounds/${A.id}/students/${A.d.students[0].id}/code`, {}],
  ]) {
    assert.equal((await B.t.call(m, p, b)).status, 404, `${m} ${p}`);
  }
  // B 학교 모집 경로에 A 학교 학생 ID 를 넣어도 불가
  assert.equal((await B.t.post(`/api/teacher/rounds/${B.id}/students/${A.d.students[0].id}/code`, {})).status, 404);
  // 로그인 전
  const anon = ctx.client();
  assert.equal((await anon.get('/api/teacher/rounds')).status, 401);
  assert.equal((await anon.get('/api/student/me')).status, 401);
  assert.equal((await anon.post('/api/student/application', { prefs: [1], requestId: rid(), baseVersion: 0 })).status, 401);
  // 공개 정보에는 명단·결과가 없다
  const pub = (await anon.get(`/api/public/rounds/${A.slug}`)).data;
  assert.deepEqual(Object.keys(pub), ['round']);
  assert.deepEqual(Object.keys(pub.round).sort(), ['contact', 'deadlineAt', 'schoolName', 'slug', 'status', 'title', 'year']);
  // 학생은 요청 값으로 다른 학생이 될 수 없다(학생 ID 는 세션에서만 결정)
  const s0 = await A.login(0);
  await s0.post('/api/student/application', { prefs: [A.pid('축구')], requestId: rid(), baseVersion: 0, studentId: A.d.students[1].id, student_id: A.d.students[1].id });
  assert.equal(ctx.app.db.get('SELECT student_id FROM applications').student_id, A.d.students[0].id);
  assert.equal((await s0.get(`/api/student/me?studentId=${A.d.students[1].id}`)).data.student.name, '학생1');
  // A 학교 코드로 B 학교 모집에 로그인 불가
  const c = A.codes[0];
  assert.equal((await anon.post('/api/student/login', { slug: B.slug, grade: c.grade, class: c.class, number: c.number, code: c.code })).status, 401);
  // 다른 사이트에서 온 요청 거부
  const cross = await fetch(ctx.base + '/api/student/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(cross.status, 403);
  await ctx.app.close();
});

test('학생코드: 추측 제한·재발급 시 이전 코드와 세션 폐기·신청 기록 보존·로그아웃', async () => {
  const ctx = await boot();
  const R = await setupRound(ctx);
  await R.t.post(`/api/teacher/rounds/${R.id}/open`);
  const s = await R.login(0);
  await s.post('/api/student/application', { prefs: [R.pid('축구')], requestId: rid(), baseVersion: 0 });
  // 서버에는 코드 원문이 없다
  const row = ctx.app.db.get('SELECT code_hash FROM students LIMIT 1');
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  const c = R.codes[0];
  const re = await R.t.post(`/api/teacher/rounds/${R.id}/students/${R.d.students[0].id}/code`, {});
  assert.equal(re.data.codes.length, 1);
  assert.equal((await s.get('/api/student/me')).status, 401); // 이전 세션 폐기
  const anon = ctx.client();
  assert.equal((await anon.post('/api/student/login', { slug: R.slug, grade: c.grade, class: c.class, number: c.number, code: c.code })).status, 401); // 이전 코드 폐기
  const fresh = ctx.client();
  assert.equal((await fresh.post('/api/student/login', { slug: R.slug, grade: c.grade, class: c.class, number: c.number, code: re.data.codes[0].code.toLowerCase() })).status, 200);
  assert.deepEqual((await fresh.get('/api/student/me')).data.application.prefs, [R.pid('축구')]); // 신청 기록 보존
  await fresh.post('/api/student/logout');
  assert.equal((await fresh.get('/api/student/me')).status, 401);
  // 5번 틀리면 그 학생만 잠긴다(같은 IP 의 다른 학생은 계속 로그인 가능)
  const c2 = R.codes[1];
  for (let i = 0; i < 5; i++) assert.equal((await anon.post('/api/student/login', { slug: R.slug, grade: c2.grade, class: c2.class, number: c2.number, code: 'AAAA-AAAA' })).status, 401);
  assert.equal((await anon.post('/api/student/login', { slug: R.slug, grade: c2.grade, class: c2.class, number: c2.number, code: c2.code })).status, 429);
  await R.login(2);
  ctx.clock.t = new Date(ctx.clock.t.getTime() + 5 * 60000 + 1);
  await R.login(1);
  // 응답은 캐시 금지
  assert.equal((await anon.get(`/api/public/rounds/${R.slug}`)).headers.get('cache-control'), 'no-store');
  await ctx.app.close();
});

test('참여 제한: 화면에서 숨김·신청 거부·배정 준수, 불가능한 설정은 접수 시작 차단', async () => {
  const ctx = await boot();
  // 학생1·학생2 는 축구만 가능(축구 정원 2) → 나머지가 모두 축구를 1지망으로 써도 둘은 축구
  const R = await setupRound(ctx, {
    restrictions: (d) => d.students.slice(0, 2).flatMap((s) => d.programs.filter((p) => p.name !== '축구').map((p) => ({ studentId: s.id, programId: p.id }))),
  });
  await R.t.post(`/api/teacher/rounds/${R.id}/open`);
  const s0 = await R.login(0);
  assert.deepEqual((await s0.get('/api/student/me')).data.programs.map((p) => p.name), ['축구']);
  assert.equal((await s0.post('/api/student/application', { prefs: [R.pid('농구')], requestId: rid(), baseVersion: 0 })).data.error.code, 'PREF_NOT_ALLOWED');
  for (let i = 0; i < 6; i++) await (await R.login(i)).post('/api/student/application', { prefs: [R.pid('축구')], requestId: rid(), baseVersion: 0 });
  await R.t.post(`/api/teacher/rounds/${R.id}/close`);
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/allocate`)).status, 200);
  const d = (await R.t.get(`/api/teacher/rounds/${R.id}`)).data;
  assert.deepEqual(d.students.slice(0, 2).map((s) => s.result.programId), [R.pid('축구'), R.pid('축구')]);
  await R.t.post(`/api/teacher/rounds/${R.id}/publish`, { runId: d.run.id });
  // 보류된 학생의 설명은 '추첨 탈락'이 아니다
  const texts = [];
  for (let i = 2; i < 6; i++) texts.push((await (await R.login(i)).get('/api/student/me')).data.result.reasons.join(' '));
  assert.ok(texts.some((t) => t.includes('안전·참여 조건')));

  // 불가능: 세 학생이 축구만 가능한데 축구 정원 2명
  const X = await setupRound(ctx, {
    restrictions: (dd) => dd.students.slice(0, 3).flatMap((s) => dd.programs.filter((p) => p.name !== '축구').map((p) => ({ studentId: s.id, programId: p.id }))),
  });
  const open = await X.t.post(`/api/teacher/rounds/${X.id}/open`);
  assert.equal(open.data.error.code, 'NOT_READY');
  assert.match(open.data.error.message, /전원 배정 가능/);
  await ctx.app.close();
});

test('설정 검증: 인원 0·합계 불일치·최대 초과·명부 오류·학번 앞자리', async () => {
  const ctx = await boot();
  const R = await setupRound(ctx);
  const put = (programs) => R.t.put(`/api/teacher/rounds/${R.id}/programs`, { programs });
  assert.equal((await put([{ name: 'A', target: 0 }])).status, 400);
  assert.equal((await put([{ name: 'A', target: 1.5 }])).status, 400);
  assert.equal((await put([{ name: 'A', target: '3' }])).status, 400);
  assert.equal((await put([{ name: 'A', target: 3, maxCapacity: 2 }])).status, 400);
  assert.equal((await put([{ name: 'A', target: 3 }, { name: 'A', target: 3 }])).status, 400);
  assert.equal((await put([{ name: 'A', target: 3 }, { name: 'B', target: 2 }])).status, 200); // 저장은 되지만
  assert.equal((await R.t.post(`/api/teacher/rounds/${R.id}/open`)).data.error.code, 'NOT_READY'); // 합계 5 ≠ 6 → 시작 불가
  const bad = await R.t.put(`/api/teacher/rounds/${R.id}/roster`, { csv: '학년,반,번호,이름\n1,1,1,가\n1,1,1,나\n1,x,2,다\n1,1,3,\n' });
  assert.equal(bad.data.error.code, 'ROSTER_ERRORS');
  assert.equal(bad.data.error.errors.length, 3);
  assert.equal((await R.t.get(`/api/teacher/rounds/${R.id}`)).data.students.length, 6); // 오류가 있으면 기존 명부 유지
  // 탭 구분(엑셀 붙여넣기)·앞자리 0·동명이인·따옴표
  const ok = await R.t.put(`/api/teacher/rounds/${R.id}/roster`, { csv: '학년\t반\t번호\t이름\n1\t01\t01\t김민준\n1\t01\t02\t김민준\n1\t02\t01\t"=SUM(A1)"\n' });
  assert.equal(ok.data.count, 3);
  await ctx.app.close();
});

test('내보내기: 수식 주입 방지, 화면 주소·정적 파일 보안 헤더', async () => {
  const ctx = await boot();
  const R = await setupRound(ctx, { n: 3, programs: [['=HYPERLINK("http://x")', 2], ['+농구', 1]] });
  await R.t.put(`/api/teacher/rounds/${R.id}/roster`, { csv: '1,1,1,=cmd|x\n1,1,2,@홍길동\n1,1,3,"이, 순신"' });
  await R.t.post(`/api/teacher/rounds/${R.id}/codes`, { mode: 'missing' });
  await R.t.post(`/api/teacher/rounds/${R.id}/open`);
  const d = (await R.t.get(`/api/teacher/rounds/${R.id}`)).data;
  for (const s of d.students) await R.t.post(`/api/teacher/rounds/${R.id}/students/${s.id}/application`, { prefs: [d.programs[0].id], note: '확인', requestId: rid(), baseVersion: 0 });
  await R.t.post(`/api/teacher/rounds/${R.id}/close`);
  await R.t.post(`/api/teacher/rounds/${R.id}/allocate`);
  const csv = (await R.t.get(`/api/teacher/rounds/${R.id}/export?by=class`)).data;
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n').slice(1);
  for (const line of lines) for (const cell of line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) assert.doesNotMatch(cell.replace(/^"/, ''), /^[=+\-@]/);
  assert.ok(csv.includes('"이, 순신"'));
  const page = await fetch(ctx.base + '/r/' + R.slug);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(ctx.base + '/static/..%2Fsrc%2Fserver.js')).status, 404);
  await ctx.app.close();
});
