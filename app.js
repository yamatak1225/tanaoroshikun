"use strict";

const STORAGE_KEYS = { master: "inventory-kun-master-v2", state: "inventory-kun-state-v2" };
const HISTORY_DB_NAME = "inventory-kun-history-v1";
const HISTORY_STORE_NAME = "scanHistory";
const REQUIRED_HEADERS = ["施設コード", "施設名称", "部署コード", "部署名称", "品名", "規格", "製品番号", "ラベルキー", "払出予定伝票日付", "エラーメッセージ"];
const DEPARTMENT_SEPARATOR = "\u001f";

const state = {
  masterRows: [],
  masterInfo: null,
  labelIndex: new Map(),
  readLabelKeys: new Set(),
  confirmationMethods: new Map(),
  reissueLabelKeys: new Set(),
  targetEndDate: "",
  currentDepartment: null,
  history: [],
  scannerBuffer: "",
  scannerTimer: null
};

let elements = {};
let successSound = null;
let alertSound = null;
let completionSound = null;
let historyDbPromise = null;

function normalizeHeader(value) { return String(value ?? "").replace(/^\uFEFF/, "").trim(); }
function normalizeValue(value) { return String(value ?? "").trim(); }
function normalizeLabelKey(value) { return normalizeValue(value).replace(/\s+/g, ""); }

function splitTsvRecords(text) {
  const records = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.length === 0) quoted = true;
    else if (char === "\t") { row.push(cell); cell = ""; }
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) records.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (quoted) throw new Error("TSV内の引用符が閉じられていません。");
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((value) => value !== "")) records.push(row);
  }
  return records;
}

function isValidDateKey(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function parseTsv(text) {
  const records = splitTsvRecords(String(text ?? "").replace(/^\uFEFF/, ""));
  if (records.length < 2) throw new Error("TSVに見出し行またはデータ行がありません。");
  const headers = records[0].map(normalizeHeader);
  const duplicates = headers.filter((header, index) => header && headers.indexOf(header) !== index);
  if (duplicates.length) throw new Error(`同じ見出しが複数あります：${[...new Set(duplicates)].join("、")}`);
  const missing = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`必須列がありません：${missing.join("、")}`);

  const rows = [];
  const errors = [];
  let errorExcludedCount = 0;
  records.slice(1).forEach((record, recordIndex) => {
    const line = recordIndex + 2;
    if (record.length > headers.length && record.slice(headers.length).some((value) => normalizeValue(value))) {
      errors.push(`${line}行目：見出し数を超えるデータがあります。`);
      return;
    }
    const row = {};
    headers.forEach((header, index) => { if (header) row[header] = normalizeValue(record[index]); });
    // 在庫差異データ側でエラーになった行は、棚卸対象データへ入れる前に除外する。
    if (row["エラーメッセージ"] !== "") {
      errorExcludedCount += 1;
      return;
    }
    const emptyHeaders = REQUIRED_HEADERS.filter((header) => header !== "エラーメッセージ" && !row[header]);
    if (emptyHeaders.length) {
      errors.push(`${line}行目：必須項目が空欄です（${emptyHeaders.join("、")}）。`);
      return;
    }
    if (!isValidDateKey(row["払出予定伝票日付"])) {
      errors.push(`${line}行目：払出予定伝票日付「${row["払出予定伝票日付"]}」がyyyyMMdd形式の正しい日付ではありません。`);
      return;
    }
    row["ラベルキー"] = normalizeLabelKey(row["ラベルキー"]);
    row.__lineNumber = line;
    rows.push(row);
  });
  if (errors.length) throw new Error(`${errors.slice(0, 5).join("\n")}${errors.length > 5 ? `\nほか${errors.length - 5}件のエラーがあります。` : ""}`);
  if (!rows.length) throw new Error("有効なデータ行がありません。");
  return { headers, rows, errorExcludedCount };
}

function removeLeadingZeros(value) {
  const normalized = String(value).replace(/^0+/, "");
  return normalized || "0";
}

function buildLabelKey(first, second, third) {
  if (!/^\d{15}$/.test(first) || !/^\d{4}$/.test(second) || !/^\d{3}$/.test(third)) {
    throw new Error("QRのラベルキー部分が不正です。");
  }
  return [first, second, third].map(removeLeadingZeros).join("-");
}

function normalizeQr(rawValue) {
  const raw = normalizeValue(rawValue);
  if (!/^\d{32}$/.test(raw)) {
    return { ok: false, code: "QR_FORMAT", title: "SPDラベル形式エラー", message: "SPDラベルは数字32桁で読み取ってください。" };
  }
  try {
    return { ok: true, raw, centerCode: raw.slice(0, 10), labelKey: buildLabelKey(raw.slice(10, 25), raw.slice(25, 29), raw.slice(29, 32)) };
  } catch (error) {
    return { ok: false, code: "QR_FORMAT", title: "SPDラベル形式エラー", message: error.message };
  }
}

function getExpectedCenterCode(facilityName) {
  return new Set(["千葉白井病院", "湘南ﾘﾊﾋﾞﾘﾃｰｼｮﾝ病院"]).has(normalizeValue(facilityName)) ? "0000000002" : "0000000001";
}

function departmentKey(department) {
  if (!department) return "";
  return [department.facilityCode, department.facilityName, department.departmentCode, department.departmentName].join(DEPARTMENT_SEPARATOR);
}

function departmentFromRow(row) {
  return {
    facilityCode: row["施設コード"],
    facilityName: row["施設名称"],
    departmentCode: row["部署コード"],
    departmentName: row["部署名称"]
  };
}

function rebuildIndexes() {
  state.labelIndex = new Map();
  state.masterRows.forEach((row) => {
    const key = row["ラベルキー"];
    if (!state.labelIndex.has(key)) state.labelIndex.set(key, []);
    state.labelIndex.get(key).push(row);
  });
}

