'use strict';
/**
 * 자유학기 선착순 신청 시뮬레이션: 여러 학교 상황을 무작위로 만들어 끝까지 돌려 본다.
 *   node scripts/simulate-fcfs.js [반복 횟수=300]
 * 확인하는 것: 시간대마다 전원 배정, 정원 이내, 참여 제한 준수, 같은 영역 겹침 없음.
 * 비교용으로 "자리 잡을 때 검사를 하지 않으면" 얼마나 자주 막히는지도 함께 센다.
 */
const fcfs = require('../src/fcfs');

/** 한 가지 상황을 만들어 끝까지 돌린다. guard=false 면 정원·겹침만 보고 자리를 내준다(비교용) */
function runScenario(seed, kind, guard = true) {
  const rng = fcfs.rngOf(String(seed), kind);
  const pick = (n) => Math.floor(rng() * n);
  const topicSlots = kind === 'three-terms' ? 6 : 2 + 2 * pick(2); // 주제선택 시간대 2개 또는 4개(3기면 6개)
  // latin: 프로그램 종류가 시간대 수와 같고 정원 합계가 학생 수와 딱 같은, 가장 빡빡한 경우(학생 수는 종류의 배수)
  const N = kind === 'small' ? 8 + pick(16) : kind === 'latin' ? topicSlots * (10 + pick(50)) : 60 + pick(240);
  const careerSlots = kind === 'with-career' || kind.startsWith('pooled') ? 2 : 0;
  // 한 기에 주제선택 2시간(첫째·둘째), 진로탐색 1시간. pooled 는 한 기의 두 시간이 프로그램 정원을 함께 쓰는 실제 운영 방식이다.
  const pooled = kind.startsWith('pooled');
  const slots = [];
  for (let i = 0; i < topicSlots; i++) slots.push({ id: slots.length + 1, area: '주제선택', term: Math.floor(i / 2) + 1 });
  for (let i = 0; i < careerSlots; i++) slots.push({ id: slots.length + 1, area: '진로탐색', term: i + 1 });
  const students = Array.from({ length: N }, (_, i) => `s${i + 1}`);
  for (const s of slots) s.students = students;

  // 프로그램: 시간대마다 종류와 정원이 조금씩 다르다. tight 는 정원 합계가 학생 수와 딱 같다.
  const programs = [];
  const slack = kind === 'tight' || kind === 'latin' || kind === 'pooled-tight' ? 0 : kind === 'loose' ? 0.3 : kind === 'pooled-terms' ? 0.5 : 0.1;
  if (pooled) {
    // 영역마다 프로그램 목록은 하나. 정원은 "한 기에 받는 총 인원"이라 같은 기의 시간들이 함께 쓴다.
    for (const area of ['주제선택', '진로탐색']) {
      const mine = slots.filter((x) => x.area === area);
      if (!mine.length) continue;
      const perTerm = mine.filter((x) => x.term === 1).length;
      const kinds = mine.length + pick(7);
      const total = Math.ceil(N * perTerm * (1 + slack));
      const base = Math.floor(total / kinds);
      for (let i = 0; i < kinds; i++) {
        const onlyTerm = kind === 'pooled-terms' && i >= mine.length + 1 && rng() < 0.3 ? 1 + pick(2) : 0; // 어느 한 기에만 여는 프로그램
        for (const slot of mine) {
          if (onlyTerm && slot.term !== onlyTerm) continue;
          programs.push({ id: programs.length + 1, slot: slot.id, key: `${area}${i + 1}`, capacity: base + (i < total - base * kinds ? 1 : 0) + (onlyTerm ? Math.ceil(N / 6) : 0), pool: `${slot.term}|${area}|${i + 1}` });
        }
      }
    }
  }
  for (const slot of pooled ? [] : slots) {
    const sameArea = slots.filter((x) => x.area === slot.area).length;
    const kinds = kind === 'latin' ? sameArea : sameArea + pick(6); // latin: 종류가 시간대 수와 같아 가장 빡빡한 경우
    const names = fcfs.shuffle(Array.from({ length: kind === 'different-lists' ? kinds + 4 : kinds }, (_, i) => `${slot.area}${i + 1}`), rng).slice(0, kinds);
    const total = Math.ceil(N * (1 + slack));
    const base = Math.floor(total / kinds);
    names.forEach((key, i) => programs.push({ id: programs.length + 1, slot: slot.id, key, capacity: base + (i < total - base * kinds ? 1 : 0) }));
  }
  // 참여 제한 약간
  const forbidden = [];
  if (kind === 'restricted') for (const s of students) if (rng() < 0.08) forbidden.push([s, programs[pick(programs.length)].id]);

  let input = { slots, programs, claims: [], forbidden };
  if (!fcfs.feasible(input)) return { skipped: true };

  // 학생들이 몰려와 신청한다: 인기가 한쪽으로 쏠리고, 일부는 결석, 일부는 몇 시간대만 낸다. 찼으면 다음으로 좋아하는 곳을 고른다.
  const popularity = new Map(programs.map((p) => [p.id, Math.pow(rng(), kind === 'skewed' ? 4 : 2)]));
  const absent = kind === 'many-absent' ? 0.35 : 0.08;
  const stats = { claims: 0, full: 0, held: 0, duplicate: 0, gaveUp: 0 };
  const arrivals = [];
  for (const s of students) if (rng() >= absent) for (const slot of slots) if (rng() < 0.9) arrivals.push([s, slot]);
  fcfs.shuffle(arrivals, rng); // 동시에 누르는 것처럼 뒤섞는다
  for (const [s, slot] of arrivals) {
    const wish = programs.filter((p) => p.slot === slot.id).sort((a, b) => popularity.get(b.id) * (0.5 + rng()) - popularity.get(a.id) * (0.5 + rng()));
    let done = false;
    for (const p of wish.slice(0, 4)) { // 네 번까지 다시 고른다
      let res;
      if (guard) res = fcfs.tryClaim(input, s, slot.id, p.id);
      else {
        const taken = input.claims.filter((c) => (p.pool ? programs.find((x) => x.id === c[2]).pool === p.pool : c[2] === p.id)).length;
        const dup = input.claims.some((c) => c[0] === s && slots.find((x) => x.id === c[1]).area === slot.area && programs.find((x) => x.id === c[2]).key === p.key);
        const banned = forbidden.some((f) => f[0] === s && f[1] === p.id);
        res = taken >= p.capacity ? { ok: false, code: 'FULL' } : dup ? { ok: false, code: 'DUPLICATE' } : banned ? { ok: false, code: 'FORBIDDEN' } : { ok: true, claims: [...input.claims, [s, slot.id, p.id]] };
      }
      if (res.ok) { input = { ...input, claims: res.claims }; stats.claims++; done = true; break; }
      if (res.code === 'FULL') stats.full++; else if (res.code === 'HELD') stats.held++; else if (res.code === 'DUPLICATE') stats.duplicate++;
    }
    if (!done) stats.gaveUp++;
    // 가끔 마음을 바꿔 다른 곳으로 옮긴다
    if (done && guard && rng() < 0.05) {
      const other = wish[pick(wish.length)];
      const res = fcfs.tryClaim(input, s, slot.id, other.id);
      if (res.ok) input = { ...input, claims: res.claims };
    }
  }
  const out = fcfs.fill(input, String(seed));
  const check = fcfs.verify(input, out.fills);
  return { N, slots: slots.length, stats, method: out.method, flags: out.flags.length, ok: check.ok, checks: check.checks, fills: out.fills.length };
}

