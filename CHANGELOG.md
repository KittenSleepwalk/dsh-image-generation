# Changelog

Version history of `@kittensleepwalk/dsh-image-generation`.

The entries below were moved verbatim out of the original README's "版本更新" sections (v0.3 – v0.9), keeping the
original wording and technical detail. No dates were recorded, so entries are ordered by version number only
(newest first). Entries released under the same version number keep their original order.

---

## v0.9 — 文字/文字框全部交给 PPT + 气泡素材

按需求调整：
- **文字与文字框全部由 PPT 生成**：文字是 PPT 原生文本框（可改字/字号/颜色）；框不再由模型画、也不再由代码栅格化
- **气泡框/标注框用透明 PNG 素材**：`assets/callouts/`
  - 7 种框型：`rounded` 圆角、`bubble_left/right/top/bottom`（带尾巴气泡）、`pill` 胶囊、`tag` 标签
  - 5 种颜色：blue #3b7ea1 / amber #c98a2b / purple #8a5fbf / green #2f8f6b / red #b5546a
  - **框外完全透明（alpha=0）**，框内白底彩边；在 PPT 里按需**任意拉伸**成文字宽高
  - `manifest.json` 记录每种框型的内容区内边距，文字框自动避开气泡尾巴
- **PPTX 原件保存**：`export_ppt` 输出可编辑 .pptx，调版后截图即文字版
- 引导线仍是 PPT 原生圆点虚线（可改/可删）
- 素材生成脚本：`scripts/make_callout_assets.py`（首次导出缺失时自动生成）

实测（样例底案 + 5 标注 + 1 结论条）导出的 PPT：
- 图片 7 个（底案 1 + 标注框 6）
- 原生文本框 6 个，中文文字正确
- 原生圆点虚线 5 条
- 画布 1280×720，PPTX 可编辑

---

## v0.8 — SKILL 必读 + 多组提示词分发

问题：直接用 `generate_image` 会得到“单张图”流程，没有 4 风格、没有释义发散。
原因：SKILL 只在文档里，Agent 没读；单图工具没有合规约束。

修复：
- **SKILL 随插件分发**：`docs/配图提示词生成SKILL.md`，新工具 `read_prompt_skill` 让 LLM 直接读全文 + 摘要（角度/风格/参考图/样例/附录/策略）
- **`plan_prompts`**：按 SKILL 生成 4 组（不同风格分类）提示词，返回 groups[]，用于分发给子智能体并行出图
- **`generate_from_brief`**：一步到位（语义 2–3 解读 × 4 风格 = 12 条 → ×4 种子 = 48 张）
- **`generate_image` 合规拦截**：需求级长提示词（≥40 字且含句读）未传 `single_image_ok:true` 时直接拒绝，并返回正确流程；
  工具描述里写明“单张图仅用于明确只要一张/单次微调”

子智能体编排（可选）：
```
read_prompt_skill（读 SKILL）
  → plan_prompts({ brief })            # 4 组，风格分类互不相同
  → 每个子智能体：generate_variants({ variants: 本组 prompts })   # 并行
  → 主智能体 read_image 逐张核对 → assemble_captions / export_ppt
```
不分子智能体时：`generate_from_brief` 串行出同一套计划。

工具总数：9 个（generate_image / image_models / generate_variants / compose_prompts / generate_from_brief / assemble_captions / export_ppt / read_prompt_skill / plan_prompts）

---

## v0.7 — 参考样例：底案 → PPT 加字 → 截图

- 样例目录：`docs/参考样例（底案-PPT截图工作流）/`
  - `weather_infographic_handdrawn_底案.png`（无文字框的干净底案）
  - `天气预报的价值_可编辑版.pptx`（PPT 原生标注）
  - `weather_infographic_handdrawn_PPT截图文字版.png`（截图成品）
