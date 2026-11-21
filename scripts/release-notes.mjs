import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CATEGORY_ORDER = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance & Refactors'],
  ['other', 'Docs & Tooling'],
]

const RELEASE_BUMP_RE = /^(?:chore(?:\(release\))?:\s*(?:bump version|release\b|\d+\.\d+\.\d+)|v?\d+\.\d+\.\d+)/i

/**
 * 解析 Conventional Commit 标题。
 * @param {string} subject
 */
export function parseCommitSubject(subject) {
  const raw = String(subject ?? '').trim()
  const match = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/i.exec(raw)
  if (!match) return { type: 'other', scope: '', breaking: false, description: raw }
  const type = match[1].toLowerCase()
  const scope = (match[2] ?? '').trim()
  const breaking = Boolean(match[3])
  const description = match[4].trim()
  return { type, scope, breaking, description }
}

function categoryOf(type) {
  if (type === 'feat') return 'feat'
  if (type === 'fix') return 'fix'
  if (type === 'perf' || type === 'refactor') return 'perf'
  return 'other'
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / 1024).toFixed(1)} KB`
}

export function parseRepoSlug(pkg) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  const raw = typeof pkg?.repository === 'string' ? pkg.repository : pkg?.repository?.url ?? ''
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i.exec(raw)
  return match ? match[1] : 'lqshow/dsh-wechat-studio'
}

function commitLink(repo, hash) {
  const short = hash.slice(0, 7)
  return `[${short}](https://github.com/${repo}/commit/${hash})`
}

/**
 * 渲染完整的 GitHub Release Markdown 正文。
 */
export function renderReleaseNotes({
  tag,
  prevTag = '',
  pkgName = 'dsh-wechat-studio',
  dshEngine = '',
  nodeEngine = '>=20',
  repo = 'lqshow/dsh-wechat-studio',
  customNotes = '',
  commits = [],
  contributors = [],
  tarball = null,
}) {
  const version = String(tag ?? '').replace(/^v/i, '')
  const distTag = version.includes('-') ? 'next' : 'latest'
  const lines = []

  // 1. Install / Update
  lines.push('## Install / Update', '')
  lines.push(`在 DeepSeek Harness 中安装或更新 **${pkgName}**：`, '')
  lines.push('```bash')
  lines.push(`# 安装当前版本`)
  lines.push(`dsh plugin --profile web add ${pkgName}@${version}`)
  lines.push('')
  lines.push(distTag === 'next' ? `# 更新到最新预发布版` : `# 更新到最新版`)
  lines.push(`dsh plugin --profile web update ${pkgName}@${distTag}`)
  lines.push('```', '')
  lines.push('或作为独立 CLI 使用（不依赖 DSH）：', '')
  lines.push('```bash')
  lines.push(`npm install -g ${pkgName}@${version}`)
  lines.push(`# 或免安装直接运行`)
  lines.push(`npx ${pkgName}@${version} --help`)
  lines.push('```', '')

  const metaParts = [
    `[npm v${version}](https://www.npmjs.com/package/${pkgName}/v/${version})`,
    nodeEngine ? `Node \`${nodeEngine}\`` : '',
    dshEngine ? `DSH \`${dshEngine}\`` : '',
  ].filter(Boolean)
  if (metaParts.length) {
    lines.push(`> ${metaParts.join(' · ')}`, '')
  }

  // 2. What's New
  lines.push("## What's New", '')
  const trimmedCustom = String(customNotes ?? '').trim()
  if (trimmedCustom) {
    lines.push(trimmedCustom, '')
  } else {
    const groups = new Map(CATEGORY_ORDER.map(([key]) => [key, []]))
    for (const c of commits) {
      if (RELEASE_BUMP_RE.test(c.subject)) continue
      const parsed = parseCommitSubject(c.subject)
      const bucket = groups.get(categoryOf(parsed.type))
      const prefix = parsed.scope ? `**${parsed.scope}**: ` : ''
      const breaking = parsed.breaking ? '**BREAKING** ' : ''
      bucket.push(`- ${breaking}${prefix}${parsed.description} (${commitLink(repo, c.hash)})`)
    }
    let hasAny = false
    for (const [key, title] of CATEGORY_ORDER) {
      const items = groups.get(key)
      if (!items.length) continue
      hasAny = true
      lines.push(`### ${title}`, '')
      lines.push(...items, '')
    }
    if (!hasAny) {
      lines.push('- Routine maintenance release.', '')
    }
  }

  // 3. Commits & Compare
  if (commits.length) {
    lines.push('## Commits', '')
    const commitLines = commits.map(c => `- ${c.subject} (${commitLink(repo, c.hash)})`)
    if (commits.length > 15) {
      lines.push(`<details>`, `<summary>查看全部 ${commits.length} 条提交</summary>`, '')
      lines.push(...commitLines, '')
      lines.push('</details>', '')
    } else {
      lines.push(...commitLines, '')
    }
    if (prevTag) {
      const compareUrl = `https://github.com/${repo}/compare/${prevTag}...${tag}`
      lines.push(`**Full Changelog**: [${prevTag}...${tag}](${compareUrl}) · ${commits.length} commits`, '')
    }
  }

  // 4. Contributors
  const uniqueContributors = [...new Set(contributors.map(s => String(s ?? '').trim()).filter(Boolean))]
  if (uniqueContributors.length) {
    lines.push('## Contributors', '')
    lines.push(uniqueContributors.map(name => `- ${name}`).join('\n'), '')
  }

  // 5. Package Integrity
  if (tarball) {
    lines.push('## Package Integrity', '')
    lines.push(`- File: \`${tarball.filename}\` (${formatBytes(tarball.size)})`)
    lines.push(`- SHA-256: \`${tarball.sha256}\``, '')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function detectPrevTag(tag, cwd) {
  let ref = 'HEAD'
  try {
    git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], cwd)
    ref = `${tag}^`
  } catch {
    ref = 'HEAD'
  }
  try {
    return git(['describe', '--tags', '--abbrev=0', ref], cwd)
  } catch {
    try {
      const all = git(['tag', '--sort=-v:refname'], cwd).split('\n').filter(Boolean)
      return all.find(t => t !== tag) ?? ''
    } catch {
      return ''
    }
  }
}

