# AI-Native PR Quality Platform

基于 Gitea 的 AI 原生 PR 质量与 Kubernetes 临时预览平台。Gitea 负责仓库、Issue、PR、Review、权限和分支保护；本平台负责把一次 PR 变更送入固定的测试、安全检查、临时预览和结构化 Agent 审查流程。

## 课程版边界

本项目面向受邀学生团队、教师或项目维护者，以及非敏感的课程示例仓库。课程版是一个可重复演示的 MVP，不是 GitHub 替代品，也不是生产级代码托管系统或不可信代码沙箱。

课程版 P0 闭环如下：

```text
PR -> Gitea Webhook -> 固定 Profile 与测试/安全检查
   -> 单次 Run 的 Kubernetes 临时环境 -> Agent 结构化报告
   -> Gitea Status/Comment -> 人工 Review -> 合并或阻断 -> 自动清理
```

P0 只支持 Node.js 和 Python 固定 Profile、单容器单 HTTP 端口、平台生成的受控 Dockerfile、固定测试、Gitleaks、临时 Preview、Mock Agent、Gitea 状态回写和人工批准。用户不能提交或执行任意 Dockerfile、Shell 或 Kubernetes YAML。

明确不属于课程版的能力包括：公网任意仓库、多租户生产隔离、对抗容器逃逸、Agent 自动改代码或自动合并、任意命令生成、GPU/本地大模型、多节点 k3s、HA、自动扩缩容、计费和跨集群。真实模型 API、Go、Trivy、网络策略安全模式和高级预览域名属于 P1 或可选演示能力。

> 安全承诺：本项目面向受邀学生团队和非敏感课程代码，提供受限的 Kubernetes 任务执行环境，不适用于生产环境或公共不可信代码。

## 部署模式

- 本地开发：Docker Compose 运行 Gitea、PostgreSQL、平台服务和 Agent；k3d 运行每次 Run 的任务与 Preview。
- 服务器演示：单节点 k3s + Traefik + 本地 Registry。Gitea、PostgreSQL、Registry、平台服务、Agent Pod 和每次 Run 的资源可以运行在同一个 Node 上。
- 单节点没有高可用能力；Node 宕机会使整个平台不可用。推荐服务器为 8 vCPU、16 GB RAM、80-100 GB SSD，并为 k3s 系统组件预留至少 20% 资源。

### 多 Agent Pod 的含义

服务器默认运行 1 个 `agent-review` Pod，推荐配置最多 3 个。多个 Pod 可以在同一个 Node 上运行，它们从同一个 review 队列领取不同的 Run，是无状态的容量副本；它们不执行用户代码、不访问 Kubernetes API、不读取 Sandbox Secret，也不为同一个 PR 生成多份聚合报告。课程版完整 Run 同时最多 1 个，最多 3 个 Run 排队；超出容量的 Webhook 记录为 `REJECTED_BY_CAPACITY`。

## 关键组件

- Gitea：仓库、PR、Review、OAuth、权限和分支保护。
- API：接收签名 Webhook、OAuth 和运行查询；Webhook 只入库并返回 `202`。
- PostgreSQL + pg-boss：保存 Run、步骤、报告、审计记录和可靠任务队列；Outbox 防止 Worker 崩溃造成任务丢失。
- Worker：编排固定工作流、创建和清理 Run Namespace、回写 Gitea 状态。
- Kubernetes Run 资源：Source Fetch、Analysis Tools、Build/Test、Preview 和每 Run 独立的 workspace PVC。
- `agent-review` Deployment：只处理脱敏且限长的输入，默认使用 Mock Provider，输出必须通过严格 Schema 校验。

## 示例仓库

`examples/node-good`、`examples/node-test-fail`、`examples/python-good` 和
`examples/python-health-fail` 是无公网依赖的课程 Fixture。平台只从 Gitea
仓库树识别受限的 `node-http` 或 `python-http` Profile，并把端口、健康路径、
测试 Profile 和入口文件写入运行计划；不接受仓库自带 Dockerfile、Shell 或
Kubernetes YAML。

## 运行前提

本地开发需要 Docker、Node.js 22 LTS、pnpm、kubectl 和 k3d；完整演示建议至少 4 核 CPU、16 GB 内存和 80 GB 可用磁盘。服务器模式需要单节点 k3s、Ingress 地址或 SSH 隧道，以及私有 Registry 配置。

实现后的启动、环境变量、迁移、测试和清理约定见 [DEVELOPMENT.md](DEVELOPMENT.md)。架构和边界见 [docs/architecture.md](docs/architecture.md)，威胁与残余风险见 [docs/threat-model.md](docs/threat-model.md)，答辩路径见 [docs/demo.md](docs/demo.md)。
当前构建、测试、远程运行边界和未闭合验收项见 [docs/verification.md](docs/verification.md)。

## 验收口径

课程版达到 MVP 的最低条件是：Node 成功 PR、Node 测试失败 PR、Gitea 质量门禁、Agent 结构化报告、独立 Namespace、持久化、自动清理和人工批准能够在选定部署路径重复运行。若 rootless BuildKit POC 未通过，动态构建必须降为 P1，验收使用固定预构建 Fixture 镜像，并在结果中标注 `BUILD_MODE=FIXTURE`；不得借此宣称完整动态构建安全性。

## 文档

- [开发指南](DEVELOPMENT.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [架构](docs/architecture.md)
- [威胁模型](docs/threat-model.md)
- [Demo 脚本](docs/demo.md)
- [验证记录](docs/verification.md)
