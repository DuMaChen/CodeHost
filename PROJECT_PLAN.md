# AI-Native PR Quality Platform

## 1. 项目定位

本项目不是从零实现 GitHub，也不宣称提供生产级代码托管或不可信代码沙箱。

项目定位：

> 基于 Gitea 的 AI 原生 PR 质量与 Kubernetes 预览平台。

Gitea 负责仓库、Issue、PR、Review、权限和分支保护。平台新增的闭环是：

~~~text
PR -> Webhook -> 项目识别 -> 固定测试与安全检查
   -> Kubernetes 临时预览 -> Agent 结构化审查
   -> Gitea Status / Comment -> 人工 Review
   -> 合并或阻断 -> 自动清理
~~~

### 目标用户

- 受邀的计算机专业学生团队
- 教师或项目维护者
- 非敏感的课程示例仓库

### 成功标准

本地开发模式使用 Docker Compose + k3d；服务器演示模式使用单节点 k3s。两种模式都针对 Node.js 和 Python 示例仓库跑通成功 PR、失败 PR、Kubernetes 临时环境、Agent 报告、Gitea 状态回写、人工批准和资源清理。

## 2. 产品边界

### P0：必须完成

- Gitea 接入、Webhook 签名校验和 delivery ID 幂等
- PostgreSQL 运行记录和 pg-boss 任务队列
- Gitea OAuth、仓库权限检查和最小 Worker RBAC
- Node.js、Python 两个固定运行 Profile
- 单容器、单 HTTP 端口
- 平台生成受控 Dockerfile
- rootless BuildKit 构建镜像
- 固定测试、健康检查和 Gitleaks
- 每次运行独立 Namespace
- ResourceQuota、LimitRange、Restricted Pod Security
- 非 root、只读根文件系统、无 ServiceAccount Token
- 预览 Deployment、Service 和本地访问方式
- Agent Mock Provider 和结构化报告
- Gitea Commit Status 和 PR Comment
- 一名人工 Reviewer 批准后才允许合并
- 成功、测试失败、健康检查失败 Fixture
- 日志、步骤状态、报告和自动清理
- Gitea、PostgreSQL、Registry 和平台日志持久化卷
- 单元、集成和 API 端到端测试
- Docker Compose + k3d 一键启动文档
- 单节点 k3s 部署文档和服务器 Ingress 配置
- README、架构文档、威胁模型和答辩脚本

### P1：明确延期

- 真实模型 API
- 用户自定义 Dockerfile
- Go Profile
- Trivy 镜像扫描
- kind + Calico 网络策略安全模式
- 多域名路由、TLS 自动签发和高级预览域名
- 多节点 k3s、HA 和自动故障转移
- Prometheus、Grafana、OpenTelemetry
- MinIO、S3、Redis、Kafka、RabbitMQ
- 两个以上活动构建任务
- 多容器、数据库依赖和微服务项目
- Forgejo 专项适配

### P2：不进入课程版本

- 公网用户提交任意仓库
- 生产级多租户隔离
- 对抗容器逃逸
- Agent 自动修改代码、创建修复 PR 或自动合并
- Agent 生成任意 Shell 或 Kubernetes YAML
- GPU、本地大模型、vLLM、AI 算力调度
- HA、自动扩缩容、计费和跨集群

## 3. 最终技术栈

| 层次 | 选择 |
|---|---|
| Git 托管 | Gitea，课程版只验证 Gitea |
| 运行时 | Node.js 22 LTS |
| 语言 | TypeScript 5.x |
| 后端 | NestJS 11 + Fastify |
| 前端 | React 19 + Vite + TanStack Query |
| 数据库 | PostgreSQL 16 |
| ORM | Drizzle ORM + drizzle-kit + node-postgres |
| 任务队列 | pg-boss，使用 PostgreSQL，不引入 Redis |
| 契约校验 | Zod，共享 API 和 Agent Schema |
| Kubernetes | 本地开发 k3d；服务器部署单节点 k3s + Traefik + 本地 Registry |
| K8s 客户端 | @kubernetes/client-node |
| 镜像构建 | rootless BuildKit |
| Agent | Mock Provider；可选 OpenAI-compatible API |
| 日志 | Pino JSON 日志，本地卷短期保存 |
| 安全检查 | Gitleaks P0，Trivy P1 |
| 测试 | Vitest、Supertest，API E2E 优先 |
| 包管理 | pnpm Workspace |
| 本地部署 | Docker Compose + k3d；服务器部署单节点 k3s |
| 许可证 | Apache-2.0 |

第 1 周完成可运行性验证后锁定准确 patch 版本、容器版本和 lockfile。P0 不同时维护 kind 和 k3d 两套方案。

rootless BuildKit 是 P0 技术闸门。若第 1 周 POC 失败，动态构建必须降为 P1，P0 的验收改为固定预构建 Fixture 镜像；不能在未验证时继续声称完整 P0 支持动态构建。

## 4. 本地资源和运行边界

- CPU：至少 4 核，推荐 8 核
- 内存：16 GB
- Docker Desktop：4 CPU、8 GB 内存起步
- 可用磁盘：本地开发至少 80 GB，服务器至少 100 GB
- GPU：不需要
- 本地开发：Docker Compose + k3d
- 服务器演示：单节点 k3s，Gitea、PostgreSQL、平台服务和 Run 资源都在同一 Node
- 活动任务：最多 1 个
- 排队任务：最多 3 个

16 GB 电脑不承诺同时运行 2 到 3 个重型构建。超过容量的任务仍记录 Webhook，但状态为 REJECTED_BY_CAPACITY。完整 Run 始终最多 1 个；服务器可运行 3 个轻量无状态 Agent 副本，它们从同一个 review 队列消费不同任务，不对同一个 PR 做多 Agent 聚合。

### 单服务器部署拓扑

一台服务器可以运行整个单节点 k3s 集群。Kubernetes 的调度单位是 Pod，不是物理服务器；多个 Agent Pod、Gitea、PostgreSQL、Worker 和预览 Pod 可以共享同一个 Node。

推荐服务器：

- 8 vCPU、16 GB RAM、80-100 GB SSD
- 4 vCPU、8 GB RAM 只适合无动态构建的轻量开发，不作为完整 Demo 配置
- 不需要 GPU
- 单节点没有高可用能力，服务器宕机会导致整个平台不可用
- 至少预留 20% CPU 和内存给 k3s、CoreDNS、local-path-provisioner、Traefik 和 Registry

