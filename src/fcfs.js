'use strict';
/**
 * 자유학기 묶음의 선착순 신청 — 화면·DB 와 분리된 순수 계산 모듈.
 *
 *  - 학생은 시간대마다 프로그램 하나를 "먼저 온 순서"로 잡는다(정원이 차면 못 잡는다).
 *  - 같은 영역(주제선택끼리, 진로탐색끼리)에서는 이름이 같은 프로그램을 두 번 받지 않는다.
 *  - 자리를 하나 잡을 때마다, 아직 못 잡은 학생 전원이 남은 자리에 겹치지 않게 들어갈 수 있는지 검사한다.
 *    들어갈 수 없게 되는 자리는 잡지 못하게 막는다. 그래서 마감 뒤 무작위 배정에서 갈 곳 없는 학생이 생기지 않는다.
 *  - 마감 뒤에는 못 잡은 시간대를 남은 자리에 무작위로 채운다.
 *
 * 입력:
 *   slots:    [{ id, area, students: [학생키...] }]          // 화면에 보이는 순서
 *   programs: [{ id, slot, key, capacity }]                  // key: 이름을 정리한 값(같으면 같은 프로그램)
 *   claims:   [[학생키, 시간대, 프로그램]]                    // 선착순으로 잡은 자리
 *   forbidden:[[학생키, 프로그램]]                            // 참여 제한
 */
const crypto = require('node:crypto');

/** 추첨 기준(seed)과 용도에서 뽑아내는 난수 */
function rngOf(seed, label) {
  let a = crypto.createHash('sha256').update(`${seed}:${label}`).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, rng) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function prepare(input) {
  const bySlot = new Map(input.slots.map((s) => [s.id, []]));
  const program = new Map();
  for (const p of input.programs) {
    program.set(p.id, p);
    if (bySlot.has(p.slot)) bySlot.get(p.slot).push(p);
  }
  const area = new Map(input.slots.map((s) => [s.id, s.area]));
  const forbidden = new Set((input.forbidden || []).map(([s, p]) => `${s}|${p}`));
  const claim = new Map(); // "시간대|학생" → 프로그램
  const taken = new Map(); // 프로그램 → 잡은 사람 수
  const held = new Map(); // "학생|영역" → 이미 가진 프로그램 이름들
  const hold = (s, slotId, key) => {
    const k = `${s}|${area.get(slotId)}`;
    if (!held.has(k)) held.set(k, new Set());
    held.get(k).add(key);
  };
  for (const [s, slotId, pid] of input.claims || []) {
    const p = program.get(pid);
    if (!p || p.slot !== slotId) continue;
    claim.set(`${slotId}|${s}`, pid);
    taken.set(pid, (taken.get(pid) || 0) + 1);
    hold(s, slotId, p.key);
  }
  return { bySlot, program, area, forbidden, claim, taken, held, hold };
}

/**
 * 아직 자리가 없는 (학생, 시간대)를 남은 자리에 채운다.
 * opt.order: 시간대를 채우는 순서(번호 배열) · opt.rng: 주면 무작위로 · opt.force: 막히면 조건을 풀어서라도 채운다
 * 반환: { ok, fills: [[학생, 시간대, 프로그램]], flags: [{ student, slot, program, why }] } 또는 { ok:false, slot, student }
 */