function readGitCommits(prevTag, tag, cwd) {
  const endRef = (() => {
    try {
      git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], cwd)
      return tag
    } catch {
      return 'HEAD'
    }
  })()
  const range = prevTag ? `${prevTag}..${endRef}` : endRef
  const format = '%H%x1f%an%x1f%s%x1e'
  let raw = ''
  try {
    raw = git(['log', '--no-merges', `--format=${format}`, range], cwd)
  } catch {
    return { commits: [], contributors: [] }
  }
  const commits = []
  const contributors = []
  for (const record of raw.split('\x1e')) {
    const trimmed = record.trim()
    if (!trimmed) continue
    const [hash, author, subject] = trimmed.split('\x1f')
    if (!hash || !subject) continue
    commits.push({ hash, author: author ?? '', subject })
    if (author) contributors.push(author)
  }
  return { commits, contributors }
}

function readTarballInfo(tarballPath) {
  if (!tarballPath) return null
  const buf = readFileSync(tarballPath)
  const sha256 = createHash('sha256').update(buf).digest('hex')
  const { size } = statSync(tarballPath)
  return { filename: basename(tarballPath), size, sha256 }
}

function parseCliArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--tag') opts.tag = argv[++i]
    else if (arg === '--prev-tag') opts.prevTag = argv[++i]
    else if (arg === '--tarball') opts.tarball = argv[++i]
    else if (arg === '--repo') opts.repo = argv[++i]
    else if (arg === '--notes-file') opts.notesFile = argv[++i]
    else if (arg === '--out') opts.out = argv[++i]
  }
  return opts
}

/**
 * 在 GitHub Actions 环境中通过 Compare API 解析真实 GitHub @handle（排除 bot）；
 * 无 token 或接口失败时返回空数组，调用方回退到本地 git 作者名。
 */
export async function resolveGithubContributors({ repo, prevTag, tag, token, fetchImpl = fetch }) {
  if (!token || !repo || !prevTag || !tag) return []
  const url = `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(prevTag)}...${encodeURIComponent(tag)}`
  try {
    const res = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-wechat-studio-release-notes',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []
    const data = await res.json()
    const seen = new Set()
    const handles = []
    for (const commit of data?.commits ?? []) {
      const login = commit?.author?.login
      if (login) {
        if (login.endsWith('[bot]')) continue
        const label = `@${login}`
        if (seen.has(label)) continue
        seen.add(label)
        handles.push(label)
        continue
      }
      const fallbackName = String(commit?.commit?.author?.name ?? '').trim()
      if (!fallbackName || fallbackName.endsWith('[bot]') || seen.has(fallbackName)) continue
      seen.add(fallbackName)
      handles.push(fallbackName)
    }
    return handles
  } catch {
    return []
  }
}

async function main() {
  const cwd = process.cwd()
  const opts = parseCliArgs(process.argv.slice(2))
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  const tag = opts.tag || process.env.RELEASE_TAG || `v${pkg.version}`
  const prevTag = opts.prevTag !== undefined ? opts.prevTag : detectPrevTag(tag, cwd)
  const repo = opts.repo || parseRepoSlug(pkg)
  const notesFile = opts.notesFile || join(cwd, 'docs', 'releases', `${tag}.md`)
  const customNotes = existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : ''
  const { commits, contributors: gitContributors } = readGitCommits(prevTag, tag, cwd)
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
  const ghContributors = await resolveGithubContributors({ repo, prevTag, tag, token })
  const contributors = ghContributors.length ? ghContributors : gitContributors
  const tarball = opts.tarball ? readTarballInfo(opts.tarball) : null

  const markdown = renderReleaseNotes({
    tag,
    prevTag,
    pkgName: pkg.name,
    dshEngine: pkg.engines?.dsh ?? '',
    nodeEngine: pkg.engines?.node ?? '>=20',
    repo,
    customNotes,
    commits,
    contributors,
    tarball,
  })

  if (opts.out) writeFileSync(opts.out, markdown, 'utf8')
  else process.stdout.write(markdown)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
