# Jasmine 开发与发版流程

本文档面向维护 Jasmine 的开发者，明确普通提交 CI、手动跨平台预构建和正式发版之间的边界。目标是让日常反馈足够快，同时确保每个公开版本都经过目标操作系统上的原生构建和安装包冒烟测试。

## 三层流程

| 流程 | 触发方式 | 运行内容 | 是否产生公开版本 |
| --- | --- | --- | --- |
| 普通 CI | 提交到 `main`，或创建/更新 Pull Request | 仓库规则检查一次；Windows、Linux、Apple Silicon macOS 各自原生编译和运行单元测试；Linux 运行 renderer 测试；Windows/Linux 运行 E2E smoke；macOS 分片运行完整 E2E | 否 |
| 手动 Release 预构建 | GitHub Actions 中手动运行 `Release` | Windows、Linux、Apple Silicon macOS 原生构建、单元测试、安装包冒烟测试 | 否，只保留 7 天的 Actions Artifacts |
| 正式 Release | 推送与 `package.json` 版本一致的 `v*.*.*` 标签 | 与手动预构建相同；三个目标平台全部通过后校验产物、生成 SHA-256 并创建 GitHub Release | 是 |

普通提交不生成 NSIS、AppImage、deb 或 DMG。它负责尽快发现编译和核心回归，配置位于 `.github/workflows/ci.yml`。正式安装包由 `.github/workflows/release.yml` 生成，两套工作流不要合并成“每次提交都打全平台安装包”。

普通 CI 按“结果会不会随操作系统变化”和“是否需要真实 Electron”分层：

- `Repository rules` 只跑 `harness:check`。这些检查只读 `docs/` 和源码，不依赖任何 npm 包，也不依赖编译产物，因此不安装依赖、不构建，跑一次即可，几十秒内就能报出文档与 UI 规则违规。
- `Linux x64`、`Windows x64` 两个验证 Job 跑各自原生的 `npm ci`、`build`、`test:unit` 和 `test:e2e:smoke`。macOS 完整 E2E Job 本身已经原生安装和构建，串行 E2E Job 在 cold-start timing 完成后再运行 macOS `test:unit`，避免单元测试中的 Electron smoke 预热冷启动路径；因此不再额外启动一个重复安装、重复构建的 macOS 验证 Job。三个目标平台的原生构建与单元测试仍全部保留。
- `test:renderer` 使用 jsdom 和 fake desktop bridge，不启动 Electron，也不加载原生模块；它只在 Linux Job 跑一次。macOS 的完整 E2E 分片已包含同一批 `@smoke` 用例，不重复执行。
- 本地完整 E2E 已从 133 个 case 下沉到 85 个（`main` 81 个，加上 focus-sensitive/startup-timing 4 个）。CI 会跳过 4 个需要真实桌面会话的 `main` case，因此完整 E2E 实际运行 81 个：`main` 的 77 个 case 拆成两个 macOS shard（39/38），其余 4 个使用独立串行 Job。两个 shard 在保持墙钟可控的同时，比原来的三个 shard 少一次完整依赖安装和构建；后续继续下沉时仍应按历史耗时而不只是 case 数重新评估。

同一 Pull Request 或 `main` 分支有新提交时，旧 CI run 会被取消，只保留最新提交继续占用 runner。Pull Request 按稳定的 PR 编号分组，`main` 按分支 ref 分组；不同 Pull Request 互不取消。合并后的 `main` 提交仍会重新运行一次集成结果，不复用 Pull Request merge ref 的结论。

所有会执行 `npm ci` 的 Job 都同时缓存 npm 下载与按操作系统、CPU 架构隔离的 Electron binary 下载。第一次 `npm ci` 最多运行 8 分钟；失败后只重试一次，第二次失败即让 Job 失败。这个重试只覆盖依赖下载等瞬时故障，不给 Playwright 测试增加自动重试，也不会把确定性的测试失败伪装成成功。

不要把 `test:unit` 按“平台相关/无关”拆开。整个单元套件并行跑完只需十几秒，拆分省不下时间，却要求每个新增测试都正确归类，漏标就会静默地跑错 Job 或者哪个 Job 都不跑。

在只有 Windows Job 的时期，macOS 专属缺陷只能等到发版才可能暴露，且未必暴露：`fileChanges` 的 watcher 在 macOS 上丢弃删除事件的缺陷在 v0.3.3 中已经存在，而当时的 macOS 发版 Job 恰好通过了。

## 日常开发

