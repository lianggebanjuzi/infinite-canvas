# ICV v1 QA 验证报告

> 测试人：严过关（QA Engineer）
> 日期：2026-08-12
> 对象：commit b2c05e7（feat(icv-v1)），baseline 57d2604
> 方式：独立验证，不采信工程师自检；不改实现代码（测试脚本自建自删，见文末）
> 结论：**全部通过，智能路由判定 NoOne**（无源码 Bug）

---

## 一、验证总览

| # | 验证项 | 结果 | 证据/备注 |
|---|--------|------|-----------|
| 1 | 构建与类型 | ✅ PASS | `npm run build` 独立重跑：tsc --noEmit **0 错误** + vite **35 模块**；产物 `gui/dist/index.html`(13.38kB) + `assets/index-*.css`(24.84kB) + `assets/index-*.js`(79.37kB)。首次失败为 gui/dist 文件锁（已知环境限制），清空后成功 |
| 2 | 数据层冒烟（工程师脚本） | ✅ 26/26 | 用当前代码独立编译到 `/tmp/icv-test` 后重跑 `scripts/icv-smoke-test.js`，26 项全过 |
| 3 | QA 独立边界测试（自建） | ✅ 50/50 | `scripts/icv-qa-edge-tests.js`，覆盖工程师脚本未覆盖的真实 run() 全流程，详见第二节 |
| 4 | 构建产物运行时冒烟 | ✅ 8/8 | `scripts/icv-bundle-smoke.js`：加载真实 bundle，window.ICV 桥接、registry 2 节点、collect/restore 往返 |
| 5 | 脏标记传播边界 | ✅ PASS | 3 级链 A→B→C 改 A → B/C 全 stale；分支 A→B、A→C 同步标；run 中不覆盖；fail→stale；改自己不标 |
| 6 | 分段执行契约 | ✅ PASS | 上游无图 → run 拒绝且**未调用 backend**；上游有图+done → 正常生成回写 |
| 7 | 失败路径 | ✅ PASS | 生成失败 → status=fail + 原因写入 error；**model 参数不变（不自动切供应商）**；backend 抛错 → fail + 原因 |
| 8 | persistence | ✅ PASS | base64 图片/ratio/status/error/lastRunAt/params 往返无损；`format!=='icv'` 拒绝（A9）；拒绝后状态不污染；非法节点/悬挂边过滤 |
| 9 | 模板 | ✅ PASS | `createDefaultProject()` 产 2 节点 1 连线，ratio=3/4，style 默认参数齐全 |
| 10 | 唯一生成入口 | ✅ PASS | `unified_generate_image/get_task_result` 仅经 utils/api.ts → v1/api.ts → run-engine；无其他直连 |
| 11 | .icproj 唯一读写 | ✅ PASS | 只有 persistence.ts 调 save/open；bottom-bar/empty-state/main 均走 persistence |
| 12 | 无日志噪音 / 无 emoji | ✅ PASS | src/v1 无 console.log/warn/debug；无 emoji（全 SVG 描边图标） |
| 13 | 错误映射复用 | ✅ PASS（轻微） | backend/api/errors.py 分层完整（QuotaExceeded/UpstreamTimeout/...）；api.ts 定义 `toFlowError` 但**未被调用**（死代码，见观察项 2） |
| 14 | 旧模块移除 | ✅ PASS | `src/main.ts` 仅 import `./v1/main`；bridge 仅桥接 v1；**bundle 内 0 旧模块残留**（text-card/drawing-board/minimap/command-manager 等均不在产物） |
| 15 | 原型对齐（代码级） | ✅ PASS | `--bg-app #FAF9F6/#232220`、`--accent #7C9A72/#93AC87`、`--st-*` 五态色值、圆角 8/12/16 与 `prototypes/ui-v2.html` **逐项一致**；CARD_W=260 且高随 ratio；状态点五态 CSS、扫描光(scanMove)/流光(flow)动画存在；空态引导卡；底部胶囊 4 按钮(打开/保存/主题/设置)+运行选中(A5)；图库抽屉；多选不弹面板+组拖(按 scale 换算)；右键菜单(运行当前卡/查看失败原因/运行全部)；指令面板 参考/标记/风格 tab + 模型/比例/分辨率/张数 chip + 参考图缩略 + 发送钮；智能避让翻转(action-bar) |

**路由判定：NoOne** —— 全部通过，无源码 Bug，无需回修。

---

## 二、QA 独立边界测试明细（50/50）

