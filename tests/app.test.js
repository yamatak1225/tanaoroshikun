"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const app = require("../app.js");

const {
  PRINT_COLUMN_HEADERS, state, parseTsv, isValidDateKey, buildLabelKey, normalizeQr, getExpectedCenterCode, rebuildIndexes,
  validateTargetEndDate, isRowOnOrBeforeEndDate, getEligibleDepartments, getCurrentTargetLabels, getOverallProgress,
  getUnreadLabels, getTargetCounts, validateSpdLabel, acceptSpdLabel, applyMasterData,
  getOutputRecords, getReissueTargetLabels, confirmUnreadLabel, toggleReissueLabel, isCompletionTransition,
  getPrintRowValues, createPdfReportData, saveState, restoreState, createHistoryRecord, filterOutputRecords, buildOutputCsv,
  openPdfLoadingWindow, createPdfBlob, displayPdfUrl, removeLegacyPwaArtifacts
} = app;

const FACILITY_A = "0000000101";
const FACILITY_B = "0000000202";
const DEPARTMENT_A = "0000000011";
const DEPARTMENT_B = "0000000022";
const header = "施設コード\t施設名称\t部署コード\t部署名称\t品名\t規格\t製品番号\tラベルキー\t払出予定伝票日付\tエラーメッセージ\t商品コード\tメーカー名\t有効期限\tロット番号";
const rows = [
  `${FACILITY_A}\t架空中央病院\t${DEPARTMENT_A}\t3階病棟\t商品A\t10枚入\tPN-A\t105819-6-1\t20260817\t\tPC-A\t架空メーカーA\t20291231\tLOT-A`,
  `${FACILITY_A}\t架空中央病院\t${DEPARTMENT_A}\t3階病棟\t商品B\t20枚入\tPN-B\t2-3-4\t20260821\t\tPC-B\t架空メーカーB\t20300131\tLOT-B`,
  `${FACILITY_A}\t架空中央病院\t${DEPARTMENT_B}\t外来\t商品C\t5本入\tPN-C\t5-6-7\t20260818\t\tPC-C\t架空メーカーC\t20281130\tLOT-C`,
  `${FACILITY_B}\t千葉白井病院\t${DEPARTMENT_A}\t手術室\t商品D\t1個\tPN-D\t8-9-10\t20260818\t\tPC-D\t架空メーカーD\t20271031\tLOT-D`
];

function makeQr(center, first, second, third) {
  return center + String(first).padStart(15, "0") + String(second).padStart(4, "0") + String(third).padStart(3, "0");
}

function selectDepartment(facilityCode, departmentCode) {
  state.currentDepartment = getEligibleDepartments().find((item) => item.facilityCode === facilityCode && item.departmentCode === departmentCode) || null;
  assert.ok(state.currentDepartment, "テスト対象部署を選択できる");
}

function resetMaster(parsedRows = parseTsv(`${header}\n${rows.join("\n")}`).rows) {
  applyMasterData(parsedRows, { fileName: "架空マスタ.tsv", size: 100, lastModified: 1, source: "テスト" }, new Date("2026-08-20T00:00:00+09:00"));
  state.targetEndDate = "2026-08-20";
  state.currentDepartment = null;
  state.readLabelKeys = new Set();
  state.confirmationMethods = new Map();
  state.reissueLabelKeys = new Set();
  state.reissueFilterActive = false;
  rebuildIndexes();
}

