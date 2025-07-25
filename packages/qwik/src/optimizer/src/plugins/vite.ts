import type { UserConfig, ViteDevServer, Plugin as VitePlugin } from 'vite';
import { QWIK_LOADER_DEFAULT_DEBUG, QWIK_LOADER_DEFAULT_MINIFIED } from '../scripts';
import type {
  EntryStrategy,
  GlobalInjections,
  Optimizer,
  OptimizerOptions,
  OptimizerSystem,
  QwikManifest,
  TransformModule,
} from '../types';
import { type BundleGraphAdder } from './bundle-graph';
import { getImageSizeServer } from './image-size-server';
import {
  CLIENT_OUT_DIR,
  QWIK_BUILD_ID,
  QWIK_CLIENT_MANIFEST_ID,
  QWIK_CORE_ID,
  QWIK_CORE_SERVER,
  QWIK_JSX_DEV_RUNTIME_ID,
  QWIK_JSX_RUNTIME_ID,
  SSR_OUT_DIR,
  TRANSFORM_REGEX,
  createQwikPlugin,
  type ExperimentalFeatures,
  type NormalizedQwikPluginOptions,
  type QwikBuildMode,
  type QwikBuildTarget,
  type QwikPackages,
  type QwikPluginOptions,
} from './plugin';
import { createRollupError, normalizeRollupOutputOptions } from './rollup';
import { VITE_DEV_CLIENT_QS, configureDevServer, configurePreviewServer } from './vite-dev-server';
import { parseId } from './vite-utils';

const DEDUPE = [QWIK_CORE_ID, QWIK_JSX_RUNTIME_ID, QWIK_JSX_DEV_RUNTIME_ID];

const STYLING = ['.css', '.scss', '.sass', '.less', '.styl', '.stylus'];
const FONTS = ['.woff', '.woff2', '.ttf'];

/**
 * Workaround to make the api be defined in the type.
 *
 * @internal
 */
type P<T> = VitePlugin<T> & { api: T; config: Extract<VitePlugin<T>['config'], Function> };

/**
 * The types for Vite/Rollup don't allow us to be too specific about the return type. The correct
 * return type is `[QwikVitePlugin, VitePlugin<never>]`, and if you search the plugin by name you'll
 * get the `QwikVitePlugin`.
 *
 * @public
 */