资源预算：

| 工作负载 | 数量 | requests | limits |
|---|---:|---:|---:|
| Gitea | 1 | 250m / 256Mi | 500m / 512Mi |
| PostgreSQL | 1 | 250m / 256Mi | 500m / 512Mi |
| API + Worker + Web | 3 | 合计 500m / 768Mi | 合计 1.5 CPU / 2Gi |
| Agent review Deployment | 1 副本（服务器可配置 3） | 每个 100m / 128Mi | 每个 500m / 512Mi |
| Analysis Tools Job | 每个活动 Run 1 个 | 250m / 256Mi | 1 CPU / 1Gi |
| Build/Test Job | 最多 1 | 1 CPU / 1Gi | 2 CPU / 4Gi |
| Preview Deployment | 1 | 100m / 128Mi | 500m / 512Mi |

节点验收以 kubectl describe node 的 Allocatable 为准，不能以物理内存代替。k3s、CoreDNS、local-path-provisioner、Traefik、Registry 和其他系统组件至少预留 20% 资源；P0 不安装 Prometheus/Grafana。

Agent review Deployment 是无状态的报告处理副本，不执行用户代码、不访问 Kubernetes API、不读取 Sandbox Secret；它只通过受控 Secret 获取模型 API Key。需要执行 Gitleaks、测试整理等工具时，由当前 Run 创建一个 Analysis Tools Job。

P0 默认 1 个 Agent review 副本；8 vCPU / 16 GB 服务器可配置为 3 个副本。3 个副本是队列消费者容量，不代表同一个 PR 同时生成三份报告。

k3d 适合本地演示，但不是生产级恶意代码沙箱。课程版只接收受邀仓库和非敏感代码。P0 依赖 Namespace、Quota、LimitRange、Restricted Pod Security、non-root、无 hostPath、无 Docker Socket、无 privileged、无 host namespace、超时、日志上限和自动清理。

k3d 默认网络策略是否实际生效不作为 P0 安全承诺。需要网络隔离证明时，P1 再使用 kind + Calico 独立验证。

## 5. Monorepo 结构

~~~text
.
├── apps/
│   ├── api/                    # Webhook、REST API、Gitea API
│   ├── worker/                # pg-boss、工作流、K8s 编排、状态回写
│   └── web/                   # 运行状态、报告、日志、预览入口
├── packages/
│   ├── contracts/             # Zod Schema、API 和事件类型
│   ├── db/                    # Drizzle Schema、Migration、Query
│   ├── git-host/              # Gitea API 和 Webhook Adapter
│   ├── workflow/              # Run 状态机和步骤定义
│   ├── k8s/                   # Namespace、Job、Deployment、清理
│   ├── agent/                 # Prompt、Provider、报告解析
│   ├── config/                # 环境变量校验
│   └── testkit/               # 固定仓库、PR、日志、Mock Agent
├── examples/
│   ├── node-good/
│   ├── node-test-fail/
│   ├── python-good/
│   └── python-health-fail/
├── images/
│   ├── runner-node/
│   ├── runner-python/
│   └── buildkit-rootless/
├── infra/compose/
├── infra/k3d/
├── infra/k3s/
├── infra/registry/
├── scripts/
├── docs/
├── .gitea/workflows/
├── README.md
├── DEVELOPMENT.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
├── RELEASE.md
├── CHANGELOG.md
├── CODEOWNERS
├── LICENSE
├── package.json
├── pnpm-workspace.yaml
└── docker-compose.yml
~~~

长期应用包括 platform-api、platform-worker、platform-web 和可水平扩展的 agent-review Deployment。工具分析在每个 Run 的 Kubernetes Job 中执行，Worker 编排队列和生命周期，agent-review 只处理脱敏审查输入并调用模型。

## 6. 部署模式

### 本地模式

- Docker Compose 运行 Gitea、PostgreSQL、API、Worker、Web、agent-review 和迁移任务。
- k3d 运行每个 Run 的 Runner、BuildKit、Analysis 和 Preview 资源。
- Worker 通过只读 KUBECONFIG 访问 k3d；k3d bootstrap 固定 API 映射到宿主机端口 6550，并把 kubeconfig 中的 localhost 地址改写为 host.docker.internal:6550（Linux 使用 host-gateway）。该文件只挂载到受信任的 platform-worker，不挂载到任何用户任务。
- 本地 Registry 由 k3d bootstrap 脚本创建。
- 预览使用受控 port-forward；平台返回命令和本机端口，由宿主机上的开发脚本执行并管理进程，Compose 内 Worker 不启动一个只存在于容器内部的 port-forward。

### 服务器模式

- 单节点 k3s 运行 Gitea、PostgreSQL、API、Worker、Web、agent-review Deployment、Registry 和每个 Run 的资源。
- Worker 使用 In-Cluster ServiceAccount，不挂载宿主机 kubeconfig。
- 服务器提供稳定域名时，预览使用带过期时间的 Traefik Ingress。
- 服务器没有域名时，使用 SSH 隧道访问，不把服务器上的 port-forward 假装成用户可直接访问的 URL。
- 服务器 P0 验收前必须配置 PREVIEW_BASE_URL 和 DNS 或 hosts 映射；没有稳定地址时只验收 SSH 隧道模式，不宣称自动预览 URL 已完成。
- infra/compose、infra/k3d、infra/k3s 分别提供配置，三者不共用 Registry 地址。
- REGISTRY_PUSH_HOST、REGISTRY_PULL_HOST、KUBECONFIG 和 PREVIEW_BASE_URL 必须通过环境校验。

Registry 连接约定：

- k3d：bootstrap 创建接入 k3d 网络的 ai-registry:5000，BuildKit Pod 和 k3d containerd 都使用 ai-registry:5000；宿主机端口映射只用于调试，不把 localhost 写入 Pod 的镜像地址。
- k3s：部署 registry Service 和 NodePort 30500，使用服务器私有 DNS 名称 REGISTRY_HOST:30500；HTTP 只允许在私有实验网络使用，正式服务器模式配置 HTTPS CA。
- k3s 节点的 /etc/rancher/k3s/registries.yaml 必须声明该 Registry 的 endpoint；BuildKit 使用 REGISTRY_PUSH_HOST，Preview 使用 REGISTRY_PULL_HOST。
- Registry PVC 为 20 GiB，临时镜像必须带 run_id 标签，Retention Worker 删除过期 manifest 并执行 Registry garbage collection 窗口。
- 任何运行前必须完成 BuildKit push -> Registry -> containerd pull -> Preview Deployment 的 smoke test。

