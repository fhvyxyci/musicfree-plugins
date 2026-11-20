# MusicFree 插件订阅源

给 [MusicFree](https://github.com/maotoumao/MusicFree) 用的插件订阅源。订阅一次，之后点「更新订阅」就能把这几个插件一起装上 / 一起更新。

| 插件 | 版本 | 需要填什么 |
| --- | --- | --- |
| **蓝奏云** | 0.0.16 | 账号 + 密码（可选填 Cookie 兜底） |
| **阿里云盘** | 0.0.8 | 刷新令牌 refresh_token |

两个插件都是「把网盘当音乐库」：全盘搜索、把音乐目录下的文件夹当歌单/专辑、按目录浏览、递归汇总全部歌曲、播放直链、自动找同目录同名 `.lrc` 歌词、读文件内嵌标签。

---

## 一、桌面版：一条链接订阅全部

1. 打开 **设置 → 插件管理**
2. 点 **订阅设置**（在插件列表上方）
3. 点「添加」，备注随便写（比如 `fhvyxyci`），链接填：

   ```
   https://fhvyxyci.github.io/musicfree-plugins/plugins.json
   ```

4. 「保存」
5. 回到插件管理页，点 **更新订阅**

两个插件会一次性装上；以后想全量更新，还是点这个「更新订阅」。

> 订阅源是一个 JSON 清单（顶层 `plugins` 数组，每项带一个 `url` 指向插件文件）。这是 MusicFree 桌面版 `installPluginFromRemoteUrl` 认的格式：结尾是 `.json` 就按清单逐条安装，结尾是 `.js` 就当成单个插件。

## 二、手机版：逐个装（不支持 JSON 清单）

手机版的「从网络安装」是把响应体**直接当插件 JS 代码**执行的，所以填 `.json` 会报错，只能一个插件一个地址：

```
https://fhvyxyci.github.io/musicfree-plugins/plugins/lanzou.js
https://fhvyxyci.github.io/musicfree-plugins/plugins/aliyundrive.js
```

装好之后，手机版会对已启用的插件**每天自动检查一次更新**（读的就是你安装时那个地址），所以不用手动盯着版本。

手机想一次装两个，可以用深链（应用支持 `musicfree://install/<地址1>,<地址2>`）：

```
musicfree://install/https%3A%2F%2Ffhvyxyci.github.io%2Fmusicfree-plugins%2Fplugins%2Flanzou.js,https%3A%2F%2Ffhvyxyci.github.io%2Fmusicfree-plugins%2Fplugins%2Faliyundrive.js
```

## 三、插件说明

### 蓝奏云

- 变量：**账号**、**密码**，可选 **Cookie**（登录被风控时的兜底）、可选 **音乐目录 ID**（只扫某个目录）
- 登录走 `pc.woozooo.com`（这个入口不弹反爬挑战）；会话过期（`zt=9`）会自动重登
- 蓝奏云没有服务端搜索，插件会自建递归索引；手机端第一次搜索要等几秒，之后是本地过滤
- 源码与文档：https://github.com/fhvyxyci/musicfree-plugin-lanzou

### 阿里云盘

- 变量：**refresh_token**（必填），以及云盘类型（默认云盘 / 资源库 / 备份盘 / 全部）
- 基于阿里云盘官方开放平台 API，只需要一个刷新令牌
- 源码与文档：https://github.com/fhvyxyci/musicfree-plugin-aliyundrive

## 四、关于更新

- 本仓库 `plugins/` 下的两个文件是**发布副本**，与各自源码仓库的正式版保持同步；每个插件的完整文档、更新日志、issue 都在上面那两个仓库里
- 桌面版点「更新订阅」拉的就是这里的副本；手机版每天自动更新，读的是你安装时填的那个地址
- 想只用单个插件，也可以直接装各自仓库的 Pages 地址，功能完全一样

## 五、协议

本仓库与其收录的两个插件均为 **AGPL-3.0-or-later**（见 [LICENSE](./LICENSE)）。两个插件的版权归其作者所有：

- 蓝奏云插件：Copyright (C) 2026 fhvyxyci
- 阿里云盘插件：Copyright (C) 2026 fhvyxyci

蓝奏云插件中的 `acw_sc__v2` 反爬算法移植自 [OpenList](https://github.com/OpenListTeam/OpenList) 的 `drivers/lanzou`（AGPL-3.0），因此沿用 AGPL-3.0。

## 六、免责声明

插件只做「读取你自己网盘里的音乐并交给 MusicFree 播放」，不提供、不存储、不分发任何音乐内容，也不绕过任何付费或版权限制。请确保你播放的内容你有权访问。使用第三方接口存在失效风险，接口变化导致的不可用会尽量修，但不作保证。
