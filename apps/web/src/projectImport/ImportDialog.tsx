/**
 * "Import from Mr. Mak…": dry run, review, choose, apply, receipt, into the
 * project the Workspace panel shows. A thin renderer over
 * `resolveImportDialogView`, which decides what is shown and when Apply is
 * allowed. The source is another project of the same environment that the
 * user picks explicitly; both paths shown are the ones the server resolved.
 *
 * Apply writes files, so it asks once more in an AlertDialog and never runs
 * on its own after a dry run.
 */
import type { MrMakImportConflictChoice, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AlertTriangle } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { useProjects } from "~/state/entities";
import { usePreparedConnection } from "~/state/session";

import { postImportApply, postImportPlan } from "./fetchMrMakImport";
import {
  importPairKey,
  resolveImportDialogView,
  type ImportDialogState,
  type SkillChoice,
  updateDecisions,
} from "./importDialogView";

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

/** `record` with `key` set to `value`, or removed when `value` is undefined. */
function withEntry<V>(
  record: Readonly<Record<string, V>>,
  key: string,
  value: V | undefined,
): Readonly<Record<string, V>> {
  const rest = Object.entries(record).filter(([candidate]) => candidate !== key);
  return Object.fromEntries(value === undefined ? rest : [...rest, [key, value]]);
}

function PathLine(props: { label: string; path: string | null; detail?: string | null }) {
  return (
    <p className="flex min-w-0 flex-col text-xs">
      <span className="text-muted-foreground">{props.label}</span>
      <span className="truncate font-mono text-foreground">{props.path ?? "—"}</span>
      {props.detail ? <span className="text-muted-foreground">{props.detail}</span> : null}
    </p>
  );
}

