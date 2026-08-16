# Steam Sync

从 Steam 拉取游戏库，按「资源」模板创建游戏笔记，并同步已有笔记的游玩时长和成就。实验性支持 PSN、Xbox、Epic 游戏库读取。

## 安装

1. 在第三方插件里启用 `Steam Sync`
2. 设置里填写对应平台的授权信息
3. 点左侧手柄图标，或命令面板执行对应命令

## Steam（正式）

- 设置：Steam API Key（<https://steamcommunity.com/dev/apikey>）+ Steam ID（游戏详情需公开）
- 命令：`获取 Steam 游戏数据` / `同步已有 Steam 游戏时长与成就`
- 已有游戏按 `steam_appid` 或「英文名」匹配，直接更新 `时长` 和 `成就`
- 读取本地 Steam 库：路径、大小、已下载/未下载状态
- 封面优先使用 SteamGridDB，未配置时回退 Steam 商店封面

## PSN（实验性）

- 设置：PSN Access Token（可用 `psn-api` / `psnawp` 获取）；也可填 NPSSO 尝试自动交换
- 命令：`获取 PSN 游戏数据`
- 读取：游戏列表、最近游玩、封面；`时长` 仅在接口返回时写入，否则为「未游玩」
- 已有笔记按 `psn_appid` 或「英文名」匹配

## Xbox（实验性）

- 设置：Xbox XBL3.0 Authorization（可用 OpenXbox/xbox-webapi-python 获取）；xuid 可留空自动获取
- 命令：`获取 Xbox 游戏数据`
- 读取：游戏列表、最近游玩、封面；`时长` 仅在接口返回时写入
- 已有笔记按 `xbox_appid` 或「英文名」匹配

## Epic（实验性）

- 设置：可填 Epic Access Token 读取完整游戏库；不填则读取本地 `*.item` 清单中的已安装游戏
- 命令：`获取 Epic 游戏数据`
- 读取：游戏列表、已安装游戏的路径和大小；Epic 平台本身不提供可靠的游玩时长，`时长` 通常为「未游玩」
- 已有笔记按 `epic_appid` 或「英文名」匹配

## 笔记匹配与创建

- 扫描范围：`笔记文件夹` 下所有 md，以及 frontmatter `类型: 游戏` 的 md
- 新游戏在弹窗中勾选后批量创建，自动追加到「索引文件」
- 模板占位符：`{{name}} {{english_name}} {{appid}} {{playtime}} {{playtime_hours}} {{playtime_minutes}} {{last_played}} {{achievements}} {{achievement_list}} {{cover}} {{status}} {{source}} {{path}} {{size}} {{date}}`
- 非 Steam 平台创建时，会把默认模板中的 `来源: Steam` 和 `steam_appid` 替换为对应平台字段

## 成就（Steam）

- frontmatter 写入 `成就: 12/54`，看板卡片会显示完成度
- 笔记底部 `## 成就` 写成 Markdown 表格：图标、名字、说明、时间、所有玩家完成百分比
- 图标用表格单元格里的 `<img>`，避免 `![|48]` 把表格拆坏
- 数据写在笔记本地，打开预览不必再实时请求 Steam
- 没有 Steam 成就、或统计未公开的游戏会写成 `无`

## 发布到 GitHub

### 方式 A：自动创建仓库并推送（推荐）

1. 先安装并登录 GitHub CLI：
   ```powershell
   winget install GitHub.cli
   gh auth login
   ```
2. 双击 `create_and_push_github.bat`
3. 脚本会自动创建公共仓库 `obsidian-steam-sync` 并推送

> 想创建私有仓库，把脚本里的 `--public` 改成 `--private`。

### 方式 B：手动创建仓库后推送

1. 在 github.com 新建空仓库（不要勾选 README）
2. 双击 `push_to_github.bat`
3. 输入仓库地址，例如 `https://github.com/你的用户名/obsidian-steam-sync.git`

`.gitignore` 已忽略 `data.json`，不会把 API Key / Token 推上去。

## 说明

- PSN / Xbox / Epic 接口多为社区逆向或客户端接口，可能随平台更新失效，仅供实验使用
- Token / Authorization / NPSSO 都是账号凭证，保存在插件 `data.json`，请勿分享
- 本插件为桌面端插件（`isDesktopOnly: true`）