## 7. 核心工作流

### Webhook

接口：POST /webhooks/gitea

处理规则：

1. 校验 X-Gitea-Signature。
2. 校验仓库是否在允许列表。
3. 使用 Gitea delivery ID 幂等去重。
4. 只处理 opened、reopened、synchronize。
5. 对 repository + PR number + head SHA 建立唯一 Run。
6. 在同一数据库事务中写入 Run 和 workflow_outbox。
7. 由 Outbox Reconciler 幂等投递 pg-boss；投递失败不能丢弃事件。
8. 立即返回 202，不在 Web 请求中执行构建。

签名必须基于原始 HTTP 请求字节校验，不能基于已经解析或重新序列化的 JSON。

Webhook 还必须检查 payload 的 created 时间不超过 15 分钟；过期事件拒绝并记录 REPLAY_REJECTED。delivery ID、payload_hash、repository_id、external_number 和 head_sha 共同用于重放审计，不能只依赖一个可被重新生成的 delivery ID。

数据库约束：

- webhook_events 对 provider_delivery_id 唯一。
- runs 对 repository_id + pull_request_id + head_sha 唯一。
- 一个事务只允许一个活动 Run；使用 PostgreSQL advisory lock 或活动状态部分唯一索引。
- 最多 3 个 QUEUED Run；超出时创建 REJECTED_BY_CAPACITY，不投递队列。
- pg-boss 独占自己的 schema 和 migration；Drizzle 只管理业务表。

执行锁状态集合为 PLANNING、EXECUTING、ANALYZING、REPORTING、CANCEL_REQUESTED；QUEUED 不占用执行锁，但计入最多 3 个排队 Run。终态为 PASSED、FAILED、INCOMPLETE、CANCELLED、REJECTED_BY_CAPACITY。Run 进入终态后释放执行锁；CANCEL_REQUESTED 只有在相关 Job 和 Preview 删除确认后才能进入 CANCELLED。

### Run 状态

~~~text
RECEIVED -> QUEUED -> PLANNING -> EXECUTING
          -> ANALYZING -> REPORTING
          -> PASSED / FAILED / INCOMPLETE
          -> REJECTED_BY_CAPACITY
~~~

取消状态：CANCEL_REQUESTED -> CANCELLED。

run.status 的完整枚举为 RECEIVED、QUEUED、PLANNING、EXECUTING、ANALYZING、REPORTING、PASSED、FAILED、INCOMPLETE、CANCEL_REQUESTED、CANCELLED、REJECTED_BY_CAPACITY。

cleanup_status 独立为 NOT_SCHEDULED、PENDING、CLEANED、FAILED。

合法转移规则：

- RECEIVED -> QUEUED 或 REJECTED_BY_CAPACITY
- QUEUED -> PLANNING 或 CANCEL_REQUESTED
- PLANNING -> EXECUTING、INCOMPLETE 或 CANCEL_REQUESTED
- EXECUTING -> ANALYZING、INCOMPLETE 或 CANCEL_REQUESTED
- ANALYZING -> REPORTING、INCOMPLETE 或 CANCEL_REQUESTED
- REPORTING -> PASSED、FAILED 或 INCOMPLETE
- CANCEL_REQUESTED -> CANCELLED；只有清理确认后允许转移
- PASSED、FAILED、INCOMPLETE、CANCELLED、REJECTED_BY_CAPACITY 不再转移
- 应用失败（测试失败、构建失败、健康检查失败）先记录失败证据，跳过不再需要的后续步骤，仍进入 ANALYZING -> REPORTING，最终为 FAILED；基础设施失败、模型不可用或证据丢失最终为 INCOMPLETE
- retry 只能从 run.status=FAILED/INCOMPLETE 且 cleanup_status=CLEANED，或 cleanup_status=FAILED 经人工确认后创建新的 attempt，不能覆盖旧报告

步骤顺序：

~~~text
detect -> fetch -> analyze (Gitleaks + deterministic tools)
       -> test -> build -> preview -> health
       -> assemble-review-input -> agent-review
       -> report -> cleanup
~~~

如果 test、build 或 health 失败，后续不相关步骤跳过，但仍执行 assemble-review-input 和 agent-review；这样失败 PR 也能获得 Agent 解释。platform/preview 在未执行时写入 failure + SKIPPED_UPSTREAM，不能保持 pending。

### 合并门禁

平台 Worker 回写五个 Commit Status：

~~~text
platform/build
platform/test
platform/security
platform/preview
platform/quality-review
~~~

P0 合并条件：

1. 构建成功
2. 固定测试成功
3. Gitleaks 通过
4. 健康检查成功
5. Agent 报告成功生成
6. 至少一名非作者 Reviewer 批准

状态绑定当前 head_sha。旧 Run 只能更新旧提交的 Status，不能覆盖当前 PR 摘要。构建成功后 platform/build=success，构建失败或上游跳过为 failure；测试完成后 platform/test=success 或 failure；Gitleaks 完成后 platform/security=success 或 failure；预览健康后 platform/preview=success，未执行或健康失败为 failure。四个前置状态全部 success 且 Agent 报告有效时 platform/quality-review=success。任一前置状态失败、Agent INCOMPLETE、Schema 失败或容量拒绝都会使 platform/quality-review=failure。

Agent review Deployment 从 review 队列领取一个 Run 的脱敏输入并生成一份报告，不做多 Agent 聚合。Agent 风险发现是审查证据，不直接替代人工判断。模型失败时状态为 INCOMPLETE，不能静默变成通过。

## 8. Agent 设计

Agent 可以读取 PR Diff、测试结果、构建错误摘要、Gitleaks 结果、健康检查结果和受限静态分析结果，输出结构化审查报告。

Agent 不可以修改代码、创建分支、提交 PR、自动合并、访问 Kubernetes API、读取 Secret、读取 Gitea Token、生成任意 Shell、生成任意 Kubernetes YAML，或决定资源和安全上下限。