自建 `scripts/icv-qa-edge-tests.js`（Node + DOM 桩，打桩 Backend 验证真实调用链）：

1. **间接脏标记**（3 级链）：改 A → B stale、孙节点 C 也 stale ✅
2. **分支传播**：A→B、A→C，改 A → B、C 同时 stale ✅
3. **模板复验**：2 节点 1 连线、ratio=3/4、count=1 ✅
4. **分段执行拒绝**：上游无图 idle → run 被拒、状态不变、backend **零调用** ✅
5. **run 成功路径**：options 组装正确（prompt/model=`provA:modelX`/aspectRatio=`1:1`/resolution=`4k`/count=`2`/referenceImages=[上游图]）；回写 done+imageUrl+lastRunAt；generateImage 恰好 1 次 ✅
6. **成功→下游 stale**：run B 成功 → C 被标 stale ✅
7. **失败路径**：error_code=402「余额不足」→ fail + error 写入；model 不变（不自动切供应商）；imageUrl 保持 null ✅
8. **backend 抛错**：网络中断 → fail + 原因 ✅
9. **并发保护**：运行中再触发 → 不重复调 backend；慢任务完成正常 done ✅
10. **输入节点 run**：有图 → 直接 done，不调 backend ✅
11. **persistence 图片往返**：base64 长图、ratio=1:1、fail+error+lastRunAt、params(16:9/count=4) 全保留；restore 后 dirty=false ✅
12. **A9 拒绝**：format!=='icv' / null / nodes 非数组均拒绝且**不污染现有状态** ✅
13. **restore 健壮性**：未知类型/非法 id 节点过滤、非法 status 回退 idle、悬挂边过滤 ✅
14. **buildOptions 兜底**：上游无图 → referenceImages=[] 不崩；canRun 返回原因 ✅
15. **选中语义**：单选 single()、多选 single()=null（A5）✅

---

## 三、观察项（非阻塞，供工程师知晓）

1. **「校验上游 done」字面偏差（低风险）**：架构 T02 写 `run('style-transfer') 校验上游 done`；实现 `style-transfer.canRun`（src/v1/nodes/style-transfer.ts:23-26）校验的是**上游 imageUrl 存在**而非 `status==='done'`。正常 UI 选图即置 done（interactions.ts:317/371），实操二者等价；仅合成状态（上游有图但 idle）下 run 会放行，生成结果仍正确。**不判定为 Bug**，建议后续在 canRun 补 `upstream.status==='done'` 使契约字面一致。
2. **toFlowError 死代码**：src/v1/api.ts:28 定义 `toFlowError` 但无调用点；错误信息实际经 pollTask 返回值 / Error.message 写入 node.error（功能达成，仅轻微冗余）。
3. **restore 不校验 version**：persistence.ts 仅校验 `format==='icv'`（A9 拍板口径只要求 format），version 未校验——符合拍板，不视为问题。

---

## 四、环境边界说明

真实出图闭环（选图→改 prompt→发送→backend 生成→结果入卡+入图库）需 **pywebview GUI + 已配置供应商密钥**，本沙箱无法完整跑通——**不计为测试失败**。已完成替代验证：
- a) 用 Node 桩验证 `run-engine.run()` 全链路：options 组装（referenceImages 含上游图、model/aspectRatio/resolution/count 正确透传）、轮询 done/fail 回写；
- b) 构建产物 bundle 加载初始化不抛异常（bundle 冒烟 8/8）。

---

## 五、用户环境验收步骤清单（真机操作）

> 前置：`pip install -r requirements.txt`（requests/pywebview/Pillow）；`npm run build`；在设置面板配置至少一个供应商密钥并启用绘图模型；`python main.py` 启动。

