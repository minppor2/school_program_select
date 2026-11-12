'use strict';
/**
 * 배정 엔진 — RANK_FIRST_LOTTERY_V2 (지망 순차 추첨)
 *
 * UI·DB와 분리된 순수 함수 모듈이다.
 *  - 바깥 반복문이 "지망 단계", 안쪽 반복문이 "추첨 순서의 학생"이다.
 *  - 지망 단계와 잔여 단계 모두에서, 배정을 하나 확정할 때마다
 *    남은 학생 전원을 배정할 수 있는지(참여 제한 포함) 검사한다.
 *  - 추첨 순서와 잔여 자리 섞기는 보존된 seed 에서 서로 다른 용도로 파생한다.
 *    (학생·프로그램의 입력/표시 순서와 무관)
 */
const crypto = require('node:crypto');

const ALGORITHM = 'RANK_FIRST_LOTTERY_V2';
const MAX_PREFS = 3;

/** 학생에게 보여 줄 설명의 근거가 되는 내부 사실 코드 */
const REASON = Object.freeze({
  FULL_BEFORE_STAGE: 'FULL_BEFORE_STAGE', // 앞 지망 단계에서 이미 정원이 채워짐
  LOTTERY_NOT_SELECTED: 'LOTTERY_NOT_SELECTED', // 같은 지망 단계의 정원 경합에서 선발되지 않음
  HELD_FOR_FEASIBILITY: 'HELD_FOR_FEASIBILITY', // 참여 조건을 충족하는 전원 배정을 위해 보류
});

class AllocationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AllocationError';
    this.code = code;
    this.details = details || null;
  }
}

function newSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function keyOf(seed, label) {
  return crypto.createHmac('sha256', Buffer.from(seed, 'hex')).update(label).digest('hex');
}

