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
| 旧插件 `String.contains` 调用 | MV | 数据库加载循环首个文件即中断，卡 `Scene_Boot` | 粒子插件 hook `DataManager.loadDataFile` 使用 Firefox 旧别名 `contains` | 核心响应注入 `contains → includes` 别名（幂等，不覆盖） | 自动测试 |
| 损坏发布的插件源码（帮助文本模板自毁） | MV | 插件整体语法错误，启动中断 | 生成工具把帮助文本模板写回源码，留下未终止字符串 | 响应层精确替换损坏段（含多出现处）；不改源文件 | 自动测试 |
| 汉化版语言检测与通用 shim 冲突 | MV | 全部数据库 404 静默，卡 `Scene_Boot` | 汉化 `rpg_managers.js` 顶层 `require('fs')` 读 `lng.txt`，与先注册的 `require` 冲突 | 合并式 fs 注册（保留既有方法 + lng 走同步 XHR）+ `/lng.txt` 路由 | 实机确认 |
| 单张缺失图片卡死整个场景 | MV | 场景永远不 ready（如停在标题） | 缺图 404 → Bitmap 错误态 → `CacheMap.isReady()` 永假 | `/img/**` 404 返回透明 PNG（加密格式按前 16 字节 XOR 重加密） | 实机确认 |
| 移动端超大纹理静默黑屏 | MV/MZ | 大尺寸视差/背景整片黑 | WebGL `MAX_TEXTURE_SIZE` 超限时上传静默失败 | 超限图片解密→等比降采样→原格式重封装（内存缓存） | 实机确认 |
| 移动端加密音频 `.rpgmvm` 缺失 | MV | 手机端 BGM/SE 全静音 | 发行包只有 `.rpgmvo`，移动端请求 `.rpgmvm` → 404 | `.rpgmvo` 解密 → AAC 转码 → 按旧式格式重加密返回（串行队列 + 磁盘缓存） | 实机确认 |
| 非 ASCII 资源路径静默丢图 | MZ | 部分立绘/CG 显示为空 | 路由未解码 `%E2%98%85…`，磁盘查找失败走兜底 | `/games/**` 路由统一 `decodeURIComponent`（带防穿越校验） | 实机确认 |
| 并发写同一存档 `EPERM` | MV/MZ | 快速连点保存随机失败 | 并发临时文件 rename 覆盖冲突 | 写入按路径串行化 + 原子替换 + 重试 | 自动测试 |
| 翻译键与运行时文本装饰漂移 | MV/MZ | 部分台词保持原文（中日混排） | 控制码/首尾装饰/省略号形态/语气前缀差异 | 匹配链：去控制码 → 首尾剥壳 → 省略号折叠 → 语气前缀剥离 → 最长前缀回退 | 自动测试 |
| 盗版重打包注入标记代码 | MV/MZ | 插件顶层 `require` 崩溃并连锁 | 整合版注入 base64 文件名 + `fs.openSync` 写标记 | 响应层剥离已知形态（形态精确匹配，识别不了不动） | 自动测试 |
| 插件参数空串触发加载期异常 | MZ | 全局错误记录 → 启动中止（错误屏） | 插件参数 `slotSettings=""` → 顶层 `JSON.parse` 抛错 | 空/空白回退 `"[]"`（等价未配置；有值不受影响） | 实机确认 |
| 第三方整合 CG 回想屋会话开关丢失 | MZ | 进入回想屋纯黑（无任何 UI） | 菜单条件依赖会话级变量，重载后开关不满足 | 内容指纹命中时就地补开关（轮询自愈） | 实机确认 |
| FMOO_ProSave 存档（zlib 封装） | MV | 列表能看到存档，游戏里读不出 | 插件仅在 NW.js 本地模式启用 `@@__FMOO_PROSAVE__@@ + deflateRaw` 封装，桥按标准 LZString 解压失败 | 桥检测前缀 → 服务端解包端点（zlib → 明文 JSON）；浏览器新存仍写标准格式，两端互读 | 自动测试；实机确认 |
| 桌面端超大纹理被误降采样 | MV/MZ | spine 剧情动画连环 `Texture Error`（帧越界） | 降采样按全局 4096 钳制，桌面（上限 16384）也被缩，图集坐标未缩 | 上限按客户端动态决定（页面探针测 WebGL 上限写 cookie，移动 UA 兜底）；`.atlas` 坐标与 PNG 成对等比缩放；带图集的贴图不再单方缩 | 自动测试；实机确认 |
| 移动端 spine 大贴图黑块 | MV/MZ | 手机看回想时人物/大 CG 纯黑块（无报错） | 大贴图超过手机 GPU 上限后上传静默失败 | 同上：PNG+atlas 成对缩放至客户端上限内（布局不变、像素略软） | 自动测试；实机确认 |
| 插件 URL 查询串破坏自名推导 | MV/MZ | 插件命令全部静默失效（如回想模式拒绝进入） | 缓存击穿用 `?mistv=` 查询串；部分插件用 `document.currentScript.src` 正则取文件名，查询串致正则失配，命令注册到了完整 URL 名下 | 版本标记改为路径段 `js/plugins/.mistv/<ver>/<name>.js`（文件名保持干净、路径变化同样击穿缓存） | 自动测试 |
| F_ 系 Movie 插件 NW 门卫 | MV | 回想/画廊入口校验拒绝进入（`unable to play movies`） | `Movie.js` 顶层 `if (!Utils.isNwjs())` 放弃初始化 → `SceneManager.playMovie` 未定义 → 画廊依赖校验失败 | 门卫中和（插件本体为纯浏览器写法）+ 自动播放被拒时静音重试；路径段版本化 | 自动测试；实机确认 |
| 产品数据校验 `require('fs')` 误判 | MV/MZ | 事件循环弹“数据缺失”提示或循环对话 | 并行事件里 `require('fs').existsSync(...)` 在浏览器恒假 | 解释器条件命令按指纹注入 `__mistExists`（同步 XHR 探测 `?mistprobe=1` 真实存在性），完整还原分支语义 | 指纹驱动；实机确认 |

