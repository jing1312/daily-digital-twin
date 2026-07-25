# Daily Digital Twin

一个运行在 Windows 本机上的个人工作替身框架：手机通过飞书派发任务，本机复用 Edge 的登录态执行网页操作，并用受限的应用目录启动桌面软件。源码公开，运行数据私有。

## 设计边界

- 本地不运行大模型；模型推理仍走你配置的兼容接口。
- 最多四个任务槽；同一软件、文件或网页标签页互斥。
- 网页使用 OpenClaw Edge 扩展的任务标签组；把标签页拖出组即可收回控制权。
- 验证码、登录弹窗和人工判断会暂停任务，验证码只在内存中传给当前页面。
- 删除、覆盖、上传、付款、发送和公开发布仍需人工确认。

## 目录

```text
src/                 公开任务内核与策略
platform/windows/    Windows 启动和 UI Automation 适配
config/*.example.*   脱敏示例配置
test/                Node 内置测试
```

私有实例放在本机的 `DAILY_TWIN_HOME` 目录（当前实例可继续使用现有 OpenClaw 目录），其中的 `state/`、`data/`、截图、日志、浏览器会话和真实应用路径不进入本仓库。

## 开发

需要 Node.js 24 或更高版本：

```powershell
npm test
npm run audit:privacy
```

初始化私有运行目录并创建任务：

```powershell
$env:DAILY_TWIN_HOME = 'D:\\your-private-runtime'
npm run runtime -- init
npm run runtime -- create '打开 Biomni，在输入框输入 TEST_TEXT'
npm run runtime -- status
```

Edge 浏览器动作通过 OpenClaw 已配对的 `chrome` profile 执行；先用 `openclaw browser extension path` 加载扩展并完成一次配对，再把需要交给替身的标签页放入 OpenClaw 标签组。

不要把真实 API Key、飞书 Secret、Cookie、任务截图或个人研究材料提交到仓库。
