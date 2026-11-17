/**
 * 宿主接口冒烟测试：不起 DSH，直接把 registerApi 挂到一个裸 http.Server 上。
 *
 *   node scripts/api-smoke.mjs
 *
 * 只验证"路由接上了、参数校验生效、不会 500"，不跑模型。
 */

import http from 'node:http'

import { registerApi } from '../lib/api.js'

const PREFIX = '/dsh-image-generation-ks/api'

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.url = PREFIX + (req.url === '/' ? '' : req.url)
      handler(req, res)
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function request(port, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text.slice(0, 200) }
  }
  return { status: response.status, json }
}

async function main() {
  let handler
  const ctx = {
    webServer: {
      register({ handler: fn }) {
        handler = fn
        return () => {}
      }
    }
  }
  registerApi(ctx, {})
  const server = await listen(handler)
  const { port } = server.address()
  const failures = []

  const caps = await request(port, 'GET', '/layered/capabilities')
  console.log('GET  /layered/capabilities →', caps.status, JSON.stringify(caps.json).slice(0, 220))
  if (caps.status !== 200 || !caps.json.ok) failures.push('capabilities 没通')

  const state = await request(port, 'GET', '/state')
  console.log('GET  /state →', state.status, 'ok=' + (state.json && state.json.ok))
  if (state.status !== 200) failures.push('state 没通')

  const bad = await request(port, 'POST', '/layered/decompose', { file: 'C:/definitely/not/here.png' })
  console.log('POST /layered/decompose（坏路径）→', bad.status, bad.json.error)
  if (bad.status !== 400) failures.push('坏路径没有被拦下')

  const missing = await request(port, 'GET', '/layered/status?job=nope')
  console.log('GET  /layered/status（假任务）→', missing.status, missing.json.error)
  if (missing.status !== 404) failures.push('假任务没有被拦下')

  const unknown = await request(port, 'GET', '/nope')
  console.log('GET  /nope →', unknown.status)
  if (unknown.status !== 404) failures.push('未知路由没有 404')

  server.close()
  if (failures.length) {
    console.log('失败：', failures.join('；'))
    process.exit(1)
  }
  console.log('接口冒烟测试通过')
  process.exit(0)
}

main().catch((error) => {
  console.error('冒烟测试崩了：', error)
  process.exit(1)
})
