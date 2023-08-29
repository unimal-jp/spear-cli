import path from "path"
import { parse } from "node-html-parser"
import liveServer from "live-server"
import watch from "node-watch"
import { Args } from "./interfaces/ArgsInterfaces"
import { Component, Element, State } from "./interfaces/MagicInterfaces"
import { DefaultSettings } from "./interfaces/SettingsInterfaces"
import { fileURLToPath } from "url"
import { SpearlyJSGenerator } from '@spearly/cms-js-core'
import chalk from 'chalk'
import { defaultSettingDeepCopy, stateDeepCopy } from "./utils/util.js"
import { FileUtil } from "./utils/file.js"
import { LocalFileManipulator } from "./file/LocalFileManipulator.js"
import { generateAliasPagesFromPagesList, parseElements } from "./utils/dom.js"
import { SpearLog } from "./utils/log.js"

const libFilename = fileURLToPath(import.meta.url)
const libDirname = path.dirname(libFilename)
const logger = new SpearLog(false)
const fileUtil = new FileUtil(new LocalFileManipulator(), logger)

let dirname = process.cwd()
let Settings: DefaultSettings
let jsGenerator: SpearlyJSGenerator

function initializeArgument(args: Args) {
  if (args.src) {
    dirname = path.resolve(args.src)
  }
  Settings = {
    projectName: "Spear CLI",
    settingsFile: "spear.config",
    pagesFolder: `${dirname}/src/pages`,
    componentsFolder: [ `${dirname}/src/components` ],
    srcDir: [ `${dirname}/src` ],
    distDir: `${dirname}/dist`,
    entry: `${dirname}/src/pages/index.?(spear|html)`,
    template: `${dirname}/public/index.html`,
    spearlyAuthKey: "",
    port: 8080,
    host: "0.0.0.0",
    crossOriginIsolation: false,
    apiDomain: "api.spearly.com",
    analysysDomain: "analytics.spearly.com",
    generateSitemap: false,
    siteURL: "",
    rootDir: dirname,
    plugins: [],
    quiteMode: false,
  }
}

async function bundle(): Promise<boolean> {
  let state: State = {
    pagesList: [],
    componentsList: [],
    body: parse("") as Element,
    globalProps: {},
    out: {
      assetsFiles: [],
    },
  }

  jsGenerator = new SpearlyJSGenerator(Settings.spearlyAuthKey, Settings.apiDomain, Settings.analysysDomain)

  // Hook API: beforeBuild
  for (const plugin of Settings.plugins) {
    if (plugin.beforeBuild) {
      try {
        const newState = await plugin.beforeBuild(state, { fileUtil, logger })
        if (newState) {
          state = stateDeepCopy(newState)
        }
      } catch (e) {
        // TODO. This error should have a plugin information.
        // For more information, see the https://github.com/unimal-jp/spear/issues/111
        console.warn(` plugin process failed. [${plugin.pluginName}]`)
      }
    }
  }

  // Create dist folder
  fileUtil.createDir(Settings)

  // First parse components from the /components folder
  try {
    for (const componentsFolder of Settings.componentsFolder) {
      await fileUtil.parseComponents(state, componentsFolder, Settings)
    }
  } catch(e) {
    logger.error(e);
    return false;
  }

  try {
    for (const srcDir of Settings.srcDir) {
      await fileUtil.parsePages(state, srcDir)
    }
  } catch(e) {
    logger.error(e);
    return false;
  }

  // Run list again to parse children of the components
  // Due to support nested components.
  const componentsList = [] as Component[]
  for (const component of state.componentsList) {
    const parsedNode = await parseElements(state, component.node.childNodes as Element[], jsGenerator, Settings) as Element[]
    componentsList.push({
      "fname": component.fname,
      "rawData": parsedNode[0].outerHTML,
      "tagName": component.tagName,
      "node": parsedNode[0],
      "props": {}
    })
  }
  state.componentsList = componentsList

  // Run list again to parse children of the pages
  for (const page of state.pagesList) {
    page.node.childNodes = await parseElements(state, page.node.childNodes as Element[], jsGenerator, Settings)
    // We need to parseElement twice due to embed nested component.
    page.node.childNodes = await parseElements(state, page.node.childNodes as Element[], jsGenerator, Settings)
  }

  // generate static routing files.
  state.pagesList = await generateAliasPagesFromPagesList(state, jsGenerator, Settings)

  // Hook API: afterBuild
  for (const plugin of Settings.plugins) {
    if (plugin.afterBuild) {
      try {
        const newState = await plugin.afterBuild(state, { fileUtil, logger })
        if (newState) {
          state = stateDeepCopy(newState)
        }
      } catch (e) {
        // TODO. This error should have a plugin information.
        // For more information, see the https://github.com/unimal-jp/spear/issues/111
        console.warn(` plugin process failed. [${plugin.pluginName}]`)
      }
    }
  }

  // Dump pages
  fileUtil.dumpPages(state, libDirname, Settings)

  // Hook API: bundle
  for (const plugin of Settings.plugins) {
    if (plugin.bundle) {
      try {
        const newState = await plugin.bundle(state, { fileUtil, logger })
        if (newState) {
          state = stateDeepCopy(newState)
        }
      } catch (e) {
        // TODO. This error should have a plugin information.
        // For more information, see the https://github.com/unimal-jp/spear/issues/111
        console.warn(` plugin process failed. ${plugin.pluginName}}`)
      }
    }
  }

  return true
}