function findLabel(labelKey) {
  const candidates = state.labelIndex.get(normalizeLabelKey(labelKey)) || [];
  if (!candidates.length) return { ok: false, code: "NOT_FOUND", candidates };
  if (candidates.length > 1) return { ok: false, code: "AMBIGUOUS_LABEL", candidates };
  return { ok: true, row: candidates[0] };
}

function parseDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function validateTargetEndDate(value = state.targetEndDate) {
  if (!value) return { ok: false, code: "END_REQUIRED", message: "対象終了日を指定してください。" };
  if (!parseDateInput(value)) return { ok: false, code: "END_INVALID", message: "対象終了日が正しくありません。" };
  return { ok: true, dateKey: value.replaceAll("-", "") };
}

function isRowOnOrBeforeEndDate(row, endValue = state.targetEndDate) {
  const validation = validateTargetEndDate(endValue);
  return Boolean(validation.ok && isValidDateKey(row?.["払出予定伝票日付"]) && row["払出予定伝票日付"] <= validation.dateKey);
}

function matchesDepartment(row, department = state.currentDepartment) {
  return Boolean(department
    && row["施設コード"] === department.facilityCode
    && row["施設名称"] === department.facilityName
    && row["部署コード"] === department.departmentCode
    && row["部署名称"] === department.departmentName);
}

function getEligibleDepartments(rows = state.masterRows) {
  if (!validateTargetEndDate().ok) return [];
  const unique = new Map();
  rows.filter((row) => isRowOnOrBeforeEndDate(row)).forEach((row) => {
    const department = departmentFromRow(row);
    const key = departmentKey(department);
    if (!unique.has(key)) unique.set(key, department);
  });
  return [...unique.values()].sort((left, right) => `${left.facilityName}\u0000${left.departmentName}`.localeCompare(`${right.facilityName}\u0000${right.departmentName}`, "ja"));
}

function getUniqueLabelRows(rows) {
  const unique = new Map();
  rows.forEach((row) => { if (!unique.has(row["ラベルキー"])) unique.set(row["ラベルキー"], row); });
  return [...unique.values()];
}

function getCurrentTargetLabels() {
  if (!state.currentDepartment || !validateTargetEndDate().ok) return [];
  return getUniqueLabelRows(state.masterRows.filter((row) => isRowOnOrBeforeEndDate(row) && matchesDepartment(row)));
}

function getUnreadLabels() {
  return getCurrentTargetLabels().filter((row) => !state.readLabelKeys.has(row["ラベルキー"]));
}

function getOutputTargetLabels() {
  if (!validateTargetEndDate().ok) return [];
  return state.masterRows.filter((row) => isRowOnOrBeforeEndDate(row));
}

function getTargetCounts() {
  const targets = getCurrentTargetLabels();
  const read = targets.filter((row) => state.readLabelKeys.has(row["ラベルキー"])).length;
  return { target: targets.length, read, unread: targets.length - read };
}

function validateSpdLabel(rawValue) {
  if (!state.masterInfo || !state.masterRows.length) {
    return { ok: false, code: "NO_MASTER", title: "マスター未読込", message: "先に在庫差異.tsvを読み込んでください。" };
  }
  const endDate = validateTargetEndDate();
  if (!endDate.ok) return { ok: false, code: endDate.code, title: "対象終了日エラー", message: endDate.message };
  if (!state.currentDepartment) {
    return { ok: false, code: "NO_DEPARTMENT", title: "部署未選択", message: "棚卸する施設・部署を選択してください。" };
  }
  const parsed = normalizeQr(rawValue);
  if (!parsed.ok) return parsed;
  const found = findLabel(parsed.labelKey);
  if (found.code === "NOT_FOUND") {
    return { ok: false, code: "NOT_FOUND", title: "マスター未登録", message: "このSPDラベルは在庫差異.tsvに存在しません。", labelKey: parsed.labelKey };
  }
  if (found.code === "AMBIGUOUS_LABEL") {
    return { ok: false, code: "AMBIGUOUS_LABEL", title: "ラベルキー重複", message: "同じラベルキーがマスターに複数あります。マスターを確認してください。", labelKey: parsed.labelKey };
  }
  const row = found.row;
  const expectedCenterCode = getExpectedCenterCode(row["施設名称"]);
  if (parsed.centerCode !== expectedCenterCode) {
    return { ok: false, code: "CENTER_MISMATCH", title: "センターコード不一致", message: "SPDラベルのセンターコードが対象施設と一致しません。", labelKey: parsed.labelKey, row, scannedCenterCode: parsed.centerCode, expectedCenterCode };
  }
  if (!matchesDepartment(row)) {
    return {
      ok: false,
      code: "DEPARTMENT_MISMATCH",
      title: "選択している部署と異なるSPDラベルです",
      message: "このラベルは読取済にしていません。正しい部署を確認してください。",
      labelKey: parsed.labelKey,
      row,
      selectedDepartment: state.currentDepartment
    };
  }
  if (!isRowOnOrBeforeEndDate(row)) {
    return { ok: false, code: "OUTSIDE_PERIOD", title: "対象終了日より後のラベルです", message: `払出予定伝票日付：${formatMasterDate(row["払出予定伝票日付"])} ／ 対象終了日：${formatDateForDisplay(state.targetEndDate)}`, labelKey: parsed.labelKey, row };
  }
  if (state.readLabelKeys.has(parsed.labelKey)) {
    return { ok: false, code: "DUPLICATE", title: "このSPDラベルは読取済です", message: "二重計上していません。次のSPDラベルを読み取ってください。", labelKey: parsed.labelKey, row };
  }
  return { ok: true, code: "SPD_OK", title: "読取完了", message: "SPDラベルを読取済にしました。", raw: parsed.raw, labelKey: parsed.labelKey, row };
}

function acceptSpdLabel(rawValue) {
  const result = validateSpdLabel(rawValue);
  if (!result.ok) return result;
  state.readLabelKeys.add(result.labelKey);
  state.confirmationMethods.set(result.labelKey, "バーコード");
  saveState();
  return { ...result, confirmationMethod: "バーコード", counts: getTargetCounts() };
}

