/**
 * SSM087 流程详情页停留时长采集脚本
 * - 仅在网址包含 SSM087、页面可见文本含完整“同意，提交”、且看不到“催办”时工作
 * - 流程编号取自 #control1，项目号取自 xiangmuhao 字段
 * - 统计规则：页面“可见”即计时；切到其他标签页 / 最小化时暂停；
 *   切到其他程序但浏览器仍可见（blur）时继续计时
 * - 存储结构：
 *   { records: { [流程编号]: { [YYYY-MM-DD]: 秒 } },
 *     flowProjects: { [流程编号]: 项目号 } }
 * - 扩展被重新加载时，旧内容脚本的 chrome.storage 上下文会失效；
 *   此处统一捕获并停止计时，避免 "Extension context invalidated" 报错。
 */
(function () {
  'use strict';

  // 网址不含 SSM087 的页面直接退出
  if (window.location.href.toUpperCase().indexOf('SSM087') === -1) return;

  var STORAGE_KEY = 'records';
  var FLUSH_INTERVAL_MS = 5000; // 每 5 秒落盘一次，降低意外关闭时的丢失
  var TICK_MS = 1000;

  // ===== 流程编号自动重试识别 =====
  // 页面加载慢时 control1 可能迟迟不渲染；读不到不能立刻写死「未识别流程」，
  // 否则刷新后新页识别成功会留下「未识别 + 真编号」两条记录。
  var UNRECOGNIZED = '（未识别流程）';
  var PROCESS_NO_MAX_ATTEMPTS = 5;  // 最多重试 5 次
  var PROCESS_NO_RETRY_MS = 4000;   // 两次尝试间隔 4 秒（5 次约覆盖 20 秒）
  var UNRECOGNIZED_WINDOW_MS = 10 * 60 * 1000; // 跨标签页归并「未识别」的时间窗
  var processNoAttempts = 0;
  var nextProcessNoAttemptAt = 0;
  var unrecognizedAt = 0;          // 最近一次落入「未识别」的时刻（来自 storage）

  var processNo = '';
  var projectNo = '';
  var buckets = {};      // { 'YYYY-MM-DD': 毫秒 }，尚未落盘的时间
  var lastTick = null;
  var cachedRecords = {};      // 已落盘记录的本地缓存，供悬浮计时实时读取
  var cachedFlowProjects = {}; // { 流程编号: 项目号 }

  // 悬浮窗状态标签的“粘滞”缓存：页面工具栏按钮会动态变化，
  // 状态文字需稳定保持一段时间才切换，避免“计时中/未计时”来回闪。
  var displayGate = null;      // { ok, reason } 当前显示的状态
  var gateCandidate = null;    // { ok, reason } 候选状态
  var gateCandidateSince = 0;  // 候选状态出现的时间
  var GATE_HOLD_MS = 3000;     // 状态需稳定保持 3 秒才切换

  // ===== 「切标签继续计时」模式（勾选后后台继续，另一条流程开始计时则让位）=====
  var RUN_ID = String(Date.now()) + '-' + String(Math.random()).slice(2);
  var continuousMode = false;   // 来自 popup 勾选状态
  var yielded = false;          // 已让位给另一条流程：本页停止累加
  var owningActive = false;     // 本页是否为当前计时的流程
  var activeTiming = null;      // { runId, processNo, ts }
  var lastEligible = false;     // 后台标签 innerText 可能读不到，缓存最近一次可见时的门控结果
  var ACTIVE_HEARTBEAT_MS = 3000;
  var ACTIVE_STALE_MS = 12000;
  var MAX_TICK_DELTA_MS = 10 * 60 * 1000; // 后台标签被浏览器节流时允许较长 tick 间隔

  // ===== 加载阶段：时间先暂存，加载完成后再决定归属 =====
  var loading = true;           // 表单是否还没渲染完成
  var carryMs = 0;              // 加载期间暂存、尚未归属的毫秒
  var prevOwnerFlow = null;     // 打开本页时正在后台计时的流程编号
  var sheetReadySince = 0;
  var loadingSince = Date.now(); // 本页开始加载的时刻，用于超时兜底
  var LOAD_RESOLVE_MS = 1000;   // 表单可见后再稳定 1 秒才判定是否需要计时
  var LOAD_TIMEOUT_MS = 180000; // 表单始终不出现时最多暂存 3 分钟，避免永久不落盘

  // ===== 扩展上下文失效保护 =====
  var contextInvalidated = false;
  var intervalIds = [];

  function contextValid() {
    if (contextInvalidated) return false;
    try {
      // 扩展重新加载后 chrome.runtime.id 变为 undefined
      if (chrome && chrome.runtime && chrome.runtime.id === undefined) return false;
      return true;
    } catch (e) { return false; }
  }

  function handleInvalidation() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    // 停掉所有定时器，避免持续报错
    for (var i = 0; i < intervalIds.length; i++) clearInterval(intervalIds[i]);
    intervalIds = [];
    // 提示用户刷新页面以加载新脚本（此时 DOM 操作仍可用）
    try {
      var stale = floatEl || document.getElementById('__ssm087_float');
      if (stale) {
        stale.innerHTML = '<div style="font-size:11px">扩展已更新，请刷新本页(F5)以继续计时</div>';
      }
    } catch (e) {}
  }

  function storageGet(defaults, cb) {
    if (!contextValid()) { handleInvalidation(); return; }
    try {
      chrome.storage.local.get(defaults, function (res) {
        if (!contextValid()) { handleInvalidation(); return; }
        cb(res || {});
      });
    } catch (e) { handleInvalidation(); }
  }

  function storageSet(obj, cb) {
    if (!contextValid()) { handleInvalidation(); return; }
    try {
      chrome.storage.local.set(obj, function () {
        if (!contextValid()) { handleInvalidation(); return; }
        if (cb) cb();
      });
    } catch (e) { handleInvalidation(); }
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function dateString(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function isActive() {
    // 只按“可见性”判断：切到别的标签页/最小化 => hidden => 暂停；
    // 切到其他程序但浏览器窗口仍可见 => 仍为 visible => 继续计时（不因 blur 暂停）
    return document.visibilityState === 'visible';
  }

  // 元素是否真正渲染出来。注意 display:none 时 innerText 会退化成 textContent，
  // 会把隐藏的按钮文字读进来，所以门控必须先确认表单区已渲染。
  function isRendered(el) {
    if (!el) return false;
    try {
      if (el.style && el.style.display === 'none') return false;
      if (window.getComputedStyle && window.getComputedStyle(el).display === 'none') return false;
      return true;
    } catch (e) { return true; }
  }

  // MvcSheet 整页加载遮罩（"正在努力加载…"）是否还可见。
  // innerText 只返回可见文本，隐藏的提示不会被读到，可放心用。
  function isLoadingMaskVisible() {
    try {
      var text = document.body ? (document.body.innerText || '') : '';
      return /正在努力加载/.test(text);
    } catch (e) { return false; }
  }

  function sheetReady() {
    var sheet = document.getElementById('sheetContent');
    // 表单节点还没出现（页面停在「正在努力加载…」）=> 仍在加载中，
    // 时间必须继续暂存，绝不能判定为「已加载完」而提前结算。
    if (!sheet || !isRendered(sheet)) return false;
    // 关键：容器可见 ≠ 内容加载完。MvcSheet 流程是
    //   #sheetContent 从 display:none → .show() → $.MvcSheet.Init() 异步填充控件。
    // .show() 到控件渲染出来之间，容器已可见但表单内容还是空的；
    // 若此时判定为就绪，会提前 resolveLoading()、把这段加载时间结算掉而丢失，
    // 并误显示「识别流程编号中 n/5」和「已停止」。
    // 因此必须同时满足：加载遮罩消失 + 表单字段控件真正出现。
    if (isLoadingMaskVisible()) return false;
    var FIELD_SEL = '[data-datafield], span.toolText, [data-title], .panel-title';
    try {
      if (sheet.querySelector && sheet.querySelector(FIELD_SEL)) return true;
    } catch (e) {}
    // 兜底：少数 DOM 结构下字段不在 sheet 内，用文档级查询
    try {
      return !!(document.querySelector && document.querySelector(FIELD_SEL));
    } catch (e) { return false; }
  }

  function activeTimingStale() {
    return !activeTiming || !activeTiming.ts ||
      (Date.now() - activeTiming.ts) > ACTIVE_STALE_MS;
  }

  function addMsToBucket(ms, at) {
    if (ms <= 0) return;
    var key = dateString(at ? new Date(at) : new Date());
    buckets[key] = (buckets[key] || 0) + ms;
  }

  // 把一段时间直接记到指定流程（用于把加载时间归还给旧后台流程）
  function addMsToFlow(flowNo, ms) {
    if (!flowNo || ms <= 0) return;
    var key = dateString(new Date());
    storageGet({ records: {} }, function (res) {
      var records = res.records || {};
      if (!records[flowNo]) records[flowNo] = {};
      records[flowNo][key] = (records[flowNo][key] || 0) + ms / 1000;
      cachedRecords = records;
      storageSet({ records: records }, function () { updateFloat(); });
    });
  }

  function claimActive() {
    yielded = false;
    owningActive = true;
    activeTiming = { runId: RUN_ID, processNo: processNo, ts: Date.now() };
    storageSet({ activeTiming: activeTiming });
    updateFloat();
  }

  /**
   * 跨标签协调：同一时刻只允许一条流程处于「后台继续计时」状态。
   * 关键：已经让位的页面在「用户切回来 + 本页可计时」时必须能重新抢占，
   * 否则新流程永远不会接管，旧后台流程会一直计时。
   */
  function syncActiveOwner(eligible) {
    if (!continuousMode) return;

    if (!eligible || !processNo) {
      if (owningActive) {
        owningActive = false;
        activeTiming = null;
        storageSet({ activeTiming: null });
      }
      return;
    }

    if (activeTiming && activeTiming.runId === RUN_ID) {
      owningActive = true;
      if (Date.now() - (activeTiming.ts || 0) >= ACTIVE_HEARTBEAT_MS) {
        activeTiming.ts = Date.now();
        storageSet({ activeTiming: activeTiming });
      }
      return;
    }

    if (activeTiming && !activeTimingStale()) {
      if (isActive()) {
        // 用户已经切到本页并开始处理 → 抢占，旧后台流程由 storage 变更事件立即停下
        claimActive();
      } else if (!yielded) {
        yielded = true;
        owningActive = false;
        flush();
      }
      return;
    }

    // 无主或原主心跳超时。已明确让位的后台页面不再抢，避免反过来打断
    // 正在前台计时的主流程（曾因此让前台主流程被误停、丢时间）。
    // 前台页面或从未让位的后台页面可以接管。
    if (!isActive() && yielded) return;
    claimActive();
  }

  /** 加载完成：把暂存时间归属到正确流程，并决定是否接管计时 */
  function resolveLoading(eligible) {
    loading = false;
    sheetReadySince = 0;
    if (carryMs > 0) {
      if (eligible || !continuousMode || !prevOwnerFlow) {
        addMsToBucket(carryMs); // 本流程需要计时（或没有旧流程）→ 归本流程
      } else {
        addMsToFlow(prevOwnerFlow, carryMs); // 不需要计时 → 归刚进入后台的旧流程
      }
      carryMs = 0;
    }
    if (!eligible) {
      yielded = true;
      owningActive = false;
      flush();
    } else {
      yielded = false; // 后面由 syncActiveOwner 决定是否立即抢占
    }
    // 加载阶段的门控结果已过期，立即按加载完的真实状态刷新，避免残留「未计时」3 秒
    displayGate = null;
    gateCandidate = null;
    gateCandidateSince = 0;
    updateFloat(eligible);
  }

  /**
   * 门控：必须在页面上“看得到完整的“同意，提交””才计入。
   * - 只取可见文本 innerText，绝不用 textContent 兜底：
   *   MvcSheet 会把所有操作按钮都渲染进 DOM、用样式控制显示，
   *   隐藏的按钮文字若被 textContent 读到，就会在按钮仅显示“同意”/“催办”时误计时。
   * - 必须完整匹配“同意，提交”（全角/半角逗号均可，逗号两边允许空白）。
   */
  function hasSubmitAction() {
    // 优先只读表单内容区，避免把扩展自己的悬浮窗文字扫进来。
    // 悬浮窗在未计时时会显示「未计时（无“同意，提交”）」，
    // 若直接扫 body.innerText，这行说明会被自己当成页面按钮，
    // 导致 未计时 → 计时中 → 未计时 反复震荡并间歇性计时。
    var sheet = document.getElementById('sheetContent');
    // 表单还没渲染出来时 innerText 会退化成 textContent，会把隐藏按钮当可见，
    // 所以加载阶段一律判定为不可计时。
    if (sheet && !isRendered(sheet)) return false;
    var root = sheet ||
      document.getElementById('form1') ||
      document.body || document.documentElement;
    if (!root) return false;
    var text = '';
    var savedVisibility = null;
    try {
      if (!floatEl) floatEl = document.getElementById('__ssm087_float');
      // 兜底：若只能扫 body，先临时隐藏悬浮窗再读可见文本（同步读写，不会闪烁）
      if (floatEl && root !== floatEl && root.contains(floatEl)) {
        savedVisibility = floatEl.style.visibility;
        floatEl.style.visibility = 'hidden';
      }
      text = root.innerText || '';
    } catch (e) { text = ''; }
    finally {
      if (savedVisibility !== null && floatEl) floatEl.style.visibility = savedVisibility;
    }
    if (!text) return false; // 可见文本为空 => 没“看到”任何按钮 => 不计时
    var compact = text.replace(/\s+/g, '');
    return /同意[，,]提交/.test(compact);
  }

  /**
   * 排除条件：页面存在“催办”按钮时不计时（即使同时有“同意，提交”按钮）。
   * 目标结构：
   *   <a href="javascript:void(0);">
   *     <i class="panel-title-icon fa fa-bullhorn toolImage"></i>
   *     <span class="toolText">催办</span></a>
   */
  function hasUrgeAction() {
    // 文本匹配：任意 span.toolText 文本为“催办”
    var spans = document.querySelectorAll('span.toolText');
    for (var i = 0; i < spans.length; i++) {
      if ((spans[i].textContent || '').trim() === '催办') return true;
    }
    // 图标匹配：fa-bullhorn（喇叭图标）
    if (document.querySelector('i.fa-bullhorn.toolImage')) return true;
    if (document.querySelector('i.fa-bullhorn')) return true;
    return false;
  }

  /** 综合门控：网页文本含“同意，提交”且没有“催办”才计时 */
  function isEligible() {
    return hasSubmitAction() && !hasUrgeAction();
  }

  /**
   * 计算悬浮窗显示状态。原始门控会随页面按钮动态变化而抖动，
   * 这里要求新状态稳定保持 GATE_HOLD_MS 才切换，避免状态文字来回闪。
   * 返回 { ok, reason }。
   */
  function gateState(rawOk) {
    var reason = rawOk ? '' : (hasUrgeAction() ? '有“催办”' : '无“同意，提交”');
    var cand = { ok: rawOk, reason: reason };
    var now = Date.now();
    if (!displayGate) {
      displayGate = cand;
      gateCandidate = cand;
      gateCandidateSince = now;
      return displayGate;
    }
    if (!gateCandidate || gateCandidate.ok !== rawOk || gateCandidate.reason !== reason) {
      gateCandidate = cand;
      gateCandidateSince = now;
    }
    if ((displayGate.ok !== rawOk || displayGate.reason !== reason) &&
        (now - gateCandidateSince) >= GATE_HOLD_MS) {
      displayGate = cand;
    }
    return displayGate;
  }

  /**
   * 从 <div id="control1" ...> 中提取流程编号。
   * 兼容两种情况：
   *  1) 只读渲染：<div id="control1"><input ... style="display:none"><label ...><span>值</span></label></div>
   *  2) 编辑渲染：<div id="control1"><input id="Control11" data-datafield="liuchengbianhao" value="值"></div>
   */
  function extractProcessNo() {
    var control = document.getElementById('control1') ||
      document.querySelector('[data-title="流程编号"]') ||
      document.querySelector('div[data-datafield="liuchengbianhao"]');
    if (!control) return '';

    var candidates = [];

    // input 的 value（优先带 data-datafield 的）
    var inputs = control.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var v = inputs[i].value;
      if (v && v.trim()) candidates.push(v.trim());
    }

    // label / span 文本
    var labels = control.querySelectorAll('label, span');
    for (var j = 0; j < labels.length; j++) {
      var t = (labels[j].textContent || '').trim();
      if (t && t !== '流程编号') candidates.push(t);
    }

    // 容器自身文本兜底
    var own = (control.textContent || '').trim();
    if (own && own !== '流程编号') candidates.push(own);

    for (var k = 0; k < candidates.length; k++) {
      var c = candidates[k];
      if (c && c !== '流程编号' && c.length <= 200) return c;
    }
    return '';
  }

  /**
   * 识别流程编号：读不到时自动重试，最多 5 次（间隔 4 秒）。
   * - 重试期间不写盘：时间留在 buckets，直到拿到真实编号或 5 次用尽。
   * - 5 次仍失败才归入「（未识别流程）」，用户可在面板手动改名。
   * - 归入未识别后仍低频重试；一旦后来读到真实编号，把未识别时间归并过来，
   *   避免「刷新后又识别成功」导致同一流程留下两条记录。
   */
  function ensureProcessNo() {
    // 已拿到真实编号就锁定，不再改动
    if (processNo && processNo !== UNRECOGNIZED) return true;

    // 页面还在「正在努力加载…」阶段（表单节点未出现 / 未渲染）时，
    // 控件还没渲染出来，此时提取必然失败。若在这里消耗重试次数，
    // 加载完之前就可能被误判为「未识别流程」。统一在此守卫，
    // 覆盖初始化、tick、flush 三个调用点。
    // 保留超时兜底：表单始终不出现时，超过 LOAD_TIMEOUT_MS 仍允许识别落盘。
    if (!sheetReady() && Date.now() - loadingSince < LOAD_TIMEOUT_MS) return false;

    var now = Date.now();
    // 节流：两次尝试至少间隔 PROCESS_NO_RETRY_MS
    if (nextProcessNoAttemptAt && now < nextProcessNoAttemptAt) return false;
    nextProcessNoAttemptAt = now + PROCESS_NO_RETRY_MS;

    var p = extractProcessNo();
    if (p) {
      processNo = p;
      processNoAttempts = 0;
      mergeUnrecognized(p); // 把此前因识别失败暂存的时间并入真实编号
      return true;
    }

    if (processNoAttempts < PROCESS_NO_MAX_ATTEMPTS) processNoAttempts++;
    if (processNoAttempts >= PROCESS_NO_MAX_ATTEMPTS && processNo !== UNRECOGNIZED) {
      // 5 次都失败：才归入未识别（此时 flush 才开始把时间写到该条目）
      processNo = UNRECOGNIZED;
      unrecognizedAt = now;
      storageSet({ unrecognizedAt: now });
    }
    return false;
  }

  /**
   * 把最近一次「未识别流程」累积的时间按天归并到真实编号并删除旧条目。
   * 只在时间窗内归并，避免把很久以前、可能属于别的流程的时间错误并入。
   */
  function mergeUnrecognized(realFlow) {
    if (!realFlow || realFlow === UNRECOGNIZED) return;
    storageGet({ records: {}, unrecognizedAt: 0 }, function (res) {
      var at = res.unrecognizedAt || 0;
      if (!at || Date.now() - at > UNRECOGNIZED_WINDOW_MS) return;
      var records = res.records || {};
      var un = records[UNRECOGNIZED];
      if (!un || !Object.keys(un).length) {
        storageSet({ unrecognizedAt: 0 });
        return;
      }
      if (!records[realFlow]) records[realFlow] = {};
      Object.keys(un).forEach(function (d) {
        records[realFlow][d] = (records[realFlow][d] || 0) + un[d];
      });
      delete records[UNRECOGNIZED];
      cachedRecords = records;
      storageSet({ records: records, unrecognizedAt: 0 }, function () { updateFloat(); });
    });
  }

  /**
   * 提取项目号。用户样例：
   * <div id="divXXXXXX" data-title="项目号">
   *   <input id="Control15" data-datafield="xiangmuhao" style="display:none">
   *   <label for="Control15"><span>22P013</span></label>
   * </div>
   * id 为动态数字，故用 data-datafield / data-title 定位。
   */
  function extractProjectNo() {
    var candidates = [];

    // 1) 带 data-datafield=xiangmuhao 的 input（可能不止一处，取第一个非空）
    var fieldInputs = document.querySelectorAll('input[data-datafield="xiangmuhao"]');
    for (var i = 0; i < fieldInputs.length; i++) {
      var v = fieldInputs[i].value;
      if (v && v.trim()) candidates.push(v.trim());
    }

    // 2) data-title=项目号 的容器（兼容 label>span 只读态 / input 编辑态）
    var box = document.querySelector('[data-title="项目号"]');
    if (box) {
      var inp = box.querySelector('input');
      if (inp && inp.value && inp.value.trim()) candidates.push(inp.value.trim());
      var span = box.querySelector('label span, span');
      if (span && span.textContent && span.textContent.trim()) {
        candidates.push(span.textContent.trim());
      }
    }

    for (var k = 0; k < candidates.length; k++) {
      var c = candidates[k];
      if (c && c !== '项目号' && c.length <= 200) return c;
    }
    return '';
  }

  function ensureProjectNo() {
    if (projectNo) return;
    var p = extractProjectNo();
    if (p) projectNo = p;
  }

  // 把 流程编号 -> 项目号 的映射落盘（与计时分开，项目号识别到即可写入）
  function persistProject() {
    if (!processNo || !projectNo) return;
    if (cachedFlowProjects[processNo] === projectNo) return;
    storageGet({ flowProjects: {} }, function (res) {
      var flowProjects = res.flowProjects || {};
      if (flowProjects[processNo] === projectNo) {
        cachedFlowProjects = flowProjects;
        return;
      }
      flowProjects[processNo] = projectNo;
      cachedFlowProjects = flowProjects;
      storageSet({ flowProjects: flowProjects });
    });
  }

  // ===== 左下角悬浮计时：显示“本流程”自己的时间（今日 + 累计），实时刷新 =====
  var floatEl = null;

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    function p2(n) { return n < 10 ? '0' + n : '' + n; }
    return (h > 0 ? p2(h) + ':' : '') + p2(m) + ':' + p2(s);
  }

  function ensureFloat() {
    if (floatEl && document.body.contains(floatEl)) return;
    floatEl = document.createElement('div');
    floatEl.id = '__ssm087_float';
    floatEl.style.cssText = [
      'position:fixed', 'left:14px', 'bottom:14px', 'z-index:2147483647',
      'background:rgba(17,24,39,.88)', 'color:#f8fafc', 'border-radius:8px',
      'padding:8px 11px', 'font:12px/1.5 -apple-system,"Microsoft YaHei",sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,.25)', 'pointer-events:none',
      'max-width:230px', 'white-space:nowrap'
    ].join(';');
    floatEl.innerHTML =
      '<div style="font-size:11px;opacity:.75">⏱ 当前流程停留 ' +
        '<span id="__ssm087_float_state" style="font-weight:600"></span></div>' +
      '<div id="__ssm087_float_flow" style="font-weight:600;overflow:hidden;text-overflow:ellipsis"></div>' +
      '<div id="__ssm087_float_project" style="font-size:11px;opacity:.85"></div>' +
      '<div style="font-size:14px;font-weight:700" id="__ssm087_float_today">今日 00:00</div>' +
      '<div style="font-size:10px;opacity:.75" id="__ssm087_float_total">累计 00:00</div>';
    (document.body || document.documentElement).appendChild(floatEl);
  }

  function updateFloat(eligible) {
    if (!floatEl) return;
    if (eligible === undefined) eligible = isEligible();
    var stateEl = document.getElementById('__ssm087_float_state');
    var flowEl = document.getElementById('__ssm087_float_flow');
    var projectEl = document.getElementById('__ssm087_float_project');
    var todayEl = document.getElementById('__ssm087_float_today');
    var totalEl = document.getElementById('__ssm087_float_total');
    if (!flowEl || !projectEl || !todayEl || !totalEl) return;

    // 状态标签：经粘滞处理，稳定才切换；颜色直观区分
    if (stateEl) {
      var gs = gateState(eligible);
      // 表单还没渲染（页面停在「正在努力加载…」）时一律显示加载中，
      // 不依赖 continuousMode：门控此时扫 body 可能读到框架里的“同意，提交”，
      // 会误显示绿色「计时中」（切标签模式下还会误加时间）。
      if (!sheetReady()) {
        stateEl.textContent = continuousMode ? '⏳加载中（时间暂存）' : '⏳页面加载中';
        stateEl.style.color = '#fbbf24';
      } else if (continuousMode && yielded && !isActive()) {
        // 已停止只对后台让位页面有意义；前台页面永不负这条提示
        stateEl.textContent = '⏸已停止（另一流程计时中）';
        stateEl.style.color = '#fca5a5';
      } else if (gs.ok) {
        var bg = continuousMode && !isActive() ? '（后台）' : '';
        stateEl.textContent = '●计时中' + bg;
        stateEl.style.color = '#4ade80';
      } else {
        stateEl.textContent = '⏸未计时（' + gs.reason + '）';
        stateEl.style.color = '#fca5a5';
      }
    }

    // 加载阶段时间还没归属，单独显示暂存值，让用户看得到它确实在计时
    if (continuousMode && loading) {
      flowEl.textContent = processNo || '（页面加载中…）';
      projectEl.textContent = '';
      todayEl.textContent = '暂存 ' + fmtDuration(carryMs / 1000);
      totalEl.textContent = '';
      return;
    }

    // 关键：无论门控状态如何，时间始终显示“已累计的真实值”，绝不清零。
    // 门控只决定是否“继续累加”，不影响已经产生的时间展示，避免数字来回跳。
    if (!processNo) {
      // 表单还没渲染出来时（页面停在「正在努力加载…」），显示加载中，
      // 不要显示「识别流程编号中 n/5」——此时根本还没开始识别。
      var identifyHint = !sheetReady()
        ? '（页面加载中…）'
        : (processNoAttempts > 0
            ? '（识别流程编号中 ' + processNoAttempts + '/' + PROCESS_NO_MAX_ATTEMPTS + '）'
            : '（识别流程编号中…）');
      flowEl.textContent = identifyHint;
      projectEl.textContent = '';
      todayEl.textContent = continuousMode && loading
        ? '暂存 ' + fmtDuration(carryMs / 1000)
        : '今日 00:00';
      totalEl.textContent = continuousMode && loading ? '' : '累计 00:00';
      return;
    }

    var todayKey = dateString(new Date());
    var storedToday = (cachedRecords[processNo] && cachedRecords[processNo][todayKey]) || 0;
    var pendingToday = (buckets[todayKey] || 0) / 1000;
    var todaySec = storedToday + pendingToday;

    // 累计：该流程所有日期已落盘 + 本次未落盘
    var totalSec = 0;
    var days = cachedRecords[processNo] || {};
    Object.keys(days).forEach(function (d) { totalSec += days[d] || 0; });
    Object.keys(buckets).forEach(function (d) { totalSec += buckets[d] / 1000; });

    flowEl.textContent = processNo;
    var proj = projectNo || cachedFlowProjects[processNo] || '';
    projectEl.textContent = proj ? ('项目号 ' + proj) : '';
    todayEl.textContent = '今日 ' + fmtDuration(todaySec) + '（' + Math.round(todaySec) + 's）';
    totalEl.textContent = '累计 ' + fmtDuration(totalSec);
  }

  function tick() {
    if (!contextValid()) { handleInvalidation(); return; }
    var now = Date.now();

    var rawEligible = isEligible();
    // 后台标签里 innerText 可能读不到内容；勾选后台计时时用最近一次可见时的结果兜底
    if (isActive()) lastEligible = rawEligible;
    var eligible = rawEligible;
    if (continuousMode && !yielded && !isActive()) {
      eligible = lastEligible || rawEligible;
    }

    var delta = lastTick === null ? 0 : now - lastTick;
    // 后台标签可能被浏览器节流到每分钟一次，勾选模式下放宽间隔上限
    var limit = continuousMode ? MAX_TICK_DELTA_MS : 60000;
    var validMs = (delta > 0 && delta < limit) ? delta : 0;

    if (continuousMode && loading) {
      // 加载阶段：时间先攒着，加载完再决定归本流程还是旧后台流程
      carryMs += validMs;
      if (now - loadingSince >= LOAD_TIMEOUT_MS) {
        // 表单始终没出现（页面结构异常 / 加载失败）的兜底，避免永久暂存不落盘
        resolveLoading(eligible);
      } else if (sheetReady()) {
        if (!sheetReadySince) sheetReadySince = now;
        // 表单刚显示时按钮可能还没渲染完，稳定 1 秒后再判断是否需要计时
        if (now - sheetReadySince >= LOAD_RESOLVE_MS) resolveLoading(eligible);
      } else {
        sheetReadySince = 0;
      }
    } else {
      // 决定本页是否仍在计时（让位给别的流程后立即停）
      if (continuousMode) syncActiveOwner(eligible);
      // 前台页面即使残留 yielded 也不停计：主流程一旦可见就必须连续计时，
      // 让位只应作用于后台页面。后台流程的抢占交给 syncActiveOwner 处理。
      var canCount = eligible && (continuousMode ? (isActive() || !yielded) : isActive());
      if (canCount) addMsToBucket(validMs, now);
    }

    // 表单渲染后再识别编号，避免加载阶段过早落入“（未识别流程）”
    if (!loading || sheetReady()) {
      ensureProcessNo();
      ensureProjectNo();
      if (projectNo) persistProject();
    }
    lastTick = now;
    updateFloat(eligible);
  }

  function flush() {
    if (!contextValid()) { handleInvalidation(); return; }
    var keys = Object.keys(buckets);
    if (!keys.length) return;
    if (!processNo) ensureProcessNo();
    if (!processNo) return; // 仍未识别则保留在 buckets，下次再写

    var snapshot = buckets;
    buckets = {};

    storageGet({ records: {} }, function (res) {
      var records = res.records || {};
      if (!records[processNo]) records[processNo] = {};
      for (var i = 0; i < keys.length; i++) {
        var day = keys[i];
        records[processNo][day] = (records[processNo][day] || 0) + snapshot[day] / 1000;
      }
      cachedRecords = records;
      storageSet({ records: records }, function () { updateFloat(); });
    });
  }

  // 计时主循环
  lastTick = Date.now();

  // 初始化本地缓存 + 悬浮计时
  storageGet({ records: {}, flowProjects: {}, keepTimingWhenHidden: false, activeTiming: null }, function (res) {
    cachedRecords = res.records || {};
    cachedFlowProjects = res.flowProjects || {};
    continuousMode = !!res.keepTimingWhenHidden;
    activeTiming = res.activeTiming || null;
    if (continuousMode && activeTiming && activeTiming.runId !== RUN_ID && !activeTimingStale()) {
      // 前台页面不让位：由 syncActiveOwner 在 tick 里抢占回来
      if (!isActive()) yielded = true;
      prevOwnerFlow = activeTiming.processNo || null; // 加载时间可能要还给它
    }
    ensureProcessNo();
    ensureProjectNo();
    ensureFloat();
    updateFloat();
  });
  // DOM 尚未就绪时（脚本注入早于 body）再兜底创建一次
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { ensureFloat(); updateFloat(); });
  } else if (document.body) {
    ensureFloat();
  }

  intervalIds.push(setInterval(tick, TICK_MS));
  intervalIds.push(setInterval(flush, FLUSH_INTERVAL_MS));

  // 面板勾选状态变化 / 其他标签流程开始计时，都要即时响应
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (!contextValid()) { handleInvalidation(); return; }
    if (area !== 'local') return;
    if (changes.keepTimingWhenHidden) {
      var was = continuousMode;
      continuousMode = !!changes.keepTimingWhenHidden.newValue;
      if (was !== continuousMode) {
        // 模式切换时重置归属，让当前页有机会重新计时
        yielded = false;
        owningActive = false;
        activeTiming = null;
        flush();
        updateFloat();
      }
    }
    if (changes.activeTiming) {
      activeTiming = changes.activeTiming.newValue || null;
      if (continuousMode && activeTiming && activeTiming.runId !== RUN_ID &&
          !activeTimingStale()) {
        if (isActive()) {
          // 本页在前台：绝不让位给后台流程，反而抢占回来。
          // 曾因这里无条件 yielded=true 导致前台主流程被后台心跳打断、时间丢失。
          if (processNo && isEligible()) claimActive();
        } else if (!yielded) {
          yielded = true;
          owningActive = false;
          flush();
        }
      }
      updateFloat();
    }
  });

  // 仅在“页面可见性变化”时暂停/恢复：切到别的标签页或最小化 => hidden => 暂停并结算。
  // 切到其他程序但浏览器仍可见 => 不触发 hidden => 继续计时（符合要求）。
  document.addEventListener('visibilitychange', function () {
    if (!contextValid()) { handleInvalidation(); return; }
    if (document.visibilityState === 'hidden') {
      flush();
    } else if (!(continuousMode && !yielded)) {
      lastTick = Date.now(); // 回到该标签页时重新起算，避免算入后台时间；后台计时模式除外
    }
  });
  // blur/focus 不再暂停计时：窗口失焦但页面仍可见时继续统计
  // 关闭标签时结算，并释放「当前计时流程」归属（心跳超时也是兜底）
  function flushAndRelease() {
    if (!contextValid()) { handleInvalidation(); return; }
    // 还没加载完就关标签：暂存时间归还给旧后台流程（没有则归本流程）
    if (continuousMode && loading && carryMs > 0) {
      if (prevOwnerFlow) addMsToFlow(prevOwnerFlow, carryMs);
      else addMsToBucket(carryMs);
      carryMs = 0;
    }
    if (continuousMode && owningActive && activeTiming && activeTiming.runId === RUN_ID) {
      storageSet({ activeTiming: null });
    }
    flush();
  }
  window.addEventListener('pagehide', flushAndRelease);
  window.addEventListener('beforeunload', flushAndRelease);
})();