P0 的 Agent 结构分为两层：

- Analysis Tools Job：每个活动 Run 一个，读取 Source Fetch 的 workspace，以只读方式执行 Gitleaks 和固定静态检查；不调用模型。测试和健康检查结果由后续步骤补入审查输入。
- Agent review Deployment：默认 1 个副本，服务器可配置 3 个副本；只从 review 队列领取脱敏输入并调用模型，不执行用户代码。

Worker 负责创建 Analysis Tools Job、运行 Test/Build/Preview/Health，并在所有证据收集完成后组装输入和投递 review 队列。队列消息只包含 run_id、attempt、head_sha、input_hash 和经过脱敏、截断的 review 输入，单条输入最多 64 KiB；原始源码和原始日志不进入队列。Agent review Pod 只持有模型 API Key，不持有 Kubernetes Token、Gitea Token、用户代码执行权限或直接写数据库的权限；报告发布到 agent-review-result 队列，由 Worker 校验 run_id、attempt、head_sha、input_hash、Schema 和大小后持久化。

模型只接收 PR Diff、相关文件片段、测试结果、构建错误摘要、脱敏后的 Gitleaks 结果和健康检查结果。Gitleaks 的匹配原文、Secret 值和完整敏感代码片段在入队前必须替换为 [REDACTED]，不能写入日志、报告、数据库或 Gitea Comment。

Gitleaks 不得把原始 JSON 或错误内容输出到 stdout/stderr。Analysis Tools Job 将 stdout 和 stderr 重定向到仅该容器可读的临时文件，脱敏程序先读取并替换匹配值，再把摘要写入 analysis-output，随后立即删除原始文件；脱敏程序异常时该步骤失败且不发布任何报告。Worker 只采集脱敏后的结果。Secret Canary 测试必须检查 stdout、stderr、平台日志、Agent 输入、报告、数据库、Gitea Comment 和临时文件八个位置。

模型输出必须通过 Zod Schema：

~~~json
{
  "summary": "string",
  "riskLevel": "LOW|MEDIUM|HIGH|CRITICAL",
  "confidence": 0.0,
  "findings": [
    {
      "severity": "LOW|MEDIUM|HIGH|CRITICAL",
      "category": "bug|security|reliability|maintainability",
      "file": "string",
      "lineStart": 1,
      "lineEnd": 1,
      "title": "string",
      "description": "string",
      "evidence": "string",
      "recommendation": "string"
    }
  ]
}
~~~

输出中禁止出现 shellCommand、kubectlCommand、patch、commit 和 merge 字段。

报告限制：

- 最多 20 条 Finding
- 整个 report_json 最多 256 KiB
- summary 最多 4 KiB
- title、description、evidence 和 recommendation 各最多 8 KiB
- 去除 HTML、JavaScript、终端控制字符和外部链接
- 只允许仓库内文件路径和合法行号
- Schema 使用 strict object，拒绝未知字段；confidence 范围为 0 到 1；lineStart 和 lineEnd 必须为正整数且 lineStart <= lineEnd
- 文件路径必须存在于当前 head_sha，行号必须落在对应文件变更范围内
- 模型超时、Schema 失败或报告超限时标记 INCOMPLETE

Mock Provider 是默认验收路径。真实 OpenAI-compatible API 仅作为可选演示路径，密钥只存在 agent-review Deployment。

## 9. Node/Python 固定 Profile

P0 不允许用户提交或执行任意 Dockerfile。平台根据识别结果选择固定 Profile，并生成受控 Dockerfile。

### Node Profile

- 特征：package.json 或标准库示例文件
- 基础镜像：固定版本 node:22-bookworm-slim
- 默认端口：3000
- 测试：平台固定命令
- 示例优先使用 Node 标准库，避免任务容器访问公网安装依赖
- P0 只验收标准库、已打包依赖或平台预置缓存；未知依赖返回 UNSUPPORTED_PROFILE，不在任务容器中访问公网安装

### Python Profile

- 特征：pyproject.toml、requirements.txt 或标准库示例文件
- 基础镜像：固定版本 python:3.12-slim
- 默认端口：8000
- 测试：平台固定命令
- 示例优先使用 Python 标准库，避免任务容器访问公网安装依赖
- P0 只验收标准库、已打包依赖或平台预置缓存；未知依赖返回 UNSUPPORTED_PROFILE，不在任务容器中访问公网安装

自动识别只输出受限枚举和路径：

~~~text
projectType: node | python
profile: node-http | python-http
port: allowed integer
healthPath: allowed path
testProfile: node-basic | python-basic
~~~

禁止模型生成任意命令、任意 YAML 和任意资源限制。

## 10. Kubernetes 资源

每次运行创建新 Namespace：pr-run-<run-short-id>，不让同一 PR 复用旧 Namespace。

Namespace 创建时必须带上：

~~~text
pod-security.kubernetes.io/enforce=restricted
pod-security.kubernetes.io/audit=restricted
pod-security.kubernetes.io/warn=restricted
platform.io/managed=true
~~~

基础对象：

~~~text
Namespace
ResourceQuota
LimitRange
ServiceAccount
Source Fetch Job
Analysis Tools Job
Build/Test Job
Preview Deployment
Service
Ingress or port-forward configuration
workspace PVC
~~~

每个 Run 的 ResourceQuota：

~~~yaml
requests.cpu: "2"
limits.cpu: "4"
requests.memory: 3Gi
limits.memory: 6Gi
requests.ephemeral-storage: 4Gi
limits.ephemeral-storage: 6Gi
count/pods: "8"
count/jobs.batch: "4"
count/deployments.apps: "1"
count/services: "2"
count/persistentvolumeclaims: "1"
~~~

每个 Run 容器必须显式设置 ephemeral-storage requests/limits，避免 ResourceQuota 拒绝创建：

- Build/Test：requests 1Gi，limits 4Gi
- Analysis Tools：requests 256Mi，limits 1Gi
- Source Fetch：requests 256Mi，limits 1Gi
- Preview：requests 128Mi，limits 512Mi
- /tmp、BuildKit 和 analysis-output emptyDir 的 sizeLimit 不超过对应 limits

