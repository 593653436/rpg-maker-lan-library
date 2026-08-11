# 安全策略

## 支持版本

当前只维护 `main` 和最新正式 Release。

## 报告漏洞

请不要在公开 Issue 中提交可直接利用的认证绕过、任意文件读写、路径遍历或密钥泄露。使用 GitHub 的 **Private vulnerability reporting**，并提供：

- 受影响版本；
- 最小复现步骤；
- 风险与可利用范围；
- 建议修复（如有）。

不要附带真实游戏、存档、账号数据或未脱敏日志。

## 部署边界

本项目定位为可信局域网应用，不应直接暴露到公网。公网部署至少需要：

- HTTPS；
- 反向代理和访问控制；
- 速率限制；
- 定期密钥轮换；
- 对 `sourceRoot` 和 `dataDir` 的最小文件系统权限。

## 敏感文件

以下内容不得进入 Issue、PR 或 Git 历史：

```text
config.json
data/
games/
recollections/
*.rpgsave
*.rmmzsave
日志、Cookie、密码和会话密钥
```

若密钥已提交，删除文件不够：立即轮换密钥，并使用 `git filter-repo` 清理历史。
