# 更新日志

本文遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化版本。

## [1.5.0] - 2026-09-23

### Added

- **TS_CommonSave 浏览器化**（`tsCommonSaveBrowserCompat`，`tscommonsave-1`）：Tranquil 系变体 `load()` 浏览器崩溃（`require` 被守卫后仍有未声明 `json` 引用逃出 try）→ 启动失败；save/load 改走 MV 存档桥（纯 JSON 进出，LZString 与 HTTP 由桥负责）。
- **图鉴解锁三件套浏览器化**（`galleryUnlockBrowserCompat`：TitleExtra / CGGallery / EventGallery）：`require('fs')` 读写 `save/<Name>_unlocks.json` 替换为 `/api/game-unlocks/<id>/<file>` 桥（名称白名单校验）；CGGallery 目录列举替换为 `/api/picture-dir/<id>/<folder>`（服务端过滤 png/jpg/jpeg/rpgmvp、排序、剥扩展名、同名去重）。版本：`title-extra-1` / `cggallery-1` / `eventgallery-1`。
- **SubFolderPicture 浏览器化**（`subFolderPictureBrowserCompat`，`subfolder-picture-1`）：`fs.readdirSync` 目录枚举替换为同一 `/api/picture-dir` 桥——回想内 HD CG 恢复显示。
- **Ramza_PreTitleSplash_MZ 前导斜杠修复**（`ramzaSplashPathCompat`，`ramza-splash-1`）：splash 资源写成 `/img/...` 时被拼成柜根绝对路径 → 404 循环 → `Scene_Boot` 卡死；响应层把拼接目录去前导斜杠。
- **Chimaki_Lang 浏览器化**（`chimakiLangFsCompat`，`chimaki-lang-1`）：webpack 内联 `fs` 模块替换为同步 XHR shim（路径去前导 `./` 相对游戏页解析），含 `\T[KEY]` 的 UI 文本查表不再崩。
- **PicturePointColor 取色守卫**（`fixPicturePointColor`，`ppc-1`）：图片未读取完（bitmap 0×0）或未显示（null）时坐标 NaN → Chromium `getImageData` `TypeError` → 场景停止；几何/bitmap 守卫统一返回 -1（与插件「ピクチャ外」语义一致）。行尾自适应（LF/CRLF）。
- **JsScript64Set 坏块修复**（复用 `fixJsScript76Set`，`jsscript64-1`）：与 76Set 字节级同一损坏（帮助模板 2 处未闭合字符串）。
- **NW.js 工具条尾部守卫**（`nwGuiTailGuardCompat`）：汉化/整合组在 `main.js` 末尾追加 `require('nw.gui')` 工具条 → 浏览器同步 `ReferenceError` → 启动黑屏；现仅当 `require` 与 `nw` 同时存在（真实 NW.js）才执行该块。
- **mtool 翻译快速匹配器**（`mtoolTranslatorFastCompat`，`mtool-fast-1`）：数万键巨型正则首段 `replace` 在手机 WebView 卡死数十秒~数分钟；手机 UA 注入分桶匹配器（桌面零改动，语义等价对拍测试）。
- **手机端 WindowLayer 直绘**（`mv-window-layer-compat.mjs`）：MV1.6 `WindowLayer.renderWebGL` 用 VoidFilter 强制 FBO 合成，部分手机 WebView 整层丢失（对白全不渲染）；手机 UA 门控注入直绘分支，桌面零改动。
- **幽灵存档槽屏蔽**（MV 桥内 `maskCommonMeta`）：`common` 元数据引用不存在的 `fileN` → 游戏读档守卫放行 → `loadGame` 静默失败卡死；无对应文件的槽位按空槽形态（`---`）归零，带指纹门槛防误伤。
- **DataGuard `$RGD$` System.json 支持**（`mv-audio-crypto.mjs`）：整体加密的 `System.json` 先解密再取 `encryptionKey`（密钥取自 `plugins.js` 的 DataGuard_Decrypter 参数，回退 `TestKey9527`）。
- 插件版本表新增 `TS_CommonSave` / `TitleExtra` / `CGGallery` / `EventGallery` / `SubFolderPicture` / `Ramza_PreTitleSplash_MZ` / `Chimaki_Lang` / `JsScript64Set` / `PicturePointColor` / `mtool_translator`；推进 `TS_ReplayMode` → `replay-mode-3`、`TS_Decode` → `scenario-decode-3`、`NekoGakuen_SteamworksAPI` → `steamworks-3`。
- 内容指纹表更新；合成回归测试新增 9 个（nwjs-tail-guard / ramza-splash / chimaki-lang / picture-point-color / gallery-unlock / subfolder-picture / ts-common-save / mv-audio-crypto / jsscript64-set），移植 3 个（mtool-translator-fast / mv-window-layer-compat / mv-common-mask）。

### Fixed

