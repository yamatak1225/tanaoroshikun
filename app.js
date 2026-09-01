"use strict";

const STORAGE_KEYS = { master: "inventory-kun-master-v2", state: "inventory-kun-state-v2" };
const HISTORY_DB_NAME = "inventory-kun-history-v1";
const HISTORY_STORE_NAME = "scanHistory";
const DEPARTMENT_APPROVAL_STORE_NAME = "departmentApprovals";
const REQUIRED_HEADERS = ["施設コード", "施設名称", "部署コード", "部署名称", "品名", "規格", "製品番号", "ラベルキー", "払出予定伝票日付", "エラーメッセージ"];
const OPTIONAL_VALUE_HEADERS = new Set(["メーカー", "メーカー名", "品名", "規格", "製品番号"]);
const PRINT_COLUMN_HEADERS = ["No.", "施設名 / 部署名", "商品コード", "商品名", "規格", "製品番号", "ラベルキー", "ラベル日付", "対応"];
const APPROVAL_PDF_HEADERS = ["No.", "商品コード", "商品名", "規格", "製品番号", "ラベルキー", "ラベル日付", "対応"];
const APPROVAL_PDF_COLUMN_RATIOS = [0.05, 0.12, 0.20, 0.16, 0.12, 0.13, 0.12, 0.10];
const DEPARTMENT_SEPARATOR = "\u001f";
const STATE_KEY_SEPARATOR = "|";