LimitRange 默认值为 requests.cpu=100m、limits.cpu=1、requests.memory=128Mi、limits.memory=1Gi、requests.ephemeral-storage=128Mi、limits.ephemeral-storage=1Gi；Worker 在提交资源前执行一次本地 Schema 和资源总量校验。

工作流阶段不得并行启动 Build/Test、Analysis 和 Preview。Build/Test Job 完成后先收集结果并删除，再创建 Preview Deployment；Analysis Tools Job 读取同一个 workspace PVC，完成后删除。

每个 Run 使用一个 4 GiB、ReadWriteOnce 的 workspace PVC，仅在该 Run Namespace 内使用。它不与其他 PR 共享，Namespace 删除时一并删除。

Gitea、PostgreSQL、Registry 和平台日志使用独立的持久化卷：

- Gitea：5 GiB
- PostgreSQL：10 GiB
- Registry：20 GiB
- 平台日志：5-10 GiB

本地 Compose 使用 named volume；单节点 k3s 使用 local-path StorageClass。Gitea、PostgreSQL、Registry 和平台日志 PVC 使用 Retain，必须先做备份/清理再删除；Run workspace PVC 使用 Delete，并由 Retention Worker 扫描孤儿 PVC/PV。local-path 只适合作业演示，没有高可用能力。

以下安全上下文适用于 Preview、Build/Test 和 Analysis 等 Run 工作负载；Gitea、PostgreSQL、Registry 和平台服务使用各自的持久化卷与服务配置，不与 Sandbox 工作目录混用。

容器安全上下文：

~~~yaml
runAsNonRoot: true
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities.drop: ["ALL"]
seccompProfile.type: RuntimeDefault
automountServiceAccountToken: false
~~~

Preview、Runner 和 Analysis 容器使用固定非 root UID。只读根文件系统不等于没有可写目录：

- /tmp 挂载带 sizeLimit 的 emptyDir
- /work 挂载 workspace PVC 或独立 emptyDir
- BuildKit 状态目录和缓存目录挂载带 sizeLimit 的 emptyDir
- 设置 TMPDIR 和语言级缓存路径

禁止 privileged、hostPath、hostNetwork、hostPID、hostIPC、Docker Socket、设备映射、长期 Secret 和用户提交的任意 Kubernetes YAML。

Worker 使用 platform-worker ServiceAccount。它使用专用最小权限 ClusterRole 管理 Namespace、ResourceQuota、LimitRange、Job、Pod、Deployment、Service、PVC 和日志读取；不允许读取任意 Secret、Node、CRD、ClusterRole 或管理 RBAC。创建和删除 Namespace 无法通过 Kubernetes RBAC 按标签限制，因此 Worker 必须是唯一持有该权限的受信任组件，并记录每次资源操作。

Worker RBAC 最小权限表：

| Resource | Verbs | 说明 |
|---|---|---|
| namespaces | get, list, watch, create, delete | 仅由 Worker 管理 Run Namespace；Kubernetes 无法按 label 限制该权限 |
| resourcequotas, limitranges | get, create, update, delete | 只操作 Run Namespace |
| jobs, pods, pods/log | get, list, watch, create, delete | 不允许 exec |
| deployments, services, ingresses | get, list, watch, create, update, delete | 只操作 Run 资源 |
| persistentvolumeclaims | get, create, delete | 只操作 Run workspace PVC |
| secrets | create, get, delete | 只用于一次性 source-fetch Token，不允许 list、watch、读取其他 Secret |

Worker 禁止 nodes、crds、clusterroles、clusterrolebindings、serviceaccounts 的管理权限。source-fetch Secret 的值由 Worker 写入后只用于挂载，Worker 不把它回显到日志。

P0 不为每个 Run 动态创建多个 ServiceAccount；Run Namespace 的 default ServiceAccount 在创建时设置 automountServiceAccountToken=false，Runner、Analysis 和 Preview 都使用它且不绑定 Role。Worker 在本地模式使用专用 kubeconfig，在服务器模式使用 In-Cluster ServiceAccount；两种凭据都不注入任务容器。

源码与结果传递：

- Source Fetch Job 使用一次性只读 Gitea 凭据，将不含 .git 和凭据的源码写入 workspace PVC；Token Secret 只挂载到 Source Fetch 容器，不挂载到 Build/Test、Analysis 或 Preview 容器，Source Fetch 完成后由 Worker 删除 Secret。
- Build/Test Job 以读写方式挂载 workspace PVC。
- Analysis Tools Job 以只读方式挂载 workspace PVC，并以读写方式挂载带 sizeLimit 的 analysis-output emptyDir；脱敏摘要和静态检查结果只写入 analysis-output。
- Preview 只使用构建后的镜像，不挂载源码 PVC。
- 测试、扫描和构建摘要在 Job 被删除前由 Worker 收集并写入数据库或平台日志卷。

镜像流程：

~~~text
平台生成 Dockerfile
-> rootless BuildKit
-> REGISTRY_PUSH_HOST
-> image digest
-> REGISTRY_PULL_HOST
-> Preview Deployment
~~~

BuildKit Job 使用 buildctl-daemonless.sh build，在固定 rootless BuildKit 镜像中运行。它不使用 Docker Socket、hostPath、kubeconfig 或长期 Registry 凭据。/tmp、BuildKit 状态目录、缓存和工作区必须是可写且有大小上限的卷。

BuildKit 镜像在第 1 周锁定 digest，固定 UID 1000，优先使用 native snapshotter；禁止使用 --oci-worker-no-process-sandbox，除非明确将构建模式标记为不安全实验。POC 必须验证 non-root、restricted PSA、无 /dev/fuse 依赖、push、pull 和 digest 部署。

Build/Test Job 的核心命令固定为 buildctl-daemonless.sh build --frontend dockerfile.v0 --local context=/work/source --local dockerfile=/work/build --output type=image,name=REGISTRY_PUSH_HOST/repo/run-id,push=true。REGISTRY_PUSH_HOST 由 bootstrap 写入，不允许用户输入覆盖；Preview 使用对应的 REGISTRY_PULL_HOST 和不可变 Digest。

REGISTRY_PUSH_HOST 和 REGISTRY_PULL_HOST 不能使用 localhost。k3d bootstrap 和 k3s bootstrap 分别写入 Registry 地址。服务器模式还必须配置 k3s registries.yaml、Registry 持久化卷和清理策略，并实际验证 BuildKit push -> Registry -> containerd pull -> Preview Deployment。

