# dsh-power-type

[English](README.md) | 中文

为 **DeepSeek Harness（DSH）Web 输入框**添加 Power Mode 打字特效。

![Power Type 特效演示](demo/preview.gif)

## 功能

- 光标粒子与文字发光残影。
- 输入区域震动与连击计数。
- 支持中文等输入法的组合输入。
- Enter 触发粒子爆发与冲击波。

## 安装

需要 DSH Web `>=0.2.1-rc.2 <0.3.0`。直接从 GitHub 安装：

```sh
dsh plugin --profile web add github:huangzhilin-hzl/dsh-power-type
```

如果从源码运行 DSH，请在 **DSH 仓库根目录**执行：

```sh
pnpm dsh plugin --profile web add github:huangzhilin-hzl/dsh-power-type
```

安装后重启 DSH Web 并刷新页面，插件无需构建。

本地开发时，也可以从插件目录安装：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-power-type
```

本地安装使用目录链接，请保留该目录。

## 使用

在输入框中打字即可，特效默认开启。可在 **插件 → 已安装插件 → Power Type** 中启用或停用插件。

在浏览器控制台调整特效强度：

```js
window.__dshPowerType.setIntensity(1.5) // 默认 1，范围 0.2–2.5
```

强度设置保存在当前浏览器本地。

## 卸载

```sh
dsh plugin --profile web remove dsh-power-type
```

从 DSH 源码运行时，将 `dsh` 替换为 `pnpm dsh`。

## 开发

先在 DSH 源码仓库中安装依赖，再从本插件目录运行：

```sh
export DSH_CHECKOUT=/absolute/path/to/deepseek-harness
node --test test/engine.test.mjs
node --test test/browser.test.mjs
node --test test/dsh.test.mjs
```

浏览器测试需要 Chrome/Chromium。DSH 集成测试还需要 `pnpm`，以及 DSH 仓库中已构建的 `apps/web/dist`。可通过 `CHROME_PATH` 和 `DSH_TEST_PNPM` 指定可执行文件路径。

设置 `DSH_PLUGIN_SPEC=github:huangzhilin-hzl/dsh-power-type`，可验证远程包的 DSH 集成。

打开 [demo/index.html](demo/index.html) 可查看独立视觉演示。
