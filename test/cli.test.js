import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { PNG } from 'pngjs'
import { callModel } from '../src/ai.js'
import { runCli } from '../src/cli.js'
import { createStandaloneCtx, resolveStandaloneLlmConfig } from '../src/cli-llm.js'
import { Store } from '../src/store.js'

const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN_PATH = join(ROOT, 'bin', 'wechat-studio.js')

function sseResponse(chunks) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}

function makeIo(extra = {}) {
  let out = ''
  let err = ''
  return {
    stdout: { write(s) { out += String(s) } },
    stderr: { write(s) { err += String(s) } },
    env: {},
    fetchImpl: async () => { throw new Error('unexpected fetch') },
    ...extra,
    read() { return { out, err } },
  }
}

function makeMockCtx(replyText) {
  const reply = typeof replyText === 'function' ? replyText : () => replyText
  return {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) }
      if (name === 'llm') {
        return {
          async prepareCall(_opts, _sig, cb) {
            const controls = {
              config: {},
              async *stream(req) {
                yield { type: 'text-delta', text: String(reply(req)) }
                yield { type: 'finish', reason: { kind: 'stop' } }
              },
            }
            return typeof cb === 'function' ? cb(controls) : controls
          },
        }
      }
      return null
    },
  }
}

function makePngBuffer(width = 400, height = 200) {
  const png = new PNG({ width, height })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 40
    png.data[i + 1] = 120
    png.data[i + 2] = 90
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

test('resolveStandaloneLlmConfig 优先使用显式参数，再回退环境变量', () => {
  const oaKey = ['OPENAI', 'API', 'KEY'].join('_')
  const oaBase = ['OPENAI', 'BASE', 'URL'].join('_')
  const oaModel = ['OPENAI', 'MODEL'].join('_')
  const wsKey = ['WECHAT', 'STUDIO', 'API', 'KEY'].join('_')
  const wsBase = ['WECHAT', 'STUDIO', 'BASE', 'URL'].join('_')
  const wsModel = ['WECHAT', 'STUDIO', 'MODEL'].join('_')

  const fromOpenAi = resolveStandaloneLlmConfig({
    [oaKey]: 'k-oa',
    [oaBase]: 'https://api.deepseek.com/v1/',
    [oaModel]: 'gpt-test',
  })
  assert.equal(fromOpenAi.apiKey, 'k-oa')
  assert.equal(fromOpenAi.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(fromOpenAi.model, 'gpt-test')

  const fromStudio = resolveStandaloneLlmConfig({
    [oaKey]: 'k-oa',
    [wsKey]: 'k-studio',
    [wsBase]: 'http://localhost:8080/v1',
    [wsModel]: 'deepseek-chat',
  }, { model: 'override-model' })
  assert.equal(fromStudio.apiKey, 'k-studio')
  assert.equal(fromStudio.baseUrl, 'http://localhost:8080/v1')
  assert.equal(fromStudio.model, 'override-model')
})

test('createStandaloneCtx 支持 SSE 分片流式响应并与 callModel 兼容', async () => {
  let captured = null
  const fetchImpl = async (url, init) => {
    captured = { url, headers: init.headers, body: JSON.parse(init.body) }
    return sseResponse([
      'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"好，"}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"公众号"}}]}\n\ndata: [DONE]\n\n',
    ])
  }
  const ctx = createStandaloneCtx({
    apiKey: 'demo-credential-123',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'demo-model',
    fetchImpl,
  })
  const deltas = []
  const text = await callModel(ctx, {
    system: '系统指令',
    user: '用户输入',
    task: 'cli-test',
    maxTokens: 1200,
    onText: delta => deltas.push(delta),
  })
  assert.equal(text, '你好，公众号')
  assert.deepEqual(deltas, ['你', '好，', '公众号'])
  assert.equal(captured.url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(captured.body.model, 'demo-model')
  assert.equal(captured.body.max_tokens, 1200)
  assert.equal(captured.body.stream, true)
  assert.deepEqual(captured.body.messages, [
    { role: 'system', content: '系统指令' },
    { role: 'user', content: '用户输入' },
  ])
})

test('createStandaloneCtx 支持非流式 JSON 响应回退', async () => {
  const fetchImpl = async () => Response.json({
    choices: [{ message: { content: '{"ok":true}' } }],
  })
  const ctx = createStandaloneCtx({
    apiKey: 'demo-credential-123',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'demo-model',
    fetchImpl,
  })
  const text = await callModel(ctx, { system: 'sys', user: 'usr', task: 'json-fallback' })
  assert.equal(text, '{"ok":true}')
})

test('createStandaloneCtx 缺少密钥时报错且不发起请求，错误响应不泄漏密钥', async () => {
  let called = false
  const noKeyCtx = createStandaloneCtx({
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'demo-model',
    fetchImpl: async () => { called = true; return Response.json({}) },
  })
  await assert.rejects(
    callModel(noKeyCtx, { system: 'sys', user: 'usr', task: 'no-key' }),
    /API Key|密钥/,
  )
  assert.equal(called, false)

  const credential = 'demo-private-value-999'
  const errCtx = createStandaloneCtx({
    apiKey: credential,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'demo-model',
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: `bad credential ${credential}` } }), { status: 401 }),
  })
  await assert.rejects(
    callModel(errCtx, { system: 'sys', user: 'usr', task: 'auth-err' }),
    err => {
      assert.doesNotMatch(err.message, /demo-private-value-999/)
      assert.match(err.message, /401|鉴权/)
      return true
    },
  )
})

