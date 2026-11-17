/**
 * 导入冒烟：确认所有模块能被 ESM 正确解析、导出名对得上、两个工具都能注册。
 * 不联网、不启动 ComfyUI。运行：node scripts/import-smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const libDir = path.join(here, '..', 'lib')

const modules = [
  'index.js',
  'tool.js',
  'models-tool.js',
  'models.js',
  'runner.js',
  'result.js',
  'files.js',
  'workflow.js',
  'params.js',
  'presets.js',
  'config.js',
  'comfy.js',
  'server.js',
  'gate.js',
  'errors.js',
  'log.js',
  'api.js'
]

for (const file of modules) {
  const mod = await import(pathToFileURL(path.join(libDir, file)).href)
  assert.ok(Object.keys(mod).length > 0, `模块没有导出：${file}`)
}

const index = await import(pathToFileURL(path.join(libDir, 'index.js')).href)
assert.equal(index.name, '@kittensleepwalk/dsh-image-generation-ks')
assert.deepEqual(index.inject, ['tools'])
assert.equal(typeof index.apply, 'function')

const registered = []
const fakeCtx = {
  reflect: {
    get: (key) => {
      if (key !== 'tools') return undefined
      return { register: (tool) => { registered.push(tool) } }
    }
  }
}
index.apply(fakeCtx, {})
assert.equal(registered.length, 9, 'apply 应该注册九个工具')
assert.equal(registered[0].name, 'generate_image')
assert.equal(registered[1].name, 'image_models')
assert.equal(registered[2].name, 'generate_variants')
assert.equal(registered[3].name, 'compose_prompts')
assert.equal(registered[4].name, 'generate_from_brief')
assert.equal(registered[5].name, 'assemble_captions')
assert.equal(registered[6].name, 'export_ppt')
assert.equal(registered[7].name, 'read_prompt_skill')
assert.equal(registered[8].name, 'plan_prompts')
for (const tool of registered) {
  assert.equal(typeof tool.execute, 'function', tool.name + ' 缺少 execute')
  assert.equal(typeof tool.parameters, 'object', tool.name + ' 缺少 parameters')
  assert.equal(typeof tool.output.render, 'function', tool.name + ' 缺少 output.render')
}

// image_models 的动作枚举必须齐全
const modelEnums = registered[1].parameters.properties.action.enum
for (const action of ['list', 'search', 'files', 'download', 'select', 'delete']) {
  assert.ok(modelEnums.includes(action), `image_models 缺少 action=${action}`)
}

// 客户端 bundle 是 hand-written 的 ModuleLoader 格式，不能在 Node 里 import，只做静态检查
const clientSource = fs.readFileSync(path.join(libDir, 'client.js'), 'utf8')
assert.match(clientSource, /window\.__ModuleLoader__\.load/)
assert.match(clientSource, /settings\.section/)
assert.match(clientSource, /exports\.apply = apply/)
assert.match(clientSource, /dsh-image-generation-ks\/api/)

console.log(`import smoke ok: tools=${registered.map((tool) => tool.name).join('+')}, client bundle ok`)
