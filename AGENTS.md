# AGENTS.md — 项目约定与上下文

本文件供后续在本工作区继续开发的 AI agent / 开发者阅读，快速了解「SSM087 流程停留时长记录器」的现状与约定。面向用户的说明见 `ssm087-dwell-recorder/README.md`。

## 项目概览

- 类型：Chrome / Edge 浏览器扩展（Manifest V3），无构建步骤，纯静态文件。
- 目录：`ssm087-dwell-recorder/`
- 用途：在网址含 `SSM087` 的流程详情页记录停留时长，按「流程编号 + 项目号 + 日期」汇总，供人工统计各流程的处理耗时。
- 数据来源页面：ASP.NET MvcSheet 表单（用户提供的样例在 `C:/Users/xiabing/Desktop/新建文本文档.txt`）。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `manifest.json` | 扩展配置；content script 注入匹配页，popup 为面板 |
| `content.js` | 页面内采集：门控判断、识别流程编号/项目号、计时、写 `chrome.storage.local`、左下角悬浮计时、扩展上下文失效保护 |
| `popup.html/css/js` | 工具栏面板：日期筛选表格、CSV/JSON 导出、JSON 导入、连点解锁编辑删除、流程编号改名、清空、标题右侧「切标签继续计时」复选框（持久化） |

## 核心业务规则（改动前务必确认）

1. **生效范围**：仅 `location.href` 含 `SSM087` 的页面；否则 content script 直接退出。
2. **正面门控**：页面**可见文本**（`innerText`，绝不用 `textContent`，否则会读进被 CSS 隐藏的按钮文字导致误计时）包含完整「同意，提交」才计时。正则 `同意[，,]提交`（先去所有空白）。「同意 提交」（无逗号）、仅「同意」/「提交」都不算。
3. **排除门控**：可见「催办」（`span.toolText` 文本 = 催办，或 `i.fa-bullhorn`）时不计时、不写记录。`i.fa-bullhorn` 已覆盖带 `.toolImage` 的情况，不要再加多余判断。
4. **综合门控**：`isEligible() = hasSubmitAction() && !hasUrgeAction()`。
5. **暂停规则**：默认只看 `visibilityState`（切标签/最小化 → hidden → 暂停；切到其他程序但窗口可见 → 继续），**不要恢复 blur 暂停**。
6. **「切标签继续计时」模式**：面板复选框状态存 `keepTimingWhenHidden`，content 启动时读取并监听 `onChanged`。勾选后忽略 `visibilityState` 暂停，后台继续累计；后台 tab 的 `setInterval` 会被浏览器节流，故 tick 间隔上限放宽到 10 分钟，并用 `lastEligible` 兜底后台可能读不到的 `innerText`。回到前台时**不要重置 `lastTick`**，否则会丢掉后台时间。
7. **跨标签互斥**：勾选模式下用 `activeTiming = { runId, processNo, ts }` 选主，每 3 秒心跳、12 秒超时。另一条流程开始计时 → 本页 `yielded=true`、立即 `flush()` 并停止累加；关闭标签时释放归属。心跳超时是标签意外关闭的兜底。**隐藏时不要自动恢复已让位的页面**；但用户切回本页且本页可计时时必须允许抢占（见 13），模式切换时也重置归属。
8. **时间精度**：底层按毫秒累加、以浮点秒写入 `records`；**所有显示/导出按整秒四舍五入**。面板合计用 `fmtHMS()` 输出 `hh:mm:ss`。
9. **悬浮窗抗抖动**：门控只决定是否继续累加，**任何情况下都不得把已累计时间清零显示**；状态标签走 `gateState()` 3 秒粘滞，避免按钮闪烁。曾因门控 false 时把时间显示成 00:00 导致数字来回跳，勿重犯。
10. **上下文失效**：扩展重载后旧注入脚本会报 `Extension context invalidated`；`contextValid()` + `storageGet/storageSet` 包装已处理，失效时停定时器、清悬浮层并提示刷新。新增存储调用必须走包装函数。
11. **门控自激陷阱**：`hasSubmitAction()` 只扫表单内容区（`#sheetContent`，兜底 `form1`），**绝不能把扩展自己的悬浮窗文字扫进去**。悬浮窗「未计时（无“同意，提交”）」的说明里恰好含触发词，扫 `body.innerText` 会被自己误判为有按钮，导致「未计时 ↔ 计时中」反复震荡、间歇性计时。若必须扫 body，需先临时隐藏 `#__ssm087_float` 再读。曾因此出现同一页面状态来回跳，勿重犯。
12. **加载阶段时间归属**：`sheetReady()` 在 `#sheetContent` 节点尚未插入 DOM（页面停在「正在努力加载…」）时必须返回 `false`——**绝不能因"页面结构不同则视为就绪"而返回 true**，否则会提前 `resolveLoading()`，把加载时间误结算掉、悬浮窗提前显示「已停止」+00:00（曾出此 bug）。表单节点出现但 `display:none` 时 `innerText` 会退化成 `textContent`，同样不可计时（`isRendered()` 守卫）。此阶段时间进 `carryMs` 暂存而非 `buckets`；表单可见并稳定 1 秒后 `resolveLoading()`：本页有「同意，提交」→ 暂存时间归本页并参与抢占；否则归 `prevOwnerFlow`（打开本页时正在后台计时的流程）。加载中关标签也要把暂存时间归还。加载超过 `LOAD_TIMEOUT_MS`（3 分钟）表单仍未出现则兜底结算，避免永久不落盘。
13. **让位后必须能抢占**：`syncActiveOwner()` 不能因 `yielded` 提前 return。已让位页面在「用户切回本页（`isActive()`）+ 本页可计时」时必须 `claimActive()`，否则新流程永远接不了管、旧后台流程一直计时。抢占通过 `activeTiming` 变更事件让旧页立即停下并结算。
14. **流程编号识别失败要重试**：`ensureProcessNo()` 读不到编号时**不要立刻写死「未识别流程」**（加载慢时 `#control1` 还没渲染，刷新一下就能读到）。按 `PROCESS_NO_MAX_ATTEMPTS=5` 次、`PROCESS_NO_RETRY_MS=4000` 间隔重试；重试期间 `processNo` 保持空，`flush()` 会跳过写盘、时间留在 `buckets`。5 次用尽才置 `UNRECOGNIZED`（全角）并写 `unrecognizedAt`。落入未识别后仍低频重试，一旦读到真编号用 `mergeUnrecognized()` 把未识别记录按天并入真编号并删除旧条目（仅 10 分钟窗口内），避免刷新后出现两条。`popup.js` 判断未识别必须**同时兼容全角与半角**写法。
15. **加载阶段不得消耗识别重试**：页面停在「正在努力加载…」（表单未渲染）时控件还不存在，`ensureProcessNo()` 会在首次提取即失败并累计次数。`ensureProcessNo()` 有三个调用点（初始化回调 / `tick()` / `flush()`），**加载守卫必须下沉到函数内部**（`!sheetReady() && 距 loadingSince < LOAD_TIMEOUT_MS` 时直接 return），不能只写在 `tick()` 里——否则初始化 + 每 5 秒的 `flush()` 会在加载期把 5 次机会耗光（曾出现「还没加载完就显示 识别流程编号中 2/5」）。保留超时兜底。同时 `updateFloat()` 在表单未渲染时状态显示「页面加载中」（不能依赖 `continuousMode`，否则会误显示绿色「计时中」）、编号行显示「（页面加载中…）」而非重试进度。

