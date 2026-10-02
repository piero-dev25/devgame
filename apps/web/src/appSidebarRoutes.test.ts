import { describe, expect, it } from "vite-plus/test";

import { routeUsesAppSidebarLayout } from "./appSidebarRoutes";

describe("routeUsesAppSidebarLayout", () => {
  it.each(["/settings", "/settings/general", "/settings/providers", "/usage", "/pull-requests"])(
    "hosts %s in AppSidebarLayout, since it has no dock",
    (pathname) => {
      expect(routeUsesAppSidebarLayout(pathname)).toBe(true);
    },
  );

  it.each(["/", "/draft/draft-1", "/env-1/thread-1", "/settingsx", "/usage/extra", "/pair"])(
    "leaves %s to the dock or its own shell",
    (pathname) => {
      expect(routeUsesAppSidebarLayout(pathname)).toBe(false);
    },
  );
});
