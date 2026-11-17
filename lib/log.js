/** 日志：默认只打一行启动摘要，调试信息用环境变量打开。 */

const PREFIX = '[image-generation-ks]'

export function debugEnabled() {
  const value = String(process.env.DSH_IMAGE_KS_DEBUG || process.env.DSH_QWEN_IMAGE_DEBUG || '').toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export function logInfo(...args) {
  console.log(PREFIX, ...args)
}

export function logWarn(...args) {
  console.warn(PREFIX, ...args)
}

export function logDebug(...args) {
  if (debugEnabled()) console.log(PREFIX, '[debug]', ...args)
}
