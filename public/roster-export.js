/* 배정 명단 내보내기: 반별·프로그램별로 묶어 엑셀(.xlsx) · 한글(.hwp) · 인쇄(PDF) 문서를 만든다. 브라우저와 Node(시험) 양쪽에서 쓴다. */
(function (root) {
  'use strict';
  const WorkbookForm = typeof module === 'object' && module.exports ? require('./workbook-form') : root.WorkbookForm;

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /**
   * rows: [{grade, class, number, name, program, place}] (이미 정렬되어 있음)
   * by: 'class' | 'program'
   * → [{ name, note, head:[...], rows:[[...]] }]  묶음 하나가 표 하나(엑셀 시트 하나, 인쇄 한 쪽)
   */
  function groupRoster(rows, by) {
    const groups = [];
    const index = new Map();
    for (const r of rows) {
      const key = by === 'class' ? `${r.grade}-${r.class}` : r.program;
      let g = index.get(key);
      if (!g) {
        g = by === 'class'
          ? { name: `${r.grade}학년 ${r.class}반`, note: '', head: ['번호', '이름', '배정 프로그램', '장소/준비물'], rows: [] }
          : { name: r.program, note: r.place || '', head: ['학년', '반', '번호', '이름'], rows: [] };
        index.set(key, g); groups.push(g);
      }
      g.rows.push(by === 'class' ? [r.number, r.name, r.program, r.place || ''] : [r.grade, r.class, r.number, r.name]);
    }
    return groups;
  }

  /** 엑셀 시트 이름: 31자 이하, 금지 문자 제거, 겹치지 않게 */
  function sheetNames(names) {
    const used = new Set();
    return names.map((raw) => {
      const base = String(raw).replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 28) || '명단';
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base} ${i}`;
      used.add(name);
      return name;
    });
  }

  /** 첫 시트는 전체, 그다음부터 묶음(반 또는 프로그램)마다 시트 하나 */
  function buildXlsx(doc) {
    const head = (names) => names.map((v) => ({ v, s: 1 }));
    const body = (cells) => cells.map((v) => ({ v, s: 2 }));
    const by = doc.by === 'class';
    const allHead = by ? ['학년', '반', '번호', '이름', '배정 프로그램', '장소/준비물'] : ['배정 프로그램', '장소/준비물', '학년', '반', '번호', '이름'];
    const allRows = doc.rows.map((r) => body(by ? [r.grade, r.class, r.number, r.name, r.program, r.place || ''] : [r.program, r.place || '', r.grade, r.class, r.number, r.name]));
    const groups = groupRoster(doc.rows, doc.by);
    const names = sheetNames(['전체', ...groups.map((g) => g.name)]);
    const sheets = [
      { name: names[0], freeze: 1, widths: by ? [7, 7, 7, 14, 22, 26] : [22, 26, 7, 7, 7, 14], rows: [head(allHead), ...allRows] },
      ...groups.map((g, i) => ({
        name: names[i + 1], freeze: 2, widths: by ? [8, 14, 22, 26] : [8, 8, 8, 16],
        rows: [[{ v: `${doc.title} · ${g.name}${g.note ? ` (${g.note})` : ''} · ${g.rows.length}명${doc.draft ? ' · 미확정' : ''}`, s: 3 }], head(g.head), ...g.rows.map(body)],
      })),
    ];
    return WorkbookForm.buildXlsx(sheets);
  }

  /**
   * 한글(한컴오피스)에서 열리는 문서. 표가 든 HTML 문서를 .hwp 이름으로 저장한다(한글이 내용을 보고 변환해 연다).
   * 묶음마다 새 쪽에서 시작한다.
   */
  function buildHwpHtml(doc) {
    const groups = groupRoster(doc.rows, doc.by);
    const td = 'border:1px solid #000;padding:4px 8px;font-size:11pt;';
    const tables = groups.map((g, i) =>
      `<h2 style="font-size:15pt;margin:0 0 6px;${i ? 'page-break-before:always;' : ''}">${esc(doc.title)} · ${esc(g.name)}${doc.draft ? ' (미확정)' : ''}</h2>` +
      `<p style="font-size:10pt;margin:0 0 8px;">${g.note ? esc(g.note) + ' · ' : ''}${g.rows.length}명</p>` +
      '<table border="1" cellspacing="0" cellpadding="4" width="100%" style="border-collapse:collapse;width:100%;">' +
      '<tr>' + g.head.map((h) => `<th style="${td}background:#e8f3ef;text-align:center;">${esc(h)}</th>`).join('') + '</tr>' +
      g.rows.map((r) => '<tr>' + r.map((v, ci) => `<td style="${td}${typeof v === 'number' ? 'text-align:center;' : ''}">${esc(v)}</td>`).join('') + '</tr>').join('') +
      '</table>').join('\n');
    return '﻿<!DOCTYPE html><html lang="ko"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><title>' + esc(doc.title) + '</title></head>' +
      '<body style="font-family:\'함초롬바탕\',\'맑은 고딕\',sans-serif;">\n' + tables + '\n</body></html>';
  }

  // ───────── 한글 문서(.hwpx) ─────────
  // hwpx 는 XML 여러 개를 묶은 zip 이다. 글꼴·글자 모양·문단 모양·테두리를 header.xml 에 번호로 정해 두고, 본문(section0.xml)에서 번호로 가리킨다.
  const HWPX_NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
  const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
  const perLang = (v) => LANGS.map((l) => `${l.toLowerCase()}="${v}"`).join(' ');
  const PAGE = { width: 59528, height: 84186, left: 8504, right: 8504, top: 5668, bottom: 4252, header: 4252, footer: 4252 }; // A4 세로
  const TEXT_WIDTH = PAGE.width - PAGE.left - PAGE.right;

  function hwpxHeader() {
    const font = LANGS.map((l) => `<hh:fontface lang="${l}" fontCnt="1"><hh:font id="0" face="맑은 고딕" type="TTF" isEmbedded="0"/></hh:fontface>`).join('');
    const side = (type) => ['left', 'right', 'top', 'bottom'].map((s) => `<hh:${s}Border type="${type}" width="0.12 mm" color="#000000"/>`).join('');
    const borderFill = (id, type, fill) => `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>${side(type)}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>${fill ? `<hc:fillBrush><hc:winBrush faceColor="${fill}" hatchColor="#000000" alpha="0"/></hc:fillBrush>` : ''}</hh:borderFill>`;
    const charPr = (id, height, bold) => `<hh:charPr id="${id}" height="${height}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"><hh:fontRef ${perLang(0)}/><hh:ratio ${perLang(100)}/><hh:spacing ${perLang(0)}/><hh:relSz ${perLang(100)}/><hh:offset ${perLang(0)}/>${bold ? '<hh:bold/>' : ''}<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>`;
    const paraPr = (id, align) => `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="${align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="0" unit="HWPUNIT"/><hc:next value="0" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/><hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`;
    return `${XML}<hh:head ${HWPX_NS} version="1.2" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>` +
      `<hh:fontfaces itemCnt="7">${font}</hh:fontfaces>` +
      // 테두리: 1 없음 · 2 실선 · 3 실선 + 연한 바탕(제목 줄)
      `<hh:borderFills itemCnt="3">${borderFill(1, 'NONE')}${borderFill(2, 'SOLID')}${borderFill(3, 'SOLID', '#E4F3EE')}</hh:borderFills>` +
      // 글자: 0 본문 11pt · 1 제목 15pt 굵게 · 2 표 제목 줄 11pt 굵게 · 3 작은 글 10pt
      `<hh:charProperties itemCnt="4">${charPr(0, 1100)}${charPr(1, 1500, true)}${charPr(2, 1100, true)}${charPr(3, 1000)}</hh:charProperties>` +
      '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' +
      '<hh:numberings itemCnt="1"><hh:numbering id="1" start="0"><hh:paraHead start="1" level="1" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^1.</hh:paraHead></hh:numbering></hh:numberings>' +
      // 문단: 0 왼쪽 · 1 가운데
      `<hh:paraProperties itemCnt="2">${paraPr(0, 'LEFT')}${paraPr(1, 'CENTER')}</hh:paraProperties>` +
      '<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>' +
      '</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>';
  }

  function hwpxSection(doc) {
    const para = (text, charPr, opt = {}) => `<hp:p id="0" paraPrIDRef="${opt.center ? 1 : 0}" styleIDRef="0" pageBreak="${opt.pageBreak ? 1 : 0}" columnBreak="0" merged="0">${opt.first || ''}<hp:run charPrIDRef="${charPr}"><hp:t>${esc(text)}</hp:t></hp:run></hp:p>`;
    const note = (length) => `<hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="${length}" type="SOLID" width="0.12 mm" color="#000000"/>`;
    const pageBorder = ['BOTH', 'EVEN', 'ODD'].map((t) => `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`).join('');
    // 쪽 설정은 첫 문단의 첫 글자 묶음에 들어간다
    const secPr = '<hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
      '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
      '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
      '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
      `<hp:pagePr landscape="WIDELY" width="${PAGE.width}" height="${PAGE.height}" gutterType="LEFT_ONLY"><hp:margin header="${PAGE.header}" footer="${PAGE.footer}" gutter="0" left="${PAGE.left}" right="${PAGE.right}" top="${PAGE.top}" bottom="${PAGE.bottom}"/></hp:pagePr>` +
      `<hp:footNotePr>${note(-1)}<hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
      `<hp:endNotePr>${note(14692344)}<hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
      `${pageBorder}</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>`;

    const ROW = 1900;
    const table = (g, id) => {
      // 칸 너비: 숫자 칸은 좁게, 글자 칸이 나머지를 나눠 갖는다
      const narrow = g.head.map((h) => ['학년', '반', '번호'].includes(h));
      const narrowW = 4600;
      const wideW = Math.floor((TEXT_WIDTH - narrow.filter(Boolean).length * narrowW) / narrow.filter((n) => !n).length);
      const widths = narrow.map((n) => (n ? narrowW : wideW));
      widths[widths.length - 1] += TEXT_WIDTH - widths.reduce((a, b) => a + b, 0);
      const cell = (text, r, c, headRow) => `<hp:tc name="" header="${headRow ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${headRow ? 3 : 2}">` +
        '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
        para(text, headRow ? 2 : 0, { center: headRow || narrow[c] }) + '</hp:subList>' +
        `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${widths[c]}" height="${ROW}"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`;
      const rows = [g.head, ...g.rows];
      return `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">` +
        `<hp:tbl id="${id}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length}" colCnt="${g.head.length}" cellSpacing="0" borderFillIDRef="2" noAdjust="0">` +
        `<hp:sz width="${TEXT_WIDTH}" widthRelTo="ABSOLUTE" height="${ROW * rows.length}" heightRelTo="ABSOLUTE" protect="0"/>` +
        '<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
        '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>' +
        rows.map((r, ri) => '<hp:tr>' + r.map((v, ci) => cell(v, ri, ci, ri === 0)).join('') + '</hp:tr>').join('') +
        '</hp:tbl><hp:t/></hp:run></hp:p>';
    };

    const groups = groupRoster(doc.rows, doc.by);
    const body = groups.map((g, i) =>
      para(`${doc.title} · ${g.name}${doc.draft ? ' (미확정)' : ''}`, 1, { pageBreak: i > 0, first: i === 0 ? secPr : '' }) +
      para(`${g.note ? g.note + ' · ' : ''}${g.rows.length}명`, 3) +
      table(g, 1000 + i)).join('');
    // 묶음이 하나도 없어도 쪽 설정이 든 문단은 있어야 문서가 열린다
    return `${XML}<hs:sec ${HWPX_NS}>${body || para(doc.title, 1, { first: secPr })}</hs:sec>`;
  }

  /** 한컴오피스 한글에서 바로 열리는 .hwpx 문서. 묶음(반·프로그램)마다 새 쪽에서 시작하고, 표가 길면 다음 쪽으로 이어진다. */
  function buildHwpx(doc) {
    const preview = groupRoster(doc.rows, doc.by).map((g) => `${doc.title} · ${g.name}\r\n` + [g.head, ...g.rows].map((r) => r.join('\t')).join('\r\n')).join('\r\n\r\n');
    return WorkbookForm.zipStore([
      ['mimetype', 'application/hwp+zip'], // 반드시 첫 파일, 압축 없이
      ['version.xml', `${XML}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.2" application="Hancom Office Hangul" appVersion="11, 0, 0, 0 WIN32LEWindows_10"/>`],
      ['META-INF/container.xml', `${XML}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/></ocf:rootfiles></ocf:container>`],
      ['META-INF/manifest.xml', `${XML}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`],
      ['Contents/content.hpf', `${XML}<opf:package ${HWPX_NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${esc(doc.title)}</opf:title><opf:language>ko</opf:language></opf:metadata>` +
        '<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>' +
        '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>'],
      ['Contents/header.xml', hwpxHeader()],
      ['Contents/section0.xml', hwpxSection(doc)],
      ['settings.xml', `${XML}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`],
      ['Preview/PrvText.txt', preview],
    ]);
  }

  const api = { groupRoster, sheetNames, buildXlsx, buildHwpHtml, buildHwpx };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RosterExport = api;
})(typeof self !== 'undefined' ? self : this);