- 从样例解析出的设计规格：1280×720 画布；底案 left 13/top 108/w 1249/h 509；标注为白色圆角 + 彩色 1.5pt 边框 + 雅黑 15pt + **圆点虚线（ROUND_DOT）3pt** 引导线；底部白底紫边框结论条
- 新工具 `export_ppt`：底案 → 可编辑 PPTX（原生形状，可改字/挪位），用户在 PowerPoint 微调后截图即文字版
- 与 `assemble_captions` 的分工：
  - `assemble_captions`：直接栅格化出「文字版 PNG」（快，适合批量预览）
  - `export_ppt`：出可编辑 PPT（正式交付、需要改字/协作时用）
- 依赖：ComfyUI venv 已安装 `python-pptx`（`pip install python-pptx`）；无 LibreOffice 时无法自动截图，需在 PowerPoint 里截
- `skill.samples` 自动解析该样例三元组；测试含 samples 解析 + PPT 导出冒烟

---

## v0.6 — 文本框/气泡框：专门设计 + 代码组装

问题：让绘图模型自己画「空文本框」会得到位置随机、大小随意、没有引导线、和元素脱节的框。
方案：**图像只留干净区域，框和字由代码确定性绘制**。

- 出图默认文字策略改为 `clean-zones`：画面只留干净空白，**不画任何框/字**
- 新工具 `assemble_captions`：底案图 + 标签清单 → 三件套
  - `*_底案.png`（纯图像底案）
  - `*_文字版.png`（带框带字成品）
  - `*_captions.json`（框位/文字/字号/颜色，PPT/PS 可按坐标回填）
- 框型设计（4 类）：
  - `title` 顶部标题胶囊（白色填充 + 强调色竖条 + 雅黑粗体）
  - `label` 贴边标签（淡色填充 + 同色描边 + 引导线指向锚点）
  - `bubble` 气泡（带小尾巴指向锚点，用于提示/结论）
  - `footer` 底部结论条（居中胶囊）
- 排版：锚点相对坐标（0–1）；支持 `side: left/right/top/bottom`；右侧/左侧纵向均分、上下排横向均分、自动避让标题/底栏；超长自动换行 + 缩字号
- 实测：底案（干净留白）+ 7 个标签 → 文字版排版整齐、引导线准确、无假字

用法：
```
assemble_captions({
  base_image: '出图.png',
  labels: [
    {text:'神经网络的画室', shape:'title'},
    {text:'杂乱素材墙', side:'left', anchor_x:0.2, anchor_y:0.45},
    {text:'① 边缘/颜色', side:'bottom', anchor_x:0.33, anchor_y:0.38},
    {text:'猜错 → 调整', shape:'bubble', anchor_x:0.5, anchor_y:0.8}
  ]
})
```

---

## v0.5 — 按新版 SKILL（8 角度 / 三条铁律 / H 文字分离）重改

**SKILL 解析新增**
- 8 角度（A–H，含 H 文字）、三条铁律
- 「提示词生成流程」7 要素：主体 / 细节与属性 / 环境与场景 / 艺术风格 / 构图与视角 / 光照与色彩 / 画质与参数
- H 文字规则：图像/文字分离、留空文字框、字体默认黑体（雅黑）、保留纯图像底案
- 附录 24 条通用提示词样例（自动解析进 skill.appendixPrompts）

**提示词组装**
- 按 7 要素组织；画面正文保持简短（约束/要素只进 spec 供核对）
- 默认文字策略改为 `reserve-boxes`：**不渲染文字，只留 4–8 个空文字框/气泡框**
- 参考图优先使用 `底案（…）.png`（无字版）作为构图参考；`文字参考（…）.md` 进 spec，供 PPT/PS 后期加字

