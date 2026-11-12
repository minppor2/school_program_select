'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine');

const seedOf = (n) => n.toString(16).padStart(64, '0');
const asMap = (r) => Object.fromEntries(r.assignments.map((a) => [a.studentId, a.programId]));
const slotsOf = (programs) => programs.flatMap((p) => Array(p.target).fill(p.id));

test('5.2 예시: 가=A, 나=C, 다=B (지망 단계가 바깥 반복문)', () => {
  const input = {
    programs: [{ id: 'A', target: 1 }, { id: 'B', target: 1 }, { id: 'C', target: 1 }],
    students: [
      { id: '가', prefs: ['A', 'B', 'C'] },
      { id: '나', prefs: ['A', 'B', 'C'] },
      { id: '다', prefs: ['B', 'A', 'C'] },
    ],
  };
  const r = E.allocateWithOrder(input, ['가', '나', '다'], slotsOf(input.programs));
  assert.deepEqual(asMap(r), { 가: 'A', 나: 'C', 다: 'B' });
  const na = r.assignments.find((a) => a.studentId === '나');
  assert.equal(na.stage, '3');
  assert.deepEqual(na.trail.map((t) => t.code), [E.REASON.LOTTERY_NOT_SELECTED, E.REASON.FULL_BEFORE_STAGE]);
});

test('5.5 참여 제한 반례: 가=B, 나=A 이고 가의 사유는 추첨 탈락이 아니다', () => {
  const input = {
    programs: [{ id: 'A', target: 1 }, { id: 'B', target: 1 }],
    students: [{ id: '가', prefs: ['A'] }, { id: '나', prefs: ['A'] }],
    forbidden: [['나', 'B']],
  };
  const r = E.allocateWithOrder(input, ['가', '나'], ['A', 'B']);
  assert.deepEqual(asMap(r), { 가: 'B', 나: 'A' });
  const ga = r.assignments.find((a) => a.studentId === '가');
  assert.equal(ga.stage, 'R');
  assert.deepEqual(ga.trail.map((t) => t.code), [E.REASON.HELD_FOR_FEASIBILITY]);
});

test('불가능한 조건: 두 학생이 A만 가능한데 A 정원 1명 → 실행 차단', () => {
  const input = {
    programs: [{ id: 'A', target: 1 }, { id: 'B', target: 1 }],
    students: [{ id: 1, prefs: ['A'] }, { id: 2, prefs: ['A'] }],
    forbidden: [[1, 'B'], [2, 'B']],
  };
  assert.throws(() => E.allocate(input, seedOf(1)), (e) => e.code === 'INFEASIBLE');
  assert.equal(E.checkFeasibility(input).ok, false);
});

test('정원 검증: 0·소수·음수·합계 불일치·최대 인원 초과·미해결 신청을 거부', () => {
  const students = [{ id: 1, prefs: ['A'] }, { id: 2, prefs: ['A'] }];
  const run = (programs, st = students) => () => E.allocate({ programs, students: st }, seedOf(1));
  assert.throws(run([{ id: 'A', target: 2 }, { id: 'B', target: 0 }]), (e) => e.code === 'BAD_TARGET');
  assert.throws(run([{ id: 'A', target: 1.5 }, { id: 'B', target: 0.5 }]), (e) => e.code === 'BAD_TARGET');
  assert.throws(run([{ id: 'A', target: 3 }, { id: 'B', target: -1 }]), (e) => e.code === 'BAD_TARGET');
  assert.throws(run([{ id: 'A', target: Infinity }]), (e) => e.code === 'BAD_TARGET');
  assert.throws(run([{ id: 'A', target: 1 }, { id: 'B', target: 2 }]), (e) => e.code === 'TARGET_SUM_MISMATCH');
  assert.throws(run([{ id: 'A', target: 2, maxCapacity: 1 }]), (e) => e.code === 'TARGET_OVER_MAX');
  assert.throws(run([{ id: 'A', target: 1 }, { id: 'B', target: 1 }], [{ id: 1, prefs: ['A'] }, { id: 2, prefs: [] }]), (e) => e.code === 'UNRESOLVED');
  assert.throws(run([{ id: 'A', target: 1 }, { id: 'B', target: 1 }], [{ id: 1, prefs: ['A', 'A'] }, { id: 2, prefs: ['B'] }]), (e) => e.code === 'BAD_PREFS');
  assert.throws(run([{ id: 'A', target: 1 }, { id: 'B', target: 1 }, { id: 'C', target: 1 }]), (e) => e.code === 'TOO_FEW_STUDENTS');
});

