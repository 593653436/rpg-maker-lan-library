# 兼容性清单

本文记录在真实项目中确认过的故障模式。游戏名仅用于互操作性说明；仓库不包含这些游戏、插件、资源或存档。

状态说明：

- **自动测试**：有纯合成回归测试，不依赖原游戏；
- **实机确认**：项目开发过程中曾由合法持有者在本地验证；
- **待用户复测**：代码边界已修复，但最终游玩由报告者确认。

| 案例 | 引擎 | 表现 | 首个根因 | 适配机制 | 状态 |
|---|---|---|---|---|---|
| エレナのご奉仕 | MZ | 进入存档后提示“存档名称无效” | `TitleImageChange` 固定读写 `titleInfo.rmmzsave`，不在桥接白名单 | 精确增加 `titleInfo`，未知名称仍拒绝 | 自动测试；实机确认 |
| SA● Ghost Protocol ver1.0 | MZ | 点击开始后黑屏 | `CsvAutoLoader.js` 在浏览器调用 `require('fs')`；旧响应还会被长缓存复用 | 完整签名命中时用同步 XHR 加载 `data/csvdata/*.csv`，插件 URL 版本化 | 自动测试；待用户复测 |
| 驱魔少女伊万杰琳之刻印的淫纹 1.0 | MV | 继续游戏卡在 `Now Loading` | 缺失的加密图片 404 被 MV 永久留在 `decrypting`；另有 `PluginCommonBase` 漏载 | 404 进入 Bitmap 原生失败链；永久失败不重试；基础插件按依赖顺序补入 | 自动测试；实机确认代码路径 |
| Scars of Summer v1.02 | MV | 回想房间不显示，误以为存档未读 | `AnotherNewGame` 使用特殊 ID `-1001`，旧桥误映射到 `config` | 固定映射 `-1001 → anotherNewGame`，同时规范真实文件大小写 | 自动测试；实机确认 |
| AnotherNewGame 4.2.0 | MZ | 额外新游戏/回想状态丢失 | 固定存档 `anotherNewGame.rmmzsave` 未桥接 | 精确固定名称白名单 | 自动测试 |
| PluginCommonBase 依赖组 | MV/MZ | `PluginManagerEx is not defined` | 插件文件存在，但 `$plugins` 漏掉基础插件或顺序错误 | 仅在已知依赖启用且基础文件存在时插入依赖之前 | 自动测试 |
| Text2Frame / DRS_AllDataExtractor | MV/MZ | 浏览器启动时报 `require is not defined` | 编辑器/测试模式开发工具被错误打进正式插件列表 | 完整开发工具签名命中时禁用；不伪造通用 `require` | 自动测试 |
| MoviePicture | MV/MZ | 手机视频拒绝播放或无声音恢复 | 移动浏览器自动播放策略和 `playsinline` 缺失 | 静音启动、用户手势恢复、内联播放及 URL 版本化 | 自动测试 |
| Ayatam AdvancedCharacterGraphics | MV/MZ | 浏览器读取角色图片列表失败 | 插件依赖 Node `fs/path` 扫目录 | 服务端生成受限角色文件清单并注入浏览器桥 | 自动测试 |
| 凍堂ヒロカの隷雄譚所用 Node 插件组 | MZ | 浏览器启动阶段 Node/NW.js API 失败 | `PluginUtils`、`AsyncLoadImage`、`AdvExtention`、`FontDictionary` 依赖 `fs/child_process` | 按插件完整签名生成服务端文件/字体清单；不使用游戏 UUID | 自动测试；历史实机确认 |
| Drill GaugeFloatingTemporaryText | MV | 首次浮动文字因命令缓冲区为空崩溃 | `setBufferContext` 早于缓冲区初始化 | 调用上下文前按插件默认值初始化缓冲区 | 自动测试；历史实机确认 |
| 网页回想室子目录 | 非限定 | 只显示静态标题或无法导入 | 入口位于 `web/index.html`；`.mjs` MIME 错误 | 自动识别 `web/` 根，`.mjs` 返回 JavaScript MIME | 自动测试；历史实机确认 |
| KiriKiri 2 / KRKR（`data.xp3`） | KRKR2 | 桌面专用格式无法在手机/浏览器运行 | 无浏览器运行时 | WebAssembly 运行时 + 源目录按需虚拟 ZIP 映射；内置存档种子 | 实机确认 |
| RGSS VX Ace（`Game.exe`） | RGSS3 | 桌面专用格式无法在手机/浏览器运行 | 无浏览器运行时 | mkxp-z WebAssembly 运行时 + 响应层兼容脚本 | 实机确认 |
| FOSSIL（MV→MZ 互操作层） | MZ | 浏览器执行 `writeNewIndexFile()` 黑屏 | `FOSSIL.js` 依赖 `require('fs')` 写盘+跳转 | 命中时改用 `FOSSILindex.html` 主替代分支并加存档桥覆盖守卫 | 指纹驱动；实机确认 |
| Enigma 封装启动器 | MV/MZ | 多语言启动器在浏览器不可用 | EXE 内打包网页覆盖层 | 只读覆盖层提取到数据目录，按指纹+签名命中 | 实机确认 |
| 加密引擎（自定义 `.png_`/`.ogg_`） | MV/MZ | 二次解密/URL 拼缀崩溃 | 服务端解密残留与浏览器缓存混合 | 强制明文路径 + `_onXhrLoad` 容错，任何缓存状态免疫 | 指纹驱动；实机确认 |
| 全局 `require`/`process`/`nw` 裸用插件组 | MV | 多个插件顶层执行 Node API 崩溃 | NW.js 打包 MV 缺少浏览器 shim | 命中时注入全局 shim 并强制 `Utils.isNwjs=false` | 指纹驱动；实机确认 |

## 未公开的适配

公开仓库有意不包含：

- 受保护/混淆数据库的解密逻辑；
- EXE 或专有启动器解包；
- 任何真实游戏覆盖层、翻译文件或商业插件源码；
- 按个人游戏记录 UUID 触发的规则。

如果某游戏只能通过上述方式运行，本项目会标记为不支持，而不是把规避保护措施的代码加入公开版本。

## 内容指纹驱动的触发

公开版中的按游戏适配统一由**内容指纹**触发（`compat-signatures.mjs`）：

- 指纹 = 游戏 `index.html + js/main.js` 的 SHA-256（带长度分隔）；
- 任何用户导入同一版本游戏即命中，无需知道开发者机器上的游戏记录 ID；
- 指纹表由 `scripts/gen-compat-signatures.mjs` 生成，配合 `config.compatGames`（规则键 → 游戏 ID 列表）作为显式兜底；
- 指纹不匹配时保持原文件不变，规则永不误伤其他游戏。

## 添加一条新记录

每条记录至少包含：

1. 游戏与引擎版本；
2. 用户可见表现；
3. 日志中的第一个致命边界；
4. 精确触发签名；
5. 修复范围和为何不会误伤其他游戏；
6. 自动测试与人工测试状态。

实现流程见 [`docs/ADDING-COMPATIBILITY.md`](docs/ADDING-COMPATIBILITY.md)。
