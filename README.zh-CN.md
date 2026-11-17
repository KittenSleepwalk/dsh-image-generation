<div align="center">

# dsh-image-generation

**在聊天里说一句话就出图——本地 ComfyUI 与 Qwen-Image-2.1，插件全自动接管。**

<a href="https://github.com/KittenSleepwalk/dsh-image-generation/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KittenSleepwalk/dsh-image-generation?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-image-generation/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/KittenSleepwalk/dsh-image-generation?style=flat-square"></a>
<a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-amber.svg?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-image-generation"><img alt="DSH >= 0.2.0-rc.1" src="https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.1-4d6bfe?style=flat-square"></a>
<img alt="GPU: 16GB VRAM" src="https://img.shields.io/badge/VRAM-16GB%2B-76B900?style=flat-square">

[English](./README.md) · **简体中文**

</div>

> [!WARNING]
> **只在一台机器上验证过，不保证完全安全。**
>
> - 在作者本机（RTX 4070 Ti SUPER 16GB）运行正常，但**只试验了这一台机器**，没有在第二台机器、也没有在其它 DSH 版本上验证过。
> - 因此请把它当「能用但未充分验证」的插件：**安装前务必备份** `~/.dsh`（至少备份 `~/.dsh/profiles/<你的profile>` 和改过的配置），出问题直接整目录回滚。
> - 本插件会**拉起本地 `ComfyUI` 进程**、占用大量显存（**13–17 GB 权重**）、下载**十几 GB** 模型文件、写 `~/.dsh-image-generation-ks/` 与输出目录。**显存被占时可能影响你正在跑的游戏 / 绘图作业。**
> - **推荐先安装 [`@kittensleepwalk/dsh-sandbox-gate`](https://github.com/KittenSleepwalk/dsh-sandbox-gate)**：它会先把每个待装插件放进一次性沙盒副本里跑一遍（启动、冷重启、session、其它插件、硬件占用），过了才允许装进主机。
>
> ```bash
> pnpm add github:KittenSleepwalk/dsh-sandbox-gate
> ```

---

## 🚀 安装

```bash
# 方式一：直接从 GitHub 装（仓库根就是包根）
pnpm add github:KittenSleepwalk/dsh-image-generation

# 方式二：本地 tarball
pnpm pack    # 产出 kittensleepwalk-dsh-image-generation-0.2.4.tgz
pnpm add ./kittensleepwalk-dsh-image-generation-0.2.4.tgz
```

本包**自带 `cordis.patch.yml`**，装好后把包名 `@kittensleepwalk/dsh-image-generation` 加进 DSH profile 的 `dsh.profile.bundles`，重启 DSH 生效。

### 或者：脚本一条命令

```powershell
# 双击 install.cmd 也行
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

它会：

1. 在 profile 的 `node_modules/@kittensleepwalk/` 下建 scoped junction
2. profile `package.json` 加依赖 + bundle
3. profile `cordis.patch.yml` 插入插件入口
4. 默认禁用旧的 `dsh-comfyui-image`（同名工具 `generate_image`，二选一）
5. 自动清理旧版 `dsh-qwen-image` 的接线（升级不残留）

然后**完全退出 DSH 再打开**。

| 开关 | 作用 |
| --- | --- |
| `-CheckOnly` | 只看不改 |
| `-EnableOld` | 保留旧出图插件 |
| `-ProfileDir <path>` | 指定 profile |

卸载：`uninstall.ps1`（不动 ComfyUI 与权重）。

---

## 📦 前提

- **ComfyUI ≥ 0.37.0**（含 `TextEncodeQwenImage21`），默认装在 `<ComfyUI 根目录>`（用 `DSH_COMFY_ROOT` 或配置 `comfy.root` 指定）
- 权重（放 `models/` 下，缺失时 `image_models` 会告诉你）：

| 目录 | 文件 | 作用 |
| --- | --- | --- |
| `diffusion_models/` | `qwen_image_2.1_int8_convrot.safetensors` | 主 DiT |
| `diffusion_models/` | `qwen_image_2.1_turbo_int8_convrot.safetensors` | turbo 档（可选） |
| `text_encoders/` | `qwen3vl_8b_int8_convrot.safetensors` | 编码器（画质基准） |
| `text_encoders/` | `qwen3vl_8b_w4a8.safetensors` | 编码器（省显存，16 GB 常驻） |
| `vae/` | `qwen_image_2.1_vae_bf16.safetensors` | RGBA VAE |

**推荐 PyTorch cu130**：int8 权重才走融合 CUDA 内核（同卡实测 1024² 从 ~69s 降到 ~21s）。
安装方式：`pip install "torch==2.9.1" "torchvision==0.24.1" "torchaudio==2.9.1" --index-url https://download.pytorch.org/whl/cu130`
（升级前 `pip freeze` 备份可回滚；升级后必须重启 ComfyUI。）

体检：`node scripts/doctor.mjs`（权重/选中项/ComfyUI/节点/模型列表/端口/本地清单）。

其它要求：**Node.js ≥ 20，DSH ≥ 0.2.0-rc.1**。下文的 `%USERPROFILE%`、`D:\...` 之类是示例路径，按自己的环境替换。

### 本机实测（RTX 4070 Ti SUPER 16GB）

| 配置 | 冷启动+出图总计 | 采样（fast 25 步 1024²） |
| --- | --- | --- |
| cu126（旧） | 81.0 s | 51.9 s（0.48 it/s） |
| **cu130（当前）** | **49.7 s** | **18.1 s（2.6–2.9 it/s）** |

cu130 下 `comfy_kitchen backend cuda` 从 `disabled=True` 变为 `disabled=False`，`int8_tensorwise` 进入 Native ops，
采样快 **≈2.9×**。冷启动那 30 s 是一次性的权重装填，换 seed / 同档位连拍会明显更快。

---

## 🖼️ 它能做什么

- **`generate_image`**：Agent 调它出图，插件自动拉起 / 复用本地 ComfyUI，用 Qwen-Image-2.1（int8 / w4a8，16 GB 显存优化）。
- **`edit_image`**：对已有图做图生图 / 遮罩局部修改；传 `color: "#RRGGBB"` + `mask` 时走精确改色（不跑模型，保留原图线条、按钮和明暗）。
- **`image_models`**：模型管理（纯静态逻辑）——列出本地模型、关键词搜索仓库、查看仓库文件、下载、切换档位使用的模型、删除不用的文件。
- **设置页「图像生成 (KS)」**：ComfyUI 状态、**一键打开 ComfyUI 前端**（新标签页）、**启动并用默认浏览器打开**、本地模型清单（切换 / 删除）、搜索下载。
- **画图面板**（点顶部「画图」按钮）：两个 tab，「画图」里输入画面描述（中英文）、选档位 fast / standard / turbo / quality / transparent，
  点「生成图片」后结果**直接显示在面板里**（附 seed / 步数 / 耗时 / 尺寸）；「模型」里可一键「设为 unet / clip / vae」、删除、按关键词搜仓库 → 查看文件 → 选目标目录 → 下载。

> 「服务」只是插件按需拉起的本地 ComfyUI 进程：首次出图自动起，空闲 15 分钟自动关，端口自动协商。

---

## ⚡ 快速开始

```text
# 文生图：最小调用
generate_image({ prompt: "窗边一个舒服的阅读角，清晨暖光，水彩", preset: "standard" })

# 一次多条提示词（每条可带 label / ratio / preset / seed）
generate_variants({ variants: [{ label: "水彩", prompt: "..." }, { label: "扁平插画", prompt: "..." }] })

# 整图图生图：保留构图，改成水彩风（denoise 0.55 默认，0.75 以上改动更明显）
edit_image({ image: "in.png", prompt: "改成柔和的水彩插画风格，保留构图和背景" })

# 局部修改：mask 白色区域允许改，黑色区域不动
edit_image({ image: "in.png", mask: "mask.png", prompt: "把头盔改成哑光黑，加一道橙色反光条", denoise: 0.85 })

# 精确改色：不跑模型，按原图明暗换色，黑线/按钮/高光原样保留
edit_image({ image: "in.png", mask: "panel.png", color: "#E00000", prompt: "把这块面板改成亮红色" })
```

`edit_image` 的几条约定：

- 输出永远是**新文件**，原图不覆盖；每次生成 `.json` sidecar。
- 局部修改会计算遮罩外平均变化，超过阈值 **8** 时门禁不通过（图仍保留，方便对比）。
- `color` 只建议用于“平涂换色”；要改材质、加零件、重画内容，用 `prompt` + `denoise` 走模型。
- 遮罩越贴合零件，结果越干净；不要把整张脸 / 整个主体都框进去。

画图面板依赖宿主接口 `/api/generate` 与 `/api/image`。**改完宿主代码后必须重启 DSH**（不是刷新页面）才会注册这两个接口；
之后刷新页面或重启即可看到新面板。

---

## 🧩 模型怎么“由用户决定”

三层都可用，全部是静态逻辑（不花推理算力）：

**A. 对话里让 Agent 管**

```text
image_models({ action: "search", keyword: "qwen-image" })
image_models({ action: "files", repo: "Comfy-Org/Qwen-Image-2.1", folder: "diffusion_models" })
image_models({ action: "download", url: "...", folder: "diffusion_models" })
image_models({ action: "select", role: "unet", name: "qwen_image_2.1_int8_convrot.safetensors" })
image_models({ action: "delete", role: "unetTurbo", name: "旧模型.safetensors" })
```

**B. 设置页点按钮**：搜索框输入关键词 → 搜索结果 → 查看文件 → 下载；本地清单里直接切换 / 删除。

**C. 直接改配置**：`~/.dsh-image-generation-ks/config.json` 的 `models.unet / unetTurbo / clip / clipLean / vae`。

五个角色：`unet`（主 DiT，`diffusion_models/`）、`unetTurbo`（turbo DiT）、`clip`（int8 编码器，画质基准）、
`clipLean`（w4a8 编码器，省显存）、`vae`（RGBA VAE）。

搜索接口来源（本机实测）：

- **HuggingFace（默认，走 `hf-mirror.com` 镜像）**：`/api/models?search=` 关键词搜索 + `/api/models/{repo}/tree/main/{folder}` 文件列表。
  直连 `huggingface.co` 在部分网络不可达，插件会自动回退到镜像；两个都试。
- **ModelScope**：关键词搜索接口现在**需要登录**（返回 401），但**仓库详情与文件列表是公开的**：
  `/api/v1/models/{repo}/repo/files?Revision=master&Root={folder}`。所以 `files` / `download` 用 ModelScope 没问题，
  `search` 建议用 `provider=huggingface`。

> 结论：没有官方“统一按关键词申请模型列表”的标准；HuggingFace + ModelScope 的公开 REST API 组合即可，
> 插件已内置多端点 / 镜像兜底，并把失败原因原样返回。

---

## 🔌 端口与配置

按 `comfy.portCandidates`（默认 `8188, 8189, 8190, 8191, 8288, 8388`）依次尝试：

1. 端口上已有 ComfyUI → 直接复用
2. 端口被别的程序占 → 顺延
3. 最终端口写入 `~/.dsh-image-generation-ks/runtime.json`，DSH 重启后复用同一实例
4. 全被占才报错并提示改配置

8188 是 ComfyUI 官方默认端口，撞车概率最低。

### 配置（`~/.dsh-image-generation-ks/config.json`，改完即生效）

```jsonc
{
  "comfy": {
    "mode": "auto",                 // auto | external | off
    "root": "<ComfyUI 根目录；也可用环境变量 DSH_COMFY_ROOT>", // python/main/cwd 留空则按 root 推导
    "portCandidates": [8188, 8189, 8190, 8191, 8288],
    "startTimeoutMs": 240000,
    "idleShutdownMs": 900000,       // 空闲 15 分钟自动关；0 = 常驻
    "openInBrowser": true           // 设置页“启动并打开”走系统默认浏览器
  },
  "models": {
    "unet": "...", "unetTurbo": "...", "clip": "...", "clipLean": "...", "vae": "...",
    "allowDelete": true,
    "searchProviders": ["modelscope", "huggingface"]
  },
  "defaults": { "preset": "standard", "steps": 40, "cfgScale": 1, "sampler": "euler", "scheduler": "simple", "aspectRatio": "1:1", "timeoutMs": 900000 },
  "outputDir": "",                  // 空 = <会话工作目录>/gen
  "toolName": "generate_image",
  "modelsToolName": "image_models",
  "apiPath": "/dsh-image-generation-ks/api"
}
```

旧版 `~/.dsh-qwen-image/config.json` 会自动继承（迁移不丢配置）。

---

## 🎚️ 档位与显存

| preset | DiT | 编码器 | 步数 | 默认尺寸 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `fast` | int8 | w4a8 | 25 | 1024² | 草稿 |
| `standard` | int8 | int8 | 40 | 1024² | 默认，画质基准 |
| `turbo` | turbo int8 | w4a8 | 8 | 1024² | 极速试构图 |
| `quality` | int8 | int8 | 40 | 2048²（官方 2K 比例） | 成稿 |
| `transparent` | int8 | w4a8 | 40 | 1024² | 透明背景 PNG |

16 GB 卡两个事实：int8 编码器（8.71 GB）+ DiT（6.76 GB）= 15.5 GB 不能同时常驻；w4a8 编码器（5.88 GB）+ DiT = 12.6 GB 可以常驻，
所以 `fast / turbo / transparent` 用 w4a8 路线。

---

## 🩺 排障

| 现象 | 处理 |
| --- | --- |
| 工具 / 设置页没出现 | 没重启 DSH；或 `node scripts/doctor.mjs` 看接线 |
| 设置页报「连不上 DSH 后端」 | 当前宿主没有 Web 接口（desktop 场景）：按钮会退化为直接打开 `http://127.0.0.1:8188` |
| 报「模型列表里没有 …」 | 权重没放对目录，或 ComfyUI 下载后没重启 |
| 第一次调用很慢 | 正常：13–17 GB 权重搬进显存，1–3 分钟 |
| 生成报 OOM | 换 `fast` 档 / 降到 1024² / 关掉其它吃显存的程序 |
| 端口被占 | 自动顺延；也可在配置里固定 |
| ComfyUI 起不来 | 看 `~/.dsh-image-generation-ks/logs/comfyui-*.log` 尾部，或双击 `start-server.cmd` |
| 想看调试日志 | 环境变量 `DSH_QWEN_IMAGE_DEBUG=1` |

---

## 🧠 SKILL 与 compose_prompts

### SKILL 是唯一权威文档

- 规则来源：`docs/配图提示词生成SKILL.md`（唯一权威文档，代码在运行时由 `lib/skill.js` 解析它）
- 铁律 → 每条提示词的 `[C_skill]` 约束；角度 / 风格 / 骨架 / 画幅表 → 目录与默认值；方案策略（语义 2–3、风格 ≥4、横竖各 ≥1）→ 组合器默认
- SKILL 缺失时退回内置默认，不阻塞出图；改 SKILL 后重启 DSH 即生效
- `read_prompt_skill` 让 LLM 直接读全文 + 摘要（角度 / 风格 / 参考图 / 样例 / 附录 / 策略）

### compose_prompts

- 工具 `compose_prompts`：一句需求 → 语义三分类（LOCK / 可释义 / 自由）→ 约束块 + 多组提示词（默认语义维 2–3 解读 × 每版 4 风格），交接给 `generate_variants` 出图。
- `action=list` 查看风格 / 图型 / 比例 id；`action=repair` 生成失败项修复块。

标准工作流（智能体侧）：

```text
compose_prompts({ brief, must_keep, styles, forms, ratios, count })
  → generate_variants({ variants: 上一步的 prompts（可带 label / ratio） })
  → read_image 逐张核对硬约束
  → 交付 2–4 张让用户挑；只有全部偏差才追问
```

实测（本需求）：2 个方案 37.6s 出图；核对发现「底层被台灯道具污染」「箭头被放大成每层 3 根」两处偏差，
修正已回写进角度模板（箭头必须写「每两层 1 根、共 3 根」；负面词加 `no furniture/lamps/books/props`）。

### plan_prompts / generate_from_brief

- `plan_prompts`：按 SKILL 生成 4 组（不同风格分类）提示词，返回 groups[]，用于分发给子智能体并行出图
- `generate_from_brief`：一步到位（语义 2–3 解读 × 4 风格 = 12 条 → ×4 种子 = 48 张，串行出图）；`dry_run:true` 先审方案
- `generate_image` 合规拦截：需求级长提示词（≥40 字且含句读）未传 `single_image_ok:true` 时直接拒绝，并返回正确流程；
  工具描述里写明“单张图仅用于明确只要一张 / 单次微调”

子智能体编排（可选）：

```text
read_prompt_skill                       # 读 SKILL
  → plan_prompts({ brief })             # 4 组，风格分类互不相同
  → 每个子智能体：generate_variants({ variants: 本组 prompts })   # 并行
  → 主智能体 read_image 逐张核对 → assemble_captions / export_ppt
```

不分子智能体时：`generate_from_brief` 串行出同一套计划。

### 参考图接入 + 提示词瘦身

- 参考图 `docs/参考图（…）.png` 共 7 张（手绘马克笔信息图 / 矢量分层图 / 3D 软塑 / 绘本彩铅），由 `lib/references.js` 解析
- 风格 Top-k 必须来自 **4 个不同分类**，`C_ref` 约束把参考图说明带进 spec
- 参考图同目录可放无字版 `底案（…）.png`，以及后期加字用的 `文字参考（…）.md`
- **提示词瘦身**：画面正文只留「内容 + 短风格词 + 布局 + 比例 + 无文字」；编号约束 / 参考图说明 / 铁律只进 `spec` 元数据用于核对，不再进画面
  （实测：长约束会被模型当正文画成满屏假文字）
- 默认文字策略 `clean-zones`：画面只留干净空白，**不画任何框 / 字**

### SKILL 代码化要点

- 8 角度：A 语义与关系、B 主体、C 骨架、D 细节、E 风格、F 画幅、G 配色光照、H 文字
- 三条铁律：具象固定（关键名词只留空白框）/ 抽象可具象但须贴合上下文 / 风格 Top-k 来自 4 个不同分类
- **提示词七要素框架**：Subject / Details & attributes / Environment & scene / Art style & medium / Composition & camera / Lighting & color / Quality & parameters（Negative 单列尾部）
- **主体七要素**：B1 主体类型（纯图形 / IP / 真实对象）、B2 抽象语义映射、B3 外观 / 动作 / 情绪 / 材质 / 主体关系 / 文字框位置 / 负面清单 → `inferSubject()` 输出主体类型、数量、空白文字框位置
- **H 文字**：图像 / 文字分离、留空文字框、字体默认黑体（雅黑）、保留纯图像底案；`spec.textRules` 记录分离 / 底案 / 字体
- C10 环形 loop 解禁：仅在「明确提出」或「大图局部关键释义」时使用
- 「艺术课讲义」风格（手绘水彩 + 拼贴 + Risograph / 丝网印感）作为艺术 / 讲义 / 科普需求的默认优先
- `skill.promptFlow`（7 要素）、`skill.textRules`、`skill.appendixCount` 与附录 24 条通用提示词样例（`skill.appendixPrompts`）由 SKILL 解析；
  参考图支持同目录「底案（…）.png」「文字版（…）.png」

### 去字底案流程（脚本）

1. `node scripts/prep-text-masks.mjs <docs>`：Windows 中文 OCR（zh-Hans-CN）识别文字 → `_masks/` 遮罩 + `ocr.json`
2. `node scripts/refs-textless.mjs --mode=inpaint --masks=<docs>/_masks --outdir=<docs>`：按遮罩局部重绘，输出 `底案（…）.png`
3. `scripts/refs-textless.mjs --mode=img2img`（旧方案，保留兼容）
4. 文字内容单独整理为 `文字参考（…）.md`（7 份已生成）

> 说明：OCR 对低对比度 / 艺术字会漏检，漏掉的文字会留在底案上；可对底案再跑一轮 `prep-text-masks` + inpaint 收敛。

### 文字与文字框：专门设计 + 确定性组装

让绘图模型自己画「空文本框」会得到位置随机、大小随意、没有引导线、和元素脱节的框。
方案：**图像只留干净区域，框和字确定性地生成**——由代码绘制，或者由 PPT 原生生成。

- `assemble_captions`：底案图 + 标签清单 → 三件套
  - `*_底案.png`（纯图像底案）
  - `*_文字版.png`（带框带字成品）
  - `*_captions.json`（框位 / 文字 / 字号 / 颜色，PPT / PS 可按坐标回填）
- 框型设计（4 类）：`title` 顶部标题胶囊（白色填充 + 强调色竖条 + 雅黑粗体）、`label` 贴边标签（淡色填充 + 同色描边 + 引导线指向锚点）、
  `bubble` 气泡（带小尾巴指向锚点，用于提示 / 结论）、`footer` 底部结论条（居中胶囊）
- 排版：锚点相对坐标（0–1）；支持 `side: left/right/top/bottom`；右侧 / 左侧纵向均分、上下排横向均分、自动避让标题 / 底栏；超长自动换行 + 缩字号
- 实测：底案（干净留白）+ 7 个标签 → 文字版排版整齐、引导线准确、无假字

```text
assemble_captions({
  base_image: '出图.png',
  labels: [
    { text: '神经网络的画室', shape: 'title' },
    { text: '杂乱素材墙', side: 'left', anchor_x: 0.2, anchor_y: 0.45 },
    { text: '① 边缘/颜色', side: 'bottom', anchor_x: 0.33, anchor_y: 0.38 },
    { text: '猜错 → 调整', shape: 'bubble', anchor_x: 0.5, anchor_y: 0.8 }
  ]
})
```

- `export_ppt`：底案 → 可编辑 `.pptx`，其中文字与文字框是 **PPT 原生对象**（可改字 / 字号 / 颜色 / 挪位）
  - 气泡框 / 标注框用透明 PNG 素材：`assets/callouts/`，7 种框型（`rounded` 圆角、`bubble_left/right/top/bottom` 带尾巴气泡、`pill` 胶囊、`tag` 标签）
    × 5 种颜色（blue #3b7ea1 / amber #c98a2b / purple #8a5fbf / green #2f8f6b / red #b5546a）；**框外完全透明（alpha=0）**，框内白底彩边，
    在 PPT 里按需**任意拉伸**成文字宽高
  - `manifest.json` 记录每种框型的内容区内边距，文字框自动避开气泡尾巴；引导线仍是 PPT 原生圆点虚线（可改 / 可删）；底部结论条也是原生形状
  - 素材生成脚本：`scripts/make_callout_assets.py`（首次导出缺失时自动生成）
  - 依赖：ComfyUI venv 已安装 `python-pptx`（`pip install python-pptx`）；无 LibreOffice 时无法自动截图，需在 PowerPoint 里截
  - 与 `assemble_captions` 的分工：`assemble_captions` 直接栅格化出「文字版 PNG」（快，适合批量预览）；
    `export_ppt` 出可编辑 PPT（正式交付、需要改字 / 协作时用）
- 参考样例：`docs/参考样例（底案-PPT截图工作流）/`
  - `weather_infographic_handdrawn_底案.png`（无文字框的干净底案）
  - `天气预报的价值_可编辑版.pptx`（PPT 原生标注）
  - `weather_infographic_handdrawn_PPT截图文字版.png`（截图成品）
  - 解析出的设计规格：1280×720 画布；底案 left 13 / top 108 / w 1249 / h 509；标注为白色圆角 + 彩色 1.5pt 边框 + 雅黑 15pt +
    **圆点虚线（ROUND_DOT）3pt** 引导线；底部白底紫边框结论条
  - `skill.samples` 自动解析该样例三元组；测试含 samples 解析 + PPT 导出冒烟
- 实测（样例底案 + 5 标注 + 1 结论条）导出的 PPT：图片 7 个（底案 1 + 标注框 6）、原生文本框 6 个（中文文字正确）、原生圆点虚线 5 条、
  画布 1280×720、PPTX 可编辑

### 工具一览

`generate_image` · `generate_variants` · `generate_from_brief` · `edit_image` · `image_models` · `compose_prompts` ·
`plan_prompts` · `read_prompt_skill` · `assemble_captions` · `export_ppt`

---

## 🗂️ 目录

```text
dsh-image-generation/
├─ lib/              插件代码（工具、ComfyUI runner、SKILL 解析、captions/PPT）
├─ scripts/          体检、单测、OCR 遮罩、去字底案、气泡素材
├─ docs/             SKILL、参考图、参考样例、说明文档
├─ assets/callouts/  透明 PNG 气泡 / 标注框素材（7 框型 × 5 色）
├─ cordis.patch.yml  bundle 入口（自注册）
├─ install.ps1 / install.cmd / uninstall.ps1 / start-server.cmd
├─ icon.svg
└─ package.json / README.md / README.zh-CN.md / CHANGELOG.md / LICENSE
```

本目录自包含（安装器、体检、单测、启动脚本、文档、默认参数）。换机器：

1. 复制目录（或 git clone / 解压 zip）
2. 目标机装好 ComfyUI + 权重
3. 双击 `install.cmd`（必要时 `-ProfileDir`）
4. 重启 DSH

上传 GitHub：本目录就是仓库根（`package.json` / `README.md` / `LICENSE` / `.gitignore` 齐全），
`git init && git add . && git commit -m init && git push`；别人 clone 后双击 `install.cmd`。

版本历史见 [CHANGELOG.md](./CHANGELOG.md)。

---

## 📄 License

插件本体 MIT。模型权重不在本仓库：Qwen-Image-2.1 受 **Qwen Research License**（研究 / 评估用途，商用需单独授权）；ComfyUI 为 GPL-3.0。

[MIT](./LICENSE) © 2026 KittenSleepwalk
