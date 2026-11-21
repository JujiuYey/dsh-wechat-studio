import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { publicSettings, readSettings, updateSettings } from '../src/settings.js'
import { contentImageUrls, friendlyWechatError, latestCover, placeholderPng, pushWechatDraft, rewriteContentImages, verifyCredentials } from '../src/wechat.js'

test('40164 的报错把 IP 白名单里的 IP 报出来', () => {
  const message = friendlyWechatError(40164, 'invalid ip 203.0.113.7 ipv6 ::ffff:203.0.113.7, not in whitelist rid: 1')
  assert.match(message, /203\.0\.113\.7/)
  assert.match(message, /IP 白名单/)
  assert.doesNotMatch(friendlyWechatError(40164, 'invalid ip not in whitelist'), /undefined/)
})

test('其它错误码翻成给用户看的话', () => {
  assert.match(friendlyWechatError(40013, ''), /AppID/)
  assert.match(friendlyWechatError(40001, ''), /AppSecret/)
  assert.match(friendlyWechatError(48001, ''), /权限/)
  assert.match(friendlyWechatError(99999, '自定义原因'), /自定义原因/)
})

test('contentImageUrls 只挑要转存的 http(s) 图', () => {
  const urls = contentImageUrls('<img src="https://a.com/1.png"><img src="https://mmbiz.qpic.cn/keep.gif"><img src="data:image/png;base64,xx"><img src="https://a.com/1.png"><img SRC="https://b.com/2.jpg">')
  assert.deepEqual(urls, ['https://a.com/1.png', 'https://b.com/2.jpg'])
})

test('rewriteContentImages 把正文里的图换成公众号地址，失败的保持原样', async () => {
  const calls = []
  const fetchImpl = async url => {
    calls.push(String(url))
    if (String(url).includes('bad.com')) return new Response('nope', { status: 404 })
    return new Response(Buffer.from('fake-image'), { headers: { 'content-type': 'image/png' } })
  }
  const html = '<p><img src="https://good.com/a.png"></p><img src="https://bad.com/b.png">'
  const { content, warnings } = await rewriteContentImages(html, {
    token: 'tok',
    fetchImpl: url => {
      if (String(url).startsWith('https://good.com') || String(url).startsWith('https://bad.com')) return fetchImpl(url)
      // 微信 uploadimg
      calls.push(String(url))
      return Response.json({ url: 'https://mmbiz.qpic.cn/uploaded.png' })
    },
  })
  assert.match(content, /https:\/\/mmbiz\.qpic\.cn\/uploaded\.png/)
  assert.match(content, /https:\/\/bad\.com\/b\.png/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /b\.png|转存/)
})

test('placeholderPng 是合法的 PNG 头', async () => {
  const { inflateSync } = await import('node:zlib')
  const png = placeholderPng()
  assert.equal(png.readUInt32BE(0), 0x89504e47)
  assert.equal(png.slice(png.length - 8, png.length - 4).toString('ascii'), 'IEND')
  assert.equal(png.readUInt32BE(16), 900)
  assert.equal(png.readUInt32BE(20), 383)
  // IDAT 解出来应该是 383 行，每行 1 个过滤字节 + 900×3 个像素
  const idatLength = png.readUInt32BE(33)
  const raw = inflateSync(png.slice(41, 41 + idatLength))
  assert.equal(raw.length, 383 * (1 + 900 * 3))
  // 第一行的像素是 (37,42,38) 重复 900 次
  assert.equal(raw[1], 37); assert.equal(raw[2], 42); assert.equal(raw[3], 38)
  assert.equal(raw[2700], 38)
})

test('latestCover 优先用「设为当前封面」选中的 cover，没有再回退到最新一批', () => {
  const article = { coverRuns: [{ images: [] }, { images: [{ id: 'old' }], format: 'png' }, { images: [{ id: 'new' }], format: 'jpeg' }] }
  assert.deepEqual(latestCover(article), { id: 'new', format: 'jpeg' })
  assert.equal(latestCover({}), null)
  // 用户在封面历史里点过「设为当前封面」，即使它不是最新生成的也要优先
  const selected = { ...article, cover: { id: 'picked', format: 'png' } }
  assert.deepEqual(latestCover(selected), { id: 'picked', format: 'png' })
  assert.deepEqual(latestCover({ cover: { id: 'picked' } }), { id: 'picked', format: 'png' })
})