function bigInput(n, k, rnd) {
  const programs = Array.from({ length: k }, (_, i) => ({ id: `P${i}`, target: 0 }));
  for (let i = 0; i < n; i++) programs[i % k].target++;
  const students = Array.from({ length: n }, (_, i) => {
    const pool = programs.map((p) => p.id).filter((id) => id !== 'P0'); // P0 은 희망 0명
    const prefs = [];
    const count = 1 + Math.floor(rnd() * 3);
    while (prefs.length < count) {
      const pick = pool[Math.floor(rnd() * rnd() * pool.length)]; // 앞 프로그램에 쏠리게
      if (!prefs.includes(pick)) prefs.push(pick);
    }
    return { id: i + 1, prefs };
  });
  return { programs, students };
}
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

test('희망 0명 프로그램도 목표 인원을 채우고 전원 배정 (184명·8개 → 각 23명)', () => {
  const input = bigInput(184, 8, lcg(7));
  const r = E.allocate(input, seedOf(42));
  assert.equal(r.verification.ok, true);
  const counts = {};
  for (const a of r.assignments) counts[a.programId] = (counts[a.programId] || 0) + 1;
  for (const p of input.programs) assert.equal(counts[p.id], 23);
  assert.ok(r.assignments.filter((a) => a.programId === 'P0').every((a) => a.stage === 'R'));
});

test('한 프로그램에 전원 1지망 · 프로그램 1개 · 나누어떨어지지 않는 정원', () => {
  const programs = [{ id: 'A', target: 4 }, { id: 'B', target: 3 }, { id: 'C', target: 3 }];
  const students = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, prefs: ['A'] }));
  const r = E.allocate({ programs, students }, seedOf(3));
  assert.equal(r.verification.ok, true);
  assert.equal(r.assignments.filter((a) => a.stage === '1').length, 4);
  const one = E.allocate({ programs: [{ id: 'A', target: 3 }], students: students.slice(0, 3) }, seedOf(3));
  assert.ok(one.assignments.every((a) => a.programId === 'A' && a.stage === '1'));
  assert.deepEqual(E.balancedTargets(10, [null, null, null]), [4, 3, 3]);
  assert.deepEqual(E.balancedTargets(184, Array(8).fill(null)), Array(8).fill(23));
  assert.deepEqual(E.balancedTargets(10, [2, null, null]), [2, 4, 4]);
  assert.equal(E.balancedTargets(10, [2, 2, 2]), null);
  assert.equal(E.balancedTargets(2, [null, null, null]), null);
});

test('재현성: 같은 입력·seed 면 같은 결과, 명부·프로그램 행 순서를 바꿔도 같은 결과', () => {
  const input = bigInput(60, 5, lcg(11));
  input.forbidden = [[1, 'P1'], [2, 'P1'], [3, 'P2'], [4, 'P0'], [5, 'P0']].filter(
    ([s, p]) => !input.students[s - 1].prefs.includes(p)
  );
  const base = asMap(E.allocate(input, seedOf(99)));
  assert.deepEqual(asMap(E.allocate(input, seedOf(99))), base);
  const shuffled = {
    programs: [...input.programs].reverse(),
    students: [...input.students].sort((a, b) => ((a.id * 7919) % 61) - ((b.id * 7919) % 61)),
    forbidden: [...input.forbidden].reverse(),
  };
  assert.deepEqual(asMap(E.allocate(shuffled, seedOf(99))), base);
  assert.notDeepEqual(asMap(E.allocate(input, seedOf(100))), base);
});