function confirmUnreadLabel(labelKey) {
  const normalizedKey = normalizeLabelKey(labelKey);
  const row = getCurrentTargetLabels().find((candidate) => candidate["ラベルキー"] === normalizedKey);
  if (!row) return { ok: false, code: "NOT_TARGET", title: "確認対象外", message: "現在選択中の部署の未読取ラベルではありません。", labelKey: normalizedKey };
  if (state.readLabelKeys.has(normalizedKey)) return { ok: false, code: "DUPLICATE", title: "確認済です", message: "このラベルはすでに読取済です。", labelKey: normalizedKey, row };
  state.readLabelKeys.add(normalizedKey);
  state.confirmationMethods.set(normalizedKey, "手動確認");
  saveState();
  return { ok: true, code: "MANUAL_OK", title: "確認完了", message: "現物確認により読取済にしました。", labelKey: normalizedKey, row, confirmationMethod: "手動確認", counts: getTargetCounts() };
}

function toggleReissueLabel(labelKey) {
  const normalizedKey = normalizeLabelKey(labelKey);
  if (!getCurrentTargetLabels().some((row) => row["ラベルキー"] === normalizedKey)) return false;
  if (state.reissueLabelKeys.has(normalizedKey)) state.reissueLabelKeys.delete(normalizedKey);
  else state.reissueLabelKeys.add(normalizedKey);
  saveState();
  return state.reissueLabelKeys.has(normalizedKey);
}

function isCompletionTransition(beforeCounts, afterCounts) {
  return Boolean(beforeCounts?.unread > 0 && afterCounts?.target > 0 && afterCounts.unread === 0);
}

function todayInputValue() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function formatDateForDisplay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || "") ? value.replaceAll("-", "/") : "―";
}

function formatMasterDate(value) {
  return isValidDateKey(value || "") ? `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}` : "―";
}

function formatLocalDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "―" : new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function createHistoryRecord(scanResult, rawValue, now = new Date()) {
  const row = scanResult.row || {};
  const selected = scanResult.selectedDepartment || state.currentDepartment || {};
  const eventAt = now.toISOString();
  return {
    eventAt,
    completedAt: scanResult.ok ? eventAt : "",
    facilityCode: row["施設コード"] || selected.facilityCode || "",
    facilityName: row["施設名称"] || selected.facilityName || "",
    departmentCode: row["部署コード"] || selected.departmentCode || "",
    departmentName: row["部署名称"] || selected.departmentName || "",
    plannedDate: row["払出予定伝票日付"] || "",
    labelKey: scanResult.labelKey || "",
    productNumber: row["製品番号"] || "",
    productName: row["品名"] || "",
    confirmationMethod: scanResult.confirmationMethod || "",
    spdRaw: normalizeValue(rawValue),
    result: scanResult.ok ? "OK" : "NG",
    detail: scanResult.title || scanResult.code || (scanResult.ok ? "読取完了" : "読取エラー")
  };
}

