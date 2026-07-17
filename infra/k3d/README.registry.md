# k3d Registry 约束

`ai-registry:5000` 只在 `ai-platform-k3d` 网络内使用。宿主机 `5111` 映射只是调试入口，不得写入 Kubernetes Pod 的 image、BuildKit output 或 Preview Deployment。临时镜像名必须包含 `run_id`，部署使用不可变 digest。