Windows 本地环境使用 `npm.cmd` 和 `npx.cmd`：

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run test:unit
npm.cmd run harness:check
npm.cmd run test:e2e:smoke
```

根据改动范围继续执行 `docs/harness.md` 中规定的定向测试或完整 E2E。普通 CI 会在 Pull Request 和 `main` 提交上重复执行关键检查，但不能替代开发者本地验证。

## 手动跨平台预构建

以下情况应在正式打标签之前手动运行一次 `Release` 工作流：

- 新增或升级 Electron、electron-builder、`node-pty`、`@parcel/watcher` 等平台或原生依赖；
- 修改 `package.json` 中的 `build` 配置、图标、额外资源或安装包名称；
- 修改 BrowserWindow 启动、终端、文件监听、资源定位或启动迁移；
- 首次增加新的操作系统或 CPU 架构。

操作步骤：

1. 打开仓库的 **Actions → Release → Run workflow**。
2. 选择要验证的分支并运行。
3. 等待三个 Build Job 全部通过。
4. 在该次运行的 Artifacts 中检查三个平台的文件。手动运行不会创建 GitHub Release。

Release 工作流会在目标系统上重新执行 `npm ci`，禁止跨平台复用 `node_modules`。这是为了确保原生依赖来自正确的平台。macOS 使用 ad-hoc 签名，不需要 Apple 开发者账号；它不等同于 Developer ID 签名或 Apple 公证。

## 正式发版

### 1. 准备版本

确认工作区干净、目标提交已经合入 `main`，并更新 `package.json` 与 `package-lock.json` 中的版本。`build.directories.output` 使用 `release/v${version}`，不需要再手动修改输出目录。

建议先运行完整的无界面发布门禁：

```powershell
npm.cmd run build
npm.cmd run test:unit
npm.cmd run harness:check
npm.cmd run test:e2e
npm.cmd run dist:win
npm.cmd run test:packaged
```

`npm.cmd run harness:release` 还包含可见的 headed acceptance，仅在前台窗口不会干扰当前使用时运行。

### 2. 先做云端预构建

按照上一节手动运行 `Release`。正式标签只应指向已经通过本地门禁和跨平台预构建的提交。

### 3. 提交并打标签

版本提交推送到 `main` 后创建标签。标签必须严格等于 `v` 加 `package.json` 的版本，否则工作流会立即失败：

```powershell
git switch main
git pull --ff-only
$releaseVersion = (Get-Content package.json | ConvertFrom-Json).version
git tag "v$releaseVersion"
git push origin "v$releaseVersion"
```

不要把已有公开标签强制移动到另一个提交。如果标签构建暴露了必须修改的问题，修复后递增补丁版本并发布新标签。

### 4. 等待 Release 完整发布

标签触发以下并行任务：

- Windows x64：NSIS 安装包、blockmap 和 `latest.yml`；
- Linux x64：`Jasmine-<version>-linux-x86_64.AppImage` 和 `Jasmine-<version>-linux-amd64.deb`；
- Apple Silicon macOS：arm64 DMG；

每个任务均执行构建、单元测试、原生打包和 `test:packaged`。Linux 中涉及 Electron 窗口的测试通过 `xvfb-run` 使用虚拟显示。Windows 任务另外执行 Harness 检查与 E2E smoke。只有三个平台全部成功，Publish Job 才会继续。

Publish Job 会拒绝缺少或重复的目标产物，生成 `SHA256SUMS.txt`，然后创建或幂等更新对应 GitHub Release。不要在工作流仍运行时手工创建同名安装包或覆盖 Release Assets。

### 5. 最终核验

交付前至少检查：

- Release 标签、标题、提交 SHA 与预期一致；
- Windows EXE、Linux AppImage/deb、Apple Silicon macOS DMG、blockmap、`latest.yml` 和 `SHA256SUMS.txt` 均存在；
- `SHA256SUMS.txt` 覆盖每个安装与更新产物；
- GitHub Actions 的三个平台 Build Job 和 Publish Job 全部成功；
- Windows 应用内更新仍能读取 `latest.yml`。macOS 与 Linux 当前通过 Release 页面手动更新。

## 安装包与签名说明

### Windows

Windows 安装包当前未做商业代码签名，SmartScreen 可能显示未知发布者。用户应从本仓库 Release 下载并核验 SHA-256。

### macOS

Jasmine 仅发布 Apple Silicon（arm64）DMG，不支持 Intel Mac。DMG 使用 ad-hoc 签名且未公证。可信用户首次打开时可能需要前往 **系统设置 → 隐私与安全性 → 仍要打开（Open Anyway）**。企业管理的 Mac 可能禁止此操作。

面向普通用户发布、希望消除 Gatekeeper 提示时，应加入 Apple Developer Program，并在 GitHub Secrets 中配置 Developer ID 证书和公证凭据，再将 `mac.identity` 与 `hardenedRuntime` 调整为正式签名配置。证书、密码、API Key 不得写入仓库、日志或构建产物。

### Linux

AppImage 是便携版本，首次运行前可能需要执行 `chmod +x`；deb 面向 Debian、Ubuntu 等发行版。当前未维护 apt 软件源，也未对软件仓库元数据做 GPG 签名。

## 失败处理

- 先打开失败 Job，定位首次失败的命令，不要只看最后的汇总错误。
- 单个平台失败时，其他平台会继续运行以暴露全部兼容性问题；Publish Job 不会执行。
- 修复应同时补充能够覆盖该失败的自动化检查。例如平台资源路径问题应进入 `test:packaged`，产物缺失应进入 `tests/unit/release-workflow.mjs`。
- 手动预构建可以反复运行；同一 ref 上更新的手动运行会取消旧运行，只保留最新一次。正式标签构建使用与手动运行隔离的并发组，永不因手动运行或其他标签而取消。标签触发的正式构建失败后，遵循新的补丁版本流程，不强推旧标签。
- Actions Artifacts 只保留 7 天；正式交付物以 GitHub Release Assets 为准。
