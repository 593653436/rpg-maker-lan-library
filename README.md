# RPG Maker LAN Library

> 把你合法持有的 RPG Maker MV/MZ、RGSS（VX Ace）与 KiriKiri 2（KRKR）网页游戏从本地磁盘或 NAS 按需流式提供给局域网设备，并在响应层修复常见的 NW.js、存档和资源加载兼容问题。

![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-43853d) ![License: MIT](https://img.shields.io/badge/License-MIT-yellow)

## 为什么需要它

不少游戏本身包含 `index.html` 或 `www/index.html`，但直接放进普通 HTTP 服务器后仍会因为 NW.js 的 `require()`、浏览器存档隔离、插件加载顺序、移动端媒体限制或加密资源错误而黑屏、卡加载或读不到存档。

本项目不复制完整游戏。它记录目录并实时流式响应，同时对**完整代码签名/内容指纹命中的已知问题**实施窄范围兼容；签名不匹配时保持原文件不变。

## 功能

- 从**任意本地磁盘或 SMB/UNC 地址**按需流式读取游戏与网页回想室，不受根目录限制
- 支持 RPG Maker MV/MZ（`index.html` / `www/index.html`）、RGSS VX Ace（mkxp-z WebAssembly 运行时）与 KiriKiri 2 / KRKR（`data.xp3` + 内置 WebAssembly 运行时）
- 支持 Enigma 封装启动器的只读网页覆盖层与多语言版本选择
- MV/MZ 存档桥：浏览器设备共享源目录存档；只读目录自动回退到本地数据目录
- 固定名称存档白名单，避免任意文件读写与路径遍历
- 自动封面查找、加密 RPG Maker 图片即时读取
- 手机虚拟键盘、横屏播放、移动端视频/音频解锁
- 管理员、注册账号、游客访问、评分、公告和诊断日志
- 可选 JSON/JSONY 文本映射翻译
- 网页回想室目录：支持 `index.html` 或 `web/index.html`
- **内容指纹驱动的兼容规则**：见 [COMPATIBILITY.md](COMPATIBILITY.md)

## 已整理的真实兼容案例

| 游戏/案例 | 原始表现 | 通用修复 |
|---|---|---|
| エレナのご奉仕 | 读档后提示 `titleInfo` 存档名无效 | 精确支持固定 `titleInfo.rmmzsave` |
| SA● Ghost Protocol ver1.0 | 点击开始后黑屏 | 将 Node CSV 自动加载器替换为浏览器同步 XHR，并版本化 URL 避免旧缓存 |
| 驱魔少女伊万杰琳之刻印的淫纹 1.0 | 继续游戏永久卡 `Now Loading` | 加密图片 404 进入原生失败链；永久缺图不再无限等待；补齐 `PluginCommonBase` 顺序 |
| Scars of Summer v1.02 | 回想房间不显示，像是存档没读到 | 特殊 ID `-1001` 精确映射到 `anotherNewGame` |
| 爱丽丝・入侵 MZ | 启动黑屏，`Text2Frame` 调用 Node API | 仅完整开发工具签名命中时禁用编辑器插件 |
| 凍堂ヒロカの隷雄譚 | 多个插件依赖 `fs`、`child_process` | 服务端生成受限文件/字体清单，替代 Node 目录扫描 |
| IsekaiNTRInn 回想室 | 只显示标题或无法识别入口 | 支持 `web/index.html` 与正确 `.mjs` MIME |
| KRKR 游戏（`data.xp3`） | 桌面专用格式无法在手机运行 | WebAssembly 运行时 + 按需虚拟 ZIP 映射，源文件零改动 |
| RGSS VX Ace 游戏 | `Game.exe` 无法在手机运行 | mkxp-z WebAssembly 运行时 + 响应层兼容脚本注入 |

详见 [COMPATIBILITY.md](COMPATIBILITY.md)：包含首个根因、触发签名、修复边界和验证状态。

## 快速开始

```bash
npm ci
npm run setup     # 生成 config.json 与随机管理员/游客凭据
npm start         # 或双击 start.bat
```

手机/电脑访问 `http://<本机局域网 IP>:8787`。点击"添加游戏"：

- 直接粘贴任意路径：`\\NAS\share\游戏\游戏目录` 或 `D:\Games\游戏目录`；或
- 点击"选择目录"，逐级浏览（可越出默认根目录）。

系统只记录目录，不复制游戏资源；SMB 原文件不会被修改。

## 兼容规则如何工作

1. 导入游戏时按 `index.html + js/main.js` 计算 SHA-256 内容指纹（见 `compatMatches` / `gameFingerprint`）。
2. 代码内置指纹表 `compat-signatures.mjs`；命中即对已知问题实施响应层修复。
3. `config.compatGames` 可提供显式 ID 兜底（规则键 → 游戏 ID 列表），并配合 `npm run gen:signatures` 重新生成指纹表。
4. 签名不匹配时保持原文件不变——修复永远窄范围、可解释。

## 配置

编辑 `config.json`（见 `config.example.json`）：端口、SMB 根目录、数据目录、站点标题、HTTPS、认证、`compatGames`、`translationExtraFiles`、`krkrBundledSaveFiles` 等。

## 测试与审计

```bash
npm test            # 单元 + 集成测试（Windows）
npm run check:public  # 公开仓库脱敏审计（CI 亦执行）
```

## 第三方运行时

KRKR 与 RGSS 的浏览器运行时为第三方开源项目编译产物，许可证与来源见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## AI 协作开发

本项目在开发与调试过程中得到以下 AI 的协助：

- **OpenAI GPT**
- **DeepSeek**

感谢它们在兼容规则设计、问题排查与文档整理上的支持。

## 许可

MIT © 2026 雾灯游戏柜。第三方运行时按其各自许可证分发。