async function run() {
  const parsed = parseTsv(`${header}\n${rows.join("\n")}`);
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.errorExcludedCount, 0);
  assert.equal(parseTsv(`${header}\n${FACILITY_A}\t架空中央病院\t${DEPARTMENT_A}\t3階病棟\t"商品\tA"\t規格X\tPN-X\t1-2-3\t20260817\t\t\t\t\t`).rows[0]["品名"], "商品\tA");
  assert.throws(() => parseTsv("施設名称\t部署名称\n架空病院\t病棟"), /必須列/);
  const missingSpecificationHeader = header.split("\t").filter((name) => name !== "規格").join("\t");
  assert.throws(() => parseTsv(`${missingSpecificationHeader}\nx`), /必須列.*規格/, "規格列そのものは従来どおり必要とする");
  assert.throws(() => parseTsv(`${header}\n${FACILITY_A}\t架空中央病院\t${DEPARTMENT_A}\t3階病棟\t商品\t規格X\tPN-X\t1-2-3\t20260230\t\t\t\t\t`), /正しい日付/);
  const headerWithManufacturerAlias = header.replace("メーカー名", "メーカー");
  const blankOptionalLine = [FACILITY_A, "架空中央病院", DEPARTMENT_A, "3階病棟", "", "   ", "", "13-1-1", "20260817", "", "PC-13", "   ", "", ""].join("\t");
  const blankOptional = parseTsv(`${headerWithManufacturerAlias}\n${blankOptionalLine}`);
  assert.equal(blankOptional.rows.length, 1, "メーカー・品名・規格・製品番号がすべて空欄でも取り込む");
  for (const name of ["メーカー", "品名", "規格", "製品番号"]) assert.equal(blankOptional.rows[0][name], "", `${name}の空白値を空文字として保持する`);
  const missingRequiredValue = ["", "架空中央病院", DEPARTMENT_A, "3階病棟", "", "", "", "14-1-1", "20260817", "", "PC-14", "", "", ""].join("\t");
  assert.throws(() => parseTsv(`${headerWithManufacturerAlias}\n${missingRequiredValue}`), /必須項目が空欄です（施設コード）/, "その他の必須値チェックは維持する");
  resetMaster(blankOptional.rows);
  assert.deepEqual(getEligibleDepartments().map((item) => item.departmentName), ["3階病棟"], "任意項目が空欄でも部署一覧へ含める");
  selectDepartment(FACILITY_A, DEPARTMENT_A);
  assert.deepEqual(getTargetCounts(), { target: 1, read: 0, unread: 1 }, "任意項目が空欄でも対象件数へ含める");
  assert.deepEqual(getPrintRowValues(getUnreadLabels()[0], 0), [
    "1", "架空中央病院 / 3階病棟", "PC-13", "", "", "", "13-1-1", "2026/08/17", ""
  ], "任意項目が空欄でも印刷行を列ずれなく作成する");
  const blankQr = makeQr("0000000001", 13, 1, 1);
  assert.equal(acceptSpdLabel(blankQr).ok, true, "任意項目が空欄でもバーコード読取できる");
  let blankOutput = getOutputRecords()[0];
  assert.deepEqual([blankOutput.manufacturerName, blankOutput.productName, blankOutput.specification, blankOutput.productNumber], ["", "", "", ""], "CSV用データでは任意項目を空文字にする");
  assert.equal(buildOutputCsv([blankOutput]).includes("undefined"), false, "CSVへundefinedを出力しない");
  assert.equal(buildOutputCsv([blankOutput]).includes("null"), false, "CSVへnullを出力しない");
  resetMaster(blankOptional.rows);
  selectDepartment(FACILITY_A, DEPARTMENT_A);
  assert.equal(confirmUnreadLabel("13-1-1").ok, true, "任意項目が空欄でも手動確認できる");
  blankOutput = getOutputRecords()[0];
  assert.equal(blankOutput.confirmationMethod, "手動確認");
  const filtered = parseTsv(`${header}\n${[
    `${FACILITY_A}\t架空中央病院\t${DEPARTMENT_A}\t3階病棟\t有効商品\t規格11\tPN-OK\t11-1-1\t20260817\t\tPC-11\t架空メーカー\t\t`,
    `${FACILITY_B}\t千葉白井病院\t${DEPARTMENT_B}\t除外部署\t\t\t\t99-9-9\t\t要確認\t\t\t\t`,
    `${FACILITY_A}\t架空中央病院\t${DEPARTMENT_A}\t3階病棟\t空白有効商品\t規格12\tPN-SPACE\t12-1-1\t20260817\t   \tPC-12\t架空メーカー\t\t`
  ].join("\n")}`);
  assert.equal(filtered.rows.length, 2, "エラーメッセージが空または空白だけの行を取り込む");
  assert.equal(filtered.errorExcludedCount, 1, "エラーメッセージがある行を除外する");
  assert.deepEqual(filtered.rows.map((row) => row["ラベルキー"]), ["11-1-1", "12-1-1"]);
  resetMaster(filtered.rows);
  assert.deepEqual(getEligibleDepartments().map((item) => item.departmentName), ["3階病棟"], "除外行の部署を候補へ出さない");
  selectDepartment(FACILITY_A, DEPARTMENT_A);
  assert.deepEqual(getTargetCounts(), { target: 2, read: 0, unread: 2 }, "除外行を件数へ含めない");
  assert.deepEqual(getUnreadLabels().map((row) => row["ラベルキー"]), ["11-1-1", "12-1-1"], "除外行を未読取一覧へ含めない");
  assert.equal(validateSpdLabel(makeQr("0000000002", 99, 9, 9)).code, "NOT_FOUND", "除外SPDラベルを照合対象にしない");
  assert.equal(toggleReissueLabel("11-1-1"), true, "再発行対象をONにする");
  state.reissueLabelKeys.add("99-9-9");
  assert.deepEqual(getReissueTargetLabels().map((row) => row["ラベルキー"]), ["11-1-1"], "エラー除外行は再発行抽出へ含めない");
  state.reissueLabelKeys.delete("99-9-9");
  assert.deepEqual(
    { read: getOverallProgress().read, unread: getOverallProgress().unread },
    { read: 0, unread: 2 },
    "再発行指定だけでは全体状況を読取済にしない"
  );
  assert.equal(getPrintRowValues(getUnreadLabels()[0], 0).at(-1), "ラベル再発行", "印刷データへ再発行表示を付ける");
  assert.deepEqual(getPrintRowValues(getUnreadLabels()[0], 0), [
    "1", "架空中央病院 / 3階病棟", "PC-11", "有効商品", "規格11", "PN-OK", "11-1-1", "2026/08/17", "ラベル再発行"
  ], "印刷データを指定された列順で作成する");
  assert.equal(toggleReissueLabel("11-1-1"), false, "再発行対象をOFFにする");
  assert.equal(getPrintRowValues(getUnreadLabels()[0], 0).at(-1), "", "再発行解除を印刷データへ反映する");
  assert.equal(toggleReissueLabel("11-1-1"), true, "再発行状態を保持するため再度ONにする");
  const manualFirst = confirmUnreadLabel("11-1-1");
  assert.equal(manualFirst.ok, true);
  assert.equal(manualFirst.confirmationMethod, "手動確認");
  assert.deepEqual(manualFirst.counts, { target: 2, read: 1, unread: 1 });
  assert.equal(isCompletionTransition({ target: 2, read: 0, unread: 2 }, manualFirst.counts), false);
  assert.deepEqual(getUnreadLabels().map((row) => row["ラベルキー"]), ["12-1-1"], "手動確認したラベルを未読取一覧から除外する");
  assert.deepEqual(getReissueTargetLabels().map((row) => row["ラベルキー"]), ["11-1-1"], "手動確認済でも再発行ONなら抽出する");
  const manualLast = confirmUnreadLabel("12-1-1");
  assert.equal(isCompletionTransition(manualFirst.counts, manualLast.counts), true, "最後の手動確認で完了遷移になる");
  assert.deepEqual(
    { read: getOverallProgress().read, unread: getOverallProgress().unread, completed: getOverallProgress().completedDepartments },
    { read: 2, unread: 0, completed: 1 },
    "手動確認を全体状況の完了判定へ反映する"
  );
  assert.equal(isCompletionTransition(manualLast.counts, manualLast.counts), false, "未読取0件の再描画相当では完了扱いにしない");
  const manualOutput = getOutputRecords();
  assert.equal(manualOutput.find((record) => record.labelKey === "11-1-1").confirmationMethod, "手動確認");
  assert.equal(manualOutput.find((record) => record.labelKey === "11-1-1").reissueStatus, "再発行");
  const manualCsv = buildOutputCsv(manualOutput);
  assert.match(manualCsv, /読取済区分/);
  assert.match(manualCsv, /確認方法/);
  assert.match(manualCsv, /ラベル再発行区分/);
  assert.match(manualCsv, /手動確認/);
  assert.match(manualCsv, /再発行/);
  assert.equal(isValidDateKey("20260228"), true);
  assert.equal(isValidDateKey("20260229"), false);
  assert.equal(buildLabelKey("000000000105819", "0006", "001"), "105819-6-1");
  assert.equal(normalizeQr(makeQr("0000000001", 105819, 6, 1)).labelKey, "105819-6-1");
  assert.equal(normalizeQr("123").code, "QR_FORMAT");
  assert.equal(getExpectedCenterCode("千葉白井病院"), "0000000002");
  assert.equal(getExpectedCenterCode("架空中央病院"), "0000000001");

  resetMaster(parsed.rows);
  assert.equal(validateTargetEndDate().ok, true);
  assert.equal(validateTargetEndDate("").code, "END_REQUIRED");
  assert.equal(validateTargetEndDate("2026-02-30").code, "END_INVALID");
  assert.equal(isRowOnOrBeforeEndDate(parsed.rows[0]), true);
  assert.equal(isRowOnOrBeforeEndDate(parsed.rows[1]), false);
  assert.deepEqual(getEligibleDepartments().map((item) => `${item.facilityName}/${item.departmentName}`), ["架空中央病院/3階病棟", "架空中央病院/外来", "千葉白井病院/手術室"]);
  assert.equal(toggleReissueLabel("5-6-7"), true, "選択部署以外の対象ラベルも再発行状態を操作できる");
  assert.deepEqual(getReissueTargetLabels().map((row) => row["ラベルキー"]), ["5-6-7"], "全部署から再発行対象を抽出する");
  state.readLabelKeys.add("5-6-7");
  state.confirmationMethods.set("5-6-7", "バーコード");
  assert.deepEqual(getReissueTargetLabels().map((row) => row["ラベルキー"]), ["5-6-7"], "バーコード読取済でも再発行ONなら抽出する");
  state.readLabelKeys.delete("5-6-7");
  state.confirmationMethods.delete("5-6-7");
  assert.equal(toggleReissueLabel("5-6-7"), false, "抽出対象の再発行状態を解除できる");
  assert.deepEqual(
    { target: getOverallProgress().target, read: getOverallProgress().read, unread: getOverallProgress().unread, completed: getOverallProgress().completedDepartments, departments: getOverallProgress().totalDepartments },
    { target: 3, read: 0, unread: 3, completed: 0, departments: 3 },
    "終了日以前の全部署を集計する"
  );

  selectDepartment(FACILITY_A, DEPARTMENT_A);
  assert.deepEqual(getCurrentTargetLabels().map((row) => row["ラベルキー"]), ["105819-6-1"]);
  const beforeBarcode = getTargetCounts();
  assert.deepEqual(beforeBarcode, { target: 1, read: 0, unread: 1 });
  const qrA = makeQr("0000000001", 105819, 6, 1);
  const accepted = acceptSpdLabel(qrA);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.confirmationMethod, "バーコード");
  assert.equal(isCompletionTransition(beforeBarcode, accepted.counts), true, "最後のバーコード読取で完了遷移になる");
  const okHistory = createHistoryRecord(accepted, qrA, new Date("2026-08-20T01:02:03.000Z"));
  const ngHistory = createHistoryRecord({ ok: false, title: "読取済", labelKey: "105819-6-1", row: parsed.rows[0] }, qrA, new Date("2026-08-20T02:02:03.000Z"));
  assert.equal(okHistory.result, "OK");
  assert.equal(okHistory.confirmationMethod, "バーコード");
  assert.equal(ngHistory.result, "NG");
  const outputRecords = getOutputRecords();
  assert.equal(outputRecords.length, 3, "終了日までの有効ラベル全件を出力対象にする");
  assert.equal(outputRecords.some((record) => record.labelKey === "2-3-4"), false, "終了日より後のラベルを出力しない");
  assert.equal(outputRecords.find((record) => record.labelKey === "105819-6-1").readStatus, "読取済");
  assert.equal(outputRecords.find((record) => record.labelKey === "105819-6-1").confirmationMethod, "バーコード");
  assert.equal(outputRecords.find((record) => record.labelKey === "5-6-7").readStatus, "未読取");
  assert.deepEqual(
    { target: getOverallProgress().target, read: getOverallProgress().read, unread: getOverallProgress().unread, completed: getOverallProgress().completedDepartments },
    { target: 3, read: 1, unread: 2, completed: 1 },
    "バーコード読取を全体状況へ反映する"
  );
  assert.equal(filterOutputRecords(outputRecords, { readStatus: "未読取" }).length, 2);
  const outputCsv = buildOutputCsv(outputRecords);
  for (const column of ["商品コード", "メーカー名", "商品名", "規格", "製品番号", "ラベルキー", "ラベル日付", "有効期限", "ロット番号", "施設名", "部署名", "読取済区分", "確認方法", "ラベル再発行区分"]) assert.match(outputCsv, new RegExp(column));
  assert.match(outputCsv, /PC-A,架空メーカーA,商品A,10枚入/);
  assert.match(outputCsv, /2026\/08\/17/);
  assert.match(outputCsv, /読取済,バーコード/);
  assert.match(outputCsv, /未読取,,/);
  assert.deepEqual(getTargetCounts(), { target: 1, read: 1, unread: 0 });
  assert.equal(getUnreadLabels().length, 0);
  assert.equal(validateSpdLabel(qrA).code, "DUPLICATE");
  assert.deepEqual(getTargetCounts(), { target: 1, read: 1, unread: 0 }, "重複読取を二重計上しない");

  state.readLabelKeys.clear();
  state.confirmationMethods.clear();
  assert.equal(validateSpdLabel(makeQr("0000000001", 5, 6, 7)).code, "DEPARTMENT_MISMATCH");
  assert.equal(validateSpdLabel(makeQr("0000000002", 105819, 6, 1)).code, "CENTER_MISMATCH");
  assert.equal(validateSpdLabel(makeQr("0000000001", 999, 1, 1)).code, "NOT_FOUND");
  state.targetEndDate = "2026-08-22";
  state.reissueLabelKeys.add("2-3-4");
  assert.deepEqual(getReissueTargetLabels().map((row) => row["ラベルキー"]), ["2-3-4"], "終了日を延長すると再発行対象へ含める");
  assert.equal(validateSpdLabel(makeQr("0000000001", 2, 3, 4)).ok, true);
  assert.equal(getOutputRecords().length, 4, "棚卸チェックの終了日変更をデータ出力へ反映する");
  state.targetEndDate = "2026-08-20";
  assert.equal(getReissueTargetLabels().some((row) => row["ラベルキー"] === "2-3-4"), false, "終了日より後の再発行ラベルを除外する");
  state.reissueLabelKeys.delete("2-3-4");
  assert.equal(validateSpdLabel(makeQr("0000000001", 2, 3, 4)).code, "OUTSIDE_PERIOD");
  state.currentDepartment = null;
  assert.equal(validateSpdLabel(qrA).code, "NO_DEPARTMENT");

  const duplicated = [...parsed.rows, { ...parsed.rows[0], __lineNumber: 6 }];
  resetMaster(duplicated);
  selectDepartment(FACILITY_A, DEPARTMENT_A);
  assert.equal(validateSpdLabel(qrA).code, "AMBIGUOUS_LABEL");
  assert.equal(getTargetCounts().target, 1, "対象件数は一意のラベルキーで数える");

  state.currentDepartment = { facilityCode: "x", facilityName: "x", departmentCode: "x", departmentName: "x" };
  state.readLabelKeys.add("105819-6-1");
  state.confirmationMethods.set("105819-6-1", "手動確認");
  state.reissueLabelKeys.add("105819-6-1");
  applyMasterData(parsed.rows, { fileName: "新マスタ.tsv", size: 200, lastModified: 2, source: "テスト" }, new Date(2026, 7, 20, 1, 0, 0));
  assert.equal(state.currentDepartment, null, "新マスターで部署選択をリセットする");
  assert.equal(state.readLabelKeys.size, 0, "新マスターで読取済をリセットする");
  assert.equal(state.confirmationMethods.size, 0, "新マスターで確認方法をリセットする");
  assert.equal(state.reissueLabelKeys.size, 0, "新マスターで再発行状態をリセットする");
  assert.equal(state.targetEndDate, "2026-08-20", "新マスターで対象終了日を当日にする");

  const storage = new Map();
  global.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value))
  };
  resetMaster(parsed.rows);
  selectDepartment(FACILITY_A, DEPARTMENT_A);
  state.readLabelKeys.add("105819-6-1");
  state.confirmationMethods.set("105819-6-1", "手動確認");
  state.reissueLabelKeys.add("105819-6-1");
  saveState();
  state.masterRows = [];
  state.masterInfo = null;
  state.readLabelKeys = new Set();
  state.confirmationMethods = new Map();
  state.reissueLabelKeys = new Set();
  state.currentDepartment = null;
  restoreState();
  assert.equal(state.readLabelKeys.has("105819-6-1"), true, "読取済状態を保存・復元する");
  assert.equal(state.confirmationMethods.get("105819-6-1"), "手動確認", "確認方法を保存・復元する");
  assert.equal(state.reissueLabelKeys.has("105819-6-1"), true, "再発行状態を保存・復元する");
  delete global.localStorage;

  const root = path.join(__dirname, "..");
  const cp932Fixture = new TextDecoder("shift-jis", { fatal: true }).decode(fs.readFileSync(path.join(__dirname, "在庫差異_テスト.tsv")));
  const fixtureParsed = parseTsv(cp932Fixture);
  assert.equal(fixtureParsed.rows.length, 3, "CP932の在庫差異.tsvを読み込める");
  assert.equal(fixtureParsed.errorExcludedCount, 1, "CP932ファイルでもエラー行を除外する");
  const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const styleSource = fs.readFileSync(path.join(root, "style.css"), "utf8");

  assert.match(indexSource, /<title>棚卸くん<\/title>/);
  assert.match(indexSource, /在庫差異\.tsvを選択/);
  assert.equal(indexSource.includes("ラベルマスタ.tsv"), false, "作業者向け表示を在庫差異.tsvへ統一");
  assert.match(styleSource, /--inventory-header:\s*#145a4e/);
  assert.match(styleSource, /--inventory-header-light:\s*#287263/);
  assert.match(styleSource, /background:\s*linear-gradient\(135deg, var\(--inventory-header\), var\(--inventory-header-light\)\)/);
  assert.equal(styleSource.includes("#4b1f66"), false, "旧紫色ヘッダーを残さない");
  assert.equal(indexSource.includes('rel="manifest"'), false, "manifest読込を削除する");
  assert.equal(indexSource.includes("apple-mobile-web-app"), false, "PWA用metaを削除する");
  assert.equal(indexSource.includes('rel="apple-touch-icon"'), false, "PWA用アイコン指定を削除する");
  assert.match(indexSource, /id="targetEndDate"/);
  assert.equal(indexSource.includes("targetStartDate"), false);
  assert.match(indexSource, /id="departmentSelect"/);
  assert.match(indexSource, /id="overallStatusButton"[^>]*>全体状況<\/button>/);
  assert.match(indexSource, /id="overallStatusDialog"[^>]*role="dialog"/);
  assert.match(appSource, /function getOverallProgress/);
  assert.match(appSource, /status\.textContent = department\.completed \? "完了" : "未完了"/);
  assert.match(styleSource, /@media \(max-width: 500px\)[\s\S]*\.overall-summary-grid \{ grid-template-columns: repeat\(2/);
  for (const section of ["checkSection", "unreadSection", "historySection", "masterSection"]) {
    assert.match(indexSource, new RegExp(`data-section="${section}"`));
    assert.match(styleSource, new RegExp(`tab-button\\[data-section="${section}"\\]`));
  }
  assert.match(indexSource, /棚卸<br class="mobile-break">チェック/);
  assert.match(indexSource, /データ<br class="mobile-break">出力/);
  assert.match(indexSource, /<h2 id="historyHeading">データ出力<\/h2>/);
  assert.match(indexSource, /id="outputList"/);
  assert.match(indexSource, /id="exportDataButton"/);
  assert.match(indexSource, /id="outputEndDate"/);
  assert.equal(indexSource.includes("historyStartDate"), false, "データ出力から開始日を削除");
  assert.equal(indexSource.includes('id="historyEndDate"'), false, "独立した終了日入力を削除");
  assert.equal(indexSource.includes("読取履歴"), false, "画面上の読取履歴表記を削除");
  assert.match(appSource, /confirmButton\.textContent = "確認済"/);
  assert.match(appSource, /reissueButton\.textContent = reissue \? "再発行対象" : "再発行"/);
  assert.match(appSource, /function switchSection/);
  assert.match(appSource, /function openHistoryDb/);
  assert.match(appSource, /function confirmUnreadLabel/);
  assert.match(appSource, /function toggleReissueLabel/);
  assert.match(appSource, /function isCompletionTransition/);
  assert.match(appSource, /playCompletionSound\(\)/);
  assert.match(appSource, /const records = getOutputRecords\(\);[\s\S]*shareOutputCsv\(records\)/, "CSVは画面絞込にかかわらず対象全件を出力する");
  assert.equal(appSource.includes("records.slice(0, 500)"), false, "データ出力画面へ対象全件を表示する");
  assert.match(appSource, /article\.append\(heading, specification, product, key, labelDate, department\)/, "未読取詳細を指定順で表示する");
  assert.match(styleSource, /\.unread-actions \.button \{ min-height: 48px/);
  assert.match(styleSource, /\.unread-reissue-button\.is-active/);
  assert.match(indexSource, /印刷プレビュー/);
  assert.match(indexSource, /id="reissueExtractButton"[^>]*>再発行ラベル抽出<\/button>/);
  assert.equal(indexSource.includes("executePrintButton"), false, "独自プレビューの印刷・共有ボタンを削除する");
  assert.equal(indexSource.includes("closePrintPreviewButton"), false, "独自プレビューの閉じるボタンを削除する");
  assert.equal(indexSource.includes("print-preview"), false, "独自プレビュー用HTMLを削除する");
  assert.deepEqual(PRINT_COLUMN_HEADERS, ["No.", "施設名 / 部署名", "商品コード", "商品名", "規格", "製品番号", "ラベルキー", "ラベル日付", "対応"]);
  assert.equal(indexSource.includes('id="printSheet"'), false, "旧HTML印刷帳票を削除する");
  assert.match(indexSource, /vendor\/pdf-lib\.min\.js/);
  assert.match(indexSource, /vendor\/fontkit\.umd\.min\.js/);
  assert.match(indexSource, /pdf-report\.js\?v=20260821-13/);
  assert.match(appSource, /function createPdfReportData/);
  assert.match(appSource, /function generateAndOpenPdf/);
  assert.match(appSource, /InventoryPdf\.generateInventoryPdf/);
  assert.match(appSource, /const pdfBlob = createPdfBlob\(result\.bytes\)/);
  assert.match(appSource, /new BlobRef\(\[pdfBytes\], \{ type: "application\/pdf" \}\)/);
  assert.match(appSource, /windowRef\.open\("about:blank", "_blank"\)/, "クリック時点でPDF表示先を確保する");
  assert.match(appSource, /displayPdfUrl\(previewWindow, pdfUrl\)/, "確保済み画面へPDFを表示する");
  assert.equal(appSource.includes("window.location.assign(pdfUrl)"), false, "現在タブをPDFへ遷移させない");
  assert.match(appSource, /elements\.printPreviewButton\.addEventListener\("click", \(event\) => \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*const previewWindow = openPdfLoadingWindow\(\);\s*void generateAndOpenPdf\(previewWindow\);\s*\}\)/, "クリック内で表示先を確保してPDF生成を開始する");
  assert.match(appSource, /PDFの生成または表示に失敗しました/);
  assert.equal(appSource.includes("window.print()"), false, "自動印刷を行わない");
  assert.equal(appSource.includes("openPrintPreview"), false, "独自プレビュー表示処理を削除する");
  assert.equal(appSource.includes("closePrintPreview"), false, "独自プレビュー終了処理を削除する");
  assert.equal(styleSource.includes("print-sheet.is-previewing"), false, "独自プレビュー用CSSを削除する");
  assert.equal(styleSource.includes("@media print"), false, "旧HTML印刷CSSを削除する");
  assert.match(appSource, /function getReissueTargetLabels/);
  assert.match(appSource, /state\.reissueFilterActive = false/);
  assert.match(appSource, /if \(sectionId !== "unreadSection" && state\.reissueFilterActive\) state\.reissueFilterActive = false/);
  assert.match(appSource, /再発行対象のラベルはありません/);
  assert.equal(getPrintRowValues(parsed.rows[0], 0)[2], "PC-A", "印刷データへ商品コードを指定順で追加する");
  const popupCalls = [];
  const popup = { document: { title: "", body: { textContent: "" } }, closed: false };
  assert.equal(openPdfLoadingWindow({ open: (...args) => { popupCalls.push(args); return popup; } }), popup);
  assert.deepEqual(popupCalls, [["about:blank", "_blank"]], "クリック時点でPDF表示先を新規タブへ確保する");
  assert.equal(popup.document.title, "棚卸くん PDF生成中");
  assert.match(popup.document.body.textContent, /PDFを生成しています/);
  assert.equal(openPdfLoadingWindow({ open: () => null }), null, "ポップアップが拒否された場合を検出する");
  const pdfBlob = createPdfBlob(new Uint8Array([37, 80, 68, 70]));
  assert.equal(pdfBlob.type, "application/pdf");
  assert.equal(pdfBlob.size, 4, "0バイトではないPDF Blobを生成する");
  assert.throws(() => createPdfBlob(new Uint8Array()), /0バイト/);
  const pdfWindow = { closed: false, location: { href: "about:blank" } };
  assert.equal(displayPdfUrl(pdfWindow, "blob:https://example.test/pdf"), true);
  assert.equal(pdfWindow.location.href, "blob:https://example.test/pdf", "確保済み画面へBlob URLを表示する");
  assert.throws(() => displayPdfUrl({ closed: true }, "blob:test"), /閉じられています/);
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  const unregistered = [];
  const removedCaches = [];
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { getRegistrations: async () => [
      { scope: "https://example.test/apps/inventory/", unregister: async () => { unregistered.push("inventory"); } },
      { scope: "https://example.test/apps/other/", unregister: async () => { unregistered.push("other"); } }
    ] } } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { baseURI: "https://example.test/apps/inventory/index.html" } });
    Object.defineProperty(globalThis, "caches", { configurable: true, value: {
      keys: async () => ["inventory-kun-v11", "unrelated-cache"],
      delete: async (name) => { removedCaches.push(name); return true; }
    } });
    await removeLegacyPwaArtifacts();
    assert.deepEqual(unregistered, ["inventory"], "棚卸くんの旧Service Workerだけを解除する");
    assert.deepEqual(removedCaches, ["inventory-kun-v11"], "棚卸くんの旧キャッシュだけを削除する");
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete globalThis.document;
    if (originalCaches) Object.defineProperty(globalThis, "caches", originalCaches); else delete globalThis.caches;
  }
  assert.match(appSource, /"ラベル再発行"/);
  assert.equal(indexSource.includes("SharePoint"), false, "SharePoint取得画面を削除");
  assert.equal(indexSource.includes("msal-browser"), false, "Microsoft認証ライブラリを削除");
  assert.equal(appSource.includes("GraphApiError"), false, "Graph取得処理を削除");
  assert.equal(appSource.includes("SHAREPOINT_"), false, "SharePoint設定を削除");
  assert.equal(indexSource.includes('id="scanInput"'), false, "非表示入力欄方式を削除");
  assert.match(appSource, /function handleGlobalKeydown/);
  assert.match(appSource, /window\.addEventListener\("keydown", handleGlobalKeydown\)/);
  assert.match(appSource, /sound\.muted = true/);
  assert.match(appSource, /elements\.departmentSelect\.blur\(\)/);
  assert.match(appSource, /showResult\("idle", "棚卸を開始できます"[\s\S]*playSuccessSound\(\)/);
  for (const removedText of ["オリコンラベル待ち", "商品バーコード待ち", "JANコード読取", "GS1-128", "SKIP"]) {
    assert.equal(indexSource.includes(removedText), false, `${removedText}を画面から削除`);
  }
  for (const removedFunction of ["parseContainerBarcode", "parseGs1Barcode", "validateProductBarcode", "executeSkip"]) {
    assert.equal(appSource.includes(`function ${removedFunction}`), false, `${removedFunction}をアプリから削除`);
  }
  assert.equal(indexSource.includes('id="refreshUnreadButton"'), false, "不要な更新ボタンを削除する");
  assert.equal(appSource.includes("refreshUnreadButton"), false, "不要な更新処理を削除する");
  assert.equal(appSource.includes("serviceWorker.register"), false, "Service Worker登録処理を削除する");
  assert.equal(fs.existsSync(path.join(root, "service-worker.js")), false, "Service Workerファイルを削除する");
  assert.equal(fs.existsSync(path.join(root, "manifest.webmanifest")), false, "manifestファイルを削除する");
  assert.match(appSource, /function removeLegacyPwaArtifacts/);
  assert.match(appSource, /registration\.scope === appScope/);
  assert.match(appSource, /name\.startsWith\("inventory-kun-"\)/);
  assert.ok(fs.existsSync(path.join(root, "ok.wav")));
  assert.ok(fs.existsSync(path.join(root, "alert.wav")));
  assert.ok(fs.existsSync(path.join(root, "complete.wav")));

  console.log("棚卸くん app tests: OK");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
