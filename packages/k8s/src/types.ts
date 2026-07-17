export type Labels = Readonly<Record<string, string>>;
export type Annotations = Readonly<Record<string, string>>;
export type ResourceQuantities = Readonly<Record<string, string>>;

export interface ObjectMeta {
  readonly name: string;
  readonly namespace?: string;
  readonly labels?: Labels;
  readonly annotations?: Annotations;
  readonly uid?: string;
  readonly resourceVersion?: string;
}

export interface KubernetesObject<Spec = unknown> {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: ObjectMeta;
  readonly spec?: Spec;
}

export interface NamespaceObject extends KubernetesObject {
  readonly apiVersion: "v1";
  readonly kind: "Namespace";
}

export interface ServiceAccountObject extends KubernetesObject {
  readonly apiVersion: "v1";
  readonly kind: "ServiceAccount";
  readonly automountServiceAccountToken: false;
}

export interface ResourceQuotaSpec {
  readonly hard: ResourceQuantities;
}

export interface ResourceQuotaObject extends KubernetesObject<ResourceQuotaSpec> {
  readonly apiVersion: "v1";
  readonly kind: "ResourceQuota";
  readonly spec: ResourceQuotaSpec;
}

export interface LimitRangeItem {
  readonly type: "Container";
  readonly defaultRequest: ResourceQuantities;
  readonly default: ResourceQuantities;
}

export interface LimitRangeSpec {
  readonly limits: readonly [LimitRangeItem];
}

export interface LimitRangeObject extends KubernetesObject<LimitRangeSpec> {
  readonly apiVersion: "v1";
  readonly kind: "LimitRange";
  readonly spec: LimitRangeSpec;
}

export interface PersistentVolumeClaimSpec {
  readonly accessModes: readonly ["ReadWriteOnce"];
  readonly resources: {
    readonly requests: ResourceQuantities;
  };
  readonly storageClassName?: string;
  readonly volumeMode: "Filesystem";
}

export interface PersistentVolumeClaimObject
  extends KubernetesObject<PersistentVolumeClaimSpec> {
  readonly apiVersion: "v1";
  readonly kind: "PersistentVolumeClaim";
  readonly spec: PersistentVolumeClaimSpec;
}

export interface EmptyDirVolumeSource {
  readonly emptyDir: {
    readonly sizeLimit: string;
  };
}

export interface PersistentVolumeClaimVolumeSource {
  readonly persistentVolumeClaim: {
    readonly claimName: string;
    readonly readOnly?: boolean;
  };
}

export interface SecretVolumeSource {
  readonly secret: {
    readonly secretName: string;
    readonly optional: false;
  };
}

export type VolumeSource =
  | EmptyDirVolumeSource
  | PersistentVolumeClaimVolumeSource
  | SecretVolumeSource;

export interface Volume {
  readonly name: string;
  readonly emptyDir?: EmptyDirVolumeSource["emptyDir"];
  readonly persistentVolumeClaim?: PersistentVolumeClaimVolumeSource["persistentVolumeClaim"];
  readonly secret?: SecretVolumeSource["secret"];
}

export interface VolumeMount {
  readonly name: string;
  readonly mountPath: string;
  readonly readOnly?: boolean;
}

export interface ResourceRequirements {
  readonly requests: ResourceQuantities;
  readonly limits: ResourceQuantities;
}

export interface ContainerPort {
  readonly name: "http";
  readonly containerPort: number;
  readonly protocol: "TCP";
}

export interface EnvironmentVariable {
  readonly name: string;
  readonly value: string;
}

export interface HTTPGetAction {
  readonly path: string;
  readonly port: "http";
  readonly scheme: "HTTP";
}

export interface TCPSocketAction {
  readonly port: "http";
}

export interface Probe {
  readonly httpGet?: HTTPGetAction;
  readonly tcpSocket?: TCPSocketAction;
  readonly initialDelaySeconds?: number;
  readonly periodSeconds: number;
  readonly timeoutSeconds: number;
  readonly failureThreshold: number;
}

export interface Capabilities {
  readonly drop: readonly ["ALL"];
}

export interface ContainerSecurityContext {
  readonly runAsNonRoot: true;
  readonly runAsUser: 1000;
  readonly runAsGroup: 1000;
  readonly allowPrivilegeEscalation: false;
  readonly readOnlyRootFilesystem: true;
  readonly capabilities: Capabilities;
}

export interface PodSecurityContext {
  readonly runAsNonRoot: true;
  readonly runAsUser: 1000;
  readonly runAsGroup: 1000;
  readonly fsGroup: 1000;
  readonly seccompProfile: {
    readonly type: "RuntimeDefault";
  };
}

