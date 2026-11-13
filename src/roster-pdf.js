'use strict';
/**
 * 명단 PDF 를 직접 만든다(인쇄 창을 거치지 않는다).
 * 글꼴(Pretendard, OFL)은 쓰인 글자만 추려 파일 안에 넣으므로 어느 기기에서 열어도 한글이 그대로 보인다.
 * 묶음(반 또는 프로그램)마다 새 쪽에서 시작하고, 표가 길면 다음 쪽에 머리줄을 다시 그린다.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { groupRoster } = require('../public/roster-export');

const FONT_DIR = path.join(path.dirname(require.resolve('pretendard/package.json')), 'dist', 'public', 'static', 'alternative');
const FONT_REGULAR = path.join(FONT_DIR, 'Pretendard-Regular.ttf');
const FONT_BOLD = path.join(FONT_DIR, 'Pretendard-Bold.ttf');
const cache = new Map();

/** 트루타입 글꼴에서 필요한 표(글자→글리프, 너비, 윤곽 위치)를 읽는다 */
function loadFont(file = FONT_REGULAR) {
  if (cache.has(file)) return cache.get(file);
  const b = fs.readFileSync(file);
  const tables = {};
  for (let i = 0, n = b.readUInt16BE(4); i < n; i++) {
    const o = 12 + i * 16;
    tables[b.toString('latin1', o, o + 4)] = { off: b.readUInt32BE(o + 8), len: b.readUInt32BE(o + 12) };
  }
  const head = tables.head.off, hhea = tables.hhea.off, hmtx = tables.hmtx.off;
  const unitsPerEm = b.readUInt16BE(head + 18);
  const longLoca = b.readInt16BE(head + 50) === 1;
  const numGlyphs = b.readUInt16BE(tables.maxp.off + 4);
  const nHM = b.readUInt16BE(hhea + 34);
  const advance = (g) => b.readUInt16BE(hmtx + Math.min(g, nHM - 1) * 4);
  const loca = (g) => (longLoca ? b.readUInt32BE(tables.loca.off + g * 4) : b.readUInt16BE(tables.loca.off + g * 2) * 2);

  // cmap: 유니코드 전체(형식 12)를 먼저, 없으면 기본 평면(형식 4)
  const cmap = tables.cmap.off;
  let f12 = null, f4 = null;
  for (let i = 0, n = b.readUInt16BE(cmap + 2); i < n; i++) {
    const o = cmap + 4 + i * 8;
    const sub = cmap + b.readUInt32BE(o + 4);
    const format = b.readUInt16BE(sub);
    if (format === 12) f12 = sub; else if (format === 4) f4 = sub;
  }
  const memo = new Map();
  const lookup = (cp) => {
    if (f12 != null) {
      let lo = 0, hi = b.readUInt32BE(f12 + 12) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, g = f12 + 16 + mid * 12;
        const start = b.readUInt32BE(g), end = b.readUInt32BE(g + 4);
        if (cp < start) hi = mid - 1; else if (cp > end) lo = mid + 1; else return b.readUInt32BE(g + 8) + (cp - start);
      }
      return 0;
    }
    if (f4 == null || cp > 0xffff) return 0;
    const segX2 = b.readUInt16BE(f4 + 6);
    for (let i = 0; i < segX2; i += 2) {
      const end = b.readUInt16BE(f4 + 14 + i);
      if (cp > end) continue;
      const start = b.readUInt16BE(f4 + 16 + segX2 + i);
      if (cp < start) return 0;
      const delta = b.readUInt16BE(f4 + 16 + 2 * segX2 + i);
      const roPos = f4 + 16 + 3 * segX2 + i, ro = b.readUInt16BE(roPos);
      if (!ro) return (cp + delta) & 0xffff;
      const g = b.readUInt16BE(roPos + ro + 2 * (cp - start));
      return g ? (g + delta) & 0xffff : 0;
    }
    return 0;
  };
  const gid = (cp) => { if (!memo.has(cp)) memo.set(cp, lookup(cp)); return memo.get(cp); };
  const font = {
    file, b, tables, unitsPerEm, numGlyphs, advance, loca, gid,
    bbox: [36, 38, 40, 42].map((o) => b.readInt16BE(head + o)), ascent: b.readInt16BE(hhea + 4), descent: b.readInt16BE(hhea + 6),
  };
  cache.set(file, font);
  return font;
}

