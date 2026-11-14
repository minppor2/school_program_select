/* 엑셀 양식: 내려받을 양식(.xlsx)을 만들고, 작성해 올린 양식을 읽는다.
   시트: [작성 방법] [학생 명단] [프로그램] [설정] [참여 제한]
   브라우저(교사 화면)와 Node(테스트) 양쪽에서 같은 코드를 쓴다. 외부 라이브러리 없음. */
(function (root, factory) {
  const RosterImport = typeof module === 'object' && module.exports ? require('./roster-import') : root.RosterImport;
  const api = factory(RosterImport);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WorkbookForm = api;
})(typeof self !== 'undefined' ? self : globalThis, function (RosterImport) {
  'use strict';

  const SHEETS = { guide: '작성 방법', roster: '학생 명단', programs: '프로그램', settings: '설정', limits: '참여 제한' };
  const clean = (v) => String(v == null ? '' : v).normalize('NFKC').replace(/\s+/g, ' ').trim();
  const squash = (v) => clean(v).replace(/\s/g, '');

  // ───────── xlsx 쓰기 (zip 무압축 + 최소 xml) ─────────
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

  function zipStore(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, text] of entries) {
      const nameBuf = enc.encode(name);
      const data = enc.encode(text);
      const crc = crc32(data);
      const head = new DataView(new ArrayBuffer(30));
      head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true); // UTF-8 이름
      head.setUint16(10, 0, true); head.setUint16(12, 0x21, true); // 시각·날짜(고정값)
      head.setUint32(14, crc, true); head.setUint32(18, data.length, true); head.setUint32(22, data.length, true); head.setUint16(26, nameBuf.length, true);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
      cd.setUint16(14, 0x21, true); cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, nameBuf.length, true); cd.setUint32(42, offset, true);
      parts.push(new Uint8Array(head.buffer), nameBuf, data);
      central.push(new Uint8Array(cd.buffer), nameBuf);
      offset += 30 + nameBuf.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
    let p = 0;
    for (const b of all) { out.set(b, p); p += b.length; }
    return out;
  }

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  // 셀 모양 번호: 0 기본, 1 제목 줄, 2 입력 칸, 3 안내 글, 4 입력 칸(글자로 취급 — 엑셀이 날짜·숫자로 바꾸지 않게)
  const STYLE = { head: 1, input: 2, note: 3, text: 4 };
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const border = '<border><left style="thin"><color rgb="FFD5DEDB"/></left><right style="thin"><color rgb="FFD5DEDB"/></right><top style="thin"><color rgb="FFD5DEDB"/></top><bottom style="thin"><color rgb="FFD5DEDB"/></bottom><diagonal/></border>';
  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}">` +
    '<fonts count="3"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="맑은 고딕"/></font><font><sz val="10"/><color rgb="FF5F6B6D"/><name val="맑은 고딕"/></font></fonts>' +
    '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0A9F76"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0FAF6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>${border}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
    '<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  /**
   * sheets: [{ name, widths:[글자 수...], freeze:고정할 줄 수, rows:[[값 | {v, s}]...] }]
   * 값이 숫자면 숫자 칸, 아니면 글자 칸. s 는 STYLE 번호.
   */
  function buildXlsx(sheets) {
    const sheetXml = (sh) => {
      const rows = sh.rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((cell, ci) => {
        const c = cell !== null && typeof cell === 'object' ? cell : { v: cell };
        const ref = `${colName(ci)}${ri + 1}`;
        const s = c.s ? ` s="${c.s}"` : '';
        if (c.v === '' || c.v == null) return c.s ? `<c r="${ref}"${s}/>` : '';
        if (typeof c.v === 'number' && Number.isFinite(c.v)) return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
      }).join('') + '</row>').join('');
      const pane = sh.freeze ? `<pane ySplit="${sh.freeze}" topLeftCell="A${sh.freeze + 1}" activePane="bottomLeft" state="frozen"/>` : '';
      const cols = sh.widths ? '<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="18"/>${cols}<sheetData>${rows}</sheetData></worksheet>`;
    };
    const entries = [
      ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView activeTab="1"/></bookViews><sheets>` +
        sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', STYLES_XML],
      ...sheets.map((sh, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh)]),
    ];
    return zipStore(entries);
  }

  /**
   * 내려받을 양식. 이미 입력한 명단·프로그램이 있으면 채워서 준다(고쳐서 다시 올릴 수 있게).
   * data: { title, students:[{grade,class,number,name}], programs:[{name,description,place,target,maxCapacity}], contact, deadlineText, limits:[{grade,class,number,name,program}] }
   */
  function buildTemplate(data) {
    const d = data || {};
    const head = (...names) => names.map((v) => ({ v, s: STYLE.head }));
    const pad = (rows, width, min, style) => { const out = rows.slice(); while (out.length < min) out.push(Array.from({ length: width }, () => ({ v: '', s: style }))); return out; };
    const cells = (arr, style) => arr.map((v) => ({ v: v == null ? '' : v, s: style }));
    const students = (d.students || []).map((s) => cells([s.grade, s.class, s.number, s.name], STYLE.input));
    const programs = (d.programs || []).map((p) => cells([p.name, p.description, p.place, p.target, p.maxCapacity], STYLE.input));
    const limits = (d.limits || []).map((r) => cells([r.grade, r.class, r.number, r.name, r.program], STYLE.input));
    const note = (v) => [{ v, s: STYLE.note }];
    return buildXlsx([
      { name: SHEETS.guide, widths: [92], rows: [
        note(`${d.title || '찜콩'} — 엑셀 양식`),
        note('① [학생 명단] 시트에 학년·반·번호·이름을 적습니다.'),
        note('② [프로그램] 시트에 프로그램 이름을 적습니다. 배정 인원을 비워 두면 학생 수에 맞춰 고르게 나눕니다.'),
        note('③ [설정] [참여 제한] 시트는 필요할 때만 적습니다. 참여 제한에는 안전·참여 조건만 적고 사유는 적지 않습니다.'),
        note('④ 저장한 뒤 교사 화면에서 “양식 올리기”를 누르면 한 번에 적용됩니다.'),
        note('시트 이름과 각 시트의 첫 줄(초록색 제목)은 바꾸지 마세요. 줄은 얼마든지 늘려도 됩니다.'),
      ] },
      { name: SHEETS.roster, widths: [8, 8, 8, 18], freeze: 1, rows: [head('학년', '반', '번호', '이름'), ...pad(students, 4, Math.max(40, students.length + 10), STYLE.input)] },
      { name: SHEETS.programs, widths: [20, 36, 24, 12, 12], freeze: 1, rows: [head('프로그램 이름', '설명', '장소·준비물', '배정 인원', '최대 인원'), ...pad(programs, 5, Math.max(12, programs.length + 4), STYLE.input)] },
      { name: SHEETS.settings, widths: [14, 34, 52], freeze: 1, rows: [
        head('항목', '내용', '적는 법'),
        [{ v: '문의처', s: STYLE.input }, { v: d.contact || '', s: STYLE.text }, { v: '예: 체육부 ○○○ 선생님 (2층 교무실)', s: STYLE.note }],
        [{ v: '시작 시각', s: STYLE.input }, { v: d.openText || '', s: STYLE.text }, { v: '예: 2026-11-20 18:00 · 그 시각부터 자동으로 열립니다. 비워 두면 ‘접수 시작’을 누른 즉시 열립니다', s: STYLE.note }],
        [{ v: '마감 시각', s: STYLE.input }, { v: d.deadlineText || '', s: STYLE.text }, { v: '예: 2026-11-20 16:00 · 비워 두면 선생님이 직접 마감합니다', s: STYLE.note }],
      ] },
      { name: SHEETS.limits, widths: [8, 8, 8, 18, 26], freeze: 1, rows: [head('학년', '반', '번호', '이름', '참여할 수 없는 프로그램'), ...pad(limits, 5, Math.max(8, limits.length + 4), STYLE.input)] },
    ]);
  }

  // ───────── 올린 양식 읽기 ─────────
  function splitSheets(rows) {
    const out = [];
    let cur = { name: '', rows: [] };
    for (const r of rows) {
      if (r[0] === RosterImport.SHEET_MARK) { if (cur.rows.length || cur.name) out.push(cur); cur = { name: clean(r[1]), rows: [] }; }
      else cur.rows.push(r);
    }
    out.push(cur);
    return out;
  }

  const toInt = (v) => { const s = clean(v).replace(/\.0+$/, '').replace(/명$/, ''); return /^\d{1,4}$/.test(s) ? Number(s) : null; };

  function readPrograms(rows) {
    const errors = [];
    const programs = [];
    let cols = null;
    rows.forEach((r, i) => {
      const cells = r.map(clean);
      if (!cells.some((c) => c !== '')) return;
      if (!cols) {
        const find = (re, not) => cells.findIndex((c) => re.test(squash(c)) && !(not && not.test(squash(c))));
        const name = find(/(이름|프로그램|동아리|종목|부서|강좌|클럽)/, /(설명|소개|장소|인원|최대)/);
        if (name === -1) return;
        cols = { name, description: find(/(설명|소개|내용|활동)/), place: find(/(장소|준비물)/), target: find(/(배정|인원|정원)/, /(최대|상한|안전)/), max: find(/(최대|상한|안전)/) };
        return;
      }
      const name = cells[cols.name];
      if (!name) return;
      const read = (col, label) => {
        if (col === -1 || !cells[col]) return null;
        const n = toInt(cells[col]);
        if (n === null || n < 1) errors.push(`프로그램 ${i + 1}번째 줄 “${name}” — ${label} “${cells[col]}”은(는) 1 이상의 숫자여야 합니다.`);
        return n;
      };
      programs.push({ name, description: cols.description === -1 ? '' : cells[cols.description] || '', place: cols.place === -1 ? '' : cells[cols.place] || '', target: read(cols.target, '배정 인원'), maxCapacity: read(cols.max, '최대 인원') });
    });
    const seen = new Set();
    for (const p of programs) { if (seen.has(p.name)) errors.push(`프로그램 “${p.name}”이(가) 두 번 적혀 있습니다.`); seen.add(p.name); }
    return { programs, errors };
  }

  /** "2026-11-20 16:00", "2026.11.20 오후 4시", 엑셀 날짜 숫자 → ISO 시각. 못 읽으면 null */
  function readDeadline(value, startOfDay) { // 시각이 없으면 마감은 23:59, 시작은 00:00 으로 본다
    const s = clean(value);
    if (!s) return undefined;
    if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 30000 && Number(s) < 80000) { // 엑셀 날짜 일련번호
      const t = new Date(Math.round((Number(s) - 25569) * 86400000));
      const whole = Number.isInteger(Number(s));
      return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), whole ? (startOfDay ? 0 : 23) : t.getUTCHours(), whole ? (startOfDay ? 0 : 59) : t.getUTCMinutes()).toISOString();
    }
    const m = s.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*[.일]?\s*(?:(오전|오후)?\s*(\d{1,2})\s*(?:[:시]\s*(\d{1,2})?\s*분?)?)?/);
    if (!m) return null;
    let hour = m[5] === undefined ? (startOfDay ? 0 : 23) : Number(m[5]);
    const minute = m[5] === undefined ? (startOfDay ? 0 : 59) : Number(m[6] || 0);
    if (m[4] === '오후' && hour < 12) hour += 12;
    if (m[4] === '오전' && hour === 12) hour = 0;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute);
    return Number.isNaN(d.getTime()) || hour > 23 || minute > 59 ? null : d.toISOString();
  }

  function readSettings(rows) {
    const out = {};
    const errors = [];
    for (const r of rows) {
      const key = squash(r[0]);
      const value = clean(r[1]);
      if (/문의/.test(key) && value) out.contact = value; // 비워 두면 기존 문의처를 그대로 둔다
      if (/시작/.test(key)) {
        const d = readDeadline(value, true);
        if (d === null) errors.push(`설정: 시작 시각 “${value}”을(를) 읽지 못했습니다. 예: 2026-11-20 18:00`);
        else if (d !== undefined) out.openAt = d;
      }
      if (/마감/.test(key)) {
        const d = readDeadline(value);
        if (d === null) errors.push(`설정: 마감 시각 “${value}”을(를) 읽지 못했습니다. 예: 2026-11-20 16:00`);
        else if (d !== undefined) out.deadlineAt = d;
      }
    }
    return { settings: out, errors };
  }

  function readLimits(rows) {
    const errors = [];
    const limits = [];
    let cols = null;
    rows.forEach((r, i) => {
      const cells = r.map(clean);
      if (!cells.some((c) => c !== '')) return;
      if (!cols) {
        const find = (re) => cells.findIndex((c) => re.test(squash(c)));
        const program = find(/(프로그램|참여)/);
        if (program === -1) return;
        cols = { grade: find(/^학년$/), class: find(/^(반|학급)$/), number: find(/^(번호|번)$/), sid: find(/^학번$/), name: find(/^(이름|성명)$/), program };
        return;
      }
      const program = cells[cols.program];
      if (!program) return;
      const id = {};
      if (cols.sid !== -1) Object.assign(id, RosterImport.readCell(cells[cols.sid], 'sid'));
      for (const role of ['grade', 'class', 'number']) if (cols[role] !== -1) Object.assign(id, RosterImport.readCell(cells[cols[role]], role));
      if (!id.grade || !id.class || !id.number) return errors.push(`참여 제한 ${i + 1}번째 줄 — 학년·반·번호를 읽지 못했습니다.`);
      limits.push({ grade: id.grade, class: id.class, number: id.number, name: cols.name === -1 ? '' : cells[cols.name] || '', program });
    });
    return { limits, errors };
  }

  /** 학생 수에 맞춰 고르게 나눈다(최대 인원 이하). 불가능하면 null */
  function balance(count, maxes) {
    const t = maxes.map(() => 0);
    for (let left = count; left > 0; left--) {
      let best = -1;
      maxes.forEach((max, i) => { if ((max == null || t[i] < max) && (best === -1 || t[i] < t[best])) best = i; });
      if (best === -1) return null;
      t[best]++;
    }
    return t;
  }

  /**
   * 올린 파일(표)을 읽는다. currentStudents: 명단 시트가 없을 때 인원 계산에 쓸 현재 학생 수.
   * 반환: { roster|null, programs|null, settings, limits|null, errors:[...], notes:[...] }
   */
  function readForm(rows, currentStudents) {
    const sheets = splitSheets(rows);
    const pick = (re) => sheets.find((s) => re.test(squash(s.name)) && !/작성/.test(s.name));
    const errors = [];
    const notes = [];
    let rosterSheet = pick(/(명단|명부|명렬|학생)/);
    const programSheet = pick(/(프로그램|동아리|종목|부서|강좌|클럽)/);
    const settingSheet = pick(/설정/);
    const limitSheet = pick(/제한/);
    let roster = null;
    if (rosterSheet) roster = RosterImport.normalizeRoster(rosterSheet.rows);
    else if (!programSheet && !settingSheet && !limitSheet) roster = RosterImport.normalizeRoster(rows.filter((r) => !(r[0] === RosterImport.SHEET_MARK && /작성/.test(clean(r[1])))));
    // 빈 양식의 명단 시트(제목 줄만 있음)는 "명단 없음"으로 본다
    if (roster && !roster.students.length && roster.errors.length === 1 && /찾지 못했습니다/.test(roster.errors[0])) roster = null;
    if (roster) errors.push(...roster.errors.map((e) => '명단 ' + e));

    let programs = null;
    if (programSheet) {
      const p = readPrograms(programSheet.rows);
      errors.push(...p.errors);
      if (p.programs.length) {
        programs = p.programs;
        const count = roster ? roster.students.length : Number(currentStudents) || 0;
        const blanks = programs.filter((x) => x.target === null);
        if (blanks.length && !p.errors.length) {
          const fixed = programs.reduce((a, x) => a + (x.target || 0), 0);
          const t = count - fixed >= blanks.length ? balance(count - fixed, blanks.map((x) => x.maxCapacity)) : null;
          if (!t) errors.push(count ? `프로그램: 학생 ${count}명을 배정 인원이 빈 프로그램 ${blanks.length}개에 나눌 수 없습니다. 배정·최대 인원을 확인해 주세요.` : '프로그램: 학생 명단이 없어 배정 인원을 나눌 수 없습니다.');
          else { blanks.forEach((x, i) => { x.target = t[i]; }); notes.push(`배정 인원이 빈 프로그램 ${blanks.length}개는 고르게 나눴습니다.`); }
        }
        const sum = programs.reduce((a, x) => a + (x.target || 0), 0);
        if (count && !errors.length && sum !== count) notes.push(`배정 인원 합계 ${sum}명이 학생 ${count}명과 다릅니다. 적용 후 화면에서 맞춰 주세요.`);
      }
    }
    const st = settingSheet ? readSettings(settingSheet.rows) : { settings: {}, errors: [] };
    errors.push(...st.errors);
    const lm = limitSheet ? readLimits(limitSheet.rows) : { limits: [], errors: [] };
    errors.push(...lm.errors);
    if (!roster && !programs && !Object.keys(st.settings).length && !lm.limits.length && !errors.length) errors.push('적용할 내용이 없습니다. 양식의 [학생 명단]·[프로그램] 시트에 내용을 적어 주세요.');
    return { roster, programs, settings: st.settings, limits: limitSheet ? lm.limits : null, errors, notes };
  }

  return { SHEETS, buildXlsx, buildTemplate, readForm, readPrograms, readDeadline, balance, crc32, zipStore };
});
