# Security Policy

## 适用范围与安全承诺

本项目是面向受邀学生团队和非敏感课程代码的课程版演示平台。它提供受限的 Kubernetes 任务执行环境，不适用于生产环境、公共不可信代码、敏感数据或需要强隔离保证的场景。

课程版 P0 的安全基线包括：签名 Webhook 和重放控制、每 Run 独立 Namespace、ResourceQuota、LimitRange、Restricted Pod Security、非 root、只读根文件系统、禁止特权/hostPath/Docker Socket/host namespace、无任务 ServiceAccount Token、资源和日志上限、超时与自动清理、最小 Worker RBAC、Agent 输入脱敏和严格报告 Schema。

这些控制不构成生产安全承诺。项目不能承诺防御 Kubernetes 内核漏洞、容器逃逸、公网不可信代码、SSD 密码学擦除、生产级多租户隔离、高并发、HA 或单节点故障。k3d 不是恶意代码沙箱；单节点 k3s 没有高可用能力。k3d 的网络策略是否生效也不作为 P0 承诺，网络隔离证明属于 P1。

## 报告问题

请通过仓库配置的私密安全渠道联系维护者。若仓库尚未配置专用安全邮箱或私密报告入口，请先私下联系维护者，提供复现步骤、受影响组件、环境、潜在影响和临时缓解方式，不要在公开 Issue、PR、Gitea Comment 或课程群中发布可利用细节。

维护者应先确认报告范围，隔离受影响的 Demo 环境，轮换可能泄露的凭据，修复后再决定公开修复说明。不要把真实 Secret、完整敏感日志或未脱敏的用户代码附在报告中。

## 开发者安全要求

- 不可信 Run 容器不得拿到 Gitea Token、模型 Key、kubeconfig 或 ServiceAccount Token；受信任的 Source Fetch Job 仅短时使用一次性只读 Gitea 凭据，用后立即删除。
- Gitleaks 原文、Secret 值和敏感代码片段在进入 Agent、报告、日志、数据库和 Gitea Comment 前必须替换为 `[REDACTED]`。
- Agent 输出必须经过严格 Schema、大小、路径、行号和 HTML/JavaScript/终端控制字符校验。
- Worker 是唯一管理 Run Namespace 的受信任组件，禁止给任务容器 Kubernetes API 权限。
- 不允许用户提交任意 Dockerfile、Shell、Kubernetes YAML、资源限制或网络规则。
- 任何安全边界变化都必须同步威胁模型和验收测试。
