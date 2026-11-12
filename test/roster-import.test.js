'use strict';
/* 명부 자동 인식: 학교에서 흔한 여러 표기를 "학년, 반, 번호, 이름"으로 읽는지 확인한다. */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const R = require('../public/roster-import');
const { parseRoster } = require('../src/csv');

const read = (text) => R.normalizeRoster(R.textToRows(text));
const flat = (r) => r.students.map((s) => `${s.grade}-${s.class}-${s.number} ${s.name}`);

test('학번 표기 읽기', () => {
  const p = R.parseStudentId;
  assert.deepEqual(p('1학년 1반 5번'), { grade: 1, class: 1, number: 5 });
  assert.deepEqual(p('3학년12반 27번'), { grade: 3, class: 12, number: 27 });
  assert.deepEqual(p('10105'), { grade: 1, class: 1, number: 5 });
  assert.deepEqual(p('10105.0'), { grade: 1, class: 1, number: 5 });
  assert.deepEqual(p('31227'), { grade: 3, class: 12, number: 27 });
  assert.deepEqual(p('1105'), { grade: 1, class: 1, number: 5 });
  assert.deepEqual(p('1-1-5'), { grade: 1, class: 1, number: 5 });
  assert.deepEqual(p('2.03.14'), { grade: 2, class: 3, number: 14 });
  assert.deepEqual(p('1/1/5'), { grade: 1, class: 1, number: 5 });
  assert.equal(p('3반 5번'), null); // 학년이 없으면 학번 전체는 아니다(칸 단위 읽기에서 반·번호로 쓴다)
  assert.deepEqual(R.readCell('3반 5번', 'number'), { class: 3, number: 5 });
  assert.equal(p('115'), null); // 3자리는 1-1-5 인지 1-15 인지 알 수 없다 → 짐작하지 않는다
  assert.equal(p('10005'), null);
  assert.equal(p('김하늘'), null);
});

test('표준 형식(제목 줄 있음/없음, 탭/쉼표)', () => {
  assert.deepEqual(flat(read('학년,반,번호,이름\n1,1,1,김하나\n1,2,3,이두리')), ['1-1-1 김하나', '1-2-3 이두리']);
  assert.deepEqual(flat(read('1\t1\t1\t김하나\n1\t2\t3\t이두리')), ['1-1-1 김하나', '1-2-3 이두리']);
  assert.deepEqual(flat(read('1학년,1반,5번,김하나\n1학년,2반,03번,이두리')), ['1-1-5 김하나', '1-2-3 이두리']);
});

test('학번 한 칸 + 이름: "1학년 1반 5번", 10105, 1-1-5, 1105', () => {
  assert.deepEqual(flat(read('학번\t이름\n1학년 1반 5번\t김하늘\n1학년 2반 13번\t이지호')), ['1-1-5 김하늘', '1-2-13 이지호']);
  assert.deepEqual(flat(read('10105,김하늘\n10213,이지호\n31227,박보람')), ['1-1-5 김하늘', '1-2-13 이지호', '3-12-27 박보람']);
  assert.deepEqual(flat(read('학번,성명\n1-1-5,김하늘\n1-2-13,이지호')), ['1-1-5 김하늘', '1-2-13 이지호']);
  assert.deepEqual(flat(read('1105\t김하늘\n1213\t이지호')), ['1-1-5 김하늘', '1-2-13 이지호']);
});

test('열 순서가 다르고 다른 칸(성별·비고)이 섞여 있어도 읽는다', () => {
  const r = read('연번,성명,성별,학년,반,번호,비고\n1,김하늘,여,1,1,5,\n2,이지호,남,1,2,13,전입');
  assert.deepEqual(flat(r), ['1-1-5 김하늘', '1-2-13 이지호']);
  assert.deepEqual(flat(read('이름,학번\n김하늘,10105\n이지호,10213')), ['1-1-5 김하늘', '1-2-13 이지호']);
});

test('병합된 칸(빈칸)은 윗줄의 학년·반을 잇는다', () => {
  const r = read('학년,반,번호,이름\n1,1,1,김하나\n,,2,이두리\n,2,1,박세찬\n,,2,최도윤');
  assert.deepEqual(flat(r), ['1-1-1 김하나', '1-1-2 이두리', '1-2-1 박세찬', '1-2-2 최도윤']);
});

test('반별 명렬표: 제목 줄의 학년·반 + 번호·이름 칸', () => {
  const r = read('1학년 2반 명렬표\t\n번호\t이름\n1\t김하나\n2\t이두리\n\n1학년 3반 명렬표\t\n번호\t이름\n1\t박세찬\n계\t1명');
  assert.deepEqual(flat(r), ['1-2-1 김하나', '1-2-2 이두리', '1-3-1 박세찬']);
  assert.equal(r.errors.length, 0);
  assert.equal(r.skipped, 1); // "계 1명" 줄
});

