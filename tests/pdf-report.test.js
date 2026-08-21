"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const PDFLib = require(path.join(root, "vendor", "pdf-lib.min.js"));
const fontkit = require(path.join(root, "vendor", "fontkit.umd.min.js"));
const InventoryPdf = require(path.join(root, "pdf-report.js"));

async function run() {
  assert.deepEqual(InventoryPdf.A4_LANDSCAPE, [841.89, 595.28]);
  assert.deepEqual(InventoryPdf.DEFAULT_HEADERS, [
    "No.", "施設名 / 部署名", "商品コード", "商品名", "規格",
    "製品番号", "ラベルキー", "ラベル日付", "対応"
  ]);
  assert.deepEqual(InventoryPdf.COLUMN_RATIOS, [0.04, 0.18, 0.11, 0.18, 0.13, 0.10, 0.10, 0.09, 0.07]);
  assert.equal(InventoryPdf.sanitizeFilenamePart('病院/:*?"<>|'), "病院________");

  const rows = Array.from({ length: 60 }, (_, index) => [
    String(index + 1),
    `架空中央病院 / テスト病棟${index % 4 + 1}`,
    `PC-${String(index + 1).padStart(4, "0")}`,
    index === 5 ? "非常に長い商品名の折り返し確認用医療材料セット（架空データ）" : `テスト商品${index + 1}`,
    index === 2 ? null : index === 5 ? "長い規格表示テスト 100mm × 250mm 20個入" : `規格${index + 1}`,
    index === 2 ? undefined : `PN-${index + 1}`,
    `KEY-${String(index + 1).padStart(5, "0")}`,
    "2026/08/20",
    index === 1 ? "ラベル再発行" : ""
  ]);

  const fontBytes = fs.readFileSync(path.join(root, "vendor", "NotoSansCJKjp-Regular.ttf"));
  const result = await InventoryPdf.generateInventoryPdf({
    title: "SPD棚卸　未確認ラベルリスト",
    facilityName: "架空中央病院",
    departmentName: "テスト病棟",
    endDate: "2026/08/20",
    printedAt: "2026/08/21 10:00",
    countSummary: "対象 60件　読取済 0件　未読取 60件",
    fileDate: "2026-08-21",
    headers: InventoryPdf.DEFAULT_HEADERS,
    rows
  }, { PDFLib, pdfLib: PDFLib, fontkit, fontBytes });

  assert.equal(result.bytes.slice(0, 4).toString(), "37,80,68,70", "PDFシグネチャが必要");
  assert.ok(result.pageCount > 1, "複数ページ帳票を生成する");
  assert.equal(result.fileName, "SPD棚卸_未確認ラベルリスト_架空中央病院_テスト病棟_20260821.pdf");

  const loaded = await PDFLib.PDFDocument.load(result.bytes);
  assert.equal(loaded.getPageCount(), result.pageCount);
  loaded.getPages().forEach((page) => {
    const size = page.getSize();
    assert.ok(Math.abs(size.width - 841.89) < 0.01, "A4横向きの幅");
    assert.ok(Math.abs(size.height - 595.28) < 0.01, "A4横向きの高さ");
  });

  const source = fs.readFileSync(path.join(root, "pdf-report.js"), "utf8");
  assert.equal(source.includes("window.print"), false, "自動印刷は行わない");
  if (process.env.PDF_QA_OUTPUT) fs.writeFileSync(process.env.PDF_QA_OUTPUT, result.bytes);
  console.log("棚卸くん PDF tests: OK");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
