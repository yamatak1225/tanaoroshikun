"use strict";

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const inputPath = path.join(projectRoot, "vendor", "NotoSansCJKjp-PdfCommon.ttf");
const outputPath = path.join(projectRoot, "vendor", "pdf-font-data.js");
const base64 = fs.readFileSync(inputPath).toString("base64");
const source = `"use strict";\n// iOS互換の事前サブセット日本語フォント。生成元とライセンスはTHIRD_PARTY_NOTICES.mdを参照。\nglobalThis.InventoryPdfFontData = Object.freeze({ fileName: "NotoSansCJKjp-PdfCommon.ttf", base64: "${base64}" });\n`;

fs.writeFileSync(outputPath, source);
console.log(`PDFフォントデータを生成しました: ${path.relative(projectRoot, outputPath)} (${source.length.toLocaleString()} bytes)`);