Job 生命周期字段：

~~~yaml
completions: 1
parallelism: 1
backoffLimit: 0
restartPolicy: Never
activeDeadlineSeconds: 900
ttlSecondsAfterFinished: 604800
~~~

Preview Deployment 固定 replicas=1、revisionHistoryLimit=0、progressDeadlineSeconds=60，并配置 readinessProbe。健康检查超时后由 Worker 删除 Deployment、Service、Ingress 和 Namespace。

Kubernetes 对象名称确定性生成：

~~~text
run-<run-short-id>-a<attempt>-<step-key>
~~~

Worker 创建前先按 Namespace、kind 和 name 对账；对象存在且 labels 的 run_id、attempt、step_key 匹配时直接接管，不重复创建；对象存在但标签不匹配时终止该 Run。每次对象的 UID 写入 k8s_resources，Worker 在重启后按 UID 和标签恢复状态。

本地模式使用受控 port-forward，并将端口和进程状态写入 Run。服务器模式必须使用带过期时间的 Traefik Ingress，或平台 API 的受鉴权反向代理；不能把服务器上的 port-forward 端口当作用户本机地址。

清理策略：

- 运行结束后预览保留 30 分钟
- 平台日志、reports、findings 和临时镜像的 logs_expires_at/reports_expires_at 设置为 7 天；Gitea Comment 只写入脱敏摘要，作为 PR 历史证据保留，不写入原始日志或 Secret，也不把它纳入平台 7 天删除承诺
- Worker 删除过期 Namespace
- 成功、失败、超时、取消都必须清理
- Worker 重启后扫描过期的 platform.io/managed=true Namespace
- Worker 在 Job TTL 删除前实时采集并截断日志，写入平台日志卷；正常路径由 Worker 在日志持久化后删除 Job，7 天 TTL 只作为 Worker 长时间离线时的兜底
- 超过单步骤 20 MiB 日志上限时终止该步骤并标记 LOG_LIMIT_EXCEEDED
- Retention Worker 每日删除过期日志、报告、Finding 和临时镜像
- Registry 只清理带 run_id 标签且已过期的临时镜像，不清理 Node/Python 基础镜像
- 清理失败将 cleanup_status 设为 FAILED，并保存 cleanup_error

## 11. PostgreSQL 数据模型

pg-boss 管理队列投递、租约、重试和死信；业务表不重复实现队列。

Drizzle 只管理业务表和业务 migration。pg-boss 独占自己的 schema 和 migration，drizzle-kit 不创建、修改或删除 pg-boss 表。

### repositories

~~~text
id, provider_repo_id, owner, name, full_name,
default_branch, enabled, created_at
~~~

唯一约束：provider_repo_id。

### pull_requests

~~~text
id, repository_id, external_number, head_sha, base_sha,
source_branch, title, author, state, updated_at
~~~

唯一约束：repository_id + external_number。每次 Webhook 更新该 PR 当前 head_sha，历史提交由 runs 保存。

### webhook_events

~~~text
id, provider_delivery_id, event_type, repository_id,
payload_hash, received_at, processed_at, error_message,
status, retry_count
~~~

唯一约束：provider_delivery_id。

### workflow_outbox

~~~text
id, run_id, attempt, step_key, queue_name,
payload_json, status, available_at, published_at,
attempts, lease_until, dedupe_key, last_error
~~~

唯一约束：run_id + attempt + step_key + queue_name；dedupe_key 固定为 run_id + step_key + attempt，并建立唯一索引。

事件入库、PR 更新、Run 创建和 Outbox 写入在一个事务中完成。Outbox Reconciler 使用 lease_until 领取记录，按 dedupe_key 投递 pg-boss；发布后进程崩溃时允许重复投递，但消费者必须先用 run_id + step_key + attempt 获取 advisory lock，并检查 run_steps 的终态，已成功或已失败的步骤直接确认并不重复执行。

### runs

~~~text
id UUID, repository_id, pull_request_id, head_sha, trigger,
status, verdict, namespace, preview_host,
execution_plan_json, workflow_version, current_attempt,
started_at, finished_at, cleanup_at, cleanup_status,
cleanup_error, preview_expires_at, logs_expires_at,
reports_expires_at, registry_ref, registry_expires_at,
error_code
~~~

唯一约束：repository_id + pull_request_id + head_sha。

### run_steps

~~~text
id, run_id, attempt, step_key, status, k8s_kind, k8s_name,
exit_code, log_path, artifact_digest,
started_at, finished_at, error_code, expires_at
~~~

唯一约束：run_id + attempt + step_key。

### reports

~~~text
id, run_id, attempt, head_sha, provider, model,
input_hash, verdict, summary, report_json,
created_at, expires_at
~~~

### findings

~~~text
id, report_id, severity, category, file_path,
line_start, line_end, title, description,
evidence, fingerprint, source, confidence, expires_at
~~~

### gitea_syncs

~~~text
id, run_id, attempt, head_sha, context,
external_status_id, comment_id, last_sync_error, synced_at
~~~

对同一 run 和 context 使用幂等更新；回写失败进入重试队列并显示在运行详情。

### k8s_resources

~~~text
id, run_id, attempt, step_key, namespace,
kind, name, uid, phase, created_at, deleted_at
~~~

唯一约束：run_id + attempt + step_key + kind + name。

### sessions

~~~text
id, gitea_user_id, encrypted_access_token,
created_at, expires_at, revoked_at
~~~

Session 数据只保存在服务端 PostgreSQL，access token 使用服务端 SESSION_ENCRYPTION_KEY 加密。浏览器只持有随机 HttpOnly session cookie，过期或注销后立即撤销。

### audit_events

记录重试、取消、配置修改、资源创建/删除、模型版本和报告版本。audit_events 也有 expires_at，默认保留 30 天。

### Migration 流程

1. PostgreSQL readiness 通过后，只运行一个 migrate Job 或 Compose migrate service。
2. migrate 成功后 API、Worker 和 Web 才启动。
3. API 和 Worker 不执行并发 migration。
4. pg-boss 启动时只检查并管理自己的 schema。
5. 每次升级先执行 migration，再运行 schema version smoke test。

## 12. API 契约

~~~text
GET  /auth/login
GET  /auth/callback
GET  /api/me