function complete(input, opt = {}) {
  const st = prepare(input);
  const fills = [];
  const flags = [];
  const order = opt.order || input.slots.map((_, i) => i);
  for (const i of order) {
    const slot = input.slots[i];
    const programs = st.bySlot.get(slot.id);
    const left = new Map(programs.map((p) => [p.id, Math.max(0, p.capacity - (st.taken.get(p.id) || 0))]));
    const need = slot.students.filter((s) => !st.claim.has(`${slot.id}|${s}`));
    if (opt.rng) shuffle(need, opt.rng);
    const occ = new Map(programs.map((p) => [p.id, []]));
    const got = new Map();
    const options = new Map();
    const sorted = opt.rng ? programs : [...programs].sort((a, b) => left.get(b.id) - left.get(a.id) || a.id - b.id); // 자리가 많이 남은 곳부터
    const anyForbidden = st.forbidden.size > 0;
    const optionsOf = (s) => {
      if (!options.has(s)) {
        const mine = st.held.get(`${s}|${slot.area}`);
        const list = sorted.filter((p) => !(mine && mine.has(p.key)) && !(anyForbidden && st.forbidden.has(`${s}|${p.id}`)));
        if (opt.rng) shuffle(list, opt.rng);
        options.set(s, list);
      }
      return options.get(s);
    };
    /** 자리가 없으면 먼저 앉은 학생을 다른 자리로 옮겨 가며 자리를 만든다(이분 매칭) */
    const place = (s, seen) => {
      for (const p of optionsOf(s)) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const o = occ.get(p.id);
        if (o.length < left.get(p.id)) { o.push(s); got.set(s, p); return true; }
        for (let k = 0; k < o.length; k++) {
          if (place(o[k], seen)) { o[k] = s; got.set(s, p); return true; }
        }
      }
      return false;
    };
    for (const s of need) {
      if (place(s, new Set())) continue;
      if (!opt.force) return { ok: false, slot: slot.id, student: s };
      // 마지막 수단: 아무도 빠지지 않게 조건을 하나씩 푼다. 푼 내용은 교사가 볼 수 있게 표시한다.
      const free = (list) => list.filter((p) => occ.get(p.id).length < left.get(p.id));
      const allowed = programs.filter((p) => !st.forbidden.has(`${s}|${p.id}`));
      const least = (list) => [...list].sort((a, b) => (occ.get(a.id).length - left.get(a.id)) - (occ.get(b.id).length - left.get(b.id)) || a.id - b.id)[0];
      const fresh = optionsOf(s);
      let p, why;
      if (free(allowed).length) { p = least(free(allowed)); why = 'DUPLICATE'; } // 자리는 있으나 같은 영역에서 이미 받은 프로그램
      else if (fresh.length) { p = least(fresh); why = 'OVER'; } // 겹치지 않는 곳이 모두 차서 정원을 넘김
      else if (allowed.length) { p = least(allowed); why = 'OVER_DUPLICATE'; }
      else if (programs.length) { p = least(programs); why = 'RESTRICTED'; } // 참여 제한 때문에 갈 곳이 없음
      else throw new Error(`시간대 ${slot.id}에 프로그램이 없습니다.`);
      occ.get(p.id).push(s);
      got.set(s, p);
      flags.push({ student: s, slot: slot.id, program: p.id, why });
    }
    for (const [s, p] of got) {
      fills.push([s, slot.id, p.id]);
      st.hold(s, slot.id, p.key);
    }
  }
  return { ok: true, fills, flags };
}

/** 시간대를 채우는 순서 몇 가지(앞에서부터, 뒤에서부터, 돌려 가며). 하나라도 되면 채울 수 있는 것이다 */
function orders(n) {
  const base = Array.from({ length: n }, (_, i) => i);
  const out = [base, [...base].reverse()];
  for (let r = 1; r < n && out.length < 6; r++) out.push([...base.slice(r), ...base.slice(0, r)]);
  return out;
}

/** 못 잡은 학생 전원이 남은 자리에 겹치지 않게 들어갈 수 있는가 */
function feasible(input) {
  return orders(input.slots.length).some((order) => complete(input, { order }).ok);
}

/**
 * 자리 잡기 판정. 받아들이면 { ok:true }, 아니면 { ok:false, code }.
 *  FULL 정원이 참 · DUPLICATE 같은 영역의 다른 시간대에서 이미 고름 · FORBIDDEN 참여 제한 · HELD 다른 학생의 배정을 위해 남겨 둠
 */
