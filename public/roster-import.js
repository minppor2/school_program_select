/* 명부 가져오기: 엑셀(.xlsx)·CSV·붙여넣은 표를 읽어 "학년, 반, 번호, 이름"으로 맞춘다.
   브라우저(교사 화면)와 Node(테스트) 양쪽에서 같은 코드를 쓴다. 외부 라이브러리 없음.
   여기서 맞춘 결과는 미리 보여 준 뒤 서버로 보내고, 서버는 표준 형식만 엄격하게 다시 검증한다.

   읽는 배치(테스트 roster-import.test.js 에 하나씩 고정):
    A. 칸이 나뉜 표        학년 | 반 | 번호 | 이름  (순서 무관, 다른 칸 섞임, 제목 줄 유무, "1학년"·"01"·"5번" 표기)
    B. 학번 한 칸          10105 · 1105 · 1-1-5 · 1학년 1반 5번  (+ 이름)
    C. 학년/반이 한 칸      "1-3"·"1학년 3반"·"103" | 번호 | 이름
    D. 반/번호가 한 칸      학년 | "3-12" | 이름
    E. 한 칸에 전부         "1학년 1반 5번 김하늘", "10105 김하늘", "5. 김하늘"(반별 표)
    F. 반별 명렬표          제목 줄·시트 이름에서 학년·반 + 번호·이름 칸, 병합 칸(빈칸은 윗줄 값)
    G. 좌우로 나란한 표     번호 | 이름 | 번호 | 이름
    H. 반이 가로로 놓인 표  번호 | 1반 | 2반 | 3반  (칸 안이 이름)
    I. 학년(또는 반)이 아예 없는 파일 → 화면에서 한 번 물어 채운다
   짐작하면 안 되는 값(115, 날짜로 바뀐 학번, 범위를 벗어난 숫자, 중복)은 읽지 않고 줄 번호와 함께 알려 준다. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RosterImport = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const SHEET_MARK = '#시트';
  // 숫자만으로 된 학번(10105 등)을 풀어 읽을 때의 타당 범위. 벗어나면 학번이 아니라고 본다(예: 날짜로 바뀐 값 36896).
  const TIGHT = { grade: 6, class: 30, number: 70 };
  // 칸이 나뉘어 있거나 "학년·반·번"이 적힌 값의 허용 범위.
  const LOOSE = { grade: 12, class: 60, number: 99 };
  const within = (o, lim) => Object.keys(o).every((k) => Number.isInteger(o[k]) && o[k] >= 1 && o[k] <= lim[k]);

  const clean = (v) => String(v == null ? '' : v).normalize('NFKC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  const squash = (v) => clean(v).replace(/\s/g, '');

  /** "1", "01", "1학년", "1반", "5번", "5.0" → 정수. 아니면 null */
  function smallInt(v) {
    const m = squash(v).match(/^제?(\d{1,3})(?:\.0+)?(학년|반|번|번호)?$/);
    return m ? Number(m[1]) : null;
  }

  /**
   * 학번(학년+반+번호) 표기를 읽는다. 읽으면 { grade, class, number }, 못 읽으면 null.
   *  "1학년 1반 5번", "1-1-5", "1.1.5", "1/01/05", "1-1 5번", "10105", "1105", "030105"
   */
  function parseStudentId(value) {
    let s = clean(value).replace(/\.0+$/, '');
    if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, ''); // 10,105
    if (!s) return null;
    let m = s.match(/(?<!\d)(\d{1,2})\s*학년(?!도)\s*(\d{1,2})\s*반\s*(\d{1,3})\s*번?/);
    if (!m) m = s.match(/^(\d{1,2})\s*[-–—./_\s]\s*(\d{1,2})\s*[-–—./_\s]\s*(\d{1,3})\s*번?$/);
    if (m) {
      const o = { grade: +m[1], class: +m[2], number: +m[3] };
      return within(o, LOOSE) ? o : null;
    }
    if (/^\d+$/.test(s)) {
      let o = null;
      if (s.length === 5) o = { grade: +s[0], class: +s.slice(1, 3), number: +s.slice(3) };
      else if (s.length === 4) o = { grade: +s[0], class: +s[1], number: +s.slice(2) };
      else if (s.length === 6) o = { grade: +s.slice(0, 2), class: +s.slice(2, 4), number: +s.slice(4) };
      return o && within(o, TIGHT) ? o : null;
    }
    return null;
  }

  /**
   * 한 칸에서 읽을 수 있는 만큼 읽는다. role 은 그 칸의 역할(grade·class·number·sid).
   * 반환: { grade?, class?, number? } (아무것도 못 읽으면 빈 객체)
   */
  function readCell(value, role) {
    const s = clean(value);
    if (!s) return {};
    const n = smallInt(s);
    if (n !== null && role !== 'sid' && within({ [role]: n }, LOOSE)) return { [role]: n };
    const full = parseStudentId(s);
    if (full) return full;
    let m = s.match(/(?<!\d)(\d{1,2})\s*학년(?!도)\s*(\d{1,2})\s*반/);
    if (m) return keep({ grade: +m[1], class: +m[2] });
    m = s.match(/(?<!\d)(\d{1,2})\s*반\s*(\d{1,3})\s*번?/);
    if (m) return keep({ class: +m[1], number: +m[2] });
    m = s.match(/^(\d{1,2})\s*[-–—./]\s*(\d{1,3})$/); // "1-3": 학년·반 칸이면 학년-반, 번호 칸이면 반-번호
    if (m) return keep(role === 'number' ? { class: +m[1], number: +m[2] } : { grade: +m[1], class: +m[2] });
    if (role === 'class' && /^\d{3}$/.test(s)) return keepTight({ grade: +s[0], class: +s.slice(1) }); // 103 → 1학년 3반
    if (role === 'number' && /^\d{4}$/.test(s)) return keepTight({ class: +s.slice(0, 2), number: +s.slice(2) }); // 0312 → 3반 12번
    m = s.match(/(?<!\d)(\d{1,2})\s*학년(?!도)/);
    if (m) return keep({ grade: +m[1] });
    m = s.match(/^(\d{1,2})\s*반$/);
    if (m) return keep({ class: +m[1] });
    m = s.match(/^(\d{1,2})\s*번$/);
    if (m) return keep({ number: +m[1] });
    if (role === 'sid' && n !== null && n <= TIGHT.number && s.length <= 2) return { number: n }; // 반별 표의 "5"
    return {};
    function keep(o) { return within(o, LOOSE) ? o : {}; }
    function keepTight(o) { return within(o, TIGHT) ? o : {}; }
  }

  const HEAD = {
    name: /^(이름|성명|학생명|학생이름|학생성명|한글성명|한글이름|성명\(한글\)|이름\(한글\)|name)$/i,
    sid: /^(학번|학생번호|학년반번호|학년반번|학년-반-번호|학년\/반\/번호|학년·반·번호|id)$/i,
    grade: /^학년$/,
    class: /^(반|학급|학반|반명|학년반|학년\/반|학년-반|학년·반|학년학급|소속)$/,
    number: /^(번호|번|출석번호|반번호|반\/번호|반-번호|번호\(반\)|no\.?)$/i,
  };
  const NOT_NAME = /(학년|학급|명렬|명단|명부|합계|인원|담임|교사|선생|비고|성별|번호|이름|성명|남자|여자|남학생|여학생|총원|현원|재적)/;
  const FLAG = /(전출|전학|휴학|자퇴|유예|면제|퇴학|제적)/;

  /** "김하늘(전입)", "김하늘*", "김 하 늘" → "김하늘" */
  function cleanName(v) {
    let s = clean(v).replace(/[([{（].*?[)\]}）]/g, ' ').replace(/[*＊#※]+/g, ' ');
    s = clean(s);
    if (/^([가-힣] )+[가-힣]$/.test(s)) s = s.replace(/ /g, '');
    return s;
  }
  function isNameLike(v) {
    const s = cleanName(v);
    return /^[가-힣a-zA-Z][가-힣a-zA-Z·.\- ]{0,28}[가-힣a-zA-Z]\d?$/.test(s) && !NOT_NAME.test(s) && !/^[남여]$/.test(s) && !/^\d/.test(s);
  }

  /**
   * 제목 줄에서 열 위치를 찾는다. 같은 제목이 다시 나오면(번호·이름·번호·이름) 새 묶음으로 나눈다.
   * 반환: [{grade?,class?,number?,sid?,name}, ...] 또는 null
   */
  function headerGroups(cells) {
    const groups = [];
    let cur = {};
    let hits = 0;
    cells.forEach((c, i) => {
      const k = squash(c);
      if (!k) return;
      for (const key of Object.keys(HEAD)) {
        if (!HEAD[key].test(k)) continue;
        if (cur[key] !== undefined) { groups.push(cur); cur = {}; }
        cur[key] = i;
        hits++;
        break;
      }
    });
    groups.push(cur);
    const named = groups.filter((g) => g.name !== undefined);
    if (!named.length) return null;
    if (hits < 2 && cells.filter((c) => clean(c) !== '').length > 3) return null; // 우연히 "이름" 한 단어만 있는 긴 줄
    // 이름이 없는 앞 묶음(학년·반만 있는 칸)은 뒤 묶음들이 함께 쓴다
    const shared = groups.filter((g) => g.name === undefined).reduce((a, g) => Object.assign(a, g), {});
    return named.map((g, i) => (i === 0 ? { ...shared, ...g } : g));
  }

  /** 반이 가로로 놓인 표의 제목 줄: 번호 | 1반 | 2반 …  또는  번호 | 1-1 | 1-2 … */
  function matrixHeader(cells) {
    const classes = [];
    let numberCol;
    cells.forEach((c, i) => {
      const k = squash(c);
      if (HEAD.number.test(k) && numberCol === undefined) { numberCol = i; return; }
      let m = k.match(/^(\d{1,2})반$/);
      if (m) return classes.push({ col: i, class: +m[1] });
      m = k.match(/^(\d{1,2})학년(\d{1,2})반$/) || k.match(/^(\d{1,2})[-–—](\d{1,2})$/);
      if (m) classes.push({ col: i, grade: +m[1], class: +m[2] });
    });
    return classes.length >= 2 ? { classes, numberCol, seen: new Map() } : null;
  }

  /** 제목 줄이 없을 때, 내용을 보고 열 위치를 짐작한다 */
  function inferGroups(rows) {
    const sample = rows.slice(0, 60);
    const width = Math.max(0, ...sample.map((r) => r.length));
    const stat = [];
    for (let i = 0; i < width; i++) {
      const vals = sample.map((r) => clean(r[i])).filter((v) => v !== '');
      const n = Math.max(1, vals.length);
      const ints = vals.map(smallInt);
      stat.push({
        i,
        count: vals.length,
        // 이름 칸은 이름처럼 생겼고 값이 서로 다르다(성별·담임처럼 반복되는 칸과 구분)
        name: (vals.filter(isNameLike).length / n) * (new Set(vals).size / n),
        small: ints.filter((x) => x !== null).length / n,
        sid: vals.filter((v) => smallInt(v) === null && parseStudentId(v)).length / n,
        combo: vals.filter((v) => smallInt(v) === null && !parseStudentId(v) && Object.keys(readCell(v, 'class')).length === 2).length / n,
        serial: ints.length > 2 && ints.every((x, k) => x !== null && (k === 0 || x === ints[k - 1] + 1)),
      });
    }
    const g = {};
    const names = stat.filter((s) => s.count && s.name >= 0.4).sort((a, b) => b.name - a.name || a.i - b.i);
    if (!names.length) return null;
    g.name = names[0].i;
    const sid = stat.find((s) => s.sid >= 0.5 && s.i !== g.name);
    if (sid) { g.sid = sid.i; return [g]; }
    const combo = stat.find((s) => s.combo >= 0.3 && s.i !== g.name);
    let ints = stat.filter((s) => s.small >= 0.5 && s.i !== g.name && (!combo || s.i !== combo.i));
    const want = combo ? 1 : 3;
    while (ints.length > want && ints.some((s) => s.serial)) ints.splice(ints.findIndex((s) => s.serial), 1); // 연번 칸 제외
    ints = ints.slice(-want).map((s) => s.i);
    if (combo) { g.class = combo.i; if (ints.length) g.number = ints[0]; }
    else if (ints.length >= 3) [g.grade, g.class, g.number] = ints;
    else if (ints.length === 2) [g.class, g.number] = ints;
    else if (ints.length === 1) [g.number] = ints;
    return [g];
  }

  /** 한 칸에 "1학년 1반 5번 김하늘", "10105 김하늘", "5. 김하늘"처럼 다 들어 있는 줄을 [학번, 이름]으로 나눈다 */
  function splitFreeText(text) {
    const s = clean(text);
    let m = s.match(/^(\d{1,2})\s*[.)번]\s*([가-힣a-zA-Z].*)$/);
    if (m && isNameLike(m[2])) return [m[1], m[2]];
    m = s.match(/^(.*\d\s*번?)\s*([가-힣]{2,}.*)$/); // 붙여 쓴 "1학년1반5번김하늘"
    const tokens = s.split(' ');
    const nameIdx = tokens.findIndex((t) => isNameLike(t));
    if (nameIdx !== -1 && tokens.length >= 2) {
      // 이름이 여러 낱말이면(응우옌 티 란) 이어진 이름 낱말을 모두 이름으로 본다
      let end = nameIdx;
      while (end + 1 < tokens.length && /^[가-힣a-zA-Z]+$/.test(tokens[end + 1]) && !NOT_NAME.test(tokens[end + 1])) end++;
      const name = tokens.slice(nameIdx, end + 1).join(' ');
      const rest = tokens.filter((_, i) => i < nameIdx || i > end).join(' ');
      if (rest) return [rest, name];
    }
    if (m && isNameLike(m[2])) return [m[1], m[2]];
    return null;
  }

  /**
   * 표(줄 × 칸)를 학생 목록으로 바꾼다.
   * opts.defaultGrade / opts.defaultClass: 파일에 학년(반)이 아예 없을 때 채울 값.
   * 반환: { students, errors:[문장], skipped, need:{grade,class}(없어서 못 읽은 줄 수), flagged(전출·휴학 표시 수), sequential(번호를 순서로 매긴 수) }
   */
  function normalizeRoster(inputRows, opts) {
    const def = { grade: Number(opts && opts.defaultGrade) || null, class: Number(opts && opts.defaultClass) || null };
    let rows = inputRows.map((r) => r.map(clean)).map((cells, i) => ({ line: i + 1, cells })).filter((r) => r.cells.some((c) => c !== ''));
    const body = rows.filter((r) => r.cells[0] !== SHEET_MARK);
    if (body.length && body.every((r) => r.cells.filter((c) => c !== '').length === 1)) {
      rows = rows.map((r) => {
        if (r.cells[0] === SHEET_MARK) return r;
        const text = r.cells.find((c) => c !== '');
        return { line: r.line, cells: splitFreeText(text) || [text] };
      });
      if (rows.some((r) => r.cells.length === 2)) rows = [{ line: 0, cells: ['학번', '이름'] }, ...rows];
    }
    const students = [];
    const errors = [];
    const need = { grade: 0, class: 0 };
    let skipped = 0, flagged = 0, sequential = 0;
    let groups = null, matrix = null, inferred = false;
    const ctx = { grade: null, class: null };
    const setCtx = (text) => {
      const o = readCell(text, 'class');
      if (o.number || (!o.grade && !o.class)) {
        const m = clean(text).match(/^(\d{1,2})\s*[-–—]\s*(\d{1,2})(?:\s*반)?$/);
        if (!m) return false;
        ctx.grade = +m[1]; ctx.class = +m[2];
        return true;
      }
      if (o.grade) ctx.grade = o.grade;
      if (o.class) ctx.class = o.class;
      return true;
    };
    const add = (line, raw, id, name) => {
      const grade = id.grade || ctx.grade || def.grade;
      const cls = id.class || ctx.class || def.class;
      if (id.grade) ctx.grade = id.grade;
      if (id.class) ctx.class = id.class;
      if (!grade || !cls || !id.number) {
        const missing = [!grade && '학년', !cls && '반', !id.number && '번호'].filter(Boolean);
        if (id.number && !grade) need.grade++;
        if (id.number && !cls) need.class++;
        errors.push(`${line}번째 줄 “${raw.slice(0, 40)}” — ${missing.join('·')}을(를) 읽지 못했습니다.`);
        return;
      }
      const s = { grade, class: cls, number: id.number, name: cleanName(name) };
      if (!within({ grade, class: cls, number: id.number }, LOOSE)) {
        errors.push(`${line}번째 줄 “${raw.slice(0, 40)}” — ${grade}학년 ${cls}반 ${id.number}번은 범위를 벗어난 값입니다.`);
        return;
      }
      if (FLAG.test(raw)) flagged++;
      students.push(Object.assign(s, { line }));
    };

    for (let idx = 0; idx < rows.length; idx++) {
      const { line, cells } = rows[idx];
      const joined = cells.filter((c) => c !== '').join(' ');
      if (cells[0] === SHEET_MARK) { // 시트가 바뀌면 열 위치를 다시 찾는다. 시트 이름이 "1-2", "1학년 2반"이면 학년·반으로 쓴다
        groups = null; matrix = null; inferred = false; ctx.grade = null; ctx.class = null;
        setCtx(cells[1] || '');
        continue;
      }
      const mh = matrixHeader(cells);
      if (mh) { matrix = mh; groups = null; continue; }
      const head = headerGroups(cells);
      if (head) { groups = head; matrix = null; inferred = false; continue; }

      if (matrix) { // 반이 가로로 놓인 표: 칸 안이 이름
        let any = false;
        const num = matrix.numberCol !== undefined ? smallInt(cells[matrix.numberCol]) : null;
        for (const c of matrix.classes) {
          const name = cells[c.col] || '';
          if (!isNameLike(name)) continue;
          any = true;
          let number = num;
          if (number === null) { number = (matrix.seen.get(c.col) || 0) + 1; sequential++; }
          matrix.seen.set(c.col, number);
          const before = { ...ctx };
          add(line, `${c.class}반 ${name}`, { grade: c.grade, class: c.class, number }, name);
          ctx.class = before.class; // 가로 표의 반은 다음 칸에 이어지지 않는다
          if (!c.grade) ctx.grade = before.grade;
        }
        if (!any && !setCtx(joined)) skipped++;
        continue;
      }
      if (!groups) {
        const rest = [];
        for (let j = idx; j < rows.length && rows[j].cells[0] !== SHEET_MARK; j++) {
          if (headerGroups(rows[j].cells) || matrixHeader(rows[j].cells)) break;
          rest.push(rows[j].cells);
        }
        groups = inferGroups(rest);
        inferred = true;
      }
      let any = false;
      for (const g of groups || []) {
        const name = cells[g.name] || '';
        const id = {};
        if (g.sid !== undefined) Object.assign(id, readCell(cells[g.sid], 'sid'));
        for (const role of ['grade', 'class', 'number']) if (g[role] !== undefined) Object.assign(id, readCell(cells[g[role]], role));
        // 제목 줄로 "이름" 칸이 정해져 있고 번호도 읽혔으면, 이름 모양이 특이해도(기호·외국어) 빠뜨리지 않는다
        const named = isNameLike(name) || (!inferred && cleanName(name) !== '' && !!id.number && !NOT_NAME.test(name));
        if (!named) continue;
        any = true;
        add(line, joined, id, name);
      }
      if (!any) {
        // 이름이 없는 줄: "1학년 1반 명렬표" 같은 제목이면 학년·반으로 기억하고, 아니면 건너뛴다
        if (!setCtx(joined)) skipped++;
        else if (inferred) groups = null; // 제목 줄 아래 표는 모양이 다를 수 있다
      }
    }

    // 같은 학년·반·번호가 두 번 나오면 둘 다 알려 준다
    const seen = new Map();
    for (const s of students) {
      const key = `${s.grade}-${s.class}-${s.number}`;
      if (seen.has(key)) errors.push(`${s.line}번째 줄 “${s.name}” — ${s.grade}학년 ${s.class}반 ${s.number}번이 ${seen.get(key).line}번째 줄(${seen.get(key).name})과 겹칩니다.`);
      else seen.set(key, s);
    }
    for (const s of students) delete s.line;
    if (!students.length && !errors.length) errors.push('이름을 찾지 못했습니다. 이름이 들어 있는 표인지 확인해 주세요.');
    return { students, errors, skipped, need, flagged, sequential };
  }

  /** 붙여넣은 글·CSV 를 표로 */
  function textToRows(text) {
    const src = String(text || '').replace(/^﻿/, '');
    const first = src.split(/\r?\n/).find((l) => l.trim() !== '') || '';
    const delim = first.includes('\t') ? '\t' : first.includes(',') ? ',' : first.includes(';') ? ';' : first.includes('|') ? '|' : null;
    if (!delim) return src.split(/\r?\n/).map((l) => [l]);
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    row.push(cell); rows.push(row);
    return rows;
  }

  // ───────── xlsx (zip + xml) 읽기 ─────────
  const xmlText = (s) => s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const tTexts = (xml) => { let out = ''; xml.replace(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g, (_, t) => { out += xmlText(t); return ''; }); return out; };
  const attr = (tag, name) => { const m = tag.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"')); return m ? xmlText(m[1]) : null; };

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저에서는 엑셀 파일을 바로 읽을 수 없습니다. 엑셀에서 표를 복사해 붙여넣어 주세요.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('엑셀 파일을 읽지 못했습니다. 파일이 손상되었을 수 있습니다.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = new Map();
    const dec = new TextDecoder('utf-8');
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/i.test(name)) continue;
      total += usize;
      if (total > 60 * 1024 * 1024) throw new Error('파일이 너무 큽니다. 명부 시트만 따로 저장해 주세요.');
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const data = u8.subarray(start, start + csize);
      const raw = method === 0 ? data : method === 8 ? await inflateRaw(data) : null;
      if (!raw) throw new Error('엑셀 파일의 압축 방식을 지원하지 않습니다.');
      files.set(name.toLowerCase(), dec.decode(raw));
    }
    return files;
  }

  function colIndex(ref) {
    let n = 0;
    for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
    return n - 1;
  }

  /** .xlsx 를 표로. 시트마다 맨 앞에 [SHEET_MARK, 시트이름] 줄을 넣는다 */
  async function readXlsx(buffer) {
    const files = await unzip(buffer);
    const wb = files.get('xl/workbook.xml');
    if (!wb) throw new Error('엑셀 통합 문서(.xlsx)가 아닙니다. 엑셀에서 “다른 이름으로 저장 → Excel 통합 문서(.xlsx)”로 저장해 주세요.');
    const shared = [];
    (files.get('xl/sharedstrings.xml') || '').replace(/<(?:\w+:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?si>/g, (_, si) => { shared.push(tTexts(si.replace(/<(?:\w+:)?rPh[\s\S]*?<\/(?:\w+:)?rPh>/g, ''))); return ''; });
    const rels = new Map();
    (files.get('xl/_rels/workbook.xml.rels') || '').replace(/<Relationship\s[^>]*>/g, (tag) => { rels.set(attr(tag, 'Id'), attr(tag, 'Target')); return ''; });
    const sheets = [];
    wb.replace(/<(?:\w+:)?sheet\s[^>]*>/g, (tag) => {
      const target = rels.get(attr(tag, 'r:id')) || '';
      const path = ('xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, '')).toLowerCase();
      sheets.push({ name: attr(tag, 'name') || '', xml: files.get(path) });
      return '';
    });
    if (!sheets.some((s) => s.xml)) [...files.keys()].filter((k) => k.startsWith('xl/worksheets/')).sort().forEach((k, i) => sheets.push({ name: `시트${i + 1}`, xml: files.get(k) }));
    const rows = [];
    for (const sheet of sheets) {
      if (!sheet.xml) continue;
      rows.push([SHEET_MARK, sheet.name]);
      sheet.xml.replace(/<(?:\w+:)?row(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?row>/g, (_, inner) => {
        const cells = [];
        inner.replace(/<(?:\w+:)?c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g, (_m, attrs = '', body = '') => {
          const ref = attr(attrs, 'r');
          const type = attr(attrs, 't');
          const v = (body.match(/<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1];
          let text = '';
          if (type === 's') text = shared[Number(v)] || '';
          else if (type === 'inlineStr') text = tTexts(body);
          else if (v !== undefined) text = xmlText(v);
          const at = ref ? colIndex(ref) : cells.length;
          while (cells.length < at) cells.push('');
          cells[at] = text;
          return '';
        });
        rows.push(cells);
        return '';
      });
    }
    return rows;
  }

  /** 파일 내용(ArrayBuffer)을 표로. 엑셀·CSV·텍스트를 내용으로 구분한다 */
  async function bufferToRows(buffer) {
    const u8 = new Uint8Array(buffer);
    if (u8.length > 8 * 1024 * 1024) throw new Error('파일이 너무 큽니다(8MB 이하). 명부 시트만 따로 저장해 주세요.');
    if (u8[0] === 0x50 && u8[1] === 0x4b) return readXlsx(buffer);
    if (u8[0] === 0xd0 && u8[1] === 0xcf) throw new Error('옛 엑셀(.xls)·한글(.hwp) 파일은 바로 읽을 수 없습니다. 엑셀에서 “다른 이름으로 저장 → Excel 통합 문서(.xlsx)”로 저장하거나, 표를 복사해 붙여넣어 주세요.');
    if (u8[0] === 0x25 && u8[1] === 0x50) throw new Error('PDF는 읽을 수 없습니다. 엑셀 파일을 넣거나 표를 복사해 붙여넣어 주세요.');
    let text;
    if (u8[0] === 0xff && u8[1] === 0xfe) text = new TextDecoder('utf-16le').decode(u8); // 엑셀의 "유니코드 텍스트"
    else if (u8[0] === 0xfe && u8[1] === 0xff) text = new TextDecoder('utf-16be').decode(u8);
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch (e) { text = new TextDecoder('euc-kr').decode(u8); } // 엑셀이 저장한 한글 CSV(CP949)
    }
    return textToRows(text);
  }

  function toCsv(students) {
    const q = (v) => (/[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    return '학년,반,번호,이름\n' + students.map((s) => [s.grade, s.class, s.number, q(s.name)].join(',')).join('\n') + '\n';
  }

  return { SHEET_MARK, parseStudentId, readCell, normalizeRoster, textToRows, readXlsx, bufferToRows, toCsv };
});