POST /webhooks/gitea

GET  /api/runs
GET  /api/runs/:runId
GET  /api/runs/:runId/steps
GET  /api/runs/:runId/logs
GET  /api/runs/:runId/report
GET  /api/runs/:runId/preview

POST /api/runs/:runId/retry
POST /api/runs/:runId/cancel

GET  /healthz
GET  /readyz
~~~

除 Webhook、healthz 和 readyz 外，所有 API 必须要求 Gitea OAuth 登录。读取 Run、日志和报告前，通过 Gitea API 验证当前用户对关联仓库的读取权限；retry、cancel 和配置变更要求仓库维护者权限。未登录返回 401，无权访问返回 403，并写入 audit_events。

OAuth 使用随机 state 和 nonce，绑定发起浏览器 Session，单次使用，5 分钟过期；回调失败、state 重放或 nonce 不匹配立即撤销临时状态。登录成功后轮换 Session ID。retry、cancel 和配置变更使用 POST + CSRF token，并再次校验当前用户的 Gitea 维护者权限。Session 使用 HttpOnly、SameSite 和 Secure Cookie；Gitea access token 只保存在服务端，不返回浏览器，不进入任务容器。

GET /api/runs/:runId/preview 返回 accessMode、status、url、expiresAt 和 sshTunnelCommand。服务器模式优先返回 Ingress URL；本地模式返回 port-forward 命令，不能把服务器端 port-forward 假装成用户本机 URL。

GET /api/runs/:runId/report 默认只返回当前 head_sha 和 current_attempt 的报告；历史 attempt 必须显式指定 attempt 参数。Gitea Status/Comment 也绑定 head_sha 和 attempt，旧 attempt 不能覆盖新提交。

前端只展示运行时间线、阶段状态、测试和构建结果、Namespace、预览入口、Agent 报告、失败日志和清理状态。仓库、Issue、PR、Review 继续使用 Gitea。

## 13. 安全基线

P0 测试：

- 无效 Webhook 签名被拒绝
- 重放 delivery ID 不重复创建 Run
- Namespace 先完成配额和 Pod Security 再启动任务
- Runner 无 Kubernetes API 权限
- 不可信 Runner、Analysis 和 Preview 容器无 Gitea Token、模型 Key、kubeconfig 和 ServiceAccount Token；只有受信任的 Source Fetch Job 可短时读取一次性 Gitea Token
- 禁止 Docker Socket、hostPath、privileged 和 host namespace
- CPU、内存、临时磁盘、日志和执行时长有上限
- PR-A 没有 Kubernetes API、Secret、PVC 或共享卷权限；跨 Namespace 网络隔离只有在 P1 NetworkPolicy 配置并通过连通性测试后才能宣称
- 报告清洗 HTML、JavaScript 和终端控制字符
- 成功、失败、超时、取消和 Worker 重启后都能清理
- 只有 Gitea 授权范围内的用户能读取运行和报告
- Prompt Injection 不能获得额外权限
- Gitleaks 的匹配原文、Secret 值和敏感代码片段在进入 Agent、报告、日志或 Gitea Comment 前必须变为 [REDACTED]
- API 未登录返回 401，无仓库权限返回 403，retry 和 cancel 需要维护者权限
- workflow_outbox 能在 Worker 崩溃后补投，不能出现数据库有 Run 但没有队列任务
- 过期报告、Finding、日志、Registry 临时镜像和 PVC 都能被 Retention Worker 清理

不能承诺防御 Kubernetes 内核漏洞、容器逃逸、公网不可信代码、SSD 密码学擦除、生产级多租户隔离和高并发。

README 必须写明：

> 本项目面向受邀学生团队和非敏感课程代码，提供受限的 Kubernetes 任务执行环境，不适用于生产环境或公共不可信代码。

## 14. Git 和开源治理

### 分支

- main 禁止直接推送、强制推送和删除
- 分支格式：feat/123-webhook、fix/145-cleanup、docs/20-quickstart
- 一个 Issue 对应一个主要目标
- 合并后删除短分支
- 使用 Squash Merge

### PR 必填

- 关联 Issue
- 目标和非目标
- 测试命令及结果
- 日志、截图或运行证据
- 数据库、配置或 K8s 变更说明
- 风险和回滚方式

### Required Checks

~~~text
platform/build
platform/test
platform/security
platform/preview
platform/quality-review
~~~

这些状态由平台 Worker 统一回写，Gitea 分支保护以它们和一名人工 Reviewer 作为合并条件。平台仓库本身的 lint、unit、integration 和 E2E 通过 pnpm ci 或后续 Gitea Actions 运行，但不把未定义的 CI Runner 伪装成 P0 门禁。

如果后续接入 Gitea Actions，Runner 只构建受信任的平台代码，使用 rootless BuildKit，不挂载 Docker Socket，不访问用户 Run 的 Kubernetes Secret 或工作区。

必备文档：

- README.md
- DEVELOPMENT.md
- CONTRIBUTING.md
- CODE_OF_CONDUCT.md
- SECURITY.md
- RELEASE.md
- CHANGELOG.md
- CODEOWNERS
- docs/architecture.md
- docs/threat-model.md
- docs/demo.md
- docs/adr/0001-gitea.md
- docs/adr/0002-monorepo.md
- docs/adr/0003-pg-boss.md
- docs/adr/0004-k3d.md
- docs/adr/0005-agent-boundary.md
- docs/adr/0006-single-node-k3s.md
- docs/adr/0007-worker-rbac.md

## 15. 10 周实施计划

### 第 1 周：工程和技术风险闸门

交付 Monorepo、Compose、PostgreSQL migration、healthz/readyz、k3d 和 k3s bootstrap 脚本，以及 rootless BuildKit 在 Restricted PSA 下构建并推送固定镜像的 POC。增加 Gitea、PostgreSQL、Registry 和日志卷。

若 BuildKit POC 失败，标记动态构建为 P1，使用固定预构建 Fixture 镜像完成其余闭环，不引入 Docker Socket。

### 第 2 周：Gitea

完成 Gitea 初始化、仓库允许列表、OAuth 登录、仓库权限映射、Webhook 签名、delivery 去重、repositories、pull_requests 和 webhook_events。

验收：创建 PR 能入库，错误签名返回 401，重复事件只有一条记录。

