// 本地存储：稿件按 ID 分片存放在 <DSH_HOME>/wechat-studio/articles/<id>/，索引在 index.json，桌面版、网页版和独立 CLI 共用。
import { createHash } from 'node:crypto'
import { access, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readJsonSafe, writeJsonAtomic } from './fs-json.js'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const EMPTY = { v: 1, currentId: null, articles: [] }
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const LOCK_STALE_MS = 15_000
const LOCK_TIMEOUT_MS = 10_000
const digest = text => createHash('sha1').update(text).digest('base64')
const exists = file => access(file).then(() => true, () => false)

async function fileSig(file) {
  try {
    const st = await stat(file)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

export async function withFileLock(lockFile, fn) {
  await mkdir(dirname(lockFile), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let handle = null
  while (!handle) {
    try {
      handle = await open(lockFile, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      const st = await stat(lockFile).catch(() => null)
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockFile).catch(() => {})
        continue
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('等待工作区写入锁超时，请稍后重试。'), { status: 409 })
      }
      await delay(15 + Math.floor(Math.random() * 25))
    }
  }
  try {
    return await fn()
  } finally {
    await handle.close().catch(() => {})
    await unlink(lockFile).catch(() => {})
  }
}

export class JsonStore {
  constructor(root, { file, empty }) {
    this.root = root
    this.file = join(root, file)
    this.lockFile = `${this.file}.lock`
    this.empty = empty
    this.queue = Promise.resolve()
    this.cache = null
    this.diskSig = undefined
    this.writing = 0
    this.loading = null
    this.problems = []
  }

  async read({ bypassWriting = false } = {}) {
    if (this.loading) return this.loading
    if (this.cache) {
      if (!bypassWriting && this.writing > 0) return this.cache
      const sig = await fileSig(this.file)
      if (sig === this.diskSig) return this.cache
    }
    this.loading ??= this.load().finally(() => { this.loading = null })
    return this.loading
  }

  async load() {
    const sig = await fileSig(this.file)
    const { status, value } = await readJsonSafe(this.file)
    if (status === 'corrupt') this.problems.push({ file: this.file, message: `${this.file} 已损坏，已改名保留` })
    else if (status === 'backup') this.problems.push({ file: this.file, message: `${this.file} 主文件已损坏，已回退到上一版备份` })
    this.cache = { ...structuredClone(this.empty), ...(value ?? {}) }
    this.diskSig = sig
    return this.cache
  }

  /**
   * 跨进程加锁后重读磁盘最新状态再修改落盘，防止多进程并发写入相互覆盖。
   * @param {(state: object) => any} fn - 修改函数，返回值原样返回。
   */
  update(fn) {
    const run = async () => withFileLock(this.lockFile, async () => {
      this.writing += 1
      try {
        const state = await this.read({ bypassWriting: true })
        const result = await fn(state)
        await mkdir(this.root, { recursive: true })
        await writeJsonAtomic(this.file, state)
        this.diskSig = await fileSig(this.file)
        return result
      } finally {
        this.writing -= 1
      }
    })
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }
}

export class Store {
  constructor(root = join(dshHome(), 'wechat-studio'), { empty = EMPTY } = {}) {
    this.root = root
    this.dir = join(root, 'articles')
    this.indexFile = join(root, 'index.json')
    this.lockFile = join(root, '.store.lock')
    this.legacyFile = join(root, 'state.json')
    this.empty = empty
    this.queue = Promise.resolve()
    this.cache = null
    this.indexSig = undefined
    this.writing = 0
    this.loading = null
    this.problems = []
    this.written = new Map() // id -> { articleHash, historyHash }
    this.writtenIndex = null
  }

  async read({ bypassWriting = false } = {}) {
    if (this.loading) return this.loading
    if (this.cache) {
      if (!bypassWriting && this.writing > 0) return this.cache
      const sig = await fileSig(this.indexFile)
      if (sig === this.indexSig) return this.cache
    }
    this.loading ??= this.load().finally(() => { this.loading = null })
    return this.loading
  }

  /**
   * 从旧版 state.json 一次性迁移成分片。
   * 顺序固定：先写分片，再写索引，最后改名旧文件。任一步崩溃，下次启动都会因索引缺失而整段重跑。
   * @param {{ stopBeforeIndex?: boolean }} [options] - `stopBeforeIndex` 仅为测试崩溃点存在。
   */
  async migrateLegacy({ stopBeforeIndex = false } = {}) {
    if (await exists(this.indexFile)) return
    const legacy = await readJsonSafe(this.legacyFile)
    if (legacy.status === 'missing') return
    if (legacy.status === 'corrupt') {
      this.problems.push({ file: this.legacyFile, message: 'state.json 已损坏，已改名保留，未迁移' })
      return
    }
    if (legacy.status === 'backup') {
      this.problems.push({ file: this.legacyFile, message: 'state.json 主文件已损坏，已从上一版备份迁移' })
    }
    const state = { ...structuredClone(this.empty), ...legacy.value }
    state.articles = Array.isArray(legacy.value.articles) ? legacy.value.articles : []
    await mkdir(this.dir, { recursive: true })
    let skippedBadId = false
    const valid = []
    for (const article of state.articles) {
      if (!ID_PATTERN.test(article?.id ?? '')) {
        skippedBadId = true
        this.problems.push({ file: this.legacyFile, message: `旧数据包含非法稿件 ID：${article?.id}，已跳过并保留 state.json` })
        continue
      }
      const { history = [], ...body } = article
      const base = join(this.dir, article.id)
      await mkdir(base, { recursive: true })
      await writeJsonAtomic(join(base, 'article.json'), body)
      await writeJsonAtomic(join(base, 'history.json'), history)
      valid.push(article)
    }
    if (stopBeforeIndex) return
    await writeJsonAtomic(this.indexFile, this.indexOf({ ...state, articles: valid }))
    if (!skippedBadId) await rename(this.legacyFile, `${this.legacyFile}.v1.bak`).catch(err => { if (err.code !== 'ENOENT') throw err })
  }

  async load() {
    await this.migrateLegacy()
    const index = await readJsonSafe(this.indexFile)
    if (index.status === 'corrupt') this.problems.push({ file: this.indexFile, message: '稿件索引已损坏，已按目录重建顺序' })
    else if (index.status === 'backup') this.problems.push({ file: this.indexFile, message: '稿件索引主文件已损坏，已回退到上一版备份' })
    const { format, order = [], deleting: rawDeleting = [], ...top } = index.value ?? {}
    const deleting = new Set(Array.isArray(rawDeleting) ? rawDeleting.filter(id => ID_PATTERN.test(id)) : [])
    const ids = await readdir(this.dir).catch(err => { if (err.code === 'ENOENT') return []; throw err })
    const articles = []
    for (const id of ids.filter(name => ID_PATTERN.test(name))) {
      if (deleting.has(id)) continue
      const base = join(this.dir, id)
      const body = await readJsonSafe(join(base, 'article.json'))
      if (body.status === 'missing') continue
      if (body.status === 'corrupt') {
        this.problems.push({ id, message: `稿件 ${id} 已损坏，已改名保留，未加载` })
        continue
      }
      if (body.status === 'backup') {
        this.problems.push({ id, message: `稿件 ${id} 主文件已损坏，已回退到上一版备份` })
      }
      const history = await readJsonSafe(join(base, 'history.json'))
      if (history.status === 'corrupt') this.problems.push({ id, message: `稿件 ${id} 的改稿历史已损坏，已改名保留` })
      else if (history.status === 'backup') this.problems.push({ id, message: `稿件 ${id} 的改稿历史主文件已损坏，已回退到上一版备份` })
      const article = { ...body.value, history: Array.isArray(history.value) ? history.value : [] }
      articles.push(article)
      const { articleHash, historyHash } = this.hashes(article)
      this.written.set(id, { articleHash, historyHash })
    }
    const rank = new Map(order.map((id, i) => [id, i]))
    articles.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)
      || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    this.cache = { ...structuredClone(this.empty), ...top, articles }
    // 补完上次删除中途崩溃遗留的目录清理，并清掉索引里的临时墓碑。
    for (const id of deleting) {
      await rm(join(this.dir, id), { recursive: true, force: true })
    }
    const cleanIndex = this.indexOf(this.cache)
    if (deleting.size && index.status === 'ok') {
      await writeJsonAtomic(this.indexFile, cleanIndex)
    }
    this.writtenIndex = digest(JSON.stringify(cleanIndex))
    this.indexSig = await fileSig(this.indexFile)
    return this.cache
  }

  hashes(article) {
    const { history = [], ...body } = article
    return { articleHash: digest(JSON.stringify(body)), historyHash: digest(JSON.stringify(history)), body, history }
  }

  indexOf(state, deleting = []) {
    const { articles, ...top } = state
    const base = { format: 2, order: articles.map(a => a.id), ...top }
    return deleting.length ? { ...base, deleting } : base
  }

  /**
   * 增量落盘。删除稿件时先在索引写入 deleting 墓碑，再删目录，最后清除墓碑，
   * 避免删目录前崩溃导致下次启动误把已删稿件当作孤儿找回。
   * @param {object} state
   * @param {{ stopBeforeRemove?: boolean }} [options] - `stopBeforeRemove` 仅为测试崩溃点存在。
   */
  async persist(state, { stopBeforeRemove = false } = {}) {
    for (const article of state.articles) {
      if (!ID_PATTERN.test(article?.id ?? '')) throw new Error(`非法稿件 ID：${article?.id}`)
    }
    await mkdir(this.dir, { recursive: true })
    const alive = new Set()
    let articlesChanged = false
    for (const article of state.articles) {
      alive.add(article.id)
      const next = this.hashes(article)
      const prev = this.written.get(article.id)
      if (prev?.articleHash === next.articleHash && prev?.historyHash === next.historyHash) continue
      const base = join(this.dir, article.id)
      await mkdir(base, { recursive: true })
      if (prev?.articleHash !== next.articleHash) {
        await writeJsonAtomic(join(base, 'article.json'), next.body)
        articlesChanged = true
      }
      if (prev?.historyHash !== next.historyHash) {
        await writeJsonAtomic(join(base, 'history.json'), next.history)
        articlesChanged = true
      }
      this.written.set(article.id, { articleHash: next.articleHash, historyHash: next.historyHash })
    }
    // 只删本进程加载或写过、现在已不在列表里的稿件；被隔离的坏稿件从未进入 written，不会被删。
    const toDelete = [...this.written.keys()].filter(id => !alive.has(id))
    if (toDelete.length) {
      const pendingIndex = this.indexOf(state, toDelete)
      await writeJsonAtomic(this.indexFile, pendingIndex)
      this.writtenIndex = digest(JSON.stringify(pendingIndex))
      if (stopBeforeRemove) return
      for (const id of toDelete) {
        await rm(join(this.dir, id), { recursive: true, force: true })
        this.written.delete(id)
      }
    }
    const index = this.indexOf(state)
    const indexHash = digest(JSON.stringify(index))
    // 任意稿件内容变更都原子重写 index.json，使 inode 变化以通知其他 Store 实例刷新缓存。
    if (indexHash !== this.writtenIndex || articlesChanged) {
      await writeJsonAtomic(this.indexFile, index)
      this.writtenIndex = indexHash
    }
    this.indexSig = await fileSig(this.indexFile)
  }

  /**
   * 跨进程加锁后检查外部变更并串行修改落盘。fn 可以直接改传入的 state。
   * @param {(state: object) => any} fn - 修改函数，返回值原样返回。
   */
  update(fn) {
    const run = async () => withFileLock(this.lockFile, async () => {
      this.writing += 1
      try {
        const state = await this.read({ bypassWriting: true })
        const result = await fn(state)
        await this.persist(state)
        return result
      } finally {
        this.writing -= 1
      }
    })
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => {})
    return next
  }
}
