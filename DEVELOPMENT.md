# Development Guide

本文档约束课程版的本地开发和单节点演示环境。所有命令和配置都应保持与 `PROJECT_PLAN.md` 的 P0 边界一致。

## 环境

本地完整闭环需要：

- Node.js 22 LTS、pnpm、Docker Desktop、kubectl 和 k3d
- 至少 4 个 CPU；推荐 8 个 CPU、16 GB RAM、80 GB 可用磁盘
- 本地 Docker Desktop 建议分配至少 4 CPU、8 GB RAM

服务器完整 Demo 推荐单节点 k3s、8 vCPU、16 GB RAM、80-100 GB SSD。4 vCPU、8 GB RAM 只适合无动态构建的轻量开发，不作为完整 Demo 配置。GPU 不是依赖。

## 本地模式

本地模式使用 Docker Compose + k3d：

1. Compose 运行 Gitea、PostgreSQL、API、Worker、Web、`agent-review` 和迁移服务。
2. k3d 运行每个 Run 的 Source Fetch、Analysis Tools、Build/Test 和 Preview 资源。
3. k3d bootstrap 创建本地 Registry；BuildKit 和 k3d containerd 使用集群可达的 Registry 地址，不使用 `localhost` 作为 Pod 镜像地址。
4. Worker 通过专用只读 kubeconfig 管理 k3d 资源；该凭据不能挂载到任何用户任务容器。
5. 本地 Preview 使用平台返回的受控 port-forward 命令；不能使用只存在于 Compose 容器内部的端口作为用户访问地址。

当前根目录已经提供的基础验证命令为：

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

数据库和队列服务启动后，可按工程实际 `package.json` 使用以下工作流命令：

```bash
docker compose up -d
pnpm db:migrate
pnpm dev
pnpm test:integration
pnpm test:e2e
```

第二段命令在对应脚本存在后才可执行；具体脚本名称以根目录 `package.json` 为准。若某个脚本尚未实现，应在 PR 中说明，而不是伪造通过结果。

## 服务器模式

服务器模式把 Gitea、PostgreSQL、Registry、API、Worker、Web、`agent-review` 和每次 Run 的 Kubernetes 资源部署到同一个单节点 k3s。Worker 使用 In-Cluster ServiceAccount，不把宿主机 kubeconfig 注入任务。

服务器预览必须满足以下之一：

- 配置 `PREVIEW_BASE_URL` 和 DNS/hosts 映射，使用带过期时间的 Traefik Ingress；或
- 没有稳定域名时，仅使用 SSH 隧道，并明确告知 Demo 参与者这是隧道访问。

没有稳定地址时，不得把服务器上的 port-forward 端口写成用户本机可直接访问的 URL。

## 环境变量与凭据

配置校验必须拒绝缺失或不一致的部署参数，至少包括：

- `REGISTRY_PUSH_HOST`：BuildKit 推送地址
- `REGISTRY_PULL_HOST`：Preview 拉取地址
- `KUBECONFIG`：仅本地受信任 Worker 使用；服务器模式改用 In-Cluster 配置
- `PREVIEW_BASE_URL`：服务器 Ingress 模式使用
- `GITEA_PUBLIC_URL`：OAuth 浏览器跳转使用；容器内访问地址仍由 `GITEA_BASE_URL` 提供
- `GITEA_RUNNER_BASE_URL`：k3d/k3s 任务容器访问 Gitea 的受控地址；本地 k3d 默认使用 `host.k3d.internal:3001`
- `MAX_ACTIVE_RUNS=1`、`MAX_QUEUED_RUNS=3`：课程版容量上限
- `AGENT_PROVIDER=mock`、`PREVIEW_MODE=local`：本地默认路径
- Gitea OAuth、Webhook 签名、数据库、Session 加密和 Registry 凭据

Registry 推送和拉取地址不能使用 `localhost`。密钥只放在本地未提交的环境文件、Secret 管理器或 Kubernetes Secret 中，不进入 Git、Issue、PR、日志、Agent 输入、报告或 Gitea Comment。默认 Agent Provider 为 Mock；真实 OpenAI-compatible API 仅是可选演示路径。

## 数据库与队列

启动顺序是 PostgreSQL readiness、单个 migrate Job 或迁移服务成功，然后才启动 API、Worker 和 Web。Drizzle 只管理业务表；pg-boss 独占自己的 schema 和 migration。API 和 Worker 不得并发执行 migration。

Webhook 必须基于原始请求字节校验签名，使用 delivery ID 幂等，并在同一事务写入事件、Run 和 `workflow_outbox`。Worker 重启后，Outbox Reconciler 应能补投任务；重复投递不得重复执行已经完成的步骤。

## 代码与测试约束

- 使用 TypeScript、pnpm Workspace、NestJS/Fastify、React/Vite、Drizzle、Zod 和 Pino，除非有记录充分的 ADR。
- 固定 Profile 只允许 Node.js 22 和 Python 3.12 的受控运行方式。P0 不接收用户 Dockerfile，不在任务容器内访问公网安装未知依赖。
- 每次 Run 最多一个活动执行任务，最多三个排队任务；超出容量要落库为 `REJECTED_BY_CAPACITY`。
- 对 Webhook、状态机、Outbox、RBAC、脱敏、清理和旧 `head_sha` 状态回写增加自动化测试。
- 测试失败、健康检查失败和基础设施失败要区分 `FAILED` 与 `INCOMPLETE`，不能静默变成通过。

建议的验证顺序是单元测试、集成测试、API E2E，再执行一次 Node 成功 PR、一次 Node 测试失败 PR 和一次清理验证。测试不得使用真实生产凭据或公共不可信仓库。

## 日志与清理

平台日志为 JSON，单步骤上限 20 MiB；日志、报告、Finding 和临时镜像默认保留 7 天。Preview 默认保留 30 分钟。成功、失败、超时、取消和 Worker 重启后的孤儿 Namespace 都必须清理；清理失败要记录 `cleanup_status=FAILED` 和错误原因。

Gitea、PostgreSQL、Registry 和平台日志使用独立的持久化卷。课程版单节点的 local-path 存储没有高可用能力；重要数据删除前需要备份和人工确认。
