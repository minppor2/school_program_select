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

const FONT_FILE = path.join(path.dirname(require.resolve('pretendard/package.json')), 'dist', 'public', 'static', 'alternative', 'Pretendard-Regular.ttf');
let cached = null;

/** 트루타입 글꼴에서 필요한 표(글자→글리프, 너비, 윤곽 위치)를 읽는다 */
function loadFont(file = FONT_FILE) {
  if (cached && cached.file === file) return cached;
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
  cached = {
    file, b, tables, unitsPerEm, numGlyphs, advance, loca, gid,
    bbox: [36, 38, 40, 42].map((o) => b.readInt16BE(head + o)), ascent: b.readInt16BE(hhea + 4), descent: b.readInt16BE(hhea + 6),
  };
  return cached;
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
const MARGIN = 48;
const ROW_MAX = 22; // 줄 높이. 한 쪽에 다 들어가지 않으면 ROW_MIN 까지 줄여 한 반이 한 쪽에 나오게 한다
const ROW_MIN = 16.5;
const hex4 = (n) => n.toString(16).padStart(4, '0');
const num = (n) => String(Math.round(n * 100) / 100);

/**
 * doc: { title, by:'class'|'program', draft, rows:[{grade,class,number,name,program,place}] } → PDF 파일(Buffer)
 */
function buildPdf(doc, fontFile) {
  const font = loadFont(fontFile);
  const used = new Map(); // 글리프 → 글자(복사·검색용)
  const glyphs = (text) => [...String(text)].map((ch) => { const g = font.gid(ch.codePointAt(0)); if (g && !used.has(g)) used.set(g, ch); return g; });
  const widthOf = (gs, size) => gs.reduce((a, g) => a + font.advance(g), 0) * size / font.unitsPerEm;
  /** 칸 너비를 넘으면 뒤를 자르고 … 을 붙인다 */
  const fit = (text, size, max) => {
    let s = String(text == null ? '' : text);
    let gs = glyphs(s);
    while (s.length > 1 && widthOf(gs, size) > max) { s = [...s.replace(/…$/, '')].slice(0, -1).join('') + '…'; gs = glyphs(s); }
    return gs;
  };
  const show = (gs, x, y, size) => `BT /F1 ${size} Tf ${num(x)} ${num(y)} Td <${gs.map(hex4).join('')}> Tj ET\n`;

  const W = A4[0] - MARGIN * 2;
  const pages = [];
  const groups = groupRoster(doc.rows, doc.by);
  if (!groups.length) groups.push({ name: '명단 없음', note: '', head: ['이름'], rows: [] });
  for (const g of groups) {
    const weights = g.head.map((h) => (/^(학년|반|번호)$/.test(h) ? 1 : h === '이름' ? 2.2 : 3.4));
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * W);
    const narrow = weights.map((w) => w === 1);
    let s = '', y = 0, part = 0;
    const room = A4[1] - MARGIN * 2 - 44;
    const lines = g.rows.length + 1;
    const ROW = lines * ROW_MAX <= room || lines * ROW_MIN > room ? ROW_MAX : Math.floor((room / lines) * 100) / 100;
    const line = (cells, isHead) => {
      const top = y, bottom = y - ROW;
      if (isHead) s += `0.894 0.953 0.933 rg ${MARGIN} ${num(bottom)} ${num(W)} ${ROW} re f 0 g\n`;
      let x = MARGIN;
      cells.forEach((v, i) => {
        const gs = fit(v, 10.5, widths[i] - 12);
        const tx = narrow[i] || isHead ? x + (widths[i] - widthOf(gs, 10.5)) / 2 : x + 6;
        s += (isHead ? '2 Tr 0.3 w ' : '') + show(gs, tx, bottom + (ROW - 8) / 2, 10.5) + (isHead ? '0 Tr\n' : '');
        x += widths[i];
      });
      s += `0.5 w 0.45 G ${MARGIN} ${num(top)} ${num(W)} ${-ROW} re S\n`;
      x = MARGIN;
      for (let i = 0; i < widths.length - 1; i++) { x += widths[i]; s += `${num(x)} ${num(top)} m ${num(x)} ${num(bottom)} l S\n`; }
      y = bottom;
    };
    const start = () => {
      s = ''; y = A4[1] - MARGIN;
      const title = `${doc.title} · ${g.name}${doc.draft ? ' (미확정)' : ''}${part ? ' (이어서)' : ''}`;
      s += '0 g 0 G 2 Tr 0.45 w ' + show(fit(title, 15, W), MARGIN, y - 15, 15) + '0 Tr\n';
      s += '0.35 g ' + show(fit(`${g.note ? g.note + ' · ' : ''}${g.rows.length}명`, 10, W), MARGIN, y - 33, 10) + '0 g\n';
      y -= 44;
      line(g.head, true);
      part++;
    };
    start();
    for (const r of g.rows) {
      if (y - ROW < MARGIN - 0.01) { pages.push(s); start(); }
      line(r, false);
    }
    pages.push(s);
  }

  // ── 파일 조립 ──
  const fontData = subsetFont(font, used.keys());
  const k = 1000 / font.unitsPerEm;
  const sorted = [...used.keys()].sort((a, b) => a - b);
  const toUni = [...used].map(([g, ch]) => `<${hex4(g)}> <${[...Buffer.from(ch, 'utf16le').swap16()].map((x) => x.toString(16).padStart(2, '0')).join('')}>`);
  const cmapParts = [];
  for (let i = 0; i < toUni.length; i += 100) { const c = toUni.slice(i, i + 100); cmapParts.push(`${c.length} beginbfchar\n${c.join('\n')}\nendbfchar`); }
  const toUnicode = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${cmapParts.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const utf16 = (t) => `<feff${[...Buffer.from(String(t), 'utf16le').swap16()].map((x) => x.toString(16).padStart(2, '0')).join('')}>`;

  const objs = []; // 1번부터
  const add = (dict, stream) => {
    if (stream == null) { objs.push(Buffer.from(`${dict}\n`, 'latin1')); return objs.length; }
    const z = zlib.deflateSync(Buffer.isBuffer(stream) ? stream : Buffer.from(stream, 'latin1'));
    objs.push(Buffer.concat([Buffer.from(`<< ${dict} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, 'latin1'), z, Buffer.from('\nendstream\n', 'latin1')]));
    return objs.length;
  };
  const NAME = 'AAAAAA+Pretendard-Regular';
  const firstPage = 8; // 1 목차, 2 쪽 묶음, 3~7 글꼴, 그 뒤로 쪽마다 (쪽, 내용)
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${firstPage + i * 2} 0 R`).join(' ')}] >>`);
  add(`<< /Type /Font /Subtype /Type0 /BaseFont /${NAME} /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 7 0 R >>`);
  add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${NAME} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 1000 /CIDToGIDMap /Identity /W [${sorted.map((g) => `${g} [${Math.round(font.advance(g) * k)}]`).join(' ')}] >>`);
  add(`<< /Type /FontDescriptor /FontName /${NAME} /Flags 4 /FontBBox [${font.bbox.map((v) => Math.round(v * k)).join(' ')}] /ItalicAngle 0 /Ascent ${Math.round(font.ascent * k)} /Descent ${Math.round(font.descent * k)} /CapHeight ${Math.round(font.ascent * k * 0.75)} /StemV 80 /FontFile2 6 0 R >>`);
  add(`/Length1 ${fontData.length}`, fontData);
  add('', toUnicode);
  pages.forEach((content, i) => {
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPage + i * 2 + 1} 0 R >>`);
    add('', content);
  });
  const info = add(`<< /Title ${utf16(doc.title)} /Producer (school_program_select) >>`);

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
