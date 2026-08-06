import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]),
  },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MENU_ACTION_CHANNEL, WINDOW_FULLSCREEN_STATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";
import { PREVIEW_WEBVIEW_PREFERENCES } from "../preview/WebviewPreferences.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

function makeFakeBrowserWindow() {
  const windowListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContents = {
    copyImageAt: vi.fn(),
    getURL: vi.fn(() => "devgame-dev://app/"),
    isLoadingMainFrame: vi.fn(() => false),
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(eventName, listener);
    }),
    once: vi.fn(),
    openDevTools: vi.fn(),
    reload: vi.fn(),
    replaceMisspelling: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };

  const window = {
    close: vi.fn(),
    focus: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    loadURL: vi.fn(() => Promise.resolve()),
    maximize: vi.fn(),
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    once: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    restore: vi.fn(),
    setBackgroundColor: vi.fn(),
    setAutoHideCursor: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    show: vi.fn(),
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    getBounds: window.getBounds,
    getNormalBounds: window.getNormalBounds,
    isDestroyed: window.isDestroyed,
    isFullScreen: window.isFullScreen,
    isMaximized: window.isMaximized,
    isMinimized: window.isMinimized,
    loadURL: window.loadURL,
    maximize: window.maximize,
    openDevTools: webContents.openDevTools,
    reload: webContents.reload,
    send: webContents.send,
    setAutoHideCursor: window.setAutoHideCursor,
    webContentsListeners,
    windowListeners,
  };
}

const desktopAssetsLayer = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.none<string>(),
    icns: Option.none<string>(),
    png: Option.none<string>(),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none<string>()),
} satisfies DesktopAssets.DesktopAssets["Service"]);

const desktopServerExposureLayer = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.die("unexpected getAdvertisedEndpoints"),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const electronMenuLayer = Layer.succeed(ElectronMenu.ElectronMenu, {
  setApplicationMenu: () => Effect.void,
  popupTemplate: () => Effect.void,
  showContextMenu: () => Effect.succeed(Option.none()),
} satisfies ElectronMenu.ElectronMenu["Service"]);

const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

const desktopEnvironmentLayer = DesktopEnvironment.layer(environmentInput).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      DesktopConfig.layerTest({
        T3CODE_PORT: "3773",
        VITE_DEV_SERVER_URL: "http://127.0.0.1:5733",
      }),
    ),
  ),
);

const desktopWindowBoundsEquivalence = Schema.toEquivalence(
  DesktopAppSettings.DesktopWindowBoundsSchema,
);

function makeTestLayer(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly createdWindowOptions?: Electron.BrowserWindowConstructorOptions[];
  readonly desktopSettings?: DesktopAppSettings.DesktopSettings;
  readonly mainWindowBoundsUpdates?: DesktopAppSettings.DesktopWindowBounds[];
  readonly mainWindowMaximizedUpdates?: boolean[];
  readonly beforeMainWindowBoundsUpdate?: (
    bounds: DesktopAppSettings.DesktopWindowBounds,
  ) => Effect.Effect<void>;
  readonly openedExternalUrls?: unknown[];
  // F-4 (independent security review, follow-up to G5, 2026-08-04): this
  // used to default to a blanket `.startsWith(...)` prefix match — the
  // exact vulnerable semantics G5 removed from the real BrowserSession.ts
  // (`isPartition`, which checks SET MEMBERSHIP, never a prefix). A test
  // that registers nothing here gets NOTHING recognized as preview,
  // matching the real fail-closed default; a test exercising
  // `will-attach-webview` with a specific partition string must opt that
  // exact string in here, the same way the real code only ever recognizes
  // a partition after this process's own derivation actually produced it.
  readonly browserPartitions?: readonly string[];
}) {
  const browserPartitions = new Set(input.browserPartitions ?? []);
  let desktopSettings = input.desktopSettings ?? DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
  const desktopAppSettingsLayer = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(() => desktopSettings),
    load: Effect.sync(() => desktopSettings),
    setMainWindowBounds: (bounds, isMaximized) =>
      Effect.gen(function* () {
        if (input.beforeMainWindowBoundsUpdate) {
          yield* input.beforeMainWindowBoundsUpdate(bounds);
        }
        const changed =
          desktopSettings.mainWindowBounds === null ||
          !desktopWindowBoundsEquivalence(desktopSettings.mainWindowBounds, bounds) ||
          desktopSettings.mainWindowMaximized !== isMaximized;
        if (changed) {
          desktopSettings = {
            ...desktopSettings,
            mainWindowBounds: bounds,
            mainWindowMaximized: isMaximized,
          };
          input.mainWindowBoundsUpdates?.push(bounds);
          input.mainWindowMaximizedUpdates?.push(isMaximized);
        }
        return { settings: desktopSettings, changed };
      }),
    setServerExposureMode: () => Effect.die("unexpected server exposure update"),
    setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
    setUpdateChannel: () => Effect.die("unexpected update channel change"),
    setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
    setWslDistro: () => Effect.die("unexpected WSL distro change"),
    setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
    applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
    applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
  } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

  const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Effect.sync(() => {
        input.createdWindowOptions?.push(options);
      }).pipe(
        Effect.andThen(Ref.update(input.createCount, (count) => count + 1)),
        Effect.as(input.window),
      ),
    main: Ref.get(input.mainWindow),
    currentMainOrFirst: Ref.get(input.mainWindow),
    focusedMainOrFirst: Ref.get(input.mainWindow),
    setMain: (window) => Ref.set(input.mainWindow, Option.some(window)),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    reveal: () => Effect.void,
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: (sync) => sync(input.window),
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  return DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        desktopAssetsLayer,
        desktopEnvironmentLayer,
        desktopAppSettingsLayer,
        desktopServerExposureLayer,
        DesktopState.layer,
        electronMenuLayer,
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: (url) =>
            Effect.sync(() => {
              input.openedExternalUrls?.push(url);
              return true;
            }),
          copyText: () => Effect.void,
        } satisfies ElectronShell.ElectronShell["Service"]),
        electronThemeLayer,
        electronWindowLayer,
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () => Effect.succeed({} as Electron.Session),
          setMainWindow: () => Effect.void,
          isBrowserPartition: (partition) => browserPartitions.has(partition),
          getBrowserPartition: () => Effect.succeed("persist:devgame-preview-test"),
        }),
      ),
    ),
  );
}