async function loadSettingsFromFile() {
  const data = await fileUtil.loadFile(`${dirname}/${Settings.settingsFile}.?(mjs|js|json)`)
  if (data) {
    Object.keys(data).forEach((k) => {
      Settings[k] = data[k]
    })
  }
}

async function loadSettings() {
    // Load default settings from spear.config.{js,json}|package.json
  await loadSettingsFromFile()
  logger.isQuite = Settings.quiteMode

  // If directory has the same name, it will be removed.
  Settings.srcDir = Settings.srcDir.filter((srcDir) => {
    return !Settings.srcDir.some((srcDir2) => {
      if (srcDir !== srcDir2 && !srcDir2.endsWith("components")) return false
      return srcDir !== srcDir2 && srcDir.startsWith(srcDir2)
    })
  })

  // Hook API after settings
  for (const plugin of Settings.plugins) {
    if (plugin.configuration) {
      try {
        const newSettings = await plugin.configuration(Settings, { fileUtil, logger })
        if (newSettings) {
          Settings = defaultSettingDeepCopy(newSettings)
        }
      } catch (e) {
        // TODO. This error should have a plugin information.
        // For more information, see the https://github.com/unimal-jp/spear/issues/111
        console.warn(` plugin process failed. ${plugin.pluginName}}}`)
      }
    }
  }
}

export default async function magic(args: Args): Promise<boolean> {
  initializeArgument(args)

  if (args.action === "watch") {
    Settings.distDir = path.resolve(dirname, "node_modules", "spear-cli", "tmpBuild")
  }

  await loadSettings()

  if (args.action === "watch") {
    if (args.port) {
      Settings.port = args.port
    }
    // Bundle before starting the server
    await bundle()

    watch("./",
      {
        recursive: true,
        filter(f, skip) {
          // skip node_modules
          if (/node_modules/.test(f)) return skip;
          return true;
        }
      },
      async function (evt, name) {
        logger.log("changed: %s", name)
        // Realod settings in order to refresh plugins object in memory.
        // If we don't refresh it, the plugin will not be reloaded.
        // e.g., i18n plugin has i18n settings file in memory.
        await loadSettings()
        bundle()
      }
    );

    const params = {
      port: Settings.port,
      host: Settings.host,
      root: Settings.distDir,
      open: false,
      file: "index.html",
      wait: 1000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logLevel: 0 as any,
      middleware:
        Settings.crossOriginIsolation
          ? [
              function (req: any, res: any, next: any) {
                res.setHeader("Cross-Origin-Embedder-Policy", "credentialless")
                res.setHeader("Cross-Origin-Opener-Policy", "same-origin")
                next()
              }
          ]
          : []
    }

    liveServer.start(params)
    logger.log(chalk.green(`
    Server started on port ${Settings.port} 🚀
    You can access the following URL:

      http://localhost:${Settings.port}
    `))
    return true
  } else if (args.action === "build") {
    return await bundle()
  }
  return false
}
