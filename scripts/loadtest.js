'use strict';
/**
 * 동시 사용 시험 (가상 데이터 전용).
 *   node scripts/loadtest.js [학생수=200]
 * 실제 서버 프로세스를 임시 폴더의 파일 DB로 띄우고, 가상 학생이 동시에 시작하는
 * 로그인 / 조회 / 제출 / 재시도 / 결과 조회 시나리오와 통합 시나리오를 측정한다.
 * 한 대의 컴퓨터 안(loopback)에서 잰 값이며, 학교망·실제 기기 성능을 보장하지 않는다.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const N = Number(process.argv[2] || 200);
const PROGRAMS = 8;
const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(BASE + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
}

const report = [];
async function phase(name, tasks) {
  const lat = [];
  let errors = 0;
  const t0 = performance.now();
  const results = await Promise.all(tasks.map(async (fn) => {
    const s = performance.now();
    try {
      const r = await fn();
      lat.push(performance.now() - s);
      if (r && r.status >= 400) errors++;
      return r;
    } catch (e) {
      errors++;
      return { status: 0, error: String(e) };
    }
  }));
  const wall = performance.now() - t0;
  lat.sort((a, b) => a - b);
  const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : NaN);
  const row = { 시나리오: name, 요청수: tasks.length, 오류: errors, 'p50(ms)': q(0.5).toFixed(0), 'p95(ms)': q(0.95).toFixed(0), '최대(ms)': q(1).toFixed(0), '전체(ms)': wall.toFixed(0) };
  report.push(row);
  return results;
}
const rid = (tag, i) => `load-${tag}-${String(i).padStart(5, '0')}`;
const check = (cond, msg) => { if (!cond) { failures.push(msg); console.error('  ✖ ' + msg); } else console.log('  ✔ ' + msg); };
const failures = [];

async function prepareRound(teacher, title, n) {
  const id = (await teacher('POST', '/api/teacher/rounds', { title, year: 2026 })).data.id;
  const per = Math.ceil(n / 8);
  const csv = '학년,반,번호,이름\n' + Array.from({ length: n }, (_, i) => `1,${1 + Math.floor(i / per)},${1 + (i % per)},가상학생${i + 1}`).join('\n');
  await teacher('PUT', `/api/teacher/rounds/${id}/roster`, { csv });
  const targets = Array.from({ length: PROGRAMS }, (_, i) => Math.floor(n / PROGRAMS) + (i < n % PROGRAMS ? 1 : 0));
  await teacher('PUT', `/api/teacher/rounds/${id}/programs`, { programs: targets.map((t, i) => ({ name: `프로그램${i + 1}`, description: '가상', place: '', target: t, maxCapacity: null })) });
  const codes = (await teacher('POST', `/api/teacher/rounds/${id}/codes`, { mode: 'missing' })).data.codes;
  const open = await teacher('POST', `/api/teacher/rounds/${id}/open`, {});
  if (open.status !== 200) throw new Error('open failed: ' + JSON.stringify(open.data));
  const d = (await teacher('GET', `/api/teacher/rounds/${id}`)).data;
  return { id, codes, slug: d.joinUrl.split('/r/')[1], programs: d.programs.map((p) => p.id) };
}
// 인기 프로그램에 쏠리는 지망 (프로그램8 은 희망 0명)
function prefsFor(i, programs) {
  const pool = programs.slice(0, -1);
  const a = pool[(i * i) % 3];
  const b = pool[3 + (i % 4)];
  const c = pool[(i + 1) % 3 === (i * i) % 3 ? 2 - ((i * i) % 3 === 2 ? 2 : 0) : (i + 1) % 3];
  const list = [a, b];
  if (c !== a && i % 2) list.push(c);
  return i % 5 === 0 ? [a] : list;
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sps-load-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'start.js')], { env: { ...process.env, DATA_DIR: dir, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (b) => String(b).includes('교사용 화면') && resolve());
    server.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
  try {
    const teacher = client();
    await teacher('POST', '/api/teacher/signup', { schoolName: '가상부하시험중', name: '시험교사', loginId: 'loadtest', password: 'loadtest-password' });

    console.log(`\n[1] 단계별 동시 시작 — 가상 학생 ${N}명, 프로그램 ${PROGRAMS}개`);
    const R = await prepareRound(teacher, '부하시험-단계별', N);
    const students = R.codes.map(() => client());
    const login = (c, s, slug) => c('POST', '/api/student/login', { slug, grade: s.grade, class: s.class, number: s.number, code: s.code });

    await phase('화면 열기(QR 접속 페이지+정적 파일 3개)', students.flatMap(() => [`/r/${R.slug}`, '/static/app.css', '/static/common.js', '/static/student.js'].map((p) => () => fetch(BASE + p).then(async (r) => (await r.arrayBuffer(), { status: r.status })))));
    const logins = await phase('동시 로그인', students.map((c, i) => () => login(c, R.codes[i], R.slug)));
    await phase('동시 내 정보 조회', students.map((c) => () => c('GET', '/api/student/me')));
    const bodies = students.map((_, i) => ({ prefs: prefsFor(i, R.programs), requestId: rid('s', i), baseVersion: 0 }));
    const submits = await phase('동시 희망 제출', students.map((c, i) => () => c('POST', '/api/student/application', bodies[i])));
    const retries = await phase('같은 요청 재전송(중복 클릭·재시도)', students.map((c, i) => () => c('POST', '/api/student/application', bodies[i])));
    const edits = await phase('동시 수정(4명 중 1명)', students.filter((_, i) => i % 4 === 0).map((c, k) => () => c('POST', '/api/student/application', { prefs: prefsFor(k * 4 + 1, R.programs), requestId: rid('e', k), baseVersion: 1 })));

    let d = (await teacher('GET', `/api/teacher/rounds/${R.id}`)).data;
    check(logins.every((r) => r.status === 200), `로그인 ${N}건 모두 성공`);
    check(submits.every((r) => r.status === 200 && r.data.receipt), `제출 ${N}건 모두 접수번호 수신`);
    check(new Set(submits.map((r) => r.data.receipt)).size === N, '접수번호 중복 없음');
    check(retries.every((r, i) => r.status === 200 && r.data.replayed && r.data.receipt === submits[i].data.receipt), '재전송은 모두 원래 접수 결과를 반환(새 접수 없음)');
    check(edits.every((r) => r.status === 200 && r.data.version === 2), '수정 요청 모두 버전 2로 반영');
    check(d.students.filter((s) => s.app).length === N, `서버에 유효 신청 ${N}건 (유실 0)`);
    check(d.students.every((s, i) => JSON.stringify(s.app.prefs) === JSON.stringify(i % 4 === 0 ? prefsFor(i + 1, R.programs) : bodies[i].prefs)), '저장된 내용이 각 학생이 마지막으로 보낸 내용과 일치(중복·뒤섞임 0)');

    await teacher('POST', `/api/teacher/rounds/${R.id}/close`, {});
    const alloc = await phase('배정하기 버튼 3번 동시 클릭', [1, 2, 3].map(() => () => teacher('POST', `/api/teacher/rounds/${R.id}/allocate`, {})));
    check(new Set(alloc.map((r) => r.data.runId)).size === 1, '동시 클릭에도 배정 실행은 1개');
    const hidden = await phase('공개 전 결과 조회', students.map((c) => () => c('GET', '/api/student/me')));
    check(hidden.every((r) => r.data.result === null), '공개 전에는 어떤 학생에게도 결과가 보이지 않음');
    await teacher('POST', `/api/teacher/rounds/${R.id}/publish`, { runId: alloc[0].data.runId });
    const results = await phase('동시 결과 조회', students.map((c) => () => c('GET', '/api/student/me')));
    d = (await teacher('GET', `/api/teacher/rounds/${R.id}`)).data;
    const nameOf = new Map(d.programs.map((p) => [p.id, p.name]));
    check(d.run.verification.ok, '배정 검증 통과(전원 1개·목표 인원·참여 제한)');
    check(results.every((r, i) => r.status === 200 && r.data.result && r.data.result.programName === nameOf.get(d.students.find((s) => s.name === r.data.student.name).result.programId)), '모든 학생이 본인의 결과만 정확히 조회');
    const counts = new Map();
    for (const s of d.students) counts.set(s.result.programId, (counts.get(s.result.programId) || 0) + 1);
    check(d.programs.every((p) => counts.get(p.id) === p.target), '희망 0명 프로그램 포함 모든 프로그램이 목표 인원 충족');

    console.log(`\n[2] 통합 시나리오 — ${N}명이 동시에 접속→로그인→조회→제출→확인`);
    const R2 = await prepareRound(teacher, '부하시험-통합', N);
    const flow = await phase('통합(학생 1명당 요청 5개)', R2.codes.map((s, i) => async () => {
      const c = client();
      await fetch(`${BASE}/r/${R2.slug}`).then((r) => r.arrayBuffer());
      const a = await login(c, s, R2.slug);
      const b = await c('GET', '/api/student/me');
      const s1 = await c('POST', '/api/student/application', { prefs: prefsFor(i, R2.programs), requestId: rid('f', i), baseVersion: 0 });
      const m = await c('GET', '/api/student/me');
      const ok = a.status === 200 && b.status === 200 && s1.status === 200 && m.data.application && m.data.application.receipt === s1.data.receipt;
      return { status: ok ? 200 : 500 };
    }));
    check(flow.every((r) => r.status === 200), `통합 흐름 ${N}명 모두 접수 완료 확인`);
    const d2 = (await teacher('GET', `/api/teacher/rounds/${R2.id}`)).data;
    check(d2.students.filter((s) => s.app).length === N, `통합: 서버에 유효 신청 ${N}건`);

    console.log('');
    console.table(report);
    const mem = process.memoryUsage();
    console.log(`환경: ${os.cpus()[0].model.trim()} × ${os.cpus().length}코어, RAM ${(os.totalmem() / 2 ** 30).toFixed(0)}GB, ${os.platform()} ${os.release()}, Node ${process.version}`);
    console.log(`서버: 단일 Node 프로세스 + SQLite 파일 DB(WAL, synchronous=FULL), 같은 컴퓨터의 loopback. 시험 클라이언트 메모리 ${(mem.rss / 2 ** 20).toFixed(0)}MB`);
    console.log(failures.length ? `\n실패 ${failures.length}건` : '\n모든 확인 항목 통과');
    process.exitCode = failures.length ? 1 : 0;
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