- **翻译桥污染插件参数**：桥曾钩住 `Window_Message.convertEscapeCharacters` 做翻译；部分插件（PictureAnimation 等）借该引擎函数解析自身参数 → 参数被字典改写 → 多帧动画不启动（立绘变"PPT"）。现摘除该钩子；消息翻译由 `startMessage` 块级替换全量承接（去掉原"须含转义符"限定，纯文本块不漏译）。

## [1.4.0] - 2026-09-22

### Added

- **计划外存档名白名单扩充**：`gameEnd|gameRecall|gameCloth|trueEnd`（事件系统固定字符串档名）与 `knsGlobalInfo`（KNS_GlobalInfo 全局旗标档）——看事件/回想写入与 KNS 系游戏启动不再被桥 400 拒绝。
- **翻译 JSON 宽容解析**（`parseTranslationJson`）：容忍 BOM、整行 `//` 与单行 `/* */` 注释（社区汉化文件风格）。
- **Steam 订阅门卫中和**：`CGMZ_SplashScreen.js` 的 `!CycloneSteam.isSubscribedApp(<id>)` 在浏览器内容条件式恒真化（`cyclone-steam-1` 版本化路径）。
- **读档音频 null 守卫**：`rpg_managers.js` 的 `playBgm/playBgs` 前置 null 检查（旧档 `_bgmOnSave/_bgsOnSave = null` 报错修复）。
- **MZ 本地文件 API 静默化**：无 `require` 环境下 `StorageManager.saveToLocalFile` 直接静默成功。
- **MZ 加密图集尺寸解析**：`readImageDims` 支持 `NN.png_`/`NN.rpgmvp` 的 RPGMV 头布局（IHDR 形状校验），图集候选名补全 `imgPath + '_'`；无缩放路径也走短缓存（max-age=300）。
- **KNS 系启动闪屏冻结修复**：MZ 1.5+ `SceneManager.onReject → onError → stop()` 会把存档桥 4xx 升级为致命错误；现仅拦截带 `__mistBridge` 标记的桥拒绝（console.warn，不中止游戏），游戏自身未处理的拒绝维持原行为。
- **SoR_DataNoteExtension 浏览器化**：`data/SoRNote/` 备注清单与内容由服务端内嵌为虚拟 fs（`__mistSoRFS`）。
- **Sakura_MapNameExtend 浏览器化**：顶层 `fs`/`path`/`process.mainModule` 依赖替换为浏览器安全 stub。
- 插件版本表新增：`Sakura_MapNameExtend: 'mapname-1'`、`SoR_DataNoteExtension_MZ: 'sornote-1'`、`CGMZ_SplashScreen: 'cyclone-steam-1'`。
- 合成回归测试：翻译注释容忍、KNS 拒绝守卫、本地文件静默、音频 null 守卫、NW.js path shim 反斜杠归一化、加密图尺寸解析、三个插件路由变换与存档名白名单集成断言。

### Fixed

- 公开版 `pirateStripCache` 缺失声明：命中盗版标记剥离路径即 `ReferenceError`，现补齐声明（该路径此前无测试覆盖）。
- NW.js 全局 shim 的 `path.join` 反斜杠归一化失效（字符串转义双写错误，含反斜杠路径不归位）。

## [1.3.0] - 2026-09-21

### Added

- **动态纹理上限**：按客户端实测 WebGL 上限（页面探针写 cookie；移动 UA 兜底 4096、桌面兜底 16384）决定是否降采样，桌面不再被固定 4096 误缩。
- **spine 图集配套缩放**：`.atlas` 的坐标与超限 PNG 成对等比缩放（布局数学不变、帧不越界），修复移动端大贴图黑块与桌面端帧越界报错；`serveAtlasCompat` + 纯函数 `scaleAtlasText`/`atlasScaleFor`（含合成回归测试）。
- **FMOO_ProSave 存档解包**：桥检测 `@@__FMOO_PROSAVE__@@` 前缀后经服务端 `zlib` 端点返回明文 JSON（浏览器侧保持标准格式写回，两端互读）。
- **F_ 系 Movie 插件浏览器化**：NW.js 门卫中和 + 自动播放静音重试（`Movie:'movie-browser-1'` 版本化路径）。
- **`?mistprobe=1` 真实存在性路由** 与 `fileExistsGuard` 指纹规则（解释器条件命令的 `require('fs').existsSync` 浏览器化，含分支语义还原）。

### Changed

- **插件版本标记从查询串改为路径段**：`js/plugins/.mistv/<version>/<name>.js`——保持缓存击穿能力的同时让插件文件名保持干净，修复 `document.currentScript` 自名推导被 `?mistv=` 破坏导致的插件命令静默失效。
- `MoviePicture` 版本推进至 `mobile-media-5`；新增 `Movie` 条目。
- 内容指纹表新增 `fileExistsGuard` 规则（18 规则 / 63 签名）。

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