| 事件系统固定字符串档名 | MV | 看事件/解锁写入被拒（“存档名称无效”） | `gameEnd/gameRecall/gameCloth/trueEnd` 不在存档桥白名单 | 扩充固定白名单（未知名称仍拒绝） | 自动测试；实机确认 |
| KNS_GlobalInfo 全局旗标档 | MZ | 启动闪屏黑屏冻结（onReject→stop 全屏报错） | `knsGlobalInfo` 写档被 400 拒 → 未处理拒绝被升级为致命错误 | 白名单 + 桥错误 `__mistBridge` 标记 + 仅拦截桥拒绝的 `onReject` 守卫 | 自动测试；实机确认 |
| 社区汉化翻译 JSON 注释 | MV/MZ | 有效翻译整包被忽略（台词保持原文） | 文件含 BOM 与整行 `//`、单行 `/* */` 注释，`JSON.parse` 抛错 | `parseTranslationJson` 宽容解析（BOM + 整行注释过滤） | 自动测试 |
| CGMZ_SplashScreen Steam 门卫 | MZ | 启动画面卡住（提示需要 Steam） | 改版把 `!CycloneSteam.isSubscribedApp(<id>)` 当内容门卫，浏览器恒 false | 内容条件式恒真化 + 版本化路径 | 自动测试 |
| 旧档读档音频 null | MV/MZ | 点击读档报错卡死 | 旧档 `_bgmOnSave/_bgsOnSave = null` | `playBgm/playBgs` 前置 null 守卫 | 自动测试 |
| MZ 本地文件直调插件 | MZ | 改画面选项报 `require is not defined` | 插件直调 `StorageManager.saveToLocalFile` | 无 `require` 环境静默成功（本地文件不可用属预期） | 自动测试 |
| MZ 加密图集配套缩放 | MZ | 手机端启动帧越界 / 图集与贴图不同步 | 图集页名解析漏 `NN.png_`；尺寸读取不识别 RPGMV 头 | 候选名补全 + RPGMV 头尺寸解析（形状校验）；无缩放短缓存 | 自动测试 |
| SoR_DataNoteExtension | MZ | 启动阶段 Node `fs` 依赖失败 | 顶层读 `data/SoRNote/` 扩展备注 | 服务端内嵌备注为虚拟 fs（`__mistSoRFS`） | 自动测试 |
| Sakura_MapNameExtend | MZ | 浏览器顶层 `require` 崩溃 | `fs/path/process.mainModule` 顶层依赖 | 安全 stub 替换（fs 空实现、path 纯字符串、process 守卫） | 自动测试 |