function openHistoryDb(indexedDbRef = globalThis.indexedDB) {
  if (!indexedDbRef) return Promise.resolve(null);
  if (historyDbPromise) return historyDbPromise;
  historyDbPromise = new Promise((resolve, reject) => {
    const request = indexedDbRef.open(HISTORY_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        const store = db.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("eventAt", "eventAt");
        store.createIndex("result", "result");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return historyDbPromise;
}

async function saveScanHistory(record) {
  state.history.push(record);
  try {
    const db = await openHistoryDb();
    if (db) {
      await new Promise((resolve, reject) => {
        const request = db.transaction(HISTORY_STORE_NAME, "readwrite").objectStore(HISTORY_STORE_NAME).add(record);
        request.onsuccess = () => { record.id = request.result; resolve(); };
        request.onerror = () => reject(request.error);
      });
    }
  } catch (error) {
    console.error("棚卸操作記録を保存できません。", error);
  }
  return record;
}

async function loadScanHistory() {
  try {
    const db = await openHistoryDb();
    if (db) {
      state.history = await new Promise((resolve, reject) => {
        const request = db.transaction(HISTORY_STORE_NAME, "readonly").objectStore(HISTORY_STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    }
  } catch (error) {
    console.error("棚卸操作記録を読み込めません。", error);
  }
  return state.history;
}

async function clearScanHistory() {
  const db = await openHistoryDb();
  if (db) {
    await new Promise((resolve, reject) => {
      const request = db.transaction(HISTORY_STORE_NAME, "readwrite").objectStore(HISTORY_STORE_NAME).clear();
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
  }
  state.history = [];
}

function createOutputRecord(row) {
  const labelKey = row["ラベルキー"];
  const read = state.readLabelKeys.has(labelKey);
  return {
    productCode: row["商品コード"] || "",
    manufacturerName: row["メーカー名"] || "",
    productName: row["品名"] || "",
    specification: row["規格"] || "",
    productNumber: row["製品番号"] || "",
    labelKey,
    labelDate: formatMasterDate(row["払出予定伝票日付"]),
    expirationDate: row["有効期限"] || "",
    lotNumber: row["ロット番号"] || "",
    facilityCode: row["施設コード"] || "",
    facilityName: row["施設名称"] || "",
    departmentCode: row["部署コード"] || "",
    departmentName: row["部署名称"] || "",
    readStatus: read ? "読取済" : "未読取",
    confirmationMethod: read ? state.confirmationMethods.get(labelKey) || "" : "",
    reissueStatus: state.reissueLabelKeys.has(labelKey) ? "再発行" : ""
  };
}

function getOutputRecords() {
  return getOutputTargetLabels().map(createOutputRecord);
}

function filterOutputRecords(records, filters = {}) {
  const search = normalizeValue(filters.search).toLowerCase();
  return records.filter((record) => {
    if (filters.facility && record.facilityName !== filters.facility) return false;
    if (filters.department && record.departmentName !== filters.department) return false;
    if (filters.readStatus && record.readStatus !== filters.readStatus) return false;
    return !search || [record.productCode, record.manufacturerName, record.productNumber, record.productName, record.specification, record.labelKey].join(" ").toLowerCase().includes(search);
  });
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function buildOutputCsv(records) {
  const columns = [
    ["商品コード", "productCode"], ["メーカー名", "manufacturerName"], ["商品名", "productName"], ["規格", "specification"],
    ["製品番号", "productNumber"], ["ラベルキー", "labelKey"], ["ラベル日付", "labelDate"], ["有効期限", "expirationDate"],
    ["ロット番号", "lotNumber"], ["施設コード", "facilityCode"], ["施設名", "facilityName"], ["部署コード", "departmentCode"],
    ["部署名", "departmentName"], ["読取済区分", "readStatus"], ["確認方法", "confirmationMethod"], ["ラベル再発行区分", "reissueStatus"]
  ];
  return [columns.map(([label]) => csvEscape(label)).join(","), ...records.map((record) => columns.map(([, key]) => csvEscape(record[key])).join(","))].join("\r\n");
}

function createOutputCsvFile(records) {
  return new File(["\uFEFF", buildOutputCsv(records)], `棚卸くん_棚卸データ_${todayInputValue().replaceAll("-", "")}.csv`, { type: "text/csv;charset=utf-8" });
}

function downloadFile(file, documentRef = document) {
  const url = URL.createObjectURL(file);
  const anchor = documentRef.createElement("a");
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shareOutputCsv(records, env = {}) {
  if (!records.length) throw new Error("出力対象の棚卸データがありません。");
  const navigatorRef = env.navigatorRef || navigator;
  const documentRef = env.documentRef || document;
  const file = createOutputCsvFile(records);
  if (navigatorRef.canShare?.({ files: [file] }) && navigatorRef.share) {
    await navigatorRef.share({ title: "棚卸くん 棚卸データ", text: "棚卸くんの対象ラベル全件CSVです。", files: [file] });
    return "shared";
  }
  downloadFile(file, documentRef);
  return "downloaded";
}

function createFingerprint(name, size, lastModified, rows) {
  return `${name}:${size}:${lastModified}:${rows.length}:${rows[0]?.["ラベルキー"] || ""}:${rows.at(-1)?.["ラベルキー"] || ""}`;
}

function saveMaster() {
  if (typeof localStorage === "undefined" || !state.masterRows.length) return false;
  const headers = Object.keys(state.masterRows[0]).filter((header) => header !== "__lineNumber");
  const records = state.masterRows.map((row) => headers.map((header) => row[header] ?? ""));
  try {
    localStorage.setItem(STORAGE_KEYS.master, JSON.stringify({ formatVersion: 1, headers, records, info: state.masterInfo }));
    return true;
  } catch (error) {
    console.error("マスターをブラウザへ保存できません。", error);
    return false;
  }
}

function saveState() {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEYS.state, JSON.stringify({
      masterFingerprint: state.masterInfo?.fingerprint || null,
      readLabelKeys: [...state.readLabelKeys],
      confirmationMethods: [...state.confirmationMethods],
      reissueLabelKeys: [...state.reissueLabelKeys],
      targetEndDate: state.targetEndDate,
      currentDepartment: state.currentDepartment
    }));
    return true;
  } catch (error) {
    console.error("棚卸状態をブラウザへ保存できません。", error);
    return false;
  }
}

function restoreState() {
  state.targetEndDate = todayInputValue();
  if (typeof localStorage === "undefined") return;
  try {
    const savedMaster = JSON.parse(localStorage.getItem(STORAGE_KEYS.master) || "null");
    if (savedMaster?.headers && Array.isArray(savedMaster.records) && savedMaster.info) {
      state.masterRows = savedMaster.records.map((record, index) => {
        const row = { __lineNumber: index + 2 };
        savedMaster.headers.forEach((header, column) => { row[header] = record[column] ?? ""; });
        return row;
      });
      state.masterInfo = savedMaster.info;
      rebuildIndexes();
    }
  } catch (error) {
    console.error("保存済みマスターを読み込めません。", error);
  }
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.state) || "null");
    if (saved?.targetEndDate && parseDateInput(saved.targetEndDate)) state.targetEndDate = saved.targetEndDate;
    if (saved && saved.masterFingerprint === state.masterInfo?.fingerprint) {
      state.readLabelKeys = new Set(Array.isArray(saved.readLabelKeys) ? saved.readLabelKeys.map(normalizeLabelKey) : []);
      state.confirmationMethods = new Map(Array.isArray(saved.confirmationMethods) ? saved.confirmationMethods.map(([key, method]) => [normalizeLabelKey(key), method]) : []);
      state.readLabelKeys.forEach((key) => { if (!state.confirmationMethods.has(key)) state.confirmationMethods.set(key, "バーコード"); });
      state.reissueLabelKeys = new Set(Array.isArray(saved.reissueLabelKeys) ? saved.reissueLabelKeys.map(normalizeLabelKey) : []);
      state.currentDepartment = saved.currentDepartment || null;
    }
  } catch (error) {
    console.error("保存済み棚卸状態を読み込めません。", error);
  }
  if (state.currentDepartment && !getEligibleDepartments().some((department) => departmentKey(department) === departmentKey(state.currentDepartment))) {
    state.currentDepartment = null;
  }
}

function decodeMasterBuffer(arrayBuffer) {
  try {
    return new TextDecoder("shift-jis", { fatal: true }).decode(arrayBuffer);
  } catch {
    throw new Error("TSVをCP932（Shift-JIS系）として読み込めませんでした。文字コードを確認してください。");
  }
}

function applyMasterData(rows, sourceInfo, now = new Date()) {
  state.masterRows = rows;
  state.masterInfo = {
    ...sourceInfo,
    importedAt: now.toISOString(),
    rowCount: rows.length,
    fingerprint: createFingerprint(sourceInfo.fileName, sourceInfo.size, sourceInfo.lastModified, rows)
  };
  state.targetEndDate = todayInputValue();
  state.currentDepartment = null;
  state.readLabelKeys = new Set();
  state.confirmationMethods = new Map();
  state.reissueLabelKeys = new Set();
  rebuildIndexes();
  const masterSaved = saveMaster();
  saveState();
  return { masterSaved, rowCount: rows.length, errorExcludedCount: sourceInfo.errorExcludedCount || 0 };
}

async function importLocalMaster(file) {
  if (!file || !/\.tsv$/i.test(file.name)) throw new Error("拡張子が.tsvのファイルを選択してください。");
  const text = decodeMasterBuffer(await file.arrayBuffer());
  const parsed = parseTsv(text);
  return applyMasterData(parsed.rows, {
    fileName: file.name,
    size: file.size,
    lastModified: file.lastModified,
    source: "端末ファイル",
    errorExcludedCount: parsed.errorExcludedCount
  });
}

function initAudio() {
  if (typeof Audio === "undefined") return;
  if (!successSound) { successSound = new Audio("ok.wav"); successSound.preload = "auto"; }
  if (!alertSound) { alertSound = new Audio("alert.wav"); alertSound.preload = "auto"; }
  if (!completionSound) { completionSound = new Audio("complete.wav"); completionSound.preload = "auto"; }
  successSound.load();
  alertSound.load();
  completionSound.load();
}

async function unlockAudio() {
  initAudio();
  const sounds = [successSound, alertSound, completionSound].filter(Boolean);
  if (sounds.length !== 3) {
    elements.audioStatus.textContent = "有効化できません";
    return false;
  }
  try {
    sounds.forEach((sound) => { sound.muted = true; });
    await Promise.all(sounds.map((sound) => sound.play()));
    sounds.forEach((sound) => { sound.pause(); sound.currentTime = 0; sound.muted = false; });
    elements.audioStatus.textContent = "有効";
    return true;
  } catch (error) {
    sounds.forEach((sound) => { sound.pause(); sound.currentTime = 0; sound.muted = false; });
    elements.audioStatus.textContent = "有効化できません";
    console.error("音声の有効化に失敗しました。", error);
    return false;
  }
}

function playSound(sound) {
  if (!sound) initAudio();
  const target = sound === "success" ? successSound : sound === "completion" ? completionSound : alertSound;
  if (!target) return;
  target.currentTime = 0;
  target.play().catch(() => {
    if (elements.audioStatus) elements.audioStatus.textContent = "音声：有効化ボタンを押してください";
  });
}

function playSuccessSound() { playSound("success"); }
function playAlertSound() { playSound("alert"); }
function playCompletionSound() { playSound("completion"); }

function cacheElements() {
  const ids = [
    "masterStatusBadge", "masterSummary", "masterFile", "enableAudioButton", "audioStatus", "importMessage",
    "masterLoaded", "masterFileName", "masterFacilityName", "masterSource", "masterImportedAt", "masterRowCount", "masterErrorExcludedCount", "masterMaxDate",
    "targetEndDate", "periodError", "departmentSelect", "currentFacility", "currentDepartment", "currentDepartmentCode", "targetCount", "readCount", "unreadCount",
    "resultPanel", "modeStatus", "resultTitle", "resultMessage", "resultDetails", "scannerBufferStatus", "manualScanInput", "manualScanButton",
    "refreshUnreadButton", "printPreviewButton", "unreadPeriodLabel", "unreadDepartmentLabel", "unreadTargetCount", "unreadReadCount", "unreadRemainingCount", "unreadActionMessage", "unreadList",
    "outputEndDate", "outputFacility", "outputDepartment", "outputReadStatus", "outputSearch", "outputCount", "outputList", "exportDataButton", "outputMessage",
    "printSheet", "printDateTime", "printEndDate", "printFacility", "printDepartment", "printCounts", "printTableBody"
  ];
  elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
}

function showImportMessage(message, kind = "") {
  elements.importMessage.textContent = message;
  elements.importMessage.className = `import-message${kind ? ` is-${kind}` : ""}`;
}

function resultDetailsFor(result) {
  const details = [];
  if (result.labelKey) details.push(["ラベルキー", result.labelKey]);
  if (result.row) {
    details.push(["読取ラベル", `${result.row["施設名称"]} / ${result.row["部署名称"]}`]);
    details.push(["品名", result.row["品名"]]);
  }
  if (result.selectedDepartment) details.unshift(["現在選択中", `${result.selectedDepartment.facilityName} / ${result.selectedDepartment.departmentName}`]);
  if (result.scannedCenterCode) details.push(["センターコード", `読取 ${result.scannedCenterCode} / 正 ${result.expectedCenterCode}`]);
  return details;
}

function showResult(kind, title, message, details = []) {
  elements.resultPanel.className = `result-panel result-panel--${kind}`;
  elements.resultTitle.textContent = title;
  elements.resultMessage.textContent = message;
  elements.resultDetails.replaceChildren();
  details.forEach(([label, value]) => {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    wrapper.append(term, description);
    elements.resultDetails.append(wrapper);
  });
}

function renderMaster() {
  const loaded = Boolean(state.masterInfo && state.masterRows.length);
  elements.masterStatusBadge.textContent = loaded ? "マスター読込済" : "マスター未読込";
  elements.masterStatusBadge.className = `status-badge status-badge--${loaded ? "ok" : "ng"}`;
  elements.masterSummary.textContent = loaded
    ? `${state.masterInfo.fileName} ／ ${state.masterInfo.rowCount.toLocaleString("ja-JP")}件 ／ ${state.masterInfo.source} ／ ${formatLocalDateTime(state.masterInfo.importedAt)}`
    : "在庫差異.tsvを読み込んでください。";
  const facilities = [...new Set(state.masterRows.map((row) => row["施設名称"]).filter(Boolean))];
  const maxDate = state.masterRows.reduce((maximum, row) => row["払出予定伝票日付"] > maximum ? row["払出予定伝票日付"] : maximum, "");
  elements.masterLoaded.textContent = loaded ? "読込済み" : "未読込";
  elements.masterFileName.textContent = state.masterInfo?.fileName || "―";
  elements.masterFacilityName.textContent = loaded ? (facilities.length <= 3 ? facilities.join("、") : `${facilities.length}施設`) : "―";
  elements.masterSource.textContent = state.masterInfo?.source || "―";
  elements.masterImportedAt.textContent = formatLocalDateTime(state.masterInfo?.importedAt);
  elements.masterRowCount.textContent = `${state.masterInfo?.rowCount || 0}件`;
  elements.masterErrorExcludedCount.textContent = `${state.masterInfo?.errorExcludedCount || 0}件`;
  elements.masterMaxDate.textContent = maxDate ? formatMasterDate(maxDate) : "―";
}

function renderDepartmentOptions() {
  const previous = departmentKey(state.currentDepartment);
  const departments = getEligibleDepartments();
  elements.departmentSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.masterRows.length ? (departments.length ? "施設・部署を選択してください" : "対象終了日以前の部署がありません") : "マスターを読み込んでください";
  elements.departmentSelect.append(placeholder);
  departments.forEach((department) => {
    const option = document.createElement("option");
    option.value = departmentKey(department);
    option.textContent = `${department.facilityName} / ${department.departmentName}`;
    elements.departmentSelect.append(option);
  });
  elements.departmentSelect.disabled = !departments.length;
  if (previous && departments.some((department) => departmentKey(department) === previous)) {
    elements.departmentSelect.value = previous;
  } else if (state.currentDepartment) {
    state.currentDepartment = null;
    saveState();
  }
}

function renderDepartment() {
  elements.currentFacility.textContent = state.currentDepartment?.facilityName || "施設未選択";
  elements.currentDepartment.textContent = state.currentDepartment?.departmentName || "部署を選択してください";
  elements.currentDepartmentCode.textContent = `施設コード：${state.currentDepartment?.facilityCode || "―"}　部署コード：${state.currentDepartment?.departmentCode || "―"}`;
}

function renderCounts() {
  const counts = getTargetCounts();
  elements.targetCount.textContent = counts.target;
  elements.readCount.textContent = counts.read;
  elements.unreadCount.textContent = counts.unread;
  elements.unreadTargetCount.textContent = counts.target;
  elements.unreadReadCount.textContent = counts.read;
  elements.unreadRemainingCount.textContent = counts.unread;
}

function renderScanner() {
  const ready = Boolean(state.masterRows.length && state.currentDepartment && validateTargetEndDate().ok);
  elements.scannerBufferStatus.textContent = state.scannerBuffer
    ? `Bluetoothリーダー入力中（${state.scannerBuffer.length}文字）`
    : ready ? "Bluetoothリーダー入力待機中" : "部署選択後に読取できます";
  elements.modeStatus.textContent = ready ? "● SPDラベル待ち" : state.masterRows.length ? "● 部署選択待ち" : "● マスター待ち";
  elements.modeStatus.className = `mode-status ${ready ? "mode-status--spd" : "mode-status--container"}`;
  elements.printPreviewButton.disabled = !state.currentDepartment || !validateTargetEndDate().ok;
}

function createUnreadItem(row, index) {
  const article = document.createElement("article");
  const labelKey = row["ラベルキー"];
  const reissue = state.reissueLabelKeys.has(labelKey);
  article.className = `unread-item${reissue ? " unread-item--reissue" : ""}`;
  const heading = document.createElement("h3");
  heading.textContent = `${index + 1}. ${row["品名"]}`;
  const specification = document.createElement("p");
  specification.className = "item-specification";
  specification.textContent = `規格：${row["規格"] || "―"}`;
  const product = document.createElement("p");
  product.className = "item-product";
  product.textContent = `製品番号：${row["製品番号"] || "―"}`;
  const key = document.createElement("p");
  key.className = "item-key";
  key.textContent = `ラベルキー：${labelKey}`;
  const labelDate = document.createElement("p");
  labelDate.textContent = `ラベル日付：${formatMasterDate(row["払出予定伝票日付"])}`;
  const department = document.createElement("p");
  department.textContent = `${row["施設名称"]} ／ ${row["部署名称"]}`;
  const actions = document.createElement("div");
  actions.className = "unread-actions";
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "button unread-confirm-button";
  confirmButton.dataset.action = "confirm";
  confirmButton.dataset.labelKey = labelKey;
  confirmButton.textContent = "確認済";
  const reissueButton = document.createElement("button");
  reissueButton.type = "button";
  reissueButton.className = `button unread-reissue-button${reissue ? " is-active" : ""}`;
  reissueButton.dataset.action = "reissue";
  reissueButton.dataset.labelKey = labelKey;
  reissueButton.setAttribute("aria-pressed", String(reissue));
  reissueButton.textContent = reissue ? "再発行対象" : "再発行";
  actions.append(confirmButton, reissueButton);
  article.append(heading, specification, product, key, labelDate, department, actions);
  return article;
}

function renderUnreadList() {
  const unread = getUnreadLabels();
  const counts = getTargetCounts();
  elements.unreadList.replaceChildren();
  if (!state.currentDepartment) {
    elements.unreadPeriodLabel.textContent = `対象終了日：${formatDateForDisplay(state.targetEndDate)}まで`;
    elements.unreadDepartmentLabel.textContent = "対象部署：指定なし";
    elements.unreadList.append(createEmptyState("棚卸チェックで対象部署を選択してください。"));
    return;
  }
  elements.unreadPeriodLabel.textContent = `対象終了日：${formatDateForDisplay(state.targetEndDate)}まで`;
  elements.unreadDepartmentLabel.textContent = `対象部署：${state.currentDepartment.facilityName} ／ ${state.currentDepartment.departmentName}`;
  if (!unread.length) {
    elements.unreadList.append(createEmptyState(counts.target ? "未読取のSPDラベルはありません。" : "対象終了日以前のSPDラベルはありません。"));
    return;
  }
  const fragment = document.createDocumentFragment();
  unread.forEach((row, index) => fragment.append(createUnreadItem(row, index)));
  elements.unreadList.append(fragment);
}

function createEmptyState(message) {
  const empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function getOutputFiltersFromUi() {
  return {
    facility: elements.outputFacility.value,
    department: elements.outputDepartment.value,
    readStatus: elements.outputReadStatus.value,
    search: elements.outputSearch.value
  };
}

function updateOutputFilterOptions(records) {
  const setOptions = (select, values, label) => {
    const current = select.value;
    select.replaceChildren(new Option(label, ""), ...[...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja")).map((value) => new Option(value, value)));
    select.value = current;
  };
  setOptions(elements.outputFacility, records.map((record) => record.facilityName), "すべての施設");
  setOptions(elements.outputDepartment, records.map((record) => record.departmentName), "すべての部署");
}

function renderOutputData() {
  if (!elements.outputList) return;
  elements.outputEndDate.textContent = formatDateForDisplay(state.targetEndDate);
  const allRecords = getOutputRecords();
  updateOutputFilterOptions(allRecords);
  const records = filterOutputRecords(allRecords, getOutputFiltersFromUi());
  elements.outputCount.textContent = `${records.length}件`;
  elements.outputList.replaceChildren();
  if (!records.length) {
    elements.outputList.append(createEmptyState("条件に該当する棚卸データはありません。"));
    return;
  }
  records.forEach((record) => {
    const article = document.createElement("article");
    article.className = `history-item history-item--${record.readStatus === "読取済" ? "ok" : "unread"}`;
    const heading = document.createElement("div");
    heading.className = "history-item-heading";
    const result = document.createElement("strong");
    result.textContent = record.readStatus;
    const method = document.createElement("span");
    method.textContent = [record.confirmationMethod, record.reissueStatus].filter(Boolean).join(" ／ ") || "未確認";
    heading.append(result, method);
    const title = document.createElement("h3");
    title.textContent = `${record.productName || "―"}　${record.specification || ""}`;
    const place = document.createElement("p");
    place.textContent = `${record.facilityName || "―"} ／ ${record.departmentName || "―"}`;
    const detail = document.createElement("p");
    detail.className = "item-key";
    detail.textContent = `製品番号：${record.productNumber || "―"}　ラベル：${record.labelKey || "―"}　日付：${record.labelDate}`;
    article.append(heading, title, place, detail);
    elements.outputList.append(article);
  });
}

function renderAll() {
  elements.targetEndDate.value = state.targetEndDate;
  const period = validateTargetEndDate();
  elements.periodError.textContent = period.ok ? "" : period.message;
  renderMaster();
  renderDepartmentOptions();
  renderDepartment();
  renderCounts();
  renderScanner();
  renderUnreadList();
  renderOutputData();
}

function switchSection(sectionId) {
  document.querySelectorAll(".screen").forEach((section) => section.classList.toggle("is-active", section.id === sectionId));
  document.querySelectorAll(".tab-button").forEach((button) => button.classList.toggle("is-active", button.dataset.section === sectionId));
  if (sectionId === "unreadSection") renderUnreadList();
  if (sectionId === "historySection") renderOutputData();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// SPD出荷チェッカーと同じく、HIDリーダーのキー入力を画面全体で蓄積しEnterで確定する。
function handleGlobalKeydown(event) {
  const ignored = [
    elements.manualScanInput, elements.targetEndDate, elements.masterFile,
    elements.outputSearch, elements.outputFacility, elements.outputDepartment, elements.outputReadStatus,
    elements.departmentSelect
  ];
  if (ignored.includes(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Enter") {
    if (state.scannerBuffer) {
      event.preventDefault();
      const scan = state.scannerBuffer;
      state.scannerBuffer = "";
      clearTimeout(state.scannerTimer);
      renderScanner();
      void processScan(scan);
    }
    return;
  }
  if (event.key.length === 1) {
    state.scannerBuffer += event.key;
    clearTimeout(state.scannerTimer);
    state.scannerTimer = setTimeout(() => {
      state.scannerBuffer = "";
      renderScanner();
    }, 1500);
    renderScanner();
  }
}

async function processScan(rawValue) {
  const beforeCounts = getTargetCounts();
  const result = acceptSpdLabel(rawValue);
  void saveScanHistory(createHistoryRecord(result, rawValue));
  if (result.ok) {
    if (isCompletionTransition(beforeCounts, result.counts)) playCompletionSound();
    else playSuccessSound();
    showResult("ok", result.title, `${result.message}　未読取 ${result.counts.unread}件`, resultDetailsFor(result));
  } else {
    playAlertSound();
    showResult("ng", result.title, result.message, resultDetailsFor(result));
  }
  renderCounts();
  renderUnreadList();
  renderOutputData();
  return result;
}

function getPrintRowValues(row, index) {
  return [
    String(index + 1), row["品名"], row["規格"] || "―", row["製品番号"] || "―", row["ラベルキー"],
    formatMasterDate(row["払出予定伝票日付"]), `${row["施設名称"]} / ${row["部署名称"]}`,
    state.reissueLabelKeys.has(row["ラベルキー"]) ? "ラベル再発行" : ""
  ];
}

function preparePrintSheet(now = new Date()) {
  if (!state.currentDepartment) return false;
  const counts = getTargetCounts();
  const unread = getUnreadLabels();
  elements.printDateTime.textContent = formatLocalDateTime(now);
  elements.printEndDate.textContent = `${formatDateForDisplay(state.targetEndDate)} まで`;
  elements.printFacility.textContent = state.currentDepartment.facilityName;
  elements.printDepartment.textContent = state.currentDepartment.departmentName;
  elements.printCounts.textContent = `対象 ${counts.target}件　読取済 ${counts.read}件　未読取 ${counts.unread}件`;
  elements.printTableBody.replaceChildren();
  unread.forEach((row, index) => {
    const tr = document.createElement("tr");
    getPrintRowValues(row, index).forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    });
    elements.printTableBody.append(tr);
  });
  return true;
}

function bindEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => button.addEventListener("click", () => switchSection(button.dataset.section)));

  elements.masterFile.addEventListener("change", async () => {
    const file = elements.masterFile.files?.[0];
    if (!file) return;
    showImportMessage("TSVを検証しています。", "info");
    try {
      const applied = await importLocalMaster(file);
      renderAll();
      showImportMessage(`有効取込 ${applied.rowCount.toLocaleString("ja-JP")}件／エラー除外 ${applied.errorExcludedCount.toLocaleString("ja-JP")}件。棚卸状態をリセットしました。${applied.masterSaved ? "" : " ブラウザ保存容量が不足したため、再起動後は再取込が必要です。"}`, "ok");
      showResult("idle", "部署を選択してください", "対象終了日を確認し、棚卸する施設・部署を選択してください。");
    } catch (error) {
      showImportMessage(error.message, "error");
      playAlertSound();
    } finally {
      elements.masterFile.blur();
      elements.masterFile.value = "";
    }
  });

  elements.targetEndDate.addEventListener("change", () => {
    state.targetEndDate = elements.targetEndDate.value;
    elements.targetEndDate.blur();
    saveState();
    renderAll();
    showResult("idle", "対象終了日を更新しました", `${formatDateForDisplay(state.targetEndDate)}までのデータで再計算しました。`);
  });

  elements.departmentSelect.addEventListener("change", () => {
    const selected = getEligibleDepartments().find((department) => departmentKey(department) === elements.departmentSelect.value) || null;
    state.currentDepartment = selected;
    elements.departmentSelect.blur();
    saveState();
    renderAll();
    if (selected) {
      showResult("idle", "棚卸を開始できます", `${selected.facilityName} / ${selected.departmentName} のSPDラベルを読み取ってください。`);
      playSuccessSound();
    } else {
      showResult("idle", "部署未選択", "棚卸する施設・部署を選択してください。");
    }
  });

  elements.manualScanButton.addEventListener("click", () => {
    const raw = elements.manualScanInput.value;
    elements.manualScanInput.value = "";
    elements.manualScanInput.blur();
    void processScan(raw);
  });
  elements.manualScanInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); elements.manualScanButton.click(); }
  });

  elements.enableAudioButton.addEventListener("click", () => { void unlockAudio(); });

  elements.printPreviewButton.addEventListener("click", () => {
    if (!preparePrintSheet()) return;
    window.print();
  });
  elements.refreshUnreadButton.addEventListener("click", () => { renderCounts(); renderUnreadList(); });

  elements.unreadList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action][data-label-key]");
    if (!button) return;
    const labelKey = button.dataset.labelKey;
    if (button.dataset.action === "reissue") {
      const enabled = toggleReissueLabel(labelKey);
      elements.unreadActionMessage.textContent = enabled ? `ラベルキー ${labelKey} を再発行対象にしました。` : `ラベルキー ${labelKey} の再発行対象を解除しました。`;
      renderUnreadList();
      renderOutputData();
      return;
    }
    if (!confirm(`ラベルキー ${labelKey} を現物確認済として読取済にしますか？`)) return;
    const beforeCounts = getTargetCounts();
    const result = confirmUnreadLabel(labelKey);
    if (!result.ok) {
      playAlertSound();
      elements.unreadActionMessage.textContent = result.message;
      renderUnreadList();
      return;
    }
    void saveScanHistory(createHistoryRecord(result, ""));
    if (isCompletionTransition(beforeCounts, result.counts)) playCompletionSound();
    else playSuccessSound();
    elements.unreadActionMessage.textContent = `${result.row["品名"]}を手動確認で読取済にしました。未読取 ${result.counts.unread}件`;
    renderCounts();
    renderUnreadList();
    renderOutputData();
  });

  [elements.outputFacility, elements.outputDepartment, elements.outputReadStatus]
    .forEach((input) => input.addEventListener("change", renderOutputData));
  elements.outputSearch.addEventListener("input", renderOutputData);
  elements.exportDataButton.addEventListener("click", async () => {
    try {
      const records = getOutputRecords();
      const method = await shareOutputCsv(records);
      elements.outputMessage.textContent = method === "shared" ? `${records.length}件の共有画面を開きました。` : `${records.length}件のCSVをダウンロードしました。`;
    } catch (error) {
      if (error.name !== "AbortError") elements.outputMessage.textContent = error.message;
    }
  });

  window.addEventListener("keydown", handleGlobalKeydown);
}