function tryClaim(input, student, slotId, programId) {
  const st = prepare({ ...input, claims: (input.claims || []).filter(([s, sl]) => !(s === student && sl === slotId)) });
  const p = st.program.get(programId);
  if (!p || p.slot !== slotId) return { ok: false, code: 'UNKNOWN' };
  if (st.forbidden.has(`${student}|${programId}`)) return { ok: false, code: 'FORBIDDEN' };
  if ((st.taken.get(programId) || 0) >= p.capacity) return { ok: false, code: 'FULL' };
  const mine = st.held.get(`${student}|${st.area.get(slotId)}`);
  if (mine && mine.has(p.key)) return { ok: false, code: 'DUPLICATE' };
  const claims = [...(input.claims || []).filter(([s, sl]) => !(s === student && sl === slotId)), [student, slotId, programId]];
  if (!feasible({ ...input, claims })) return { ok: false, code: 'HELD' };
  return { ok: true, claims };
}

/**
 * 마감 뒤 남은 자리 채우기. 무작위로 여러 번 시도하고, 안 되면 검사에 쓰던 정해진 순서로, 그래도 안 되면 조건을 풀어 채운다.
 * 반환: { fills, flags, method: 'RANDOM' | 'ORDERED' | 'FORCED' }
 */
function fill(input, seed) {
  const all = orders(input.slots.length);
  for (let attempt = 0; attempt < 24; attempt++) {
    const rng = rngOf(seed, `fill:${attempt}`);
    const order = shuffle(input.slots.map((_, i) => i), rng);
    const out = complete(input, { order, rng });
    if (out.ok) return { ...out, method: 'RANDOM' };
  }
  for (const order of all) {
    const out = complete(input, { order });
    if (out.ok) return { ...out, method: 'ORDERED' };
  }
  return { ...complete(input, { force: true, rng: rngOf(seed, 'fill:force') }), method: 'FORCED' };
}

/** 결과 검증: 시간대마다 전원 하나씩, 정원 이내, 참여 제한 준수, 같은 영역 겹침 없음 */
function verify(input, fills) {
  const st = prepare(input);
  const all = [...(input.claims || []).filter(([s, sl, p]) => st.claim.get(`${sl}|${s}`) === p), ...fills];
  const seat = new Map();
  const count = new Map();
  let twice = 0, restricted = 0;
  const names = new Map();
  let overlap = 0;
  for (const [s, slotId, pid] of all) {
    const k = `${slotId}|${s}`;
    if (seat.has(k)) twice++;
    seat.set(k, pid);
    count.set(pid, (count.get(pid) || 0) + 1);
    if (st.forbidden.has(`${s}|${pid}`)) restricted++;
    const p = st.program.get(pid);
    const a = `${s}|${st.area.get(slotId)}`;
    if (!names.has(a)) names.set(a, new Set());
    if (names.get(a).has(p.key)) overlap++;
    names.get(a).add(p.key);
  }
  let missing = 0;
  for (const slot of input.slots) for (const s of slot.students) if (!seat.has(`${slot.id}|${s}`)) missing++;
  const over = input.programs.filter((p) => (count.get(p.id) || 0) > p.capacity).length;
  const checks = [
    { name: 'ALL_ASSIGNED_ONCE', label: '전원 배정', ok: missing === 0 && twice === 0, detail: `누락 ${missing} · 중복 ${twice}` },
    { name: 'WITHIN_CAPACITY', label: '정원 이내', ok: over === 0, detail: `정원을 넘은 프로그램 ${over}개` },
    { name: 'RESTRICTIONS_RESPECTED', label: '참여 제한 준수', ok: restricted === 0, detail: `위반 ${restricted}` },
    { name: 'NO_OVERLAP', label: '같은 영역 겹침 없음', ok: overlap === 0, detail: `겹침 ${overlap}` },
  ];
  return { ok: checks.every((c) => c.ok), checks };
}

module.exports = { ALGORITHM: 'FCFS_RANDOM_FILL_V1', complete, feasible, tryClaim, fill, verify, rngOf, shuffle };