// Builds a DesktopWindow over a fake ElectronWindow whose `create` returns the
// given outcomes in order (null => simulated open failure), and whose
// currentMainOrFirst mirrors the real fallback to the first live window (the
// splash, before any main is registered). Reveal targets are recorded so tests
// can assert what activation actually surfaced.
const makeSplashScenario = (createOutcomes: readonly (Electron.BrowserWindow | null)[]) =>
  Effect.gen(function* () {
    const createdWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const createCalls = yield* Ref.make(0);
    const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
    const revealedWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const fallbackWindow = createOutcomes.find(
      (window): window is Electron.BrowserWindow => window !== null,
    );

    const currentMainOrFirst = Effect.gen(function* () {
      const registered = yield* Ref.get(mainWindow);
      if (Option.isSome(registered)) {
        return registered;
      }
      const created = yield* Ref.get(createdWindows);
      return Option.fromNullishOr(created[0] ?? null);
    });

    const electronWindowShape = {
      create: () =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(createCalls, (count) => count + 1);
          const outcome = createOutcomes[index] ?? null;
          if (outcome === null) {
            return yield* new ElectronWindow.ElectronWindowCreateError({
              options: {
                title: null,
                width: null,
                height: null,
                minWidth: null,
                minHeight: null,
                show: null,
                modal: null,
                frame: null,
                transparent: null,
                backgroundColor: null,
                webPreferences: {
                  preload: null,
                  partition: null,
                  backgroundThrottling: null,
                  sandbox: null,
                  contextIsolation: null,
                  nodeIntegration: null,
                  webviewTag: null,
                },
              },
              cause: new Error("simulated window-open failure"),
            });
          }
          yield* Ref.update(createdWindows, (windows) => [...windows, outcome]);
          return outcome;
        }),
      main: Ref.get(mainWindow),
      currentMainOrFirst,
      focusedMainOrFirst: currentMainOrFirst,
      setMain: (window) => Ref.set(mainWindow, Option.some(window)),
      clearMain: () => Ref.set(mainWindow, Option.none()),
      reveal: (window) => Ref.update(revealedWindows, (windows) => [...windows, window]),
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: (sync) => (fallbackWindow ? sync(fallbackWindow) : Effect.void),
    } satisfies ElectronWindow.ElectronWindow["Service"];

    const layer = DesktopWindow.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          desktopAssetsLayer,
          desktopEnvironmentLayer,
          DesktopAppSettings.layerTest(),
          desktopServerExposureLayer,
          electronMenuLayer,
          Layer.succeed(ElectronShell.ElectronShell, {
            openExternal: () => Effect.succeed(true),
            copyText: () => Effect.void,
          } satisfies ElectronShell.ElectronShell["Service"]),
          electronThemeLayer,
          Layer.succeed(ElectronWindow.ElectronWindow, electronWindowShape),
          Layer.mock(PreviewManager.PreviewManager)({
            getBrowserSession: () => Effect.succeed({} as Electron.Session),
            setMainWindow: () => Effect.void,
            // F-4: no test reaches `will-attach-webview` through this
            // splash scenario, so nothing needs to be registered as
            // recognized — matches the real fail-closed default (see
            // makeTestLayer above, which IS exercised against it).
            isBrowserPartition: () => false,
            getBrowserPartition: () => Effect.succeed("persist:devgame-preview-test"),
          }),
        ),
      ),
    );

    return { layer, createCalls, mainWindow, revealedWindows } as const;
  });

