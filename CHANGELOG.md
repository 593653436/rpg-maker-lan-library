# 更新日志

本文遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化版本。

## [1.2.0] - 2026-09-21

### Added

- **启动链容错**：旧插件 `String.contains` 别名 polyfill（数据库加载循环中断类卡死）；损坏发布插件（帮助文本模板自毁）响应层修复；汉化版语言检测与通用 shim 的合并式注册 + `/lng.txt` 路由。
- **素材管线**：缺失图片透明兜底（不再因单张 404 卡死场景）；移动端超大纹理降采样；非 ASCII 资源路径 URL 解码。
- **移动端音频**：`.rpgmvo → m4a` 转码桥（含加密音频重加密与普通 ogg 两条路径，串行队列 + 磁盘缓存，支持 Range）。
- **翻译匹配链升级**：去控制码 → 首尾剥壳 → 省略号折叠 → 语气前缀剥离 → 最长前缀回退（含合成回归测试）。
- **存档写入串行化与原子替换**（含并发回归测试）。
- **盗版重打包注入标记剥离**（已知形态精确匹配，含合成回归测试）。
- **第三方整合回想屋自愈**（内容指纹触发）与插件空参数容错。
- 新依赖 `pngjs`（纹理降采样）；内容指纹表扩充（`steamworks` 新增、`xyouRoom` 新增）。

### Changed

- 插件版本表扩充：新增 `JsScript76Set`、`SRD_UltraBase`、`SaveSlotCustom` 条目；`NekoGakuen_SteamworksAPI` 版本 +1 以刷新缓存。
- 存档名单正则同时接受 `achievement` / `achievements` 两种文件名。

## [1.1.0] - 2026-08-11

### Added

- **任意地址支持**：游戏与网页回想室不再限制在 `sourceRoot`/`recollectionRoot` 内，本地磁盘、SMB/UNC 地址均可直接添加或浏览（上一级可越出根目录）。
- **KiriKiri 2 / KRKR 游戏**：随项目提供 WebAssembly 运行时（`public/krkr-runtime`），服务器将源目录映射为按需读取的虚拟 ZIP；支持内置存档种子、跨域隔离和 PWA 缓存。
- **RGSS (RPG Maker VX Ace)**：mkxp-z WebAssembly 运行时（`public/mkxp`）与响应层兼容脚本（`public/rgss-compat`）。
- **启动器覆盖层**：Enigma 封装的 EXE 启动器可作为只读网页覆盖层加载，支持多语言版本选择。
- **内容指纹兼容规则**：兼容规则按游戏 `index.html + js/main.js` 的 SHA-256 指纹触发（`compat-signatures.mjs`），任何用户导入同一版本游戏即自动命中；`config.compatGames` 可显式指定规则键到游戏 ID 的兜底映射。
- 剧本回想模式（TS_ReplayMode/TS_Decode）、通用存档（CommonSave）、场景文本桥。
- 新增 `npm run gen:signatures` 重新生成指纹表。

### Changed

- `config.json` 新增可选字段：`https`、`proxy`、`rtpRoot`、`compatGames`、`translationExtraFiles`、`krkrBundledSaveFiles`。
- 启动日志的局域网地址改为自动探测本机网卡，不再硬编码。

## [1.0.0] - 2026-07-24

### Added

- 本地/NAS RPG Maker MV/MZ 游戏按需 HTTP 流式服务。
- MV/MZ 源目录存档桥与只读目录本地回退。
- 固定名称特殊存档：`common`、`achievements`、`anotherNewGame`、`titleInfo` 等。
- `PluginCommonBase` 顺序恢复。
- Node/NW.js 插件浏览器兼容：CSV、文件清单、字体清单和角色图清单。
- 移动端视频播放、弱网重试、裸 `%` URL 兼容和加密图片 HTTP 错误处理。
- 管理员/用户/游客、评分、公告、翻译映射和启动诊断。
- 网页回想室及嵌套 `web/index.html`、`.mjs` MIME 支持。

### Security

- 所有规则改为源码完整签名触发，不按生产游戏 UUID 触发。
- 公开版移除受保护数据库解密和 EXE/启动器解包逻辑。
- 初始化强制生成随机密码与会话密钥；无认证配置拒绝启动。
- 公开版采用 MIT 许可证，方便个人和项目复用。