const TOKEN_CALLS = () => [['https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential', Response.json({ access_token: 'tok' })]]

test('verifyCredentials 换到 token 就算通过，账号信息失败不拦', async () => {
  const fetchImpl = async url => {
    const target = String(url)
    if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'tok' })
    if (target.includes('getaccountinfo')) return Response.json({ errcode: -1, errmsg: 'nope' })
    return Response.json({})
  }
  const result = await verifyCredentials('wxid', 'secret', fetchImpl)
  assert.deepEqual(result, { nickname: '', headImg: '' })
})

test('verifyCredentials 的错误走友好文案', async () => {
  const fetchImpl = async () => Response.json({ errcode: 40164, errmsg: 'invalid ip 203.0.113.7, not in whitelist' })
  await assert.rejects(verifyCredentials('wxid', 'secret', fetchImpl), /203\.0\.113\.7/)
})

test('pushWechatDraft 没凭证、没正文时报 400，凭证错时带白名单提示', async () => {
  await assert.rejects(pushWechatDraft({ article: {}, html: '<p>x</p>', settings: {}, fetchImpl: async () => assert.fail() }), /公众号凭证/)
  await assert.rejects(pushWechatDraft({ article: {}, html: '  ', settings: { mp: { appId: 'a', appSecret: 'b' } }, fetchImpl: async () => assert.fail() }), /正文/)
  const fetchImpl = async () => Response.json({ errcode: 40164, errmsg: 'invalid ip 1.2.3.4, not in whitelist' })
  await assert.rejects(pushWechatDraft({ article: {}, html: '<p>x</p>', settings: { mp: { appId: 'a', appSecret: 'b' } }, fetchImpl }), /1\.2\.3\.4/)
})

test('pushWechatDraft 用真封面和转存后的正文推草稿', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    seen.push(target)
    if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'tok' })
    if (target.includes('add_material')) {
      // add_material 必须带 type=image
      assert.ok(target.includes('type=image'), `add_material 缺少 type=image：${target}`)
      return Response.json({ media_id: 'THUMB' })
    }
    if (target.includes('uploadimg')) return Response.json({ url: 'https://mmbiz.qpic.cn/up.png' })
    if (target.includes('draft/add')) {
      const payload = JSON.parse(init.body)
      assert.equal(payload.articles[0].title.length, 32) // draft/add 的 title 上限 32 字
      return Response.json({ media_id: 'DRAFT' })
    }
    if (target.startsWith('https://good.com')) return new Response(Buffer.from('image-bytes'), { headers: { 'content-type': 'image/png' } })
    throw new Error(`unexpected ${target}`)
  }
  const result = await pushWechatDraft({
    article: { title: '标题标题标题'.repeat(10), coverRuns: [{ images: [{ id: 'c1' }], format: 'png' }] },
    html: '<section>banner</section><p><img src="https://good.com/a.png"></p>',
    settings: { mp: { appId: 'a', appSecret: 'b' }, brand: { author: '作者' } },
    cover: { buffer: Buffer.from('cover-bytes'), format: 'png' },
    fetchImpl,
  })
  assert.equal(result.mediaId, 'DRAFT')
  assert.deepEqual(result.warnings, [])
  const draft = seen.find(u => u.includes('draft/add'))
  assert.ok(draft.includes('access_token=tok'))
  assert.ok(seen.some(u => u.includes('add_material')))
  assert.ok(seen.some(u => u.includes('uploadimg')))
})

