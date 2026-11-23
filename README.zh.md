# dsh-session-delete-lite

DSH 有归档、置顶、重命名、分叉，但没有删除会话。这个插件只补这一件事。

## 功能

- 侧栏每个会话的 `⋯` 菜单里多一项 **删除会话**。
- 会话运行中或等你确认时，该项置灰。
- 弹一次确认框，确认后真删。

删除会清掉 DSH 为该会话指定的 JSONL 目录、列表登记、投影缓存和溢出的工具结果。默认目录和自定义目录都支持。插件会向 DSH 确认会话记录已经消失，再提示成功。**删除后无法恢复。**

SQLite 把多个会话保存在同一个数据库里。遇到这种存储方式，确认框会显示原因，并保留会话和侧栏登记。

如果删的正是你在看的会话，界面会切到同工作区的新会话。如果清理未完成，确认框会显示提示，你可以在同一个框里重试。

## 安装

```bash
dsh plugin --profile desktop add github:GTilor/dsh-session-delete
```

也可以装本地目录：**插件** → **添加插件** → 选这个文件夹。装完重启 DSH。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-session-delete-lite
```

## 实现

`index.js` 处理 `POST /_dsh-session-delete/delete`。`client.js` 通过 DSH 的 `sidebar.workspaces.session.menu.item` 和 `shell.overlay` 槽位渲染菜单项和确认框。

确认删除时，插件会重新检查 DSH 报告的活动。如果 DSH 的 Agent 仍持有会话，确认框会提示重启 DSH 后重试。其余会话走宿主的卸载流程，再通过工作区服务更新登记并清理文件。

在项目目录运行 `npm test` 即可用临时会话执行回归测试。

## 版本要求

DeepSeek Harness `^0.2.3-alpha.2`。桌面版与 `dsh web` 共用 Web 侧接口。删除接口已在 `dsh web` 宿主上验证。

## 许可

MIT。
