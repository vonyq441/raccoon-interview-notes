# 项目面试文档站

VitePress 在本地开发时读取外层项目根目录的 `面试.md` 和中央调度平台设计文档，单向生成本仓库的云端副本与 `docs` 构建副本。外层源文档是唯一可编辑版本，站点脚本不会向它们写入内容；GitHub Actions 则读取仓库内已提交的副本。

## 本地使用

在仓库根目录执行：

```powershell
npm run docs:install
npm run docs:dev
```

浏览器打开 `http://127.0.0.1:5173/`。生产构建与预览：

```powershell
npm run docs:build
npm run docs:preview
```

每次启动或构建前会自动同步 `面试.md`；也可以单独执行 `npm run docs:sync`。

## 同步安全边界

- `../面试.md`、`../甘肃具身智能示范应用-中央调度平台设计与面试.md`：本地唯一源文件，只读，脚本绝不回写。
- `面试.md`、`中央调度平台设计与面试.md`：用于提交到独立文档仓库的云端副本，由同步脚本覆盖。
- `docs/interview.md`、`docs/central-scheduling.md`：VitePress 构建副本，由同步脚本覆盖，不要手工编辑。
- 同步脚本只对副本调用写入，并在同步后再次读取源文件进行一致性检查。
- VitePress 的缓存和构建产物位于 `interview-site/docs/.vitepress`，不会写入根目录文档。

## GitHub Pages

仓库已包含 `.github/workflows/deploy-pages.yml`。在 GitHub 仓库中将 Pages 的 Source 设置为 **GitHub Actions**；推送 `main` 后，修改 `面试.md` 或站点文件会触发自动部署。

Pages 地址通常为：

```text
https://<GitHub用户名>.github.io/<仓库名>/
```

> Pages 是公开网页时，请勿在面试文档中放入密码、密钥、真实客户资料或内网地址。

## 依赖安全说明

VitePress 1.6.4 当前依赖的 Vite 开发服务器存在已公开安全告警，但官方依赖树暂无兼容修复版本。本站发布的是构建后的纯静态文件，不在公网运行 Vite 开发服务器；`dev` 和 `preview` 默认只监听 `127.0.0.1`。后续 VitePress 发布兼容修复后应及时升级并重新执行 `npm audit`。