export function ImportDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  destination: { readonly ref: ScopedProjectRef; readonly path: string };
  /** After an import changed the destination: refresh what shows it. */
  onImported: () => void;
}) {
  const id = useId();
  const { environmentId, projectId: destinationProjectId } = props.destination.ref;
  const sources = useProjects().filter(
    (project) => project.environmentId === environmentId && project.id !== destinationProjectId,
  );
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const [state, setState] = useState<ImportDialogState>({
    sourceProjectId: null,
    destinationProjectId,
    dryRun: null,
    decisionsPairKey: null,
    choices: {},
    skillChoices: {},
    confirmExistingProject: false,
    apply: null,
  });
  const [confirming, setConfirming] = useState(false);
  // The panel can move to another project while the dialog is open.
  const current = { ...state, destinationProjectId };
  const view = resolveImportDialogView(current);
  const source = sources.find((project) => project.id === current.sourceProjectId) ?? null;

  const runDryRun = async (sourceProjectId: ProjectId) => {
    if (prepared === null) return;
    const pairKey = importPairKey(sourceProjectId, destinationProjectId);
    setState((previous) => ({ ...previous, dryRun: { status: "running", pairKey } }));
    const outcome = await postImportPlan({ prepared, sourceProjectId, destinationProjectId });
    setState((previous) => ({ ...previous, dryRun: { status: "done", pairKey, outcome } }));
  };

  const apply = async () => {
    setConfirming(false);
    const request = view.applyRequest;
    if (prepared === null || request === null) return;
    setState((previous) => ({ ...previous, apply: { status: "running", planId: request.planId } }));
    const outcome = await postImportApply({ prepared, request });
    setState((previous) => ({
      ...previous,
      apply: { status: "done", planId: request.planId, outcome },
    }));
    if (outcome._tag === "ok") props.onImported();
  };

  // Decisions belong to the source and destination shown now (`updateDecisions`).
  const decide = (update: Parameters<typeof updateDecisions>[1]) =>
    setState((previous) => updateDecisions({ ...previous, destinationProjectId }, update));
  const setChoice = (path: string, choice: MrMakImportConflictChoice | undefined) =>
    decide((decisions) => ({ choices: withEntry(decisions.choices, path, choice) }));
  const setSkillChoice = (skill: string, choice: SkillChoice | undefined) =>
    decide((decisions) => ({ skillChoices: withEntry(decisions.skillChoices, skill, choice) }));

  const { plan, receipt } = view;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from Mr. Mak</DialogTitle>
          <DialogDescription>
            Copies a Mr. Mak workspace's committed content and skills into this project. The dry run
            writes nothing; nothing is imported until you apply it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-source`}>
                Source (the Mr. Mak project)
                <Select
                  value={current.sourceProjectId ?? ""}
                  items={Object.fromEntries(sources.map((project) => [project.id, project.title]))}
                  onValueChange={(value) => {
                    const next = sources.find((project) => project.id === value);
                    if (next) setState((previous) => ({ ...previous, sourceProjectId: next.id }));
                  }}
                >
                  <SelectTrigger id={`${id}-source`} className="min-w-0">
                    <SelectValue placeholder="Choose a project" />
                  </SelectTrigger>
                  <SelectPopup>
                    {sources.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Label>
              <PathLine label="Destination (this project)" path={props.destination.path} />
            </div>
            <PathLine
              label="Source path"
              path={plan?.source.path ?? source?.workspaceRoot ?? null}
              detail={
                plan
                  ? `Committed revision ${plan.source.revision}${plan.source.branch ? ` on ${plan.source.branch}` : ""}${
                      plan.source.dirtyCount > 0
                        ? `. ${plan.source.dirtyCount} uncommitted edits are not imported.`
                        : "."
                    }`
                  : null
              }
            />
            {plan?.destination.warning ? (
              <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
                <p className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                  {plan.destination.warning}
                </p>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${id}-confirm`}
                    checked={plan.destination.confirmed}
                    onCheckedChange={(checked) =>
                      decide(() => ({ confirmExistingProject: checked === true }))
                    }
                  />
                  <Label htmlFor={`${id}-confirm`}>Import into this project anyway</Label>
                </div>
              </div>
            ) : null}
            {view.dryRunError ? (
              <p className="text-xs text-destructive">{view.dryRunError}</p>
            ) : null}

            {plan ? (
              <>
                <Section title="Dry run">
                  <dl className="grid grid-cols-4 gap-2 text-xs">
                    {plan.counts.map((count) => (
                      <div key={count.label} className="flex flex-col">
                        <dt className="text-muted-foreground">{count.label}</dt>
                        <dd className="font-medium text-foreground">{count.value}</dd>
                      </div>
                    ))}
                  </dl>
                  {plan.nothingToImport ? (
                    <p className="text-xs text-muted-foreground">Nothing to import.</p>
                  ) : null}
                </Section>
                {plan.conflicts.length > 0 ? (
                  <Section title="Conflicts: files this project already has in another version">
                    <ul className="flex max-h-48 flex-col gap-1.5 overflow-y-auto">
                      {plan.conflicts.map((conflict) => (
                        <li
                          key={conflict.path}
                          className="flex items-center justify-between gap-2 text-xs"
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate font-mono">{conflict.path}</span>
                            <span className="text-muted-foreground">{conflict.reason}</span>
                          </span>
                          <ToggleGroup
                            aria-label={`What to do with ${conflict.path}`}
                            value={conflict.choice ? [conflict.choice] : []}
                            onValueChange={(next) => {
                              const value = next[0];
                              setChoice(
                                conflict.path,
                                value === "keep-destination" || value === "take-source"
                                  ? value
                                  : undefined,
                              );
                            }}
                          >
                            <Toggle value="keep-destination">Keep this project's</Toggle>
                            <Toggle value="take-source">Take Mr. Mak's</Toggle>
                          </ToggleGroup>
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                {plan.skillConflicts.length > 0 ? (
                  <Section title="Skill conflicts: this project has a different skill with the same name">
                    <ul className="flex flex-col gap-1.5">
                      {plan.skillConflicts.map((skill) => (
                        <li
                          key={skill.name}
                          className="flex items-center justify-between gap-2 text-xs"
                        >
                          <span className="min-w-0 truncate font-mono">{skill.name}</span>
                          <ToggleGroup
                            aria-label={`What to do with skill ${skill.name}`}
                            value={skill.choice ? [skill.choice] : []}
                            onValueChange={(next) => {
                              const value = next[0];
                              setSkillChoice(
                                skill.name,
                                value === "keep-existing" || value === "import-renamed"
                                  ? value
                                  : undefined,
                              );
                            }}
                          >
                            <Toggle value="keep-existing">Keep this project's</Toggle>
                            <Toggle value="import-renamed">Import as {skill.renamedTo}</Toggle>
                          </ToggleGroup>
                        </li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                {plan.requirements.length > 0 ? (
                  <Section title="Requirements (listed only, nothing is installed or called)">
                    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                      {plan.requirements.map((requirement) => (
                        <li key={requirement}>{requirement}</li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
                <Section title="Not imported">
                  <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                    {plan.exclusions.map((group) => (
                      <li key={group.rule}>
                        {group.label}: {group.count} ({group.examples.join(", ")}
                        {group.count > group.examples.length ? ", …" : ""})
                      </li>
                    ))}
                    {plan.excludedStores.map((store) => (
                      <li key={store}>{store}</li>
                    ))}
                  </ul>
                </Section>
                {plan.issues.length > 0 ? (
                  <Section title="Issues after import">
                    <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto text-xs text-muted-foreground">
                      {plan.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </Section>
                ) : null}
              </>
            ) : null}

            {receipt ? (
              <Section title="Receipt">
                <p className="flex items-center gap-2 text-xs text-foreground">
                  <Badge variant="success">Done</Badge>
                  {receipt.headline}
                </p>
                <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                  {receipt.rows.map((row) => (
                    <li key={row.label}>
                      {row.label}: {row.value}
                    </li>
                  ))}
                  {receipt.skills.map((skill) => (
                    <li key={skill}>Skill {skill}</li>
                  ))}
                  {receipt.conflictsLeft.map((conflict) => (
                    <li key={conflict.path}>
                      Left as it was: {conflict.path} ({conflict.reason})
                    </li>
                  ))}
                  {receipt.transforms.map((transform) => (
                    <li key={transform}>{transform}</li>
                  ))}
                  <li>{receipt.commit}</li>
                  <li>
                    Receipt {receipt.importId} at{" "}
                    <span className="font-mono">{receipt.receiptPath}</span>
                  </li>
                </ul>
              </Section>
            ) : null}
            {view.applyError ? <p className="text-xs text-destructive">{view.applyError}</p> : null}
            {view.applyBlockedReason && plan ? (
              <p className="text-xs text-muted-foreground">{view.applyBlockedReason}</p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={view.dryRunBlockedReason !== null || prepared === null}
            onClick={() => {
              if (current.sourceProjectId !== null) void runDryRun(current.sourceProjectId);
            }}
          >
            {plan ? "Run the dry run again" : "Dry run"}
          </Button>
          <Button
            type="button"
            disabled={view.applyRequest === null}
            onClick={() => setConfirming(true)}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogPopup>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Import into this project?</AlertDialogTitle>
            <AlertDialogDescription>
              {plan
                ? `Writes the reviewed files from ${plan.source.path} into ${plan.destination.path}. Files you chose to keep stay as they are, and nothing is deleted.`
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => void apply()}>Import</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Dialog>
  );
}