function byKey(a, b) {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** 학생 내부 ID에 연결된 추첨 우선순서. 입력 배열 순서와 무관하다. */
function deriveStudentOrder(seed, studentIds) {
  return studentIds
    .map((id) => ({ id, key: keyOf(seed, `student-order:${id}`) + ':' + String(id) }))
    .sort(byKey)
    .map((x) => x.id);
}

/** 잔여 자리 섞기. 학생 순서와 다른 용도의 난수 흐름을 쓴다. */
function deriveSlotOrder(seed, programs) {
  const slots = [];
  for (const p of programs) {
    for (let k = 0; k < p.target; k++) {
      slots.push({ programId: p.id, key: keyOf(seed, `remaining-slot:${p.id}:${k}`) + `:${p.id}:${k}` });
    }
  }
  return slots.sort(byKey).map((s) => s.programId);
}

function pairKey(studentId, programId) {
  return `${studentId}|${programId}`;
}

/**
 * 입력 검증. 문제가 있으면 AllocationError 를 던진다.
 * input = {
 *   students: [{ id, prefs: [programId...], noPreference?: boolean }],
 *   programs: [{ id, target, maxCapacity?: number|null }],
 *   forbidden: [[studentId, programId], ...]   // 참여 불가 관계
 * }
 */
function validateInput(input) {
  const { students, programs } = input;
  const forbidden = input.forbidden || [];
  if (!Array.isArray(programs) || programs.length === 0) {
    throw new AllocationError('NO_PROGRAMS', '프로그램이 없습니다.');
  }
  if (!Array.isArray(students) || students.length === 0) {
    throw new AllocationError('NO_STUDENTS', '대상 학생이 없습니다.');
  }
  const programIds = new Set();
  let sum = 0;
  for (const p of programs) {
    if (programIds.has(p.id)) throw new AllocationError('DUPLICATE_PROGRAM', '프로그램이 중복되었습니다.', { programId: p.id });
    programIds.add(p.id);
    if (!Number.isInteger(p.target) || p.target < 1) {
      throw new AllocationError('BAD_TARGET', '프로그램별 배정 인원은 1 이상의 정수여야 합니다.', { programId: p.id });
    }
    if (p.maxCapacity != null) {
      if (!Number.isInteger(p.maxCapacity) || p.maxCapacity < 1) {
        throw new AllocationError('BAD_MAX', '안전상 최대 인원은 1 이상의 정수여야 합니다.', { programId: p.id });
      }
      if (p.target > p.maxCapacity) {
        throw new AllocationError('TARGET_OVER_MAX', '배정 인원이 안전상 최대 인원을 넘습니다.', { programId: p.id });
      }
    }
    sum += p.target;
  }
  if (students.length < programs.length) {
    throw new AllocationError('TOO_FEW_STUDENTS', '대상 학생이 프로그램 수보다 적어 모든 프로그램을 운영할 수 없습니다.');
  }
  if (sum !== students.length) {
    throw new AllocationError('TARGET_SUM_MISMATCH', `배정 인원의 합(${sum})이 대상 학생 수(${students.length})와 같아야 합니다.`, {
      sum,
      students: students.length,
    });
  }
  const forbiddenSet = new Set();
  const studentIds = new Set(students.map((s) => s.id));
  if (studentIds.size !== students.length) throw new AllocationError('DUPLICATE_STUDENT', '학생이 중복되었습니다.');
  for (const [sid, pid] of forbidden) {
    if (!studentIds.has(sid) || !programIds.has(pid)) {
      throw new AllocationError('BAD_RESTRICTION', '참여 제한에 알 수 없는 학생/프로그램이 있습니다.');
    }
    forbiddenSet.add(pairKey(sid, pid));
  }
  for (const s of students) {
    const prefs = s.prefs || [];
    if (!Array.isArray(prefs) || prefs.length > MAX_PREFS) {
      throw new AllocationError('BAD_PREFS', '지망은 최대 3개입니다.', { studentId: s.id });
    }
    if (s.noPreference) {
      if (prefs.length) throw new AllocationError('BAD_PREFS', '무희망 확인 학생에게 지망이 있습니다.', { studentId: s.id });
    } else if (prefs.length === 0) {
      throw new AllocationError('UNRESOLVED', '신청이 확인되지 않은 학생이 있습니다.', { studentId: s.id });
    }
    if (new Set(prefs).size !== prefs.length) {
      throw new AllocationError('BAD_PREFS', '같은 프로그램을 중복 선택했습니다.', { studentId: s.id });
    }
    for (const pid of prefs) {
      if (pid == null || !programIds.has(pid)) {
        throw new AllocationError('BAD_PREFS', '알 수 없는 프로그램을 선택했습니다.', { studentId: s.id });
      }
      if (forbiddenSet.has(pairKey(s.id, pid))) {
        throw new AllocationError('PREF_NOT_ALLOWED', '참여할 수 없는 프로그램이 지망에 포함되어 있어 입력 검토가 필요합니다.', {
          studentId: s.id,
          programId: pid,
        });
      }
    }
  }
  return forbiddenSet;
}

/**
 * 남은 학생 전원을 남은 자리에 배정할 수 있는지(정원을 반영한 이분 매칭).
 * studentIds: 미배정 학생, capacity: Map(programId -> 남은 자리), allowedOf(studentId) -> programId[]
 */
function canCompleteAll(studentIds, capacity, allowedOf) {
  let total = 0;
  for (const c of capacity.values()) total += c;
  if (total !== studentIds.length) return false;
  const members = new Map();
  for (const pid of capacity.keys()) members.set(pid, []);
  const place = (sid, seen) => {
    for (const pid of allowedOf(sid)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const m = members.get(pid);
      if (m.length < capacity.get(pid)) {
        m.push(sid);
        return true;
      }
      for (let i = 0; i < m.length; i++) {
        if (place(m[i], seen)) {
          m[i] = sid;
          return true;
        }
      }
    }
    return false;
  };
  for (const sid of studentIds) {
    if (!place(sid, new Set())) return false;
  }
  return true;
}

/** 설정만으로(신청과 무관하게) 전원 배정이 가능한지 검사한다. 접수 시작 전 점검용. */
function checkFeasibility(input) {
  const forbiddenSet = validateInput({
    ...input,
    students: input.students.map((s) => ({ id: s.id, prefs: [], noPreference: true })),
  });
  const programIds = input.programs.map((p) => p.id);
  const allowedOf = (sid) => programIds.filter((pid) => !forbiddenSet.has(pairKey(sid, pid)));
  const noOption = input.students.filter((s) => allowedOf(s.id).length === 0).map((s) => s.id);
  const capacity = new Map(input.programs.map((p) => [p.id, p.target]));
  const ok = noOption.length === 0 && canCompleteAll(input.students.map((s) => s.id), capacity, allowedOf);
  return { ok, studentsWithoutOption: noOption };
}

/**
 * 순서가 주어진 핵심 배정. (테스트에서 추첨 순서를 직접 지정할 수 있다.)
 * order: 학생 ID 배열(추첨 우선순서), slotOrder: 프로그램 ID 배열(자리 하나당 원소 하나, 섞인 순서)
 */
function allocateWithOrder(input, order, slotOrder) {
  const forbiddenSet = validateInput(input);
  const { students, programs } = input;
  const hasRestrictions = forbiddenSet.size > 0;
  const programIds = programs.map((p) => p.id);
  const allowedCache = new Map();
  const allowedOf = (sid) => {
    let a = allowedCache.get(sid);
    if (!a) {
      a = programIds.filter((pid) => !forbiddenSet.has(pairKey(sid, pid)));
      allowedCache.set(sid, a);
    }
    return a;
  };

  if (order.length !== students.length || new Set(order).size !== students.length) {
    throw new AllocationError('BAD_ORDER', '추첨 순서가 학생 명부와 일치하지 않습니다.');
  }
  const byId = new Map(students.map((s) => [s.id, s]));
  for (const id of order) if (!byId.has(id)) throw new AllocationError('BAD_ORDER', '추첨 순서에 알 수 없는 학생이 있습니다.');

  const remaining = new Map(programs.map((p) => [p.id, p.target]));
  const unassigned = new Set(order);
  const result = new Map(); // studentId -> { programId, stage, trail }
  const trails = new Map(students.map((s) => [s.id, []]));

  const feasibleNow = () => !hasRestrictions || canCompleteAll([...unassigned], remaining, allowedOf);

  if (!feasibleNow()) {
    const noOption = students.filter((s) => allowedOf(s.id).length === 0).map((s) => s.id);
    throw new AllocationError(
      'INFEASIBLE',
      '현재 배정 인원과 참여 제한으로는 학생 전원을 배정할 수 없습니다. 정원이나 참여 제한 설정을 검토해 주세요.',
      { studentsWithoutOption: noOption }
    );
  }

  const tryFix = (sid, pid) => {
    remaining.set(pid, remaining.get(pid) - 1);
    unassigned.delete(sid);
    if (feasibleNow()) return true;
    remaining.set(pid, remaining.get(pid) + 1);
    unassigned.add(sid);
    return false;
  };

  // 1) 지망 단계: 한 단계 전체를 끝낸 뒤 다음 단계로 넘어간다.
  for (let rank = 1; rank <= MAX_PREFS; rank++) {
    const atStageStart = new Map(remaining);
    for (const sid of order) {
      if (!unassigned.has(sid)) continue;
      const pid = (byId.get(sid).prefs || [])[rank - 1];
      if (pid === undefined) continue;
      if (remaining.get(pid) <= 0) {
        trails.get(sid).push({
          rank,
          programId: pid,
          code: atStageStart.get(pid) <= 0 ? REASON.FULL_BEFORE_STAGE : REASON.LOTTERY_NOT_SELECTED,
        });
        continue;
      }
      if (tryFix(sid, pid)) {
        result.set(sid, { programId: pid, stage: String(rank) });
      } else {
        trails.get(sid).push({ rank, programId: pid, code: REASON.HELD_FOR_FEASIBILITY });
      }
    }
  }

  // 2) 잔여 단계: 남은 자리를 섞어 둔 순서대로, 참여 가능하고 전원 배정이 유지되는 첫 자리.
  const quota = new Map(remaining);
  const slots = [];
  for (const pid of slotOrder) {
    const q = quota.get(pid);
    if (q > 0) {
      slots.push(pid);
      quota.set(pid, q - 1);
    }
  }
  if (slots.length !== unassigned.size) {
    throw new AllocationError('INTERNAL', '잔여 자리 수가 미배정 학생 수와 맞지 않습니다.');
  }
  for (const sid of order) {
    if (!unassigned.has(sid)) continue;
    const tried = new Set();
    let placed = false;
    for (let i = 0; i < slots.length; i++) {
      const pid = slots[i];
      if (tried.has(pid)) continue;
      tried.add(pid);
      if (forbiddenSet.has(pairKey(sid, pid))) continue;
      if (tryFix(sid, pid)) {
        slots.splice(i, 1);
        result.set(sid, { programId: pid, stage: 'R' });
        placed = true;
        break;
      }
    }
    if (!placed) {
      // 임의 강제배정 금지: 내부 검증 실패로 중단한다.
      throw new AllocationError('INTERNAL', '잔여 배정 중 배정 가능한 자리를 찾지 못했습니다.');
    }
  }

  const assignments = students.map((s) => ({
    studentId: s.id,
    programId: result.get(s.id).programId,
    stage: result.get(s.id).stage, // '1' | '2' | '3' | 'R'
    noPreference: !!s.noPreference,
    trail: trails.get(s.id),
  }));
  const check = verify(input, assignments);
  if (!check.ok) {
    throw new AllocationError('VERIFY_FAILED', '배정 결과 검증에 실패했습니다.', { checks: check.checks });
  }
  return { algorithm: ALGORITHM, assignments, verification: check };
}

/** 보존된 seed 로 순서를 파생해 배정한다. 같은 입력·seed·버전이면 항상 같은 결과다. */
function allocate(input, seed) {
  if (typeof seed !== 'string' || !/^[0-9a-f]{64}$/.test(seed)) {
    throw new AllocationError('BAD_SEED', '추첨 기준이 올바르지 않습니다.');
  }
  validateInput(input);
  const order = deriveStudentOrder(seed, input.students.map((s) => s.id));
  const slotOrder = deriveSlotOrder(seed, input.programs);
  return allocateWithOrder(input, order, slotOrder);
}

/** 결과 불변조건 검증: 전원 1개, 목표 인원, 참여 조건, 단계 표기의 일치 */
function verify(input, assignments) {
  const checks = [];
  const forbiddenSet = new Set((input.forbidden || []).map(([s, p]) => pairKey(s, p)));
  const programIds = new Set(input.programs.map((p) => p.id));
  const byStudent = new Map();
  let duplicate = 0;
  let unknown = 0;
  for (const a of assignments) {
    if (byStudent.has(a.studentId)) duplicate++;
    byStudent.set(a.studentId, a);
    if (!programIds.has(a.programId)) unknown++;
  }
  const missing = input.students.filter((s) => !byStudent.has(s.id)).length;
  const extra = assignments.length - duplicate - input.students.filter((s) => byStudent.has(s.id)).length;
  checks.push({
    name: 'ALL_ASSIGNED_ONCE',
    label: '학생 전원이 1개 프로그램에 배정됨',
    ok: missing === 0 && duplicate === 0 && unknown === 0 && extra === 0,
    detail: `대상 ${input.students.length}명 · 누락 ${missing} · 중복 ${duplicate}`,
  });
  const counts = new Map(input.programs.map((p) => [p.id, 0]));
  for (const a of assignments) counts.set(a.programId, (counts.get(a.programId) || 0) + 1);
  const off = input.programs.filter((p) => counts.get(p.id) !== p.target).length;
  checks.push({
    name: 'TARGETS_MET',
    label: '모든 프로그램이 정해진 인원을 채움',
    ok: off === 0,
    detail: `프로그램 ${input.programs.length}개 · 불일치 ${off}`,
  });
  const violations = assignments.filter((a) => forbiddenSet.has(pairKey(a.studentId, a.programId))).length;
  checks.push({
    name: 'RESTRICTIONS_RESPECTED',
    label: '참여 제한을 어긴 배정 없음',
    ok: violations === 0,
    detail: `참여 제한 ${forbiddenSet.size}건 · 위반 ${violations}`,
  });
  const students = new Map(input.students.map((s) => [s.id, s]));
  const stageBad = assignments.filter((a) => {
    const s = students.get(a.studentId);
    if (!s) return true;
    if (a.stage === 'R') return false;
    return (s.prefs || [])[Number(a.stage) - 1] !== a.programId;
  }).length;
  checks.push({
    name: 'STAGE_CONSISTENT',
    label: '배정 단계 기록이 제출한 지망과 일치',
    ok: stageBad === 0,
    detail: `불일치 ${stageBad}`,
  });
  return { ok: checks.every((c) => c.ok), checks };
}

/** 명부 수 기준 균등 인원 초안. 안전상 최대 인원을 넘지 않게 나눈다. 불가능하면 null. */
function balancedTargets(studentCount, maxCapacities) {
  const k = maxCapacities.length;
  if (k === 0 || studentCount < k) return null;
  const targets = new Array(k).fill(0);
  let left = studentCount;
  // 한 명씩 가장 적은 프로그램(동률이면 앞 순서)에 더한다. 인원 차이는 가능한 한 1명 이내가 된다.
  while (left > 0) {
    let best = -1;
    for (let i = 0; i < k; i++) {
      const max = maxCapacities[i];
      if (max != null && targets[i] >= max) continue;
      if (best === -1 || targets[i] < targets[best]) best = i;
    }
    if (best === -1) return null;
    targets[best]++;
    left--;
  }
  return targets;
}

module.exports = {
  ALGORITHM,
  MAX_PREFS,
  REASON,
  AllocationError,
  newSeed,
  deriveStudentOrder,
  deriveSlotOrder,
  validateInput,
  canCompleteAll,
  checkFeasibility,
  allocateWithOrder,
  allocate,
  verify,
  balancedTargets,
};