test('createStandaloneCtx 透传 AbortSignal 中断请求', async () => {
  const controller = new AbortController()
  const ctx = createStandaloneCtx({
    apiKey: 'demo-credential-123',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'demo-model',
    fetchImpl: async (_url, init) => {
      assert.equal(init.signal, controller.signal)
      controller.abort()
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    },
  })
  await assert.rejects(
    callModel(ctx, { system: 'sys', user: 'usr', task: 'abort-test', signal: controller.signal }),
    err => err.name === 'AbortError' || /中断|aborted/i.test(err.message),
  )
})

test('CLI 框架：--help、--version、未知命令与 --json 错误退出码 2', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))

  const helpIo = makeIo()
  assert.equal(await runCli(['--help'], helpIo), 0)
  for (const cmd of ['layout', 'detect', 'svg-card', 'articles', 'insights', 'style', 'cover']) {
    assert.match(helpIo.read().out, new RegExp(cmd))
  }

  const verIo = makeIo()
  assert.equal(await runCli(['--version', '--json'], verIo), 0)
  assert.deepEqual(JSON.parse(verIo.read().out), { ok: true, version: pkg.version })

  const badCmdIo = makeIo()
  assert.equal(await runCli(['nonexistent', '--json'], badCmdIo), 2)
  const badParsed = JSON.parse(badCmdIo.read().out)
  assert.equal(badParsed.ok, false)
  assert.equal(badParsed.code, 'USAGE')
  assert.equal(badCmdIo.read().err, '')

  const badFlagIo = makeIo()
  assert.equal(await runCli(['layout', 'a.md', '--unknown-flag', '--json'], badFlagIo), 2)
  assert.equal(JSON.parse(badFlagIo.read().out).code, 'USAGE')
})

test('package.json 同时保留 DSH 插件配置与 CLI bin 入口', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.main, 'src/host.js')
  assert.equal(pkg.exports['.'], './src/host.js')
  assert.equal(pkg.exports['./client'], './dist/client.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.bin['wechat-studio'], './bin/wechat-studio.js')
  assert.ok(pkg.files.includes('bin'))
  assert.ok(pkg.files.includes('dist'))
  assert.ok(pkg.files.includes('src'))
})