describe("DesktopWindow", () => {
  it("restores bounds only when the window fits within a connected display", () => {
    const persistedBounds = { x: 2040, y: 80, width: 1320, height: 880 };
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];

    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, displays),
      persistedBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, [displays[0]!]),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });

  it("recognizes only same-origin renderer navigations", () => {
    assert.isTrue(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "devgame://app/",
        navigationUrl: "devgame://app/settings/connections",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "devgame://app/",
        navigationUrl: "https://accounts.microsoft.com/oauth",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "devgame://app/",
        navigationUrl: "not a url",
      }),
    );
  });

  it.effect("does not open a development window until the backend is ready", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.activate;
        assert.equal(yield* Ref.get(createCount), 0);

        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(createdWindowOptions[0]?.width, 1100);
        assert.equal(createdWindowOptions[0]?.height, 780);
        assert.isUndefined(createdWindowOptions[0]?.x);
        assert.isUndefined(createdWindowOptions[0]?.y);
        assert.isTrue(createdWindowOptions[0]?.disableAutoHideCursor);
        assert.isFalse(createdWindowOptions[0]?.webPreferences?.backgroundThrottling);
        assert.deepEqual(fakeWindow.setAutoHideCursor.mock.calls, [[false]]);
        assert.deepEqual(fakeWindow.loadURL.mock.calls[0], ["devgame-dev://app/"]);
        assert.equal(fakeWindow.openDevTools.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("blocks only repeated Cmd+W input before it reaches the native window menu", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const beforeInput = fakeWindow.webContentsListeners.get("before-input-event");
        if (!beforeInput) {
          return yield* Effect.die("before-input-event listener was not registered");
        }

        let prevented = false;
        const event = { preventDefault: () => (prevented = true) };
        const input = {
          type: "keyDown",
          isAutoRepeat: true,
          key: "W",
          meta: true,
          control: false,
          alt: false,
          shift: false,
        };
        beforeInput(event, input);
        assert.isTrue(prevented);

        prevented = false;
        beforeInput(event, { ...input, isAutoRepeat: false });
        assert.isFalse(prevented);

        prevented = false;
        beforeInput(event, { ...input, meta: false });
        assert.isFalse(prevented);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("uses the persisted main window bounds when opening the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 120, y: 80, width: 1320, height: 880 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(createdWindowOptions[0]?.width, 1320);
        assert.equal(createdWindowOptions[0]?.height, 880);
        assert.equal(createdWindowOptions[0]?.x, 120);
        assert.equal(createdWindowOptions[0]?.y, 80);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("restores the persisted maximized state", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 120, y: 80, width: 1320, height: 880 },
          mainWindowMaximized: true,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(fakeWindow.maximize.mock.calls.length, 0);
        const readyToShow = fakeWindow.windowListeners.get("ready-to-show");
        if (!readyToShow) {
          return yield* Effect.die("window ready-to-show listener was not registered");
        }
        readyToShow();
        assert.equal(fakeWindow.maximize.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("debounces move and resize bounds updates", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const move = fakeWindow.windowListeners.get("move");
        const resize = fakeWindow.windowListeners.get("resize");
        if (!move || !resize) {
          return yield* Effect.die("window bounds listeners were not registered");
        }

        fakeWindow.getBounds.mockReturnValue({ x: 120, y: 80, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(250);

        fakeWindow.getBounds.mockReturnValue({ x: 160, y: 100, width: 1360, height: 900 });
        resize();
        yield* TestClock.adjust(499);
        assert.deepEqual(mainWindowBoundsUpdates, []);

        yield* TestClock.adjust(1);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 160, y: 100, width: 1360, height: 900 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists normal bounds and state for a maximized window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.isMaximized.mockReturnValue(true);
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 220, y: 140, width: 1380, height: 920 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 220, y: 140, width: 1380, height: 920 }]);
        assert.deepEqual(mainWindowMaximizedUpdates, [true]);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists normal bounds and state from the native maximize event", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const maximize = fakeWindow.windowListeners.get("maximize");
        if (!maximize) {
          return yield* Effect.die("window maximize listener was not registered");
        }

        fakeWindow.isMaximized.mockReturnValue(true);
        fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
        fakeWindow.getNormalBounds.mockReturnValue({ x: 220, y: 140, width: 1380, height: 920 });
        maximize();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 220, y: 140, width: 1380, height: 920 }]);
        assert.deepEqual(mainWindowMaximizedUpdates, [true]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not persist bounds that fail the domain schema", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 100.4, y: 80.2, width: 839.4, height: 619.4 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("preserves unrestorable bounds until the user changes the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 2040, y: 80, width: 1320, height: 880 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        const move = fakeWindow.windowListeners.get("move");
        if (!close || !move) {
          return yield* Effect.die("window lifecycle listeners were not registered");
        }

        close();
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, []);

        fakeWindow.getBounds.mockReturnValue({ x: 80, y: 60, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 80, y: 60, width: 1280, height: 840 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when fullscreen before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 200, y: 130, width: 1400, height: 940 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isFullScreen.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 200, y: 130, width: 1400, height: 940 }]);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when minimized before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: -32_000, y: -32_000, width: 160, height: 28 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 180, y: 120, width: 1440, height: 960 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isMinimized.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 180, y: 120, width: 1440, height: 960 }]);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("logs display lookup failures before falling back to the default size", () =>
    Effect.gen(function* () {
      const displayLookupFailure = new Error("screen API unavailable");
      vi.mocked(Electron.screen.getAllDisplays).mockImplementationOnce(() => {
        throw displayLookupFailure;
      });
      const logRecords: Array<{
        readonly message: unknown;
        readonly annotations: Readonly<Record<string, unknown>>;
      }> = [];
      const logger = Logger.make(({ fiber, message }) => {
        logRecords.push({
          message,
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        });
      });
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false }))),
      );

      const warning = logRecords.find(
        (record) =>
          Array.isArray(record.message) &&
          record.message[0] === "failed to read connected displays; using defaults",
      );
      assert.isDefined(warning);
      assert.strictEqual(warning.annotations.cause, displayLookupFailure);
      assert.equal(createdWindowOptions[0]?.width, 1100);
      assert.equal(createdWindowOptions[0]?.height, 780);
      assert.isUndefined(createdWindowOptions[0]?.x);
      assert.isUndefined(createdWindowOptions[0]?.y);
    }),
  );

  it.effect("persists the current main window bounds before the window closes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 240, y: 160, width: 1410, height: 930 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const writeStarted = yield* Deferred.make<void>();
      const allowWrite = yield* Deferred.make<void>();
      const flushCompleted = yield* Deferred.make<void>();
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        beforeMainWindowBoundsUpdate: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowWrite)),
            Effect.asVoid,
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Deferred.await(writeStarted);
        fakeWindow.isDestroyed.mockReturnValue(true);

        const flushFiber = yield* desktopWindow.flushMainWindowBounds.pipe(
          Effect.andThen(Deferred.succeed(flushCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(flushCompleted));

        yield* Deferred.succeed(allowWrite, undefined);
        yield* Fiber.join(flushFiber);
        assert.isTrue(yield* Deferred.isDone(flushCompleted));

        assert.deepEqual(mainWindowBoundsUpdates, [
          {
            x: 240,
            y: 160,
            width: 1410,
            height: 930,
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("publishes native macOS fullscreen changes to the renderer", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const enterFullscreen = fakeWindow.windowListeners.get("enter-full-screen");
        const leaveFullscreen = fakeWindow.windowListeners.get("leave-full-screen");
        if (!enterFullscreen || !leaveFullscreen) {
          return yield* Effect.die("fullscreen listeners were not registered");
        }

        enterFullscreen();
        leaveFullscreen();
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [WINDOW_FULLSCREEN_STATE_CHANNEL, true],
          [WINDOW_FULLSCREEN_STATE_CHANNEL, false],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("recovers when the development renderer is temporarily unreachable", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const didFailLoad = fakeWindow.webContentsListeners.get("did-fail-load");
        const didFinishLoad = fakeWindow.webContentsListeners.get("did-finish-load");
        if (!didFailLoad || !didFinishLoad) {
          return yield* Effect.die("renderer load listeners were not registered");
        }

        didFailLoad({}, -9, "ERR_UNEXPECTED", "devgame-dev://app/", true);
        assert.equal(fakeWindow.loadURL.mock.calls.length, 1);

        yield* TestClock.adjust(100);
        assert.deepEqual(fakeWindow.loadURL.mock.calls, [
          ["devgame-dev://app/"],
          ["devgame-dev://app/"],
        ]);
        assert.equal(fakeWindow.reload.mock.calls.length, 0);

        didFailLoad({}, -9, "ERR_UNEXPECTED", "devgame-dev://app/", true);
        didFinishLoad();
        yield* TestClock.adjust(250);
        assert.equal(fakeWindow.loadURL.mock.calls.length, 2);
        assert.equal(fakeWindow.reload.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it("retries only transient failures for the development renderer", () => {
    assert.isTrue(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "devgame-dev://app/",
        errorCode: -102,
        isMainFrame: true,
        validatedUrl: "devgame-dev://app/",
      }),
    );
    assert.isFalse(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "devgame-dev://app/",
        errorCode: -3,
        isMainFrame: true,
        validatedUrl: "devgame-dev://app/",
      }),
    );
    assert.isFalse(
      DesktopWindow.isRetryableDevelopmentRendererLoadFailure({
        applicationUrl: "devgame-dev://app/",
        errorCode: -102,
        isMainFrame: true,
        validatedUrl: "https://example.com/",
      }),
    );
  });

  it.effect("opens safe off-origin renderer navigations in the system browser", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willNavigate = fakeWindow.webContentsListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("will-navigate listener was not registered");
        }
        let prevented = false;
        willNavigate(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "https://accounts.microsoft.com/oauth",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(openedExternalUrls, ["https://accounts.microsoft.com/oauth"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  // #88 (2026-08-04): restores G3/#80's `did-attach-webview` guest-
  // navigation guard (same-origin allow, cross-origin deny-and-deflect,
  // `will-navigate`/`will-redirect`, a minimal guest context menu) —
  // recovered from `git show 630eeb5e9` (the last tree state before
  // `f82da4876` deleted this mechanism, and the citation this file's own
  // now-removed comment already had right) — but applied UNCONDITIONALLY,
  // not scoped by session identity: preview is the only
  // guest type left, and the old "preview's guest loads the user's own,
  // fully-trusted dev server" carve-out doesn't hold for a running game
  // build that pulls npm packages, CDN scripts, and remote asset hosts.
  // See `DesktopWindow.ts`'s own comment at the guard for the full
  // rationale. No `session`/`FAKE_THIRD_PARTY_SESSION` field on the guest
  // fixtures below (unlike the original tests this is adapted from) —
  // there is nothing left to check identity against.
  it.effect("wires a guest will-navigate guard: same-origin allowed", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const didAttachWebview = fakeWindow.webContentsListeners.get("did-attach-webview");
        if (!didAttachWebview) {
          return yield* Effect.die("did-attach-webview listener was not registered");
        }
        const guestListeners = new Map<string, (...args: Array<unknown>) => void>();
        const guestWebContents = {
          getURL: () => "http://127.0.0.1:5733/game",
          on: (eventName: string, listener: (...args: Array<unknown>) => void) => {
            guestListeners.set(eventName, listener);
          },
        };
        didAttachWebview({}, guestWebContents);

        const willNavigate = guestListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("guest will-navigate listener was not registered");
        }
        let prevented = false;
        willNavigate(
          { preventDefault: () => (prevented = true) },
          "http://127.0.0.1:5733/game/level-2",
        );

        assert.isFalse(prevented);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("wires a guest will-navigate guard: cross-origin denied and deflected externally", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const didAttachWebview = fakeWindow.webContentsListeners.get("did-attach-webview");
        if (!didAttachWebview) {
          return yield* Effect.die("did-attach-webview listener was not registered");
        }
        const guestListeners = new Map<string, (...args: Array<unknown>) => void>();
        const guestWebContents = {
          // F-3: the deflect rate limiter is keyed by webContents id. An
          // explicit, unique id here keeps this test's budget separate
          // from every other test in this file that also exercises a
          // deflect — sharing `undefined` would make tests order-dependent.
          id: 9101,
          getURL: () => "http://127.0.0.1:5733/game",
          on: (eventName: string, listener: (...args: Array<unknown>) => void) => {
            guestListeners.set(eventName, listener);
          },
        };
        didAttachWebview({}, guestWebContents);

        const willNavigate = guestListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("guest will-navigate listener was not registered");
        }
        let prevented = false;
        // A CDN/asset host the game embeds an iframe from, hostile or
        // compromised — the exact class #88 describes.
        willNavigate(
          { preventDefault: () => (prevented = true) },
          "https://attacker.example.com/phish",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(openedExternalUrls, ["https://attacker.example.com/phish"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  // H2: `will-navigate` only fires for a navigation's INITIAL request — a
  // same-origin request that then 302-redirects cross-origin fires
  // `will-redirect` instead. Same policy, same rate limit, new event.
  it.effect("wires a guest will-redirect guard: same-origin redirect allowed", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const didAttachWebview = fakeWindow.webContentsListeners.get("did-attach-webview");
        if (!didAttachWebview) {
          return yield* Effect.die("did-attach-webview listener was not registered");
        }
        const guestListeners = new Map<string, (...args: Array<unknown>) => void>();
        const guestWebContents = {
          id: 9102,
          getURL: () => "http://127.0.0.1:5733/game",
          on: (eventName: string, listener: (...args: Array<unknown>) => void) => {
            guestListeners.set(eventName, listener);
          },
        };
        didAttachWebview({}, guestWebContents);

        const willRedirect = guestListeners.get("will-redirect");
        if (!willRedirect) {
          return yield* Effect.die("guest will-redirect listener was not registered");
        }
        let prevented = false;
        willRedirect(
          { preventDefault: () => (prevented = true) },
          "http://127.0.0.1:5733/game?redirected=1",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isFalse(prevented);
        assert.deepEqual(openedExternalUrls, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "wires a guest will-redirect guard: cross-origin redirect denied and deflected externally",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const openedExternalUrls: unknown[] = [];
        const layer = makeTestLayer({
          window: fakeWindow.window,
          createCount,
          mainWindow,
          openedExternalUrls,
        });

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

          const didAttachWebview = fakeWindow.webContentsListeners.get("did-attach-webview");
          if (!didAttachWebview) {
            return yield* Effect.die("did-attach-webview listener was not registered");
          }
          const guestListeners = new Map<string, (...args: Array<unknown>) => void>();
          const guestWebContents = {
            id: 9103,
            getURL: () => "http://127.0.0.1:5733/game",
            on: (eventName: string, listener: (...args: Array<unknown>) => void) => {
              guestListeners.set(eventName, listener);
            },
          };
          didAttachWebview({}, guestWebContents);

          const willRedirect = guestListeners.get("will-redirect");
          if (!willRedirect) {
            return yield* Effect.die("guest will-redirect listener was not registered");
          }
          let prevented = false;
          // H1's own composing precondition: a same-origin request that
          // 302s cross-origin — this is the effect, not the handler's
          // return value.
          willRedirect(
            { preventDefault: () => (prevented = true) },
            "https://attacker.example.com/evil",
          );
          yield* Effect.promise(() => Promise.resolve());

          assert.isTrue(prevented);
          assert.deepEqual(openedExternalUrls, ["https://attacker.example.com/evil"]);
        }).pipe(Effect.provide(layer));
      }),
  );

  // F-3: the deflect path is rate limited so a hostile page can't spawn
  // unbounded real browser tabs by looping a redirect/navigation.
  it.effect("rate-limits repeated cross-origin will-redirect deflects from the same guest", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const didAttachWebview = fakeWindow.webContentsListeners.get("did-attach-webview");
        if (!didAttachWebview) {
          return yield* Effect.die("did-attach-webview listener was not registered");
        }
        const guestListeners = new Map<string, (...args: Array<unknown>) => void>();
        const guestWebContents = {
          id: 9104,
          getURL: () => "http://127.0.0.1:5733/game",
          on: (eventName: string, listener: (...args: Array<unknown>) => void) => {
            guestListeners.set(eventName, listener);
          },
        };
        didAttachWebview({}, guestWebContents);

        const willRedirect = guestListeners.get("will-redirect");
        if (!willRedirect) {
          return yield* Effect.die("guest will-redirect listener was not registered");
        }
        for (let i = 0; i < 3; i++) {
          willRedirect({ preventDefault: () => {} }, `https://attacker.example.com/evil?n=${i}`);
        }
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(openedExternalUrls, ["https://attacker.example.com/evil?n=0"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("wires a guest context-menu guard (#80)", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const didAttachWebview = fakeWindow.webContentsListeners.get("did-attach-webview");
        if (!didAttachWebview) {
          return yield* Effect.die("did-attach-webview listener was not registered");
        }
        const guestListeners = new Map<string, (...args: Array<unknown>) => void>();
        const guestWebContents = {
          getURL: () => "http://127.0.0.1:5733/game",
          on: (eventName: string, listener: (...args: Array<unknown>) => void) => {
            guestListeners.set(eventName, listener);
          },
        };
        didAttachWebview({}, guestWebContents);

        const contextMenu = guestListeners.get("context-menu");
        if (!contextMenu) {
          return yield* Effect.die("guest context-menu listener was not registered");
        }
        let prevented = false;
        contextMenu(
          { preventDefault: () => (prevented = true) },
          {
            editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true },
          },
        );

        // Denying default + popping a template is the same observable shape
        // the main window's own context-menu test would use; `electronMenu
        // .popupTemplate` here is a no-op mock (see `electronMenuLayer`), so
        // the reachable assertion is that a menu was even attempted —
        // proven by `preventDefault` firing, which only happens once this
        // handler exists at all.
        assert.isTrue(prevented);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("allows a preview-partition webview to attach with contextIsolation=false", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        browserPartitions: ["persist:devgame-preview-abc"],
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willAttachWebview = fakeWindow.webContentsListeners.get("will-attach-webview");
        if (!willAttachWebview) {
          return yield* Effect.die("will-attach-webview listener was not registered");
        }
        let prevented = false;
        const webPreferences: Record<string, unknown> = {
          partition: "persist:devgame-preview-abc",
        };
        willAttachWebview({ preventDefault: () => (prevented = true) }, webPreferences, {
          partition: "persist:devgame-preview-abc",
          webpreferences: PREVIEW_WEBVIEW_PREFERENCES,
        });

        assert.isFalse(prevented);
        assert.deepEqual(webPreferences, {
          partition: "persist:devgame-preview-abc",
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          contextIsolation: false,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  // F2 (independent security review, 2026-08-04), VERIFIED BY EXECUTION:
  // the vulnerability wasn't that fresh `webPreferences` lacked safe
  // defaults — it's that a renderer-supplied `<webview>` ATTRIBUTE
  // (`disablewebsecurity`) reaches this handler already set on the object
  // Electron hands in, and nothing overrode it. This test starts from
  // exactly that attacker-controlled shape and proves the handler forces
  // it back, not just that an empty object ends up correct.
  it.effect("overrides a malicious renderer-supplied webPreferences on the preview partition", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        browserPartitions: ["persist:devgame-preview-abc"],
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willAttachWebview = fakeWindow.webContentsListeners.get("will-attach-webview");
        if (!willAttachWebview) {
          return yield* Effect.die("will-attach-webview listener was not registered");
        }
        let prevented = false;
        // Simulates what `<webview disablewebsecurity>` hands Electron
        // BEFORE this handler runs.
        const webPreferences: Record<string, unknown> = {
          partition: "persist:devgame-preview-abc",
          sandbox: false,
          nodeIntegration: true,
          nodeIntegrationInSubFrames: true,
          webSecurity: false,
          allowRunningInsecureContent: true,
          contextIsolation: true,
        };
        willAttachWebview({ preventDefault: () => (prevented = true) }, webPreferences, {
          partition: "persist:devgame-preview-abc",
          webpreferences: PREVIEW_WEBVIEW_PREFERENCES,
        });

        assert.isFalse(prevented);
        assert.deepEqual(webPreferences, {
          partition: "persist:devgame-preview-abc",
          sandbox: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          contextIsolation: false,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("blocks a webview attach whose partition doesn't match the preview allowlist", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willAttachWebview = fakeWindow.webContentsListeners.get("will-attach-webview");
        if (!willAttachWebview) {
          return yield* Effect.die("will-attach-webview listener was not registered");
        }
        let prevented = false;
        const webPreferences: Record<string, unknown> = {
          partition: "persist:some-unrelated-partition",
        };
        willAttachWebview({ preventDefault: () => (prevented = true) }, webPreferences, {
          partition: "persist:some-unrelated-partition",
          webpreferences: PREVIEW_WEBVIEW_PREFERENCES,
        });

        assert.isTrue(prevented);
        assert.deepEqual(webPreferences, { partition: "persist:some-unrelated-partition" });
      }).pipe(Effect.provide(layer));
    }),
  );

  // G1 (independent security review, follow-up to F2/F3, 2026-08-04),
  // SHIP BLOCKER — PROVEN BY EXECUTION against real Electron via the
  // reviewer's probe (case C, re-run after this fix and confirmed
  // denied): this handler used to classify from `params.partition` — the
  // bare `partition="..."` ATTRIBUTE — while Electron actually builds the
  // guest from `webPreferences.partition`. The `webpreferences="..."`
  // attribute is parsed with NO key allowlist and applied LAST, silently
  // overriding `partition` (and `preload`) on the object Electron
  // actually uses. `<webview partition="persist:devgame-preview-X"
  // webpreferences="partition=persist:devgame-preview-INJECTED,preload=/e
  // vil.js">` used to be ALLOWED as preview (so `contextIsolation` was
  // forced false with the attacker's preload left in place), while
  // Electron attached a session this process never derived, with a
  // renderer-supplied preload running at `contextIsolation:false` — full
  // `ipcRenderer` access. This reproduces the reviewer's case C verbatim
  // (values taken directly from their probe) and proves it denied
  // outright, not merely reclassified.
  it.effect(
    "denies a webview whose webpreferences attribute smuggles a different partition AND preload (G1 full chain)",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

          const willAttachWebview = fakeWindow.webContentsListeners.get("will-attach-webview");
          if (!willAttachWebview) {
            return yield* Effect.die("will-attach-webview listener was not registered");
          }
          let prevented = false;
          // What Electron hands the handler by the time it runs: the
          // `webpreferences=` attribute has ALREADY overridden `partition`
          // and set `preload` on this object — this is the field Electron
          // actually builds the guest session from.
          const webPreferences: Record<string, unknown> = {
            partition: "persist:devgame-preview-injected0123456789ab",
            preload: "/Users/attacker/evil.js",
          };
          willAttachWebview({ preventDefault: () => (prevented = true) }, webPreferences, {
            partition: "persist:devgame-preview-aaaaaaaaaaaaaaaaaaaa",
            webpreferences:
              "partition=persist:devgame-preview-injected0123456789ab,preload=/Users/attacker/evil.js",
          });

          assert.isTrue(prevented);
          // Denied means untouched — no security-flag pinning even ran,
          // and critically `preload` was never stripped, proving this
          // path never reaches the "classified as preview, leave it alone"
          // branch that made the exploit work.
          assert.deepEqual(webPreferences, {
            partition: "persist:devgame-preview-injected0123456789ab",
            preload: "/Users/attacker/evil.js",
          });
        }).pipe(Effect.provide(layer));
      }),
  );

  // G1, the partition-confusion half alone (no preload) — the reviewer's
  // case B. Denied for the same reason as the full chain above, but
  // proven independently: even without a malicious preload, letting this
  // through would attach a session this process never derived under
  // preview's own posture, a real downgrade in its own right.
  it.effect(
    "denies a webview whose webpreferences attribute smuggles a different partition alone",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

          const willAttachWebview = fakeWindow.webContentsListeners.get("will-attach-webview");
          if (!willAttachWebview) {
            return yield* Effect.die("will-attach-webview listener was not registered");
          }
          let prevented = false;
          const webPreferences: Record<string, unknown> = {
            partition: "persist:devgame-preview-injected0123456789ab",
          };
          willAttachWebview({ preventDefault: () => (prevented = true) }, webPreferences, {
            partition: "persist:devgame-preview-aaaaaaaaaaaaaaaaaaaa",
            webpreferences: "partition=persist:devgame-preview-injected0123456789ab",
          });

          assert.isTrue(prevented);
        }).pipe(Effect.provide(layer));
      }),
  );

  // G6 (independent security review, executed): the forced-flag list was a
  // denylist by omission — anything NOT in that list of six keys reached
  // Electron unfiltered. Reproduces the reviewer's case E: `webviewTag=true`
  // (nested webviews attach via the GUEST's own will-attach-webview, where
  // this handler isn't registered — no allowlist at all on that path) and
  // `experimentalFeatures=true` both came through before this fix.
  // Requiring `params.webpreferences` to be byte-identical to one of the
  // two known-good constants closes this: neither constant contains ANY
  // of these keys, so any attempt to add one is, by construction, already
  // a deviation from the constant and gets denied before it matters which
  // specific key it was.
  it.effect(
    "denies a webview whose webpreferences attribute carries keys outside the known-good constants",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

          const willAttachWebview = fakeWindow.webContentsListeners.get("will-attach-webview");
          if (!willAttachWebview) {
            return yield* Effect.die("will-attach-webview listener was not registered");
          }
          let prevented = false;
          const webPreferences: Record<string, unknown> = {
            partition: "persist:devgame-preview-injected0123456789ab",
            webviewTag: true,
            experimentalFeatures: true,
          };
          willAttachWebview({ preventDefault: () => (prevented = true) }, webPreferences, {
            partition: "persist:devgame-preview-injected0123456789ab",
            webpreferences:
              "webviewTag=true,nodeIntegrationInWorker=true,experimentalFeatures=true,enableWebSQL=true,javascript=true,images=false,plugins=true",
          });

          assert.isTrue(prevented);
        }).pipe(Effect.provide(layer));
      }),
  );

  // Belt-and-braces check, tested directly: even granting that a valid
  // `webpreferences` string can no longer move `webPreferences.partition`
  // away from `params.partition` (the check above should already make
  // that unreachable), decide identity from `webPreferences.partition`
  // and fail closed if the two ever disagree anyway — don't depend on the
  // other check being airtight forever. Seeded directly (not derived from
  // a webpreferences string), matching the F2 test's own pattern of
  // constructing the hostile shape rather than only the route that
  // produces it today.
  it.effect(
    "denies a webview when webPreferences.partition disagrees with params.partition, independent of webpreferences",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

          const willAttachWebview = fakeWindow.webContentsListeners.get("will-attach-webview");
          if (!willAttachWebview) {
            return yield* Effect.die("will-attach-webview listener was not registered");
          }
          let prevented = false;
          const webPreferences: Record<string, unknown> = {
            partition: "persist:devgame-preview-injected0123456789ab",
          };
          willAttachWebview({ preventDefault: () => (prevented = true) }, webPreferences, {
            partition: "persist:devgame-preview-aaaaaaaaaaaaaaaaaaaa",
            webpreferences: PREVIEW_WEBVIEW_PREFERENCES,
          });

          assert.isTrue(prevented);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("blocks a webview attach with a missing or non-string partition", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = makeTestLayer({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willAttachWebview = fakeWindow.webContentsListeners.get("will-attach-webview");
        if (!willAttachWebview) {
          return yield* Effect.die("will-attach-webview listener was not registered");
        }
        let prevented = false;
        willAttachWebview({ preventDefault: () => (prevented = true) }, {}, {});

        assert.isTrue(prevented);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "retries opening the real main on activate when a failed post-readiness open left only the splash",
    () =>
      Effect.gen(function* () {
        const splash = makeFakeBrowserWindow();
        const main = makeFakeBrowserWindow();
        // create #1 -> splash, #2 -> fails (the pool swallows this post-readiness
        // window-open error), #3 -> the real main on activate's retry.
        const scenario = yield* makeSplashScenario([splash.window, null, main.window]);

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;

          // 1. WSL-only boot shows the connecting splash.
          yield* desktopWindow.showConnectingSplash;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);

          // 2. Backend reports ready, but opening the real main fails. The pool
          //    swallows that error in production, so handleBackendReady fails
          //    here without a registered main window -- only the splash is open.
          const readyExit = yield* Effect.exit(
            desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773")),
          );
          assert.equal(readyExit._tag, "Failure");
          assert.equal(yield* Ref.get(scenario.createCalls), 2);
          assert.isTrue(Option.isNone(yield* Ref.get(scenario.mainWindow)));

          // 3. Activating must not mistake the splash for the main window: it
          //    retries the open and brings up the real main instead of leaving
          //    the user stranded on "Connecting to WSL".
          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(scenario.createCalls), 3);
          const registeredMain = yield* Ref.get(scenario.mainWindow);
          assert.isTrue(Option.isSome(registeredMain));
          assert.equal(Option.getOrThrow(registeredMain), main.window);
        }).pipe(Effect.provide(scenario.layer));
      }),
  );

  it.effect(
    "re-reveals the connecting splash on activate while the backend is still cold-booting",
    () =>
      Effect.gen(function* () {
        const splash = makeFakeBrowserWindow();
        // Only the splash is ever created; the backend never reports ready.
        const scenario = yield* makeSplashScenario([splash.window]);

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;

          yield* desktopWindow.showConnectingSplash;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);

          // Taskbar/dock activation during cold boot must bring the splash back
          // rather than no-op and leave it hidden until the backend finishes.
          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);
          assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [splash.window]);
        }).pipe(Effect.provide(scenario.layer));
      }),
  );

  it.effect("does not dispatch menu actions to the splash before the backend is ready", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;

        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.dispatchMenuAction("open-settings");

        assert.equal(yield* Ref.get(scenario.createCalls), 1);
        assert.equal(splash.send.mock.calls.length, 0);
        assert.equal(main.send.mock.calls.length, 0);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("dispatches menu actions after backend readiness when no main window exists", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window, null, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;

        yield* desktopWindow.showConnectingSplash;
        const readyExit = yield* Effect.exit(
          desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773")),
        );
        assert.equal(readyExit._tag, "Failure");

        yield* desktopWindow.dispatchMenuAction("open-settings");

        assert.equal(yield* Ref.get(scenario.createCalls), 3);
        assert.deepEqual(main.send.mock.calls, [[MENU_ACTION_CHANNEL, "open-settings"]]);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );
});
