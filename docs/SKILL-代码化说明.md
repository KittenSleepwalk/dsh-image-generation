# SKILL 代码化说明

> 回答两个问题：① 之前提示词扩充是不是代码做的？② 文本 SKILL 能不能变成可执行形式？
> 结论：之前是代码（`prompt-angles.js` + `constraints.js`）；现在把 SKILL 变成**配置源**——
> SKILL 仍是人写的唯一权威文档，代码**解析**它并把规则注入每条提示词，不再复制两套口径。

## 1. 之前怎么做的（代码逻辑）

| 文件 | 作用 |
|---|---|
| `lib/prompt-angles.js` | 角度目录（9 风格家族 / 40+ 细类、16 图型、比例、构图、密度、配色）+ 组合器 `composePrompts`：语义分析 → 约束 → 变体组合 |
| `lib/constraints.js` | 把「不能错」编译成编号约束（C1 层数方向 / C2 箭头数量 / C3 每层白名单 / C_skill / 收口句），带 verify、静态自检、修复块 |
| `lib/variants-tool.js` | `generate_variants`：每条提示词 × 随机种子扩展（`seeds_per_prompt`）、`min_images` 校验 |
| `lib/batch.js` | 串行排队出图（ComfyUI /prompt → /history → /view） |
| `lib/compose-tool.js` | 工具封装：`compose_prompts`（compose / list / repair） |

也就是说：**扩充是代码做的**，SKILL 之前只以文档形式存在，规则靠人工同步。

## 2. 现在：SKILL → 代码配置（`lib/skill.js`）

`loadSkill()` 在运行时读 `docs/配图提示词生成SKILL.md`，把结构化部分解析成对象：

| SKILL 段落 | 解析结果 | 代码消费方 |
|---|---|---|
| `## 0 两条铁律` | `ironRules[]`（编号列表） | `skillPromptBlock()` → 拼进每条 prompt 的 `[C_skill]` 约束，并写进 checks |
| `## 1 角度总表` | `angles[]`（编号/名称/等级） | 工具输出摘要、完整性校验 |
| `## C 风格家族表` | `styleFamilies[]`（9 家族：细类/适合/风险） | 与 `prompt-angles.js` 的风格 prompt 模板对接；决定每版 4 风格 |
| `## C 骨架表` | `forms[]`（16 种骨架） | 图型轮换 |
| `## D 画幅表` | `ratios[]`（比例/尺寸/用途/约束） | 比例维：横竖各 ≥1 |
| `## 3 方案策略` | `strategy{}`：语义维 2–3、风格维 ≥4、结构可多组、横竖各 ≥1 | `composePrompts` 的默认 `versions` / `stylesPerVersion` / 比例要求 |

另外两条工程化保证：

- **文件缺失不阻塞**：`loadSkill()` 找不到 SKILL 时退回内置默认（铁律 + 4 风格 + 2–3 解读），出图照常；
- **单一权威**：修改 SKILL 的表格/策略后，重启 DSH（或热加载）即生效，不需要改代码；
  只有「新增风格细类的中文描述」这类 prompt 文案，需要在 `prompt-angles.js` 补一条模板（因为英文提示词模板在代码里）。

## 3. 一步到位：`generate_from_brief`

新工具，把「SKILL → 提示词 → 出图」串成一次调用：

```
generate_from_brief({
  brief: '用户需求原话',
  must_keep: ['额外硬约束'],
  count: 6,                // 释义版本，最少 6
  seeds_per_prompt: 4,     // 每条 4 个随机种子
  max_images: 120,         // 上限保护，超出直接报错
  dry_run: true            // 先审方案：只生成提示词与计划
})
```

流程：
1. 读 SKILL；
2. `composePrompts`：按 SKILL 策略语义维 2–3 解读 × 每版 4 种风格（默认 3×4=12 条提示词）；
3. `expandVariantSeeds`：每条 × 4 个随机种子 = 48 张；
4. `runVariants`：串行排队出图（fast 档约 20–35 分钟），返回每张路径/seed/门禁。

## 4. 当前 SKILL 里值得补的两处

1. `## 0` 第 3 条「**风格Top-k**：在风格」句子没写完（截断），建议补成「在风格家族中按 Top-k 选取，默认每版 4 种」；
2. `## 1 角度总表` 标题写「13 个」，表格实际只有 5 行（A–E）。代码按实际行数解析（当前 5 个），补齐后自动生效。

## 5. 怎么改 / 怎么验证

- 改规则：编辑 `docs/配图提示词生成SKILL.md`（表格、铁律、策略数字）；
- 验证解析：调 `compose_prompts({ brief, action:'list' })` 或 `generate_from_brief({ brief, dry_run:true })`，输出会打印 SKILL 路径、角度数、风格家族数、骨架数、策略；
- 验证出图：去掉 `dry_run` 再调；先用 `seeds_per_prompt:1` 出 12 张审方案，满意后再 4 种子全量 48 张。
