# 参与贡献

感谢你帮助改进 RPG Maker 浏览器兼容。

## 在提交 Issue 前

- 确认你合法持有并有权在个人局域网运行该游戏；
- 使用最新 `main` 复现；
- 导出脱敏诊断日志；
- 搜索现有 Issue 和 `COMPATIBILITY.md`。

## 禁止上传

- 游戏本体、图片、音频、视频；
- 完整商业插件；
- 翻译文件或游戏数据库；
- 存档；
- Cookie、密码、密钥、账号数据；
- NAS/SMB 地址、用户名和本机绝对路径；
- DRM 绕过、数据库解密或启动器解包代码。

## 兼容修复 PR

1. 从 `main` 建立 `fix/compat-short-name`；
2. 使用原创最小夹具建立失败测试；
3. 添加完整签名受限的最小修复；
4. 更新 `COMPATIBILITY.md` 与 `CHANGELOG.md`；
5. 运行：

```bash
npm test
npm run check:public
```

6. 提交使用约定式格式，例如：

```text
fix(compat): bridge AnotherNewGame special save id
```

## 代码原则

- KISS：一个规则解决一个根因；
- 默认不修改：签名不完整就原样返回；
- 不按游戏 UUID、安装路径或用户环境触发；
- 不添加全局 Node/NW.js 假对象；
- 不为了通过一个游戏破坏其他游戏；
- 新规则必须有命中与不命中测试。

## 文档

每项新兼容必须写清：表现、首个根因、适配边界、验证状态。只写“修复黑屏”不够。
