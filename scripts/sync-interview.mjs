import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const siteRoot = resolve(scriptDirectory, '..')
const workspaceSource = resolve(siteRoot, '..', '面试.md')
const repositorySource = resolve(siteRoot, '面试.md')
const destination = resolve(siteRoot, 'docs', 'interview.md')

await mkdir(dirname(destination), { recursive: true })

let source = repositorySource
try {
  await access(workspaceSource)
  source = workspaceSource
} catch {
  // GitHub Actions 或独立克隆中使用仓库内已提交的文档副本。
}

const sourcePath = await realpath(source)
const destinationDirectory = await realpath(dirname(destination))
const destinationPath = resolve(destinationDirectory, 'interview.md')

if (sourcePath === destinationPath || !destinationPath.startsWith(destinationDirectory)) {
  throw new Error('同步路径校验失败：禁止覆盖源文档')
}

const sourceContent = await readFile(sourcePath)

async function writeIfChanged(path, content) {
  const current = await readFile(path).catch(() => null)
  if (current?.equals(content)) return
  await writeFile(path, content, { flag: 'w' })
}

// 本地开发时只从外层工作区导入，绝不向外层源文档回写。
if (sourcePath === await realpath(workspaceSource).catch(() => '')) {
  await writeIfChanged(repositorySource, sourceContent)
}

await writeIfChanged(destinationPath, sourceContent)
const sourceContentAfterSync = await readFile(sourcePath)

if (!sourceContent.equals(sourceContentAfterSync)) {
  throw new Error('安全校验失败：源文档在同步期间发生变化')
}

console.log(`已单向同步：${sourcePath} -> ${destinationPath}`)
