import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseCommitSubject, renderReleaseNotes, resolveGithubContributors } from '../scripts/release-notes.mjs'

test('parseCommitSubject 正确解析 Conventional Commits 与普通提交', () => {
  assert.deepEqual(parseCommitSubject('feat(preflight): add health check'), {
    type: 'feat',
    scope: 'preflight',
    breaking: false,
    description: 'add health check',
  })
  assert.deepEqual(parseCommitSubject('fix!: drop legacy flag'), {
    type: 'fix',
    scope: '',
    breaking: true,
    description: 'drop legacy flag',
  })
  assert.deepEqual(parseCommitSubject('更新文案'), {
    type: 'other',
    scope: '',
    breaking: false,
    description: '更新文案',
  })
})

test('renderReleaseNotes 自动按提交类型分组，跳过发版 bump 并输出安装命令、对比链接与校验值', () => {
  const md = renderReleaseNotes({
    tag: 'v0.3.0',
    prevTag: 'v0.2.1',
    pkgName: 'dsh-wechat-studio',
    dshEngine: '>=0.2.1-rc.5 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0',
    nodeEngine: '>=20',
    repo: 'lqshow/dsh-wechat-studio',
    commits: [
      { hash: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', author: 'lqshow', subject: 'feat(preflight): add preflight health check' },
      { hash: '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', author: 'lqshow', subject: 'fix(settings): update developer platform link' },
      { hash: '3333333ccccccccccccccccccccccccccccccccc', author: 'alice', subject: 'chore: bump version to 0.3.0' },
    ],
    contributors: ['lqshow', 'lqshow', 'alice'],
    tarball: { filename: 'dsh-wechat-studio-0.3.0.tgz', size: 1024 * 512, sha256: 'deadbeef' },
  })

  assert.match(md, /dsh plugin --profile web add dsh-wechat-studio@0\.3\.0/)
  assert.match(md, /dsh plugin --profile web update dsh-wechat-studio@latest/)
  assert.match(md, /npm install -g dsh-wechat-studio@0\.3\.0/)
  assert.match(md, /### Features\n\n- \*\*preflight\*\*: add preflight health check \(\[1111111\]/)
  assert.match(md, /### Fixes\n\n- \*\*settings\*\*: update developer platform link \(\[2222222\]/)
  assert.doesNotMatch(md, /### Docs & Tooling/)
  assert.match(md, /## Commits[\s\S]*chore: bump version to 0\.3\.0/)
  assert.match(md, /\[v0\.2\.1\.\.\.v0\.3\.0\]\(https:\/\/github\.com\/lqshow\/dsh-wechat-studio\/compare\/v0\.2\.1\.\.\.v0\.3\.0\) · 3 commits/)
  assert.match(md, /## Contributors\n\n- lqshow\n- alice/)
  assert.match(md, /dsh-wechat-studio-0\.3\.0\.tgz` \(512\.0 KB\)/)
  assert.match(md, /SHA-256: `deadbeef`/)
})

test('renderReleaseNotes 存在手写版本说明时优先嵌入，同时保留安装命令、Commits 与包校验', () => {
  const md = renderReleaseNotes({
    tag: 'v0.3.0',
    prevTag: 'v0.2.1',
    customNotes: '### 重点更新\n\n新增发布防踩坑体检面板。',
    commits: [{ hash: '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', author: 'lqshow', subject: 'feat(preflight): add check' }],
    contributors: ['lqshow'],
  })

  assert.match(md, /## What's New\n\n### 重点更新\n\n新增发布防踩坑体检面板。/)
  assert.doesNotMatch(md, /### Features/)
  assert.match(md, /## Commits\n\n- feat\(preflight\): add check/)
})

test('scripts/release-notes.mjs CLI 端到端可执行并生成完整 Release Notes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-release-notes-'))
  try {
    const script = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url))
    const tarball = join(dir, 'dsh-wechat-studio-0.2.2.tgz')
    const out = join(dir, 'notes.md')
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-wechat-studio',
      version: '0.2.2',
      repository: 'lqshow/dsh-wechat-studio',
      engines: { node: '>=20' },
    }))
    git('-c', 'init.defaultBranch=main', 'init', '-q')
    git('config', 'user.name', 'Release Test')
    git('config', 'user.email', 'release-test@example.com')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(dir, 'article.txt'), 'first release\n')
    git('add', 'article.txt')
    git('commit', '-qm', 'feat: first release')
    git('tag', 'v0.2.1')
    writeFileSync(join(dir, 'article.txt'), 'second release\n')
    git('commit', '-qam', 'fix: second release')
    git('tag', 'v0.2.2')
    writeFileSync(tarball, 'fake-tarball-bytes')
    execFileSync(process.execPath, [
      script,
      '--tag', 'v0.2.2',
      '--prev-tag', 'v0.2.1',
      '--tarball', tarball,
      '--out', out,
    ], { cwd: dir, env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_REPOSITORY: '' } })
    const content = readFileSync(out, 'utf8')
    assert.match(content, /## Install \/ Update/)
    assert.match(content, /## What's New/)
    assert.match(content, /## Commits\n\n- fix: second release/)
    assert.match(content, /## Package Integrity/)
    assert.match(content, /dsh-wechat-studio-0\.2\.2\.tgz/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('预发布版本固定安装当前 RC 并使用 @next 更新，且未打标签时不传 --prev-tag 也能正常生成', () => {
  const rcMd = renderReleaseNotes({ tag: 'v0.3.0-rc.1', prevTag: 'v0.2.1', commits: [] })
  assert.match(rcMd, /dsh plugin --profile web add dsh-wechat-studio@0\.3\.0-rc\.1/)
  assert.match(rcMd, /dsh plugin --profile web update dsh-wechat-studio@next/)

  const out = execFileSync(process.execPath, [
    'scripts/release-notes.mjs',
    '--tag', 'v99.99.99',
  ], { cwd: process.cwd(), encoding: 'utf8' })
  assert.match(out, /dsh plugin --profile web add dsh-wechat-studio@99\.99\.99/)
  assert.match(out, /## What's New/)
})

test('resolveGithubContributors 解析 @handle、保留未绑定账号作者并过滤 bot', async () => {
  assert.deepEqual(await resolveGithubContributors({ repo: 'a/b', prevTag: 'v1', tag: 'v2', token: '' }), [])
  const handles = await resolveGithubContributors({
    repo: 'lqshow/dsh-wechat-studio',
    prevTag: 'v0.2.1',
    tag: 'v0.2.2',
    token: 'ghs_test',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        commits: [
          { author: { login: 'lqshow' } },
          { author: { login: 'lqshow' } },
          { author: { login: 'dependabot[bot]' } },
          { author: { login: 'alice' } },
          { author: null, commit: { author: { name: 'Bob' } } },
          { author: null, commit: { author: { name: 'Bob' } } },
        ],
      }),
    }),
  })
  assert.deepEqual(handles, ['@lqshow', '@alice', 'Bob'])

  const failed = await resolveGithubContributors({
    repo: 'lqshow/dsh-wechat-studio',
    prevTag: 'v0.2.1',
    tag: 'v0.2.2',
    token: 'ghs_test',
    fetchImpl: async () => ({ ok: false, status: 403 }),
  })
  assert.deepEqual(failed, [])
})
