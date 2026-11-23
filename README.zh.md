# dsh-session-delete-lite

DSH 有归档、置顶、重命名、分叉，但没有删除会话。这个插件只补这一件事。

## 功能

- 侧栏每个会话的 `⋯` 菜单里多一项 **删除会话**。
- 会话运行中或等你确认时，该项置灰。
- 弹一次确认框，确认后真删。

删除会清掉 `~/.dsh/sessions/` 下的会话目录、列表登记、投影缓存和溢出的工具结果。**删了找不回来**——归档只是收起来，这个是真删。

如果删的正是你在看的会话，界面会切到同工作区的新会话。万一这次删不彻底，会先隐藏并直接告诉你。

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

`index.js` 注册两个私有路由（`/_dsh-session-delete/status`、`/_dsh-session-delete/delete`）干活；`client.js` 通过 DSH 自己的槽位（`sidebar.workspaces.session.menu.item`、`shell.overlay`）渲染菜单项和确认框，不碰其它界面。

删除仍在内存里的会话需要卸载，DSH 没有公开接口；插件走框架自己的拆解流程，每一步都做能力探测，探测失败就隐藏该行并如实告知，不谎称删干净。

## 版本要求

DeepSeek Harness `^0.2.3-alpha.2`。桌面版与 `dsh web` 用的是同一套 Web 侧接口，目前只实测了桌面版。

## 许可

MIT。改编自 Ansellwan 的 [DeepSeekHarness-Session-Delete](https://github.com/Ansellwan/DeepSeekHarness-Session-Delete)，去掉了分组清理面板。
