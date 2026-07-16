# Registry 运行约定

Registry 只保存带 `run_id` 标签的临时镜像和固定基础镜像。临时镜像必须通过 digest 部署，Retention Worker 只删除已过期且带 `run_id` 的 manifest，不删除 Node/Python 基础镜像。清理 manifest 后，在维护窗口执行 Registry garbage collection，并先确认没有活动 Run 引用 digest。

三种部署模式使用不同地址：

| 模式 | Pod/容器使用的 Registry 地址 | 持久化卷 |
| --- | --- | --- |
| Compose | `registry:5000` | `ai-platform-compose-registry` |
| k3d | `ai-registry:5000` | `ai-platform-k3d-registry` |
| 单节点 k3s | `${REGISTRY_HOST}:30500` | `platform-registry` PVC，20 GiB，Retain |

所有 Registry 配置均默认 HTTP，仅适用于本地或私有实验网络。服务器正式演示必须把 k3s 节点的 `registries.yaml` endpoint 改为 HTTPS 并配置 CA；不能把公网或用户输入直接作为 Registry 地址。

