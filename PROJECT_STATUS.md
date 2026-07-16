# 项目进度与目标记录

> 项目：PR Runway —— AI 原生 PR 质量门禁与 Kubernetes 临时环境管理平台  
> 更新时间：2026-07-16  
> 当前结论：课程版主闭环已经在准备好的 rootful k3s 环境中完成多条真实运行验证；扩展能力和部分安全/可靠性门仍未闭合。

完整的项目设计、组件职责、Kubernetes 资源生命周期、Agent 契约、API、部署、测试和答辩说明见 [PROJECT_DOCUMENTATION.md](/Users/gatesbil/Documents/Project/微课/PROJECT_DOCUMENTATION.md)。本文件保留为进度摘要和快速状态入口。

## 1. 项目目标

### 1.1 总目标

构建一个基于 Gitea 的 AI 原生代码托管质量平台：当学生提交 Pull Request 后，平台自动将代码变更送入受控的 Kubernetes 临时环境，完成项目识别、测试、安全检查、镜像/Preview 验证和健康检查，再由 Agent 根据确定性运行证据生成结构化审查报告，最后把结果回写 Gitea，由人工 Reviewer 决定是否合并。

核心闭环：

```text
Gitea PR
  -> 签名 Webhook / 幂等入库
  -> 受限项目识别与执行计划
  -> Kubernetes 独立 Namespace
  -> Fetch / Analysis / Test / Build / Preview / Health
  -> 脱敏证据汇总
  -> Agent Review 报告
  -> Gitea Status / Comment
  -> 人工批准或阻断合并
  -> Namespace、Job、PVC、日志和临时资源清理
```

### 1.2 课程目标

项目用于证明以下云原生和开源工程能力：

- 使用真实 Gitea 仓库、PR、Review、权限和分支保护；
- 使用 Kubernetes API 管理 Namespace、Quota、LimitRange、Job、Deployment、Service、PVC 和日志；
- 为每个 PR 提供可回收的独立临时测试/Preview 环境；
- 让 Agent 解释测试和运行证据，而不是直接决定合并或执行任意命令；
- 用固定 Fixture、自动化测试和真实 k3s 运行记录证明成功、失败、超时和清理路径；
- 在本地有限预算和单节点服务器条件下可以复现。

### 1.3 项目边界

项目面向受邀学生团队、教师和非敏感课程示例代码。它不是完整 GitHub 替代品，也不是生产级不可信代码沙箱、多租户平台或高可用 Kubernetes 集群。

明确不承诺：公网任意仓库、对抗容器逃逸、任意 Dockerfile/Shell/Kubernetes YAML、Agent 自动改代码或合并、多节点 HA、GPU、本地大模型、计费和跨集群生产运维。

## 2. 设计创新点

### 2.1 证据驱动的 AI 质量门禁

测试退出码、镜像 digest、健康状态、资源状态、日志摘要和 Gitleaks 结果先由确定性工具产生。Agent 只读取经过脱敏、截断和 Schema 约束的证据，生成结构化 Finding；最终合并仍需要自动检查和人工批准。

报告与 `run_id`、`attempt`、`head_sha` 和 `input_hash` 绑定，旧提交的报告不能覆盖新提交状态。

### 2.2 PR 级 Kubernetes 临时环境

每个 PR Run 创建独立 Namespace，并附带 ResourceQuota、LimitRange、Restricted Pod Security、tokenless ServiceAccount、workspace PVC、任务 Job、Preview Deployment 和 Service。Worker 负责创建、观察、对账、超时、取消和清理。

### 2.3 受约束的 AI 部署规划

目标版本将增加受 Schema 约束的 Planner 角色，用于从有限仓库证据中提出 Node/Python Profile、端口、健康路径和测试 Profile。Worker 会再次执行白名单和资源校验；Planner 不生成任意命令、Dockerfile、Kubernetes YAML，也不能访问 Kubernetes 或 Gitea 凭据。

### 2.4 可追溯的 Git-Run-Cluster 链路

平台希望将以下对象串成一条审计链：

```text
仓库 / PR / head_sha
  -> run_id / attempt
  -> execution plan
  -> Namespace / Job / Pod / Service UID
  -> image digest
  -> evidence input_hash
  -> Agent report
  -> Gitea Status / Comment
```

## 3. 当前系统架构

