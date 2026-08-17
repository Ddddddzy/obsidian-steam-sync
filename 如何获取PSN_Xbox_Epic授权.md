# 如何获取 PSN / Xbox / Epic 授权

这三个平台的授权凭证都可以用 **浏览器开发者工具（F12）** 直接拿到，不需要会编程。核心思路：

> 先登录对应平台网页版 → 打开 F12 Network → 在网页上点点点 → 找平台 API 请求 → 复制请求头里的 Authorization。

---

## 一、PSN：获取 Access Token（或 NPSSO）

### 方法 A：从浏览器 Network 拿 Access Token（推荐）

1. 打开 Chrome / Edge，访问 <https://store.playstation.com>
2. 登录你的 PSN 账号
3. 按 `F12` 打开开发者工具，切到 **Network（网络）** 标签
4. 在过滤框输入：`np.playstation.net`
5. 回到网页，点击你的头像、游戏库、或任意会加载游戏列表的页面
6. 在 Network 里会出现一些请求，点开任意一个 `m.np.playstation.net` 或 `dps.psn.playstation.net` 开头的请求
7. 在右侧 **Headers（标头）** → **Request Headers** 里找到：
   ```
   Authorization: Bearer eyJxxxxxxxxxxxxxxxx...
   ```
8. 复制 `Bearer` 后面的整串内容
9. 粘贴到 Obsidian 插件设置的：
   **Steam Sync → PSN Access Token**

### 方法 B：从浏览器 Cookie 拿 NPSSO

1. 保持登录 <https://store.playstation.com>
2. 按 `F12`，切到 **Application（应用）** 标签
3. 左侧展开 **Cookies** → 点击 `https://store.playstation.com`
4. 找到名字叫 `npsso` 的 Cookie
5. 复制它的值
6. 粘贴到插件设置的：
   **Steam Sync → PSN NPSSO**

> 插件会先尝试用 NPSSO 自动交换 Access Token。如果自动交换失败，请用方法 A 直接填 Access Token。

---

## 二、Xbox：获取 XBL3.0 Authorization

1. 打开 Chrome / Edge，访问 <https://account.xbox.com>
2. 登录你的微软账号
3. 按 `F12`，切到 **Network（网络）** 标签
4. 在过滤框输入：`xboxlive.com`
5. 回到网页，打开“游戏”、“成就”或“个人资料”相关页面
6. 在 Network 里找发往以下域名的请求：
   - `titlehub.xboxlive.com`
   - `profile.xboxlive.com`
   - `achievements.xboxlive.com`
7. 点开这个请求，在 **Request Headers** 里找到：
   ```
   Authorization: XBL3.0 x=...;...;...
   ```
8. 复制**完整的 Authorization 值**，包括 `XBL3.0` 前缀
9. 粘贴到插件设置的：
   **Steam Sync → Xbox XBL3.0 Authorization**
10. `Xbox xuid` 可以先留空，插件会尝试自动获取

> 如果在 `account.xbox.com` 抓不到，也可以登录 <https://www.xbox.com/play> 再试。关键是找发往 `xboxlive.com` 域名的请求。

---

## 三、Epic：获取 Access Token（或直接读本地）

### 方式 A：不填 Token，直接读本地已安装游戏（最简单）

1. 插件设置里 **Epic Access Token 留空**
2. 确认 **Epic 本地清单目录** 是：
   ```
   C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests
   ```
3. 运行命令 `获取 Epic 游戏数据`

> 这种方式只能拿到“已安装”的游戏，时长通常为「未游玩」。

### 方式 B：从浏览器 Network 拿 Access Token（读完整游戏库）

1. 打开 Chrome / Edge，访问 <https://store.epicgames.com>
2. 登录你的 Epic 账号
3. 按 `F12`，切到 **Network（网络）** 标签
4. 在过滤框输入：`epicgames.com`
5. 回到网页，点击你的头像、愿望单或游戏库
6. 在 Network 里找发往以下域名的请求：
   - `account-public-service-prod03.ol.epicgames.com`
   - `library-service.live.use1a.on.epicgames.com`
   - `store-site-backend-static-ipv4.ak.epicgames.com`
7. 点开请求，在 **Request Headers** 里找到：
   ```
   Authorization: Bearer eyJxxxxxxxxxxxxxxxx...
   ```
8. 复制 `Bearer` 后面的整串内容
9. 粘贴到插件设置的：
   **Steam Sync → Epic Access Token**
10. 再运行命令 `获取 Epic 游戏数据`

---

## 常见问题

- **Network 里没有请求？**
  先清空列表（点 Network 左上角禁止图标），再重新点网页。
- **Authorization 是空的？**
  可能你点的不是 API 请求。优先找域名里带 `np.playstation.net`、`xboxlive.com`、`epicgames.com` 的请求。
- **Token 会过期吗？**
  会。过期后再按同样方法复制一次，或者用对应工具（psn-api / psnawp / OpenXbox）获取长期刷新凭证。
- **这些凭证安全吗？**
  Token 等于账号授权，请勿分享、截图、上传 GitHub。本插件的 `data.json` 已被 `.gitignore` 忽略。
