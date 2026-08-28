# Test Report

> 项目：视觉实验台（Infinite Canvas 2.0）· 第 1 步信任层
> 撰写：严过关（QA 工程师）
> 日期：2026-08-16
> 轮次：Round 1（发现源码 Bug）→ Round 2（修复回归）→ 最终确认（边角闭合回归）

---

## Summary（最终）

| 项 | 值 |
|---|---|
| **Total** | 252 |
| **Passed** | 252 |
| **Failed** | 0 |
| 全量回归是否全绿 | ✅ 是（test-textgen 57/0、test-textgen-qa 78/0） |
| **Routing Decision** | **全部通过（可交付）** |

### 覆盖率估计（按信任层 6 项功能 + 现有回归）

| 功能 | 覆盖结论 | 断言 |
|---|---|---|
| ① 原子保存 | ✅ 全绿（成功/异常原文件不变/.tmp 清理/坏路径/append_json_line） | 24 |
| ② 自动保存 | ✅ 全绿（门控/单飞互斥/pending 合并/无路径静默/saveForClose/三态） | — |
| ③ 关闭保护 + 打开前 dirty 检查 | ✅ 全绿（三选一/无改动不弹/保存失败不关/guardOpen/中断警示） | — |
| ④ 最小撤销/重做（快照栈） | ✅ 全绿（push/undo/redo/50 裁尾/suspend/dirty 穿越保存点复位/深拷贝） | — |
| ⑤ 历史图库持久化（history.jsonl + trace） | ✅ 全绿（buildImageTrace/buildTextTrace/hashRef/appendTrace/loadHistory + 后端落点/坏行容错） | — |
| ⑥ 现有回归（text-gen 链路 + persistence） | ✅ 全绿 | 135 |

> 断言分布：trust-layer 前端 93（含 S3/S6）、后端 24、回归 test-textgen 57、回归 test-textgen-qa 78。

---

## Round 2 回归结论（S3 修复验证）

- 工程师修复 `src/v1/persistence.ts`：`save()` 记录 collect 时刻的 `flowState.updatedAt` 版本号，落盘成功后仅在版本未变时清 dirty（`_clearDirtyIfUnchanged`）；在途期间有新改动则保留 dirty，由 SaveCoordinator 既有 pending 补写再落盘后复位。
- **S3 验证通过**：`在途改动应触发 pending 合并补写（期望 2 次写，实际 2）`、`最新状态 B 应被落盘`、`补写后 dirty=false`。

---

## 最终确认回归结论（边角闭合）

- 工程师修复 `src/v1/ui/bottom-bar.ts` 项目名 input 处理器：补同步 `flowState.updatedAt = Date.now()`（第 35 行）。QA 静态核对确认该行已就位；并复核全部 dirty=true 入口（flow-state 12 + dirty 3 + interactions 1 + canvas-view 1 + bottom-bar 1）现均已同步 `updatedAt`，版本号方案完整闭合。
- **S6 用例审查结论**：断言逻辑正确。S6 以内联模拟「重命名时 dirty + updatedAt + notify 三者同步」验证 persistence 版本号方案在 projectName 场景下 pending 补写不丢；若移除 updatedAt 同步，`total` 会从 2 退化为 1、断言失败，即 S6 确实编码了「updatedAt 同步是补写不丢的前提」。S6 对 bottom-bar 真实处理器为间接覆盖（headless 下不触发真实 input 事件），已由静态核对补足。
- 复跑结果：trust-layer 前端 93/93（含 S6）、后端 24/24、回归 test-textgen 57/57、回归 test-textgen-qa 78/78。**无新增失败、无回归。**

---

## Failed Tests

无。

---

## Known Issues

无（S3 与 bottom-bar 边角均已闭合；原「标题就地编辑入口未实现」为设计提及但非本步验收项，已归档不在本步阻塞清单）。

> 附：测试环境备注（非源码问题）——沙箱限制 `D:/tmp/icv-test` 不可写，smoke 编译产物输出到 workspace 内 `.icv-smoke/`；回归测试以 UTF-8 安全副本（仅改 `BASE` 常量、断言原样）在 `.icv-smoke/regress/` 运行；后端测试因 `tempfile.mkdtemp()` 沙箱目录不可写，改用 `os.makedirs` 手工建唯一目录。

---

## 验证命令（复现）

```bash
# 前端编译 + 测试
npx tsc -p tsconfig.smoke.json --outDir ".icv-smoke"
node smoke/test-trust-layer.cjs          # 93/0
node .icv-smoke/regress/test-textgen.cjs     # 57/0
node .icv-smoke/regress/test-textgen-qa.cjs  # 78/0

# 后端
python -m py_compile backend/api/utils.py backend/api/project_api.py main.py
python smoke/test-trust-layer-backend.py  # 24/0
```
