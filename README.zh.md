# dsh-session-delete-lite

一个极简的 DeepSeek Harness（DSH）插件，只提供**从侧栏删除会话**的功能。

[English](README.md)

## 安装

在 DSH 打开 **插件 → 添加插件**，粘贴下面的地址。安装并启用后重启 DSH。

```text
github:GTilor/dsh-session-delete#v1.0.2
```

也可以在退出桌面版后用命令行安装。用 Web 版时，把 `desktop` 换成 `web`。

```bash
dsh plugin --profile desktop add github:GTilor/dsh-session-delete#v1.0.2
```

你也可以下载安装包，在 **添加插件** 里填入文件的本地路径。[下载 v1.0.2 安装包](https://github.com/GTilor/dsh-session-delete/releases/download/v1.0.2/dsh-session-delete-lite-1.0.2.tgz)

## 使用演示

从侧栏的 **⋯ → 删除会话** 确认删除正在查看的「周末阅读笔记」。删除成功后，侧栏里还能看到「下周安排」，界面回到同一工作区的新会话。

![从侧栏删除周末阅读笔记，出现会话已删除提示，下周安排仍在列表中](docs/delete-session-demo.gif)

## 功能

- 侧栏每个会话的 `⋯` 菜单里多一项 **删除会话**。
- 会话运行中或等你确认时，该项置灰。
- 确认框会单独显示会话名，方便点「永久删除」前核对。
- 删除成功时，顶部会出现带绿色圆勾的「会话已删除」。失败或清理未完成时，顶部会出现琥珀色提示，原因留在确认框内，可以直接重试。

删除会清掉 DSH 为该会话指定的 JSONL 目录、列表登记、投影缓存和溢出的工具结果。默认目录和自定义目录都支持。插件会向 DSH 确认会话记录已经消失，再提示成功。**删除后无法恢复。**

SQLite 把多个会话保存在同一个数据库里。遇到这种存储方式，确认框会显示原因，并保留会话和侧栏登记。

空闲会话可以直接从侧栏删除，包括刚刚切走的会话。如果删的正是你在看的会话，界面会切到同工作区的新会话。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-session-delete-lite
```

## 实现

`index.js` 处理 `POST /_dsh-session-delete/delete`。`client.js` 通过 DSH 的 `sidebar.workspaces.session.menu.item` 和 `shell.overlay` 槽位渲染菜单项和确认框。

桌面和 Web 界面打开会话时，`web-agents.js` 会保留 DSH 为这条会话提供的关闭句柄。确认删除时，插件检查正在运行的任务和排队的用户消息，关闭空闲会话，再向存储服务取得独占写入权。会话文件会移到 DSH 扫描范围之外，随后清理缓存、侧栏登记和暂存文件。如果清理中断，插件会在下次启动时继续。若另一个组件或进程仍在使用该会话，确认框会说明原因。

在项目目录运行 `npm test` 即可用临时会话执行回归测试。

## 版本要求

支持 DeepSeek Harness `0.2.2-rc.5` 和 `^0.2.3-alpha.2`。已在 `0.2.2-rc.5` 和 `0.2.3-alpha.2` 的 Web 界面实测删除当前会话和切走后的会话。桌面版与 `dsh web` 共用侧栏和会话控制器。

## 许可

MIT。