1. **启动与空态**：打开应用 → 预期空画布 + 居中引导卡（标题+一句说明+「创建默认模板」按钮）；点按钮 → 出现 2 张卡（产品图→换风格）并连好线。
2. **选产品图**：点击/拖入产品图卡 → 弹出文件选择（或拖图到卡上）→ 图片显示、卡变 done 深绿点。
3. **改风格指令**：选换风格卡 → 指令面板出现「正在编辑·北欧风场景」+ 参考图缩略（上游图自动带入）；tab 切到「风格」→ 模型/比例/分辨率/张数 chip 可点选；输入 prompt。
4. **发送生成**：点圆形发送钮 → 卡片扫描光 + 上游连线流光；完成后卡显示生成图 + 深绿点 + 历史图库抽屉自动加入缩略图；Toast「生成完成」。
5. **脏标记验证**：改产品图（替换上游图）→ 下游换风格卡变**橙点 stale**；改自己的 prompt → 不变 stale；再运行 → 恢复 done。
6. **失败路径**：断网或改无效模型后发送 → 卡变**红点**，hover/右键「查看失败原因」显示原因；**模型未被自动切换**；恢复网络后手动重跑成功。
7. **保存/打开**：Ctrl+S 或底部「保存」→ Toast 项目已保存；「打开」恢复上次 .icproj（图片 base64 内嵌，大项目保存有提示）；打开旧版 .icproj → 提示「旧版项目不支持，请新建」。
8. **多选/组拖/运行选中**：Shift 点选两张卡 → 不弹面板；拖拽任一张 → 整组移动；底部「运行选中 (2)」高亮 → 按拓扑序执行；右键画布 → 运行全部。
9. **图库拖入**：从左侧图库抽屉拖缩略图 → 拖到输入节点上替换；拖到空白 → 新建输入节点。
10. **主题/设置**：底部「主题」浅/深切换（暖米白/暖棕黑）；「设置」可增删改查供应商 + 设默认模型。

---

## 六、测试产物

- QA 自建测试：`scripts/icv-qa-edge-tests.js`（可保留作回归）
- 一次性探测：`scripts/icv-qa-probe.js`（已无用途，可删）
- 编译配置：`tsconfig.smoke.json`（QA 冒烟编译用，可删；如保留需把 `outDir` 换成本地路径）
- 冒烟编译产物：`G:/tmp/icv-test/`（临时目录，可删）

复跑方式：`npx tsc -p tsconfig.smoke.json` → `node scripts/icv-smoke-test.js` → `node scripts/icv-qa-edge-tests.js` → `node scripts/icv-bundle-smoke.js`

---

## 七、2026-08-12 手动连线增量验证（commit 69dadba）

> 独立验证，不采信工程师自检。改动范围 6 文件 +456/-22，与声称一致，无夹带无关改动。

### 7.1 全量回归结果

| 测试 | 结果 | 备注 |
|---|---|---|
| `icv-connect-tests.js`（工程师 27 项） | ✅ 27/27 | 独立编译当前代码后重跑 |
| `icv-qa-edge-tests.js`（QA 50 项） | ✅ 50/50 | 无回退 |
| `icv-smoke-test.js`（26 项） | ✅ 26/26 | 无回退 |
| `icv-bundle-smoke.js`（8 项） | ✅ 8/8 | 新 bundle index-Cvr9ppVn.js |
| `npm run build` | ✅ | tsc 0 错误 + vite 35 模块；bundle 88.06kB / css 26.13kB（随功能增长） |
| `icv-connect-qa-tests.js`（QA 新增 49 项） | ✅ 49/49 + 3 缺陷观察 | 见 7.3 |

### 7.2 代码审查结论

- **canConnect 三条校验**：连自己 / 重复连 / 产品图作下游——全部实现且 toast 文案正确（connect() 返回 error 供 UI 提示）。
- **connect/insertStep 单一数据源**：均走 flow-state，`.icproj v3` 格式未变；插入/删边后 collect/restore 往返无损（节点/边/id 全保留）。
- **insertStep 正确性**：链中间（A→B→C 插 B→C）与链末端（A→B）均正确——原边断开、A→New→B 重连、其它边不受影响、新节点参数用注册表默认值、参考图自动取上游；**stale 语义在 UI 层补偿**（link-view.ts:142 / interactions.ts:636 调 `dirty.markUpstreamChanged(new)`），下游（含子孙）正确转 stale，上游不受影响。
- **端口拖拽坐标**：橡皮筋用世界坐标（`toWorldCoords` 换算）、落点判定用 `elementFromPoint`（屏幕坐标）——缩放 0.5/1.5 下 Node 桩验证换算正确。
- **删除连线连带语义**：**缺陷，见 7.3**。

### 7.3 缺陷：删除连线不标下游 stale（判定：给工程师修）

**位置**：
- `src/v1/canvas/link-view.ts:130`（hover × 删除按钮：`flowState.removeEdge(edge.id)`）
- `src/v1/canvas/interactions.ts:646`（右键菜单「删除连线」：`flowState.removeEdge(edgeId)`）
- 根因 `src/v1/state/flow-state.ts:202` `removeEdge()` 本身不标 stale