**去字底案流程（新增脚本）**
1. `node scripts/prep-text-masks.mjs <docs>`：Windows 中文 OCR（zh-Hans-CN）识别文字 → `_masks/` 遮罩 + `ocr.json`
2. `node scripts/refs-textless.mjs --mode=inpaint --masks=<docs>/_masks --outdir=<docs>`：按遮罩局部重绘，输出 `底案（…）.png`
3. `scripts/refs-textless.mjs --mode=img2img`（旧方案，保留兼容）
4. 文字内容单独整理为 `文字参考（…）.md`（7 份已生成）

> 说明：OCR 对低对比度/艺术字会漏检，漏掉的文字会留在底案上；可对底案再跑一轮 `prep-text-masks` + inpaint 收敛。

---

## v0.5 — 按新版 SKILL 重构

对齐要点：
- 三条铁律：具象固定（关键名词只留空白框）/ 抽象可具象但须贴合上下文 / 风格 Top-k 来自 4 个不同分类
- 8 角度：A 语义与关系、B 主体、C 骨架、D 细节、E 风格、F 画幅、G 配色光照、H 文字
- **提示词改为七要素框架**：Subject / Details & attributes / Environment & scene / Art style & medium / Composition & camera / Lighting & color / Quality & parameters（Negative 单列尾部）
- **主体七要素**：B1 主体类型（纯图形/IP/真实对象）、B2 抽象语义映射、B3 外观/动作/情绪/材质/主体关系/文字框位置/负面清单 → `inferSubject()` 输出主体类型、数量、空白文字框位置
- **H 文字**：默认「留空文字框」策略（3-6 个空白标签框/气泡框，框内无字，文字由 PPT/PS 后加）；`spec.textRules` 记录分离/底案/字体（黑体雅黑）
- C10 环形 loop 解禁：仅在「明确提出」或「大图局部关键释义」时使用
- 新增「艺术课讲义」风格（手绘水彩+拼贴+Risograph/丝网印感），艺术/讲义/科普需求默认优先
- `skill.promptFlow`（7 要素）、`skill.textRules`、`skill.appendixCount` 由 SKILL 解析；参考图支持同目录「底案（…）.png」「文字版（…）.png」

---

## v0.4 — 参考图接入 + 提示词瘦身

- 新参考图：`docs/参考图（…）.png` 共 7 张（手绘马克笔信息图 / 矢量分层图 / 3D 软塑 / 绘本彩铅），由 `lib/references.js` 解析
- SKILL 解析新增：参考图清单、风格 Top-k「4 个分类」、`C_ref` 约束
- **提示词瘦身**：画面正文只留「内容 + 短风格词 + 布局 + 比例 + 无文字」；编号约束/参考图说明/铁律只进 `spec` 元数据用于核对，不再进画面（实测：长约束会被模型当正文画成满屏假文字）
- 默认文字策略改为「无文字」：模型渲染中文标签不稳，标签建议 PPT 后期加
- 修复：`generate_from_brief` 现在会把 compose 的 `ratio` 映射成 `aspect_ratio`（之前恒出 1024×1024）
- 实测（深度学习逐层特征）：16:9 手绘马克笔叠层图，四层自下而上+短箭头+无文字，风格接近参考图

---

## v0.3 — SKILL 代码化

- SKILL 唯一权威文档：`docs/配图提示词生成SKILL.md`（用户重写版）
- 代码在运行时解析它（`lib/skill.js`）：铁律 → 每条提示词的 `[C_skill]` 约束；角度/风格/骨架/画幅表 → 目录与默认值；方案策略（语义 2–3、风格 ≥4、横竖各 ≥1）→ 组合器默认
- SKILL 缺失时退回内置默认，不阻塞出图；改 SKILL 后重启 DSH 即生效
- 新工具 `generate_from_brief`：读 SKILL → 语义维 2–3 解读 × 4 风格（默认 3×4=12 条提示词）→ ×4 种子 = 48 张 → 串行出图；`dry_run:true` 先审方案
- 说明文档：`docs/SKILL-代码化说明.md`
- 工具全景：`generate_image` / `image_models` / `generate_variants` / `compose_prompts` / `generate_from_brief`