test('rewriteContentImages 拒绝 GIF、超大图和内网地址，并跟进重定向后仍校验', async () => {
  const warnings = []
  const upload = () => Response.json({ url: 'https://mmbiz.qpic.cn/uploaded.png' })
  const wrap = fetchImpl => async (url, init) => {
    if (String(url).startsWith('https://api.weixin.qq.com')) return upload()
    return fetchImpl(url, init)
  }
  const push = async html => (await rewriteContentImages(html, { token: 'tok', fetchImpl: wrap(async url => {
    if (String(url).includes('gif.com')) return new Response(Buffer.from('g'), { headers: { 'content-type': 'image/gif' } })
    if (String(url).includes('big.com')) return new Response(Buffer.alloc(1_100_000), { headers: { 'content-type': 'image/png' } })
    if (String(url).includes('jump.com')) return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.png' } })
    if (String(url).includes('192.168.1.5')) return new Response(Buffer.from('x'), { headers: { 'content-type': 'image/png' } })
    if (String(url).includes('good.com')) return new Response(Buffer.from('ok'), { headers: { 'content-type': 'image/png' } })
    throw new Error(`unexpected ${url}`)
  })})).warnings
  warnings.push(...await push('<img src="https://gif.com/a.gif">'))
  assert.match(warnings.at(-1), /JPG\/PNG/)
  warnings.push(...await push('<img src="https://big.com/a.png">'))
  assert.match(warnings.at(-1), /1 MB/)
  warnings.push(...await push('<img src="http://192.168.1.5/a.png">'))
  assert.match(warnings.at(-1), /内网/)
  // 302 重定向到内网地址也要被拦下
  warnings.push(...await push('<img src="https://jump.com/a.png">'))
  assert.match(warnings.at(-1), /内网/)
  // 正常公网图不受影响
  const ok = await rewriteContentImages('<img src="https://good.com/a.png">', { token: 'tok', fetchImpl: wrap(async () => new Response(Buffer.from('ok'), { headers: { 'content-type': 'image/png' } })) })
  assert.equal(ok.warnings.length, 0)
})

test('pushWechatDraft 封面没有时用占位图并提醒', async () => {
  const fetchImpl = async url => {
    const target = String(url)
    if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'tok' })
    if (target.includes('add_material')) return Response.json({ media_id: 'THUMB' })
    if (target.includes('draft/add')) return Response.json({ media_id: 'DRAFT' })
    throw new Error(`unexpected ${target}`)
  }
  const result = await pushWechatDraft({ article: { title: 't' }, html: '<p>x</p>', settings: { mp: { appId: 'a', appSecret: 'b' } }, fetchImpl })
  assert.deepEqual(result.warnings, ['这篇还没有生成封面，草稿里放了占位图；想用真封面，先生成封面再重新推送。'])
})

test('mp 凭证保存后 publicSettings 只报有没有', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-mp-'))
  try {
    const next = await updateSettings(root, { mp: { name: '小钥 AI', appId: 'wx123', appSecret: 'a'.repeat(32) } })
    assert.deepEqual(next.mp, { name: '小钥 AI', appId: 'wx123', appSecret: 'a'.repeat(32), headImg: '' })
    const pub = publicSettings(next)
    assert.equal(pub.mp.appId, 'wx123')
    assert.equal(pub.mp.appSecretSet, true)
    assert.equal(pub.mp.headImg, '')
    assert.ok(!('appSecret' in pub.mp))
    // 文件确实落盘且不在 publicSettings 里泄漏
    const saved = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
    assert.equal(saved.mp.appSecret, 'a'.repeat(32))
    // 缓存头像并验证更换 appId 时清空旧头像、非法协议不保存
    const withAvatar = await updateSettings(root, { mp: { headImg: 'https://cdn.example.com/avatar.png' } })
    assert.equal(withAvatar.mp.headImg, 'https://cdn.example.com/avatar.png')
    assert.equal(publicSettings(withAvatar).mp.headImg, 'https://cdn.example.com/avatar.png')
    const badAvatar = await updateSettings(root, { mp: { headImg: 'ftp://example.com/avatar.png' } })
    assert.equal(badAvatar.mp.headImg, '')
    await updateSettings(root, { mp: { headImg: 'https://cdn.example.com/avatar.png' } })
    // 不传 appSecret 时不改动；传非 32 位报 400；换了 appId 清空旧头像
    const untouched = await updateSettings(root, { mp: { appId: 'wx456' } })
    assert.equal(untouched.mp.appSecret, 'a'.repeat(32))
    assert.equal(untouched.mp.headImg, '')
    await assert.rejects(updateSettings(root, { mp: { appSecret: 'not-hex' } }), /AppSecret/)
    // 空字符串表示清除
    const cleared = await updateSettings(root, { mp: { appSecret: '' } })
    assert.equal(cleared.mp.appSecret, '')
    const again = await updateSettings(root, { mp: { appSecret: 'b'.repeat(32) } })
    assert.equal(again.mp.appSecret, 'b'.repeat(32))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readSettings 对坏掉的 mp 字段有默认值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wechat-mp-'))
  try {
    await writeFile(join(root, 'settings.json'), JSON.stringify({ mp: { name: 1, appId: null, appSecret: 3, headImg: 'ftp://bad.example/x.png' } }))
    const settings = await readSettings(root)
    assert.deepEqual(settings.mp, { name: '', appId: '', appSecret: '', headImg: '' })
    assert.equal(publicSettings(settings).mp.appSecretSet, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pushWechatDraft 优先发送 article.summary 作为 digest，超长按 120 字截断', async () => {
  let sentPayload = null
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'tok' })
    if (target.includes('add_material')) return Response.json({ media_id: 'THUMB' })
    if (target.includes('draft/add')) {
      sentPayload = JSON.parse(init.body)
      return Response.json({ media_id: 'DRAFT' })
    }
    throw new Error(`unexpected ${target}`)
  }
  const longSummary = `  ${'摘'.repeat(130)}  `
  await pushWechatDraft({
    article: { title: '测试标题', summary: longSummary, blocks: [{ text: '正文第一段' }] },
    html: '<p>正文第一段</p>',
    settings: { mp: { appId: 'a', appSecret: 'b' } },
    fetchImpl,
  })
  assert.equal(sentPayload.articles[0].digest, '摘'.repeat(120))
})

