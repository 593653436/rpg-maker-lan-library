# 添加 RPG Maker 兼容规则

兼容代码最容易演变成“按游戏名堆特判”。本项目禁止这种做法。规则必须能解释、能测试、能在源代码发生变化时安全失效。

## 1. 收集脱敏证据

优先顺序：

1. 启动诊断 JSON；
2. 浏览器控制台首个异常；
3. 失败资源和 HTTP 状态；
4. 插件名、版本、作者发布页；
5. 只包含必要函数的最小代码片段。

删除用户名、绝对路径、NAS 地址、账号、Cookie、存档内容和游戏对话。不要上传完整商业插件。

## 2. 找第一个致命边界

不要把后续连锁错误当根因。示例：

```text
require is not defined
→ 数据库未初始化
→ SceneManager._scene 为 null
→ 黑屏
```

修复对象是第一行的 Node API 依赖，不是黑屏本身。

## 3. 设计签名

弱规则（禁止）：

```js
if (pluginName === 'SomePlugin') patch(source)
```

强规则（要求）：

```js
const signature =
  /require\(['"]fs['"]\)/.test(source) &&
  /DataManager\.createGameObjects/.test(source) &&
  /registerCommand\(.+ReloadCsv/.test(source);

if (!signature) return source;
```

原则：

- 文件名用于路由，不是修复许可；
- 至少匹配多个互相独立的结构特征；
- 不匹配时原样返回；
- 不用游戏 UUID、安装路径或标题触发；
- 不提供全局 `require`、`process`、`Buffer` 假实现。

## 4. 写 RED

测试必须覆盖：

- 完整签名输入会被修复；
- 同名但缺少一个关键签名的输入保持不变；
- 修复结果不含危险 API；
- 相关旧行为不回归。

夹具必须是原创合成代码，不能复制真实商业插件。

## 5. 最小修复

优先级：

1. 用浏览器标准 API 替代 Node API；
2. 由服务器生成受限清单；
3. 让引擎进入自身已有的错误/跳过链；
4. 仅开发工具可安全禁用时才禁用插件。

运行时必需插件不能简单禁用。例如 CSV 插件若负责建立全局数据数组，就必须保留同等语义。

## 6. 验证

```bash
npm test
npm run check:public
```

若人工验证由报告者执行，在兼容清单标记“待用户复测”，不要写成已实机确认。

## 7. 文档与提交

同步更新：

- `COMPATIBILITY.md`
- `CHANGELOG.md`
- 必要时 README 的能力或限制

建议提交：

```text
fix(compat): handle encrypted-image HTTP errors in MV

the MV decryptor ignored HTTP 404 responses and left Bitmap in the
"decrypting" state forever. Route permanent HTTP failures through the
native Bitmap error chain so skip plugins can recover.
```

一个兼容问题一个提交，便于回滚和二分定位。
