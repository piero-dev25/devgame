// DevGame's ambient send context — the editor selection and the engine
// headline — carried on upstream's structured composer context records.
//
// Send side: `collectAmbientContextRecords` builds the records for ONE
// thread's project; every send path passes them to `buildMessageContext`
// (`ambientRecords`) and adds their inline references with
// `appendAmbientContextReferences`, so the server's provider projection
// renders them for every provider.
//
// Read side: `extractAmbientMessageContext` pulls them back out of a sent
// message before the timeline's generic record/inline-reference rendering
// runs, so the selection renders as `EditorSelectionMessageChips` above the
// body and the engine headline stays out of the visible text, exactly as the
// pre-records transport rendered. Messages sent before the records transport
// still carry trailing `<engine>` / `<editor_selection>` blocks; those are
// stripped through the legacy extractors, outermost first.
import type { ComposerContextRecord, OrchestrationMessageContext } from "@t3tools/contracts";

import { removeInlineContextReference } from "~/lib/composerContextReferences";
import {
  buildEditorSelectionContextRecord,
  extractTrailingEditorSelection,
  readEditorSelectionContextRecord,
  type ExtractedEditorSelection,
} from "./editorSelectionContext";
import {
  buildEngineStateContextRecord,
  extractTrailingEngineHeadline,
  readEngineStateContextRecord,
} from "./engineHeadline";
import type { EditorPresenceEntry } from "./protocol";
import {
  getCurrentEditorPresenceChips,
  getCurrentEditorPresenceEditors,
  selectEditorPresenceChipsForProject,
  type EditorPresenceProjectRef,
  type EditorPresenceRenderChip,
} from "./store";

/**
 * The records to attach to one outgoing message for the thread's project.
 *
 * - `engineChipState === "none"` (detection ran and this is not a game) sends
 *   nothing, matching the composer, which unmounts the chip row then.
 * - The selection is scoped to the thread's own project (task #71): a thread
 *   rooted at project A never ships project B's selected objects.
 * - The engine record comes last so its reference is the message's final one,
 *   like the old outermost `<engine>` block.
 *
 * `chips` and `editors` default to the live presence snapshots; tests pass
 * their own.
 */
export function collectAmbientContextRecords(input: {
  readonly project: EditorPresenceProjectRef | null;
  readonly engineChipState: string;
  readonly chips?: ReadonlyArray<EditorPresenceRenderChip>;
  readonly editors?: ReadonlyArray<EditorPresenceEntry>;
}): ComposerContextRecord[] {
  if (input.engineChipState === "none" || !input.project) return [];
  const chips = input.chips ?? getCurrentEditorPresenceChips();
  const editors = input.editors ?? getCurrentEditorPresenceEditors();
  const records: ComposerContextRecord[] = [];
  const selection = buildEditorSelectionContextRecord(
    selectEditorPresenceChipsForProject(chips, input.project),
  );
  if (selection) records.push(selection);
  const engine = buildEngineStateContextRecord(editors, input.project);
  if (engine) records.push(engine);
  return records;
}

const EMPTY_SELECTION: ExtractedEditorSelection = {
  promptText: "",
  entries: [],
  truncatedCount: 0,
};

export interface AmbientMessageContext<T extends AmbientMessage> {
  /** The message without its ambient context, for the generic record rendering. */
  readonly message: T;
  readonly editorSelection: ExtractedEditorSelection;
  readonly engineLines: ReadonlyArray<string>;
}

interface AmbientMessage {
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}

function isAmbientRecord(record: ComposerContextRecord): boolean {
  return (
    readEditorSelectionContextRecord(record) !== null ||
    readEngineStateContextRecord(record) !== null
  );
}

/** Splits a sent user message into its visible part and its ambient context. */
export function extractAmbientMessageContext<T extends AmbientMessage>(
  message: T,
): AmbientMessageContext<T> {
  const records = message.context?.records ?? [];
  const ambient = records.filter(isAmbientRecord);
  if (ambient.length > 0) {
    let text = message.text;
    for (const record of ambient) {
      text = removeInlineContextReference(text, record.contextId).prompt;
    }
    let editorSelection = EMPTY_SELECTION;
    let engineLines: ReadonlyArray<string> = [];
    for (const record of ambient) {
      editorSelection = readEditorSelectionContextRecord(record) ?? editorSelection;
      engineLines = readEngineStateContextRecord(record) ?? engineLines;
    }
    const remaining = records.filter((record) => !isAmbientRecord(record));
    const { context: _context, ...rest } = message;
    return {
      message: (remaining.length > 0
        ? { ...rest, text, context: { ...message.context!, records: remaining } }
        : { ...rest, text }) as unknown as T,
      editorSelection,
      engineLines,
    };
  }
  const engine = extractTrailingEngineHeadline(message.text);
  const selection = extractTrailingEditorSelection(engine.promptText);
  if (engine.lines.length === 0 && selection.entries.length === 0) {
    return { message, editorSelection: EMPTY_SELECTION, engineLines: [] };
  }
  return {
    message: { ...message, text: selection.promptText } as T,
    editorSelection: selection,
    engineLines: engine.lines,
  };
}