/** 쓰인 글리프만 남긴 글꼴 파일을 만든다. 글리프 번호는 그대로 둔다(나머지는 빈 윤곽). */
function subsetFont(font, used) {
  const { b, tables, numGlyphs, loca } = font;
  const glyf = tables.glyf.off;
  const need = new Set([0, ...used]);
  for (const g of [...need]) { // 합성 글리프가 가리키는 부품도 넣는다
    const stack = [g];
    while (stack.length) {
      const x = stack.pop();
      const off = loca(x), end = loca(x + 1);
      if (end <= off || b.readInt16BE(glyf + off) >= 0) continue;
      let p = glyf + off + 10, flags;
      do {
        flags = b.readUInt16BE(p);
        const part = b.readUInt16BE(p + 2);
        if (!need.has(part)) { need.add(part); stack.push(part); }
        p += 4 + (flags & 1 ? 4 : 2);
        if (flags & 8) p += 2; else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8;
      } while (flags & 0x20);
    }
  }
  const newLoca = Buffer.alloc((numGlyphs + 1) * 4);
  const chunks = [];
  let pos = 0;
  for (let g = 0; g < numGlyphs; g++) {
    newLoca.writeUInt32BE(pos, g * 4);
    if (!need.has(g)) continue;
    const off = loca(g), end = loca(g + 1);
    if (end <= off) continue;
    const pad = (4 - ((end - off) % 4)) % 4;
    chunks.push(b.subarray(glyf + off, glyf + end));
    if (pad) chunks.push(Buffer.alloc(pad));
    pos += end - off + pad;
  }
  newLoca.writeUInt32BE(pos, numGlyphs * 4);
  const head = Buffer.from(b.subarray(tables.head.off, tables.head.off + tables.head.len));
  head.writeUInt32BE(0, 8); // checkSumAdjustment 는 맨 끝에 다시 적는다
  head.writeInt16BE(1, 50); // loca 를 긴 형식으로
  const out = { head, loca: newLoca, glyf: Buffer.concat(chunks) };
  for (const tag of ['hhea', 'maxp', 'hmtx', 'cvt ', 'fpgm', 'prep']) if (tables[tag]) out[tag] = b.subarray(tables[tag].off, tables[tag].off + tables[tag].len);

  const tags = Object.keys(out).sort();
  const sum = (buf) => { let s = 0; for (let i = 0; i + 4 <= buf.length; i += 4) s = (s + buf.readUInt32BE(i)) >>> 0; return s; };
  const pad4 = (buf) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf);
  const n = tags.length, pow = 2 ** Math.floor(Math.log2(n));
  const dir = Buffer.alloc(12 + n * 16);
  dir.writeUInt32BE(0x00010000, 0); dir.writeUInt16BE(n, 4); dir.writeUInt16BE(pow * 16, 6); dir.writeUInt16BE(Math.log2(pow), 8); dir.writeUInt16BE(n * 16 - pow * 16, 10);
  const body = [];
  let at = dir.length, headAt = 0;
  tags.forEach((tag, i) => {
    const data = pad4(out[tag]);
    const o = 12 + i * 16;
    dir.write(tag, o, 'latin1'); dir.writeUInt32BE(sum(data), o + 4); dir.writeUInt32BE(at, o + 8); dir.writeUInt32BE(out[tag].length, o + 12);
    if (tag === 'head') headAt = at;
    body.push(data); at += data.length;
  });
  const file = Buffer.concat([dir, ...body]);
  file.writeUInt32BE((0xb1b0afba - sum(file)) >>> 0, headAt + 8);
  return file;
}

