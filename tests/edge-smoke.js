"use strict";

const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const edgeCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const edgePath = edgeCandidates.find(fs.existsSync);
if (!edgePath) throw new Error("Microsoft Edgeが見つかりません。");

const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-kun-edge-"));
const screenshotPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
try {
  const pageUrl = pathToFileURL(path.resolve(__dirname, "..", "index.html")).href;
  const child = spawnSync(edgePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--window-size=390,844",
    "--disable-features=msEdgeFirstRunExperience",
    `--user-data-dir=${profilePath}`, "--dump-dom", pageUrl
  ], { encoding: "utf8", timeout: 20000, windowsHide: true });

  const dom = child.stdout || "";
  const result = {
    status: child.status,
    error: child.error?.code || null,
    domBytes: Buffer.byteLength(dom),
    title: dom.includes("<title>棚卸くん</title>"),
    initialized: dom.includes('data-app-ready="true"'),
    endDateOnly: !dom.includes('id="targetStartDate"') && dom.includes('id="targetEndDate"'),
    departmentSelect: dom.includes('id="departmentSelect"'),
    counts: dom.includes('id="targetCount"') && dom.includes('id="readCount"') && dom.includes('id="unreadCount"'),
    hiddenScannerRemoved: !dom.includes('id="scanInput"'),
    unreadList: dom.includes('id="unreadList"') && dom.includes('id="printPreviewButton"')
      && dom.includes('id="reissueExtractButton"') && !dom.includes('id="executePrintButton"'),
    fourTabs: ["checkSection", "unreadSection", "historySection", "masterSection"]
      .every((section) => dom.includes(`data-section="${section}"`)),
    historyScreen: dom.includes('id="outputList"') && dom.includes('id="exportDataButton"')
      && dom.includes('id="outputEndDate"') && !dom.includes('id="historyStartDate"'),
    removedShippingControls: !dom.includes('id="skipButton"') && !dom.includes('id="pendingProductPanel"')
      && !dom.includes('id="clearDepartmentButton"'),
    pwaRemoved: !dom.includes('rel="manifest"') && !dom.includes('rel="apple-touch-icon"')
      && !dom.includes('apple-mobile-web-app-capable'),
    scannerStatus: dom.includes('id="scannerBufferStatus"')
  };
  console.log(JSON.stringify(result));
  if (!result.title || !result.initialized || !result.endDateOnly || !result.departmentSelect
    || !result.counts || !result.hiddenScannerRemoved || !result.unreadList || !result.fourTabs || !result.historyScreen || !result.removedShippingControls
    || !result.pwaRemoved || !result.scannerStatus) {
    if (child.stderr) console.error(child.stderr);
    process.exitCode = 1;
  }

  if (screenshotPath) {
    const screenshot = spawnSync(edgePath, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--window-size=500,844", "--hide-scrollbars",
      "--disable-features=msEdgeFirstRunExperience",
      `--user-data-dir=${profilePath}`, `--screenshot=${screenshotPath}`, pageUrl
    ], { encoding: "utf8", timeout: 20000, windowsHide: true });
    if (screenshot.status !== 0 || !fs.existsSync(screenshotPath)) {
      console.error(screenshot.stderr || "390px画面のスクリーンショットを作成できませんでした。");
      process.exitCode = 1;
    }
  }
} finally {
  fs.rmSync(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
