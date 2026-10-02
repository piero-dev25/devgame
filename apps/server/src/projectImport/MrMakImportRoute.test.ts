/**
 * `dispatchImportPlan` / `dispatchImportApply` / `dispatchImportStatus`: scope
 * gates, server-side resolution of the two projects the user picked, and how
 * service failures reach the wire. The service is a recording fake; its own
 * behavior is covered by importReview.test.ts.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  MRMAK_IMPORT_APPLY_PATH,
  MRMAK_IMPORT_PLAN_PATH,
  MRMAK_IMPORT_STATUS_PATH,
  MrMakImportApplyInput,
  OrchestrationProjectShell,
  ProjectId,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { MrMakImportReviewError } from "./importReview.ts";
import * as MrMakImport from "./MrMakImport.ts";
import {
  dispatchImportApply,
  dispatchImportPlan,
  dispatchImportStatus,
} from "./MrMakImportRoute.ts";

const MRMAK = ProjectId.make("project-mrmak");
const COMPARISON = ProjectId.make("project-comparison");
const ROOTS = new Map([
  [MRMAK, "/projects/mr-mak"],
  [COMPARISON, "/projects/mr-mak-comparison"],
]);

const makeSession = (
  scopes: EnvironmentAuth.AuthenticatedSession["scopes"],
): EnvironmentAuth.AuthenticatedSession => ({
  sessionId: AuthSessionId.make("test-session"),
  subject: "test-subject",
  method: "bearer-access-token",
  scopes,
});
const reader = makeSession([AuthOrchestrationReadScope]);
const operator = makeSession([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]);

const decodeProjectShell = Schema.decodeSync(OrchestrationProjectShell);
const projectionLayer = (roots: ReadonlyMap<ProjectId, string> | "fail") =>
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getProjectShellById: (projectId) =>
      roots === "fail"
        ? Effect.fail(new PersistenceSqlError({ operation: "test: projection lookup failure" }))
        : Effect.succeed(
            Option.map(Option.fromNullishOr(roots.get(projectId)), (workspaceRoot) =>
              decodeProjectShell({
                id: projectId,
                title: projectId,
                workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-10-03T00:00:00.000Z",
                updatedAt: "2026-10-03T00:00:00.000Z",
              }),
            ),
          ),
  });

/** A fake service that records what the routes asked of it. */
const makeService = (options: { readonly applyFails?: boolean } = {}) => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const layer = Layer.mock(MrMakImport.MrMakImport)({
    review: (input) => {
      calls.push({ method: "review", input });
      return Effect.die("the summary is not under test");
    },
    apply: (input) => {
      calls.push({ method: "apply", input });
      return options.applyFails
        ? Effect.fail(new MrMakImportReviewError({ reason: "stale-plan", paths: [] }))
        : Effect.die("the receipt is not under test");
    },
    status: (input) => {
      calls.push({ method: "status", input });
      return Effect.succeed({ import: null });
    },
  });
  return { calls, layer };
};

const applyInput = (overrides: Partial<MrMakImportApplyInput> = {}): MrMakImportApplyInput => ({
  sourceProjectId: MRMAK,
  destinationProjectId: COMPARISON,
  planId: "plan-1",
  choices: { "docs/readme.md": "take-source" },
  skillChoices: [],
  confirmExistingProject: false,
  ...overrides,
});

describe("MrMakImportRoute", () => {
  it("serves under /api, which single-origin dev already proxies", () => {
    for (const path of [
      MRMAK_IMPORT_PLAN_PATH,
      MRMAK_IMPORT_APPLY_PATH,
      MRMAK_IMPORT_STATUS_PATH,
    ]) {
      expect(isDevProxiedPath(path)).toBe(true);
    }
  });

  it.effect("gates the dry run and status on orchestration:read and apply on operate", () =>
    Effect.gen(function* () {
      const service = makeService({ applyFails: true });
      const run = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          MrMakImport.MrMakImport | ProjectionSnapshotQuery.ProjectionSnapshotQuery
        >,
      ) => effect.pipe(Effect.provide(Layer.merge(service.layer, projectionLayer(ROOTS))));
      const terminalOnly = makeSession([AuthTerminalOperateScope]);
      const planInput = { sourceProjectId: MRMAK, destinationProjectId: COMPARISON };

      const refused = [
        yield* run(dispatchImportPlan(terminalOnly, planInput)),
        yield* run(dispatchImportStatus(terminalOnly, { projectId: COMPARISON })),
        // Reading is not enough to write files into a project.
        yield* run(dispatchImportApply(reader, applyInput())),
      ];
      expect(refused.map((outcome) => outcome._tag)).toEqual([
        "insufficientScope",
        "insufficientScope",
        "insufficientScope",
      ]);
      expect(service.calls).toEqual([]);

      const status = yield* run(dispatchImportStatus(reader, { projectId: COMPARISON }));
      expect(status).toEqual({ _tag: "ok", value: { import: null } });
      const applied = yield* run(dispatchImportApply(operator, applyInput()));
      expect(applied._tag).toBe("ok");
      expect(service.calls.map((call) => call.method)).toEqual(["status", "apply"]);
    }),
  );

  it.effect("resolves both projects on the server and passes only their roots on", () =>
    Effect.gen(function* () {
      const service = makeService({ applyFails: true });
      const outcome = yield* dispatchImportApply(operator, applyInput()).pipe(
        Effect.provide(Layer.merge(service.layer, projectionLayer(ROOTS))),
      );
      // A typed service refusal is a wire error carrying its message.
      expect(outcome).toEqual({
        _tag: "ok",
        value: {
          _tag: "error",
          message: new MrMakImportReviewError({ reason: "stale-plan", paths: [] }).message,
        },
      });
      expect(service.calls).toEqual([
        {
          method: "apply",
          input: {
            sourceRoot: "/projects/mr-mak",
            destinationRoot: "/projects/mr-mak-comparison",
            planId: "plan-1",
            choices: { "docs/readme.md": "take-source" },
            skillChoices: [],
            confirmExistingProject: false,
          },
        },
      ]);
    }),
  );

  it.effect("refuses its own source, unknown projects and a broken projection", () =>
    Effect.gen(function* () {
      const service = makeService();
      const unknown = ProjectId.make("project-from-another-environment");
      const cases = [
        { roots: ROOTS, input: applyInput({ destinationProjectId: MRMAK }) },
        { roots: ROOTS, input: applyInput({ destinationProjectId: unknown }) },
        { roots: ROOTS, input: applyInput({ sourceProjectId: unknown }) },
        { roots: "fail" as const, input: applyInput() },
      ];
      const messages: Array<string> = [];
      for (const { roots, input } of cases) {
        const outcome = yield* dispatchImportApply(operator, input).pipe(
          Effect.provide(Layer.merge(service.layer, projectionLayer(roots))),
        );
        messages.push(
          outcome._tag === "ok" && "_tag" in outcome.value ? outcome.value.message : "",
        );
      }
      const plan = yield* dispatchImportPlan(reader, {
        sourceProjectId: COMPARISON,
        destinationProjectId: COMPARISON,
      }).pipe(Effect.provide(Layer.merge(service.layer, projectionLayer(ROOTS))));
      if (plan._tag === "ok" && "_tag" in plan.value) messages.push(plan.value.message);

      expect(messages).toEqual([
        "Choose a different destination: an import never writes into its source.",
        "Project not found.",
        "Project not found.",
        "Could not resolve project.",
        "Choose a different destination: an import never writes into its source.",
      ]);
      expect(service.calls).toEqual([]);
    }),
  );
});