export function qwikVite(qwikViteOpts: QwikVitePluginOptions = {}): any {
  let isClientDevOnly = false;
  let clientDevInput: undefined | string = undefined;
  let tmpClientManifestPath: undefined | string = undefined;
  let viteCommand: 'build' | 'serve' = 'serve';
  let manifestInput: QwikManifest | null = null;
  let clientOutDir: string | null = null;
  let basePathname: string = '/';
  let clientPublicOutDir: string | null = null;
  let viteAssetsDir: string | undefined;
  let srcDir: string | null = null;
  let rootDir: string | null = null;

  let ssrOutDir: string | null = null;
  const fileFilter: QwikVitePluginOptions['fileFilter'] = qwikViteOpts.fileFilter
    ? (id, type) => TRANSFORM_REGEX.test(id) || qwikViteOpts.fileFilter!(id, type)
    : () => true;
  const disableFontPreload = qwikViteOpts.disableFontPreload ?? false;
  const injections: GlobalInjections[] = [];
  const qwikPlugin = createQwikPlugin(qwikViteOpts.optimizerOptions);

  const bundleGraphAdders = new Set<BundleGraphAdder>();

  const api: QwikVitePluginApi = {
    getOptimizer: () => qwikPlugin.getOptimizer(),
    getOptions: () => qwikPlugin.getOptions(),
    getManifest: () => manifestInput,
    getRootDir: () => qwikPlugin.getOptions().rootDir,
    getClientOutDir: () => clientOutDir,
    getClientPublicOutDir: () => clientPublicOutDir,
    getAssetsDir: () => viteAssetsDir,
    registerBundleGraphAdder: (adder: BundleGraphAdder) => bundleGraphAdders.add(adder),
  };

  // We provide two plugins to Vite. The first plugin is the main plugin that handles all the
  // Vite hooks. The second plugin is a post plugin that is called after the build has finished.
  // The post plugin is used to generate the Qwik manifest file that is used during SSR to
  // generate QRLs for event handlers.
  const vitePluginPre: P<QwikVitePluginApi> = {
    name: 'vite-plugin-qwik',
    enforce: 'pre',
    api,

    async config(viteConfig, viteEnv) {
      await qwikPlugin.init();

      const sys = qwikPlugin.getSys();
      const path = qwikPlugin.getPath();

      let target: QwikBuildTarget;
      if (viteConfig.build?.ssr || viteEnv.mode === 'ssr') {
        target = 'ssr';
      } else if (viteEnv.mode === 'lib') {
        target = 'lib';
      } else if (viteEnv.mode === 'test') {
        target = 'test';
      } else {
        target = 'client';
      }

      let buildMode: QwikBuildMode;
      if (viteEnv.mode === 'production') {
        buildMode = 'production';
      } else if (viteEnv.mode === 'development') {
        buildMode = 'development';
      } else if (viteCommand === 'build' && target === 'client') {
        // build (production)
        buildMode = 'production';
      } else {
        // serve (development)
        buildMode = 'development';
      }

      viteCommand = viteEnv.command;
      isClientDevOnly = viteCommand === 'serve' && viteEnv.mode !== 'ssr';

      qwikPlugin.debug(`vite config(), command: ${viteCommand}, env.mode: ${viteEnv.mode}`);

      if (viteCommand === 'serve') {
        qwikViteOpts.entryStrategy = { type: 'segment' };
      } else {
        if (target === 'ssr') {
          qwikViteOpts.entryStrategy = { type: 'hoist' };
        } else if (target === 'lib') {
          qwikViteOpts.entryStrategy = { type: 'inline' };
        }
      }

      const shouldFindVendors =
        !qwikViteOpts.disableVendorScan && (target !== 'lib' || viteCommand === 'serve');
      viteAssetsDir = viteConfig.build?.assetsDir;
      const useAssetsDir = target === 'client' && !!viteAssetsDir && viteAssetsDir !== '_astro';
      const pluginOpts: QwikPluginOptions = {
        target,
        buildMode,
        csr: qwikViteOpts.csr,
        debug: qwikViteOpts.debug,
        entryStrategy: qwikViteOpts.entryStrategy,
        srcDir: qwikViteOpts.srcDir,
        rootDir: viteConfig.root,
        tsconfigFileNames: qwikViteOpts.tsconfigFileNames,
        resolveQwikBuild: true,
        transformedModuleOutput: qwikViteOpts.transformedModuleOutput,
        outDir: viteConfig.build?.outDir,
        assetsDir: useAssetsDir ? viteAssetsDir : undefined,
        devTools: qwikViteOpts.devTools,
        sourcemap: !!viteConfig.build?.sourcemap,
        lint: qwikViteOpts.lint,
        experimental: qwikViteOpts.experimental,
      };
      if (!qwikViteOpts.csr) {
        if (target === 'ssr') {
          // ssr
          if (typeof viteConfig.build?.ssr === 'string') {
            // from --ssr flag user config
            // entry.server.ts (express/cloudflare/netlify)
            pluginOpts.input = viteConfig.build.ssr;
          } else if (typeof qwikViteOpts.ssr?.input === 'string') {
            // entry.ssr.tsx input (exports render())
            pluginOpts.input = qwikViteOpts.ssr.input;
          }

          if (qwikViteOpts.ssr?.outDir) {
            pluginOpts.outDir = qwikViteOpts.ssr.outDir;
          }
          pluginOpts.manifestInput = qwikViteOpts.ssr?.manifestInput;
        } else if (target === 'client') {
          // client
          pluginOpts.input = qwikViteOpts.client?.input;
          if (qwikViteOpts.client?.outDir) {
            pluginOpts.outDir = qwikViteOpts.client.outDir;
          }
          pluginOpts.manifestOutput = qwikViteOpts.client?.manifestOutput;
        } else {
          if (typeof viteConfig.build?.lib === 'object') {
            pluginOpts.input = viteConfig.build?.lib.entry;
          }
        }
        if (sys.env === 'node' || sys.env === 'bun') {
          const fs: typeof import('fs') = await sys.dynamicImport('node:fs');

          try {
            const rootDir = pluginOpts.rootDir ?? sys.cwd();
            const packageJsonPath = sys.path.join(rootDir, 'package.json');
            const pkgString = await fs.promises.readFile(packageJsonPath, 'utf-8');

            try {
              const data = JSON.parse(pkgString);

              if (typeof data.name === 'string') {
                pluginOpts.scope = data.name;
              }
            } catch (e) {
              console.error(e);
            }
          } catch {
            // error reading package.json from Node.js fs, ok to ignore
          }

          // In a Node.js environment, create a path to a q-manifest.json file within the
          // OS tmp directory. This path should always be the same for both client and ssr.
          // Client build will write to this path, and SSR will read from it. For this reason,
          // the Client build should always start and finish before the SSR build.
          const nodeOs: typeof import('os') = await sys.dynamicImport('node:os');

          // Additionally, we add a suffix to scope the file to the current application so that
          // different applications can be run in parallel without generating conflicts.
          const scopeSuffix = pluginOpts.scope ? `-${pluginOpts.scope.replace(/\//g, '--')}` : '';

          tmpClientManifestPath = path.join(
            nodeOs.tmpdir(),
            `vite-plugin-qwik-q-manifest${scopeSuffix}.json`
          );

          if (target === 'ssr' && !pluginOpts.manifestInput) {
            // This is a SSR build so we should load the client build's manifest
            // so it can be used as the manifestInput of the SSR build
            try {
              const clientManifestStr = await fs.promises.readFile(tmpClientManifestPath, 'utf-8');
              pluginOpts.manifestInput = JSON.parse(clientManifestStr);
            } catch {
              // ignore
            }
          }
        }
      }

      const opts = qwikPlugin.normalizeOptions(pluginOpts);
      manifestInput = pluginOpts.manifestInput || null;
      srcDir = opts.srcDir;
      rootDir = opts.rootDir;

      if (!qwikViteOpts.csr) {
        clientOutDir = qwikPlugin.normalizePath(
          sys.path.resolve(opts.rootDir, qwikViteOpts.client?.outDir || CLIENT_OUT_DIR)
        );

        clientPublicOutDir = viteConfig.base
          ? path.join(clientOutDir, viteConfig.base)
          : clientOutDir;

        ssrOutDir = qwikPlugin.normalizePath(
          sys.path.resolve(opts.rootDir, qwikViteOpts.ssr?.outDir || SSR_OUT_DIR)
        );

        if (typeof qwikViteOpts.client?.devInput === 'string') {
          clientDevInput = path.resolve(opts.rootDir, qwikViteOpts.client.devInput);
        } else {
          if (opts.srcDir) {
            clientDevInput = path.resolve(opts.srcDir, CLIENT_DEV_INPUT);
          } else {
            clientDevInput = path.resolve(opts.rootDir, 'src', CLIENT_DEV_INPUT);
          }
        }
        clientDevInput = qwikPlugin.normalizePath(clientDevInput);
      }

      const vendorRoots = shouldFindVendors ? await findQwikRoots(sys, sys.cwd()) : [];
      const vendorIds = vendorRoots.map((v) => v.id);
      const isDevelopment = buildMode === 'development';
      const qDevKey = 'globalThis.qDev';
      const qTestKey = 'globalThis.qTest';
      const qInspectorKey = 'globalThis.qInspector';
      const qSerializeKey = 'globalThis.qSerialize';
      const qDev = viteConfig?.define?.[qDevKey] ?? isDevelopment;
      const qInspector = viteConfig?.define?.[qInspectorKey] ?? isDevelopment;
      const qSerialize = viteConfig?.define?.[qSerializeKey] ?? isDevelopment;

      const updatedViteConfig: UserConfig = {
        ssr: {
          noExternal: [QWIK_CORE_ID, QWIK_CORE_SERVER, QWIK_BUILD_ID, ...vendorIds],
        },
        envPrefix: ['VITE_', 'PUBLIC_'],
        resolve: {
          dedupe: [...DEDUPE, ...vendorIds],
          conditions: buildMode === 'production' && target === 'client' ? ['min'] : [],
        },
        esbuild:
          viteCommand === 'serve'
            ? false
            : {
                logLevel: 'error',
                jsx: 'automatic',
              },
        optimizeDeps: {
          exclude: [
            '@vite/client',
            '@vite/env',
            'node-fetch',
            'undici',
            QWIK_CORE_ID,
            QWIK_CORE_SERVER,
            QWIK_JSX_RUNTIME_ID,
            QWIK_JSX_DEV_RUNTIME_ID,
            QWIK_BUILD_ID,
            QWIK_CLIENT_MANIFEST_ID,
            ...vendorIds,
          ],
        },
        build: {
          modulePreload: false,
          dynamicImportVarsOptions: {
            exclude: [/./],
          },
          rollupOptions: {
            /**
             * This is a workaround to have predictable chunk hashes between builds. It doesn't seem
             * to impact the build time.
             * https://github.com/QwikDev/qwik/issues/7226#issuecomment-2647122505
             */
            maxParallelFileOps: 1,
            output: {
              manualChunks: qwikPlugin.manualChunks,
            },
          },
        },
        define: {
          [qDevKey]: qDev,
          [qInspectorKey]: qInspector,
          [qSerializeKey]: qSerialize,
          [qTestKey]: JSON.stringify(process.env.NODE_ENV === 'test'),
        },
      };

      if (!qwikViteOpts.csr) {
        const buildOutputDir =
          target === 'client' && viteConfig.base
            ? path.join(opts.outDir, viteConfig.base)
            : opts.outDir;

        updatedViteConfig.build!.cssCodeSplit = false;
        updatedViteConfig.build!.outDir = buildOutputDir;
        const origOnwarn = updatedViteConfig.build!.rollupOptions?.onwarn;
        updatedViteConfig.build!.rollupOptions = {
          input: opts.input,
          output: normalizeRollupOutputOptions(
            qwikPlugin,
            viteConfig.build?.rollupOptions?.output,
            useAssetsDir,
            buildOutputDir
          ),
          preserveEntrySignatures: 'exports-only',
          onwarn: (warning, warn) => {
            if (warning.plugin === 'typescript' && warning.message.includes('outputToFilesystem')) {
              return;
            }
            origOnwarn ? origOnwarn(warning, warn) : warn(warning);
          },
        };

        if (opts.target === 'ssr') {
          // SSR Build
          if (viteCommand === 'build') {
            updatedViteConfig.publicDir = false;
            updatedViteConfig.build!.ssr = true;
            if (viteConfig.build?.minify == null && buildMode === 'production') {
              updatedViteConfig.build!.minify = 'esbuild';
            }
          }
        } else if (opts.target === 'client') {
          // Client Build
          if (isClientDevOnly && !opts.csr) {
            updatedViteConfig.build!.rollupOptions!.input = clientDevInput;
          }
        } else if (opts.target === 'lib') {
          // Library Build
          updatedViteConfig.build!.minify = false;
          updatedViteConfig.build!.rollupOptions.external = [
            QWIK_CORE_ID,
            QWIK_CORE_SERVER,
            QWIK_JSX_RUNTIME_ID,
            QWIK_JSX_DEV_RUNTIME_ID,
            QWIK_BUILD_ID,
            QWIK_CLIENT_MANIFEST_ID,
          ];
        } else {
          // Test Build
          updatedViteConfig.define = {
            [qDevKey]: true,
            [qTestKey]: true,
            [qInspectorKey]: false,
          };
        }

        (globalThis as any).qDev = qDev;
        (globalThis as any).qTest = true;
        (globalThis as any).qInspector = qInspector;
      }

      return updatedViteConfig;
    },

    async configResolved(config) {
      basePathname = config.base;
      if (!(basePathname.startsWith('/') && basePathname.endsWith('/'))) {
        // TODO v2: make this an error
        console.error(
          `warning: vite's config.base must begin and end with /. This will be an error in v2. If you have a valid use case, please open an issue.`
        );
        if (!basePathname.endsWith('/')) {
          basePathname += '/';
        }
      }
      const useSourcemap = !!config.build.sourcemap;
      if (useSourcemap && qwikViteOpts.optimizerOptions?.sourcemap === undefined) {
        qwikPlugin.setSourceMapSupport(true);
      }
      // Ensure that the final settings are applied
      qwikPlugin.normalizeOptions(qwikViteOpts);
    },

    async buildStart() {
      // Using vite.resolveId to check file if exist
      // for example input might be virtual file
      const resolver = this.resolve.bind(this);
      await qwikPlugin.validateSource(resolver);

      qwikPlugin.onDiagnostics((diagnostics, optimizer, srcDir) => {
        diagnostics.forEach((d) => {
          const id = qwikPlugin.normalizePath(optimizer.sys.path.join(srcDir, d.file));
          if (d.category === 'error') {
            this.error(createRollupError(id, d));
          } else {
            this.warn(createRollupError(id, d));
          }
        });
      });

      await qwikPlugin.buildStart(this);
    },

    resolveId(id, importer, resolveIdOpts) {
      if (id.startsWith('\0') || !fileFilter(id, 'resolveId')) {
        return null;
      }
      if (isClientDevOnly && id === VITE_CLIENT_MODULE) {
        return id;
      }
      return qwikPlugin.resolveId(this, id, importer, resolveIdOpts);
    },

    load(id, loadOpts) {
      if (id.startsWith('\0') || !fileFilter(id, 'load')) {
        return null;
      }

      id = qwikPlugin.normalizePath(id);
      const opts = qwikPlugin.getOptions();

      if (isClientDevOnly && id === VITE_CLIENT_MODULE) {
        return getViteDevModule(opts);
      }
      if (viteCommand === 'serve' && id.endsWith(QWIK_CLIENT_MANIFEST_ID)) {
        return {
          code: 'export const manifest = undefined;',
        };
      }
      return qwikPlugin.load(this, id, loadOpts);
    },

    transform(code, id, transformOpts) {
      if (id.startsWith('\0') || !fileFilter(id, 'transform') || id.includes('?raw')) {
        return null;
      }

      if (isClientDevOnly) {
        const parsedId = parseId(id);
        if (parsedId.params.has(VITE_DEV_CLIENT_QS)) {
          code = updateEntryDev(code);
        }
      }
      return qwikPlugin.transform(this, code, id, transformOpts);
    },
  } as const satisfies VitePlugin<QwikVitePluginApi>;

  const vitePluginPost: VitePlugin<never> = {
    name: 'vite-plugin-qwik-post',
    enforce: 'post',

    generateBundle: {
      order: 'post',
      async handler(_, rollupBundle) {
        const opts = qwikPlugin.getOptions();

        if (opts.target === 'client') {
          // client build

          for (const [fileName, b] of Object.entries(rollupBundle)) {
            if (b.type === 'asset') {
              const baseFilename = basePathname + fileName;
              if (STYLING.some((ext) => fileName.endsWith(ext))) {
                if (typeof b.source === 'string' && b.source.length < opts.inlineStylesUpToBytes) {
                  injections.push({
                    tag: 'style',
                    location: 'head',
                    attributes: {
                      'data-src': baseFilename,
                      dangerouslySetInnerHTML: b.source,
                    },
                  });
                } else {
                  injections.push({
                    tag: 'link',
                    location: 'head',
                    attributes: {
                      rel: 'stylesheet',
                      href: baseFilename,
                    },
                  });
                }
              } else {
                const selectedFont = FONTS.find((ext) => fileName.endsWith(ext));
                if (selectedFont && !disableFontPreload) {
                  injections.unshift({
                    tag: 'link',
                    location: 'head',
                    attributes: {
                      rel: 'preload',
                      href: baseFilename,
                      as: 'font',
                      type: `font/${selectedFont.slice(1)}`,
                      crossorigin: '',
                    },
                  });
                }
              }
            }
          }

          const clientManifestStr = await qwikPlugin.generateManifest(
            this,
            rollupBundle,
            bundleGraphAdders,
            {
              injections,
              platform: { vite: '' },
            }
          );

          const sys = qwikPlugin.getSys();
          if (tmpClientManifestPath && (sys.env === 'node' || sys.env === 'bun')) {
            // Client build should write the manifest to a tmp dir
            const fs: typeof import('fs') = await sys.dynamicImport('node:fs');
            await fs.promises.writeFile(tmpClientManifestPath, clientManifestStr);
          }
        }
      },
    },

    async writeBundle(_, rollupBundle) {
      const opts = qwikPlugin.getOptions();
      if (opts.target === 'ssr') {
        // ssr build

        const sys = qwikPlugin.getSys();
        if (sys.env === 'node' || sys.env === 'bun') {
          const outputs = Object.keys(rollupBundle);

          // In order to simplify executing the server script with a common script
          // always ensure there's a plain .js file.
          // For example, if only a .mjs was generated, also
          // create the .js file that just calls the .mjs file
          const patchModuleFormat = async (bundeName: string) => {
            try {
              const bundleFileName = sys.path.basename(bundeName);
              const ext = sys.path.extname(bundleFileName);
              const isEntryFile =
                bundleFileName.startsWith('entry.') || bundleFileName.startsWith('entry_');
              if (
                isEntryFile &&
                !bundleFileName.includes('preview') &&
                (ext === '.mjs' || ext === '.cjs')
              ) {
                const extlessName = sys.path.basename(bundleFileName, ext);
                const js = `${extlessName}.js`;
                const moduleName = extlessName + ext;

                const hasJsScript = outputs.some((f) => sys.path.basename(f) === js);
                if (!hasJsScript) {
                  // didn't generate a .js script
                  // create a .js file that just import()s their script
                  const bundleOutDir = sys.path.dirname(bundeName);
                  const fs: typeof import('fs') = await sys.dynamicImport('node:fs');

                  const folder = sys.path.join(opts.outDir, bundleOutDir);
                  await fs.promises.mkdir(folder, { recursive: true });
                  await fs.promises.writeFile(
                    sys.path.join(folder, js),
                    `export * from "./${moduleName}";`
                  );
                }
              }
            } catch (e) {
              console.error('patchModuleFormat', e);
            }
          };

          await Promise.all(outputs.map(patchModuleFormat));
        }
      }
    },

    configureServer(server: ViteDevServer) {
      qwikPlugin.configureServer(server);
      const devSsrServer = 'devSsrServer' in qwikViteOpts ? !!qwikViteOpts.devSsrServer : true;
      const imageDevTools =
        qwikViteOpts.devTools && 'imageDevTools' in qwikViteOpts.devTools
          ? qwikViteOpts.devTools.imageDevTools
          : true;

      if (imageDevTools) {
        server.middlewares.use(getImageSizeServer(qwikPlugin.getSys(), rootDir!, srcDir!));
      }

      if (!qwikViteOpts.csr) {
        const plugin = async () => {
          const opts = qwikPlugin.getOptions();
          const sys = qwikPlugin.getSys();
          const path = qwikPlugin.getPath();
          await configureDevServer(
            basePathname,
            server,
            opts,
            sys,
            path,
            isClientDevOnly,
            clientDevInput,
            devSsrServer
          );
        };
        const isNEW = (globalThis as any).__qwikCityNew === true;
        if (isNEW) {
          return plugin;
        } else {
          return plugin();
        }
      }
    },

    configurePreviewServer(server) {
      return async () => {
        const sys = qwikPlugin.getSys();
        const path = qwikPlugin.getPath();
        await configurePreviewServer(server.middlewares, ssrOutDir!, sys, path);
      };
    },

    handleHotUpdate(ctx) {
      qwikPlugin.handleHotUpdate(ctx);

      // Tell the client to reload the page if any modules were used in ssr or client
      // this needs to be refined
      if (ctx.modules.length) {
        ctx.server.hot.send({
          type: 'full-reload',
        });
      }
    },

    onLog(level, log) {
      if (log.plugin == ('vite-plugin-qwik' satisfies QwikVitePlugin['name'])) {
        const color = LOG_COLOR[level] || ANSI_COLOR.White;
        const frames = (log.frame || '')
          .split('\n')
          .map(
            (line) =>
              (line.match(/^\s*\^\s*$/) ? ANSI_COLOR.BrightWhite : ANSI_COLOR.BrightBlack) + line
          );
        // eslint-disable-next-line no-console
        console[level](
          `${color}%s\n${ANSI_COLOR.BrightWhite}%s\n%s${ANSI_COLOR.RESET}`,
          `[${log.plugin}](${level}): ${log.message}\n`,
          `  ${log?.loc?.file}:${log?.loc?.line}:${log?.loc?.column}\n`,
          `  ${frames.join('\n  ')}\n`
        );
        return false;
      }
    },
  } as const satisfies VitePlugin<QwikVitePluginApi>;

  return [vitePluginPre, vitePluginPost];
}

