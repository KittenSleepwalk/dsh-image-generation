/**
 * Web 客户端半：在设置页注册一个「图像生成 (KS)」分区。
 *
 * 功能（全部是静态逻辑，不调用 LLM）：
 *   - 显示 ComfyUI 运行状态与显存
 *   - 「打开 ComfyUI 前端」：新标签页打开
 *   - 「启动并打开」：让宿主确保 ComfyUI 在跑，再用系统默认浏览器打开（desktop 场景）
 *   - 本地模型清单：切换档位使用的模型、删除不用的模型
 *   - 关键词搜索仓库 → 查看文件 → 下载
 *
 * 这个文件是 DSH 的客户端 bundle 格式（window.__ModuleLoader__.load + factory），
 * 不经过打包器；只 require 平台内置的 react。
 */
window.__ModuleLoader__.load({
  id: '@kittensleepwalk/dsh-image-generation-ks',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var API = '/dsh-image-generation-ks/api'
    var DEFAULT_BASE = 'http://127.0.0.1:8188'

    var ROLE_ORDER = ['unet', 'unetTurbo', 'clip', 'clipLean', 'vae']
    var ROLE_LABELS = {
      unet: '主 DiT',
      unetTurbo: 'turbo DiT',
      clip: '编码器 int8',
      clipLean: '编码器 w4a8',
      vae: 'VAE'
    }
    var FOLDER_OF_ROLE = {
      unet: 'diffusion_models',
      unetTurbo: 'diffusion_models',
      clip: 'text_encoders',
      clipLean: 'text_encoders',
      vae: 'vae'
    }

    var styles = {
      root: { padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '14px', maxWidth: '980px' },
      card: { border: '1px solid rgba(127,127,127,0.25)', borderRadius: '10px', padding: '14px 16px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '15px', fontWeight: 600, marginBottom: '8px' },
      sub: { fontSize: '12px', opacity: 0.7, lineHeight: 1.6 },
      button: {
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '8px',
        padding: '6px 12px',
        cursor: 'pointer',
        background: 'transparent',
        color: 'inherit',
        fontSize: '13px'
      },
      primary: {
        border: '1px solid rgba(90,140,255,0.7)',
        background: 'rgba(90,140,255,0.15)',
        borderRadius: '8px',
        padding: '6px 12px',
        cursor: 'pointer',
        color: 'inherit',
        fontSize: '13px'
      },
      input: {
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '8px',
        padding: '6px 10px',
        background: 'transparent',
        color: 'inherit',
        fontSize: '13px',
        minWidth: '220px'
      },
      badge: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '999px',
        border: '1px solid rgba(127,127,127,0.35)'
      },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px' },
      msg: { fontSize: '12px', color: '#8ab4ff' },
      err: { fontSize: '12px', color: '#ff8a8a' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
      td: { padding: '5px 8px', borderBottom: '1px solid rgba(127,127,127,0.15)', verticalAlign: 'middle' }
    }

    function call(path, body) {
      var options = { headers: { Accept: 'application/json' } }
      if (body !== undefined) {
        options.method = 'POST'
        options.headers['Content-Type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      return fetch(API + path, options).then(function (response) {
        return response.json().then(function (json) {
          if (!json || json.ok === false) throw new Error((json && json.error) || 'HTTP ' + response.status)
          return json
        })
      })
    }

    function Section(props) {
      var stateHook = useState(null)
      var state = stateHook[0]
      var setState = stateHook[1]
      var busyHook = useState('')
      var busy = busyHook[0]
      var setBusy = busyHook[1]
      var msgHook = useState('')
      var message = msgHook[0]
      var setMessage = msgHook[1]
      var errHook = useState('')
      var error = errHook[0]
      var setError = errHook[1]
      var keywordHook = useState('qwen-image')
      var keyword = keywordHook[0]
      var setKeyword = keywordHook[1]
      var resultsHook = useState([])
      var results = resultsHook[0]
      var setResults = resultsHook[1]
      var filesHook = useState(null)
      var files = filesHook[0]
      var setFiles = filesHook[1]
      var folderHook = useState('diffusion_models')
      var folder = folderHook[0]
      var setFolder = folderHook[1]

      function refresh() {
        setError('')
        return call('/state')
          .then(function (json) {
            setState(json)
          })
          .catch(function (e) {
            setError('连不上 DSH 后端：' + e.message)
          })
      }

      useEffect(function () {
        refresh()
      }, [])

      function withBusy(label, task) {
        setBusy(label)
        setError('')
        setMessage('')
        return task()
          .then(function (text) {
            if (text) setMessage(text)
            return refresh()
          })
          .catch(function (e) {
            setError(e.message)
          })
          .then(function () {
            setBusy('')
          })
      }

      function openComfyUI() {
        var base = (state && state.baseUrl) || DEFAULT_BASE
        window.open(base, '_blank', 'noopener')
      }

      function startAndOpen() {
        return withBusy('启动中…', function () {
          return call('/open', {}).then(function (json) {
            if (!json.opened) {
              window.open(json.url, '_blank', 'noopener')
              return 'ComfyUI 已在 ' + json.url + ' 运行；浏览器拦截了自动打开，已改为新标签页打开。'
            }
            return 'ComfyUI 已在 ' + json.url + ' 运行，已用默认浏览器打开。'
          })
        })
      }

      function selectModel(role, name) {
        return withBusy('切换中…', function () {
          return call('/models/select', { role: role, name: name }).then(function (json) {
            return '已切换 ' + role + ' → ' + json.name
          })
        })
      }

      function deleteModelFile(role, name) {
        if (!window.confirm('确定删除这个模型文件？\n' + name)) return Promise.resolve()
        return withBusy('删除中…', function () {
          return call('/models/delete', { role: role, name: name }).then(function (json) {
            return '已删除，释放 ' + json.freedGb + ' GB'
          })
        })
      }

      function search() {
        return withBusy('搜索中…', function () {
          return call('/models/search', { keyword: keyword, limit: 12 }).then(function (json) {
            setResults(json.results || [])
            var notes = (json.errors || []).join('；')
            return '找到 ' + (json.results || []).length + ' 个仓库' + (notes ? '（' + notes + '）' : '')
          })
        })
      }

      function listFiles(repo) {
        return withBusy('读取文件…', function () {
          return call('/models/files', { repo: repo, folder: folder }).then(function (json) {
            setFiles(json)
            return repo + ' / ' + folder + '：' + (json.files || []).length + ' 项'
          })
        })
      }

      function download(file) {
        return withBusy('下载中…（大文件可能要几分钟到几十分钟）', function () {
          return call('/models/download', { url: file.url, folder: folder }).then(function (json) {
            return '已下载 ' + (json.filename || file.name) + '（' + (json.sizeGb || 0) + ' GB），重启 ComfyUI 后可见'
          })
        })
      }

      var running = state && state.running
      var comfy = (state && state.comfy) || null
      var models = (state && state.models) || []

      var statusRow = h(
        'div',
        { style: styles.row },
        h('span', { style: Object.assign({}, styles.badge, { color: running ? '#7ee08a' : '#ffb86b' }) }, running ? '运行中' : '未运行'),
        h('span', { style: styles.mono }, (state && state.baseUrl) || DEFAULT_BASE),
        comfy
          ? h(
              'span',
              { style: styles.sub },
              'ComfyUI ' + comfy.comfyuiVersion + ' · torch ' + comfy.torchVersion + ' · 显存 ' + comfy.vramTotalMb + 'MB（空闲 ' + comfy.vramFreeMb + 'MB）'
            )
          : null
      )

      var buttons = h(
        'div',
        { style: styles.row },
        h('button', { style: styles.primary, onClick: openComfyUI, title: '在新标签页打开 ComfyUI 前端' }, '打开 ComfyUI 前端'),
        h('button', { style: styles.button, onClick: startAndOpen, disabled: Boolean(busy) }, '启动并用默认浏览器打开'),
        h('button', { style: styles.button, onClick: refresh, disabled: Boolean(busy) }, '刷新状态'),
        busy ? h('span', { style: styles.sub }, busy) : null
      )

      var selectedRows = ROLE_ORDER.map(function (role) {
        var folderName = FOLDER_OF_ROLE[role]
        var candidates = models.filter(function (item) {
          return item.folder === folderName
        })
        var current = state && state.selected ? state.selected[role] : null
        var options = [h('option', { key: '__empty', value: '' }, '（未设置）')].concat(
          candidates.map(function (item) {
            return h('option', { key: item.name, value: item.name }, item.name + '  ' + item.sizeGb + 'GB')
          })
        )
        return h(
          'tr',
          { key: role },
          h('td', { style: Object.assign({}, styles.td, styles.mono) }, role),
          h('td', { style: styles.td }, ROLE_LABELS[role] || role),
          h(
            'td',
            { style: styles.td },
            h(
              'select',
              {
                style: styles.input,
                value: current || '',
                onChange: function (event) {
                  if (event.target.value) selectModel(role, event.target.value)
                }
              },
              options
            )
          )
        )
      })

      var modelRows = models.map(function (item, index) {
        return h(
          'tr',
          { key: item.folder + '/' + item.name + '/' + index },
          h('td', { style: Object.assign({}, styles.td, styles.mono) }, item.folder),
          h('td', { style: styles.td }, item.name),
          h('td', { style: styles.td }, item.sizeGb + ' GB'),
          h(
            'td',
            { style: styles.td },
            item.selected
              ? h('span', { style: Object.assign({}, styles.badge, { color: '#7ee08a' }) }, '使用中：' + item.selectedFor.join(','))
              : h('span', { style: styles.badge }, '未使用')
          ),
          h(
            'td',
            { style: styles.td },
            h(
              'button',
              {
                style: styles.button,
                disabled: Boolean(busy) || item.selected,
                title: item.selected ? '正在使用中，先切换再删' : '删除这个文件',
                onClick: function () {
                  deleteModelFile(item.roles[0], item.name)
                }
              },
              '删除'
            )
          )
        )
      })

      var resultRows = results.map(function (entry) {
        return h(
          'tr',
          { key: entry.provider + '/' + entry.id },
          h('td', { style: Object.assign({}, styles.td, styles.mono) }, entry.id),
          h('td', { style: styles.td }, entry.provider),
          h('td', { style: styles.td }, '↓' + entry.downloads),
          h(
            'td',
            { style: styles.td },
            h(
              'button',
              { style: styles.button, onClick: function () { listFiles(entry.id) }, disabled: Boolean(busy) },
              '查看文件'
            ),
            h(
              'a',
              { style: Object.assign({}, styles.button, { marginLeft: '6px', textDecoration: 'none' }), href: entry.url, target: '_blank', rel: 'noreferrer' },
              '仓库页'
            )
          )
        )
      })

      var fileRows = files && files.files
        ? files.files.map(function (file, index) {
            return h(
              'tr',
              { key: file.name + '/' + index },
              h('td', { style: Object.assign({}, styles.td, styles.mono) }, file.name),
              h('td', { style: styles.td }, file.type === 'dir' ? '目录' : (file.sizeGb || 0) + ' GB'),
              h(
                'td',
                { style: styles.td },
                file.type === 'dir'
                  ? h('span', { style: styles.sub }, '点上面的目录名切换 folder 后重查')
                  : h('button', { style: styles.primary, disabled: Boolean(busy), onClick: function () { download(file) } }, '下载到 ' + folder)
              )
            )
          })
        : []

      return h(
        'div',
        { style: styles.root },
        h('div', { style: styles.card }, h('div', { style: styles.title }, 'ComfyUI 服务'), statusRow, h('div', { style: { height: '10px' } }), buttons),
        message ? h('div', { style: styles.msg }, message) : null,
        error ? h('div', { style: styles.err }, error) : null,
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '档位使用的模型'),
          h('table', { style: styles.table }, h('tbody', null, selectedRows)),
          h('div', { style: Object.assign({}, styles.sub, { marginTop: '8px' }) }, '切换后立即写配置，下次出图生效；ComfyUI 需要重启才会扫描到新下载的文件。')
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '本地模型（' + models.length + '）'),
          models.length
            ? h('table', { style: styles.table }, h('tbody', null, modelRows))
            : h('div', { style: styles.sub }, '还没有权重文件。用下面的搜索框找模型。')
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.title }, '搜索并下载模型'),
          h(
            'div',
            { style: styles.row },
            h('input', {
              style: styles.input,
              value: keyword,
              placeholder: '关键词，例如 qwen-image',
              onChange: function (event) { setKeyword(event.target.value) },
              onKeyDown: function (event) { if (event.key === 'Enter') search() }
            }),
            h('input', {
              style: styles.input,
              value: folder,
              placeholder: '目标目录 diffusion_models / text_encoders / vae',
              onChange: function (event) { setFolder(event.target.value) }
            }),
            h('button', { style: styles.primary, onClick: search, disabled: Boolean(busy) }, '搜索'),
            h('button', { style: styles.button, onClick: function () { listFiles(keyword) }, disabled: Boolean(busy) }, '按当前关键词查文件')
          ),
          resultRows.length ? h('table', { style: styles.table }, h('tbody', null, resultRows)) : null,
          fileRows.length ? h('div', { style: { marginTop: '10px' } }, h('table', { style: styles.table }, h('tbody', null, fileRows))) : null,
          h('div', { style: Object.assign({}, styles.sub, { marginTop: '8px' }) }, '下载走 DSH 宿主（不受浏览器跨域限制），写入 ComfyUI 的 models 目录；大文件建议用 Agent 的 image_models 工具在后台跑。')
        )
      )
    }

    var inject = ['slots', 'locale']

    function loadImage(url) {
      return new Promise(function (resolve, reject) {
        var image = new Image()
        image.onload = function () { resolve(image) }
        image.onerror = function () { reject(new Error('图层加载失败')) }
        image.src = url
      })
    }

    /**
     * 图层工作室：把已经画好的一张图拆成 RGBA 层，然后在画布上直接拖。
     *
     * 为什么拆完能拖：每层都是原图尺寸的透明 PNG，层内像素没动过，
     * 移动只是改显示偏移——所以零随机、可撤销，"合回去"也还能对得上原图。
     */
    function LayerStudio(props) {
      var file = props.file
      var capsHook = useState(null)
      var caps = capsHook[0]
      var setCaps = capsHook[1]
      var jobHook = useState(null)
      var job = jobHook[0]
      var setJob = jobHook[1]
      var layerHook = useState([])
      var layers = layerHook[0]
      var setLayers = layerHook[1]
      var selHook = useState(0)
      var selected = selHook[0]
      var setSelected = selHook[1]
      var countHook = useState(4)
      var count = countHook[0]
      var setCount = countHook[1]
      var descHook = useState('')
      var desc = descHook[0]
      var setDesc = descHook[1]
      var noteHook = useState('')
      var note = noteHook[0]
      var setNote = noteHook[1]
      var errHook = useState('')
      var error = errHook[0]
      var setError = errHook[1]

      function api(pathname, body) {
        var options = { headers: { Accept: 'application/json' } }
        if (body !== undefined) {
          options.method = 'POST'
          options.headers['Content-Type'] = 'application/json'
          options.body = JSON.stringify(body)
        }
        return fetch(API + pathname, options).then(function (response) {
          return response.json().then(function (json) {
            if (!json || json.ok === false) throw new Error((json && json.error) || 'HTTP ' + response.status)
            return json
          })
        })
      }

      useEffect(function () {
        api('/layered/capabilities').then(setCaps).catch(function (e) { setError(e.message) })
      }, [])

      useEffect(function () {
        if (!job || job.state !== 'running') return undefined
        var timer = setInterval(function () {
          api('/layered/status?job=' + encodeURIComponent(job.id))
            .then(function (json) {
              if (json.state === 'running') {
                setJob(function (prev) { return Object.assign({}, prev, { elapsedMs: json.elapsedMs }) })
                return
              }
              // 状态接口回的是 jobId（拆层提交时用的是 jobId），这里统一补一个 id：
              // 否则 PSD 导出会拿 undefined 去查任务，服务端只会回 404。
              setJob(Object.assign({}, json, { id: json.jobId }))
              if (json.state === 'done') {
                setLayers(json.bounds.map(function (box, index) {
                  return { index: index, url: json.urls.layerList[index], x: 0, y: 0, scale: 1, visible: true, box: box.box }
                }))
                setNote('拆好了：' + json.metrics.count + ' 层 · ' + (json.metrics.elapsedMs / 1000).toFixed(0) + 's · 合回原图 PSNR '
                  + json.metrics.psnr.toFixed(1) + ' dB / SSIM ' + json.metrics.ssim.toFixed(3))
              } else {
                setError(json.error || '拆层失败')
              }
            })
            .catch(function (e) { setError(e.message) })
        }, 2000)
        return function () { clearInterval(timer) }
      }, [job && job.id, job && job.state])

      function decompose() {
        if (!file) return
        setError('')
        setNote('')
        setLayers([])
        api('/layered/decompose', { file: file, layers: count, prompt: desc })
          .then(function (json) { setJob({ id: json.jobId, state: 'running', elapsedMs: 0 }) })
          .catch(function (e) { setError(e.message) })
      }

      var width = job && job.metrics ? job.metrics.width : 0
      var height = job && job.metrics ? job.metrics.height : 0
      var zoom = width ? Math.min(1, 720 / width) : 1
      var stageW = Math.round(width * zoom)
      var stageH = Math.round(height * zoom)

      function drag(index, event) {
        event.preventDefault()
        var startX = event.clientX
        var startY = event.clientY
        var base = layers[index]
        function move(e) {
          var dx = (e.clientX - startX) / zoom
          var dy = (e.clientY - startY) / zoom
          setLayers(function (prev) {
            return prev.map(function (layer, i) {
              return i === index ? Object.assign({}, base, { x: base.x + dx, y: base.y + dy }) : layer
            })
          })
        }
        function up() {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      function update(index, patch) {
        setLayers(function (prev) {
          return prev.map(function (layer, i) { return i === index ? Object.assign({}, layer, patch) : layer })
        })
      }

      function move(index, delta) {
        var target = index + delta
        if (target < 0 || target >= layers.length) return
        setLayers(function (prev) {
          var next = prev.slice()
          var tmp = next[index]
          next[index] = next[target]
          next[target] = tmp
          return next
        })
        setSelected(target)
      }

      function exportPng() {
        if (!width) return
        var canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        var ctx = canvas.getContext('2d')
        Promise.all(layers.map(function (layer) { return loadImage(layer.url) }))
          .then(function (images) {
            layers.forEach(function (layer, i) {
              if (!layer.visible) return
              ctx.save()
              ctx.translate(layer.x + width / 2, layer.y + height / 2)
              ctx.scale(layer.scale, layer.scale)
              ctx.drawImage(images[i], -width / 2, -height / 2, width, height)
              ctx.restore()
            })
            var link = document.createElement('a')
            link.href = canvas.toDataURL('image/png')
            link.download = 'layered-' + Date.now() + '.png'
            link.click()
          })
          .catch(function (e) { setError(e.message) })
      }

      /** 导出 PSD：把当前摆放（位移/缩放/显隐/层序）交给服务端重新栅格化，每层可单独拖。 */
      function exportPsd() {
        if (!job || !width) return
        var jobId = job.id || job.jobId
        if (!jobId) { setError('任务状态还没同步好，稍等一秒再导出'); return }
        fetch(API + '/layered/psd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job: jobId,
            layers: layers.map(function (layer) {
              return {
                index: layer.index,
                x: layer.x,
                y: layer.y,
                scale: layer.scale,
                visible: layer.visible,
                name: '图层 ' + (layer.index + 1)
              }
            })
          })
        })
          .then(function (response) {
            if (response.ok) return response.blob()
            return response.json().then(function (json) { throw new Error((json && json.error) || 'HTTP ' + response.status) })
          })
          .then(function (blob) {
            var url = URL.createObjectURL(blob)
            var link = document.createElement('a')
            link.href = url
            link.download = 'layered-' + Date.now() + '.psd'
            link.click()
            setTimeout(function () { URL.revokeObjectURL(url) }, 4000)
          })
          .catch(function (e) { setError(e.message) })
      }

      var missing = caps ? ['unet', 'clip', 'vae'].filter(function (role) { return !caps[role].present }) : []
      var current = layers[selected]

      var list = layers.map(function (layer, index) {
        var active = index === selected
        return h(
          'div',
          {
            key: layer.index,
            onClick: function () { setSelected(index) },
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '5px 8px',
              borderRadius: '7px',
              cursor: 'pointer',
              background: active ? 'rgba(90,140,255,0.16)' : 'transparent',
              border: '1px solid ' + (active ? 'rgba(90,140,255,0.55)' : 'transparent')
            }
          },
          h('img', {
            src: layer.url,
            style: { width: '38px', height: '38px', objectFit: 'contain', background: 'rgba(127,127,127,0.12)', borderRadius: '5px' }
          }),
          h('span', { style: { fontSize: '12px', flex: 1 } }, '图层 ' + (index + 1)),
          h('button', {
            title: '显示/隐藏',
            style: Object.assign({}, styles.button, { padding: '1px 6px', fontSize: '11px' }),
            onClick: function (event) { event.stopPropagation(); update(index, { visible: !layer.visible }) }
          }, layer.visible ? '隐' : '显'),
          h('button', {
            title: '上移一层',
            style: Object.assign({}, styles.button, { padding: '1px 6px', fontSize: '11px' }),
            onClick: function (event) { event.stopPropagation(); move(index, 1) }
          }, '↑'),
          h('button', {
            title: '下移一层',
            style: Object.assign({}, styles.button, { padding: '1px 6px', fontSize: '11px' }),
            onClick: function (event) { event.stopPropagation(); move(index, -1) }
          }, '↓')
        )
      })

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h(
          'div',
          { style: Object.assign({}, styles.row, { gap: '8px' }) },
          h('span', { style: styles.sub }, '拆几张'),
          h(
            'select',
            { value: String(count), onChange: function (event) { setCount(Number(event.target.value)) }, style: Object.assign({}, styles.input, { minWidth: '80px' }) },
            [3, 4, 5, 6, 8].map(function (n) { return h('option', { key: n, value: String(n) }, n + ' 层') })
          ),
          h('input', {
            value: desc,
            onChange: function (event) { setDesc(event.target.value) },
            placeholder: '这张图画的是什么（可不填，填了更准）',
            style: Object.assign({}, styles.input, { flex: 1, minWidth: '180px' })
          }),
          h('button', {
            style: styles.primary,
            disabled: !file || !caps || missing.length > 0 || Boolean(job && job.state === 'running'),
            onClick: decompose
          }, job && job.state === 'running' ? '拆层中…' : '拆成图层')
        ),
        !file
          ? h('div', { style: styles.sub }, '先在「画图」页生成一张，再回来拆层。')
          : null,
        missing.length
          ? h('div', { style: styles.err }, '还缺权重：' + missing.join(' / ') + ' —— 下载完再试（首张要装进显存，约 1–3 分钟）')
          : null,
        job && job.state === 'running'
          ? h('div', { style: styles.msg }, '正在拆：' + Math.round((job.elapsedMs || 0) / 1000) + ' 秒（本机 16GB 显存，640px 大约 2–6 分钟）')
          : null,
        note ? h('div', { style: styles.msg }, note) : null,
        error ? h('div', { style: styles.err }, error) : null,
        layers.length
          ? h(
              'div',
              { style: { display: 'flex', gap: '12px', alignItems: 'flex-start' } },
              h(
                'div',
                {
                  style: {
                    position: 'relative',
                    width: stageW + 'px',
                    height: stageH + 'px',
                    flex: 'none',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    backgroundImage:
                      'linear-gradient(45deg, rgba(127,127,127,0.18) 25%, transparent 25%, transparent 75%, rgba(127,127,127,0.18) 75%),'
                      + 'linear-gradient(45deg, rgba(127,127,127,0.18) 25%, transparent 25%, transparent 75%, rgba(127,127,127,0.18) 75%)',
                    backgroundSize: '16px 16px',
                    backgroundPosition: '0 0, 8px 8px'
                  }
                },
                layers.map(function (layer, index) {
                  var hidden = !layer.visible
                  return h('img', {
                    key: layer.index,
                    src: layer.url,
                    draggable: false,
                    onMouseDown: hidden ? undefined : function (event) { setSelected(index); drag(index, event) },
                    style: {
                      position: 'absolute',
                      left: 0,
                      top: 0,
                      width: stageW + 'px',
                      height: stageH + 'px',
                      zIndex: index + 1,
                      opacity: hidden ? 0 : 1,
                      cursor: hidden ? 'default' : 'grab',
                      transform: 'translate(' + layer.x * zoom + 'px,' + layer.y * zoom + 'px)'
                    }
                  })
                })
              ),
              h(
                'div',
                { style: { flex: 1, minWidth: '220px', display: 'flex', flexDirection: 'column', gap: '8px' } },
                h('div', { style: Object.assign({}, styles.sub) }, '拖动画布里的对象换位置；上面「↑ ↓」改前后遮挡。'),
                h('div', { style: { maxHeight: '300px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' } }, list),
                current
                  ? h(
                      'div',
                      { style: Object.assign({}, styles.row, { gap: '8px' }) },
                      h('span', { style: styles.sub }, '大小'),
                      h('input', {
                        type: 'range',
                        min: '0.3',
                        max: '2.2',
                        step: '0.02',
                        value: String(current.scale),
                        onChange: function (event) { update(selected, { scale: Number(event.target.value) }) },
                        style: { flex: 1 }
                      }),
                      h('button', {
                        style: styles.button,
                        onClick: function () { update(selected, { x: 0, y: 0, scale: 1 }) }
                      }, '复位')
                    )
                  : null,
                h(
                  'div',
                  { style: Object.assign({}, styles.row, { gap: '8px' }) },
                  h('button', { style: styles.primary, onClick: exportPng }, '导出这一版 PNG'),
                  h('button', { style: styles.button, onClick: exportPsd }, '导出 PSD（分层）')
                )
              )
            )
          : null
      )
    }

    /**
     * 画图面板：提示词输入 + 生成 + 结果展示 + 模型列表/下载。
     * 点顶部「画图」按钮打开；系统级操作（启动 ComfyUI / 调默认浏览器）走宿主接口。
     */
    function DrawPanel(props) {
      var onClose = props.onClose
      var stateHook = useState(null)
      var state = stateHook[0]
      var setState = stateHook[1]
      var promptHook = useState('')
      var prompt = promptHook[0]
      var setPrompt = promptHook[1]
      var presetHook = useState('fast')
      var preset = presetHook[0]
      var setPreset = presetHook[1]
      var busyHook = useState('')
      var busy = busyHook[0]
      var setBusy = busyHook[1]
      var msgHook = useState('')
      var message = msgHook[0]
      var setMessage = msgHook[1]
      var errHook = useState('')
      var error = errHook[0]
      var setError = errHook[1]
      var resultHook = useState(null)
      var result = resultHook[0]
      var setResult = resultHook[1]
      var modelsHook = useState(null)
      var models = modelsHook[0]
      var setModels = modelsHook[1]
      var tabHook = useState('draw')
      var tab = tabHook[0]
      var setTab = tabHook[1]
      var keywordHook = useState('qwen-image')
      var keyword = keywordHook[0]
      var setKeyword = keywordHook[1]
      var hitsHook = useState([])
      var hits = hitsHook[0]
      var setHits = hitsHook[1]
      var filesHook = useState(null)
      var files = filesHook[0]
      var setFiles = filesHook[1]
      var folderHook = useState('diffusion_models')
      var folder = folderHook[0]
      var setFolder = folderHook[1]

      function callJson(pathname, body) {
        var options = { headers: { Accept: 'application/json' } }
        if (body !== undefined) {
          options.method = 'POST'
          options.headers['Content-Type'] = 'application/json'
          options.body = JSON.stringify(body)
        }
        return fetch(API + pathname, options).then(function (response) {
          return response.json().then(function (json) {
            if (!json || json.ok === false) throw new Error((json && json.error) || 'HTTP ' + response.status)
            return json
          })
        })
      }

      function refresh() {
        return callJson('/state')
          .then(function (json) {
            setState(json)
          })
          .catch(function (e) {
            setError('连不上宿主接口：' + e.message)
          })
          .then(function () { return callJson('/models') })
          .then(function (json) { setModels(json) })
          .catch(function () {})
      }

      useEffect(function () {
        refresh()
      }, [])

      function run(label, task) {
        setBusy(label)
        setError('')
        setMessage('')
        return task()
          .catch(function (e) { setError(e.message) })
          .then(function () { setBusy('') })
      }

      function generate() {
        if (!prompt.trim()) { setError('先输入画面描述'); return }
        return run('生成中…（首次要装权重，约 30–90 秒）', function () {
          return callJson('/generate', { prompt: prompt.trim(), preset: preset }).then(function (json) {
            setResult(json)
            setMessage('生成完成：' + json.width + '×' + json.height + ' / ' + (json.durationMs / 1000).toFixed(1) + 's')
          })
        })
      }

      function openComfyUI() {
        return run('启动中…', function () {
          return callJson('/open', {}).then(function (json) {
            if (!json.opened) window.open(json.url, '_blank', 'noopener')
            setMessage('ComfyUI 前端：' + json.url)
          })
        })
      }

      function selectModel(role, name) {
        return run('切换中…', function () {
          return callJson('/models/select', { role: role, name: name }).then(function (json) {
            setMessage('已切换 ' + role + ' → ' + json.name)
            return refresh()
          })
        })
      }

      function removeModel(role, name) {
        if (!window.confirm('确定删除模型文件？\n' + name)) return Promise.resolve()
        return run('删除中…', function () {
          return callJson('/models/delete', { role: role, name: name }).then(function (json) {
            setMessage('已删除，释放 ' + json.freedGb + ' GB')
            return refresh()
          })
        })
      }

      function search() {
        return run('搜索中…', function () {
          return callJson('/models/search', { keyword: keyword, limit: 10 }).then(function (json) {
            setHits(json.results || [])
            var notes = (json.errors || []).join('；')
            setMessage('找到 ' + (json.results || []).length + ' 个仓库' + (notes ? '（' + notes + '）' : ''))
          })
        })
      }

      function listFiles(repo) {
        return run('读取文件…', function () {
          return callJson('/models/files', { repo: repo, folder: folder }).then(function (json) {
            setFiles(json)
            setMessage(repo + ' / ' + folder + '：' + (json.files || []).length + ' 项')
          })
        })
      }

      function download(file) {
        return run('下载中…（大文件要几分钟）', function () {
          return callJson('/models/download', { url: file.url, folder: folder }).then(function (json) {
            setMessage('已下载 ' + (json.filename || file.name) + '（' + (json.sizeGb || 0) + ' GB），重启 ComfyUI 后可见')
          })
        })
      }

      var panelStyle = {
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }
      var cardStyle = {
        width: 'min(920px, 94vw)',
        maxHeight: '88vh',
        overflow: 'auto',
        background: 'var(--dsh-background, #fff)',
        color: 'var(--dsh-foreground, #111)',
        borderRadius: '12px',
        boxShadow: '0 18px 50px rgba(0,0,0,0.35)',
        padding: '16px 18px',
        fontFamily: 'inherit'
      }
      var tabBtn = function (active) {
        return {
          border: 'none',
          borderBottom: active ? '2px solid #5a8cff' : '2px solid transparent',
          background: 'transparent',
          color: 'inherit',
          padding: '6px 10px',
          cursor: 'pointer',
          fontWeight: active ? 600 : 400
        }
      }
      var actionBtn = {
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '8px',
        padding: '6px 12px',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '13px'
      }
      var primaryBtn = {
        border: '1px solid rgba(90,140,255,0.75)',
        background: 'rgba(90,140,255,0.16)',
        borderRadius: '8px',
        padding: '8px 18px',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '14px',
        fontWeight: 600
      }
      var inputStyle = {
        border: '1px solid rgba(127,127,127,0.35)',
        borderRadius: '8px',
        padding: '6px 10px',
        background: 'transparent',
        color: 'inherit',
        fontSize: '13px'
      }
      var tdStyle = { padding: '4px 8px', borderBottom: '1px solid rgba(127,127,127,0.15)', verticalAlign: 'middle' }

      var selectedRows = models && models.items
        ? models.items.map(function (item, index) {
            var roleCandidates = item.folder === 'vae' ? ['vae'] : item.folder === 'text_encoders' ? ['clip', 'clipLean'] : ['unet', 'unetTurbo']
            return h(
              'tr',
              { key: item.folder + item.name + index },
              h('td', { style: Object.assign({}, tdStyle, styles.mono) }, item.folder),
              h('td', { style: tdStyle }, item.name),
              h('td', { style: tdStyle }, item.sizeGb + ' GB'),
              h(
                'td',
                { style: tdStyle },
                item.selected
                  ? h('span', { style: Object.assign({}, styles.badge, { color: '#2f9e44' }) }, '使用中：' + item.selectedFor.join(','))
                  : roleCandidates.map(function (role) {
                      return h(
                        'button',
                        { key: role, style: Object.assign({}, actionBtn, { marginRight: '6px', padding: '2px 8px' }), disabled: Boolean(busy), onClick: function () { selectModel(role, item.name) } },
                        '设为 ' + role
                      )
                    })
              ),
              h(
                'td',
                { style: tdStyle },
                h('button', { style: Object.assign({}, actionBtn, { padding: '2px 8px' }), disabled: Boolean(busy) || item.selected, onClick: function () { removeModel(roleCandidates[0], item.name) } }, '删除')
              )
            )
          })
        : []

      var hitRows = hits.map(function (entry) {
        return h(
          'tr',
          { key: entry.provider + entry.id },
          h('td', { style: Object.assign({}, tdStyle, styles.mono) }, entry.id),
          h('td', { style: tdStyle }, '↓' + entry.downloads),
          h(
            'td',
            { style: tdStyle },
            h('button', { style: Object.assign({}, actionBtn, { padding: '2px 8px' }), disabled: Boolean(busy), onClick: function () { listFiles(entry.id) } }, '查看文件')
          )
        )
      })

      var fileRows = files && files.files
        ? files.files
            .filter(function (file) { return file.type === 'file' })
            .map(function (file, index) {
              return h(
                'tr',
                { key: file.name + index },
                h('td', { style: Object.assign({}, tdStyle, styles.mono) }, file.name),
                h('td', { style: tdStyle }, (file.sizeGb || 0) + ' GB'),
                h(
                  'td',
                  { style: tdStyle },
                  h('button', { style: Object.assign({}, primaryBtn, { padding: '3px 10px', fontSize: '12px' }), disabled: Boolean(busy), onClick: function () { download(file) } }, '下载')
                )
              )
            })
        : []

      var drawView = h(
        'div',
        null,
        h('div', { style: styles.sub }, '画面描述（中文/英文都行）'),
        h('textarea', {
          value: prompt,
          rows: 4,
          placeholder: '例如：赛璐璐风格插画，一只戴着头盔的柯基宇航员，纯色背景，粗黑描边',
          onChange: function (event) { setPrompt(event.target.value) },
          style: Object.assign({}, inputStyle, { width: '100%', marginTop: '6px', resize: 'vertical', fontFamily: 'inherit' })
        }),
        h(
          'div',
          { style: Object.assign({}, styles.row, { marginTop: '10px' }) },
          h('span', { style: styles.sub }, '档位'),
          h(
            'select',
            { value: preset, onChange: function (event) { setPreset(event.target.value) }, style: inputStyle },
            ['fast', 'standard', 'turbo', 'quality', 'transparent'].map(function (name) {
              return h('option', { key: name, value: name }, name)
            })
          ),
          h('button', { style: primaryBtn, disabled: Boolean(busy), onClick: generate }, busy ? busy : '生成图片'),
          h('button', { style: Object.assign({}, actionBtn, { marginLeft: 'auto' }), disabled: Boolean(busy), onClick: openComfyUI }, '打开 ComfyUI 前端')
        ),
        result
          ? h(
              'div',
              { style: { marginTop: '14px' } },
              h('img', {
                src: result.url,
                alt: '生成结果',
                style: { maxWidth: '100%', borderRadius: '10px', border: '1px solid rgba(127,127,127,0.25)' }
              }),
              h(
                'div',
                { style: Object.assign({}, styles.sub, { marginTop: '6px' }) },
                'seed=' + result.seed + ' · ' + result.preset + ' · ' + result.steps + ' 步 · ' + (result.durationMs / 1000).toFixed(1) + 's · ' + result.width + '×' + result.height
              )
            )
          : h('div', { style: Object.assign({}, styles.sub, { marginTop: '14px' }) }, '生成的图片会显示在这里')
      )

      var modelsView = h(
        'div',
        null,
        h('div', { style: styles.sub }, '当前选中：' + (state && state.selected ? Object.keys(state.selected).map(function (role) { return role + '=' + (state.selected[role] || '未设置') }).join('  ') : '') ),
        h(
          'table',
          { style: Object.assign({}, styles.table, { marginTop: '8px' }) },
          h('tbody', null, selectedRows.length ? selectedRows : h('tr', null, h('td', { style: styles.sub }, '本地还没有模型，先下载')))
        ),
        h('div', { style: { marginTop: '16px', borderTop: '1px solid rgba(127,127,127,0.2)', paddingTop: '12px' } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '下载模型'),
          h(
            'div',
            { style: styles.row },
            h('input', { value: keyword, onChange: function (event) { setKeyword(event.target.value) }, placeholder: '关键词，例如 qwen-image', style: Object.assign({}, inputStyle, { minWidth: '220px' }) }),
            h('span', { style: styles.sub }, '目标目录'),
            h(
              'select',
              { value: folder, onChange: function (event) { setFolder(event.target.value) }, style: inputStyle },
              ['diffusion_models', 'text_encoders', 'vae'].map(function (name) { return h('option', { key: name, value: name }, name) })
            ),
            h('button', { style: primaryBtn, disabled: Boolean(busy), onClick: search }, '搜索仓库')
          ),
          h('table', { style: Object.assign({}, styles.table, { marginTop: '8px' }) }, h('tbody', null, hitRows)),
          fileRows.length ? h('table', { style: Object.assign({}, styles.table, { marginTop: '8px' }) }, h('tbody', null, fileRows)) : null
        )
      )

      return h(
        'div',
        { style: panelStyle, onClick: function (event) { if (event.target === event.currentTarget) onClose() } },
        h(
          'div',
          { style: cardStyle },
          h(
            'div',
            { style: Object.assign({}, styles.row, { justifyContent: 'space-between' }) },
            h('div', { style: { fontSize: '16px', fontWeight: 700 } }, 'Qwen-Image 画图'),
            h('button', { style: actionBtn, onClick: onClose }, '关闭')
          ),
          h(
            'div',
            { style: { margin: '8px 0 12px 0', borderBottom: '1px solid rgba(127,127,127,0.2)' } },
            h('button', { style: tabBtn(tab === 'draw'), onClick: function () { setTab('draw') } }, '画图'),
            h('button', { style: tabBtn(tab === 'layers'), onClick: function () { setTab('layers') } }, '图层'),
            h('button', { style: tabBtn(tab === 'models'), onClick: function () { setTab('models') } }, '模型')
          ),
          message ? h('div', { style: styles.msg }, message) : null,
          error ? h('div', { style: styles.err }, error) : null,
          tab === 'draw'
            ? drawView
            : tab === 'layers'
              ? h(LayerStudio, { file: result && result.file })
              : modelsView
        )
      )
    }

    /** 顶部「画图」按钮：点击打开画图面板 */
    function HeaderAction() {
      var openHook = useState(false)
      var open = openHook[0]
      var setOpen = openHook[1]
      return h(
        'span',
        null,
        h(
          'button',
          {
            onClick: function () { setOpen(true) },
            title: '打开画图面板（模型管理 + 生成图片）',
            style: {
              border: '1px solid rgba(127,127,127,0.35)',
              borderRadius: '6px',
              padding: '3px 10px',
              marginRight: '6px',
              background: 'transparent',
              color: 'inherit',
              fontSize: '12px',
              cursor: 'pointer'
            }
          },
          '画图'
        ),
        open ? h(DrawPanel, { onClose: function () { setOpen(false) } }) : null
      )
    }

    function apply(ctx) {
      // 字典（和 @nanmicoder/dsh-agent-teams 一样：slot 注册时带 locale 命名空间）
      try {
        ctx.effect(function () {
          return ctx.locale.register('image-generation-ks', {
            zh: { open: '画图', settings: '图像生成 (KS)', busy: '启动中…' },
            en: { open: 'Draw', settings: 'Image Generation (KS)', busy: 'Starting…' }
          })
        }, 'image-generation-ks: dictionaries')
      } catch (error) {
        if (typeof console !== 'undefined') console.warn('[image-generation-ks] 注册字典失败', error)
      }

      ctx.slots.inject('settings.section', function () {
        try {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'ks-image-generation',
              order: 120,
              locale: 'image-generation-ks',
              label: function () {
                return '图像生成 (KS)'
              }
            },
            Section
          )
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[image-generation-ks] 注册设置页失败', error)
          return function () {}
        }
      })

      // 与 @nanmicoder/dsh-agent-teams 相同：注册到「会话标题旁的操作区」，确保界面可见
      ctx.slots.inject('conversation.session.header.actions', function () {
        try {
          return ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'ks-image-open',
              order: 50,
              locale: 'image-generation-ks'
            },
            HeaderAction
          )
        } catch (error) {
          if (typeof console !== 'undefined') console.warn('[image-generation-ks] 注册画图按钮失败', error)
          return function () {}
        }
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
