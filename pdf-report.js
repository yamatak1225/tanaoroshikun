"use strict";

(function initializeInventoryPdf(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.InventoryPdf = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (root) => {
  const A4_LANDSCAPE = [841.89, 595.28];
  const MM_TO_PT = 72 / 25.4;
  const PAGE_MARGIN = 10 * MM_TO_PT;
  const STAMP_WIDTH = 22 * MM_TO_PT;
  const STAMP_BODY_HEIGHT = 14 * MM_TO_PT;
  const TABLE_FONT_SIZE = 6.8;
  const TABLE_LINE_HEIGHT = 8.5;
  const CELL_PADDING = 1.6 * MM_TO_PT;
  const TABLE_BORDER_WIDTH = 0.5;
  const COLUMN_RATIOS = [0.04, 0.18, 0.11, 0.18, 0.13, 0.10, 0.10, 0.09, 0.07];
  const DEFAULT_HEADERS = ["No.", "施設名 / 部署名", "商品コード", "商品名", "規格", "製品番号", "ラベルキー", "ラベル日付", "対応"];
  const APPROVAL_COLUMN_RATIOS = [0.05, 0.12, 0.20, 0.16, 0.12, 0.13, 0.12, 0.10];
  const APPROVAL_HEADERS = ["No.", "商品コード", "商品名", "規格", "製品番号", "ラベルキー", "ラベル日付", "対応"];
  let cachedFontBytesPromise = null;

  function textValue(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  function sanitizeFilenamePart(value) {
    return textValue(value)
      .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 50) || "未設定";
  }

  function buildPdfFilename(report) {
    const dateKey = textValue(report.fileDate).replace(/\D/g, "").slice(0, 8) || "日付未設定";
    const reportName = report.reportType === "departmentApproval" ? "部署確認記録" : "未確認ラベルリスト";
    return `SPD棚卸_${reportName}_${sanitizeFilenamePart(report.facilityName)}_${sanitizeFilenamePart(report.departmentName)}_${dateKey}.pdf`;
  }

  function wrapText(text, font, size, maxWidth) {
    const source = textValue(text).replace(/\r\n?/g, "\n");
    const result = [];
    source.split("\n").forEach((paragraph) => {
      if (!paragraph) {
        result.push("");
        return;
      }
      let line = "";
      for (const character of paragraph) {
        const candidate = line + character;
        if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
          result.push(line);
          line = character;
        } else {
          line = candidate;
        }
      }
      result.push(line);
    });
    return result.length ? result : [""];
  }

  function fitSingleLine(text, font, initialSize, maxWidth, minimumSize = 6) {
    let size = initialSize;
    const value = textValue(text);
    while (size > minimumSize && font.widthOfTextAtSize(value, size) > maxWidth) size -= 0.25;
    return { text: value, size };
  }

  function drawBoldText(page, text, options) {
    page.drawText(textValue(text), options);
    page.drawText(textValue(text), { ...options, x: options.x + 0.18 });
  }

  function drawFittedText(page, text, font, options) {
    const fitted = fitSingleLine(text, font, options.size, options.maxWidth, options.minimumSize);
    page.drawText(fitted.text, { x: options.x, y: options.y, size: fitted.size, font, color: options.color });
  }

  function drawSummaryPair(page, font, colors, label, value, x, y, width) {
    const labelWidth = 56;
    drawBoldText(page, label, { x, y, size: 9, font, color: colors.black });
    drawFittedText(page, value, font, { x: x + labelWidth, y, size: 9, minimumSize: 6.5, maxWidth: width - labelWidth, color: colors.black });
  }

  function drawFirstPageHeader(page, font, report, pdfLib) {
    const { width, height } = page.getSize();
    const colors = { black: pdfLib.rgb(0, 0, 0), gray: pdfLib.rgb(0.47, 0.47, 0.47) };
    const top = height - PAGE_MARGIN;
    drawBoldText(page, report.title || "SPD棚卸　未確認ラベルリスト", {
      x: PAGE_MARGIN,
      y: top - 17,
      size: 17,
      font,
      color: colors.black
    });

    if (report.reportType === "departmentApproval") {
      const halfWidth = (width - PAGE_MARGIN * 2) / 2 - 8;
      const rightX = PAGE_MARGIN + halfWidth + 16;
      drawSummaryPair(page, font, colors, "施設名", report.facilityName, PAGE_MARGIN, top - 48, halfWidth);
      drawSummaryPair(page, font, colors, "部署名", report.departmentName, rightX, top - 48, halfWidth);
      drawSummaryPair(page, font, colors, "対象終了日", report.endDate, PAGE_MARGIN, top - 68, halfWidth);
      drawSummaryPair(page, font, colors, "確認日時", report.confirmedAt, rightX, top - 68, halfWidth);
      drawSummaryPair(page, font, colors, "確認者氏名", report.confirmedBy, PAGE_MARGIN, top - 88, halfWidth);
      drawSummaryPair(page, font, colors, "件数", report.countSummary, rightX, top - 88, halfWidth);
      return top - 108;
    }

    const stampX = width - PAGE_MARGIN - STAMP_WIDTH;
    const stampHeaderHeight = 12;
    const stampHeight = stampHeaderHeight + STAMP_BODY_HEIGHT;
    const stampY = top - stampHeight;
    page.drawRectangle({ x: stampX, y: stampY, width: STAMP_WIDTH, height: stampHeight, borderColor: colors.black, borderWidth: 0.75 });
    page.drawLine({ start: { x: stampX, y: stampY + STAMP_BODY_HEIGHT }, end: { x: stampX + STAMP_WIDTH, y: stampY + STAMP_BODY_HEIGHT }, thickness: 0.75, color: colors.black });
    const approvalLabel = "部署確認者";
    const approvalWidth = font.widthOfTextAtSize(approvalLabel, 7);
    drawBoldText(page, approvalLabel, { x: stampX + (STAMP_WIDTH - approvalWidth) / 2, y: stampY + STAMP_BODY_HEIGHT + 2.5, size: 7, font, color: colors.black });
    const stampTextWidth = font.widthOfTextAtSize("印", 7);
    page.drawText("印", { x: stampX + (STAMP_WIDTH - stampTextWidth) / 2, y: stampY + STAMP_BODY_HEIGHT / 2 - 3, size: 7, font, color: colors.gray });

    const summaryWidth = width - PAGE_MARGIN * 2 - STAMP_WIDTH - 18;
    const halfWidth = summaryWidth / 2 - 8;
    const rightX = PAGE_MARGIN + summaryWidth / 2 + 8;
    drawSummaryPair(page, font, colors, "施設名", report.facilityName, PAGE_MARGIN, top - 52, halfWidth);
    drawSummaryPair(page, font, colors, "部署名", report.departmentName, rightX, top - 52, halfWidth);
    drawSummaryPair(page, font, colors, "対象終了日", report.endDate, PAGE_MARGIN, top - 72, halfWidth);
    drawSummaryPair(page, font, colors, "印刷日時", report.printedAt, rightX, top - 72, halfWidth);
    drawSummaryPair(page, font, colors, "件数", report.countSummary, PAGE_MARGIN, top - 92, summaryWidth);
    return top - 112;
  }

  function columnLayout(pageWidth, ratios = COLUMN_RATIOS) {
    const tableWidth = pageWidth - PAGE_MARGIN * 2;
    const widths = ratios.map((ratio) => tableWidth * ratio);
    const positions = [];
    let x = PAGE_MARGIN;
    widths.forEach((width) => {
      positions.push(x);
      x += width;
    });
    return { tableWidth, widths, positions };
  }

  function fontForText(value, fonts) {
    return /^[\x00-\x7F]*$/.test(textValue(value)) ? fonts.latin : fonts.japanese;
  }

  function prepareCellLines(values, fonts, layout, size = TABLE_FONT_SIZE) {
    return values.map((value, index) => {
      const font = fontForText(value, fonts);
      return { font, lines: wrapText(value, font, size, Math.max(1, layout.widths[index] - CELL_PADDING * 2)) };
    });
  }

  function rowHeightForLines(cells) {
    return Math.max(...cells.map((cell) => cell.lines.length), 1) * TABLE_LINE_HEIGHT + CELL_PADDING * 2;
  }

  function drawTableRow(page, topY, values, fonts, layout, pdfLib, options = {}) {
    const cells = prepareCellLines(values, fonts, layout);
    const rowHeight = rowHeightForLines(cells);
    const fill = options.header ? pdfLib.rgb(0.933, 0.933, 0.933) : undefined;
    const black = pdfLib.rgb(0, 0, 0);
    values.forEach((value, columnIndex) => {
      const x = layout.positions[columnIndex];
      const width = layout.widths[columnIndex];
      page.drawRectangle({
        x,
        y: topY - rowHeight,
        width,
        height: rowHeight,
        color: fill,
        borderColor: pdfLib.rgb(0.33, 0.33, 0.33),
        borderWidth: TABLE_BORDER_WIDTH
      });
      cells[columnIndex].lines.forEach((line, lineIndex) => {
        const textOptions = {
          x: x + CELL_PADDING,
          y: topY - CELL_PADDING - TABLE_FONT_SIZE - lineIndex * TABLE_LINE_HEIGHT,
          size: TABLE_FONT_SIZE,
          font: cells[columnIndex].font,
          color: black
        };
        if (options.header) drawBoldText(page, line, textOptions);
        else page.drawText(line, textOptions);
      });
    });
    return rowHeight;
  }

  function normalizeReport(report) {
    return {
      title: textValue(report.title) || "SPD棚卸　未確認ラベルリスト",
      facilityName: textValue(report.facilityName),
      departmentName: textValue(report.departmentName),
      endDate: textValue(report.endDate),
      printedAt: textValue(report.printedAt),
      countSummary: textValue(report.countSummary),
      reportType: textValue(report.reportType),
      confirmedBy: textValue(report.confirmedBy),
      confirmedAt: textValue(report.confirmedAt),
      tableTitle: textValue(report.tableTitle),
      emptyMessage: textValue(report.emptyMessage),
      fileDate: textValue(report.fileDate),
      headers: (report.headers || DEFAULT_HEADERS).map(textValue),
      columnRatios: (report.columnRatios || COLUMN_RATIOS).map(Number),
      rows: (report.rows || []).map((row) => (report.headers || DEFAULT_HEADERS).map((_, index) => textValue(row?.[index])))
    };
  }

  async function loadFontBytes(options) {
    if (options.fontBytes) return options.fontBytes;
    if (!cachedFontBytesPromise) {
      const fetchRef = options.fetchRef || root.fetch?.bind(root);
      if (!fetchRef) throw new Error("日本語フォントを読み込む機能がありません。");
      const fontUrl = options.fontUrl || "./vendor/NotoSansCJKjp-Regular.ttf";
      cachedFontBytesPromise = fetchRef(fontUrl).then((response) => {
        if (!response.ok) throw new Error(`日本語フォントを読み込めません（${response.status}）。`);
        return response.arrayBuffer();
      }).catch((error) => {
        cachedFontBytesPromise = null;
        throw error;
      });
    }
    return cachedFontBytesPromise;
  }

  async function generateInventoryPdf(inputReport, options = {}) {
    const pdfLib = options.pdfLib || root.PDFLib;
    const fontkitRef = options.fontkit || root.fontkit;
    if (!pdfLib?.PDFDocument || !pdfLib?.rgb) throw new Error("PDF生成ライブラリを読み込めません。");
    if (!fontkitRef) throw new Error("日本語フォント処理ライブラリを読み込めません。");
    const report = normalizeReport(inputReport || {});
    if (!report.headers.length || report.headers.length !== report.columnRatios.length || Math.abs(report.columnRatios.reduce((sum, value) => sum + value, 0) - 1) > 0.001) throw new Error("PDF一覧の列数または列幅が正しくありません。");
    const fontBytes = await loadFontBytes(options);
    const pdfDoc = await pdfLib.PDFDocument.create();
    pdfDoc.registerFontkit(fontkitRef);
    // CJKフォントの部分埋込みは一部のPDF表示環境で字形が欠落するため、
    // 日本語の確実な表示を優先して静的TrueTypeフォント全体を埋め込む。
    const font = await pdfDoc.embedFont(fontBytes, { subset: false });
    const fonts = { japanese: font, latin: await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica) };
    pdfDoc.setTitle(report.title);
    pdfDoc.setSubject(report.reportType === "departmentApproval" ? "棚卸くん 部署確認記録" : "棚卸くん 未確認ラベル帳票");
    pdfDoc.setCreator("棚卸くん / pdf-lib 1.17.1");
    pdfDoc.setProducer("棚卸くん");

    const [pageWidth, pageHeight] = A4_LANDSCAPE;
    const layout = columnLayout(pageWidth, report.columnRatios);
    let page = pdfDoc.addPage(A4_LANDSCAPE);
    let currentY = drawFirstPageHeader(page, font, report, pdfLib);
    if (report.tableTitle) {
      drawBoldText(page, report.tableTitle, { x: PAGE_MARGIN, y: currentY - 2, size: 11, font, color: pdfLib.rgb(0, 0, 0) });
      currentY -= 20;
    }
    const headerHeight = drawTableRow(page, currentY, report.headers, fonts, layout, pdfLib, { header: true });
    currentY -= headerHeight;

    report.rows.forEach((row) => {
      const lines = prepareCellLines(row, fonts, layout);
      const rowHeight = rowHeightForLines(lines);
      const maximumRowHeight = pageHeight - PAGE_MARGIN * 2 - headerHeight;
      if (rowHeight > maximumRowHeight) throw new Error("1件の文字量が多すぎるためPDFへ配置できません。商品名や規格を確認してください。");
      if (currentY - rowHeight < PAGE_MARGIN) {
        page = pdfDoc.addPage(A4_LANDSCAPE);
        currentY = pageHeight - PAGE_MARGIN;
        currentY -= drawTableRow(page, currentY, report.headers, fonts, layout, pdfLib, { header: true });
      }
      currentY -= drawTableRow(page, currentY, row, fonts, layout, pdfLib);
    });
    if (!report.rows.length && report.emptyMessage) {
      drawBoldText(page, report.emptyMessage, { x: PAGE_MARGIN, y: currentY - 22, size: 11, font, color: pdfLib.rgb(0, 0, 0) });
    }

    const bytes = await pdfDoc.save();
    return { bytes, fileName: buildPdfFilename(report), pageCount: pdfDoc.getPageCount() };
  }

  return {
    A4_LANDSCAPE,
    DEFAULT_HEADERS,
    COLUMN_RATIOS,
    APPROVAL_HEADERS,
    APPROVAL_COLUMN_RATIOS,
    sanitizeFilenamePart,
    buildPdfFilename,
    wrapText,
    generateInventoryPdf
  };
});