| 组件 | 当前职责 | 状态 |
|---|---|---|
| Gitea | 仓库、Issue、PR、Review、OAuth、分支保护 | 已接入并有远程证据 |
| Platform API | Webhook、OAuth、Run/Step/Log/Report/Preview API | 已实现，基础探活和权限路径已验证 |
| PostgreSQL | 业务表、Run、Step、报告、资源和审计数据 | 已部署并持久化 |
| pg-boss / Outbox | 异步工作流、租约、补投和幂等 | 已实现，局部恢复测试通过 |
| Platform Worker | 状态机、Kubernetes 编排、Gitea 回写、清理和 Retention | 主流程已真实运行，部分边界待补证据 |
| Kubernetes | 每 Run Namespace、Fetch/Analysis/Test/Build/Preview/Health | rootful k3s 真实运行通过；k3d 本地路径仍需独立复现 |
| Registry | 固定基础镜像和 digest-pinned Preview/Runner 镜像 | 基础服务可用；临时 manifest 写入/Retention 未闭合 |
| Agent Review | Mock Provider、可选 OpenAI-compatible Provider、严格报告 Schema | Mock 真实工作流已通过；完整真实模型路径非 P0 |
| Web | Run 列表、时间线、日志、报告、Preview、清理和操作入口 | 已实现并有契约测试 |
| 示例仓库 | Node/Python 成功、测试失败、健康失败 Fixture | 已有并用于远程验证 |

## 4. 已实现的主要能力

### 4.1 Git 与工作流

- Gitea Webhook 原始请求签名校验；
- delivery ID 幂等和重复事件去重；
- `repository + PR + head_sha` 关联 Run；
- PostgreSQL Outbox 防止数据库已写入但队列任务丢失；
- Run/Step 状态机、attempt 和下游跳过规则；
- Gitea 五个质量 Status 与脱敏 PR Comment 回写；
- main 分支保护、Required Checks 和人工批准门禁。

### 4.2 Kubernetes 与部署

- 本地 Docker Compose + k3d 设计路径；
- 远程单节点 rootful k3s 部署路径；
- 每个 Run 独立 Namespace；
- ResourceQuota、LimitRange、Restricted PSA；
- Source Fetch、Analysis、Test/Build、Preview 和 Health 工作流；
- Job deadline、日志截断、健康检查和清理；
- Preview TCP readiness 与 Worker Service HTTP health check 分离；
- Preview 使用不可变镜像引用；
- 本地 port-forward、服务器 Ingress/SSH 隧道模式；
- Worker Kubernetes Client 禁用 Node 22 stale keep-alive，避免长轮询产生 k3s HTTP 400；
- Preview 避免重复 reconcile，修复 Deployment controller 竞争导致的 HTTP 409。

### 4.3 Agent 与安全

- Mock Agent Provider；
- OpenAI-compatible Provider 接口，但默认不依赖真实模型；
- 输入脱敏、字节大小限制、截断和 hash；
- 严格 Agent Report Schema；
- Finding 文件、行号和变更范围校验；
- 禁止报告输出 Shell、patch、commit、merge 或 kubectl 字段；
- Gitleaks 结果在进入 Agent、日志、数据库和 Gitea Comment 前脱敏；
- Runner、Analysis 和 Preview Pod 使用非 root、只读根文件系统、无 ServiceAccount Token；
- Worker 最小 RBAC，不允许读取任意 Secret、Node、CRD、ClusterRole 或执行 `pods/exec`。

## 5. 已完成验证

验证来源为 [docs/verification.md](/Users/gatesbil/Documents/Project/微课/docs/verification.md)。下表只记录有明确运行证据的内容。

| Gate | 场景 | 结果和证据 |
|---|---|---|
| G-01 | Node 成功 PR | Run `42e19861-ae6e-471c-93b9-bbf00c0394fd` 全流程通过；使用 `BUILD_MODE=FIXTURE`；Preview、Report、Gitea 同步和 Namespace/PVC 清理完成 |
| G-02 | Node 测试失败 | Run `3be66b84-ed46-46b2-93d9-fc593f9165c3` 的 Test 失败；Build/Preview/Health 跳过；Run、质量报告和 Gitea Status 失败；cleanup 成功 |
| Recovery | 成功恢复 | Run `085eef63-59b6-4464-9c62-048d5494e2f0` 恢复为 `PASSED/CLEANED` |
| G-03 | Python 成功 PR | Run `838bcb17-fa39-4d55-90d9-a65df4b74b13` 识别 Python Profile，端口 8000、Test/Build/Preview/Health/Report 全部通过并清理 |
| G-04 | 健康检查失败 | Run `809602a1-db92-4899-aa4a-ac788a2e564f` 的 Preview 通过、Health 返回 `PREVIEW_HEALTH_CHECK_FAILED`，最终 `FAILED/CLEANED` |
| G-05 | 重复 Webhook | 同一 delivery ID 两次请求均返回 202；只有一条 Webhook 记录、一个 Run、无重复 Namespace |
| G-06 | 任务超时 | Run `b22cd5fc-8760-4d80-a28c-8f523315ffa4` 的 Fetch 返回 `INCOMPLETE/JOB_TIMEOUT`，下游跳过，最终 `INCOMPLETE/CLEANED` |
| G-07 | 直接推送 main | Gitea 返回 HTTP 403，直接推送被拒绝 |
| G-08 | 未批准合并 | Gitea 返回 HTTP 405，缺少审批时无法合并 |
| G-11 | Sandbox 凭据边界 | Runner/Analysis/Preview 无 ServiceAccount Token、敏感环境变量和 Secret 挂载 |
| G-17 | 准备好的 k3s 重启 | API、Worker、Agent Review、Web 重启后 Ready；Gitea/PostgreSQL/Registry PVC 保持 Bound，历史数据仍可读取 |
| G-19 | Worker RBAC | 允许读取 Namespace、创建 Job、读取 Pod 日志；拒绝任意 Secret、Node、CRD、ClusterRole |

