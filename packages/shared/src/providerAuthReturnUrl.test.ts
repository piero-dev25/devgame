import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["devgame", "devgame-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "devgame://attacker/welcome",
    "devgame://app:123/welcome",
    "devgame://app/auth/callback",
    "devgame://user@ app/welcome",
    "devgame://app/welcome/../evil",
    "https://attacker.example/welcome",
    // Upstream T3 Code's desktop schemes and hosted origin belong to another
    // app; a fork-trusted return there would hand the user to it.
    "t3code://app/welcome",
    "t3code-dev://app/settings/providers",
    "https://app.t3.codes/welcome",
    "file:///welcome",
    "javascript:alert(1)",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
