'use strict';

/** 따옴표·줄바꿈을 처리하는 CSV/TSV 파서. 붙여넣은 엑셀 표(탭 구분)도 받는다. */
function parseTable(text) {
  let src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = firstLine.includes('\t') ? '\t' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push({ line: rowLine, cells: row });
      row = [];
      cell = '';
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push({ line: rowLine, cells: row });
  }
  return rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
}

/**
 * 명부 표(학년, 반, 번호, 이름) 검증. 오류가 하나라도 있으면 저장하지 않도록 errors 를 돌려준다.
 */
function parseRoster(text) {
  const rows = parseTable(text);
  const errors = [];
  const students = [];
  if (rows.length === 0) return { students, errors: ['내용이 비어 있습니다.'] };
  let start = 0;
  const head = rows[0].cells.map((c) => c.trim());
  if (head[0] === '학년' || /grade/i.test(head[0])) {
    if (head[1] !== '반' || head[2] !== '번호' || head[3] !== '이름') {
      errors.push('첫 줄은 "학년, 반, 번호, 이름" 순서여야 합니다.');
    }
    start = 1;
  }
  const seen = new Map();
  const toInt = (v) => (/^\d{1,3}$/.test(v) ? Number(v) : NaN);
  for (let i = start; i < rows.length; i++) {
    const { line, cells } = rows[i];
    const c = cells.map((x) => x.trim());
    if (c.length < 4 || c.slice(4).some((x) => x !== '')) {
      errors.push(`${line}번째 줄: 칸 수가 맞지 않습니다(학년, 반, 번호, 이름 4칸).`);
      continue;
    }
    const grade = toInt(c[0]);
    const cls = toInt(c[1]);
    const number = toInt(c[2]);
    const name = c[3];
    const bad = [];
    if (!(grade >= 1)) bad.push('학년');
    if (!(cls >= 1)) bad.push('반');
    if (!(number >= 1)) bad.push('번호');
    if (!name) bad.push('이름');
    if (name.length > 40) bad.push('이름(40자 이내)');
    if (bad.length) {
      errors.push(`${line}번째 줄: ${bad.join('·')} 값이 비었거나 형식이 맞지 않습니다.`);
      continue;
    }
    const key = `${grade}-${cls}-${number}`;
    if (seen.has(key)) {
      errors.push(`${line}번째 줄: ${grade}학년 ${cls}반 ${number}번이 ${seen.get(key)}번째 줄과 중복됩니다.`);
      continue;
    }
    seen.set(key, line);
    students.push({ grade, class: cls, number, name });
  }
  if (!errors.length && students.length === 0) errors.push('학생이 한 명도 없습니다.');
  if (students.length > 3000) errors.push('한 모집에 등록할 수 있는 학생은 3,000명까지입니다.');
  return { students, errors };
}

/** 엑셀/CSV 수식 주입 방지 + 따옴표·줄바꿈 처리 */
function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { parseTable, parseRoster, csvCell, toCsv };