const A4 = [595.28, 841.89];
const MARGIN = 44;
const HEADER = 80; // 위쪽 색 띠
const GAP = 12;
const HEAD_ROW = 24; // 표 머리줄
const FOOTER = 18;
const ROW_MAX = 26; // 줄 높이. 한 쪽에 다 들어가지 않으면 ROW_MIN 까지 줄여 한 반이 한 쪽에 나오게 한다
const ROW_MIN = 16;
const hex4 = (n) => n.toString(16).padStart(4, '0');
const num = (n) => String(Math.round(n * 100) / 100);
const rgb = (hex) => [1, 3, 5].map((i) => num(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');

const BRAND = rgb('#0a9f76'), BRAND_DARK = rgb('#087a5b'), BRAND_PALE = rgb('#d3f3e7'), TINT = rgb('#f1faf6');
const INK = rgb('#1b2025'), GRAY = rgb('#6b737b'), WHITE = '1 1 1';
/** 프로그램마다 다른 파스텔 꼬리표(바탕, 글자). 흑백으로 뽑아도 글자는 진하게 남는다 */
const PILLS = [
  ['#e4f6ef', '#0b6b50'], ['#e3effd', '#1c4f8f'], ['#fff3d1', '#7a5600'], ['#fde7ee', '#9a2b52'], ['#eee8fc', '#5236a3'],
  ['#ffe9d9', '#9a4a12'], ['#dff5f9', '#0f6170'], ['#ecf6d8', '#4b6a12'], ['#eef0f2', '#3d444b'],
].map((p) => p.map(rgb));

/** 모서리가 둥근 네모 길 */
function rrect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const k = r * 0.5523, n = num;
  return `${n(x + r)} ${n(y)} m ${n(x + w - r)} ${n(y)} l ${n(x + w - r + k)} ${n(y)} ${n(x + w)} ${n(y + r - k)} ${n(x + w)} ${n(y + r)} c `
    + `${n(x + w)} ${n(y + h - r)} l ${n(x + w)} ${n(y + h - r + k)} ${n(x + w - r + k)} ${n(y + h)} ${n(x + w - r)} ${n(y + h)} c `
    + `${n(x + r)} ${n(y + h)} l ${n(x + r - k)} ${n(y + h)} ${n(x)} ${n(y + h - r + k)} ${n(x)} ${n(y + h - r)} c `
    + `${n(x)} ${n(y + r)} l ${n(x)} ${n(y + r - k)} ${n(x + r - k)} ${n(y)} ${n(x + r)} ${n(y)} c h`;
}

/**
 * doc: { title, school, by:'class'|'program', draft, rows:[{grade,class,number,name,program,place}] } → PDF 파일(Buffer)
 * 교실에 붙여 두는 용도라 묶음 이름을 크게, 프로그램은 색 꼬리표로 보여 준다.
 */
function buildPdf(doc) {
  const fonts = [FONT_REGULAR, FONT_BOLD].map((file) => ({ font: loadFont(file), used: new Map() })); // used: 글리프 → 글자(복사·검색용)
  const glyphs = (text, f) => [...String(text)].map((ch) => {
    const g = fonts[f].font.gid(ch.codePointAt(0));
    if (g && !fonts[f].used.has(g)) fonts[f].used.set(g, ch);
    return g;
  });
  const widthOf = (gs, size, f) => gs.reduce((a, g) => a + fonts[f].font.advance(g), 0) * size / fonts[f].font.unitsPerEm;
  /** 너비를 넘으면 뒤를 자르고 … 을 붙인다 */
  const fit = (text, size, max, f) => {
    let s = String(text == null ? '' : text);
    let gs = glyphs(s, f);
    while (s.length > 1 && widthOf(gs, size, f) > max) { s = [...s.replace(/…$/, '')].slice(0, -1).join('') + '…'; gs = glyphs(s, f); }
    return gs;
  };
  /** 글 한 줄. o: { bold, color, max, align:'center'|'right' } → { s: 그리는 명령, w: 너비 } */
  const text = (t, x, y, size, o = {}) => {
    const f = o.bold ? 1 : 0;
    const gs = fit(t, size, o.max == null ? 1e9 : o.max, f);
    const w = widthOf(gs, size, f);
    const tx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
    return { w, s: `${o.color || INK} rg BT /F${f + 1} ${num(size)} Tf ${num(tx)} ${num(y)} Td <${gs.map(hex4).join('')}> Tj ET\n` };
  };
  const fill = (color, path) => `${color} rg ${path} f\n`;

  const W = A4[0] - MARGIN * 2;
  const programs = [...new Set(doc.rows.map((r) => r.program))].sort((a, b) => String(a).localeCompare(String(b), 'ko'));
  const pillOf = (name) => PILLS[Math.max(0, programs.indexOf(name)) % PILLS.length];
  const subtitle = `${doc.school ? doc.school + ' · ' : ''}${doc.title}`;
  const pages = [];
  const groups = groupRoster(doc.rows, doc.by);
  if (!groups.length) groups.push({ name: '명단 없음', note: '', head: ['이름'], rows: [] });

  for (const g of groups) {
    // 칸 너비: 학년·반·번호는 좁게, 마지막 칸이 남은 자리를 채운다
    const kind = g.head.map((h) => (/^(학년|반|번호)$/.test(h) ? 'narrow' : h === '이름' ? 'name' : h === '배정 프로그램' ? 'program' : 'note'));
    const base = { narrow: doc.by === 'class' ? 58 : W * 0.18, name: 124, program: 176, note: 120 };
    const widths = kind.map((k) => base[k]);
    widths[widths.length - 1] = W - widths.slice(0, -1).reduce((a, b) => a + b, 0);

    const room = A4[1] - MARGIN * 2 - HEADER - GAP - HEAD_ROW - FOOTER - 4;
    const n = Math.max(1, g.rows.length);
    const ROW = n * ROW_MAX <= room ? ROW_MAX : n * ROW_MIN > room ? 20 : Math.floor((room / n) * 100) / 100;
    const size = Math.max(9.5, Math.min(12, ROW * 0.47));
    let s = '', y = 0, part = 0, count = 0;

    const start = () => {
      s = '';
      const top = A4[1] - MARGIN;
      s += fill(BRAND, rrect(MARGIN, top - HEADER, W, HEADER, 14));
      // 오른쪽: 인원(흰 알약), 미확정·이어서 표시
      let right = MARGIN + W - 18;
      const badge = (label, bg, fg) => {
        const w = text(label, 0, 0, 12.5, { bold: true }).w + 24;
        right -= w;
        s += fill(bg, rrect(right, top - HEADER / 2 - 14, w, 28, 14));
        s += text(label, right + w / 2, top - HEADER / 2 - 4.5, 12.5, { bold: true, color: fg, align: 'center' }).s;
        right -= 8;
      };
      badge(`${g.rows.length}명`, WHITE, BRAND_DARK);
      if (doc.draft) badge('미확정', rgb('#fff3d1'), rgb('#7a5600'));
      if (part) badge('이어서', BRAND_PALE, BRAND_DARK);
      const max = right - MARGIN - 22;
      const up = g.note ? 6 : 0;
      s += text(subtitle, MARGIN + 20, top - 28 + up, 10.5, { color: BRAND_PALE, max }).s;
      s += text(g.name, MARGIN + 20, top - 58 + up, 25, { bold: true, color: WHITE, max }).s;
      if (g.note) s += text(g.note, MARGIN + 20, top - 70, 10.5, { color: WHITE, max }).s;

      y = top - HEADER - GAP;
      let x = MARGIN;
      g.head.forEach((h, i) => {
        const o = { bold: true, color: GRAY };
        s += (kind[i] === 'narrow' ? text(h, x + widths[i] / 2, y - 16, 9, { ...o, align: 'center' }) : text(h, x + 12, y - 16, 9, o)).s;
        x += widths[i];
      });
      y -= HEAD_ROW;
      s += `${BRAND} RG 1.2 w ${MARGIN} ${num(y)} m ${num(MARGIN + W)} ${num(y)} l S\n`;
      y -= 3;
      part++;
    };
    const line = (cells) => {
      const bottom = y - ROW;
      const mid = bottom + (ROW - size * 0.72) / 2;
      if (count++ % 2) s += fill(TINT, rrect(MARGIN, bottom, W, ROW, 5));
      let x = MARGIN;
      cells.forEach((v, i) => {
        const w = widths[i];
        if (kind[i] === 'narrow') s += text(v, x + w / 2, mid, size, { align: 'center' }).s;
        else if (kind[i] === 'name') s += text(v, x + 12, mid, size, { bold: true, max: w - 18 }).s;
        else if (kind[i] === 'program' && v) {
          const [bg, fg] = pillOf(v);
          const t = text(v, x + 20, mid + 0.4, size - 1, { bold: true, color: fg, max: w - 34 });
          const h = Math.min(ROW - 5, size + 9);
          s += fill(bg, rrect(x + 10, bottom + (ROW - h) / 2, t.w + 20, h, h / 2)) + t.s;
        } else s += text(v, x + 12, mid + 0.4, size - 1, { color: GRAY, max: w - 18 }).s;
        x += w;
      });
      y = bottom;
    };
    start();
    for (const r of g.rows) {
      if (y - ROW < MARGIN + FOOTER - 0.01) { pages.push(s); start(); }
      line(r);
    }
    if (!g.rows.length) s += text('배정된 학생이 없습니다', MARGIN + W / 2, y - 30, 11, { color: GRAY, align: 'center' }).s;
    pages.push(s);
  }
  // 바닥글: 왼쪽에 모집 이름, 오른쪽에 쪽 번호
  pages.forEach((p, i) => {
    pages[i] = p
      + text(`${subtitle}${doc.draft ? ' · 공개 전 미확정 명단' : ''}`, MARGIN + 2, MARGIN - 6, 8.5, { color: GRAY, max: W - 60 }).s
      + text(`${i + 1} / ${pages.length}`, MARGIN + W - 2, MARGIN - 6, 8.5, { color: GRAY, align: 'right' }).s;
  });

  // ── 파일 조립 ──
  const utf16hex = (t) => [...Buffer.from(String(t), 'utf16le').swap16()].map((x) => x.toString(16).padStart(2, '0')).join('');
  const objs = []; // 1번부터
  const add = (dict, stream) => {
    if (stream == null) { objs.push(Buffer.from(`${dict}\n`, 'latin1')); return objs.length; }
    const z = zlib.deflateSync(Buffer.isBuffer(stream) ? stream : Buffer.from(stream, 'latin1'));
    objs.push(Buffer.concat([Buffer.from(`<< ${dict} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream\n', 'latin1')]));
    return objs.length;
  };
  const firstPage = 3 + fonts.length * 5; // 1 목차, 2 쪽 묶음, 글꼴마다 5개, 그 뒤로 쪽마다 (쪽, 내용)
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(' ')}] >>`);
  fonts.forEach(({ font, used }, f) => {
    const o = 3 + f * 5;
    const name = `AAAAA${'AB'[f]}+Pretendard-${f ? 'Bold' : 'Regular'}`;
    const k = 1000 / font.unitsPerEm;
    const sorted = [...used.keys()].sort((a, b) => a - b);
    const toUni = [...used].map(([g, ch]) => `<${hex4(g)}> <${utf16hex(ch)}>`);
    const cmapParts = [];
    for (let i = 0; i < toUni.length; i += 100) { const c = toUni.slice(i, i + 100); cmapParts.push(`${c.length} beginbfchar\n${c.join('\n')}\nendbfchar`); }
    const toUnicode = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${cmapParts.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
    const fontData = subsetFont(font, used.keys());
    add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${o + 1} 0 R] /ToUnicode ${o + 4} 0 R >>`);
    add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${o + 2} 0 R /DW 1000 /CIDToGIDMap /Identity /W [${sorted.map((g) => `${g} [${Math.round(font.advance(g) * k)}]`).join(' ')}] >>`);
    add(`<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [${font.bbox.map((v) => Math.round(v * k)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(font.ascent * k)} /Descent ${Math.round(font.descent * k)} /CapHeight ${Math.round(font.ascent * k * 0.75)} /StemV ${f ? 140 : 80} /FontFile2 ${o + 3} 0 R >>`);
    add(`/Length1 ${fontData.length}`, fontData);
    add('', toUnicode);
  });
  const fontRefs = fonts.map((_, f) => `/F${f + 1} ${3 + f * 5} 0 R`).join(' ');
  pages.forEach((content, i) => {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Resources << /Font << ${fontRefs} >> >> /Contents ${firstPage + i * 2 + 1} 0 R >>`);
    add('', content);
  });
  const info = add(`<< /Title <feff${utf16hex(doc.title)}> /Producer (school_program_select) >>`);

  const parts = [Buffer.from('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets = [];
  let at = parts[0].length;
  objs.forEach((o, i) => {
    const full = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('endobj\n', 'latin1')]);
    offsets.push(at); parts.push(full); at += full.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

module.exports = { buildPdf, subsetFont, loadFont };