### 5.1 本地验证证据

已有记录显示以下检查通过：

- 5 个 package 和 4 个 app 的 TypeScript build；
- 9 个 package/app 项目 no-emit typecheck；
- 单 Worker Vitest：31 个文件、123 个测试通过；
- API `/healthz`、无效 Webhook、Preview 配置和命令注入测试；
- Kubernetes runtime、Outbox recovery、API E2E、Compose 配置检查；
- k3s 模板 YAML 解析、迁移 Job 和 5 个运行时 Deployment 检查；
- Compose/k3d/k3s/Runner Shell 语法检查。

### 5.2 远程环境边界

远程证据来自准备好的 Ubuntu rootful k3s harness：

- 单节点 k3s，节点状态为 Ready；
- Docker、Compose、Gitea、PostgreSQL、Registry、API、Worker、Agent Review 和 Web 可用；
- 4 个平台 PVC 为 Bound，迁移 Job 完成；
- 使用 amd64 平台镜像和 digest-pinned Runner/Preview 镜像；
- 已完成多条真实 PR Fixture 流程，但不是全新、无预装材料的服务器复现；
- rootless k3s 的 cgroup/Preview sandbox 失败记录仍保留，不能用来宣称生产级隔离。

## 6. 尚未完成或只能部分证明的内容

| Gate/能力 | 当前状态 | 不能宣称的内容 | 下一步证据 |
|---|---|---|---|
| G-00 动态 rootless BuildKit | P1/未完成 | 不能宣称动态构建和完整 BuildKit 安全链路已通过 | Restricted PSA 下真实 push→Registry→containerd pull→digest 部署 |
| G-12 新环境 | 部分完成 | 当前只证明 prepared harness，不是 clean-room 新服务器 | 无预装镜像/数据的安装、迁移、首次 Run 和失败回滚 |
| G-15 Retention | 未完成 | 不能宣称临时 Registry manifest、孤儿 PVC/PV 全部自动清理 | manifest 写入、digest 保护、过期删除、孤儿扫描和清理回归 |
| G-18 OAuth/脱敏 | 部分完成 | 不能宣称真实浏览器 OAuth、有效 Session CSRF、state 过期和完整 Canary 已通过 | 浏览器流程、state/nonce、CSRF、八位置 Secret Canary |
| G-20 状态机/并发 | 部分完成 | 不能宣称完整并发和全量状态机证据 | PostgreSQL/pg-boss 真实并发、取消竞态、租约恢复、终态保护 |
| Planner Agent | 计划目标 | 当前 Reviewer 已实现不等于 Planner 已实现 | 受限 Schema、deterministic fallback、Mock 队列和拒绝测试 |
| Cluster Summary/Adapter | 计划增强 | 当前 Kubernetes 编排能力不等于完整集群管理 API | 集群摘要、资源对账、权限分离和真实 k3s API 证据 |
| k3d 本地完整闭环 | 设计/局部测试 | 不能用远程 k3s 结果代替本地 k3d 复现 | 本地安装、镜像 smoke test、成功/失败 Run 和清理 |

## 7. 当前配置和资源边界

- `K8S_JOB_TIMEOUT_MS` 正常默认值为 `900000` ms，远程 G-06 曾临时设置为 `5000` ms，验证后已恢复；
- 完整 Run 同时最多 1 个，排队最多 3 个；
- 服务器 Reviewer 默认 1 个副本，可配置 1-3 个；
- 本地建议 8 vCPU/16 GiB，远程单节点建议 8 vCPU/16 GiB；
- 不需要 GPU；
- Preview 默认保留约 30 分钟；日志、报告和临时产物目标保留 7 天；
- Gitea、PostgreSQL、Registry 和平台日志 PVC 应与 Run workspace PVC 分离；平台 PVC 使用 Retain，Run workspace 使用 Delete；
- 正式服务器 Registry 必须使用 HTTPS/CA；私有实验网 HTTP 不能写成生产安全配置。

## 8. 当前计划与下一步

