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
    const label = `${RANK_NAME[t.rank]}(${programName(t.programId)})`;
    if (t.code === REASON.LOTTERY_NOT_SELECTED) {
      lines.push(`${label}은 신청이 정원을 넘어 추첨했고, 이번 추첨에서 선발되지 않았습니다.`);
    } else if (t.code === REASON.FULL_BEFORE_STAGE) {
      lines.push(`${label}은 검토할 때 이미 정원이 마감되어 다음 순서를 검토했습니다.`);
    } else if (t.code === REASON.HELD_FOR_FEASIBILITY) {
      lines.push(`${label}은 안전·참여 조건을 포함한 배정 기준이 적용되어 배정되지 않았습니다. 궁금한 점은 학교 문의처에 확인해 주세요.`);
    }
  }
  if (stage === 'R') {
    lines.push(
      noPreference
        ? '학교에서 희망 없음으로 확인되어, 남은 프로그램에 무작위로 배정되었습니다.'
        : '제출한 희망에 배정되지 않아, 남은 프로그램에 무작위로 배정되었습니다.'
    );
  } else {
    lines.push(`${RANK_NAME[stage]}에 배정되었습니다.`);
  }
  return lines;
}

module.exports = { explain, RANK_NAME };
