'use strict';
/**
 * 학생에게 보여 줄 고정 문구. 엔진이 기록한 사실 코드만으로 만든다.
 * (추측·자유 서술 금지. 엔진 모드가 바뀌면 이 문구도 함께 바꿔야 한다.)
 */
const { REASON } = require('./engine');

const RANK_NAME = { 1: '1지망', 2: '2지망', 3: '3지망' };

function explain({ stage, trail, noPreference }, programName) {
  const lines = [];
  for (const t of trail) {
    const label = `${RANK_NAME[t.rank]} ${programName(t.programId)}`;
    if (t.code === REASON.LOTTERY_NOT_SELECTED) {
      lines.push(`${label} · 추첨 탈락`);
    } else if (t.code === REASON.FULL_BEFORE_STAGE) {
      lines.push(`${label} · 정원 마감`);
    } else if (t.code === REASON.HELD_FOR_FEASIBILITY) {
      lines.push(`${label} · 안전·참여 기준 적용`);
    }
  }
  if (stage === 'R') {
    lines.push(
      noPreference
        ? '희망 없음 · 남은 자리 배정'
        : '남은 자리 배정 (무작위)'
    );
  } else {
    lines.push(`${RANK_NAME[stage]} 배정`);
  }
  return lines;
}

module.exports = { explain, RANK_NAME };