test('참여 제한이 없으면: 2·3지망을 추가해도 1지망 단계 결과가 바뀌지 않는다', () => {
  const input = bigInput(80, 6, lcg(5));
  const onlyFirst = { programs: input.programs, students: input.students.map((s) => ({ id: s.id, prefs: s.prefs.slice(0, 1) })) };
  const a = E.allocate(input, seedOf(8)).assignments.filter((x) => x.stage === '1');
  const b = E.allocate(onlyFirst, seedOf(8)).assignments.filter((x) => x.stage === '1');
  assert.deepEqual(a.map((x) => [x.studentId, x.programId]), b.map((x) => [x.studentId, x.programId]));
});

test('무희망 확인 학생은 지망 단계에 참가하지 않고 잔여 배정된다', () => {
  const input = {
    programs: [{ id: 'A', target: 1 }, { id: 'B', target: 1 }],
    students: [{ id: 1, prefs: [], noPreference: true }, { id: 2, prefs: ['A'] }],
  };
  const r = E.allocateWithOrder(input, [1, 2], ['A', 'B']);
  assert.deepEqual(asMap(r), { 1: 'B', 2: 'A' });
});

test('소규모 완전 열거: 3명·3개(각 1명) 참여 가능 조합 343 × 순서 6 × 지망 구성 3 = 6,174', () => {
  const P = ['A', 'B', 'C'];
  const S = [1, 2, 3];
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const subsets = [1, 2, 3, 4, 5, 6, 7].map((m) => P.filter((_, i) => m & (1 << i)));
  let cases = 0;
  let feasibleCombos = 0;
  for (const a1 of subsets) for (const a2 of subsets) for (const a3 of subsets) {
    const allowed = [a1, a2, a3];
    const brute = perms.some((pm) => pm.every((pi, si) => allowed[si].includes(P[pi])));
    if (brute) feasibleCombos++;
    const forbidden = [];
    S.forEach((s, i) => P.forEach((p) => { if (!allowed[i].includes(p)) forbidden.push([s, p]); }));
    for (const pm of perms) {
      for (let cfg = 0; cfg < 3; cfg++) {
        cases++;
        // 지망 구성: 0=허용 프로그램 전부(앞에서부터), 1=역순, 2=1지망만
        const students = S.map((s, i) => {
          let prefs = [...allowed[i]];
          if (cfg === 1) prefs.reverse();
          if (cfg === 2) prefs = prefs.slice(0, 1);
          return { id: s, prefs };
        });
        const input = { programs: P.map((id) => ({ id, target: 1 })), students, forbidden };
        const order = pm.map((i) => S[i]);
        if (!brute) {
          assert.throws(() => E.allocateWithOrder(input, order, P), (e) => e.code === 'INFEASIBLE');
          continue;
        }
        const r = E.allocateWithOrder(input, order, P);
        assert.equal(r.verification.ok, true);
        for (const x of r.assignments) assert.ok(allowed[x.studentId - 1].includes(x.programId));
      }
    }
  }
  assert.equal(cases, 6174);
  assert.equal(feasibleCombos, 247);
});

test('무작위 대규모: 200명·8개, 참여 제한 포함 100회 — 항상 검증 통과', () => {
  const rnd = lcg(2026);
  for (let t = 0; t < 100; t++) {
    const input = bigInput(200, 8, rnd);
    const forbidden = [];
    for (const s of input.students) {
      if (rnd() < 0.1) {
        const p = input.programs[Math.floor(rnd() * 8)].id;
        if (!s.prefs.includes(p)) forbidden.push([s.id, p]);
      }
    }
    input.forbidden = forbidden;
    const r = E.allocate(input, seedOf(t + 1));
    assert.equal(r.verification.ok, true);
  }
});