test('pushWechatDraft 无摘要时跳过标题/图片/代码块，取第一段正文纯文本作为 digest', async () => {
  const sentDigests = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'tok' })
    if (target.includes('add_material')) return Response.json({ media_id: 'THUMB' })
    if (target.includes('draft/add')) {
      sentDigests.push(JSON.parse(init.body).articles[0].digest)
      return Response.json({ media_id: 'DRAFT' })
    }
    throw new Error(`unexpected ${target}`)
  }
  await pushWechatDraft({
    article: {
      title: '测试标题',
      summary: '   ',
      blocks: [
        { text: '## 小标题' },
        { text: '![配图](https://example.com/a.png)' },
        { text: '```js\nconsole.log(1)\n```' },
        { text: '这是**第一段**正文，里面有 `代码` 和   多余空格。' },
      ],
    },
    html: '<p>x</p>',
    settings: { mp: { appId: 'a', appSecret: 'b' } },
    fetchImpl,
  })
  await pushWechatDraft({
    article: {
      title: '只有非正文块',
      summary: '',
      blocks: [{ text: '## 仅标题' }, { text: '![图](https://example.com/b.png)' }],
    },
    html: '<p>x</p>',
    settings: { mp: { appId: 'a', appSecret: 'b' } },
    fetchImpl,
  })
  assert.deepEqual(sentDigests, ['这是第一段正文，里面有 代码 和 多余空格。', ''])
})

test('deriveDigest 按 120 UTF-16 码元截断时不拆分末尾 emoji 代理对', async () => {
  const { deriveDigest } = await import('../src/wechat-meta.js')
  const summary = '文'.repeat(119) + '🚀'
  const direct = deriveDigest({ summary })
  assert.equal(direct.text, '文'.repeat(119))
  assert.equal(direct.text.length, 119)

  const fromBlock = deriveDigest({ summary: '', blocks: [{ kind: 'para', text: '文'.repeat(119) + '🚀后续' }] })
  assert.equal(fromBlock.text, '文'.repeat(119))
  assert.equal(fromBlock.fallback, true)
})

test('pushWechatDraft 截断超长标题时不拆分末尾 emoji 代理对', async () => {
  let sentTitle = null
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.includes('/cgi-bin/token')) return Response.json({ access_token: 'tok' })
    if (target.includes('add_material')) return Response.json({ media_id: 'THUMB' })
    if (target.includes('draft/add')) {
      sentTitle = JSON.parse(init.body).articles[0].title
      return Response.json({ media_id: 'DRAFT' })
    }
    throw new Error(`unexpected ${target}`)
  }
  await pushWechatDraft({
    article: { title: '文'.repeat(31) + '🚀', blocks: [{ text: '正文' }] },
    html: '<p>正文</p>',
    settings: { mp: { appId: 'a', appSecret: 'b' } },
    fetchImpl,
  })
  assert.equal(sentTitle, '文'.repeat(31))
})