test('离线确定性子命令：layout、svg-card、articles、insights', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-cli-offline-'))
  try {
    const mdPath = join(dir, 'sample.md')
    const outHtml = join(dir, 'out.html')
    await writeFile(mdPath, '# 测试文章标题\n\n第一段正文内容，用来验证排版和导入。\n\n## 小节\n\n第二段正文内容。\n', 'utf8')

    // layout
    const layoutIo = makeIo()
    assert.equal(await runCli(['layout', mdPath, '--style', 'neo', '--theme', 'forest', '--out', outHtml, '--data-dir', dir, '--json'], layoutIo), 0)
    const layoutRes = JSON.parse(layoutIo.read().out)
    assert.equal(layoutRes.ok, true)
    assert.equal(layoutRes.style, 'neo')
    assert.equal(layoutRes.theme, 'forest')
    assert.equal(layoutRes.out, outHtml)
    assert.match(await readFile(outHtml, 'utf8'), /测试文章标题/)

    // layout invalid style & extra positional -> exit 2
    const badStyleIo = makeIo()
    assert.equal(await runCli(['layout', mdPath, '--style', 'invalid-style', '--json'], badStyleIo), 2)
    const extraArgIo = makeIo()
    assert.equal(await runCli(['layout', mdPath, 'extra.md', '--json'], extraArgIo), 2)
    assert.equal(JSON.parse(extraArgIo.read().out).code, 'USAGE')

    // svg-card & invalid kind -> exit 2
    const badSvgIo = makeIo()
    assert.equal(await runCli(['svg-card', 'not-a-kind', '--title', '测试', '--line', '一条', '--json'], badSvgIo), 2)
    assert.equal(JSON.parse(badSvgIo.read().out).code, 'USAGE')

    const svgIo = makeIo()
    assert.equal(await runCli(['svg-card', 'svg-steps', '--title', '写作流程', '--line', '收集素材', '--line', '起草改稿', '--json'], svgIo), 0)
    const svgRes = JSON.parse(svgIo.read().out)
    assert.equal(svgRes.ok, true)
    assert.match(svgRes.html, /<svg\b/)
    assert.match(svgRes.html, /<animate/)

    // articles import -> list -> get -> verify Store compatibility
    const importIo = makeIo()
    assert.equal(await runCli(['articles', 'import', mdPath, '--data-dir', dir, '--json'], importIo), 0)
    const imported = JSON.parse(importIo.read().out)
    assert.equal(imported.ok, true)
    assert.equal(imported.title, '测试文章标题')

    // 全局选项放在二级子命令前也能正常解析
    const listIo = makeIo()
    assert.equal(await runCli(['articles', '--json', '--data-dir', dir, 'list'], listIo), 0)
    const listed = JSON.parse(listIo.read().out)
    assert.equal(listed.count, 1)
    assert.equal(listed.articles[0].id, imported.id)

    const getIo = makeIo()
    assert.equal(await runCli(['articles', 'get', imported.id, '--data-dir', dir, '--json'], getIo), 0)
    const got = JSON.parse(getIo.read().out)
    assert.match(got.markdown, /测试文章标题/)

    const store = new Store(dir)
    const diskState = await store.read()
    assert.equal(diskState.articles.length, 1)
    assert.equal(diskState.currentId, imported.id)

    // insights summary on empty workspace
    const insIo = makeIo()
    assert.equal(await runCli(['insights', 'summary', '--data-dir', dir, '--json'], insIo), 0)
    const insRes = JSON.parse(insIo.read().out)
    assert.equal(insRes.ok, true)
    assert.equal(insRes.hasData, false)

    // insights import with valid WeChat growth HTML-table fixture
    const xlsPath = join(dir, 'growth.xls')
    await writeFile(xlsPath, '<table><tr><td>时间</td><td>新关注人数</td></tr><tr><td>2026-11-18</td><td>15</td></tr></table>', 'utf8')
    const insImportIo = makeIo()
    assert.equal(await runCli(['insights', 'import', xlsPath, '--data-dir', dir, '--json'], insImportIo), 0)
    const insImportRes = JSON.parse(insImportIo.read().out)
    assert.equal(insImportRes.ok, true)
    assert.equal(insImportRes.importedKind, 'growth')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('外部 API 子命令：detect 与 cover（--prompt-only 及完整生成）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-cli-api-'))
  try {
    const mdPath = join(dir, 'post.md')
    await writeFile(mdPath, '# 为什么本地工具更好用\n\n本地优先的工作流不需要来回粘贴，效率高很多。\n', 'utf8')

    // detect missing key -> exit 2
    const noKeyDetectIo = makeIo()
    assert.equal(await runCli(['detect', mdPath, '--data-dir', dir, '--json'], noKeyDetectIo), 2)

    // detect with key + mock fetch
    const zqKeyName = ['ZHUQUE', 'API', 'KEY'].join('_')
    const detectIo = makeIo({
      env: { [zqKeyName]: 'zq-private-token-xyz' },
      fetchImpl: async () => Response.json({
        status: 'success',
        labels_ratio: { 0: 0.7, 1: 0.2, 2: 0.1 },
        segment_labels: [{ order: 0, text: '本地优先的工作流不需要来回粘贴，效率高很多。', label: 1, conf: 0.88 }],
        usage: { total_tokens: 42 },
      }),
    })
    assert.equal(await runCli(['detect', mdPath, '--data-dir', dir, '--json'], detectIo), 0)
    const detectOut = detectIo.read().out
    assert.doesNotMatch(detectOut, /zq-private-token-xyz/)
    const detectRes = JSON.parse(detectOut)
    assert.equal(detectRes.ok, true)
    assert.equal(detectRes.flagged.length, 1)
    assert.equal(detectRes.tokens, 42)

    // cover --prompt-only：零模型 Key、零生图 Key 也能直接输出模板与槽位
    const coverPromptIo = makeIo()
    assert.equal(await runCli(['cover', mdPath, '--style', 'felt', '--prompt-only', '--data-dir', dir, '--json'], coverPromptIo), 0)
    const coverPromptRes = JSON.parse(coverPromptIo.read().out)
    assert.equal(coverPromptRes.ok, true)
    assert.equal(coverPromptRes.promptOnly, true)
    assert.ok(Array.isArray(coverPromptRes.slots) && coverPromptRes.slots.length > 0)
    assert.ok(coverPromptRes.system.length > 20 && coverPromptRes.user.includes('为什么本地工具更好用'))

    const promptOnlyCtx = makeMockCtx(req => {
      const parsed = JSON.parse(req.messages[0].content[0].text)
      return JSON.stringify({ values: parsed.slots.map((name, i) => (name.includes('人物段') ? '无人物' : `槽位${i + 1}`)) })
    })

    // cover full generation with mocked Ark PNG
    const arkKeyName = ['ARK', 'API', 'KEY'].join('_')
    const outCover = join(dir, 'cover-out.png')
    const pngBase64 = makePngBuffer(470, 200).toString('base64')
    const coverGenIo = makeIo({
      ctx: promptOnlyCtx,
      env: { [arkKeyName]: 'ark-demo-key' },
      fetchImpl: async () => Response.json({ data: [{ b64_json: pngBase64 }] }),
    })
    assert.equal(await runCli(['cover', mdPath, '--style', 'felt', '--out', outCover, '--data-dir', dir, '--json'], coverGenIo), 0)
    const coverGenRes = JSON.parse(coverGenIo.read().out)
    assert.equal(coverGenRes.ok, true)
    assert.equal(coverGenRes.out, outCover)
    const written = await readFile(outCover)
    assert.equal(written.toString('hex', 0, 8), '89504e470d0a1a0a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('个人写作风格子命令：status、analyze、preview、apply、restore（含 --prompt-only）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-cli-style-'))
  try {
    const samplePath = join(dir, 'sample1.md')
    const profilePath = join(dir, 'profile.json')
    const sampleBody = '说白了，写公众号最怕端着架子讲大道理。我平时写稿都是先抓一个身边真发生过的小事，三句话把矛盾摆出来，再顺着聊我踩过的坑和实测数据。'.repeat(4)
    await writeFile(samplePath, `# 别端着写文章\n\n${sampleBody}\n`, 'utf8')

    // status (initial，同时验证全局参数放在二级子命令前)
    const statusIo1 = makeIo()
    assert.equal(await runCli(['style', '--json', '--data-dir', dir, 'status'], statusIo1), 0)
    assert.equal(JSON.parse(statusIo1.read().out).active, false)

    // analyze --prompt-only (works with zero model key)
    const promptIo = makeIo()
    assert.equal(await runCli(['style', 'analyze', samplePath, '--prompt-only', '--data-dir', dir, '--json'], promptIo), 0)
    const promptRes = JSON.parse(promptIo.read().out)
    assert.equal(promptRes.ok, true)
    assert.equal(promptRes.promptOnly, true)
    assert.match(promptRes.user, /说白了，写公众号最怕端着架子讲大道理/)

    // analyze with mock ctx -> writes profile.json
    const analyzeCtx = makeMockCtx(JSON.stringify({
      name: '直白实测风',
      summary: '像跟同行朋友聊天，先抛真事再给实测结论',
      voice: ['口语直白，不端着'],
      rhythm: ['短段落推进，先讲具体场景'],
      phrases: ['说白了'],
      taboos: ['赋能'],
      headline: { lengthRange: '14-20字', hooks: ['反常识'], punctuation: '少用感叹号', summaryStyle: '一句讲清结论' },
      excerpts: ['说白了，写公众号最怕端着架子讲大道理。我平时写稿都是先抓一个身边真发生过的小事，三句话把矛盾摆出来，再顺着聊我踩过的坑和实测数据。'],
    }))
    const analyzeIo = makeIo({ ctx: analyzeCtx })
    assert.equal(await runCli(['style', 'analyze', samplePath, '--out', profilePath, '--data-dir', dir, '--json'], analyzeIo), 0)
    const analyzeRes = JSON.parse(analyzeIo.read().out)
    assert.equal(analyzeRes.ok, true)
    assert.equal(analyzeRes.profile.name, '直白实测风')

    // preview --prompt-only & live
    const prevPromptIo = makeIo()
    assert.equal(await runCli(['style', 'preview', profilePath, '--topic', 'AI 提效', '--prompt-only', '--json'], prevPromptIo), 0)
    assert.equal(JSON.parse(prevPromptIo.read().out).topic, 'AI 提效')

    const prevCtx = makeMockCtx(JSON.stringify({
      opening: '说白了，很多人用 AI 越用越累，是因为把提示词写成了工作汇报。',
      titles: ['别再把 AI 当下属使唤了', '为什么你用 AI 反而更慢？', '实测一周：我砍掉了 80% 的提示词'],
    }))
    const prevIo = makeIo({ ctx: prevCtx })
    assert.equal(await runCli(['style', 'preview', profilePath, '--topic', 'AI 提效', '--json'], prevIo), 0)
    assert.equal(JSON.parse(prevIo.read().out).titles.length, 3)

    // apply --no-headline -> status -> restore
    const applyIo = makeIo()
    assert.equal(await runCli(['style', 'apply', profilePath, '--no-headline', '--data-dir', dir, '--json'], applyIo), 0)
    const applied = JSON.parse(applyIo.read().out)
    assert.deepEqual(applied.written, ['writer'])

    const statusIo2 = makeIo()
    assert.equal(await runCli(['style', 'status', '--data-dir', dir, '--json'], statusIo2), 0)
    assert.deepEqual(JSON.parse(statusIo2.read().out).scopes, { writer: true, headline: false })

    const restoreIo = makeIo()
    assert.equal(await runCli(['style', 'restore', '--data-dir', dir, '--json'], restoreIo), 0)
    assert.equal(JSON.parse(restoreIo.read().out).state.active, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('第一性原理补全：子命令 --help、stdin -、skills、cover --prompt-file 与 baseUrl 兼容', async () => {
  // 1. baseUrl 已含 /chat/completions 不重复拼接
  let capturedUrl = ''
  const urlCtx = createStandaloneCtx({
    apiKey: 'demo-credential-123',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'demo-model',
    fetchImpl: async url => {
      capturedUrl = String(url)
      return Response.json({ choices: [{ message: { content: 'ok' } }] })
    },
  })
  assert.equal(await callModel(urlCtx, { system: 's', user: 'u', task: 'url-check' }), 'ok')
  assert.equal(capturedUrl, 'https://api.deepseek.com/v1/chat/completions')

  // 2. 二级子命令与一级子命令的 --help 均返回 0 并展示专属选项
  for (const args of [
    ['layout', '--help'],
    ['svg-card', '--help'],
    ['skills', '--help'],
    ['articles', 'list', '--help'],
    ['insights', 'summary', '--help'],
    ['style', 'analyze', '--help'],
    ['style', 'status', '--help'],
    ['cover', '--help'],
  ]) {
    const hIo = makeIo()
    assert.equal(await runCli(args, hIo), 0, `expected exit 0 for ${args.join(' ')}`)
    assert.match(hIo.read().out, /用法/)
  }
  const layoutHelpIo = makeIo()
  assert.equal(await runCli(['layout', '--help'], layoutHelpIo), 0)
  assert.match(layoutHelpIo.read().out, /--follow-card/)

  // 3. --title=--json 不会误判为 JSON 输出模式
  const nonJsonIo = makeIo()
  assert.equal(await runCli(['svg-card', 'svg-steps', '--title=--json', '--line', '一步', '--line', '二步'], nonJsonIo), 0)
  assert.match(nonJsonIo.read().out.trim(), /^<section|^<svg/)

  const dir = await mkdtemp(join(tmpdir(), 'ws-cli-agent-'))
  try {
    // 4. stdin '-' 管道支持（layout - 与 articles import -）
    const stdinMd = '# 管道输入标题\n\n通过标准输入直接传给 CLI，不需要临时文件。\n'
    const outHtml = join(dir, 'stdin.html')
    const pipeLayoutIo = makeIo({ stdin: stdinMd })
    assert.equal(await runCli(['layout', '-', '--out', outHtml, '--data-dir', dir, '--json'], pipeLayoutIo), 0)
    assert.equal(JSON.parse(pipeLayoutIo.read().out).ok, true)
    assert.match(await readFile(outHtml, 'utf8'), /管道输入标题/)

    const pipeImportIo = makeIo({ stdin: stdinMd })
    assert.equal(await runCli(['articles', 'import', '-', '--data-dir', dir, '--json'], pipeImportIo), 0)
    assert.equal(JSON.parse(pipeImportIo.read().out).title, '管道输入标题')

    // 5. skills 命令返回当前生效技能路径
    const skillsIo = makeIo()
    assert.equal(await runCli(['skills', '--data-dir', dir, '--json'], skillsIo), 0)
    const skillsRes = JSON.parse(skillsIo.read().out)
    assert.equal(skillsRes.ok, true)
    assert.ok(skillsRes.skills.some(s => s.name === 'writer' && s.source === 'bundled'))

    // 6. cover --prompt-only 透出 fragments/personSegments；cover --prompt-file 零模型 Key 闭环生图
    const mdPath = join(dir, 'c.md')
    await writeFile(mdPath, stdinMd, 'utf8')
    const pOnlyIo = makeIo()
    assert.equal(await runCli(['cover', mdPath, '--style', 'felt', '--prompt-only', '--data-dir', dir, '--json'], pOnlyIo), 0)
    const pOnlyRes = JSON.parse(pOnlyIo.read().out)
    assert.equal(pOnlyRes.ok, true)
    assert.ok(pOnlyRes.fragments && typeof pOnlyRes.fragments === 'object')
    assert.ok(pOnlyRes.personSegments && typeof pOnlyRes.personSegments === 'object')

    const arkKeyName = ['ARK', 'API', 'KEY'].join('_')
    const outCover = join(dir, 'from-prompt-file.png')
    const pngBase64 = makePngBuffer(470, 200).toString('base64')
    const pFileIo = makeIo({
      stdin: '手工羊毛毡微缩场景封面最终提示词',
      env: { [arkKeyName]: 'ark-demo-key' },
      fetchImpl: async () => Response.json({ data: [{ b64_json: pngBase64 }] }),
    })
    assert.equal(await runCli(['cover', '--prompt-file', '-', '--style', 'felt', '--out', outCover, '--data-dir', dir, '--json'], pFileIo), 0)
    assert.equal(JSON.parse(pFileIo.read().out).ok, true)
    assert.equal((await readFile(outCover)).toString('hex', 0, 8), '89504e470d0a1a0a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('多进程共享存储、growth-only hasData 与稳定 RUNTIME 错误码', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-cli-mp-'))
  try {
    // 1. 已运行的 Store 实例能实时看到外部 CLI 子进程导入的稿件（无需重启）
    const liveStore = new Store(dir)
    assert.equal((await liveStore.read()).articles.length, 0)

    const mdPath = join(dir, 'from-cli.md')
    await writeFile(mdPath, '# 外部 CLI 导入的新稿\n\n正文内容。\n', 'utf8')
    await execFileAsync(process.execPath, [BIN_PATH, 'articles', 'import', mdPath, '--data-dir', dir, '--json'])

    const refreshed = await liveStore.read()
    assert.equal(refreshed.articles.length, 1)
    assert.equal(refreshed.articles[0].title, '外部 CLI 导入的新稿')

    // 2. 只导入 growth.xls 时 insights summary 的 hasData 必须与 summary.hasData 一致
    const growthPath = join(dir, 'growth.xls')
    await writeFile(growthPath, '<table><tr><td>时间</td><td>新关注人数</td></tr><tr><td>2026-11-18</td><td>12</td></tr></table>', 'utf8')
    await execFileAsync(process.execPath, [BIN_PATH, 'insights', 'import', growthPath, '--data-dir', dir, '--json'])

    const sumIo = makeIo()
    assert.equal(await runCli(['insights', 'summary', '--data-dir', dir, '--json'], sumIo), 0)
    const sumRes = JSON.parse(sumIo.read().out)
    assert.equal(sumRes.hasData, true)
    assert.equal(sumRes.summary.hasData, true)

    // 3. 两个并发 CLI 子进程同时导入 growth 和 tendency，都不丢更新
    const dir2 = await mkdtemp(join(tmpdir(), 'ws-cli-mp-race-'))
    try {
      const gFile = join(dir2, 'g.xls')
      const tFile = join(dir2, 't.xls')
      await writeFile(gFile, '<table><tr><td>时间</td><td>新关注人数</td></tr><tr><td>2026-11-18</td><td>20</td></tr></table>', 'utf8')
      const tendencyHtml = '<html><body><table>'
        + '<tr><td>数据趋势概况（2026.11.10-2026.11.18）</td></tr>'
        + '<tr><td>日期</td><td>渠道</td><td>阅读人数</td><td></td><td>日期</td><td>分享人数</td><td>跳转阅读原文人数</td><td>微信收藏人数</td><td>发表篇数</td><td></td><td>发表日期</td><td>内容标题</td><td>传播渠道</td><td>阅读人数</td><td>阅读人数占比</td></tr>'
        + '<tr><td>2026-11-18</td><td>全部</td><td>500</td><td></td><td>2026-11-18</td><td>10</td><td>1</td><td>2</td><td>1</td><td></td><td>2026-11-18</td><td>并发测试文章</td><td>全部</td><td>500</td><td>1</td></tr>'
        + '</table></body></html>'
      await writeFile(tFile, tendencyHtml, 'utf8')

      await Promise.all([
        execFileAsync(process.execPath, [BIN_PATH, 'insights', 'import', gFile, '--data-dir', dir2, '--json']),
        execFileAsync(process.execPath, [BIN_PATH, 'insights', 'import', tFile, '--data-dir', dir2, '--json']),
      ])

      const merged = JSON.parse(await readFile(join(dir2, 'insights.json'), 'utf8'))
      assert.ok(merged.growth, '并发写入后应保留 growth')
      assert.ok(merged.tendency, '并发写入后应保留 tendency')
    } finally {
      await rm(dir2, { recursive: true, force: true })
    }

    // 4. 系统错误（如把目录传给 layout）在 --json 下仍返回稳定枚举 code: RUNTIME，并附带 causeCode
    const dirErrIo = makeIo()
    assert.equal(await runCli(['layout', dir, '--data-dir', dir, '--json'], dirErrIo), 1)
    const dirErrRes = JSON.parse(dirErrIo.read().out)
    assert.equal(dirErrRes.ok, false)
    assert.equal(dirErrRes.code, 'RUNTIME')
    assert.equal(dirErrRes.causeCode, 'EISDIR')
    // 5. 两个独立 Store 实例读取同一稿件：A 修改标题后，B 必须读到新标题，且 B 后续更新不能覆盖回旧标题
    const storeA = new Store(dir)
    const storeB = new Store(dir)
    const [aBefore, bBefore] = await Promise.all([storeA.read(), storeB.read()])
    assert.equal(aBefore.articles[0].title, '外部 CLI 导入的新稿')
    assert.equal(bBefore.articles[0].title, '外部 CLI 导入的新稿')

    await storeA.update(state => { state.articles[0].title = '新标题' })
    const bAfterRead = await storeB.read()
    assert.equal(bAfterRead.articles[0].title, '新标题')

    await storeB.update(state => { state.articles[0].summary = '补充摘要' })
    const freshStore = new Store(dir)
    const finalState = await freshStore.read()
    assert.equal(finalState.articles[0].title, '新标题')
    assert.equal(finalState.articles[0].summary, '补充摘要')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('可执行入口 bin/wechat-studio.js 真实子进程冒烟测试', async () => {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const { stdout } = await execFileAsync(process.execPath, [BIN_PATH, '--version', '--json'])
  assert.deepEqual(JSON.parse(stdout), { ok: true, version: pkg.version })
})