**最小复现**：模板 A(产品图,done)→B(换风格,done 有图)。hover 连线点 × 删除（或右键→删除连线）→ B 仍显示 done 深绿点，但已无上游、结果无法再复现；再拖 A2→B 重连新上游 → B 仍 done，但结果图来自旧上游 A。状态与数据不一致。

**判定**：中严重度状态一致性缺陷。应用内所有其它结构性变更（换图 interactions.ts:402/456、自动接孤儿 :421、插入步骤 :636/142、运行完成 run-engine.ts:38/65）都标下游 stale，唯独删除连线不标。修复建议：在 `removeEdge` 或两个调用点对 `to` 及其子孙标 stale（`dirty.markStale(to)` 或遍历 `getAllDownstreams`）。

### 7.4 观察项（低风险，不阻塞）

1. `canConnect` 不限制 style 节点多上游：可对同一换风格节点连 2 条上游线，`buildOptions` 取 `getUpstreams()[0]` 存在歧义（v1 模板为单上游，暂不触发）。
2. `flow-state.ts` 重复定义 `CARD_W=260`（与 canvas-view 同值，注释说明数据层不依赖视图层）——刻意为之，若卡片宽度变更需同步两处。
3. 端口拖拽/右键菜单/×按钮为真实 DOM 交互，沙箱无法自动化 → 列入真机手感验收。

### 7.5 真机手感验收要点（用户环境）

1. 缩放 0.5/1.5 下从 out 端口拖线到 in 端口：橡皮筋跟随、目标端口高亮、松手成线；拖到产品图 in 端口被拒并 toast「产品图是起点，不能作为下游」。
2. hover 连线出现 + 与 ×：× 删除后下游应变橙点（修复后预期）；中点 + 插入步骤后新卡位于连线中点、连线自动重连。
3. 右键连线菜单「插入步骤 / 删除连线」可用；Shift 框选与端口拖拽不冲突（拖拽以 out 端口 mousedown 为起点）。

### 7.6 Round 2 回归（2026-08-12，commit 8121c38 修复确认）

工程师修复提交 8121c38（`flow-state.removeEdge` 现对 `edge.to` 及其所有子孙标 stale，run 不覆盖；改动 2 文件 +64，范围干净），QA 独立重跑：

| 测试 | 结果 | 备注 |
|---|---|---|
| `icv-connect-qa-tests.js`（QA 49 项） | ✅ 49/49 | **[5a][5b][5c] 缺陷演示段全部转 stale，DEFECT-OBSERVED 0 处** |
| `icv-connect-tests.js`（工程师 33 项） | ✅ 33/33 | 含新增 6 项删边 stale 测试 |
| `icv-qa-edge-tests.js`（50 项） | ✅ 50/50 | 无回退 |
| `icv-smoke-test.js`（26 项） | ✅ 26/26 | 无回退 |
| `icv-bundle-smoke.js`（8 项） | ✅ 8/8 | 新 bundle index-BUtfZNAH.js |
| `npm run build` | ✅ | tsc 0 错误 + 35 模块，bundle 88.65kB |

**结论：缺陷已修复，Round 2 全量通过，智能路由判定 NoOne。** 修复口径验证：删唯一上游边 → 下游 stale；删链中间边 → B 及子孙 C 均 stale；删边重连新上游 → B 仍 stale（结果图不可信提示）；运行中节点不覆盖。与换图/插入步骤/运行完成路径一致。

---

## 八、image-gen 节点增量验证（2026-08-12，commit 0c70919）

> 独立验证，不采信工程师自检。改动范围 9 文件（+2 新：nodes/image-gen.ts、scripts/icv-imagegen-tests.js；M 7：flow.d.ts / main.ts / persistence.ts / card-view.ts / cmd-panel.ts / interactions.ts / app.css），与声称一致，无夹带无关改动。

### 8.1 全量回归结果

| 测试 | 结果 | 备注 |
|---|---|---|
| `icv-imagegen-tests.js`（工程师 28 项） | ✅ 28/28 | 独立编译当前代码后重跑 |
| `icv-qa-imagegen-test.js`（QA 独立 20 项） | ✅ 20/20 | 自建，见 8.3 |
| `icv-qa-edge-tests.js`（50 项） | ✅ 50/50 | 无回退 |
| `icv-smoke-test.js`（26 项） | ✅ 26/26 | 无回退 |
| `icv-connect-tests.js`（33 项） | ✅ 33/33 | 无回退 |
| `icv-connect-qa-tests.js`（39 项） | ✅ 39/39 | 无回退 |
| `icv-empty-state-test.js`（21 项） | ✅ 21/21 | 无回退 |
| `npm run build` | ✅ | tsc 0 错误 + vite 34 模块；bundle 90.71kB / css 26.76kB（随功能增长，image-gen 已入包） |

