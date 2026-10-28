// ==UserScript==
// @name         百度网盘直链极速下载（勾选版·重写）
// @namespace    https://tampermonkey.net/
// @author       基于百万修改版 2.0.3-clean 重写
// @version      3.0.0-clean
// @description  勾选文件后点悬浮按钮批量极速下载。核心：官方 locatedownload 接口获取直链，非 pdf 先临时重命名为 .pdf 绕过限制，下载后恢复原名。读取页面 Vue 状态取已勾选文件，不依赖表格 DOM；接口走页面原生 fetch（同源带 Cookie，Via 等手机浏览器可用）。
// @match        https://pan.baidu.com/disk/main*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @connect      pan.baidu.com
// @connect      baidupcs.com
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  // ==================== 配置 ====================
  const CFG = {
    LOG_PREFIX: "[BaiduPanClean]",
    FILE_PATTERN: /^.+\..+\.pdf$/i, // locatedownload 对 .pdf 友好，非 pdf 先临时改名
    RENAME_WAIT_MS: 3000,
    BTN_ID: "bp-clean-float",
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $win = () => (typeof unsafeWindow !== "undefined" ? unsafeWindow : window);
  const info = (...a) => console.info(CFG.LOG_PREFIX, ...a);
  const warn = (...a) => console.warn(CFG.LOG_PREFIX, ...a);
  const err = (...a) => console.error(CFG.LOG_PREFIX, ...a);

  // ==================== 读取已勾选文件（三条通道，来自 LinkSwift 的成熟适配） ====================
  // 不再扫描表格 DOM：直接读页面框架维护的选中列表，任何视图（列表/缩略图）和改版都更抗性。
  function getSelectedFiles() {
    const w = $win();
    let list = [];

    // 通道 1：新版 wp-s UI，核心面板 Vue 实例的 selectedList
    try {
      const wpCore = document.querySelector(".wp-s-core-pan");
      if (wpCore?.__vue__?.selectedList?.length) list = wpCore.__vue__.selectedList;
    } catch { }

    // 通道 2：旧版列表组件的 allFileList 中带 selected 标记的项
    if (!list.length) {
      try {
        const fileList = document.querySelector(".file-list");
        if (fileList?.__vue__?.allFileList?.length) list = fileList.__vue__.allFileList.filter((item) => !!item.selected);
      } catch { }
    }

    // 通道 3：最老的内核上下文
    if (!list.length) {
      try {
        const context = w.require?.("system-core:context/context.js");
        const got = context?.instanceForSystem?.list?.getSelected?.();
        if (got?.length) list = got;
      } catch { }
    }

    // 归一化：id / path / name / isdir
    const files = [];
    for (const item of list) {
      const name = item.server_filename || item.filename || item.name || item.serverFilename;
      const path = item.path || (name ? null : null);
      const id = item.fs_id ?? item.fsid ?? item.id;
      const isdir = !!(item.isdir === 1 || item.isdir === true || item.isdir);
      if (!name || !path || isdir) continue;
      files.push({ id: Number.isFinite(Number(id)) ? Number(id) : id, path: String(path), name: String(name) });
    }
    return files;
  }

  // ==================== 页面原生请求（同源自动带 Cookie，Via 可用） ====================
  async function pageRequest(url, options = {}) {
    const resp = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers,
      body: options.body,
      credentials: "include",
    });
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      return { errno: -1, errmsg: "响应不是 JSON", raw: text.slice(0, 200) };
    }
  }

  function getBdstoken() {
    try {
      return $win()?.locals?.userInfo?.bdstoken || null;
    } catch {
      return null;
    }
  }

  // ==================== 核心：获取直链 ====================
  function buildDownloadUrl(filePath) {
    const url = new URL("https://pan.baidu.com/api/locatedownload");
    const params = {
      clienttype: "0",
      app_id: "250528",
      web: "1",
      channel: "chunlei",
      path: filePath,
      origin: "pdf",
      use: "1",
    };
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const token = getBdstoken();
    if (token) url.searchParams.set("bdstoken", token);
    return url.toString();
  }

  function extractDlink(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (typeof obj.dlink === "string" && obj.dlink) return obj.dlink;
    if (typeof obj?.data?.dlink === "string" && obj.data.dlink) return obj.data.dlink;
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") {
        const found = extractDlink(v);
        if (found) return found;
      }
    }
    return null;
  }

  async function fetchDirectLink(filePath) {
    const data = await pageRequest(buildDownloadUrl(filePath), {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    const dlink = extractDlink(data);
    if (!dlink) {
      const msg = data.errmsg || data.show_msg || "无法获取直链，可能文件大于 150MB 或接口受限";
      throw new Error(msg);
    }
    return dlink;
  }

  // ==================== 临时重命名 ====================
  async function remoteRename(fileId, filePath, newName) {
    const url = new URL("https://pan.baidu.com/api/filemanager");
    const params = { async: "2", onnest: "fail", opera: "rename", clienttype: "0", app_id: "250528", web: "1" };
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const token = getBdstoken();
    if (token) url.searchParams.set("bdstoken", token);

    const filelist = JSON.stringify([{ id: fileId, path: filePath, newname: newName }]);
    const data = await pageRequest(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
      body: `filelist=${encodeURIComponent(filelist)}`,
    });

    if (data.errno !== 0) {
      throw new Error(`重命名失败 [${data.errno}]: ${data.show_msg || data.errmsg || "未知错误"}`);
    }
    return data;
  }

  // ==================== 下载文件 ====================
  function fallbackGM(url, name) {
    return new Promise((resolve, reject) => {
      if (typeof GM_download !== "function") return reject(new Error("GM_download 不可用"));
      GM_download({
        url,
        name,
        headers: { Referer: "https://pan.baidu.com/" },
        onload: resolve,
        onerror: reject,
        ontimeout: () => reject(new Error("下载超时")),
      });
    });
  }

  function anchorDownload(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function downloadFile(url, fileName) {
    const saveName = fileName.replace(/\.pdf$/i, "");
    try {
      const resp = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          responseType: "arraybuffer",
          anonymous: false,
          headers: { Referer: "https://pan.baidu.com/" },
          onload: resolve,
          onerror: reject,
          ontimeout: () => reject(new Error("下载超时")),
        });
      });
      const buffer = resp.response;
      if (!buffer) throw new Error("下载数据为空");
      const ct = (resp.responseHeaders || "").match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim() || "application/octet-stream";
      const blob = new Blob([buffer], { type: ct });
      const blobUrl = URL.createObjectURL(blob);
      anchorDownload(blobUrl, saveName);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    } catch (e) {
      warn("Blob 下载失败，尝试 GM_download:", e);
      try {
        await fallbackGM(url, saveName);
      } catch (e2) {
        warn("GM_download 失败，回退为直接打开直链:", e2);
        anchorDownload(url, saveName);
      }
    }
  }

  // ==================== 单文件流水线 ====================
  function needTempRename(fileName) {
    return !CFG.FILE_PATTERN.test(fileName);
  }

  async function runPipeline(file, onProgress) {
    const originalName = file.name;
    let currentName = originalName;
    let needRestore = false;
    let downloadError = null;

    // 1) 非 pdf 先临时重命名
    if (needTempRename(currentName)) {
      if (!file.id) throw new Error("无法获取文件ID");
      const renamed = `${currentName}.pdf`;
      onProgress?.("改名中");
      await remoteRename(file.id, file.path, renamed);
      currentName = renamed;
      needRestore = true;
      await sleep(CFG.RENAME_WAIT_MS);
    }

    // 2) 获取直链并下载
    try {
      const filePath = file.path.replace(/[^/]+$/, "") + currentName;
      onProgress?.("解析直链");
      const url = await fetchDirectLink(filePath);
      onProgress?.("下载中");
      await downloadFile(url, currentName);
    } catch (e) {
      downloadError = e;
    }

    // 3) 恢复原名
    if (needRestore) {
      try {
        await remoteRename(file.id, file.path.replace(/[^/]+$/, "") + currentName, originalName);
      } catch (e) {
        err("恢复文件名失败:", e);
        if (!downloadError) throw e;
      }
    }

    if (downloadError) throw downloadError;
  }

  // ==================== 悬浮按钮与进度 ====================
  function ensureButton() {
    if (document.getElementById(CFG.BTN_ID)) return;
    const btn = document.createElement("div");
    btn.id = CFG.BTN_ID;
    btn.innerHTML = `<span class="bp-float-icon">⚡</span><span class="bp-float-text">极速下载</span><span class="bp-float-badge"></span>`;
    btn.addEventListener("click", onFloatClick);
    document.body.appendChild(btn);
    const css = `
      #${CFG.BTN_ID}{position:fixed;right:24px;bottom:88px;z-index:999998;display:flex;align-items:center;gap:6px;padding:10px 14px;border-radius:22px;background:#fff9ec;border:1px solid #f7b955;color:#8a5a00;font-size:13px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.15);user-select:none}
      #${CFG.BTN_ID}:hover{background:#fff3dc}
      #${CFG.BTN_ID}.busy{opacity:.75;pointer-events:none}
      #${CFG.BTN_ID} .bp-float-badge{min-width:18px;height:18px;line-height:18px;border-radius:9px;background:#f7b955;color:#fff;font-size:11px;text-align:center;padding:0 4px;display:none}
      #${CFG.BTN_ID} .bp-float-badge.on{display:inline-block}
      #bp-clean-panel{position:fixed;right:24px;bottom:132px;z-index:999998;max-width:320px;background:#fff;border:1px solid #eee;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);font-size:12px;color:#333;display:none}
      #bp-clean-panel .bp-panel-head{padding:8px 12px;border-bottom:1px solid #f2f2f2;font-weight:600}
      #bp-clean-panel .bp-panel-body{padding:8px 12px;max-height:200px;overflow-y:auto;line-height:1.7}
      #bp-clean-panel .ok{color:#2ca02c}
      #bp-clean-panel .bad{color:#d33}
      #bp-clean-panel .cur{color:#2f6bff}
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const panel = document.createElement("div");
    panel.id = "bp-clean-panel";
    panel.innerHTML = `<div class="bp-panel-head">下载状态</div><div class="bp-panel-body"></div>`;
    document.body.appendChild(panel);
  }

  function setPanel(lines, current) {
    const body = document.querySelector("#bp-clean-panel .bp-panel-body");
    if (!body) return;
    body.innerHTML = lines.map((l) => `<div>${l}</div>`).join("") + (current ? `<div class="cur">▶ ${current}</div>` : "");
  }

  function setBadge(n) {
    const badge = document.querySelector(`#${CFG.BTN_ID} .bp-float-badge`);
    if (!badge) return;
    badge.textContent = String(n);
    badge.classList.toggle("on", n > 0);
  }

  let running = false;
  async function onFloatClick() {
    if (running) return;
    const btn = document.getElementById(CFG.BTN_ID);
    const files = getSelectedFiles();
    const panel = document.getElementById("bp-clean-panel");
    const lines = [];
    if (!files.length) {
      panel.style.display = "block";
      setPanel([`<span class="bad">没有勾选任何文件~</span>`, `先在列表中勾选要下载的文件，再点本按钮。`]);
      return;
    }
    running = true;
    btn.classList.add("busy");
    panel.style.display = "block";
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setBadge(i + 1);
      setPanel(lines, `${file.name}`);
      try {
        await runPipeline(file, (stage) => setPanel(lines, `${stage}：${file.name}`));
        ok++;
        lines.push(`<span class="ok">✓ ${file.name}</span>`);
      } catch (e) {
        err("下载处理失败:", e);
        lines.push(`<span class="bad">✗ ${file.name}：${e.message || e}</span>`);
      }
      setPanel(lines);
      if (i + 1 < files.length) await sleep(800);
    }
    lines.push(`<div>完成：${ok}/${files.length}</div>`);
    setPanel(lines);
    setBadge(0);
    btn.classList.remove("busy");
    running = false;
  }

  // ==================== 启动 ====================
  function start() {
    ensureButton();
    info("已注入悬浮按钮，勾选文件后点击即可批量极速下载");
    // 兜底：SPA 路由切换后按钮可能被页面重建吞掉，定期确保存在
    setInterval(ensureButton, 3000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
