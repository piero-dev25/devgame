// "Add to chat" for third-party browser-panel sources (Figma, Notion) — see
// docs/workbench/three-feature-decisions.md #4 and thirdPartySourceIdentity.ts.
//
// Deliberately a SEPARATE, parallel builder from previewAnnotation.ts's
// `buildPreviewAnnotationPrompt`/`<preview_annotation>` rather than an
// extension of it: `PreviewAnnotationPayload` is the live dev-preview
// annotation contract (elements/regions/strokes/styleChanges — the
// react-grab DOM-picking flow), shared with a feature this task must not
// touch. `<third_party_source>` is its own tag so extraction logic for one
// never has to account for the other's shape.
//
// The chip mirrors EditorPresenceChipRow's field pattern (label/kind/detail)
// as a PRECEDENT, not a shared component — see EditorPresenceChipRow.tsx's
// own doc comment; `EditorPresenceRenderChip` carries live-socket pin state
// this has no equivalent for.
import type { PreviewAnnotationScreenshot } from "@t3tools/contracts";

import type { ThirdPartySourceIdentity } from "./thirdPartySourceIdentity";

export interface ThirdPartySourceChip {
  readonly kind: "figma" | "notion";
  readonly label: string;
  readonly detail: string | null;
}

export function buildThirdPartySourceChip(
  identity: ThirdPartySourceIdentity,
): ThirdPartySourceChip {
  if (identity.source === "figma") {
    return {
      kind: "figma",
      label: identity.fileName ?? identity.fileKey,
      // Deliberately "Frame in context", never "Selected" — see
      // thirdPartySourceIdentity.ts's epistemic-status note: the URL
      // identifies the top-level frame, not a specific layer selection.
      detail: identity.frameNodeId ? `Frame ${identity.frameNodeId}` : null,
    };
  }
  return {
    kind: "notion",
    // No page title is captured today (see buildThirdPartySourceAnnotationPrompt's
    // separate `pageTitle` input) — the chip only has the identity, so it
    // falls back to the page id rather than promising a title it doesn't have.
    label: identity.pageId,
    detail: null,
  };
}

export interface ThirdPartySourceAnnotation {
  readonly identity: ThirdPartySourceIdentity;
  readonly pageUrl: string;
  readonly pageTitle: string | null;
  readonly comment: string;
  readonly screenshot: PreviewAnnotationScreenshot | null;
  readonly createdAt: string;
}

export function buildThirdPartySourceAnnotationPrompt(
  annotation: ThirdPartySourceAnnotation,
): string {
  const { identity } = annotation;
  const lines = ["<third_party_source>", `Source: ${identity.source}`];
  const title = annotation.pageTitle?.trim() || annotation.pageUrl.trim();
  lines.push(`Page: ${title}`);
  lines.push(`URL: ${annotation.pageUrl}`);

  if (identity.source === "figma") {
    lines.push(`File key: ${identity.fileKey}`);
    if (identity.frameNodeId) {
      lines.push(
        `Frame in context: ${identity.frameNodeId} (the top-level frame the user is working in, not a specific layer selection)`,
      );
    }
  } else {
    lines.push(`Page id: ${identity.pageId}`);
  }

  if (annotation.comment.trim()) {
    lines.push(`Comment: ${annotation.comment.trim()}`);
  }
  if (annotation.screenshot) {
    lines.push("The attached screenshot shows what the user is currently looking at.");
  }
  lines.push("</third_party_source>");
  return lines.join("\n");
}
