# Contributing

感谢参与课程版平台建设。贡献应服务于一个可重复的 PR 质量闭环，并保持项目对受邀学生团队和非敏感课程代码的定位。

## 提交前提

- 先确认改动对应一个 Issue 或明确的课程交付目标。
- 先阅读 `PROJECT_PLAN.md`、[架构](docs/architecture.md) 和 [威胁模型](docs/threat-model.md)。
- 不要把生产承诺、公共不可信代码支持或未验证的容器安全能力写入代码和文档。
- 不要修改或提交真实 Token、模型 Key、OAuth 凭据、kubeconfig、Secret 值或敏感课程代码。

## 分支与 PR

分支使用 `feat/123-webhook`、`fix/145-cleanup` 或 `docs/20-quickstart` 形式。`main` 禁止直接推送、强制推送和删除；合并后删除短分支，默认使用 Squash Merge。

每个 PR 必须包含：

- 关联 Issue、目标和非目标
- 测试命令及真实结果
- 日志、截图或可复现的运行证据
- 数据库、配置或 Kubernetes 资源变更说明
- 安全影响、容量影响和回滚方式
- 若调整课程边界，说明与 `PROJECT_PLAN.md` 的一致性和必要的计划更新

## 评审重点

评审者应优先检查正确性、权限边界、幂等、失败恢复、清理和敏感数据脱敏。任何 Run 资源都必须使用独立 Namespace、Quota、LimitRange、Restricted Pod Security、non-root、只读根文件系统、无特权、无 hostPath、无 Docker Socket 和无 ServiceAccount Token。

`agent-review` 只消费脱敏、截断且经 Schema 约束的输入。Agent 不执行用户代码、不访问 Kubernetes API、不读取 Gitea Token 或 Sandbox Secret，不修改代码、不创建修复 PR、不自动合并。多个 Agent Pod 只是同一 review 队列的无状态消费者，不对同一个 PR 做多 Agent 聚合。

## 必要验证

涉及 Webhook、队列、工作流、Kubernetes、报告或权限的改动，至少覆盖对应的单元、集成或 API E2E 测试。高风险改动还应验证：

- 无效签名、delivery ID 重放和过期事件
- Worker 崩溃后的 Outbox 补投及重复消费
- 任务超时、取消、容量拒绝、孤儿 Namespace 和 PVC 清理
- Sandbox 不可见 Gitea Token、模型 Key、kubeconfig 和 ServiceAccount Token
- Gitleaks Canary 不出现在日志、Agent 输入、报告、数据库或 Gitea Comment
- 未登录返回 401、无仓库权限返回 403、维护者操作权限正确

## 文档与版本

用户可见行为、配置、边界和安全承诺变化必须同步文档。发布前更新 `CHANGELOG.md`；版本、迁移、回滚和验收按 [RELEASE.md](RELEASE.md) 执行。

