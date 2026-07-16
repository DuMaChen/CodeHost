# k3d 本地集群

k3d 是本地 Compose + Kubernetes 演示路径。bootstrap 固定一个 server、可配置数量的 k3d agent 节点，并把 Kubernetes API 映射到宿主机 `6550`。Registry 使用独立的 `ai-registry:5000` 网络别名和 `ai-platform-k3d-registry` named volume；不要把 Compose 的 `registry:5000` 或服务器的 `${REGISTRY_HOST}:30500` 带入 k3d Pod。

## 启动

前置条件：Docker、k3d、kubectl，以及至少 4 CPU/8 GiB Docker 资源。执行：

```sh
K3D_AGENTS=1 infra/k3d/bootstrap.sh
```

服务器容许更多本地节点时可设置 `K3D_AGENTS`，但它表示 k3d 节点数量；Agent Review Deployment 的业务副本数仍由应用部署值控制，默认 1、上限 3。

bootstrap 会：

- 创建独立 Docker 网络和 Registry 容器，Registry 仅在宿主机 `5111` 暴露调试端口；
- 创建单 server 的 k3d 集群，并将 k3s containerd 配置为从 `http://ai-registry:5000` 拉取；
- 将宿主机 `kubectl` kubeconfig 写到 `infra/k3d/kubeconfig`，并另外生成只读的 Worker kubeconfig `infra/k3d/kubeconfig.worker`；后者把 API 地址改写为 `host.docker.internal:6550`；
- Worker 配置保留 `tls-server-name` 为 k3s Server 证书中的节点名，避免 Docker host gateway 地址改变 TLS 主机名校验。
- 等待所有节点 Ready。

Compose Worker 只读挂载该 kubeconfig。它是受信任的编排组件，用户 Run 的 Pod 不挂载 kubeconfig、Registry 凭据或 Docker Socket。

## 镜像 smoke test

BuildKit POC 必须实际验证下面的链路，再允许 Worker 创建 Preview：

```text
rootless BuildKit push -> ai-registry:5000 -> k3d containerd pull -> Preview Deployment
```

k3d 只适合受邀、非敏感课程仓库的演示，不提供生产级恶意代码隔离承诺。Run Namespace 的 Restricted PSA、Quota、LimitRange、non-root、只读根文件系统、无 host namespace 和无长期 Secret 由 Worker 创建资源时强制执行。

## Rootless BuildKit POC

先把经过验证的 BuildKit rootless 镜像 digest 和 Registry 镜像名放入 shell，例如 `BUILDKIT_IMAGE=moby/buildkit:rootless@sha256:<verified-digest>`、`BUILD_IMAGE=ai-registry:5000/platform/buildkit-smoke`，再渲染并执行 POC：

```sh
: "${BUILDKIT_IMAGE:?set a verified BuildKit digest}"
export BUILD_IMAGE="${BUILD_IMAGE:-ai-registry:5000/platform/buildkit-smoke}"
envsubst '${BUILDKIT_IMAGE} ${BUILD_IMAGE}' < infra/k3d/buildkit-rootless-poc.yaml.tmpl \
  | kubectl --kubeconfig infra/k3d/kubeconfig apply -f -
kubectl --kubeconfig infra/k3d/kubeconfig -n buildkit-poc wait \
  --for=condition=complete job/buildkit-rootless-poc --timeout=15m
```

这个 Job 使用 rootless BuildKit、native snapshotter、Restricted PSA、大小受限的 `emptyDir`，不使用 privileged、hostPath、设备映射或 Docker Socket。POC 必须成功完成 push -> Registry -> k3d containerd pull 后，才能把动态构建标为 P0；否则按 PROJECT_PLAN.md 降级为固定 Fixture 镜像路径。