## 数据存储

`chrome.storage.local`，五个键：

- `records`：`{ 流程编号: { "YYYY-MM-DD": 秒数 } }`
- `flowProjects`：`{ 流程编号: 项目号 }`
- `keepTimingWhenHidden`：面板「切标签继续计时」复选框状态（布尔值，需要记住）
- `activeTiming`：`{ runId, processNo, ts }`，后台计时选主/心跳，保证跨标签只有一条流程计时
- `unrecognizedAt`：最近一次流程编号识别失败落入「未识别流程」的时刻（时间戳），用于识别成功后在 10 分钟窗口内归并未识别时间

按浏览器隔离（Chrome / Edge 各自独立）。卸载扩展或面板「清空记录」才会删除；「重新加载」扩展不丢数据。用户可用面板 JSON 导出/导入做备份迁移。

## 面板交互约定

- 表格数据四列（流程编号/项目号/日期/时长）+ 操作列；按日期筛选，只显示选中当天。
- 一页最多 8 行、表头 sticky、表格区独立滚动、外层无滚动条（`table-layout: auto` 内容自适应列宽，不要再写死百分比）。
- 面板宽度 496px。
- **编辑/删除默认隐藏**：连点标题 5 次（2 秒内）临时解锁，关闭面板即失效（纯内存变量，无需持久化）。
- **(未识别流程) 编号始终可点**改名（无需解锁，一次机会）；解锁后点任意流程编号也是改名（不是删除）。改名迁移全部日期记录 + 项目号，目标已存在则同日秒数累加合并。
- 单条删除走操作列「删」按钮（只删某流程某天）。

## 开发 / 验证约定

- 无 npm / 构建；改完 JS 用 `node --check` 验语法。
- 逻辑测试用 Node `vm` + 手写 DOM mock（历史上多次以 `test_*.js` 临时脚本验证后删除，不留在仓库）。
- Git Bash 下 heredoc 里的正则反斜杠会被吞，检查脚本用字符串 `indexOf` 而非正则字面量。
- 交付给用户后需提醒：到扩展管理页点「重新加载」，并**刷新已打开的流程详情页 F5** 才生效。
- 面板是预览用 HTML，可直接打开 `popup.html` 看样式（此时无 chrome API，交互会报错，属正常）。

## 用户沟通习惯

- 用户以中文沟通，多次用「换个说法」重新描述同一需求，本质是调整判断口径；遇到门控类需求优先确认「到底什么可见状态才算」。
- 列宽/格式等视觉微调偏好直接看到效果，改动后给出简明表格说明新旧值。