test('한 칸에 다 들어 있는 줄: "1학년 1반 5번 김하늘", "10106 이지호"', () => {
  assert.deepEqual(flat(read('1학년 1반 5번 김하늘\n1학년 1반 6번 이지호')), ['1-1-5 김하늘', '1-1-6 이지호']);
  assert.deepEqual(flat(read('10105 김하늘\n10106 이지호')), ['1-1-5 김하늘', '1-1-6 이지호']);
  assert.deepEqual(flat(read('김하늘 1-1-5\n이지호 1-1-6')), ['1-1-5 김하늘', '1-1-6 이지호']);
});

test('읽지 못한 줄은 짐작하지 않고 알려 준다', () => {
  const r = read('학번,이름\n10105,김하늘\n115,이지호\n,박보람');
  assert.deepEqual(flat(r), ['1-1-5 김하늘']);
  assert.equal(r.errors.length, 2);
  assert.match(r.errors[0], /3번째 줄/);
  assert.match(read('번호,이름\n1,김하늘').errors[0], /학년·반/); // 학년·반을 알 수 없는 표
  assert.match(read('1,2,3\n4,5,6').errors[0], /이름을 찾지 못했습니다/);
});

test('맞춘 결과는 서버의 표준 형식 검증을 그대로 통과한다(이름에 쉼표가 있어도)', () => {
  const r = read('학번\t이름\n10105\t김하늘\n10106\t이지호');
  r.students.push({ grade: 1, class: 1, number: 7, name: 'Kim, Ha' });
  const server = parseRoster(R.toCsv(r.students));
  assert.deepEqual(server.errors, []);
  assert.equal(server.students.length, 3);
  assert.equal(server.students[2].name, 'Kim, Ha');
});

// ── 테스트용 xlsx 만들기(zip: 저장·압축 섞어서) ──
function zip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text, deflate] of entries) {
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(deflate ? 8 : 0, 8);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(deflate ? 8 : 0, 10);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(head, nameBuf, data);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...parts, cdBuf, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}
function xlsx(sheets) {
  const strings = [];
  const si = (t) => { let i = strings.indexOf(t); if (i < 0) i = strings.push(t) - 1; return i; };
  const col = (i) => String.fromCharCode(65 + i);
  const sheetXml = (rows) => '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) => {
      if (v === '' || v == null) return '';
      const ref = `${col(ci)}${ri + 1}`;
      return typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="s"><v>${si(v)}</v></c>`;
    }).join('') + '</row>').join('') + '</sheetData></worksheet>';
  const sheetFiles = sheets.map(([, rows], i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(rows), i % 2 === 0]);
  return zip([
    ['[Content_Types].xml', '<Types/>', false],
    ['xl/workbook.xml', '<workbook xmlns:r="x"><sheets>' + sheets.map(([name], i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>', true],
    ['xl/_rels/workbook.xml.rels', '<Relationships>' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="t" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>', false],
    ...sheetFiles,
    ['xl/sharedStrings.xml', '<sst>' + strings.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t><rPh><t>읽기</t></rPh></si>`).join('') + '</sst>', true],
  ]);
}

test('엑셀(.xlsx) 파일: 한 시트에 학번·이름', async () => {
  const buf = xlsx([['명부', [['학번', '이름', '비고'], [10105, '김하늘', ''], [10213, '이지호', '전입'], ['1학년 3반 7번', '박보람', '']]]]);
  const r = R.normalizeRoster(await R.bufferToRows(buf));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(flat(r), ['1-1-5 김하늘', '1-2-13 이지호', '1-3-7 박보람']);
});

test('엑셀(.xlsx) 파일: 반별 시트("1-1", "1학년 2반")에 번호·이름만 있고 빈 칸이 섞여 있어도 읽는다', async () => {
  const buf = xlsx([
    ['1-1', [['번호', '', '이름'], [1, '', '김하나'], [2, '', '이두리']]],
    ['1학년 2반', [['', '번호', '성명'], ['', 1, '박세찬'], ['', 2, '최도윤 & 친구']]],
  ]);
  const r = R.normalizeRoster(await R.bufferToRows(buf));
  assert.deepEqual(flat(r).slice(0, 3), ['1-1-1 김하나', '1-1-2 이두리', '1-2-1 박세찬']);
  assert.equal(r.students.length + r.errors.length + r.skipped, 4);
});

test('파일 종류: 엑셀이 저장한 한글 CSV(CP949), 옛 .xls·PDF 안내', async () => {
  // "학번,이름\n10105,김하늘" 의 CP949(EUC-KR) 바이트
  const cp949 = Buffer.from([0xc7, 0xd0, 0xb9, 0xf8, 0x2c, 0xc0, 0xcc, 0xb8, 0xa7, 0x0a, 0x31, 0x30, 0x31, 0x30, 0x35, 0x2c, 0xb1, 0xe8, 0xc7, 0xcf, 0xb4, 0xc3]);
  const r = R.normalizeRoster(await R.bufferToRows(cp949.buffer.slice(cp949.byteOffset, cp949.byteOffset + cp949.length)));
  assert.deepEqual(flat(r), ['1-1-5 김하늘']);
  await assert.rejects(R.bufferToRows(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]).buffer), /\.xlsx/);
  await assert.rejects(R.bufferToRows(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer), /PDF/);
  await assert.rejects(R.bufferToRows(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0]).buffer), /읽지 못했습니다/);
});