const ANSI_COLOR = {
  Black: '\x1b[30m',
  Red: '\x1b[31m',
  Green: '\x1b[32m',
  Yellow: '\x1b[33m',
  Blue: '\x1b[34m',
  Magenta: '\x1b[35m',
  Cyan: '\x1b[36m',
  White: '\x1b[37m',
  BrightBlack: '\x1b[90m',
  BrightRed: '\x1b[91m',
  BrightGreen: '\x1b[92m',
  BrightYellow: '\x1b[93m',
  BrightBlue: '\x1b[94m',
  BrightMagenta: '\x1b[95m',
  BrightCyan: '\x1b[96m',
  BrightWhite: '\x1b[97m',
  RESET: '\x1b[0m',
};

const LOG_COLOR = {
  warn: ANSI_COLOR.Yellow,
  info: ANSI_COLOR.Cyan,
  debug: ANSI_COLOR.BrightBlack,
};

function updateEntryDev(code: string) {
  code = code.replace(/["']@builder.io\/qwik["']/g, `'${VITE_CLIENT_MODULE}'`);
  return code;
}

function getViteDevModule(opts: NormalizedQwikPluginOptions) {
  const qwikLoader = JSON.stringify(
    opts.debug ? QWIK_LOADER_DEFAULT_DEBUG : QWIK_LOADER_DEFAULT_MINIFIED
  );

  return `// Qwik Vite Dev Module
import { render as qwikRender } from '@builder.io/qwik';

export async function render(document, rootNode, opts) {

  await qwikRender(document, rootNode, opts);

  let qwikLoader = document.getElementById('qwikloader');
  if (!qwikLoader) {
    qwikLoader = document.createElement('script');
    qwikLoader.id = 'qwikloader';
    qwikLoader.innerHTML = ${qwikLoader};
    const parent = document.head ?? document.body ?? document.documentElement;
    parent.appendChild(qwikLoader);
  }

  if (!window.__qwikViteLog) {
    window.__qwikViteLog = true;
    console.debug("%c⭐️ Qwik Client Mode","background: #0c75d2; color: white; padding: 2px 3px; border-radius: 2px; font-size: 0.8em;","Do not use this mode in production!\\n - No portion of the application is pre-rendered on the server\\n - All of the application is running eagerly in the browser\\n - Optimizer/Serialization/Deserialization code is not exercised!");
  }
}`;
}

async function findDepPkgJsonPath(sys: OptimizerSystem, dep: string, parent: string) {
  const fs: typeof import('fs') = await sys.dynamicImport('node:fs');
  let root = parent;
  while (root) {
    const pkg = sys.path.join(root, 'node_modules', dep, 'package.json');
    try {
      await fs.promises.access(pkg);
      // use 'node:fs' version to match 'vite:resolve' and avoid realpath.native quirk
      // https://github.com/sveltejs/vite-plugin-svelte/issues/525#issuecomment-1355551264
      return fs.promises.realpath(pkg);
    } catch {
      //empty
    }
    const nextRoot = sys.path.dirname(root);
    if (nextRoot === root) {
      break;
    }
    root = nextRoot;
  }
  return undefined;
}

const findQwikRoots = async (
  sys: OptimizerSystem,
  packageJsonDir: string
): Promise<QwikPackages[]> => {
  const paths = new Map<string, string>();
  if (sys.env === 'node' || sys.env === 'bun') {
    const fs: typeof import('fs') = await sys.dynamicImport('node:fs');
    let prevPackageJsonDir: string | undefined;
    do {
      try {
        const data = await fs.promises.readFile(sys.path.join(packageJsonDir, 'package.json'), {
          encoding: 'utf-8',
        });

        try {
          const packageJson = JSON.parse(data);
          const dependencies = packageJson['dependencies'];
          const devDependencies = packageJson['devDependencies'];

          const packages: string[] = [];
          if (typeof dependencies === 'object') {
            packages.push(...Object.keys(dependencies));
          }
          if (typeof devDependencies === 'object') {
            packages.push(...Object.keys(devDependencies));
          }

          const basedir = sys.cwd();
          await Promise.all(
            packages.map(async (id) => {
              const pkgJsonPath = await findDepPkgJsonPath(sys, id, basedir);
              if (pkgJsonPath) {
                const pkgJsonContent = await fs.promises.readFile(pkgJsonPath, 'utf-8');
                const pkgJson = JSON.parse(pkgJsonContent);
                const qwikPath = pkgJson['qwik'];
                if (!qwikPath) {
                  return;
                }
                // Support multiple paths
                const allPaths = Array.isArray(qwikPath) ? qwikPath : [qwikPath];
                for (const p of allPaths) {
                  paths.set(
                    await fs.promises.realpath(sys.path.resolve(sys.path.dirname(pkgJsonPath), p)),
                    id
                  );
                }
              }
            })
          );
        } catch (e) {
          console.error(e);
        }
      } catch {
        // ignore errors if package.json not found
      }
      prevPackageJsonDir = packageJsonDir;
      packageJsonDir = sys.path.dirname(packageJsonDir);
    } while (packageJsonDir !== prevPackageJsonDir);
  }
  return Array.from(paths).map(([path, id]) => ({ path, id }));
};

export const isNotNullable = <T>(v: T): v is NonNullable<T> => {
  return v != null;
};

const VITE_CLIENT_MODULE = `@builder.io/qwik/vite-client`;
const CLIENT_DEV_INPUT = 'entry.dev';

interface QwikVitePluginCommonOptions {
  /**
   * Prints verbose Qwik plugin debug logs.
   *
   * Default `false`
   */
  debug?: boolean;
  /**
   * The Qwik entry strategy to use while building for production. During development the type is
   * always `segment`.
   *
   * Default `{ type: "smart" }`)
   */
  entryStrategy?: EntryStrategy;
  /**
   * The source directory to find all the Qwik components. Since Qwik does not have a single input,
   * the `srcDir` is used to recursively find Qwik files.
   *
   * Default `src`
   */
  srcDir?: string;
  /**
   * List of tsconfig.json files to use for ESLint warnings during development.
   *
   * Default `['tsconfig.json']`
   */
  tsconfigFileNames?: string[];
  /**
   * List of directories to recursively search for Qwik components or Vendors.
   *
   * Default `[]`
   *
   * @deprecated No longer used. Instead, any imported file with `.qwik.` in the name is processed.
   */
  vendorRoots?: string[];
  /**
   * Disables the automatic vendor roots scan. This is useful when you want to manually specify the
   * vendor roots.
   */
  disableVendorScan?: boolean;
  /**
   * Options for the Qwik optimizer.
   *
   * Default `undefined`
   */
  optimizerOptions?: OptimizerOptions;
  /**
   * Hook that's called after the build and provides all of the transformed modules that were used
   * before bundling.
   */
  transformedModuleOutput?:
    | ((transformedModules: TransformModule[]) => Promise<void> | void)
    | null;
  devTools?: {
    /**
     * Validates image sizes for CLS issues during development. In case of issues, provides you with
     * a correct image size resolutions. If set to `false`, image dev tool will be disabled.
     *
     * Default `true`
     */
    imageDevTools?: boolean | true;
    /**
     * Press-hold the defined keys to enable qwik dev inspector. By default the behavior is
     * activated by pressing the left or right `Alt` key. If set to `false`, qwik dev inspector will
     * be disabled.
     *
     * Valid values are `KeyboardEvent.code` values. Please note that the 'Left' and 'Right'
     * suffixes are ignored.
     */
    clickToSource?: string[] | false;
  };
  /**
   * Predicate function to filter out files from the optimizer. hook for resolveId, load, and
   * transform
   */
  fileFilter?: (id: string, hook: string) => boolean;
  /**
   * Run eslint on the source files for the ssr build or dev server. This can slow down startup on
   * large projects. Defaults to `true`
   */
  lint?: boolean;
  /**
   * Experimental features. These can come and go in patch releases, and their API is not guaranteed
   * to be stable between releases
   */
  experimental?: (keyof typeof ExperimentalFeatures)[];

  /**
   * Disables automatic preloading of font assets (WOFF/WOFF2/TTF) found in the build output. When
   * enabled, the plugin will not add `<link rel="preload">` tags for font files in the document
   * head.
   *
   * Disabling may impact Cumulative Layout Shift (CLS) metrics.
   */
  disableFontPreload?: boolean;
}

interface QwikVitePluginCSROptions extends QwikVitePluginCommonOptions {
  /** Client Side Rendering (CSR) mode. It will not support SSR, default to Vite's `index.html` file. */
  csr: true;
  client?: never;
  devSsrServer?: never;
  ssr?: never;
}

interface QwikVitePluginSSROptions extends QwikVitePluginCommonOptions {
  /** Client Side Rendering (CSR) mode. It will not support SSR, default to Vite's `index.html` file. */
  csr?: false | undefined;
  client?: {
    /**
     * The entry point for the client builds. This would be the application's root component
     * typically.
     *
     * Default `src/components/app/app.tsx`
     */
    input?: string[] | string;
    /**
     * Entry input for client-side only development with hot-module reloading. This is for Vite
     * development only and does not use SSR.
     *
     * Default `src/entry.dev.tsx`
     */
    devInput?: string;
    /**
     * Output directory for the client build.
     *
     * Default `dist`
     */
    outDir?: string;
    /**
     * The client build will create a manifest and this hook is called with the generated build
     * data.
     *
     * Default `undefined`
     */
    manifestOutput?: (manifest: QwikManifest) => Promise<void> | void;
  };

  /**
   * Qwik is SSR first framework. This means that Qwik requires either SSR or SSG. In dev mode the
   * dev SSR server is responsible for rendering and pausing the application on the server.
   *
   * Under normal circumstances this should be on, unless you have your own SSR server which you
   * would like to use instead and wish to disable this one.
   *
   * Default: true
   */
  devSsrServer?: boolean;

  /** Controls the SSR behavior. */
  ssr?: {
    /**
     * The entry point for the SSR renderer. This file should export a `render()` function. This
     * entry point and `render()` export function is also used for Vite's SSR development and
     * Node.js debug mode.
     *
     * Default `src/entry.ssr.tsx`
     */
    input?: string;
    /**
     * Output directory for the server build.
     *
     * Default `server`
     */
    outDir?: string;
    /**
     * The SSR build requires the manifest generated during the client build. By default, this
     * plugin will wire the client manifest to the ssr build. However, the `manifestInput` option
     * can be used to manually provide a manifest.
     *
     * Default `undefined`
     */
    manifestInput?: QwikManifest;
  };
}

interface QwikVitePluginCSROptions extends QwikVitePluginCommonOptions {
  /** Client Side Rendering (CSR) mode. It will not support SSR, default to Vite's `index.html` file. */
  csr: true;
}

/** @public */
export type QwikVitePluginOptions = QwikVitePluginCSROptions | QwikVitePluginSSROptions;
export { ExperimentalFeatures } from './plugin';

/** @public */
export interface QwikVitePluginApi {
  getOptimizer: () => Optimizer | null;
  getOptions: () => NormalizedQwikPluginOptions;
  getManifest: () => QwikManifest | null;
  getRootDir: () => string | null;
  getClientOutDir: () => string | null;
  getClientPublicOutDir: () => string | null;
  getAssetsDir: () => string | undefined;
  registerBundleGraphAdder: (adder: BundleGraphAdder) => void;
}

/**
 * This is the type of the "pre" Qwik Vite plugin. `qwikVite` actually returns a tuple of two
 * plugins, but after Vite flattens them, you can find the plugin by name.
 *
 * @public
 */
export type QwikVitePlugin = P<QwikVitePluginApi> & {
  name: 'vite-plugin-qwik';
};

/** @public */
export interface QwikViteDevResponse {
  _qwikEnvData?: Record<string, any>;
  _qwikRenderResolve?: () => void;
}
