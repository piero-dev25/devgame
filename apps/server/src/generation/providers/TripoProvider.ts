/**
 * Tripo v2 provider — exactly the endpoints/shapes spike 0 validated live
 * against a real account (docs/v2/SPIKE_RESULTS.md). Do NOT invent
 * endpoints not covered there. v2 retires 2026-10-01; the v3 migration is a
 * filed fast-follow (OWNER_DOCKET.md D3), out of scope here.
 *
 * Credential: `ServerSecretStore` under the fixed name
 * `generation-provider-tripo` (frozen spec's "Credentials" section), seeded
 * from `~/.config/devgame/tripo-api-key` on first run if absent — dev
 * convenience only; production is the provider-env pattern (seams note
 * §3.4). The key is read from the secret store ONCE at layer construction
 * and cached for the process lifetime — never re-read per call, never
 * logged, never returned to a client.
 */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  Model3dProvider,
  Model3dProviderError,
  type Model3dProviderShape,
  type Model3dTaskState,
} from "./Model3dProvider.ts";

export const TRIPO_SECRET_NAME = "generation-provider-tripo";
const TRIPO_API_BASE = "https://api.tripo3d.ai/v2/openapi";
const TRIPO_MODEL_VERSION = "v2.5-20250123";

const TripoSubmitResponse = Schema.Struct({
  code: Schema.Int,
  data: Schema.Struct({ task_id: Schema.String }),
});

const TripoTaskStatus = Schema.Literals([
  "queued",
  "running",
  "success",
  "failed",
  "banned",
  "expired",
  "cancelled",
]);

const TripoPollResponse = Schema.Struct({
  code: Schema.Int,
  data: Schema.Struct({
    status: TripoTaskStatus,
    progress: Schema.Int,
    output: Schema.optional(
      Schema.Struct({
        pbr_model: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
        rendered_image: Schema.optional(Schema.String),
      }),
    ),
  }),
});

const toProviderError = (operation: string) => (cause: unknown) =>
  new Model3dProviderError({ detail: `Tripo ${operation} failed: ${String(cause)}` });

const defaultDevKeyPath = () => `${NodeOS.homedir()}/.config/devgame/tripo-api-key`;

/**
 * Reads the cached key if present; otherwise seeds it from the owner's key
 * file (dev convenience, frozen spec's "Credentials" section) and persists
 * it to the secret store so this file read happens at most once ever, not
 * once per server start.
 *
 * `devKeyPath` is injectable (defaults to the real
 * `~/.config/devgame/tripo-api-key`) purely so tests can exercise the
 * "no secret yet, fall back to a key file" branch without ever touching
 * this machine's REAL dev-convenience key file — the owner has one
 * configured per OWNER_DOCKET.md D3, and a test reading it live would be a
 * flaky, machine-dependent test.
 */
const resolveApiKey = Effect.fn("TripoProvider.resolveApiKey")(function* (
  devKeyPath: string = defaultDevKeyPath(),
) {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;

  const existing = yield* secretStore
    .get(TRIPO_SECRET_NAME)
    .pipe(Effect.mapError(toProviderError("secret read")));
  if (Option.isSome(existing)) {
    return new TextDecoder().decode(existing.value).trim();
  }

  const keyFilePath = devKeyPath;
  const fileContents = yield* fileSystem.readFileString(keyFilePath).pipe(Effect.option);
  if (Option.isNone(fileContents)) {
    return yield* new Model3dProviderError({
      detail: `No Tripo API key configured. Set the '${TRIPO_SECRET_NAME}' secret or create ${keyFilePath}.`,
    });
  }
  const key = fileContents.value.trim();
  yield* secretStore
    .set(TRIPO_SECRET_NAME, new TextEncoder().encode(key))
    .pipe(Effect.mapError(toProviderError("secret seed")));
  return key;
});

const mapTaskState = (data: typeof TripoPollResponse.Type.data): Model3dTaskState => {
  if (data.status === "success") {
    return {
      status: "success",
      progress: 100,
      modelUrl: data.output?.pbr_model ?? data.output?.model ?? "",
      renderedImageUrl: data.output?.rendered_image ?? null,
    };
  }
  if (
    data.status === "failed" ||
    data.status === "banned" ||
    data.status === "expired" ||
    data.status === "cancelled"
  ) {
    return { status: "failed", detail: `Tripo task ${data.status}` };
  }
  return { status: data.status, progress: data.progress };
};

export interface TripoProviderOptions {
  readonly devKeyPath?: string;
}

const makeWithOptions = Effect.fn("TripoProvider.make")(function* (
  options: TripoProviderOptions = {},
) {
  const httpClient = yield* HttpClient.HttpClient;
  const apiKey = yield* resolveApiKey(options.devKeyPath);

  const submitTextTo3d: Model3dProviderShape["submitTextTo3d"] = (input) =>
    HttpClientRequest.post(`${TRIPO_API_BASE}/task`).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.bodyJson({
        type: "text_to_model",
        prompt: input.prompt,
        model_version: TRIPO_MODEL_VERSION,
        ...(input.faceLimit === undefined ? {} : { face_limit: input.faceLimit }),
        texture: true,
        pbr: true,
      }),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TripoSubmitResponse)),
      Effect.map((response) => ({ providerTaskId: response.data.task_id })),
      Effect.mapError(toProviderError("submit")),
      Effect.withSpan("TripoProvider.submitTextTo3d"),
    );

  const pollTask: Model3dProviderShape["pollTask"] = (providerTaskId) =>
    HttpClientRequest.get(`${TRIPO_API_BASE}/task/${encodeURIComponent(providerTaskId)}`).pipe(
      HttpClientRequest.bearerToken(apiKey),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TripoPollResponse)),
      Effect.map((response) => mapTaskState(response.data)),
      Effect.mapError(toProviderError("poll")),
      Effect.withSpan("TripoProvider.pollTask"),
    );

  const deriveFbx: Model3dProviderShape["deriveFbx"] = (originalProviderTaskId) =>
    HttpClientRequest.post(`${TRIPO_API_BASE}/task`).pipe(
      HttpClientRequest.bearerToken(apiKey),
      HttpClientRequest.bodyJson({
        type: "convert_model",
        original_model_task_id: originalProviderTaskId,
        format: "FBX",
      }),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TripoSubmitResponse)),
      Effect.map((response) => ({ providerTaskId: response.data.task_id })),
      Effect.mapError(toProviderError("convert_model")),
      Effect.withSpan("TripoProvider.deriveFbx"),
    );

  return Model3dProvider.of({ submitTextTo3d, pollTask, deriveFbx });
});

export const layer = Layer.effect(Model3dProvider, makeWithOptions());

/** Exposed for tests, so `devKeyPath` can point at a throwaway path instead
 * of this machine's real `~/.config/devgame/tripo-api-key`. */
export const __testing = { make: makeWithOptions };
