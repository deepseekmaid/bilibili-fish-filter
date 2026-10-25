<div align="center">

# B站大肥鱼过滤器

**——让你的 B站评论区充满卖萌的大肥鱼！**

![版本](https://img.shields.io/badge/version-v1.04-4d6bfe) ![许可](https://img.shields.io/badge/license-MIT-green) ![平台](https://img.shields.io/badge/Chrome%20%7C%20Edge%20%7C%20Tampermonkey-ok-4d6bfe)

</div>

按昵称和正文挑评论的 B 站评论区过滤器。三条规则各自可以设挡，也能组合成并集或交集；命中的留下，其余隐藏。扩展与油猴脚本共用同一套规则和同一个设置面板。

![设置面板](docs/popup-v1.04.png)

## 功能

- **三条规则**：昵称含「鱼」、正文含 @、正文含「主人」，每条独立设挡
- **并集 / 交集**：命中任意一条即保留，或全部命中才保留
- **自动加载**：评论被过滤光时继续往下加载，不改变页面滚动位置
- **快速模式**：加载期间跳过逐条过滤，先装满再一次性处理
- **两种形态**：Chrome / Edge 扩展与油猴脚本，界面和逻辑同源

## 实际效果

![规则实测](docs/demo-v1.04.png)

## 三条规则

| 规则 | 默认 | 保留条件 | 例子 |
| --- | --- | --- | --- |
| 规则一 · 昵称含「鱼」 | **开** | 作者昵称里出现 `鱼` 或 `魚` | `大肥鱼`、`小鱼干儿`、`鱻魚` |
| 规则二 · 正文含 @ | **关** | 三挡：包含 `@` ／ 以 `@` 开头 ／ 关 | 包含档：`笑死 @小红`；开头档：`@小红 快看` |
| 规则三 · 「主人」 | **以主人开头** | 三挡：包含「主人」／ 以「主人」开头 ／ 关 | `主人早上好`、`今天主人不在`（包含档） |

白名单语义：**只留命中的，其余隐藏**。默认只开规则一，页面上就只剩昵称带鱼的评论。

## 组合方式

| 组合 | 判定 | 适用场景 |
| --- | --- | --- |
| **并集**（默认） | 命中任意一条就保留 | 想尽量多留一点 |
| 交集 | 所有规则都命中才保留 | 只要最严格的那批 |

规则全部关掉时不做任何过滤。

## 安装

### Chrome / Edge 扩展

1. 下载 [`bilibili-fish-filter-v1.04.zip`](https://github.com/deepseekmaid/bilibili-fish-filter/releases/latest) 并解压；
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），右上角开启「开发者模式」；
3. 点「加载已解压的扩展程序」，选择解压出的 `bilibili-fish-filter/` 目录；
4. 刷新已打开的 B 站页面。

也可以 `git clone` 后直接加载仓库根目录。

### 油猴脚本（Tampermonkey / Violentmonkey）

油猴脚本不需要打包、不需要开开发者模式，装好脚本管理器即可。整个过程三步。

#### 第 1 步 · 装脚本管理器

| 浏览器 | 安装方式 |
| --- | --- |
| Chrome | [Chrome 应用商店 · Tampermonkey](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) |
| Edge | [Edge 加载项 · Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) |
| Firefox | [Firefox 附加组件 · Tampermonkey](https://addons.mozilla.org/firefox/addon/tampermonkey/) |

装好后浏览器右上角会出现 Tampermonkey 图标（橙色方块），没看到就点拼图图标把它固定出来。

#### 第 2 步 · 安装脚本

**方式 A（推荐）**：点这个链接，Tampermonkey 会自动打开安装页，点「安装」：

> https://github.com/deepseekmaid/bilibili-fish-filter/raw/main/dist/bilibili-fish-filter.user.js

**方式 B**：如果点开只是一页代码、没有安装按钮（浏览器把 `.user.js` 当普通文本打开了），用这个兜底流程：

1. 复制地址栏里的完整 URL；
2. 点 Tampermonkey 图标 → **管理面板**；
3. 切到 **实用工具 / Utilities** 标签页；
4. 在 **Import from URL / 从 URL 安装** 里粘贴 URL，点「安装」；
5. 安装页里确认名称是「B站大肥鱼过滤器（油猴版）」、版本是 `1.0.4`，点「安装」。

**方式 C**：完全离线也能装：在脚本链接页面全选复制代码 → 管理面板 → 点「+」新建脚本 → 全选删除 → 粘贴 → `Ctrl+S` 保存。

#### 第 3 步 · 确认生效

1. 点 Tampermonkey 图标 → 「管理面板」，列表里应出现 **B站大肥鱼过滤器（油猴版）**，版本 `1.0.4`，状态为已启用；
2. 打开任意 B 站视频页并刷新；
3. 页面**右下角**出现一个蓝色圆形按钮，点开就是设置面板。

看不到按钮时依次检查：脚本是否被禁用、当前标签页是不是 `www.bilibili.com` 开头的地址、浏览器是否在无痕窗口（无痕默认不运行脚本）。

#### 更新脚本

重新点一次上面的安装链接，Tampermonkey 会打开安装页并覆盖成新版本。

脚本**没有**写 `@updateURL`，Tampermonkey 不会在后台自动升级——想换版本时手动装一次即可。

> 如果之前装过更早的构建（`@namespace` 还是占位地址），它会被识别成另一个脚本并与新版并存。请先在管理面板把旧的删掉，再装这一版。

## 使用

- 点工具栏图标（扩展）或右下角按钮（油猴）打开面板，任何改动即时生效，不需要刷新；
- 油猴版右下角的**蓝色悬浮球可以拖动**：按住它拖到任意位置，位置会记住；没手动摆过面板时，面板默认出现在球的上方；
- 面板本身也可以拖动：按住顶栏（左侧有 ⠿ 把手）或任意空白处，位置同样会记住；
- 面板底部显示当前页「保留 N 条 / 共 M 条」；
- 主评论被隐藏时，整个楼层（含「共 N 条回复」）会一起收起，该楼下的楼中楼不会再展开。

## 常见问题

**打开后评论区几乎空了？** 白名单默认只放行昵称带鱼的评论，这是规则本身的结果；调低挡位或关掉规则即可恢复。

**选了交集后一条都不显示？** 规则二「以 @ 开头」与规则三「以主人开头」不可能同时满足，交集会得到空集。

**加载时会滚动页面吗？** 不会。自动加载优先直接驱动评论区组件；只有在评论区尚未挂载的页面上，才会用一个不可见的滚动脉冲触发懒加载，并立即把位置还原。

## 隐私

扩展不发起任何网络请求；只申请 `storage` 一个权限；仅在 `www.bilibili.com`、`t.bilibili.com`、`space.bilibili.com`、`live.bilibili.com` 运行；隐藏只作用于当前页面 DOM，刷新即恢复。

## 开发

需要 Node.js >= 20。

```bash
npm install
npm test               # 48 项断言：扩展 38 + 后挂载 1 + 面板 3 + 油猴 6（跑前自动重建油猴脚本）
npm run build          # 生成 dist/ 下的 zip 与 .user.js
npm run version:check  # 校验 manifest / package / 油猴 @version 三处一致
```

### 目录结构

```
├── manifest.json                 MV3 清单
├── content.js                    过滤逻辑（扩展与油猴共用）
├── popup.html / popup.js         设置面板（油猴版直接复用）
├── icons/                        16 / 32 / 48 / 128 图标
├── dist/                         构建产物：zip + .user.js
├── docs/                         README 截图
├── scripts/
│   ├── build.mjs                 零依赖打 zip
│   ├── build-userscript.mjs      由 content.js 生成油猴脚本
│   ├── check-version.mjs         版本一致性校验
│   ├── set-version.mjs           版本号切换
│   └── userscript/               油猴适配层与素材（tail.js、fab.webp）
├── test/                         扩展 / 面板 / 油猴断言
└── .github/workflows/ci.yml      测试 → 构建 → 版本校验
```

## 许可

[MIT](LICENSE)

##插件由 GPT-6-astra 协助制作。