### 第 3 周：工作流和队列

完成 pg-boss、workflow_outbox、Run、Run Step、状态机、一次重试、取消请求、单活动 Run 限制和最小 Worker RBAC。

验收：

~~~text
Webhook -> pg-boss -> Worker -> Run 状态更新
~~~

### 第 4 周：Node Profile

完成 Node 识别、平台生成 Dockerfile、固定测试、rootless BuildKit、成功和测试失败 Fixture。

验收：Node 成功和失败两条路径可重复运行。

### 第 5 周：Kubernetes 预览

完成 Namespace、Quota、LimitRange、Restricted PSA、workspace PVC、Source Fetch Job、Analysis Tools Job、Build/Test Job、Preview Deployment、Service、Registry、Worker RBAC、服务器 Ingress、本地 port-forward 和 TTL 清理。

验收：

~~~text
PR -> image -> Namespace -> Pod -> Service -> preview -> cleanup
~~~

若第 5 周没有跑通预览，停止新增功能，进入 Node 单语言、Mock Agent、单活动任务降级模式。

### 第 6 周：Agent 报告

完成 Report Schema、Mock Provider、报告持久化、Finding 证据、Gitea Status、Comment、Gitleaks 强制脱敏、报告限额和 7 天 Retention Worker。

### 第 7 周：Web 运行台

完成运行列表、时间线、日志、报告、预览入口、失败原因和清理状态。先做正确性，不做复杂图表。

### 第 8 周：Python 和质量门禁

完成 Python Profile、Python Fixture、Gitleaks 阻断、Gitea 分支保护和 Required Checks。

### 第 9 周：可靠性和安全测试

完成重复 Webhook、Outbox 补投、Worker 重启、任务超时、取消、过期 Namespace 扫描、PVC 清理、Secret Canary、Gitleaks 脱敏、XSS 清洗、权限检查和连续两次运行。

### 第 10 周：交付和答辩

完成 README 新环境复现、CHANGELOG、v0.1.0、架构图、威胁模型、Demo 脚本和备用录屏。

## 16. 验收矩阵

| 编号 | 场景 | 通过标准 |
|---|---|---|
| G-00 | BuildKit 闸门 | rootless BuildKit 在 Restricted PSA 下完成固定镜像 push、containerd pull 和 Digest 部署；失败时动态构建转 P1 |
| G-01 | Node 成功 PR | Build、Test、Preview、Report、Gitea Status 和 Comment 全部成功，人工批准后可合并；若 G-00 失败则使用固定预构建 Fixture，并在结果中标注 BUILD_MODE=FIXTURE |
| G-02 | Node 测试失败 | platform/test 和 platform/quality-review 失败，PR 不能合并 |
| G-03 | Python 成功 PR | 第二种 Profile 运行成功 |
| G-04 | 健康检查失败 | Preview 不 Ready，报告显示原因，资源可清理 |
| G-05 | 重复 Webhook | 不创建重复 Run 或 Namespace |
| G-06 | 任务超时 | Run 失败或不完整，Namespace 被清理 |
| G-07 | 直接推送 main | Gitea 拒绝 |
| G-08 | 未人工批准合并 | 分支保护阻止合并 |
| G-09 | Agent 报告 | JSON 符合 Schema，Finding 有文件、行号和证据 |
| G-10 | 清理 | 成功和失败运行都能删除 Namespace |
| G-11 | Secret 边界 | Sandbox 看不到 Token、Key、kubeconfig |
| G-12 | 新环境 | 按 README 可启动并完成 Demo |
| G-13 | API 权限 | 未登录 401、无仓库权限 403、维护者操作受限 |
| G-14 | Outbox 恢复 | 模拟 Worker 崩溃后 Run 能被补投且不重复执行 |
| G-15 | Retention | 7 天到期的日志、报告、Finding、临时镜像和 Run workspace PVC 可清理，平台 PVC 按 Retain 策略保留 |
| G-16 | 服务器预览 | 配置 PREVIEW_BASE_URL 后，单节点 k3s 通过 Ingress 得到带过期时间的预览 URL；无该配置只验收 SSH 隧道模式 |
| G-17 | 持久化重启 | 重启 Gitea、PostgreSQL、Registry 和平台服务后仓库、Run、报告、镜像元数据和日志仍可读取 |
| G-18 | OAuth 与脱敏 | 成功 OAuth、伪造/重放/过期 state、Session Cookie、CSRF、Gitleaks Canary 和 Agent 输入脱敏测试全部通过 |
| G-19 | Worker RBAC | Worker 能完成 Run 资源生命周期，但无法读取 Node、任意 Secret、CRD 或管理 RBAC |
| G-20 | 状态机 | 所有合法转移、取消、重试、容量拒绝和清理状态都有自动化测试 |

## 17. 答辩 Demo

1. 打开 Gitea，展示仓库、PR、分支保护和 Required Checks。
2. 从分支创建 Node 成功 PR。
3. 展示 Webhook 和平台 Run 页面。
4. 展示项目识别、测试、BuildKit 构建和镜像 Digest。
5. 执行 kubectl get ns，展示独立 Namespace。
6. 本地模式通过 port-forward 打开预览服务；服务器模式打开带过期时间的 Traefik Ingress URL。
7. 展示 Agent 报告、Finding、日志和 Gitea Comment。
8. 未批准时尝试合并，展示阻断。
9. 人工 Review、批准并合并。
10. 创建测试失败 PR，展示质量门禁失败。
11. 展示失败日志和 Agent 解释。
12. 清理或等待 TTL，展示 Namespace 删除。
13. 展示重复 Webhook 不重复运行。

答辩核心表述：

> Agent 不替代测试和人工判断，它把代码变更、运行结果和风险整理成可审查证据。

## 18. 最终判定

课程版的真实交付物是：

> 一个基于 Gitea 的 AI 原生 PR 质量与 Kubernetes 临时预览平台，而不是完整的 GitHub 替代品。

P0 主验收路径是单节点 k3s + Ingress；Docker Compose + k3d 是本地开发和离线复现路径。只要 Node 成功 PR、Node 失败 PR、Gitea 质量门禁、Agent 结构化报告、Kubernetes Namespace、持久化和自动清理能够在选定路径重复运行，项目就达到课程版 MVP。其余能力必须服从这个闭环。