async function init() {
  cacheElements();
  restoreState();
  initAudio();
  bindEvents();
  renderAll();
  await loadScanHistory();
  if (state.currentDepartment) showResult("idle", "読取待機中", `${state.currentDepartment.facilityName} / ${state.currentDepartment.departmentName} のSPDラベルを読み取ってください。`);
  document.body.dataset.appReady = "true";
}

function registerServiceWorker() {
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch((error) => console.error("オフライン機能を登録できません。", error)));
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => { void init(); });
  registerServiceWorker();
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    REQUIRED_HEADERS, state, normalizeLabelKey, splitTsvRecords, isValidDateKey, parseTsv, buildLabelKey, normalizeQr,
    getExpectedCenterCode, departmentKey, departmentFromRow, rebuildIndexes, findLabel, parseDateInput, validateTargetEndDate,
    isRowOnOrBeforeEndDate, matchesDepartment, getEligibleDepartments, getUniqueLabelRows, getCurrentTargetLabels, getUnreadLabels,
    getTargetCounts, getOutputTargetLabels, getOutputRecords, validateSpdLabel, acceptSpdLabel, confirmUnreadLabel, toggleReissueLabel,
    isCompletionTransition, getPrintRowValues, todayInputValue, formatDateForDisplay, formatMasterDate, applyMasterData, saveState, restoreState, createHistoryRecord,
    createOutputRecord, filterOutputRecords, buildOutputCsv
  };
}
