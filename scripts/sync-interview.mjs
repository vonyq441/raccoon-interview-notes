import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const siteRoot = resolve(scriptDirectory, '..')
const documents = [
  {
    workspace: resolve(siteRoot, '..', '面试.md'),
    repository: resolve(siteRoot, '面试.md'),
    destination: resolve(siteRoot, 'docs', 'interview.md')
  },
  {
    workspace: resolve(siteRoot, '..', '甘肃具身智能示范应用-中央调度平台设计与面试.md'),
    repository: resolve(siteRoot, '中央调度平台设计与面试.md'),
    destination: resolve(siteRoot, 'docs', 'central-scheduling.md')
  }
]

async function writeIfChanged(path, content) {
  const current = await readFile(path).catch(() => null)
  if (current?.equals(content)) return
  await writeFile(path, content, { flag: 'w' })
}

for (const document of documents) {
  await mkdir(dirname(document.destination), { recursive: true })

  const workspaceSourcePath = await realpath(document.workspace).catch(() => null)
  const repositorySourcePath = await realpath(document.repository).catch(() => null)
  const sourcePath = workspaceSourcePath ?? repositorySourcePath
  if (!sourcePath) {
    throw new Error(`找不到文档源文件：${document.repository}`)
  }

  const destinationDirectory = await realpath(dirname(document.destination))
  const destinationPath = resolve(destinationDirectory, basename(document.destination))
  const relativeDestination = relative(destinationDirectory, destinationPath)
  if (sourcePath === destinationPath || relativeDestination.startsWith('..') || isAbsolute(relativeDestination)) {
    throw new Error('同步路径校验失败：禁止覆盖源文档')
  }

  const sourceContent = await readFile(sourcePath)

  // 本地开发时只从外层工作区导入，绝不向外层源文档回写。
  if (workspaceSourcePath && sourcePath === workspaceSourcePath) {
    await writeIfChanged(document.repository, sourceContent)
  }

  await writeIfChanged(destinationPath, sourceContent)
  const sourceContentAfterSync = await readFile(sourcePath)
  if (!sourceContent.equals(sourceContentAfterSync)) {
    throw new Error('安全校验失败：源文档在同步期间发生变化')
  }

  console.log(`已单向同步：${sourcePath} -> ${destinationPath}`)
}