### 8.2 代码审查结论（重点项）

- **buildOptions 取全部上游**：`nodes/image-gen.ts:24-30` 用 `ctx.getUpstreams(node.id).filter(u => u.imageUrl).map(...)` —— 非 `[0]`，顺序与上游一致；`style-transfer` 仍取首图（回归语义不变）。
- **null 不入数组**：`canRun` 与 `buildOptions` 均先 `filter(u => u.imageUrl)`，上游无图被剔除，`referenceImages` **绝不含 null/空串**（backend 安全）。多上游仅一个有图 → canRun=true 且数组只含该图（QA 独立测试①验证）。
- **canRun 语义**：prompt / model / 至少一个带图上游三关，返回原因文案正确。
- **cmd-panel 参考区**：`init()` 订阅 flowState（cmd-panel.ts:57）→ `sync()` → `_renderRefs()`，上游增减/换图实时重建多缩略图；`image-gen` 走 `_renderMultiRefs`（含空态 hint），`style-transfer` 走单主参考（先 `_clearMultiRefs()` 再显示 refMain）——互不串扰。
- **card-view 上游缩略图行**：`_upstreamStrip` 仅 image-gen 生效，随 `renderAll()`（flowState notify 驱动）动态重建；删线后 `getUpstreams` 收缩 → 缩略图同步移除；叠加式定位不改卡片尺寸；title 经 `escapeAttr` 转义。
- **interactions 自动接线**：`new-image-gen` 只接「带图且 `getEdgesFrom().length===0`」的产品图（不抢已有连线的上游），先 `canConnect` 校验再 `addEdge`——比 new-style（接首个产品图）更严格、符合多图语义。
- **persistence**：restore 类型白名单加 `image-gen`，collect/restore 往返无损（节点/结果图/参数/多入边/出边）。
- **run-engine 未改**：引擎本就类型无关（统一 `def.canRun/buildOptions`），run 成功路径 `setNodeImage` + `dirty.markUpstreamChanged` 已覆盖 image-gen → 下游标 stale；结论成立。

### 8.3 QA 独立补测（`scripts/icv-qa-imagegen-test.js`，20/20）

1. **多上游其一无图**：canRun=true 但 `referenceImages` 无 null/空值，仅含带图那张 ✅
2. **上游替换图后**：buildOptions 取到新图、旧图消失、数量不变 ✅
3. **image-gen 接下游**：canConnect 通过 → run 成功结果回写 → 下游 style-transfer 标 stale → 下游 buildOptions 取到 image-gen 结果图 ✅
4. **persistence 往返**：2 产品图 + image-gen + style-transfer 下游 + 2 入 1 出边，restore 后节点/边/参数/结果图全保留，恢复后 buildOptions 仍取 2 张 ✅
5. **附：删上游线** → referenceImages 同步收缩为 1 张 ✅

### 8.4 真机验收要点（沙箱无法自动化，需用户环境）

1. **image-gen 卡片缩略图行**：连 2+ 张上游 → 卡片底部出现对应小缩略图；删一条线 → 缩略图即时消失；卡片尺寸不因缩略图行变化（叠加不撑大）。
2. **cmd-panel 参考区**：选中 image-gen → 参考 tab 默认激活，显示全部上游缩略图；连/删线时实时增减；选中 style-transfer → 仍只显示单主参考（多上游不串图）。
3. **右键新建 + 自动接线 + 生成闭环**：右键「图片生成节点」→ 所有带图未连出产品图自动拉线进该节点；配指令发送 → 生成结果入卡、可继续接下游换风格；改上游图 → image-gen 变橙点 stale。

### 8.5 观察项（低风险，不阻塞）

1. `new-style` 自动接线仍接「首个产品图」（含无图/已连出）——本次未改，为既有行为；如需与 image-gen 同口径可后续统一。
2. `.cmd-ref-hint` 文案「连接上游后自动带入参考图」依赖真实 DOM 呈现，已列入真机验收。
3. cmd-panel 多缩略图元素在面板隐藏时不主动清空（下次 `_renderMultiRefs` 重建），无泄漏风险。


