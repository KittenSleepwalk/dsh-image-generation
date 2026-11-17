<div align="center">

# dsh-image-generation

**Say one sentence in chat and get an image — local ComfyUI plus Qwen-Image-2.1, wired up end to end by the plugin.**

<a href="https://github.com/KittenSleepwalk/dsh-image-generation/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KittenSleepwalk/dsh-image-generation?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-image-generation/issues"><img alt="GitHub issues" src="https://img.shields.io/github/issues/KittenSleepwalk/dsh-image-generation?style=flat-square"></a>
<a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-amber.svg?style=flat-square"></a>
<a href="https://github.com/KittenSleepwalk/dsh-image-generation"><img alt="DSH >= 0.2.0-rc.1" src="https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.1-4d6bfe?style=flat-square"></a>
<img alt="GPU: 16GB VRAM" src="https://img.shields.io/badge/VRAM-16GB%2B-76B900?style=flat-square">

**English** · [简体中文](./README.zh-CN.md)

</div>

> [!WARNING]
> **Only verified on one machine — not guaranteed to be fully safe.**
>
> - It runs on the author's machine (RTX 4070 Ti SUPER 16GB), and it **has only ever been tried on that single machine** — never on a second machine, and never on other DSH versions.
> - Treat it as *works, but not thoroughly verified*: **back up `~/.dsh` before installing** (at least `~/.dsh/profiles/<your-profile>` and any config you edited), so a broken install can be rolled back by restoring a directory.
> - This plugin **launches a local `ComfyUI` process**, takes a large slice of VRAM (**13–17 GB of weights**), downloads **more than ten GB** of model files, and writes `~/.dsh-image-generation-ks/` plus an output directory. **While it holds VRAM it can disturb a game or a render you are running.**
> - **Install [`@kittensleepwalk/dsh-sandbox-gate`](https://github.com/KittenSleepwalk/dsh-sandbox-gate) first** — it runs the candidate plugin inside a throwaway sandbox copy (boot, cold restarts, sessions, other plugins, GPU contention) and only lets it reach the host once it passes.
>
> ```bash
> pnpm add github:KittenSleepwalk/dsh-sandbox-gate
> ```

---

## 🚀 Install

```bash
# 1) straight from GitHub (the repository root *is* the package root)
pnpm add github:KittenSleepwalk/dsh-image-generation

# 2) or from a local tarball
pnpm pack    # produces kittensleepwalk-dsh-image-generation-0.2.4.tgz
pnpm add ./kittensleepwalk-dsh-image-generation-0.2.4.tgz
```

This package **ships its own `cordis.patch.yml`**. After installing, add the package name
`@kittensleepwalk/dsh-image-generation` to `dsh.profile.bundles` in your DSH profile and restart DSH.

### Or: the one-command installer

```powershell
# double-clicking install.cmd does the same
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

It will:

1. create a scoped junction for the package under the profile's `node_modules/@kittensleepwalk/`
2. add the dependency + bundle to the profile `package.json`
3. insert the plugin entry into the profile `cordis.patch.yml`
4. disable the old `dsh-comfyui-image` by default (it registers the same `generate_image` tool name — pick one)
5. clean up the wiring left behind by the old `dsh-qwen-image` (no leftovers after an upgrade)

Then **fully quit DSH and start it again**.

| Switch | Effect |
| --- | --- |
| `-CheckOnly` | inspect only, change nothing |
| `-EnableOld` | keep the old image plugin enabled |
| `-ProfileDir <path>` | target a specific profile |

Uninstall: `uninstall.ps1` (it does not touch ComfyUI or the weights).

---

## 📦 Requirements

- **ComfyUI ≥ 0.37.0** (it must provide `TextEncodeQwenImage21`), installed by default at `<ComfyUI root>` (point at it with `DSH_COMFY_ROOT` or the config key `comfy.root`).
- Weights, placed under `models/` (when something is missing, `image_models` tells you):

| Directory | File | Purpose |
| --- | --- | --- |
| `diffusion_models/` | `qwen_image_2.1_int8_convrot.safetensors` | main DiT |
| `diffusion_models/` | `qwen_image_2.1_turbo_int8_convrot.safetensors` | turbo tier (optional) |
| `text_encoders/` | `qwen3vl_8b_int8_convrot.safetensors` | encoder (image-quality baseline) |
| `text_encoders/` | `qwen3vl_8b_w4a8.safetensors` | encoder (VRAM-saving, resident on 16 GB) |
| `vae/` | `qwen_image_2.1_vae_bf16.safetensors` | RGBA VAE |

**PyTorch cu130 recommended**: only then do the int8 weights go through the fused CUDA kernels (on the same card, 1024² dropped from ~69 s to ~21 s).
Install with:
`pip install "torch==2.9.1" "torchvision==0.24.1" "torchaudio==2.9.1" --index-url https://download.pytorch.org/whl/cu130`
(`pip freeze` before upgrading if you want a rollback path; restart ComfyUI afterwards.)

Health check: `node scripts/doctor.mjs` (weights / selected models / ComfyUI / nodes / model list / port / local inventory).

Requirements elsewhere: **Node.js ≥ 20, DSH ≥ 0.2.0-rc.1**. Paths such as `%USERPROFILE%` and `D:\...` are examples — use your own.

### Measured on the author's machine (RTX 4070 Ti SUPER 16GB)

| Setup | cold start + render, total | sampling (fast, 25 steps, 1024²) |
| --- | --- | --- |
| cu126 (old) | 81.0 s | 51.9 s (0.48 it/s) |
| **cu130 (current)** | **49.7 s** | **18.1 s (2.6–2.9 it/s)** |

Under cu130, `comfy_kitchen backend cuda` flips from `disabled=True` to `disabled=False`, `int8_tensorwise` enters Native ops,
and sampling becomes **≈2.9×** faster. The ~30 s of cold start is one-off weight loading — changing the seed or firing again on the
same tier is noticeably quicker.

---

## 🖼️ What it does

- **`generate_image`** — the Agent calls it to draw; the plugin launches or reuses a local ComfyUI and renders with Qwen-Image-2.1 (int8 / w4a8, tuned for 16 GB VRAM).
- **`edit_image`** — img2img / masked local edits on an existing picture; passing `color: "#RRGGBB"` together with a `mask` takes the exact-recolour path (no model run, keeping the original lines, buttons and shading).
- **`image_models`** — model management (pure static logic): list local models, keyword-search repositories, inspect repository files, download, switch the model a tier uses, delete files you no longer need.
- **Settings page "图像生成 (KS)"** — ComfyUI status, **open the ComfyUI frontend in one click** (new tab), **start it and open it in the default browser**, the local model list (switch / delete), search and download.
- **Draw panel** (the “画图” button at the top) — two tabs: **draw** (prompt in Chinese or English, tier fast / standard / turbo / quality / transparent, “generate” → the result shows up **right in the panel** with seed / steps / elapsed time / size) and **models** (one-click “set as unet / clip / vae”, delete, keyword search → inspect files → pick the target directory → download).

> The “service” is just a local ComfyUI process the plugin starts on demand: it comes up at the first render, shuts down after
> 15 minutes idle, and the port is negotiated automatically.

---

## ⚡ Quick start

```text
# text to image — the minimum call
generate_image({ prompt: "a cosy reading nook by the window, warm morning light, watercolour", preset: "standard" })

# several prompts in one call (each item may carry label / ratio / preset / seed)
generate_variants({ variants: [{ label: "watercolour", prompt: "..." }, { label: "flat illustration", prompt: "..." }] })

# img2img: keep the composition, restyle it (denoise 0.55 default, 0.75 and above changes more)
edit_image({ image: "in.png", prompt: "restyle it as a soft watercolour illustration, keep the composition and the background" })

# local edit: the white mask area may change, the black area stays
edit_image({ image: "in.png", mask: "mask.png", prompt: "turn the helmet matte black and add an orange reflective stripe", denoise: 0.85 })

# exact recolour: no model run, recolour by the original luminance, black lines / buttons / highlights kept as they are
edit_image({ image: "in.png", mask: "panel.png", color: "#E00000", prompt: "make this panel bright red" })
```

How `edit_image` behaves:

- the output is always a **new file**, the original is never overwritten; every render also writes a `.json` sidecar.
- a local edit measures the average change outside the mask; above threshold **8** the gate fails (the image is still kept so you can compare side by side).
- `color` is only meant for **flat recolouring**; to change a material, add parts or redraw content, use `prompt` + `denoise` and go through the model.
- the tighter the mask hugs the part, the cleaner the result; do not box in a whole face or a whole subject.

The panel relies on the host routes `/api/generate` and `/api/image`. After changing host code you must **restart DSH** (not just
refresh the page) for those two routes to register; afterwards a page refresh or a restart shows the new panel.

---

## 🧩 Model management

All three layers work, and all of them are static logic (no inference compute is spent):

**A. Let the Agent manage it in chat**

```text
image_models({ action: "search", keyword: "qwen-image" })
image_models({ action: "files", repo: "Comfy-Org/Qwen-Image-2.1", folder: "diffusion_models" })
image_models({ action: "download", url: "...", folder: "diffusion_models" })
image_models({ action: "select", role: "unet", name: "qwen_image_2.1_int8_convrot.safetensors" })
image_models({ action: "delete", role: "unetTurbo", name: "old-model.safetensors" })
```

**B. Click buttons on the settings page**: type a keyword into the search box → search results → inspect files → download; in the local list you switch or delete directly.

**C. Edit the config yourself**: `models.unet / unetTurbo / clip / clipLean / vae` in `~/.dsh-image-generation-ks/config.json`.

The five roles: `unet` (main DiT, `diffusion_models/`), `unetTurbo` (turbo DiT), `clip` (int8 text encoder — the image-quality baseline),
`clipLean` (w4a8 text encoder — saves VRAM), `vae` (RGBA VAE).

Where the search endpoints come from (measured here):

- **HuggingFace (default, going through the `hf-mirror.com` mirror)**: `/api/models?search=` for keyword search and
  `/api/models/{repo}/tree/main/{folder}` for the file listing. Direct `huggingface.co` is unreachable on some networks, so the plugin
  falls back to the mirror automatically; it tries both.
- **ModelScope**: the keyword search endpoint now **requires a login** (returns 401), but **repository details and file listings are public**:
  `/api/v1/models/{repo}/repo/files?Revision=master&Root={folder}`. So `files` / `download` work fine against ModelScope;
  for `search`, prefer `provider=huggingface`.

> Conclusion: there is no official standard for “give me a model list by keyword”; the public REST APIs of HuggingFace plus ModelScope in
> combination are enough, the plugin ships multi-endpoint / mirror fallbacks and returns the failure reason verbatim.

---

## 🔌 Ports & config

It walks `comfy.portCandidates` in order (default `8188, 8189, 8190, 8191, 8288, 8388`):

1. a ComfyUI already listening on that port → reuse it
2. the port is taken by something else → move on to the next one
3. the final port is written to `~/.dsh-image-generation-ks/runtime.json`, so DSH reuses the same instance after a restart
4. only if every candidate is taken does it fail, telling you to change the config

8188 is ComfyUI's official default port, so collisions are least likely there.

### Config: `~/.dsh-image-generation-ks/config.json` (takes effect as soon as you save)

```jsonc
{
  "comfy": {
    "mode": "auto",                 // auto | external | off
    "root": "<ComfyUI root; DSH_COMFY_ROOT also works>", // python/main/cwd fall back to root when left empty
    "portCandidates": [8188, 8189, 8190, 8191, 8288],
    "startTimeoutMs": 240000,
    "idleShutdownMs": 900000,       // shut down after 15 minutes idle; 0 = stay resident
    "openInBrowser": true           // the settings page's "start and open" uses the system default browser
  },
  "models": {
    "unet": "...", "unetTurbo": "...", "clip": "...", "clipLean": "...", "vae": "...",
    "allowDelete": true,
    "searchProviders": ["modelscope", "huggingface"]
  },
  "defaults": { "preset": "standard", "steps": 40, "cfgScale": 1, "sampler": "euler", "scheduler": "simple", "aspectRatio": "1:1", "timeoutMs": 900000 },
  "outputDir": "",                  // empty = <session working directory>/gen
  "toolName": "generate_image",
  "modelsToolName": "image_models",
  "apiPath": "/dsh-image-generation-ks/api"
}
```

The old `~/.dsh-qwen-image/config.json` is inherited automatically (no config is lost on migration).

---

## 🎚️ Tiers & VRAM

| preset | DiT | encoder | steps | default size | purpose |
| --- | --- | --- | --- | --- | --- |
| `fast` | int8 | w4a8 | 25 | 1024² | drafts |
| `standard` | int8 | int8 | 40 | 1024² | default, image-quality baseline |
| `turbo` | turbo int8 | w4a8 | 8 | 1024² | very fast composition trials |
| `quality` | int8 | int8 | 40 | 2048² (official 2K ratio) | final renders |
| `transparent` | int8 | w4a8 | 40 | 1024² | transparent-background PNG |

Two facts on a 16 GB card: the int8 encoder (8.71 GB) + DiT (6.76 GB) = 15.5 GB cannot stay resident together;
the w4a8 encoder (5.88 GB) + DiT = 12.6 GB can, which is why `fast / turbo / transparent` take the w4a8 route.

---

## 🩺 Troubleshooting

| Symptom | What to do |
| --- | --- |
| The tool / settings page never shows up | DSH was not restarted; or run `node scripts/doctor.mjs` to inspect the wiring |
| The settings page reports “cannot reach the DSH backend” | the current host has no Web interface (desktop case): the button degrades to opening `http://127.0.0.1:8188` directly |
| “model list has no …” | the weights sit in the wrong directory, or ComfyUI was not restarted after the download |
| The first call is very slow | normal: 13–17 GB of weights are moved into VRAM, 1–3 minutes |
| Generation reports OOM | switch to `fast`, drop to 1024², close other VRAM-hungry programs |
| Port already taken | it moves on automatically; you can also pin one in the config |
| ComfyUI will not start | look at the tail of `~/.dsh-image-generation-ks/logs/comfyui-*.log`, or double-click `start-server.cmd` |
| You want debug logs | environment variable `DSH_QWEN_IMAGE_DEBUG=1` |

---

## 🧠 SKILL / compose_prompts

### The SKILL is the single source of truth

- The rules live in `docs/配图提示词生成SKILL.md` — the only authoritative document, parsed by the code at runtime (`lib/skill.js`).
- The iron rules become a `[C_skill]` constraint on every prompt; the angle / style / skeleton / aspect-ratio tables become the catalogue and
  the defaults; the plan policy (2–3 interpretations, ≥ 4 styles, at least one landscape and one portrait) becomes the composer default.
- If the SKILL is missing, the plugin falls back to built-in defaults and still renders; edit the SKILL, restart DSH, and it is in effect.
- `read_prompt_skill` lets the model read the full text plus a summary (angles / styles / references / samples / appendix / policy).

### compose_prompts

- One brief → semantic three-way classification (LOCK / interpretable / free) → a numbered constraint block plus prompt groups
  (default 2–3 interpretations × 4 styles per version) → handed to `generate_variants`.
- `action=list` lists the style / form / ratio ids; `action=repair` builds the fix block for the constraints that failed.

Standard agent-side workflow:

```text
compose_prompts({ brief, must_keep, styles, forms, ratios, count })
  → generate_variants({ variants: <the prompts from the previous step> (label / ratio optional) })
  → read_image, check every hard constraint image by image
  → deliver 2–4 images for the user to pick; only ask back if every plan misses
```

Measured on a real request: two plans rendered in 37.6 s; the check found two deviations — “the bottom layer polluted by desk-lamp props”
and “arrows scaled up to three per layer”. Both fixes went back into the angle templates: arrows must be written as
“one arrow per two layers, three in total”; the negative prompt gains `no furniture/lamps/books/props`.

### plan_prompts / generate_from_brief

- `plan_prompts` produces 4 groups of prompts, each from a different style category, returned as `groups[]` so they can be fanned out to sub-agents.
- `generate_from_brief` is the one-shot path: 2–3 interpretations × 4 styles (3×4 = 12 prompts by default) × 4 seeds = 48 images, rendered serially.
  Pass `dry_run: true` to review the prompts and the plan without rendering.
- `generate_image` keeps a compliance gate: a requirement-level long prompt (≥ 40 characters and containing sentence punctuation) is rejected
  unless `single_image_ok: true` is passed, and the rejection returns the correct flow. The tool description spells out that a single image is
  only for “exactly one image wanted” or “one small retouch”.

Sub-agent orchestration (optional):

```text
read_prompt_skill                       # read the SKILL
  → plan_prompts({ brief })             # 4 groups, style categories all different
  → each sub-agent: generate_variants({ variants: <this group's prompts> })   # in parallel
  → main agent: read_image, check each image → assemble_captions / export_ppt
```

Without sub-agents, `generate_from_brief` renders the same plan serially.

### Reference images and prompt slimming

- `docs/参考图（…）.png`: 7 reference images (hand-drawn marker infographic / vector layered diagram / 3D soft plastic / picture-book coloured pencil), parsed by `lib/references.js`.
- Style Top-k must come from **4 different categories**, and a `C_ref` constraint carries the reference note into the spec.
- Reference sets may also ship a textless `底案（…）.png` next to them, plus a `文字参考（…）.md` holding the text that will be typeset later.
- The prompt body only keeps “content + short style words + layout + ratio + no text”; numbered constraints, reference notes and iron rules stay in the
  `spec` metadata for review and never enter the picture (measured: long constraints get painted into the picture as screenfuls of fake text).
- The default text strategy is `clean-zones`: the picture only leaves clean blank areas — **no frames, no text at all**.

### The SKILL in code

- Eight angles A–H: A semantics & relations, B subject, C skeleton, D details, E style, F aspect ratio, G colour & light, H text.
- Three iron rules: concrete things are fixed (key nouns only get blank boxes) / abstract things may be made concrete but must fit the context /
  style Top-k comes from 4 different categories.
- Seven-element prompt frame: Subject / Details & attributes / Environment & scene / Art style & medium / Composition & camera / Lighting & color /
  Quality & parameters (Negative listed separately at the end).
- Subject seven elements: B1 subject type (pure shape / IP / real object), B2 abstract-semantics mapping, B3 appearance / action / emotion / material /
  subject relations / text-box position / negative list → `inferSubject()` outputs the subject type, the count and the blank text-box positions.
- H text: image/text separation, leave blank text boxes, the font defaults to 黑体 (YaHei), keep the pure-image base.
- C10 radial loop is unlocked only when it is “explicitly requested” or “a key interpretation inside a large image”.
- The “art-class handout” style (hand-drawn watercolour + collage + a Risograph / silkscreen feel) is the default first choice for art, handout and
  popular-science requests.
- `skill.promptFlow` (the 7 elements), `skill.textRules`, `skill.appendixCount` and the 24 appendix prompts (`skill.appendixPrompts`) are all parsed
  from the SKILL; a reference directory may also carry `底案（…）.png` and `文字版（…）.png`.

### Text-free base images (scripts)

1. `node scripts/prep-text-masks.mjs <docs>`: Windows Chinese OCR (zh-Hans-CN) finds the text → `_masks/` masks + `ocr.json`
2. `node scripts/refs-textless.mjs --mode=inpaint --masks=<docs>/_masks --outdir=<docs>`: repaints locally through the masks, writes `底案（…）.png`
3. `scripts/refs-textless.mjs --mode=img2img` (the old path, kept for compatibility)
4. The text itself is filed separately as `文字参考（…）.md` (7 already generated)

> OCR misses low-contrast and stylised lettering, and whatever it misses stays on the base — run `prep-text-masks` + inpaint once more
> on the base to converge.

### Frames and text: designed once, assembled deterministically

Asking the drawing model to paint “empty text boxes” produces boxes with random positions, arbitrary sizes, no leader lines and no relation to
the elements. The solution: **the image only leaves clean areas, and boxes and text are produced deterministically** — by code, or natively by PowerPoint.

- `assemble_captions`: base image + label list → three files
  - `*_底案.png` (the pure image base)
  - `*_文字版.png` (finished, boxed and lettered)
  - `*_captions.json` (box position / text / font size / colour, so PPT or PS can backfill by coordinate)
- Four frame types: `title` top title pill (white fill + accent bar + YaHei bold), `label` edge label (light fill + same-colour stroke + a leader line
  pointing at the anchor), `bubble` (with a small tail pointing at the anchor, for hints and conclusions), `footer` bottom conclusion bar (centred pill).
- Layout: anchors in relative 0–1 coordinates; `side: left/right/top/bottom`; left and right columns distribute evenly vertically, top and bottom rows
  evenly horizontally, automatically avoiding the title and the footer; over-long text wraps and shrinks the font size.
- Measured: a base with clean whitespace plus 7 labels → the lettered version is tidy, the leader lines land exactly, no fake text.

```text
assemble_captions({
  base_image: 'render.png',
  labels: [
    { text: "the neural network's studio", shape: 'title' },
    { text: 'cluttered material wall', side: 'left', anchor_x: 0.2, anchor_y: 0.45 },
    { text: '① edge / colour', side: 'bottom', anchor_x: 0.33, anchor_y: 0.38 },
    { text: 'wrong guess → adjust', shape: 'bubble', anchor_x: 0.5, anchor_y: 0.8 }
  ]
})
```

- `export_ppt`: base → an editable `.pptx` in which text and frames are **native PowerPoint objects** (you can re-type, resize, recolour).
  - Frames come from transparent PNG assets in `assets/callouts/`: 7 shapes (`rounded`, `bubble_left/right/top/bottom`, `pill`, `tag`) ×
    5 colours (blue #3b7ea1 / amber #c98a2b / purple #8a5fbf / green #2f8f6b / red #b5546a). **Outside the frame is fully transparent (alpha=0)**,
    inside is white with a coloured border, so a frame can be **stretched to any text width** in PowerPoint.
  - `manifest.json` records the content padding of every shape, so the text box automatically avoids the bubble tail; leader lines stay native
    PowerPoint dotted lines (editable, deletable); the bottom conclusion bar is also native.
  - The asset generator is `scripts/make_callout_assets.py` (run automatically on the first export when the assets are missing).
  - Dependency: `python-pptx` inside the ComfyUI venv (`pip install python-pptx`). Without LibreOffice there is no automatic screenshot, so
    capture it in PowerPoint yourself.
  - Division of labour: `assemble_captions` rasterises the lettered PNG directly (fast, good for batch previews); `export_ppt` produces an
    editable PPTX (for real delivery and for edits by others).
- Reference sample: `docs/参考样例（底案-PPT截图工作流）/`
  - `weather_infographic_handdrawn_底案.png` (a clean base with no text boxes)
  - `天气预报的价值_可编辑版.pptx` (native PowerPoint annotations)
  - `weather_infographic_handdrawn_PPT截图文字版.png` (the lettered screenshot)
  - the parsed design spec: 1280×720 canvas; base at left 13 / top 108 / w 1249 / h 509; annotations are white rounded boxes with a coloured 1.5 pt
    border, YaHei 15 pt and **round-dot (ROUND_DOT) 3 pt** leader lines; the bottom conclusion bar is white with a purple border.
  - `skill.samples` parses that triple automatically; the test suite covers samples parsing plus a PPT export smoke run.
- Measured export (sample base + 5 annotations + 1 conclusion bar): 7 images (1 base + 6 annotation boxes), 6 native text boxes with correct
  Chinese text, 5 native dotted leader lines, a 1280×720 canvas, and an editable `.pptx`.

### Tool set

`generate_image` · `generate_variants` · `generate_from_brief` · `edit_image` · `image_models` · `compose_prompts` · `plan_prompts` ·
`read_prompt_skill` · `assemble_captions` · `export_ppt`

---

## 🗂️ Layout

```text
dsh-image-generation/
├─ lib/              plugin code (tools, ComfyUI runner, SKILL parser, captions/PPT)
├─ scripts/          doctor, tests, OCR masks, text-free bases, callout assets
├─ docs/             the SKILL, reference images, samples, notes
├─ assets/callouts/  transparent PNG callout frames (7 shapes × 5 colours)
├─ cordis.patch.yml  bundle entry (self-registering)
├─ install.ps1 / install.cmd / uninstall.ps1 / start-server.cmd
├─ icon.svg
└─ package.json / README.md / README.zh-CN.md / CHANGELOG.md / LICENSE
```

This directory is self-contained (installer, health check, unit tests, start script, docs, default parameters). Moving to another machine:

1. copy the directory (or `git clone` / unzip it)
2. install ComfyUI + the weights on the target machine
3. double-click `install.cmd` (use `-ProfileDir` if needed)
4. restart DSH

Publishing to GitHub: this directory *is* the repository root (`package.json` / `README.md` / `LICENSE` / `.gitignore` are all in place) —
`git init && git add . && git commit -m init && git push`; anyone who clones it just double-clicks `install.cmd`.

See [CHANGELOG.md](./CHANGELOG.md) for the version history.

---

## 📄 License

The plugin itself is MIT. The model weights are not in this repository: Qwen-Image-2.1 falls under the
**Qwen Research License** (research / evaluation use; commercial use needs a separate grant), and ComfyUI is GPL-3.0.

[MIT](./LICENSE) © 2026 KittenSleepwalk