const KINDS = ['pooled', 'pooled-tight', 'pooled-terms', 'tight', 'loose', 'latin', 'skewed', 'many-absent', 'restricted', 'with-career', 'different-lists', 'three-terms', 'small'];

function simulate(rounds) {
  const rows = [];
  for (const kind of KINDS) {
    const row = { kind, runs: 0, ok: 0, random: 0, ordered: 0, forced: 0, claims: 0, full: 0, held: 0, fills: 0, noGuardStuck: 0 };
    for (let i = 0; i < rounds; i++) {
      const a = runScenario(i, kind, true);
      if (a.skipped) continue;
      row.runs++;
      if (a.ok) row.ok++;
      row[a.method.toLowerCase()]++;
      row.claims += a.stats.claims; row.full += a.stats.full; row.held += a.stats.held; row.fills += a.fills;
      const b = runScenario(i, kind, false); // 검사 없이 자리를 내줬다면
      if (!b.skipped && b.method === 'FORCED') row.noGuardStuck++;
    }
    rows.push(row);
  }
  return rows;
}

if (require.main === module) {
  const rounds = Number(process.argv[2]) || 300;
  const started = Date.now();
  const rows = simulate(rounds);
  console.log('상황              실행  모두통과  무작위  정해진순서  조건풂  잡은자리  정원참  남겨둠  무작위배정  (검사없으면 막힘)');
  for (const r of rows) {
    console.log([r.kind.padEnd(16), String(r.runs).padStart(5), String(r.ok).padStart(8), String(r.random).padStart(7), String(r.ordered).padStart(9), String(r.forced).padStart(7),
      String(r.claims).padStart(9), String(r.full).padStart(7), String(r.held).padStart(6), String(r.fills).padStart(9), String(r.noGuardStuck).padStart(12)].join(' '));
  }
  const bad = rows.reduce((a, r) => a + (r.runs - r.ok) + r.forced, 0);
  console.log(`\n${rows.reduce((a, r) => a + r.runs, 0)}번 실행 · ${((Date.now() - started) / 1000).toFixed(1)}초 · ${bad ? `문제 ${bad}건` : '갈 곳 없는 학생·겹침·정원 초과 0건'}`);
  process.exitCode = bad ? 1 : 0;
}

module.exports = { runScenario, simulate, KINDS };
