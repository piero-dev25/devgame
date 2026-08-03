import { describe, expect, it } from "vite-plus/test";

import {
  ALLOWED_LEGAL_DOCUMENT_URLS,
  isLegalDocumentUrl,
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  resolveMarketingSiteUrl,
  SECURITY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
} from "./legal-document-url";

/**
 * These tests run with `EXPO_PUBLIC_MARKETING_SITE_URL` unset, which is the
 * state of an unconfigured fork: no legal documents exist and nothing is
 * allowlisted, so no URL can be opened in the in-app browser.
 */
describe("legal documents with no marketing site configured", () => {
  it("publishes no legal document URLs", () => {
    expect(LEGAL_URL).toBeNull();
    expect(PRIVACY_POLICY_URL).toBeNull();
    expect(TERMS_OF_SERVICE_URL).toBeNull();
    expect(SECURITY_POLICY_URL).toBeNull();
    expect(ALLOWED_LEGAL_DOCUMENT_URLS).toEqual([]);
  });

  it.each([
    "https://t3.codes/legal",
    "https://t3.codes/privacy-policy",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("allowlists nothing, including any upstream document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});

describe("resolveMarketingSiteUrl", () => {
  it("returns null for unset, blank and non-http values rather than a default", () => {
    expect(resolveMarketingSiteUrl(undefined)).toBeNull();
    expect(resolveMarketingSiteUrl("   ")).toBeNull();
    expect(resolveMarketingSiteUrl("javascript:alert(1)")).toBeNull();
    expect(resolveMarketingSiteUrl("not-a-url")).toBeNull();
  });

  it("normalizes a configured site to a trailing-slash origin path", () => {
    expect(resolveMarketingSiteUrl("https://example.test/docs?a=1#b")?.toString()).toBe(
      "https://example.test/docs/",
    );
  });
});