export interface Container {
  readonly name: string;
  readonly image: string;
  readonly imagePullPolicy: "IfNotPresent";
  readonly command?: readonly string[];
  readonly env?: readonly EnvironmentVariable[];
  readonly ports?: readonly [ContainerPort];
  readonly resources: ResourceRequirements;
  readonly securityContext: ContainerSecurityContext;
  readonly volumeMounts: readonly VolumeMount[];
  readonly readinessProbe?: Probe;
}

export interface PodSpec {
  readonly serviceAccountName: "default";
  readonly automountServiceAccountToken: false;
  readonly restartPolicy: "Never" | "Always";
  readonly securityContext: PodSecurityContext;
  readonly containers: readonly [Container];
  readonly volumes: readonly Volume[];
}

export interface PodTemplateSpec {
  readonly metadata: {
    readonly name?: string;
    readonly labels?: Labels;
    readonly annotations?: Annotations;
  };
  readonly spec: PodSpec;
}

export interface JobSpec {
  readonly completions: 1;
  readonly parallelism: 1;
  readonly backoffLimit: 0;
  readonly activeDeadlineSeconds: 900;
  readonly ttlSecondsAfterFinished: 604800;
  readonly template: PodTemplateSpec;
}

export interface JobObject extends KubernetesObject<JobSpec> {
  readonly apiVersion: "batch/v1";
  readonly kind: "Job";
  readonly spec: JobSpec;
}

export interface LabelSelector {
  readonly matchLabels: Labels;
}

export interface DeploymentSpec {
  readonly replicas: 1;
  readonly revisionHistoryLimit: 0;
  readonly progressDeadlineSeconds: 60;
  readonly selector: LabelSelector;
  readonly template: PodTemplateSpec;
}

export interface DeploymentObject extends KubernetesObject<DeploymentSpec> {
  readonly apiVersion: "apps/v1";
  readonly kind: "Deployment";
  readonly spec: DeploymentSpec;
}

export interface ServicePort {
  readonly name: "http";
  readonly port: 80;
  readonly targetPort: "http";
  readonly protocol: "TCP";
}

export interface ServiceSpec {
  readonly type: "ClusterIP";
  readonly selector: Labels;
  readonly ports: readonly [ServicePort];
}

export interface ServiceObject extends KubernetesObject<ServiceSpec> {
  readonly apiVersion: "v1";
  readonly kind: "Service";
  readonly spec: ServiceSpec;
}

export interface IngressPath {
  readonly path: "/";
  readonly pathType: "Prefix";
  readonly backend: {
    readonly service: {
      readonly name: string;
      readonly port: {
        readonly name: "http";
      };
    };
  };
}

export interface IngressRule {
  readonly host: string;
  readonly http: {
    readonly paths: readonly [IngressPath];
  };
}

export interface IngressSpec {
  readonly ingressClassName: "traefik";
  readonly rules: readonly [IngressRule];
  readonly tls?: readonly [{ readonly hosts: readonly [string]; readonly secretName: string }];
}

export interface IngressObject extends KubernetesObject<IngressSpec> {
  readonly apiVersion: "networking.k8s.io/v1";
  readonly kind: "Ingress";
  readonly spec: IngressSpec;
}

export interface PolicyRule {
  readonly apiGroups: readonly string[];
  readonly resources: readonly string[];
  readonly verbs: readonly string[];
}

export interface ClusterRoleSpec {
  readonly rules: readonly PolicyRule[];
}

export interface ClusterRoleObject extends KubernetesObject<ClusterRoleSpec> {
  readonly apiVersion: "rbac.authorization.k8s.io/v1";
  readonly kind: "ClusterRole";
  readonly spec?: never;
  readonly rules: readonly PolicyRule[];
}

export interface ClusterRoleBindingSubject {
  readonly kind: "ServiceAccount";
  readonly name: "platform-worker";
  readonly namespace: "platform-system";
}

export interface ClusterRoleBindingObject extends KubernetesObject {
  readonly apiVersion: "rbac.authorization.k8s.io/v1";
  readonly kind: "ClusterRoleBinding";
  readonly subjects: readonly [ClusterRoleBindingSubject];
  readonly roleRef: {
    readonly apiGroup: "rbac.authorization.k8s.io";
    readonly kind: "ClusterRole";
    readonly name: "platform-worker";
  };
}

export type ManagedKubernetesObject =
  | NamespaceObject
  | ServiceAccountObject
  | ResourceQuotaObject
  | LimitRangeObject
  | PersistentVolumeClaimObject
  | JobObject
  | DeploymentObject
  | ServiceObject
  | IngressObject;