详细方案草案见 [PROJECT_PLAN.v2-draft.md](/Users/gatesbil/Documents/Project/微课/PROJECT_PLAN.v2-draft.md)。该草案仍需完成架构、Kubernetes、安全、测试、课程范围和文档一致性审查后，才能替换权威 `PROJECT_PLAN.md`。

### 优先级 1：先闭合已有主线

1. 将当前已验证结果和未验证项固定到验收矩阵，补齐每个 Gate 的命令、预期输出、失败判定、回滚方式和证据路径；
2. 完成 G-15 Registry/Retention/PVC 清理边界；
3. 完成 G-18 OAuth/CSRF/Secret Canary 的真实测试；
4. 完成 G-20 状态机、并发、取消、租约和 Worker 重启回归；
5. 进行一次不依赖当前运行 Pod 的新环境部署验证。

### 优先级 2：强化 Kubernetes 集群管理创新

1. 抽出 Cluster Adapter，统一 k3d/k3s 的地址、Registry、凭据和资源操作；
2. 增加受保护的 Cluster Summary，只读展示节点 Allocatable、平台 Namespace、Run 资源、容量和清理状态；
3. 增加资源 UID/labels 对账、Worker 重启接管、冲突检测和清理审计；
4. 让 Web 从 API 已确认的 Cluster/Namespace 状态展示部署测试过程，不提供任意 kubectl。

### 优先级 3：增强 Agent，但不牺牲可验收性

1. 先实现 Planner 的严格 Schema 和 deterministic fallback；
2. 再实现 Planner 与 Reviewer 的不同输入、输出、队列和权限契约；
3. 使用 Mock Provider 完成可重复测试；
4. 真实模型和独立 Agent Deployment 作为 P1，不能成为课程主流程的单点依赖。

## 9. 每个 Target 的完成规则

所有新增或修复工作必须遵循：

```text
实现
  -> 单元/契约测试
  -> TypeScript build/typecheck
  -> 静态代码和配置审查
  -> 安全/RBAC 审查
  -> Kubernetes manifest/schema 检查
  -> 本地或远程真实运行验证
  -> 成功/失败/超时/清理回归
  -> 更新 docs/verification.md
```

最低要求：

- 不能只凭代码搜索或 Fixture 日志宣布 Kubernetes 功能完成；
- 失败和清理路径必须有独立证据；
- 旧 attempt、旧 head SHA 和旧报告不能覆盖新状态；
- 测试未运行、命令挂起或环境不匹配时必须明确记录，不能写成 Passed；
- 变更必须有回滚点，远程验证后恢复默认配置和临时 Fixture；
- 文档、README、架构图和实际部署模板必须保持一致。

## 10. 最终答辩目标

建议用一条成功路径现场演示，用失败和幂等路径展示已保存证据：

1. Gitea 展示 PR、main 分支保护和 Required Checks；
2. 触发一次 Node 成功 PR；
3. 展示 Run、ExecutionPlan、Cluster Summary、Namespace、Quota、Job、Preview 和镜像 digest；
4. 展示脱敏日志、Agent Finding 和 Gitea Comment；
5. 未批准时合并被阻断，人工批准后通过；
6. 展示测试失败或健康失败 Run 的下游跳过和资源清理；
7. 展示重复 Webhook 只产生一个 Run；
8. 说明单节点、Fixture、受邀代码和非生产沙箱边界。

最终完成标准是：P0 主流程能够重复运行，至少两种 Profile 和成功/失败路径有真实 Kubernetes 证据，Git-Run-Cluster-Agent-Gitea 状态可追溯，所有未完成项已明确标记，且文档没有把设计目标冒充成已实现能力。

## 11. 相关文档

- [PROJECT_PLAN.md](/Users/gatesbil/Documents/Project/微课/PROJECT_PLAN.md)：当前权威计划，待 v2 审查后更新；
- [PROJECT_PLAN.v2-draft.md](/Users/gatesbil/Documents/Project/微课/PROJECT_PLAN.v2-draft.md)：Kubernetes/Agent 增强版计划草案；
- [README.md](/Users/gatesbil/Documents/Project/微课/README.md)：项目简介和快速入口；
- [docs/architecture.md](/Users/gatesbil/Documents/Project/微课/docs/architecture.md)：架构与边界；
- [docs/deployment.md](/Users/gatesbil/Documents/Project/微课/docs/deployment.md)：本地和服务器部署顺序；
- [docs/threat-model.md](/Users/gatesbil/Documents/Project/微课/docs/threat-model.md)：威胁模型和安全承诺；
- [docs/verification.md](/Users/gatesbil/Documents/Project/微课/docs/verification.md)：当前验证证据与未闭合门；
- [docs/demo.md](/Users/gatesbil/Documents/Project/微课/docs/demo.md)：答辩演示路径。
