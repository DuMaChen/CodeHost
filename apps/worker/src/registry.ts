export interface RegistryManifestReference {
  readonly registryHost: string;
  readonly repository: string;
  readonly digest: string;
}

export function parseRegistryManifestReference(value: string, runId: string): RegistryManifestReference {
  const at = value.lastIndexOf("@");
  const slash = value.indexOf("/");
  if (at <= 0 || slash <= 0 || !value.includes(`/${runId}/`)) throw new Error("registry reference is not a run-scoped manifest");
  const registryHost = value.slice(0, slash);
  const repository = value.slice(slash + 1, at);
  const digest = value.slice(at + 1);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || !/^[a-z0-9][a-z0-9._:/-]*$/.test(repository) || repository.includes("..") || repository.includes("//")) throw new Error("registry reference is invalid");
  if (!/^[a-z0-9][a-z0-9.:-]*$/.test(registryHost)) throw new Error("registry host is invalid");
  return { registryHost, repository, digest };
}

export class RegistryClient {
  private readonly baseUrl: string;
  private readonly baseHost: string;
  private readonly token: string | undefined;

  constructor(options: { readonly baseUrl: string; readonly token?: string }) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Registry API URL must use HTTP(S)");
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Registry API URL is invalid");
    this.baseUrl = url.toString().replace(/\/$/, "");
    this.baseHost = url.host;
    this.token = options.token;
    if (this.token !== undefined && url.protocol !== "https:") throw new Error("Registry API tokens require HTTPS");
  }

  async deleteManifest(reference: RegistryManifestReference): Promise<void> {
    if (reference.registryHost !== this.baseHost) throw new Error("registry reference host does not match configured Registry");
    const path = `/v2/${reference.repository}/manifests/${reference.digest}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.oci.image.manifest.v1+json",
        ...(this.token === undefined ? {} : { Authorization: `Bearer ${this.token}` }),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 || response.ok) return;
    throw new Error(`Registry manifest deletion failed with HTTP ${response.status}`);
  }
}
