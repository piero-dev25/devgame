// Test fixture: a prepared primary (cookie-session) connection for the fork
// fetchers, which now take the whole `PreparedConnection` that upstream's
// `executeAuthenticatedEnvironmentHttpRequest` needs.
import {
  type PreparedConnection,
  type PreparedHttpAuthorization,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";

export function primaryPreparedConnection(
  input: {
    readonly environmentId?: EnvironmentId;
    readonly httpBaseUrl?: string;
    readonly httpAuthorization?: PreparedHttpAuthorization | null;
  } = {},
): PreparedConnection {
  const environmentId = input.environmentId ?? EnvironmentId.make("env-1");
  const httpBaseUrl = input.httpBaseUrl ?? "http://127.0.0.1:3000";
  const wsBaseUrl = httpBaseUrl.replace(/^http/, "ws");
  return {
    environmentId,
    label: "Test environment",
    httpBaseUrl,
    socketUrl: `${wsBaseUrl}/ws`,
    httpAuthorization: input.httpAuthorization ?? null,
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Test environment",
      httpBaseUrl,
      wsBaseUrl,
    }),
  };
}