| TS_CommonSave 系启动崩 | MV | 加载报错 / 启动失败 | `require('fs')` 被守卫后仍有未声明 `json` 引用逃出 try → `createGameObjects` 崩 | save/load 改走 MV 存档桥（纯 JSON 进出）；版本化路径 | 自动测试；实机确认 |
| 图鉴解锁三件套（TitleExtra/CGGallery/EventGallery） | MV | 标题按钮不显示 / 图鉴全锁 | 三插件 `require('fs')` 读写解锁文件，浏览器抛错被各自 catch 吞掉 | 解锁文件读写换 `/api/game-unlocks` HTTP 桥（名称白名单）；CGGallery 目录列举走 `/api/picture-dir`；版本化路径 | 自动测试；实机确认 |
| SubFolderPicture 子目录 CG | MV | 回想内 HD CG 不显示（占位图） | `fs.readdirSync` 枚举 `img/pictures/<folder>`，浏览器返回 [] → `folder/undefined` | 目录列表走 `/api/picture-dir`（服务端过滤/排序/剥扩展名/去重） | 自动测试；实机确认 |
| Ramza_PreTitleSplash_MZ 前导斜杠 | MZ | 启动卡死（位图永不就绪） | splash 参数 File 为 `/img/...` → 拼成柜根绝对路径 → 循环 404 | 响应层把拼接目录去前导斜杠（无斜杠参数为无操作替换） | 自动测试；实机确认 |
| Chimaki_Lang CSV 字典 | MZ | 含 `\T[KEY]` 的 UI 文本查表崩 | webpack 内联模块 `require("fs")` 浏览器同步 ReferenceError → 字典永不载入 | fs 模块换同步 XHR shim；版本化路径 | 自动测试；实机确认 |
| PicturePointColor 取色 | MV | 菜单「思い出す」报错停场景 | 未加载完的 bitmap（0×0）→ NaN 坐标 → Chromium `getImageData` TypeError | 几何/bitmap 守卫返回 -1（插件「ピクチャ外」语义） | 自动测试；实机确认 |
| JsScript64Set 坏块 | MV | 插件 SyntaxError（整包报废） | 生成工具把帮助模板写回源码（2 处未闭合字符串） | 复用 76Set 修复器精确替换（全部出现处）；版本化路径 | 自动测试；实机确认 |
| 整合包 main.js 尾部 NW.js 工具条 | MV/MZ | 启动黑屏（无报错画面） | 尾部 IIFE `require('nw.gui')` 同步 ReferenceError → 跳过 `SceneManager.run` | 仅当 `require` 与 `nw` 同时存在才执行该块（浏览器直接跳过） | 自动测试；实机确认 |
| mtool 巨型正则手机卡死 | MV | 手机首段翻译卡死数十秒~数分钟 | 数万键巨型正则单次 `replace` 解释器路径退化 | 手机 UA 注入分桶匹配器（语义等价对拍）；路径段版本化 | 自动测试；实机确认 |
| 手机对白不渲染（WindowLayer 整层丢） | MV | 手机端对话框文字全不显示（名字/气泡正常） | MV1.6 `WindowLayer.renderWebGL` 强制 FBO 合成在部分手机 WebView 丢失 | 手机 UA 门控注入直绘分支（桌面零改动） | 自动测试；实机确认 |
| 幽灵存档槽（整合包缺档） | MV | 读档界面点槽位无反应 / 卡死 | `common` 元数据引用不存在的 `fileN`，游戏守卫放行 → `loadGame` 静默 false | 桥内槽位屏蔽：元数据非空但无对应文件的槽按空槽形态归零（指纹门槛） | 自动测试；实机确认 |
| DataGuard `$RGD$` 加密 System.json | MV | 加密音频链取不到 key（移动端音频转换整体失败） | `System.json` 整体加密 → `JSON.parse` 失败 | 先 `$RGD$` 解密（密钥取自 `plugins.js` 参数，回退默认键）再取 encryptionKey | 自动测试；实机确认 |
| 翻译桥污染插件参数（立绘变"PPT"） | MV | 多帧动画不启动，只在状态切换时整张重显 | 翻译桥钩 `Window_Message.convertEscapeCharacters`，插件借用该引擎函数解析的参数被字典改写 | 摘除越界钩子；消息翻译由 `startMessage` 块级替换承接 | 自动测试；实机确认 |

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
