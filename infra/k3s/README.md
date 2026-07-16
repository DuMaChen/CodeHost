# 单节点 k3s 部署

该目录是服务器演示路径：一个 k3s server/node 同时承载 Gitea、PostgreSQL、Registry、API、Worker、Agent Review 和每个 Run 的 Kubernetes 资源。没有多节点高可用、故障转移或恶意代码生产级隔离承诺。不要给这些基础服务添加要求多节点的反亲和性或拓扑分散规则。

## 前置条件

- 单节点 k3s，启用 Traefik 和默认 local-path provisioner；推荐 8 vCPU、16 GiB RAM、80-100 GiB SSD。
- 节点至少预留 20% CPU 和内存给 k3s、CoreDNS、local-path-provisioner、Traefik 和 Registry。
- 管理端有 `kubectl` 和 `envsubst`（gettext）；节点的 `/etc/rancher/k3s/registries.yaml` 已配置。
- `REGISTRY_HOST` 是服务器私有 DNS 或私有 IP，不带协议、路径和端口，不能是 `localhost`、`127.0.0.1` 或 `0.0.0.0`。

## 安装

```sh
cp infra/k3s/.env.example /tmp/platform-k3s.env
# 编辑 /tmp/platform-k3s.env，替换所有示例密码、域名和镜像 tag
set -a
. /tmp/platform-k3s.env
set +a
infra/k3s/install.sh
```

`install.sh` 会校验非本机 Registry 地址、服务器域名、敏感值、平台镜像和 `AGENT_REPLICAS`（只能是 1-3），将 `platform.yaml.tmpl` 渲染到未跟踪的临时文件，先应用 RBAC，再应用基础资源和唯一的 `platform-migrate` Job。Job 等待 PostgreSQL 就绪并完成 Drizzle migration；安装脚本确认 Job 成功后才等待 API、Worker、Agent Review 和 Web rollout。敏感值只从当前 shell 输入，不写回仓库。重复安装会先删除上一轮已完成的迁移 Job，使新 migration 能被执行。

首次部署前必须完成镜像链路 smoke test：

```text
rootless BuildKit push -> REGISTRY_HOST:30500 -> k3s containerd pull -> Preview Deployment
```

## 拓扑与边界

- Gitea、PostgreSQL、Registry 和平台日志分别使用 5 GiB、10 GiB、20 GiB、10 GiB 的 `platform-local-path` PVC；StorageClass 的回收策略是 `Retain`。清理前先备份。
- 每个 Run 由 Worker 创建独立 Namespace、4 GiB `workspace` PVC、ResourceQuota、LimitRange、Restricted PSA 和默认 ServiceAccount（`automountServiceAccountToken=false`）；Run PVC 使用 k3s 的 `local-path`/Delete 策略，不与平台 PVC 共用。
- Worker 使用 `platform-worker` In-Cluster ServiceAccount。ClusterRole 只授予计划要求的 Namespace、Quota、LimitRange、Job、Pod/log、Deployment、Service、Ingress、PVC 和一次性 source-fetch Secret 权限；不授予 Node、CRD、RBAC 或 ServiceAccount 管理权限，也不允许 `pods/exec`。
- API、Gitea、PostgreSQL、Registry 和 Agent 均关闭不需要的 ServiceAccount Token；Agent 只能通过 `agent-model-api` Secret（可选）读取模型 Key，不接触 Kubernetes API、Gitea Token 或用户代码。
- 所有平台容器显式 non-root、禁止提权、丢弃全部 capabilities、RuntimeDefault seccomp；API、Worker 和 Agent 使用只读根文件系统，仅通过日志 PVC 和受大小限制的 `/tmp` 写入。
- 资源按 PROJECT_PLAN.md 的单节点预算设置。Agent Review 默认 1 副本，8 vCPU/16 GiB 服务器可通过 `AGENT_REPLICAS=3` 扩到 3；这代表队列消费者容量，不代表同一 PR 生成三份报告。

## Registry TLS

k3s 节点必须把 `infra/registry/k3s-registries.yaml.example` 配置成实际的 `/etc/rancher/k3s/registries.yaml` 并重启 k3s。HTTP 只允许私有实验网络；正式服务器必须使用 HTTPS 和 CA。Preview image 使用 `REGISTRY_PULL_HOST`，BuildKit 使用 `REGISTRY_PUSH_HOST`，两者都由 install 脚本注入，不接受用户 Run 覆盖。

没有稳定 DNS 和 `PREVIEW_BASE_URL` 时，只验收 SSH 隧道模式；不要把服务器端 port-forward 端口宣称为用户本机 URL。
