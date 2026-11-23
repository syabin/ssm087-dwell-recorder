(function () {
  'use strict';

  var rowsEl = document.getElementById('rows');
  var emptyEl = document.getElementById('empty');
  var gridEl = document.getElementById('grid');
  var totalEl = document.getElementById('total');
  var datePicker = document.getElementById('datePicker');
  var chkContinuous = document.getElementById('chkContinuous');

  // 「切标签继续计时」勾选状态持久化；切换时重置跨标签计时归属
  chrome.storage.local.get({ keepTimingWhenHidden: false }, function (res) {
    chkContinuous.checked = !!res.keepTimingWhenHidden;
  });
  chkContinuous.addEventListener('change', function () {
    chrome.storage.local.set({
      keepTimingWhenHidden: chkContinuous.checked,
      activeTiming: null
    });
  });

  // 编辑/删除功能默认隐藏；连点标题 5 次临时解锁（仅当前面板会话有效，关闭即失效）
  var unlocked = false;
  var TAP_WINDOW_MS = 2000; // 连续点击必须在此时长内完成
  var tapTimes = [];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  // 秒数 → hh:mm:ss（时长按整秒计算）
  function fmtHMS(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }
  function localDate(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function shiftDate(str, delta) {
    var p = str.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + delta);
    return localDate(d);
  }

  function load(cb) {
    chrome.storage.local.get({ records: {}, flowProjects: {} }, function (res) {
      cb(res.records || {}, res.flowProjects || {});
    });
  }

  // 修改流程编号：把旧编号下所有日期的记录迁到新编号；目标已存在则按天累加合并
  function renameFlow(oldFlow) {
    var input = window.prompt('将流程编号「' + oldFlow + '」修改为：', '');
    if (input === null) return;              // 取消
    var newFlow = String(input).trim();
    if (!newFlow) { alert('流程编号不能为空，已取消。'); return; }
    if (newFlow === oldFlow) return;         // 没变
    load(function (recs, projs) {
      var oldDays = recs[oldFlow] || {};
      if (!recs[newFlow]) recs[newFlow] = {};
      // 按天合并：目标已有同一天则累加
      Object.keys(oldDays).forEach(function (d) {
        recs[newFlow][d] = (recs[newFlow][d] || 0) + (oldDays[d] || 0);
      });
      delete recs[oldFlow];
      // 项目号映射迁移：目标无项目号时用旧编号的
      if (projs[oldFlow] !== undefined) {
        if (!projs[newFlow]) projs[newFlow] = projs[oldFlow];
        delete projs[oldFlow];
      }
      chrome.storage.local.set({ records: recs, flowProjects: projs }, function () {
        render();
        alert('已将「' + oldFlow + '」修改为「' + newFlow + '」。\n若已打开流程详情页，请按 F5 刷新以同步悬浮计时。');
      });
    });
  }

  function render() {
    load(function (records, flowProjects) {
      var selected = datePicker.value || localDate();

      // 只显示选中日期的记录
      var list = [];
      Object.keys(records).forEach(function (flow) {
        var days = records[flow] || {};
        var sec = Math.round(days[selected] || 0);
        if (sec > 0) list.push({ flow: flow, date: selected, sec: sec });
      });

      // 流程编号升序
      list.sort(function (a, b) {
        return a.flow.localeCompare(b.flow, 'zh-CN');
      });

      rowsEl.innerHTML = '';
      list.forEach(function (r) {
        var tr = document.createElement('tr');

        // 流程编号：点击即修改编号
        // - 未识别流程始终可点击（无需解锁，一次机会）
        // - 兼容全角「（未识别流程）」与历史半角「(未识别流程)」两种写法
        var isUnrecognized = (r.flow === '（未识别流程）' || r.flow === '(未识别流程)');
        var td1 = document.createElement('td');
        td1.className = 'flow' + ((unlocked || isUnrecognized) ? ' link' : '');
        td1.textContent = r.flow;
        if (unlocked || isUnrecognized) {
          td1.title = '点击修改流程编号';
          td1.addEventListener('click', function () { renameFlow(r.flow); });
        }

        var tdp = document.createElement('td');
        tdp.className = 'project';
        tdp.textContent = flowProjects[r.flow] || '';

        var td2 = document.createElement('td');
        td2.textContent = r.date;

        // 秒数：解锁后点击变成输入框，回车/失焦保存
        var td3 = document.createElement('td');
        td3.className = 'num' + (unlocked ? ' editable' : '');
        td3.textContent = r.sec;
        if (unlocked) {
          td3.title = '点击修改秒数';
          td3.addEventListener('click', function () {
            if (td3.querySelector('input')) return;
            var input = document.createElement('input');
            input.type = 'number';
            input.step = '1';
            input.min = '0';
            input.value = r.sec;
            input.className = 'cell-input';
            td3.textContent = '';
            td3.appendChild(input);
            input.focus();
            input.select();
            var done = false;
            function commit() {
              if (done) return;
              done = true;
              var v = Math.round(parseFloat(input.value));
              if (isNaN(v) || v < 0) { render(); return; } // 非法值还原
              load(function (recs) {
                if (!recs[r.flow]) recs[r.flow] = {};
                recs[r.flow][r.date] = v;
                chrome.storage.local.set({ records: recs }, render);
              });
            }
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              else if (e.key === 'Escape') { done = true; render(); }
            });
          });
        }

        // 操作列：解锁后才渲染「删」按钮
        var tdop = document.createElement('td');
        tdop.className = 'op';
        if (unlocked) {
          var btnDel = document.createElement('button');
          btnDel.type = 'button';
          btnDel.className = 'row-del';
          btnDel.textContent = '删';
          btnDel.title = '删除这条记录';
          btnDel.addEventListener('click', function () {
            if (!confirm('删除记录：' + r.flow + ' / ' + r.date + '？')) return;
            load(function (recs) {
              if (recs[r.flow]) {
                delete recs[r.flow][r.date];
                if (Object.keys(recs[r.flow]).length === 0) delete recs[r.flow];
              }
              chrome.storage.local.set({ records: recs }, render);
            });
          });
          tdop.appendChild(btnDel);
        }

        tr.appendChild(td1); tr.appendChild(tdp); tr.appendChild(td2);
        tr.appendChild(td3); tr.appendChild(tdop);
        rowsEl.appendChild(tr);
      });

      var isEmpty = list.length === 0;
      emptyEl.hidden = !isEmpty;
      gridEl.style.display = isEmpty ? 'none' : '';

      var total = list.reduce(function (s, r) { return s + r.sec; }, 0);
      totalEl.textContent = selected + ' · ' + list.length + ' 条 · 合计 ' + fmtHMS(total);
      window._rows = list;
    });
  }

  // ---- 连点标题 5 次切换编辑模式 ----
  document.getElementById('titleHead').addEventListener('click', function () {
    var now = Date.now();
    tapTimes.push(now);
    // 只保留窗口内的点击
    tapTimes = tapTimes.filter(function (t) { return now - t <= TAP_WINDOW_MS; });
    if (tapTimes.length >= 5) {
      tapTimes = [];
      unlocked = !unlocked;
      render();
    }
  });

  // 初始化日期为今天
  datePicker.value = localDate();
  datePicker.addEventListener('change', render);
  document.getElementById('btnPrev').addEventListener('click', function () {
    datePicker.value = shiftDate(datePicker.value || localDate(), -1);
    render();
  });
  document.getElementById('btnNext').addEventListener('click', function () {
    datePicker.value = shiftDate(datePicker.value || localDate(), 1);
    render();
  });
  document.getElementById('btnToday').addEventListener('click', function () {
    datePicker.value = localDate();
    render();
  });

  document.getElementById('btnClear').addEventListener('click', function () {
    if (!confirm('确定清空全部停留记录吗？此操作不可撤销。\n建议先用「导出 JSON」备份。')) return;
    chrome.storage.local.set({ records: {}, flowProjects: {} }, render);
  });

  // 导出：始终导出全部日期的全部记录，不受日期筛选影响
  document.getElementById('btnExport').addEventListener('click', function () {
    load(function (records, flowProjects) {
      var lines = ['流程编号,项目号,日期,停留时长(秒)'];
      Object.keys(records).forEach(function (flow) {
        var days = records[flow] || {};
        var proj = String(flowProjects[flow] || '').replace(/"/g, '""');
        Object.keys(days).forEach(function (date) {
          var sec = Math.round(days[date] || 0);
          if (sec <= 0) return;
          var esc = String(flow).replace(/"/g, '""');
          lines.push('"' + esc + '","' + proj + '","' + date + '",' + sec);
        });
      });
      var blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'SSM087停留时长_' + localDate() + '.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  });

  // ---- 导出 JSON：完整备份 records + flowProjects ----
  document.getElementById('btnExportJson').addEventListener('click', function () {
    load(function (records, flowProjects) {
      var payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        records: records,
        flowProjects: flowProjects
      };
      var text = JSON.stringify(payload, null, 2);
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'SSM087停留时长备份_' + localDate() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  });

  // ---- 导入 JSON：覆盖当前全部数据 ----
  var fileImport = document.getElementById('fileImport');
  document.getElementById('btnImportJson').addEventListener('click', function () {
    fileImport.value = ''; // 允许重复选择同一文件
    fileImport.click();
  });
  fileImport.addEventListener('change', function () {
    var file = fileImport.files && fileImport.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var data;
      try { data = JSON.parse(e.target.result); }
      catch (err) { alert('导入失败：文件不是有效的 JSON。'); return; }
      var recs = data && data.records;
      var projs = data && data.flowProjects;
      if (!recs || typeof recs !== 'object' || Array.isArray(recs)) {
        alert('导入失败：JSON 中缺少有效的 records 字段。');
        return;
      }
      if (!confirm('将用备份覆盖当前全部数据。\n确定导入 ' + Object.keys(recs).length +
                   ' 个流程的记录吗？此操作不可撤销。')) return;
      chrome.storage.local.set({
        records: recs,
        flowProjects: (projs && typeof projs === 'object' && !Array.isArray(projs)) ? projs : {}
      }, function () {
        render();
        alert('导入完成。若已打开流程详情页，请按 F5 刷新以同步左下角悬浮计时。');
      });
    };
    reader.readAsText(file, 'utf-8');
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.records) render();
    if (changes.keepTimingWhenHidden) chkContinuous.checked = !!changes.keepTimingWhenHidden.newValue;
  });

  render();
})();
