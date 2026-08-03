/**
 * The in-app legal screens name whoever publishes them as the user's
 * counterparty, so there is no default site. A build that does not configure
 * `EXPO_PUBLIC_MARKETING_SITE_URL` shows no legal documents at all rather than
 * presenting another company's terms as ours.
 */
export function resolveMarketingSiteUrl(override: string | undefined): URL | null {
  const configured = override?.trim();
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }

    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url;
  } catch {
    return null;
  }
}

const MARKETING_SITE_URL = resolveMarketingSiteUrl(process.env.EXPO_PUBLIC_MARKETING_SITE_URL);

function marketingSiteDocumentUrl(path: string): string | null {
  return MARKETING_SITE_URL === null ? null : new URL(path, MARKETING_SITE_URL).toString();
}

export const PRIVACY_POLICY_URL = marketingSiteDocumentUrl("privacy-policy");
export const SECURITY_POLICY_URL = marketingSiteDocumentUrl("security-policy");
export const TERMS_OF_SERVICE_URL = marketingSiteDocumentUrl("terms-of-service");
export const LEGAL_URL = marketingSiteDocumentUrl("legal");

export const ALLOWED_LEGAL_DOCUMENT_URLS = [
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
  SECURITY_POLICY_URL,
].filter((value): value is string => value !== null);

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const ALLOWED_LEGAL_DOCUMENT_IDENTITIES = new Set(
  ALLOWED_LEGAL_DOCUMENT_URLS.map(webDocumentIdentity).filter(
    (value): value is string => value !== null,
  ),
);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && ALLOWED_LEGAL_DOCUMENT_IDENTITIES.has(identity);
}
