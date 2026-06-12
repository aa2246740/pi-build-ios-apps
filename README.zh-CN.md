# pi-build-ios-apps

[English](README.md)

![pi-build-ios-apps hero](docs/assets/hero.png)

> 让 Pi 能构建、启动，并在浏览器里调试 iOS Simulator App。

`pi-build-ios-apps` 是一个 Pi package。它把 iOS 本地验证闭环交给 Pi：
检查 Xcode，运行 `xcodebuild`，用 `simctl` 安装和启动 App，通过 `serve-sim`
镜像 Simulator，并且可以复用 cmux browser surface 做可视化调试。

它的目标不是隐藏式自动化，而是可见、可打断、可验收的本地移动 App 开发。

![真实模拟器 demo](docs/assets/demo.gif)

## 为什么需要它

很多 coding agent 能改 iOS 代码，但到了真正证明 App 能跑的时候就停住了：
构建、启动、看模拟器、点击界面、截图、报告结果，还是要人手动接上。

`pi-build-ios-apps` 补齐的就是这段本地运行时验证。

它让 Pi 可以处理：

- 检查 Xcode 和 iOS Simulator 环境
- 用 `xcodebuild` list/build/test/clean/build-for-testing
- 用 `xcrun simctl` boot/install/launch/terminate/screenshot
- 为指定 Simulator UDID 启动、检查、停止和操作 `serve-sim`
- 当官方 `serve-sim` 页面卡在 `Connecting` 时，用 direct MJPEG 预览兜底
- 在 cmux browser 里复用一个预览 surface，避免 agent 不断开新标签页

## 安装

从 GitHub 安装：

```sh
pi install git:github.com/aa2246740/pi-build-ios-apps
```

项目内安装：

```sh
pi install -l git:github.com/aa2246740/pi-build-ios-apps
```

本地 checkout 安装：

```sh
pi install /path/to/pi-build-ios-apps
```

不安装，只试一次：

```sh
pi -e /path/to/pi-build-ios-apps/extensions/pi-build-ios-apps.ts \
  --skill /path/to/pi-build-ios-apps/skills/pi-build-ios-apps
```

## 快速使用

进入一个 iOS 项目：

```sh
pi
```

然后对 Pi 说：

```text
Use pi-build-ios-apps. Run the iOS doctor first, then build and launch this app
on the booted iOS Simulator. Do not modify system proxy settings. If you use a
browser preview, reuse the existing cmux browser surface unless a new one is
necessary.
```

## 工具

这个 package 注册了 6 个 Pi 工具：

| Tool | 作用 |
| --- | --- |
| `pi_ios_doctor` | 检查 Xcode、runtime、Node/npm、CocoaPods、serve-sim、cmux。 |
| `pi_ios_xcodebuild` | 对 Xcode project/workspace 运行 build/test 等动作。 |
| `pi_ios_simulator` | 管理 Simulator boot/install/launch/terminate/screenshot。 |
| `pi_ios_serve_sim` | 为一个明确 UDID 启动、检查、停止和操作 `serve-sim`。 |
| `pi_ios_preview` | 当 `Connecting` 卡住时启动 direct MJPEG 预览页。 |
| `pi_ios_cmux_open` | 在 cmux browser 中打开或复用 iOS 预览 URL。 |

## 工作流

```text
Pi 读取项目
  -> pi_ios_doctor 检查本地 Apple 工具链
  -> pi_ios_xcodebuild 构建或测试 App
  -> pi_ios_simulator 安装并启动 App
  -> pi_ios_serve_sim 镜像已启动的 Simulator
  -> pi_ios_cmux_open 复用一个 browser surface 做可视化验收
  -> Pi 报告明确的验证边界
```

## 和 pi-company 的组合

`pi-build-ios-apps` 很适合搭配
[`pi-company`](https://github.com/aa2246740/pi-company)。

`pi-company` 负责把多个可见 Pi 会话组织成本地项目团队：lead、coder、reviewer、
tester、PM、issue、worktree、gate。这个 package 让这支团队真正具备 iOS App
的构建和模拟器验收能力。

```text
人 -> pi-company lead -> coder worktree -> iOS build/run
  -> tester Simulator 验收 -> review gates -> acceptance -> merge
```

如果装了 cmux，Pi 的多个角色和 iOS 预览可以放在同一个可见工作区里：左边是 agent，
右边是模拟器浏览器预览，中间没有隐藏的云端编排器。

## React Native、Expo 和 HealthKit

它不是只适用于 SwiftUI。只要项目能通过本地 Xcode 工具链构建或启动，它就能帮上忙。

对 React Native / Expo native 项目：

- 启动 dev build 前先确保 Metro 在运行
- 用 `pi_ios_simulator` 传入 `RCT_METRO_PORT` 等 launch env
- 当 native iOS project 或模块生态需要 Pods 时，CocoaPods 仍然是现实需求
- 不要默认认为 SwiftPM 可以替代 React Native native modules 的 Pods 集成

## 安全边界

`pi-build-ios-apps` 有意保持本地、显式、可审计：

- 不修改系统代理设置。
- 不强制要求 CocoaPods，除非目标项目自己需要 Pods。
- `serve-sim` 清理只针对一个明确的 Simulator UDID。
- cmux 预览默认复用一个 browser surface。
- 要求 Pi 报告命令、URL、模拟器 ID 和验证边界。

Pi package 可以执行本地代码。安装任何第三方 package 前，都应该先审查源码。

## Demo 和隐私

仓库里的截图和 GIF 来自 synthetic `ColorTap` demo app，在本地 iOS Simulator 上生成。
它们不包含真实健康数据、私有源码、API key、代理配置、私有 Git remote 或个人机器路径。

## 需求

- macOS
- Xcode 和 iOS Simulator runtime
- Node.js 20+
- Pi coding agent
- 可通过 `npx --yes serve-sim@latest` 使用 `serve-sim`
- 可选但推荐：cmux

## 开发

```sh
npm install
npm run typecheck
npm pack --dry-run
```

本地烟测：

```sh
pi -e ./extensions/pi-build-ios-apps.ts \
  --skill ./skills/pi-build-ios-apps
```

## 非官方声明

这是一个独立的社区 package。除非特别说明，它不隶属于 Apple、OpenAI、Codex、Pi、
cmux 或 `serve-sim` 项目。

## License

Apache-2.0