const state = {
  masterRows: [],
  masterInfo: null,
  labelIndex: new Map(),
  readLabelKeys: new Set(),
  confirmationMethods: new Map(),
  reissueLabelKeys: new Set(),
  departmentApprovals: new Map(),
  savedFacilities: new Map(),
  reissueFilterActive: false,
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
let activePdfUrl = "";
let pendingResetFacility = null;
let activeDepartmentApproval = null;
let outputPdfBusy = false;

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
  const sourceFacilities = new Map();
  let errorExcludedCount = 0;
  records.slice(1).forEach((record, recordIndex) => {
    const line = recordIndex + 2;
    if (record.length > headers.length && record.slice(headers.length).some((value) => normalizeValue(value))) {
      errors.push(`${line}行目：見出し数を超えるデータがあります。`);
      return;
    }
    const row = {};
    headers.forEach((header, index) => { if (header) row[header] = normalizeValue(record[index]); });
    if (row["施設コード"] && row["施設名称"]) sourceFacilities.set(row["施設コード"], { facilityCode: row["施設コード"], facilityName: row["施設名称"] });
    // 在庫差異データ側でエラーになった行は、棚卸対象データへ入れる前に除外する。
    if (row["エラーメッセージ"] !== "") {
      errorExcludedCount += 1;
      return;
    }
    // 列自体は必要でも、業務上空欄を許容する項目は行単位の必須値チェックから除外する。
    const emptyHeaders = REQUIRED_HEADERS.filter((header) => header !== "エラーメッセージ" && !OPTIONAL_VALUE_HEADERS.has(header) && !row[header]);
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
  return { headers, rows, errorExcludedCount, sourceFacilities: [...sourceFacilities.values()] };
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

function facilityKey(facility) {
  if (!facility) return "";
  return normalizeValue(facility.facilityCode);
}

function facilityFromRow(row) {
  return {
    facilityCode: row["施設コード"],
    facilityName: row["施設名称"]
  };
}

function inventoryStateKey(facilityCode, labelKey) {
  const normalizedFacilityCode = normalizeValue(facilityCode);
  const normalizedLabelKey = normalizeLabelKey(labelKey);
  return normalizedFacilityCode && normalizedLabelKey ? `${normalizedFacilityCode}${STATE_KEY_SEPARATOR}${normalizedLabelKey}` : "";
}

function inventoryStateKeyForRow(row) {
  return inventoryStateKey(row?.["施設コード"], row?.["ラベルキー"]);
}

function parseInventoryStateKey(value) {
  const text = String(value ?? "");
  const separatorIndex = text.indexOf(STATE_KEY_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === text.length - 1) return null;
  return { facilityCode: text.slice(0, separatorIndex), labelKey: text.slice(separatorIndex + 1) };
}

function departmentApprovalKey(facilityCode, departmentCode, targetEndDate) {
  const parts = [normalizeValue(facilityCode), normalizeValue(departmentCode), normalizeValue(targetEndDate)];
  return parts.every(Boolean) ? parts.join(STATE_KEY_SEPARATOR) : "";
}

function parseDepartmentApprovalKey(value) {
  const parts = String(value ?? "").split(STATE_KEY_SEPARATOR);
  return parts.length === 3 && parts.every(Boolean)
    ? { facilityCode: parts[0], departmentCode: parts[1], targetEndDate: parts[2] }
    : null;
}

function currentDepartmentApprovalKey(department = state.currentDepartment, targetEndDate = state.targetEndDate) {
  return departmentApprovalKey(department?.facilityCode, department?.departmentCode, targetEndDate);
}

function getDepartmentApproval(department = state.currentDepartment, targetEndDate = state.targetEndDate) {
  return state.departmentApprovals.get(currentDepartmentApprovalKey(department, targetEndDate)) || null;
}

function isRowRead(row) { return state.readLabelKeys.has(inventoryStateKeyForRow(row)); }
function confirmationMethodForRow(row) { return state.confirmationMethods.get(inventoryStateKeyForRow(row)) || ""; }
function isRowReissue(row) { return state.reissueLabelKeys.has(inventoryStateKeyForRow(row)); }

function registerSavedFacilities(facilities) {
  (facilities || []).forEach((facility) => {
    const facilityCode = normalizeValue(facility?.facilityCode);
    if (!facilityCode) return;
    state.savedFacilities.set(facilityCode, { facilityCode, facilityName: normalizeValue(facility.facilityName) || facilityCode });
  });
}

function rebuildIndexes() {
  state.labelIndex = new Map();
  state.masterRows.forEach((row) => {
    const key = row["ラベルキー"];
    if (!state.labelIndex.has(key)) state.labelIndex.set(key, []);
    state.labelIndex.get(key).push(row);
  });
}

function findLabel(labelKey, department = state.currentDepartment) {
  const candidates = state.labelIndex.get(normalizeLabelKey(labelKey)) || [];
  if (!candidates.length) return { ok: false, code: "NOT_FOUND", candidates };
  if (candidates.length > 1 && department) {
    const departmentCandidates = candidates.filter((row) => row["施設コード"] === department.facilityCode && row["部署コード"] === department.departmentCode);
    if (departmentCandidates.length === 1) return { ok: true, row: departmentCandidates[0] };
  }
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
  rows.forEach((row) => {
    const key = inventoryStateKeyForRow(row);
    if (!unique.has(key)) unique.set(key, row);
  });
  return [...unique.values()];
}

function getCurrentTargetLabels() {
  if (!state.currentDepartment || !validateTargetEndDate().ok) return [];
  return getUniqueLabelRows(state.masterRows.filter((row) => isRowOnOrBeforeEndDate(row) && matchesDepartment(row)));
}

function getUnreadLabels() {
  return getCurrentTargetLabels().filter((row) => !isRowRead(row));
}

function getReissueTargetLabels() {
  return getUniqueLabelRows(getOutputTargetLabels()).filter((row) => isRowReissue(row));
}

function getOutputTargetLabels() {
  if (!validateTargetEndDate().ok) return [];
  return state.masterRows.filter((row) => isRowOnOrBeforeEndDate(row));
}

function getResetFacilities(rows = state.masterRows) {
  const facilities = new Map();
  rows.forEach((row) => {
    const facility = facilityFromRow(row);
    const key = facilityKey(facility);
    if (!facilities.has(key)) facilities.set(key, facility);
  });
  const progressFacilityCodes = new Set([...state.readLabelKeys, ...state.confirmationMethods.keys(), ...state.reissueLabelKeys]
    .map(parseInventoryStateKey).filter(Boolean).map((identity) => identity.facilityCode));
  state.departmentApprovals.forEach((approval) => {
    if (approval.facilityCode) progressFacilityCodes.add(approval.facilityCode);
  });
  progressFacilityCodes.forEach((facilityCode) => {
    if (facilities.has(facilityCode)) return;
    const savedFacility = state.savedFacilities.get(facilityCode);
    facilities.set(facilityCode, savedFacility || { facilityCode, facilityName: facilityCode });
  });
  return [...facilities.values()].sort((left, right) => left.facilityName.localeCompare(right.facilityName, "ja"));
}

function getTargetCounts() {
  const targets = getCurrentTargetLabels();
  const read = targets.filter(isRowRead).length;
  return { target: targets.length, read, unread: targets.length - read };
}

function snapshotLabel(row) {
  return {
    facilityCode: row?.["施設コード"] || "",
    facilityName: row?.["施設名称"] || "",
    departmentCode: row?.["部署コード"] || "",
    departmentName: row?.["部署名称"] || "",
    productCode: row?.["商品コード"] || "",
    productName: row?.["品名"] || "",
    specification: row?.["規格"] || "",
    productNumber: row?.["製品番号"] || "",
    labelKey: row?.["ラベルキー"] || "",
    labelDate: formatMasterDate(row?.["払出予定伝票日付"]),
    reissue: isRowReissue(row)
  };
}

function createDepartmentApprovalSnapshot(confirmedBy, now = new Date()) {
  if (!state.currentDepartment) return { ok: false, message: "棚卸対象部署を選択してください。" };
  const endDate = validateTargetEndDate();
  if (!endDate.ok) return { ok: false, message: endDate.message };
  const normalizedName = normalizeValue(confirmedBy);
  if (!normalizedName) return { ok: false, message: "確認者氏名を入力してください。" };
  const approvalKey = currentDepartmentApprovalKey();
  if (state.departmentApprovals.has(approvalKey)) return { ok: false, message: "この部署はすでに部署確認済みです。" };
  const counts = getTargetCounts();
  const unreadLabels = getUnreadLabels().map(snapshotLabel);
  const approval = {
    approvalKey,
    facilityCode: state.currentDepartment.facilityCode,
    facilityName: state.currentDepartment.facilityName,
    departmentCode: state.currentDepartment.departmentCode,
    departmentName: state.currentDepartment.departmentName,
    targetEndDate: state.targetEndDate,
    targetCount: counts.target,
    readCount: counts.read,
    unreadCount: counts.unread,
    confirmedBy: normalizedName,
    confirmedAt: now.toISOString(),
    unreadLabels
  };
  approval.contentSignature = departmentApprovalContentSignature(approval);
  return { ok: true, approval };
}

function departmentApprovalContentSignature(value) {
  const labels = (value?.unreadLabels || []).map((label) => ({
    facilityCode: label.facilityCode || "", departmentCode: label.departmentCode || "", productCode: label.productCode || "",
    productName: label.productName || "", specification: label.specification || "", productNumber: label.productNumber || "",
    labelKey: label.labelKey || "", labelDate: label.labelDate || "", reissue: Boolean(label.reissue)
  })).sort((left, right) => left.labelKey.localeCompare(right.labelKey, "ja"));
  return JSON.stringify({ targetCount: Number(value?.targetCount || 0), readCount: Number(value?.readCount || 0), unreadCount: Number(value?.unreadCount || 0), labels });
}

function currentDepartmentApprovalSignature(department = state.currentDepartment) {
  if (!department || !validateTargetEndDate().ok) return "";
  const targets = getUniqueLabelRows(state.masterRows.filter((row) => isRowOnOrBeforeEndDate(row) && matchesDepartment(row, department)));
  const unreadLabels = targets.filter((row) => !isRowRead(row)).map(snapshotLabel);
  const readCount = targets.length - unreadLabels.length;
  return departmentApprovalContentSignature({ targetCount: targets.length, readCount, unreadCount: unreadLabels.length, unreadLabels });
}

function isDepartmentApprovalOutdated(approval, department = state.currentDepartment) {
  return Boolean(approval && department && approval.contentSignature !== currentDepartmentApprovalSignature(department));
}

function getDepartmentProgress(rows = state.masterRows) {
  return getEligibleDepartments(rows).map((department) => {
    const targets = getUniqueLabelRows(rows.filter((row) => isRowOnOrBeforeEndDate(row) && matchesDepartment(row, department)));
    const read = targets.filter(isRowRead).length;
    const approval = getDepartmentApproval(department);
    return {
      ...department, target: targets.length, read, unread: targets.length - read,
      completed: targets.length > 0 && read === targets.length,
      departmentApproved: Boolean(approval), approval,
      approvalOutdated: isDepartmentApprovalOutdated(approval, department)
    };
  });
}

function getOverallProgress(rows = state.masterRows) {
  const departments = getDepartmentProgress(rows);
  return departments.reduce((summary, department) => {
    summary.target += department.target;
    summary.read += department.read;
    summary.unread += department.unread;
    if (department.completed) summary.completedDepartments += 1;
    return summary;
  }, { departments, target: 0, read: 0, unread: 0, completedDepartments: 0, totalDepartments: departments.length });
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
  if (isRowRead(row)) {
    return { ok: false, code: "DUPLICATE", title: "このSPDラベルは読取済です", message: "二重計上していません。次のSPDラベルを読み取ってください。", labelKey: parsed.labelKey, row };
  }
  return { ok: true, code: "SPD_OK", title: "読取完了", message: "SPDラベルを読取済にしました。", raw: parsed.raw, labelKey: parsed.labelKey, row };
}

function acceptSpdLabel(rawValue) {
  const result = validateSpdLabel(rawValue);
  if (!result.ok) return result;
  const stateKey = inventoryStateKeyForRow(result.row);
  state.readLabelKeys.add(stateKey);
  state.confirmationMethods.set(stateKey, "バーコード");
  registerSavedFacilities([facilityFromRow(result.row)]);
  saveState();
  return { ...result, confirmationMethod: "バーコード", counts: getTargetCounts() };
}

function confirmUnreadLabel(labelKey) {
  const normalizedKey = normalizeLabelKey(labelKey);
  const row = getCurrentTargetLabels().find((candidate) => candidate["ラベルキー"] === normalizedKey);
  if (!row) return { ok: false, code: "NOT_TARGET", title: "確認対象外", message: "現在選択中の部署の未読取ラベルではありません。", labelKey: normalizedKey };
  const stateKey = inventoryStateKeyForRow(row);
  if (state.readLabelKeys.has(stateKey)) return { ok: false, code: "DUPLICATE", title: "確認済です", message: "このラベルはすでに読取済です。", labelKey: normalizedKey, row };
  state.readLabelKeys.add(stateKey);
  state.confirmationMethods.set(stateKey, "手動確認");
  registerSavedFacilities([facilityFromRow(row)]);
  saveState();
  return { ok: true, code: "MANUAL_OK", title: "確認完了", message: "現物確認により読取済にしました。", labelKey: normalizedKey, row, confirmationMethod: "手動確認", counts: getTargetCounts() };
}

function toggleReissueLabel(labelKey, facilityCode = state.currentDepartment?.facilityCode) {
  const normalizedKey = normalizeLabelKey(labelKey);
  const normalizedFacilityCode = normalizeValue(facilityCode);
  const candidates = getOutputTargetLabels().filter((candidate) => candidate["ラベルキー"] === normalizedKey
    && (!normalizedFacilityCode || candidate["施設コード"] === normalizedFacilityCode));
  const row = candidates.length === 1 ? candidates[0] : null;
  if (!row) return false;
  const stateKey = inventoryStateKeyForRow(row);
  if (state.reissueLabelKeys.has(stateKey)) state.reissueLabelKeys.delete(stateKey);
  else state.reissueLabelKeys.add(stateKey);
  registerSavedFacilities([facilityFromRow(row)]);
  saveState();
  return state.reissueLabelKeys.has(stateKey);
}

function isCompletionTransition(beforeCounts, afterCounts) {
  return Boolean(beforeCounts?.unread > 0 && afterCounts?.target > 0 && afterCounts.unread === 0);
}

function resetInventoryForFacility(facility, options = {}) {
  const normalizedFacility = {
    facilityCode: normalizeValue(facility?.facilityCode),
    facilityName: normalizeValue(facility?.facilityName) || normalizeValue(facility?.facilityCode)
  };
  if (!normalizedFacility.facilityCode) {
    return { ok: false, message: "リセット対象施設を選択してください。" };
  }

  let readResetCount = 0;
  let reissueResetCount = 0;
  const approvalRecords = options.approvalRecords || [...state.departmentApprovals.values()].filter((approval) => approval.facilityCode === normalizedFacility.facilityCode);
  [...state.readLabelKeys].forEach((stateKey) => {
    if (parseInventoryStateKey(stateKey)?.facilityCode !== normalizedFacility.facilityCode) return;
    if (state.readLabelKeys.delete(stateKey)) readResetCount += 1;
    state.confirmationMethods.delete(stateKey);
  });
  [...state.confirmationMethods.keys()].forEach((stateKey) => {
    if (parseInventoryStateKey(stateKey)?.facilityCode === normalizedFacility.facilityCode) state.confirmationMethods.delete(stateKey);
  });
  [...state.reissueLabelKeys].forEach((stateKey) => {
    if (parseInventoryStateKey(stateKey)?.facilityCode === normalizedFacility.facilityCode && state.reissueLabelKeys.delete(stateKey)) reissueResetCount += 1;
  });
  approvalRecords.forEach((approval) => state.departmentApprovals.delete(approval.approvalKey));
  state.reissueFilterActive = false;
  saveState();
  const targetCount = new Set(state.masterRows.filter((row) => row["施設コード"] === normalizedFacility.facilityCode).map((row) => inventoryStateKeyForRow(row))).size;
  return {
    ok: true,
    facility: normalizedFacility,
    targetCount,
    readResetCount,
    reissueResetCount,
    approvalResetCount: approvalRecords.length,
    approvalRecords,
    approvalKeys: approvalRecords.map((approval) => approval.approvalKey)
  };
}

function todayInputValue(now = new Date()) {
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

function formatApprovalDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "―";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}`;
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
    const request = indexedDbRef.open(HISTORY_DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        const store = db.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("eventAt", "eventAt");
        store.createIndex("result", "result");
      }
      if (!db.objectStoreNames.contains(DEPARTMENT_APPROVAL_STORE_NAME)) {
        const store = db.createObjectStore(DEPARTMENT_APPROVAL_STORE_NAME, { keyPath: "approvalKey" });
        store.createIndex("facilityCode", "facilityCode");
        store.createIndex("confirmedAt", "confirmedAt");
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  return historyDbPromise;
}

async function loadDepartmentApprovals() {
  try {
    const db = await openHistoryDb();
    if (!db) return state.departmentApprovals;
    const approvals = await new Promise((resolve, reject) => {
      const request = db.transaction(DEPARTMENT_APPROVAL_STORE_NAME, "readonly").objectStore(DEPARTMENT_APPROVAL_STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    state.departmentApprovals = new Map(approvals.filter((approval) => approval?.approvalKey).map((approval) => [approval.approvalKey, approval]));
    registerSavedFacilities(approvals.map((approval) => ({ facilityCode: approval.facilityCode, facilityName: approval.facilityName })));
  } catch (error) {
    console.error("部署確認記録を読み込めません。", error);
  }
  return state.departmentApprovals;
}

async function saveDepartmentApproval(approval) {
  if (!approval?.approvalKey) throw new Error("部署確認記録の識別キーがありません。");
  if (state.departmentApprovals.has(approval.approvalKey)) throw new Error("この部署はすでに部署確認済みです。");
  const db = await openHistoryDb();
  if (!db) throw new Error("部署確認記録を端末へ保存できません。IndexedDBを利用できるブラウザで開いてください。");
  await new Promise((resolve, reject) => {
    const request = db.transaction(DEPARTMENT_APPROVAL_STORE_NAME, "readwrite").objectStore(DEPARTMENT_APPROVAL_STORE_NAME).add(approval);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  state.departmentApprovals.set(approval.approvalKey, approval);
  registerSavedFacilities([{ facilityCode: approval.facilityCode, facilityName: approval.facilityName }]);
  saveState();
  return approval;
}

async function deleteDepartmentApproval(approvalKey) {
  const approval = state.departmentApprovals.get(approvalKey);
  if (!approval) return false;
  const db = await openHistoryDb();
  if (!db) throw new Error("部署確認記録を端末から削除できません。");
  await new Promise((resolve, reject) => {
    const request = db.transaction(DEPARTMENT_APPROVAL_STORE_NAME, "readwrite").objectStore(DEPARTMENT_APPROVAL_STORE_NAME).delete(approvalKey);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  state.departmentApprovals.delete(approvalKey);
  return true;
}

async function deleteDepartmentApprovalsForFacility(facilityCode, approvalKeys = null) {
  const normalizedCode = normalizeValue(facilityCode);
  const keys = approvalKeys || [...state.departmentApprovals.values()]
    .filter((approval) => approval.facilityCode === normalizedCode).map((approval) => approval.approvalKey);
  if (!keys.length) return 0;
  const db = await openHistoryDb();
  if (!db) throw new Error("部署確認記録を端末から削除できません。");
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(DEPARTMENT_APPROVAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(DEPARTMENT_APPROVAL_STORE_NAME);
    keys.forEach((key) => store.delete(key));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("部署確認記録の削除を中断しました。"));
  });
  keys.forEach((key) => state.departmentApprovals.delete(key));
  return keys.length;
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
  const read = isRowRead(row);
  const departmentApproval = state.departmentApprovals.get(departmentApprovalKey(row["施設コード"], row["部署コード"], state.targetEndDate));
  return {
    productCode: row["商品コード"] || "",
    manufacturerName: row["メーカー名"] || row["メーカー"] || "",
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
    confirmationMethod: read ? confirmationMethodForRow(row) : "",
    reissueStatus: isRowReissue(row) ? "再発行" : "",
    departmentApprovalStatus: departmentApproval ? "確認済" : "",
    departmentApprover: departmentApproval?.confirmedBy || "",
    departmentApprovedAt: departmentApproval ? formatApprovalDateTime(departmentApproval.confirmedAt) : ""
  };
}

function getOutputRecords() {
  return getOutputTargetLabels().map(createOutputRecord);
}

function getOutputScopeDepartments() {
  const departments = new Map();
  getEligibleDepartments().forEach((department) => departments.set(departmentKey(department), department));
  state.departmentApprovals.forEach((approval) => {
    const department = {
      facilityCode: normalizeValue(approval.facilityCode),
      facilityName: normalizeValue(approval.facilityName) || normalizeValue(approval.facilityCode),
      departmentCode: normalizeValue(approval.departmentCode),
      departmentName: normalizeValue(approval.departmentName) || normalizeValue(approval.departmentCode)
    };
    const key = departmentKey(department);
    if (key && !departments.has(key)) departments.set(key, department);
  });
  return [...departments.values()].sort((left, right) => `${left.facilityName}\u0000${left.departmentName}`.localeCompare(`${right.facilityName}\u0000${right.departmentName}`, "ja"));
}

function getOutputScopeFacilities() {
  const facilities = new Map();
  getOutputScopeDepartments().forEach((department) => {
    if (!facilities.has(department.facilityCode)) facilities.set(department.facilityCode, { facilityCode: department.facilityCode, facilityName: department.facilityName });
  });
  return [...facilities.values()].sort((left, right) => left.facilityName.localeCompare(right.facilityName, "ja"));
}

function getOutputScopeDescriptor(filters = {}) {
  const facilityCode = normalizeValue(filters.facilityCode || filters.facility);
  const departmentCode = facilityCode ? normalizeValue(filters.departmentCode || filters.department) : "";
  const facility = getOutputScopeFacilities().find((item) => item.facilityCode === facilityCode) || null;
  const department = facilityCode && departmentCode
    ? getOutputScopeDepartments().find((item) => item.facilityCode === facilityCode && item.departmentCode === departmentCode) || null
    : null;
  if (!facility) return { facilityCode: "", facilityName: "全施設", departmentCode: "", departmentName: "全部署", fileScopeParts: ["全施設"] };
  if (!department) return { facilityCode, facilityName: facility.facilityName, departmentCode: "", departmentName: "全部署", fileScopeParts: [facility.facilityName, "全部署"] };
  return { facilityCode, facilityName: facility.facilityName, departmentCode, departmentName: department.departmentName, fileScopeParts: [facility.facilityName, department.departmentName] };
}

function filterOutputRecords(records, filters = {}) {
  const search = normalizeValue(filters.search).toLowerCase();
  const facilityCode = normalizeValue(filters.facilityCode);
  const departmentCode = normalizeValue(filters.departmentCode);
  return records.filter((record) => {
    if (facilityCode && record.facilityCode !== facilityCode) return false;
    if (departmentCode && record.departmentCode !== departmentCode) return false;
    // 旧呼出しとの互換性を維持しつつ、画面からの判定はコードを使用する。
    if (!facilityCode && filters.facility && record.facilityName !== filters.facility) return false;
    if (!departmentCode && filters.department && record.departmentName !== filters.department) return false;
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
    ["部署名", "departmentName"], ["読取済区分", "readStatus"], ["確認方法", "confirmationMethod"], ["ラベル再発行区分", "reissueStatus"],
    ["部署確認区分", "departmentApprovalStatus"], ["部署確認者", "departmentApprover"], ["部署確認日時", "departmentApprovedAt"]
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

function createPdfFile(result, FileRef = File) {
  if (!result?.bytes?.byteLength || !result.fileName) throw new Error("PDFファイルを作成できません。");
  return new FileRef([result.bytes], result.fileName, { type: "application/pdf" });
}

async function shareOutputPdf(result, env = {}) {
  const navigatorRef = env.navigatorRef || navigator;
  const documentRef = env.documentRef || document;
  const FileRef = env.FileRef || File;
  const file = createPdfFile(result, FileRef);
  if (navigatorRef.canShare?.({ files: [file] }) && navigatorRef.share) {
    await navigatorRef.share({ title: result.fileName.replace(/\.pdf$/i, ""), text: "棚卸くんで作成したPDFです。", files: [file] });
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
      formatVersion: 2,
      masterFingerprint: state.masterInfo?.fingerprint || null,
      readLabelKeys: [...state.readLabelKeys],
      confirmationMethods: [...state.confirmationMethods],
      reissueLabelKeys: [...state.reissueLabelKeys],
      savedFacilities: [...state.savedFacilities.values()],
      targetEndDate: state.targetEndDate,
      currentDepartment: state.currentDepartment
    }));
    return true;
  } catch (error) {
    console.error("棚卸状態をブラウザへ保存できません。", error);
    return false;
  }
}

function migrateStoredStateKey(value, masterRows = state.masterRows) {
  const parsed = parseInventoryStateKey(value);
  if (parsed) return inventoryStateKey(parsed.facilityCode, parsed.labelKey);
  const legacyLabelKey = normalizeLabelKey(value);
  const facilityCodes = [...new Set(masterRows.filter((row) => row["ラベルキー"] === legacyLabelKey).map((row) => row["施設コード"]))];
  return facilityCodes.length === 1 ? inventoryStateKey(facilityCodes[0], legacyLabelKey) : "";
}

function reconcileInventoryState(validStateKeys, refreshedFacilityCodes) {
  const validKeys = validStateKeys instanceof Set ? validStateKeys : new Set(validStateKeys || []);
  const refreshedCodes = refreshedFacilityCodes instanceof Set ? refreshedFacilityCodes : new Set(refreshedFacilityCodes || []);
  const shouldRetain = (stateKey) => {
    const identity = parseInventoryStateKey(stateKey);
    return Boolean(identity && (!refreshedCodes.has(identity.facilityCode) || validKeys.has(stateKey)));
  };
  const retainedReadKeys = [...state.readLabelKeys].filter(shouldRetain);
  state.readLabelKeys = new Set(retainedReadKeys);
  state.confirmationMethods = new Map(retainedReadKeys.map((stateKey) => [
    stateKey,
    state.confirmationMethods.get(stateKey) || "バーコード"
  ]));
  state.reissueLabelKeys = new Set([...state.reissueLabelKeys].filter(shouldRetain));
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
      registerSavedFacilities(Array.isArray(saved.savedFacilities) ? saved.savedFacilities : []);
      registerSavedFacilities(state.masterRows.map(facilityFromRow));
      state.readLabelKeys = new Set(Array.isArray(saved.readLabelKeys) ? saved.readLabelKeys.map((key) => migrateStoredStateKey(key)).filter(Boolean) : []);
      state.confirmationMethods = new Map(Array.isArray(saved.confirmationMethods) ? saved.confirmationMethods
        .map(([key, method]) => [migrateStoredStateKey(key), method]).filter(([key]) => key) : []);
      state.readLabelKeys.forEach((key) => { if (!state.confirmationMethods.has(key)) state.confirmationMethods.set(key, "バーコード"); });
      state.reissueLabelKeys = new Set(Array.isArray(saved.reissueLabelKeys) ? saved.reissueLabelKeys.map((key) => migrateStoredStateKey(key)).filter(Boolean) : []);
      state.currentDepartment = saved.currentDepartment || null;
    }
  } catch (error) {
    console.error("保存済み棚卸状態を読み込めません。", error);
  }
  const restoredFacilities = state.masterInfo?.sourceFacilities?.length ? state.masterInfo.sourceFacilities : state.masterRows.map(facilityFromRow);
  reconcileInventoryState(new Set(state.masterRows.map(inventoryStateKeyForRow)), new Set(restoredFacilities.map((facility) => facility.facilityCode)));
  if (state.currentDepartment) {
    state.currentDepartment = getEligibleDepartments().find((department) => department.facilityCode === state.currentDepartment.facilityCode
      && department.departmentCode === state.currentDepartment.departmentCode) || null;
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
  const previousLabelKeys = new Set(state.masterRows.map(inventoryStateKeyForRow));
  const previousDepartment = state.currentDepartment ? { ...state.currentDepartment } : null;
  state.readLabelKeys = new Set([...state.readLabelKeys].map((key) => migrateStoredStateKey(key)).filter(Boolean));
  state.confirmationMethods = new Map([...state.confirmationMethods].map(([key, method]) => [migrateStoredStateKey(key), method]).filter(([key]) => key));
  state.reissueLabelKeys = new Set([...state.reissueLabelKeys].map((key) => migrateStoredStateKey(key)).filter(Boolean));
  const previousTargetEndDate = validateTargetEndDate().ok ? state.targetEndDate : todayInputValue(now);
  const currentLabelKeys = new Set(rows.map(inventoryStateKeyForRow));
  const sourceFacilities = sourceInfo.sourceFacilities?.length
    ? sourceInfo.sourceFacilities.map((facility) => ({ facilityCode: normalizeValue(facility.facilityCode), facilityName: normalizeValue(facility.facilityName) }))
    : [...new Map(rows.map((row) => [row["施設コード"], facilityFromRow(row)])).values()];
  const refreshedFacilityCodes = new Set(sourceFacilities.map((facility) => facility.facilityCode));

  state.masterRows = rows;
  state.masterInfo = {
    ...sourceInfo,
    sourceFacilities,
    importedAt: now.toISOString(),
    rowCount: rows.length,
    fingerprint: createFingerprint(sourceInfo.fileName, sourceInfo.size, sourceInfo.lastModified, rows)
  };
  state.targetEndDate = previousTargetEndDate;
  registerSavedFacilities(sourceFacilities);
  reconcileInventoryState(currentLabelKeys, refreshedFacilityCodes);
  state.reissueFilterActive = false;
  rebuildIndexes();
  const eligibleDepartments = getEligibleDepartments();
  state.currentDepartment = previousDepartment
    ? eligibleDepartments.find((department) => department.facilityCode === previousDepartment.facilityCode
      && department.departmentCode === previousDepartment.departmentCode) || null
    : null;
  const masterSaved = saveMaster();
  saveState();
  return {
    masterSaved,
    rowCount: rows.length,
    errorExcludedCount: sourceInfo.errorExcludedCount || 0,
    addedLabelCount: [...currentLabelKeys].filter((labelKey) => !previousLabelKeys.has(labelKey)).length,
    removedLabelCount: [...previousLabelKeys].filter((labelKey) => !currentLabelKeys.has(labelKey)).length,
    retainedReadCount: [...currentLabelKeys].filter((stateKey) => state.readLabelKeys.has(stateKey)).length,
    retainedManualCount: [...currentLabelKeys].filter((stateKey) => state.confirmationMethods.get(stateKey) === "手動確認").length,
    retainedReissueCount: [...currentLabelKeys].filter((stateKey) => state.reissueLabelKeys.has(stateKey)).length,
    departmentPreserved: Boolean(previousDepartment && state.currentDepartment),
    departmentCleared: Boolean(previousDepartment && !state.currentDepartment),
    previousDepartment
  };
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
    errorExcludedCount: parsed.errorExcludedCount,
    sourceFacilities: parsed.sourceFacilities
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
    "resetFacilitySelect", "resetInventoryButton", "resetInventoryMessage", "resetConfirmDialog", "resetConfirmMessage", "cancelResetButton", "executeResetButton",
    "targetEndDate", "periodError", "departmentSelect", "overallStatusButton", "currentFacility", "currentDepartment", "currentDepartmentCode", "targetCount", "readCount", "unreadCount",
    "resultPanel", "modeStatus", "resultTitle", "resultMessage", "resultDetails", "scannerBufferStatus", "manualScanInput", "manualScanButton",
    "printPreviewButton", "departmentApprovalButton", "departmentApprovalStatus", "reissueExtractButton", "unreadPeriodLabel", "unreadDepartmentLabel", "unreadCountGrid", "unreadTargetCount", "unreadReadCount", "unreadRemainingCount", "unreadActionMessage", "unreadList",
    "outputEndDate", "outputFacility", "outputDepartment", "outputReadStatus", "outputSearch", "outputCount", "outputList", "exportDataButton", "exportUnreadPdfButton", "exportApprovalPdfButton", "outputMessage",
    "overallStatusDialog", "overallStatusCloseButton", "overallEndDate", "overallTargetCount", "overallReadCount", "overallUnreadCount", "overallCompletedCount", "overallApprovedCount", "overallDepartmentList",
    "departmentApprovalDialog", "departmentApprovalCloseButton", "departmentApprovalDepartment", "departmentApprovalEndDate", "departmentApprovalTargetCount", "departmentApprovalReadCount", "departmentApprovalUnreadCount",
    "departmentApprovalExistingMessage", "departmentApprovalUpdateWarning", "departmentApprovalLabelList", "departmentApprovalInputArea", "departmentApproverName", "departmentApprovalCheck", "departmentApprovalStatement", "departmentApprovalMessage",
    "executeDepartmentApprovalButton", "departmentApprovalRecordActions", "departmentApprovalPdfButton", "cancelDepartmentApprovalButton"
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
    details.push(["品名", result.row["品名"] || ""]);
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

function renderResetFacilities() {
  const previous = elements.resetFacilitySelect.value;
  const facilities = getResetFacilities();
  elements.resetFacilitySelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = facilities.length ? "リセットする施設を選択してください" : "リセット可能な棚卸情報はありません";
  elements.resetFacilitySelect.append(placeholder);
  facilities.forEach((facility) => {
    const option = document.createElement("option");
    option.value = facilityKey(facility);
    option.textContent = `${facility.facilityName}（${facility.facilityCode}）`;
    elements.resetFacilitySelect.append(option);
  });
  elements.resetFacilitySelect.disabled = !facilities.length;
  if (previous && facilities.some((facility) => facilityKey(facility) === previous)) elements.resetFacilitySelect.value = previous;
  elements.resetInventoryButton.disabled = !elements.resetFacilitySelect.value;
}

function selectedResetFacility() {
  return getResetFacilities().find((facility) => facilityKey(facility) === elements.resetFacilitySelect.value) || null;
}

function closeResetConfirmDialog() {
  pendingResetFacility = null;
  if (elements.resetConfirmDialog.open) elements.resetConfirmDialog.close();
  elements.resetInventoryButton.focus();
}

function openResetConfirmDialog() {
  const facility = selectedResetFacility();
  if (!facility) {
    elements.resetInventoryMessage.textContent = "リセット対象施設を選択してください。";
    return;
  }
  pendingResetFacility = facility;
  elements.resetConfirmMessage.textContent = `${facility.facilityName}の棚卸情報だけをリセットします。他施設の棚卸情報は変更されません。よろしいですか？`;
  if (typeof elements.resetConfirmDialog.showModal === "function") {
    elements.resetConfirmDialog.showModal();
    elements.cancelResetButton.focus();
    return;
  }
  if (confirm(elements.resetConfirmMessage.textContent)) executeFacilityReset();
  else pendingResetFacility = null;
}

async function executeFacilityReset() {
  const facility = pendingResetFacility;
  if (!facility) return;
  const approvalRecords = [...state.departmentApprovals.values()].filter((approval) => approval.facilityCode === normalizeValue(facility.facilityCode));
  pendingResetFacility = null;
  if (elements.resetConfirmDialog.open) elements.resetConfirmDialog.close();
  try {
    await deleteDepartmentApprovalsForFacility(facility.facilityCode, approvalRecords.map((approval) => approval.approvalKey));
  } catch (error) {
    elements.resetInventoryMessage.textContent = `部署確認記録を削除できなかったため、リセットを完了できませんでした：${error.message}`;
    playAlertSound();
    return;
  }
  const result = resetInventoryForFacility(facility, { approvalRecords });
  if (!result.ok) {
    elements.resetInventoryMessage.textContent = result.message;
    playAlertSound();
    return;
  }
  renderAll();
  elements.resetFacilitySelect.value = facilityKey(result.facility);
  elements.resetInventoryButton.disabled = false;
  elements.resetInventoryMessage.textContent = `${result.facility.facilityName}の棚卸情報と部署確認 ${result.approvalResetCount}件をリセットしました。他施設の棚卸情報は維持されています。部署確認記録も変更していません。`;
  if (state.currentDepartment?.facilityCode === result.facility.facilityCode) {
    const counts = getTargetCounts();
    showResult("idle", "棚卸情報をリセットしました", `${result.facility.facilityName}の棚卸を最初から開始できます。未読取 ${counts.unread}件`);
  }
  elements.resetInventoryButton.focus();
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
  elements.overallStatusButton.disabled = !departments.length;
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

function renderDepartmentApprovalStatus() {
  const approval = getDepartmentApproval();
  elements.departmentApprovalStatus.replaceChildren();
  elements.departmentApprovalStatus.hidden = !approval;
  if (!approval) return;
  const title = document.createElement("strong");
  title.textContent = "部署確認済";
  const person = document.createElement("p");
  person.textContent = `確認者：${approval.confirmedBy || ""}`;
  const date = document.createElement("p");
  date.textContent = `確認日時：${formatApprovalDateTime(approval.confirmedAt)}`;
  elements.departmentApprovalStatus.append(title, person, date);
  if (isDepartmentApprovalOutdated(approval)) {
    const warning = document.createElement("p");
    warning.className = "department-approval-warning";
    warning.textContent = "部署確認後に棚卸対象データが更新されています。";
    elements.departmentApprovalStatus.append(warning);
  }
}

function renderOverallStatus() {
  if (elements.overallStatusDialog.hidden) return;
  const progress = getOverallProgress();
  elements.overallEndDate.textContent = `対象終了日：${formatDateForDisplay(state.targetEndDate)}`;
  elements.overallTargetCount.textContent = progress.target;
  elements.overallReadCount.textContent = progress.read;
  elements.overallUnreadCount.textContent = progress.unread;
  elements.overallCompletedCount.textContent = `${progress.completedDepartments} / ${progress.totalDepartments}`;
  const approvedDepartments = progress.departments.filter((department) => department.departmentApproved).length;
  elements.overallApprovedCount.textContent = `${approvedDepartments} / ${progress.totalDepartments}`;
  elements.overallDepartmentList.replaceChildren();
  if (!progress.departments.length) {
    const empty = document.createElement("p");
    empty.className = "overall-empty";
    empty.textContent = "対象終了日以前の部署がありません。";
    elements.overallDepartmentList.append(empty);
    return;
  }
  progress.departments.forEach((department) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `overall-department-item${department.completed ? " is-complete" : ""}`;
    button.dataset.departmentKey = departmentKey(department);
    const heading = document.createElement("span");
    heading.className = "overall-department-heading";
    const name = document.createElement("strong");
    name.textContent = `${department.facilityName} / ${department.departmentName}`;
    const status = document.createElement("span");
    status.className = "overall-department-status";
    status.textContent = department.completed ? "完了" : "未完了";
    heading.append(name, status);
    const counts = document.createElement("span");
    counts.className = "overall-department-counts";
    [
      `対象 ${department.target}件`,
      `読取済 ${department.read}件`,
      `未読取 ${department.unread}件`
    ].forEach((text) => {
      const value = document.createElement("span");
      value.textContent = text;
      counts.append(value);
    });
    const approvalStatus = document.createElement("span");
    approvalStatus.className = `overall-department-approval${department.departmentApproved ? " is-approved" : ""}${department.approvalOutdated ? " is-outdated" : ""}`;
    approvalStatus.textContent = department.departmentApproved
      ? `部署確認済：${department.approval.confirmedBy || ""}（${formatApprovalDateTime(department.approval.confirmedAt)}）${department.approvalOutdated ? "／確認後更新あり" : ""}`
      : "部署未確認";
    button.append(heading, counts, approvalStatus);
    elements.overallDepartmentList.append(button);
  });
}

function openOverallStatus() {
  if (elements.overallStatusButton.disabled) return;
  elements.overallStatusDialog.hidden = false;
  document.body.classList.add("has-modal");
  renderOverallStatus();
  elements.overallStatusCloseButton.focus();
}

function closeOverallStatus() {
  elements.overallStatusDialog.hidden = true;
  document.body.classList.remove("has-modal");
  elements.overallStatusButton.focus();
}

function createDepartmentApprovalLabelItem(label, index) {
  const article = document.createElement("article");
  article.className = "department-approval-label";
  const heading = document.createElement("h4");
  heading.textContent = `${index + 1}. ${label.productName || ""}`;
  const specification = document.createElement("p");
  specification.textContent = `規格：${label.specification || ""}`;
  const product = document.createElement("p");
  product.textContent = `商品コード：${label.productCode || ""}　製品番号：${label.productNumber || ""}`;
  const key = document.createElement("p");
  key.className = "item-key";
  key.textContent = `ラベルキー：${label.labelKey || ""}`;
  const date = document.createElement("p");
  date.textContent = `ラベル日付：${label.labelDate || ""}`;
  article.append(heading, specification, product, key, date);
  if (label.reissue) {
    const reissue = document.createElement("span");
    reissue.className = "department-approval-reissue";
    reissue.textContent = "ラベル再発行";
    article.append(reissue);
  }
  return article;
}

function renderDepartmentApprovalDialog() {
  const approval = activeDepartmentApproval;
  if (!approval) return;
  const existing = Boolean(state.departmentApprovals.get(approval.approvalKey));
  elements.departmentApprovalDepartment.textContent = `${approval.facilityName || ""} / ${approval.departmentName || ""}`;
  elements.departmentApprovalEndDate.textContent = `対象終了日：${formatDateForDisplay(approval.targetEndDate)}`;
  elements.departmentApprovalTargetCount.textContent = approval.targetCount;
  elements.departmentApprovalReadCount.textContent = approval.readCount;
  elements.departmentApprovalUnreadCount.textContent = approval.unreadCount;
  elements.departmentApprovalLabelList.replaceChildren();
  if (!approval.unreadLabels.length) {
    const zero = document.createElement("p");
    zero.className = "department-approval-zero";
    zero.textContent = "未確認SPDラベルは0件です";
    elements.departmentApprovalLabelList.append(zero);
  } else {
    approval.unreadLabels.forEach((label, index) => elements.departmentApprovalLabelList.append(createDepartmentApprovalLabelItem(label, index)));
  }
  elements.departmentApprovalExistingMessage.hidden = !existing;
  elements.departmentApprovalExistingMessage.textContent = existing
    ? `この部署はすでに部署確認済みです。\n確認者：${approval.confirmedBy || ""}\n確認日時：${formatApprovalDateTime(approval.confirmedAt)}` : "";
  elements.departmentApprovalUpdateWarning.hidden = !existing || !isDepartmentApprovalOutdated(approval, state.currentDepartment);
  elements.departmentApprovalInputArea.hidden = existing;
  elements.departmentApprovalRecordActions.hidden = !existing;
  elements.departmentApprovalStatement.textContent = approval.unreadCount
    ? "上記の未確認SPDラベルについて、所在状況を確認しました。"
    : "棚卸対象ラベルについて確認しました。";
}

function openDepartmentApprovalDialog() {
  if (!state.currentDepartment) {
    elements.unreadActionMessage.textContent = "棚卸対象部署を選択してください。";
    playAlertSound();
    return;
  }
  const endDate = validateTargetEndDate();
  if (!endDate.ok) {
    elements.unreadActionMessage.textContent = endDate.message;
    playAlertSound();
    return;
  }
  const existing = getDepartmentApproval();
  if (existing) activeDepartmentApproval = existing;
  else {
    const counts = getTargetCounts();
    activeDepartmentApproval = {
      approvalKey: currentDepartmentApprovalKey(),
      ...state.currentDepartment,
      targetEndDate: state.targetEndDate,
      targetCount: counts.target,
      readCount: counts.read,
      unreadCount: counts.unread,
      unreadLabels: getUnreadLabels().map(snapshotLabel)
    };
  }
  elements.departmentApproverName.value = "";
  elements.departmentApprovalCheck.checked = false;
  elements.departmentApprovalMessage.textContent = "";
  renderDepartmentApprovalDialog();
  elements.departmentApprovalDialog.hidden = false;
  document.body.classList.add("has-modal");
  (existing ? elements.departmentApprovalPdfButton : elements.departmentApproverName).focus();
}

function closeDepartmentApprovalDialog() {
  elements.departmentApprovalDialog.hidden = true;
  activeDepartmentApproval = null;
  document.body.classList.remove("has-modal");
  elements.departmentApprovalButton.focus();
}

async function executeDepartmentApproval() {
  const confirmedBy = normalizeValue(elements.departmentApproverName.value);
  if (!confirmedBy) {
    elements.departmentApprovalMessage.textContent = "確認者氏名を入力してください。";
    elements.departmentApproverName.focus();
    return;
  }
  if (!elements.departmentApprovalCheck.checked) {
    elements.departmentApprovalMessage.textContent = "確認内容にチェックしてください。";
    elements.departmentApprovalCheck.focus();
    return;
  }
  const created = createDepartmentApprovalSnapshot(confirmedBy);
  if (!created.ok) {
    elements.departmentApprovalMessage.textContent = created.message;
    playAlertSound();
    return;
  }
  elements.executeDepartmentApprovalButton.disabled = true;
  elements.departmentApprovalMessage.textContent = "部署確認記録を端末へ保存しています。";
  try {
    activeDepartmentApproval = await saveDepartmentApproval(created.approval);
    renderDepartmentApprovalDialog();
    renderDepartmentApprovalStatus();
    renderOverallStatus();
    renderOutputData();
    elements.unreadActionMessage.textContent = "部署確認記録を保存しました。";
    playSuccessSound();
  } catch (error) {
    elements.departmentApprovalMessage.textContent = `部署確認記録を保存できませんでした：${error.message}`;
    playAlertSound();
  } finally {
    elements.executeDepartmentApprovalButton.disabled = false;
  }
}

async function cancelCurrentDepartmentApproval() {
  const approval = activeDepartmentApproval;
  if (!approval || !state.departmentApprovals.has(approval.approvalKey)) return;
  if (!confirm(`${approval.facilityName} / ${approval.departmentName}の部署確認記録を取消します。よろしいですか？`)) return;
  try {
    await deleteDepartmentApproval(approval.approvalKey);
    closeDepartmentApprovalDialog();
    renderDepartmentApprovalStatus();
    renderOverallStatus();
    renderOutputData();
    elements.unreadActionMessage.textContent = "選択中の部署確認記録だけを取消しました。他部署・他施設の記録は変更していません。";
  } catch (error) {
    elements.departmentApprovalMessage.textContent = `部署確認記録を取消できませんでした：${error.message}`;
    playAlertSound();
  }
}

function selectDepartmentForInventory(selected) {
  state.currentDepartment = selected;
  saveState();
  renderAll();
  if (selected) {
    showResult("idle", "棚卸を開始できます", `${selected.facilityName} / ${selected.departmentName} のSPDラベルを読み取ってください。`);
    playSuccessSound();
  } else {
    showResult("idle", "部署未選択", "棚卸する施設・部署を選択してください。");
  }
}

function renderScanner() {
  const ready = Boolean(state.masterRows.length && state.currentDepartment && validateTargetEndDate().ok);
  elements.scannerBufferStatus.textContent = state.scannerBuffer
    ? `Bluetoothリーダー入力中（${state.scannerBuffer.length}文字）`
    : ready ? "Bluetoothリーダー入力待機中" : "部署選択後に読取できます";
  elements.modeStatus.textContent = ready ? "● SPDラベル待ち" : state.masterRows.length ? "● 部署選択待ち" : "● マスター待ち";
  elements.modeStatus.className = `mode-status ${ready ? "mode-status--spd" : "mode-status--container"}`;
  elements.printPreviewButton.disabled = !state.currentDepartment || !validateTargetEndDate().ok;
  elements.reissueExtractButton.disabled = !state.masterRows.length || !validateTargetEndDate().ok;
}

function createUnreadItem(row, index, options = {}) {
  const article = document.createElement("article");
  const labelKey = row["ラベルキー"];
  const reissue = isRowReissue(row);
  const read = isRowRead(row);
  article.className = `unread-item${reissue ? " unread-item--reissue" : ""}`;
  const heading = document.createElement("h3");
  heading.textContent = `${index + 1}. ${row["品名"] || ""}`;
  const specification = document.createElement("p");
  specification.className = "item-specification";
  specification.textContent = `規格：${row["規格"] || ""}`;
  const product = document.createElement("p");
  product.className = "item-product";
  product.textContent = `製品番号：${row["製品番号"] || ""}`;
  const key = document.createElement("p");
  key.className = "item-key";
  key.textContent = `ラベルキー：${labelKey}`;
  const labelDate = document.createElement("p");
  labelDate.className = "item-label-date";
  labelDate.textContent = `ラベル日付：${formatMasterDate(row["払出予定伝票日付"])}`;
  const department = document.createElement("p");
  department.textContent = `${row["施設名称"]} ／ ${row["部署名称"]}`;
  const readStatus = document.createElement("p");
  readStatus.className = `reissue-read-status ${read ? "is-read" : "is-unread"}`;
  readStatus.textContent = read ? `読取済（${confirmationMethodForRow(row) || "バーコード"}）` : "未読取";
  const actions = document.createElement("div");
  actions.className = `unread-actions${options.reissueMode ? " is-single" : ""}`;
  const confirmButton = document.createElement("button");
  confirmButton.type = "button";
  confirmButton.className = "button unread-confirm-button";
  confirmButton.dataset.action = "confirm";
  confirmButton.dataset.labelKey = labelKey;
  confirmButton.dataset.facilityCode = row["施設コード"];
  confirmButton.textContent = "確認済";
  const reissueButton = document.createElement("button");
  reissueButton.type = "button";
  reissueButton.className = `button unread-reissue-button${reissue ? " is-active" : ""}`;
  reissueButton.dataset.action = "reissue";
  reissueButton.dataset.labelKey = labelKey;
  reissueButton.dataset.facilityCode = row["施設コード"];
  reissueButton.setAttribute("aria-pressed", String(reissue));
  reissueButton.textContent = reissue ? "再発行対象" : "再発行";
  if (options.reissueMode) actions.append(reissueButton);
  else actions.append(confirmButton, reissueButton);
  article.append(heading, specification, product, key, labelDate, department);
  if (options.reissueMode) article.append(readStatus);
  article.append(actions);
  return article;
}

function renderUnreadList() {
  const reissueMode = state.reissueFilterActive;
  const unread = reissueMode ? getReissueTargetLabels() : getUnreadLabels();
  const counts = getTargetCounts();
  renderDepartmentApprovalStatus();
  elements.unreadList.replaceChildren();
  elements.reissueExtractButton.classList.toggle("is-active", reissueMode);
  elements.reissueExtractButton.setAttribute("aria-pressed", String(reissueMode));
  elements.reissueExtractButton.textContent = reissueMode ? "再発行ラベル抽出中" : "再発行ラベル抽出";
  elements.unreadCountGrid.hidden = reissueMode;
  if (reissueMode) {
    elements.unreadPeriodLabel.textContent = `再発行ラベル抽出中　対象終了日：${formatDateForDisplay(state.targetEndDate)}まで`;
    elements.unreadDepartmentLabel.textContent = `対象部署：全部署 ／ 再発行対象 ${unread.length}件`;
    if (!unread.length) {
      elements.unreadList.append(createEmptyState("再発行対象のラベルはありません。"));
      return;
    }
    const fragment = document.createDocumentFragment();
    unread.forEach((row, index) => fragment.append(createUnreadItem(row, index, { reissueMode: true })));
    elements.unreadList.append(fragment);
    return;
  }
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
    facilityCode: elements.outputFacility.value,
    departmentCode: elements.outputDepartment.value,
    readStatus: elements.outputReadStatus.value,
    search: elements.outputSearch.value
  };
}

function updateOutputFilterOptions() {
  const selectedFacilityCode = elements.outputFacility.value;
  const selectedDepartmentCode = elements.outputDepartment.value;
  const facilities = getOutputScopeFacilities();
  elements.outputFacility.replaceChildren(
    new Option("すべて", ""),
    ...facilities.map((facility) => new Option(facility.facilityName, facility.facilityCode))
  );
  elements.outputFacility.value = facilities.some((facility) => facility.facilityCode === selectedFacilityCode) ? selectedFacilityCode : "";

  const facilityCode = elements.outputFacility.value;
  const departments = facilityCode ? getOutputScopeDepartments().filter((department) => department.facilityCode === facilityCode) : [];
  elements.outputDepartment.replaceChildren(
    new Option("すべて", ""),
    ...departments.map((department) => new Option(department.departmentName, department.departmentCode))
  );
  elements.outputDepartment.value = departments.some((department) => department.departmentCode === selectedDepartmentCode) ? selectedDepartmentCode : "";
  elements.outputDepartment.disabled = !facilityCode;
}

function renderOutputData() {
  if (!elements.outputList) return;
  elements.outputEndDate.textContent = formatDateForDisplay(state.targetEndDate);
  const allRecords = getOutputRecords();
  updateOutputFilterOptions();
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
    detail.textContent = `製品番号：${record.productNumber || ""}　ラベル：${record.labelKey || "―"}　日付：${record.labelDate}`;
    article.append(heading, title, place, detail);
    elements.outputList.append(article);
  });
}

function renderAll() {
  elements.targetEndDate.value = state.targetEndDate;
  const period = validateTargetEndDate();
  elements.periodError.textContent = period.ok ? "" : period.message;
  renderMaster();
  renderResetFacilities();
  renderDepartmentOptions();
  renderDepartment();
  renderCounts();
  renderScanner();
  renderUnreadList();
  renderOutputData();
  renderOverallStatus();
}

function switchSection(sectionId) {
  if (sectionId !== "unreadSection" && state.reissueFilterActive) state.reissueFilterActive = false;
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
    elements.departmentSelect, elements.resetFacilitySelect, elements.departmentApproverName, elements.departmentApprovalCheck
  ];
  if (!elements.departmentApprovalDialog.hidden || ignored.includes(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
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
  renderOverallStatus();
  return result;
}

function getPrintRowValues(row, index) {
  return [
    String(index + 1), `${row["施設名称"]} / ${row["部署名称"]}`, row["商品コード"] || "―", row["品名"] || "", row["規格"] || "",
    row["製品番号"] || "", row["ラベルキー"], formatMasterDate(row["払出予定伝票日付"]),
    isRowReissue(row) ? "ラベル再発行" : ""
  ];
}

function createPdfReportData(now = new Date()) {
  if (!state.currentDepartment) return null;
  const counts = getTargetCounts();
  const unread = getUnreadLabels();
  return {
    title: "SPD棚卸　未確認ラベルリスト",
    facilityName: state.currentDepartment.facilityName,
    departmentName: state.currentDepartment.departmentName,
    endDate: `${formatDateForDisplay(state.targetEndDate)} まで`,
    printedAt: formatLocalDateTime(now),
    countSummary: `対象 ${counts.target}件　読取済 ${counts.read}件　未読取 ${counts.unread}件`,
    fileDate: todayInputValue().replaceAll("-", ""),
    headers: PRINT_COLUMN_HEADERS,
    rows: unread.map(getPrintRowValues)
  };
}

function getScopedCurrentTargetLabels(filters = {}) {
  const scope = getOutputScopeDescriptor(filters);
  return getUniqueLabelRows(getOutputTargetLabels()).filter((row) => {
    if (scope.facilityCode && row["施設コード"] !== scope.facilityCode) return false;
    if (scope.departmentCode && row["部署コード"] !== scope.departmentCode) return false;
    return true;
  }).sort((left, right) => `${left["施設名称"]}\u0000${left["部署名称"]}\u0000${left["ラベルキー"]}`.localeCompare(`${right["施設名称"]}\u0000${right["部署名称"]}\u0000${right["ラベルキー"]}`, "ja"));
}

function createOutputUnreadPdfData(filters = {}, now = new Date()) {
  const scope = getOutputScopeDescriptor(filters);
  const targets = getScopedCurrentTargetLabels(scope);
  const unread = targets.filter((row) => !isRowRead(row));
  const readCount = targets.length - unread.length;
  return {
    title: "SPD棚卸　未確認ラベルリスト",
    facilityName: scope.facilityName,
    departmentName: scope.departmentName,
    endDate: `${formatDateForDisplay(state.targetEndDate)} まで`,
    printedAt: formatLocalDateTime(now),
    countSummary: `対象 ${targets.length}件　読取済 ${readCount}件　未読取 ${unread.length}件`,
    fileDate: todayInputValue(now).replaceAll("-", ""),
    fileScopeParts: scope.fileScopeParts,
    headers: PRINT_COLUMN_HEADERS,
    rows: unread.map(getPrintRowValues),
    targetCount: targets.length,
    unreadCount: unread.length
  };
}

function createDepartmentApprovalPdfData(approval) {
  if (!approval?.approvalKey) return null;
  return {
    reportType: "departmentApproval",
    title: "SPD棚卸　部署確認記録",
    facilityName: approval.facilityName || "",
    departmentName: approval.departmentName || "",
    endDate: formatDateForDisplay(approval.targetEndDate),
    confirmedBy: approval.confirmedBy ? `${approval.confirmedBy} 様` : "",
    confirmedAt: formatApprovalDateTime(approval.confirmedAt),
    countSummary: `対象 ${approval.targetCount || 0}件　読取済 ${approval.readCount || 0}件　未読取 ${approval.unreadCount || 0}件`,
    fileDate: todayInputValue(new Date(approval.confirmedAt)).replaceAll("-", ""),
    tableTitle: "未確認SPDラベル",
    headers: APPROVAL_PDF_HEADERS,
    columnRatios: APPROVAL_PDF_COLUMN_RATIOS,
    emptyMessage: approval.unreadCount ? "" : "未確認SPDラベル：0件",
    rows: (approval.unreadLabels || []).map((label, index) => [
      String(index + 1), label.productCode || "", label.productName || "", label.specification || "", label.productNumber || "",
      label.labelKey || "", label.labelDate || "", label.reissue ? "ラベル再発行" : ""
    ])
  };
}

function getDepartmentApprovalRecordsForScope(filters = {}) {
  const scope = getOutputScopeDescriptor(filters);
  return [...state.departmentApprovals.values()].filter((approval) => {
    if (scope.facilityCode && approval.facilityCode !== scope.facilityCode) return false;
    if (scope.departmentCode && approval.departmentCode !== scope.departmentCode) return false;
    return true;
  }).sort((left, right) => `${left.facilityName}\u0000${left.departmentName}\u0000${left.targetEndDate}\u0000${left.confirmedAt}`.localeCompare(`${right.facilityName}\u0000${right.departmentName}\u0000${right.targetEndDate}\u0000${right.confirmedAt}`, "ja"));
}

function createDepartmentApprovalBatchPdfData(approvals, filters = {}, now = new Date()) {
  const records = (approvals || []).filter((approval) => approval?.approvalKey);
  if (!records.length) return null;
  const scope = getOutputScopeDescriptor(filters);
  return {
    reportType: "departmentApproval",
    title: "SPD棚卸　部署確認記録",
    facilityName: scope.facilityName,
    departmentName: scope.departmentName,
    fileDate: todayInputValue(now).replaceAll("-", ""),
    fileScopeParts: scope.fileScopeParts,
    headers: APPROVAL_PDF_HEADERS,
    columnRatios: APPROVAL_PDF_COLUMN_RATIOS,
    sections: records.map(createDepartmentApprovalPdfData)
  };
}

function openPdfLoadingWindow(windowRef = window) {
  try {
    // ポップアップ制限を避けるため、利用者のクリック処理内で表示先を先に確保する。
    const preview = windowRef.open("about:blank", "_blank");
    if (!preview) return null;
    preview.document.title = "棚卸くん PDF生成中";
    preview.document.body.textContent = "PDFを生成しています。しばらくお待ちください。";
    return preview;
  } catch {
    return null;
  }
}

function createPdfBlob(pdfBytes, BlobRef = Blob) {
  if (!pdfBytes?.byteLength) throw new Error("PDFデータが0バイトです。");
  const pdfBlob = new BlobRef([pdfBytes], { type: "application/pdf" });
  if (!pdfBlob.size) throw new Error("PDF Blobが0バイトです。");
  return pdfBlob;
}

function displayPdfUrl(previewWindow, pdfUrl) {
  if (!previewWindow || previewWindow.closed) throw new Error("PDF表示用の画面が閉じられています。");
  if (!pdfUrl) throw new Error("PDF表示用URLがありません。");
  previewWindow.location.href = pdfUrl;
  return true;
}

async function generateAndOpenPdf(previewWindow = null) {
  const report = createPdfReportData();
  if (!report) {
    previewWindow?.close();
    elements.unreadActionMessage.textContent = "PDFの生成または表示に失敗しました：棚卸する部署を選択してください。";
    return false;
  }
  if (!globalThis.InventoryPdf?.generateInventoryPdf) {
    previewWindow?.close();
    elements.unreadActionMessage.textContent = "PDFの生成または表示に失敗しました：PDF生成機能を読み込めません。画面を再読み込みしてください。";
    playAlertSound();
    return false;
  }
  if (!previewWindow || previewWindow.closed) {
    elements.unreadActionMessage.textContent = "PDFの生成または表示に失敗しました：PDF表示用の画面を開けません。ブラウザのポップアップ設定を確認してください。";
    playAlertSound();
    return false;
  }
  const originalLabel = elements.printPreviewButton.textContent;
  elements.printPreviewButton.disabled = true;
  elements.printPreviewButton.textContent = "PDF生成中…";
  elements.unreadActionMessage.textContent = "A4横向きPDFを端末内で生成しています。";
  try {
    const result = await globalThis.InventoryPdf.generateInventoryPdf(report, {
      fontUrl: new URL("./vendor/NotoSansCJKjp-Regular.ttf", document.baseURI).href
    });
    const pdfBlob = createPdfBlob(result.bytes);
    const pdfUrl = URL.createObjectURL(pdfBlob);
    if (!pdfUrl) throw new Error("PDF表示用URLを生成できません。");
    if (activePdfUrl) URL.revokeObjectURL(activePdfUrl);
    activePdfUrl = pdfUrl;
    elements.unreadActionMessage.textContent = `${result.pageCount}ページのPDFを生成しました。PDFの共有メニューから印刷できます。`;
    displayPdfUrl(previewWindow, pdfUrl);
    return true;
  } catch (error) {
    if (previewWindow && !previewWindow.closed) previewWindow.close();
    elements.unreadActionMessage.textContent = `PDFの生成または表示に失敗しました：${error.message}`;
    playAlertSound();
    return false;
  } finally {
    elements.printPreviewButton.textContent = originalLabel;
    elements.printPreviewButton.disabled = !state.currentDepartment || !validateTargetEndDate().ok;
  }
}

async function generateAndOpenDepartmentApprovalPdf(previewWindow = null, approval = activeDepartmentApproval) {
  const report = createDepartmentApprovalPdfData(approval);
  if (!report) {
    previewWindow?.close();
    elements.departmentApprovalMessage.textContent = "承認記録PDFの生成に必要な保存済み記録がありません。";
    return false;
  }
  if (!globalThis.InventoryPdf?.generateInventoryPdf || !previewWindow || previewWindow.closed) {
    previewWindow?.close();
    elements.departmentApprovalExistingMessage.textContent = "承認記録PDFの表示先を開けません。ブラウザのポップアップ設定を確認してください。";
    playAlertSound();
    return false;
  }
  const originalLabel = elements.departmentApprovalPdfButton.textContent;
  elements.departmentApprovalPdfButton.disabled = true;
  elements.departmentApprovalPdfButton.textContent = "PDF生成中…";
  try {
    const result = await globalThis.InventoryPdf.generateInventoryPdf(report, {
      fontUrl: new URL("./vendor/NotoSansCJKjp-Regular.ttf", document.baseURI).href
    });
    const pdfBlob = createPdfBlob(result.bytes);
    const pdfUrl = URL.createObjectURL(pdfBlob);
    if (!pdfUrl) throw new Error("PDF表示用URLを生成できません。");
    if (activePdfUrl) URL.revokeObjectURL(activePdfUrl);
    activePdfUrl = pdfUrl;
    displayPdfUrl(previewWindow, pdfUrl);
    return true;
  } catch (error) {
    if (previewWindow && !previewWindow.closed) previewWindow.close();
    elements.departmentApprovalExistingMessage.textContent = `承認記録PDFの生成または表示に失敗しました：${error.message}`;
    playAlertSound();
    return false;
  } finally {
    elements.departmentApprovalPdfButton.textContent = originalLabel;
    elements.departmentApprovalPdfButton.disabled = false;
  }
}

function setOutputPdfBusy(busy, activeButton = null) {
  outputPdfBusy = busy;
  [elements.exportDataButton, elements.exportUnreadPdfButton, elements.exportApprovalPdfButton].forEach((button) => {
    if (button) button.disabled = busy;
  });
  if (busy && activeButton) {
    activeButton.dataset.originalLabel = activeButton.textContent;
    activeButton.textContent = "PDFを作成しています…";
  } else {
    [elements.exportUnreadPdfButton, elements.exportApprovalPdfButton].forEach((button) => {
      if (button?.dataset.originalLabel) {
        button.textContent = button.dataset.originalLabel;
        delete button.dataset.originalLabel;
      }
    });
  }
}

async function generateAndShareOutputPdf(reportType) {
  if (outputPdfBusy) return false;
  const filters = getOutputFiltersFromUi();
  const activeButton = reportType === "departmentApproval" ? elements.exportApprovalPdfButton : elements.exportUnreadPdfButton;
  let report;
  if (reportType === "departmentApproval") {
    const approvals = getDepartmentApprovalRecordsForScope(filters);
    if (!approvals.length) {
      elements.outputMessage.textContent = "対象となる部署確認記録がありません。";
      return false;
    }
    report = createDepartmentApprovalBatchPdfData(approvals, filters);
  } else {
    const validation = validateTargetEndDate();
    if (!validation.ok) {
      elements.outputMessage.textContent = validation.message;
      return false;
    }
    report = createOutputUnreadPdfData(filters);
    if (!report.unreadCount) {
      elements.outputMessage.textContent = "対象となる未確認ラベルはありません。";
      return false;
    }
  }
  if (!globalThis.InventoryPdf?.generateInventoryPdf) {
    elements.outputMessage.textContent = "PDF生成機能を読み込めません。画面を再読み込みしてください。";
    return false;
  }

  setOutputPdfBusy(true, activeButton);
  elements.outputMessage.textContent = "PDFを作成しています…";
  try {
    const result = await globalThis.InventoryPdf.generateInventoryPdf(report, {
      fontUrl: new URL("./vendor/NotoSansCJKjp-Regular.ttf", document.baseURI).href
    });
    const method = await shareOutputPdf(result);
    const sizeKilobytes = Math.max(1, Math.round(result.bytes.byteLength / 1024)).toLocaleString("ja-JP");
    elements.outputMessage.textContent = method === "shared"
      ? `${result.pageCount}ページ（${sizeKilobytes}KB）のPDFを共有画面へ渡しました。`
      : `${result.pageCount}ページ（${sizeKilobytes}KB）のPDFをダウンロードしました。`;
    return true;
  } catch (error) {
    if (error.name !== "AbortError") {
      elements.outputMessage.textContent = `PDFを出力できませんでした：${error.message}`;
      playAlertSound();
    }
    return false;
  } finally {
    setOutputPdfBusy(false);
  }
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
      elements.resetInventoryMessage.textContent = "";
      const stateSummary = `読取済 ${applied.retainedReadCount.toLocaleString("ja-JP")}件（手動確認 ${applied.retainedManualCount.toLocaleString("ja-JP")}件）／再発行 ${applied.retainedReissueCount.toLocaleString("ja-JP")}件を引き継ぎ、新規 ${applied.addedLabelCount.toLocaleString("ja-JP")}件、対象外 ${applied.removedLabelCount.toLocaleString("ja-JP")}件です。`;
      const departmentNotice = applied.departmentCleared ? " 再取込前の部署は最新データの対象にないため、部署選択を解除しました。" : "";
      showImportMessage(`有効取込 ${applied.rowCount.toLocaleString("ja-JP")}件／エラー除外 ${applied.errorExcludedCount.toLocaleString("ja-JP")}件。${stateSummary}${departmentNotice}${applied.masterSaved ? "" : " ブラウザ保存容量が不足したため、再起動後は再取込が必要です。"}`, "ok");
      if (applied.departmentPreserved) {
        showResult("idle", "棚卸状態を引き継ぎました", `${state.currentDepartment.facilityName} / ${state.currentDepartment.departmentName} の棚卸を続けられます。`);
      } else if (applied.departmentCleared) {
        showResult("warning", "部署選択を解除しました", `${applied.previousDepartment.facilityName} / ${applied.previousDepartment.departmentName} は最新データの対象にありません。部署を選び直してください。`);
      } else {
        showResult("idle", "部署を選択してください", "対象終了日を確認し、棚卸する施設・部署を選択してください。");
      }
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
    elements.departmentSelect.blur();
    selectDepartmentForInventory(selected);
  });

  elements.overallStatusButton.addEventListener("click", openOverallStatus);
  elements.overallStatusCloseButton.addEventListener("click", closeOverallStatus);
  elements.overallStatusDialog.addEventListener("click", (event) => {
    if (event.target === elements.overallStatusDialog) closeOverallStatus();
  });
  elements.overallDepartmentList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-department-key]");
    if (!button) return;
    const selected = getEligibleDepartments().find((department) => departmentKey(department) === button.dataset.departmentKey) || null;
    if (!selected) return;
    closeOverallStatus();
    switchSection("checkSection");
    selectDepartmentForInventory(selected);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!elements.departmentApprovalDialog.hidden) {
      closeDepartmentApprovalDialog();
      return;
    }
    if (!elements.overallStatusDialog.hidden) closeOverallStatus();
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

  elements.resetFacilitySelect.addEventListener("change", () => {
    elements.resetInventoryButton.disabled = !elements.resetFacilitySelect.value;
    elements.resetInventoryMessage.textContent = "";
  });
  elements.resetInventoryButton.addEventListener("click", openResetConfirmDialog);
  elements.cancelResetButton.addEventListener("click", closeResetConfirmDialog);
  elements.executeResetButton.addEventListener("click", () => { void executeFacilityReset(); });
  elements.resetConfirmDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeResetConfirmDialog();
  });

  elements.printPreviewButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const previewWindow = openPdfLoadingWindow();
    void generateAndOpenPdf(previewWindow);
  });
  elements.departmentApprovalButton.addEventListener("click", openDepartmentApprovalDialog);
  elements.departmentApprovalCloseButton.addEventListener("click", closeDepartmentApprovalDialog);
  elements.departmentApprovalDialog.addEventListener("click", (event) => {
    if (event.target === elements.departmentApprovalDialog) closeDepartmentApprovalDialog();
  });
  elements.executeDepartmentApprovalButton.addEventListener("click", () => { void executeDepartmentApproval(); });
  elements.departmentApproverName.addEventListener("input", () => { elements.departmentApprovalMessage.textContent = ""; });
  elements.departmentApprovalCheck.addEventListener("change", () => { elements.departmentApprovalMessage.textContent = ""; });
  elements.departmentApprovalPdfButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const previewWindow = openPdfLoadingWindow();
    void generateAndOpenDepartmentApprovalPdf(previewWindow);
  });
  elements.cancelDepartmentApprovalButton.addEventListener("click", () => { void cancelCurrentDepartmentApproval(); });
  elements.reissueExtractButton.addEventListener("click", () => {
    state.reissueFilterActive = !state.reissueFilterActive;
    elements.unreadActionMessage.textContent = state.reissueFilterActive ? "全部署の再発行対象ラベルを表示しています。" : "通常の未読取一覧へ戻りました。";
    renderUnreadList();
  });
  elements.unreadList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action][data-label-key]");
    if (!button) return;
    const labelKey = button.dataset.labelKey;
    const facilityCode = button.dataset.facilityCode;
    if (button.dataset.action === "reissue") {
      const enabled = toggleReissueLabel(labelKey, facilityCode);
      elements.unreadActionMessage.textContent = enabled ? `ラベルキー ${labelKey} を再発行対象にしました。` : `ラベルキー ${labelKey} の再発行対象を解除しました。`;
      renderUnreadList();
      renderOutputData();
      renderOverallStatus();
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
    elements.unreadActionMessage.textContent = `${result.row["品名"] || "対象ラベル"}を手動確認で読取済にしました。未読取 ${result.counts.unread}件`;
    renderCounts();
    renderUnreadList();
    renderOutputData();
    renderOverallStatus();
  });

  elements.outputFacility.addEventListener("change", () => {
    elements.outputDepartment.value = "";
    renderOutputData();
  });
  [elements.outputDepartment, elements.outputReadStatus].forEach((input) => input.addEventListener("change", renderOutputData));
  elements.outputSearch.addEventListener("input", renderOutputData);
  elements.exportDataButton.addEventListener("click", async () => {
    try {
      const filters = getOutputFiltersFromUi();
      const records = filterOutputRecords(getOutputRecords(), { facilityCode: filters.facilityCode, departmentCode: filters.departmentCode });
      const method = await shareOutputCsv(records);
      elements.outputMessage.textContent = method === "shared" ? `${records.length}件の共有画面を開きました。` : `${records.length}件のCSVをダウンロードしました。`;
    } catch (error) {
      if (error.name !== "AbortError") elements.outputMessage.textContent = error.message;
    }
  });
  elements.exportUnreadPdfButton.addEventListener("click", () => { void generateAndShareOutputPdf("unread"); });
  elements.exportApprovalPdfButton.addEventListener("click", () => { void generateAndShareOutputPdf("departmentApproval"); });

  window.addEventListener("keydown", handleGlobalKeydown);
}

async function init() {
  cacheElements();
  restoreState();
  initAudio();
  bindEvents();
  await Promise.all([loadDepartmentApprovals(), loadScanHistory()]);
  renderAll();
  if (state.currentDepartment) showResult("idle", "読取待機中", `${state.currentDepartment.facilityName} / ${state.currentDepartment.departmentName} のSPDラベルを読み取ってください。`);
  document.body.dataset.appReady = "true";
}

async function removeLegacyPwaArtifacts() {
  // 過去版を利用した端末だけを対象に、旧Service Workerと棚卸くんの旧キャッシュを解除する。
  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const appScope = new URL("./", document.baseURI).href;
      await Promise.all(registrations.filter((registration) => registration.scope === appScope).map((registration) => registration.unregister()));
    }
    if ("caches" in globalThis) {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.filter((name) => name.startsWith("inventory-kun-")).map((name) => caches.delete(name)));
    }
  } catch {
    // 旧PWA資材の解除に失敗しても通常Webアプリの業務処理は継続する。
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    void removeLegacyPwaArtifacts();
    void init();
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    REQUIRED_HEADERS, OPTIONAL_VALUE_HEADERS, PRINT_COLUMN_HEADERS, APPROVAL_PDF_HEADERS, APPROVAL_PDF_COLUMN_RATIOS, state, normalizeLabelKey, splitTsvRecords, isValidDateKey, parseTsv, buildLabelKey, normalizeQr,
    getExpectedCenterCode, departmentKey, departmentFromRow, facilityKey, facilityFromRow, inventoryStateKey, inventoryStateKeyForRow, parseInventoryStateKey, departmentApprovalKey, parseDepartmentApprovalKey, currentDepartmentApprovalKey, getDepartmentApproval, rebuildIndexes, findLabel, parseDateInput, validateTargetEndDate,
    isRowOnOrBeforeEndDate, matchesDepartment, getEligibleDepartments, getUniqueLabelRows, getCurrentTargetLabels, getUnreadLabels,
    getTargetCounts, getDepartmentProgress, getOverallProgress, getOutputTargetLabels, getResetFacilities, getReissueTargetLabels, getOutputRecords, getOutputScopeDepartments, getOutputScopeFacilities, getOutputScopeDescriptor, getScopedCurrentTargetLabels, getDepartmentApprovalRecordsForScope, validateSpdLabel, acceptSpdLabel, confirmUnreadLabel, toggleReissueLabel,
    isCompletionTransition, resetInventoryForFacility, migrateStoredStateKey, getPrintRowValues, createPdfReportData, createOutputUnreadPdfData, createDepartmentApprovalPdfData, createDepartmentApprovalBatchPdfData, todayInputValue, formatDateForDisplay, formatMasterDate, formatApprovalDateTime, applyMasterData, saveState, restoreState, createHistoryRecord,
    snapshotLabel, createDepartmentApprovalSnapshot, departmentApprovalContentSignature, currentDepartmentApprovalSignature, isDepartmentApprovalOutdated,
    createOutputRecord, filterOutputRecords, buildOutputCsv, createPdfFile, shareOutputPdf, openPdfLoadingWindow, createPdfBlob, displayPdfUrl, removeLegacyPwaArtifacts
  };
}
