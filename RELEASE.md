# Release Guide

本项目发布的是课程版可重复演示能力，不是生产服务等级承诺。发布说明必须明确实际验证的部署路径、测试结果和仍然存在的限制。

## 版本规则

使用语义化版本：

- `MAJOR`：破坏已发布 API、数据模型或课程版使用约定。
- `MINOR`：向后兼容地增加课程版能力。
- `PATCH`：向后兼容的修复、文档和安全更新。

`v0.x` 表示课程版 MVP 仍可能调整；`v0.1.0` 是项目计划中的首个完整课程版发布目标，不应在验收未完成前提前宣称已发布。

## 发布前检查

- [ ] `main` 无未审查改动，PR 已关联 Issue，并有人工 Reviewer 批准。
- [ ] Node 成功 PR、Node 测试失败 PR 和资源清理可以重复运行。
- [ ] Gitea Status、Comment、人工批准和当前 `head_sha` 绑定正确。
- [ ] Webhook 签名、delivery ID 幂等、Outbox 补投、权限、OAuth/CSRF 和脱敏测试通过。
- [ ] 每 Run Namespace、Quota、LimitRange、Restricted Pod Security、non-root、只读根文件系统和无 Token 约束通过检查。
- [ ] 成功、失败、超时、取消和 Worker 重启后孤儿资源都能清理。
- [ ] Gitea、PostgreSQL、Registry 和平台日志的持久化卷验证过备份/重启恢复。
- [ ] rootless BuildKit POC 已通过 Restricted PSA 下的 push -> pull -> Digest 部署 smoke test；若未通过，发布必须使用固定 Fixture 并标注 `BUILD_MODE=FIXTURE`。
- [ ] 单节点 k3s 的实际 Node Allocatable、系统组件资源预留、Registry、Ingress 或 SSH 隧道已记录。
- [ ] `CHANGELOG.md` 已写入版本、已知限制和不属于课程版的能力。

## 发布步骤

1. 冻结版本范围，确认没有把 P1/P2 能力混入 P0 验收。
2. 执行数据库 migration 和 schema smoke test；不得让 API 与 Worker 并发 migration。
3. 备份 Gitea、PostgreSQL、Registry 元数据和平台日志卷。
4. 在选定路径执行 Demo，并保存脱敏的运行 ID、状态、报告、Gitea 状态、Preview 和清理证据。
5. 创建版本标签和发布说明，注明本次使用的是 `k3s` Ingress、SSH 隧道或本地 `k3d`。
6. 发布后检查 `healthz`、`readyz`、队列消费、持久化读取和过期资源清理。

## 回滚与故障处理

回滚前先停止新 Run，保留旧版本的运行记录和报告。数据库 migration 必须有经过验证的向前兼容或恢复步骤；不得直接删除生产式持久化卷。单节点故障没有自动故障转移能力，恢复依赖节点、卷和备份可用性。

若发现凭据泄露，立即撤销/轮换凭据、停止受影响的任务、检查日志/报告/Gitea Comment 是否包含敏感值，并记录安全事件。课程版不承诺对已被不可信代码读取的 SSD 数据进行密码学擦除。

