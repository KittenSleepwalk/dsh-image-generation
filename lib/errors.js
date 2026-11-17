/** 错误分类：每种错误都必须带「怎么办」，因为报错是给 Agent 和用户一起看的。 */

export const CODES = {
  BAD_ARGS: 'BAD_ARGS',
  SERVER_DOWN: 'SERVER_DOWN',
  SERVER_START_FAILED: 'SERVER_START_FAILED',
  MISSING_NODE: 'MISSING_NODE',
  MISSING_MODEL: 'MISSING_MODEL',
  SUBMIT_FAILED: 'SUBMIT_FAILED',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  OOM: 'OOM',
  TIMEOUT: 'TIMEOUT',
  NO_IMAGE: 'NO_IMAGE',
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  GATE_FAILED: 'GATE_FAILED',
  ABORTED: 'ABORTED'
}

export class ImagePluginError extends Error {
  constructor(code, message, hint = '') {
    super(message)
    this.name = 'ImagePluginError'
    this.code = code
    this.hint = hint
  }
}

export function fail(code, message, hint = '') {
  throw new ImagePluginError(code, message, hint)
}

/** 把错误压成「一句话 + 怎么办」，空行分开，方便直接贴给用户。 */
export function formatError(error) {
  if (error instanceof ImagePluginError) {
    return error.hint ? `${error.message}\n怎么办：${error.hint}` : error.message
  }
  const message = error && error.message ? error.message : String(error)
  return message
}

/** 判断 ComfyUI 返回的错误里有没有显存不足的痕迹。 */
export function looksLikeOom(text) {
  const s = String(text || '').toLowerCase()
  return (
    s.includes('out of memory') ||
    s.includes('outofmemoryerror') ||
    s.includes('allocation on device') ||
    s.includes('cuda error: out of memory') ||
    s.includes('oom')
  )
}
