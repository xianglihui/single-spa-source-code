import { ensureJQuerySupport } from "../jquery-support.js";
import {
  isActive,
  toName,
  NOT_LOADED,
  NOT_BOOTSTRAPPED,
  NOT_MOUNTED,
  MOUNTED,
  LOAD_ERROR,
  SKIP_BECAUSE_BROKEN,
  LOADING_SOURCE_CODE,
  shouldBeActive,
} from "./app.helpers.js";
import { reroute } from "../navigation/reroute.js";
import { find } from "../utils/find.js";
import { toUnmountPromise } from "../lifecycles/unmount.js";
import {
  toUnloadPromise,
  getAppUnloadInfo,
  addAppToUnload,
} from "../lifecycles/unload.js";
import { formatErrorMessage } from "./app-errors.js";
import { isInBrowser } from "../utils/runtime-environment.js";
import { assign } from "../utils/assign";
// 已经挂载的应用列表
const apps = [];
// 将应用分为四大类
export function getAppChanges() {
  // 需要被移除的应用
  const appsToUnload = [],
  // 需要被卸载的应用
    appsToUnmount = [],
  // 需要被加载的应用
    appsToLoad = [],
  // 需要被挂载的应用
    appsToMount = [];

  // 超时200ms后，会再次尝试在 LOAD_ERROR 中下载应用程序
  const currentTime = new Date().getTime();

  apps.forEach((app) => {
    // boolean，应用是否应该被激活
    const appShouldBeActive =
      app.status !== SKIP_BECAUSE_BROKEN && shouldBeActive(app);

    switch (app.status) {
       // 需要被加载的应用
      case LOAD_ERROR:
        if (appShouldBeActive && currentTime - app.loadErrorTime >= 200) {
          appsToLoad.push(app);
        }
        break;
        // 需要被加载的应用
      case NOT_LOADED:
      case LOADING_SOURCE_CODE:
        if (appShouldBeActive) {
          appsToLoad.push(app);
        }
        break;
        // 状态为xx的应用
      case NOT_BOOTSTRAPPED:
      case NOT_MOUNTED:
        if (!appShouldBeActive && getAppUnloadInfo(toName(app))) {
          // 需要被移除的应用
          appsToUnload.push(app);
        } else if (appShouldBeActive) {
          // 需要被挂载的应用
          appsToMount.push(app);
        }
        break;
        // 需要被卸载的应用，已经处于挂载状态，但现在路由已经变了的应用需要被卸载
      case MOUNTED:
        if (!appShouldBeActive) {
          appsToUnmount.push(app);
        }
        break;
      // all other statuses are ignored
    }
  });

  return { appsToUnload, appsToUnmount, appsToLoad, appsToMount };
}

// 获取已经挂载的应用，即状态为 MOUNTED 的应用
export function getMountedApps() {
  return apps.filter(isActive).map(toName);
}
// 获取app名称集合
export function getAppNames() {
  return apps.map(toName);
}

// 原有应用配置数据 devtools中使用
export function getRawAppData() {
  return [...apps];
}
// 获取应用状态，指：NOT_LOADED, NOT_MOUNTED, MOUNTED, ...
export function getAppStatus(appName) {
  const app = find(apps, (app) => toName(app) === appName);
  return app ? app.status : null;
}
/**
 * 注册应用，两种方式
 * registerApplication('app1', loadApp(url), activeWhen('/app1'), customProps)
 * registerApplication({
 *    name: 'app1',
 *    app: loadApp(url),
 *    activeWhen: activeWhen('/app1'),
 *    customProps: {}
 * })
 * @param {*} appNameOrConfig 应用名称或者应用配置对象
 * @param {*} appOrLoadApp 应用的加载方法，是一个 promise
 * @param {*} activeWhen 判断应用是否激活的一个方法，方法返回 true or false
 * @param {*} customProps 传递给子应用的 props 对象
 */

export function registerApplication(
  appNameOrConfig,
  appOrLoadApp,
  activeWhen,
  customProps
) {
  const registration = sanitizeArguments(
    appNameOrConfig,
    appOrLoadApp,
    activeWhen,
    customProps
  );
  // 判断应用是否重名
  if (getAppNames().indexOf(registration.name) !== -1)
  // 如果重名
    throw Error(
      formatErrorMessage(
        21,
        __DEV__ &&
        // "应用已经注册过了！"
          `There is already an app registered with name ${registration.name}`,
        registration.name
      )
    );
  // 将各个应用的配置信息都存放到 apps 数组中
  apps.push(
    // 给每个应用增加一个内置属性
    assign(
      {
        loadErrorTime: null,// 加载错误时间
        // 最重要的，应用的状态
        status: NOT_LOADED,
        parcels: {},
        devtools: {
          overlays: {
            options: {},
            selectors: [],
          },
        },
      },
      registration
    )
  );
  // 浏览器环境运行
  if (isInBrowser) {
    ensureJQuerySupport();
    reroute();
  }
}
// 获取当前激活函数：遍历所有应用，通过匹配应用标识符，得到应用的name
export function checkActivityFunctions(location = window.location) {
  return apps.filter((app) => app.activeWhen(location)).map(toName);
}
// 取消注册应用
export function unregisterApplication(appName) {
  // 应用本来就没有被注册过，无法取消注册
  if (apps.filter((app) => toName(app) === appName).length === 0) {
    throw Error(
      formatErrorMessage(
        25,
        __DEV__ &&
        // 此应该本来就未被注册过，因此无法取消注册
          `Cannot unregister application '${appName}' because no such application has been registered`,
        appName
      )
    );
  }
  // 取消注册应用，卸载完成后，从应用列表中移除
  return unloadApplication(appName).then(() => {
    const appIndex = apps.map(toName).indexOf(appName);
    apps.splice(appIndex, 1);
  });
}
// 卸载应用
export function unloadApplication(appName, opts = { waitForUnmount: false }) {
  if (typeof appName !== "string") {
    throw Error(
      formatErrorMessage(
        26,
        // 应用名称必须为字符串！
        __DEV__ && `unloadApplication requires a string 'appName'`
      )
    );
  }
  const app = find(apps, (App) => toName(App) === appName);
  if (!app) {
    throw Error(
      formatErrorMessage(
        27,
        __DEV__ &&
        // "app没注册，无需卸载
          `Could not unload application '${appName}' because no such application has been registered`,
        appName
      )
    );
  }

  const appUnloadInfo = getAppUnloadInfo(toName(app));
  if (opts && opts.waitForUnmount) {
    // We need to wait for unmount before unloading the app
    // 在unloading前，需要等待unmount完app
    if (appUnloadInfo) {
      // Someone else is already waiting for this, too
      // 别人也在等待
      return appUnloadInfo.promise;
    } else {
      // We're the first ones wanting the app to be resolved.
      // 没有人在等，直接卸载
      const promise = new Promise((resolve, reject) => {
        addAppToUnload(app, () => promise, resolve, reject);
      });
      return promise;
    }
  } else {
    /* We should unmount the app, unload it, and remount it immediately.
     */
     // 我们应该卸载应用程序，卸载完成后，立即重装它
    let resultPromise;

    if (appUnloadInfo) {
      // Someone else is already waiting for this app to unload
      resultPromise = appUnloadInfo.promise;
      immediatelyUnloadApp(app, appUnloadInfo.resolve, appUnloadInfo.reject);
    } else {
      // We're the first ones wanting the app to be resolved.
      resultPromise = new Promise((resolve, reject) => {
        addAppToUnload(app, () => resultPromise, resolve, reject);
        immediatelyUnloadApp(app, resolve, reject);
      });
    }

    return resultPromise;
  }
}
  // 立即卸载应用程序
function immediatelyUnloadApp(app, resolve, reject) {
  toUnmountPromise(app) // 先unmount
    .then(toUnloadPromise) // 再unload
    .then(() => {
      resolve();
      setTimeout(() => {
        // reroute, but the unload promise is done
        // 卸载应用已经完成，然后 reroute
        reroute();
      });
    })
    .catch(reject);
}
/**
 * 同样是验证四个参数是否合法
 */
function validateRegisterWithArguments(
  name,
  appOrLoadApp,
  activeWhen,
  customProps
) {
  // 应用名称校验
  if (typeof name !== "string" || name.length === 0)
    throw Error(
      formatErrorMessage(
        20,
        __DEV__ &&
        // throw Error("应用名称必须是字符串");
          `The 1st argument to registerApplication must be a non-empty string 'appName'`
      )
    );
// 装载函数校验
  if (!appOrLoadApp)
    throw Error(
      formatErrorMessage(
        23,
        __DEV__ &&
        // registerApplication的第二个参数必须是应用程序或加载应用程序函数;
          "The 2nd argument to registerApplication must be an application or loading application function"
      )
    );

  if (typeof activeWhen !== "function")
    throw Error(
      formatErrorMessage(
        24,
        __DEV__ &&
        // "必须是函数， 如：location => location.has.startsWith('#/app')"
          "The 3rd argument to registerApplication must be an activeWhen function"
      )
    );

  if (!validCustomProps(customProps))
    throw Error(
      formatErrorMessage(
        22,
        __DEV__ &&
        // throw Error("customProps必须是对象");
          "The optional 4th argument is a customProps and must be an object"
      )
    );
}
/**
 * 验证应用配置对象的各个属性是否存在不合法的情况，存在则抛出错误
 * @param {*} config = { name: 'app1', app: function, activeWhen: function, customProps: {} }
 */

export function validateRegisterWithConfig(config) {
  // 1. 异常判断，应用的配置对象不能是数组或者null
  if (Array.isArray(config) || config === null)
    throw Error(
      formatErrorMessage(
        39,
        __DEV__ && "Configuration object can't be an Array or null!"
      )
    );
  // 2. 应用配置必须是指定的几个关键字
  const validKeys = ["name", "app", "activeWhen", "customProps"];
  // 过滤函数，将不是 validKeys 中的key，过滤出来。
  const invalidKeys = Object.keys(config).reduce(
    (invalidKeys, prop) =>
      validKeys.indexOf(prop) >= 0 ? invalidKeys : invalidKeys.concat(prop),
    []
  );
  // 如果存在无效的key，则抛出一个错误,表示书写不合法
  if (invalidKeys.length !== 0)
    throw Error(
      formatErrorMessage(
        38,
        __DEV__ &&
        // 配置对象只接受 validKeys 中的属性，其他的无效
          `The configuration object accepts only: ${validKeys.join(
            ", "
          )}. Invalid keys: ${invalidKeys.join(", ")}.`,
        validKeys.join(", "),
        invalidKeys.join(", ")
      )
    );
 // 3. 应用名称存在校验
  if (typeof config.name !== "string" || config.name.length === 0)
    throw Error(
      formatErrorMessage(
        20,
        __DEV__ &&
        // 应用名称必须存在，且不能是空字符串
          "The config.name on registerApplication must be a non-empty string"
      )
    );
  // app 属性只能是一个对象或者函数
  // 对象是一个已被解析过的对象，是一个包含各个生命周期的对象；
  // 加载函数必须返回一个 promise
  // 以上信息在官方文档中有提到：https://zh-hans.single-spa.js.org/docs/configuration
  if (typeof config.app !== "object" && typeof config.app !== "function")
    throw Error(
      formatErrorMessage(
        20,
        __DEV__ &&
          "The config.app on registerApplication must be an application or a loading function"
      )
    );
  // 第三个参数，可以是一个字符串，也可以是一个函数，也可以是两者组成的一个数组，表示当前应该被激活的应用的baseURL
  const allowsStringAndFunction = (activeWhen) =>
    typeof activeWhen === "string" || typeof activeWhen === "function";
  if (
    !allowsStringAndFunction(config.activeWhen) &&
    !(
      Array.isArray(config.activeWhen) &&
      config.activeWhen.every(allowsStringAndFunction)
    )
  )
    throw Error(
      formatErrorMessage(
        24,
        __DEV__ &&
        // activeWhen 必须是字符串，或者函数或者数组
          "The config.activeWhen on registerApplication must be a string, function or an array with both"
      )
    );
  // 5. 自定义属性校验， 必须是一个对象
  if (!validCustomProps(config.customProps))
    throw Error(
      formatErrorMessage(
        22,
        // customProps 必须是对象，不能是函数或者数组，也不能为空
        __DEV__ && "The optional config.customProps must be an object"
      )
    );
}

function validCustomProps(customProps) {
  return (
    !customProps ||
    typeof customProps === "function" ||
    (typeof customProps === "object" &&
      customProps !== null &&
      !Array.isArray(customProps))
  );
}
/**
 * 格式化用户传递的子应用配置参数
 */
function sanitizeArguments(
  appNameOrConfig,
  appOrLoadApp,
  activeWhen,
  customProps
) {
  //  判断第一个参数是否为对象
  const usingObjectAPI = typeof appNameOrConfig === "object";

  // 初始化应用配置对象
  const registration = {
    name: null, // 应用名称
    loadApp: null, // promise函数加载app的函数
    activeWhen: null, // 当前激活的标识
    customProps: null, // 自定义属性，用于向子应用传递
  };

  // 注册应用的时候传递的参数是对象,校验合法后，进行赋值
  if (usingObjectAPI) {
    // 先做一层校验
    validateRegisterWithConfig(appNameOrConfig);
    registration.name = appNameOrConfig.name;
    registration.loadApp = appNameOrConfig.app;
    registration.activeWhen = appNameOrConfig.activeWhen;
    registration.customProps = appNameOrConfig.customProps;
  } else {
    // 参数列表
    validateRegisterWithArguments(
      appNameOrConfig,
      appOrLoadApp,
      activeWhen,
      customProps
    );
    registration.name = appNameOrConfig;
    registration.loadApp = appOrLoadApp;
    registration.activeWhen = activeWhen;
    registration.customProps = customProps;
  }
  // 如果第二个参数不是一个函数，比如是一个包含已经生命周期的对象，则包装成一个返回 promise 的函数
  registration.loadApp = sanitizeLoadApp(registration.loadApp);
  // 如果用户没有提供 props 对象，则给一个默认的空对象
  registration.customProps = sanitizeCustomProps(registration.customProps);
  // 保证activeWhen是一个返回boolean值的函数
  registration.activeWhen = sanitizeActiveWhen(registration.activeWhen);
  // 返回处理后的应用配置对象
  return registration;
}
// 保证第二个参数一定是一个返回 promise 的函数
function sanitizeLoadApp(loadApp) {
  if (typeof loadApp !== "function") {
    return () => Promise.resolve(loadApp);
  }

  return loadApp;
}

// 保证 props 不为 undefined
function sanitizeCustomProps(customProps) {
  return customProps ? customProps : {};
}
/**
 * 得到一个函数，函数负责判断浏览器当前地址是否和用户给定的baseURL相匹配，匹配返回true，否则返回false
 */
function sanitizeActiveWhen(activeWhen) {
  console.log("activeWhen", activeWhen);
  // activeWhen 返回一个函数，将location传入 (location) => location.hash.startsWith('#/app1'); 调用后返回一个字符串
  let activeWhenArray = Array.isArray(activeWhen) ? activeWhen : [activeWhen];
  // 保证数组中每个元素都是一个函数
  activeWhenArray = activeWhenArray.map((activeWhenOrPath) =>
    typeof activeWhenOrPath === "function"
      ? activeWhenOrPath
      // activeWhen如果是一个路径，则保证成一个函数
      : pathToActiveWhen(activeWhenOrPath)
  );
 // 返回一个函数，函数返回一个 boolean 值
  return (location) =>
    activeWhenArray.some((activeWhen) => activeWhen(location)); // 调用用户配置的函数，传入location
}

// activeWhen传入的不是函数，而是字符串或者数组，则特殊处理
// '/app1', '/users/:userId/profile', '/pathname/#/hash' ['/pathname/#/hash', '/app1']
// 具体见官方文档api，有详细说明：https://zh-hans.single-spa.js.org/docs/api
export function pathToActiveWhen(path, exactMatch) {
  // 根据用户提供的baseURL，生成正则表达式
  const regex = toDynamicPathValidatorRegex(path, exactMatch);
// 函数返回boolean值，判断当前路由是否匹配用户给定的路径
  return (location) => {
    // compatible with IE10
    let origin = location.origin;
    if (!origin) {
      origin = `${location.protocol}//${location.host}`;
    }
    const route = location.href
      .replace(origin, "")
      .replace(location.search, "")
      .split("?")[0];
    return regex.test(route);
  };
}

function toDynamicPathValidatorRegex(path, exactMatch) {
  let lastIndex = 0,
    inDynamic = false,
    regexStr = "^";
// 添加 / 前缀
  if (path[0] !== "/") {
    path = "/" + path;
  }
// /app1
  for (let charIndex = 0; charIndex < path.length; charIndex++) {
    const char = path[charIndex];
    const startOfDynamic = !inDynamic && char === ":";// 当前字符是：
    const endOfDynamic = inDynamic && char === "/";// 当前字符是 /
    if (startOfDynamic || endOfDynamic) {
      appendToRegex(charIndex);
    }
  }

  appendToRegex(path.length);
  return new RegExp(regexStr, "i");

  function appendToRegex(index) {
    const anyCharMaybeTrailingSlashRegex = "[^/]+/?";
    const commonStringSubPath = escapeStrRegex(path.slice(lastIndex, index));

    regexStr += inDynamic
      ? anyCharMaybeTrailingSlashRegex
      : commonStringSubPath;

    if (index === path.length) {
      if (inDynamic) {
        if (exactMatch) {
          // Ensure exact match paths that end in a dynamic portion don't match
          // urls with characters after a slash after the dynamic portion.
          regexStr += "$";
        }
      } else {
        // For exact matches, expect no more characters. Otherwise, allow
        // any characters.
        const suffix = exactMatch ? "" : ".*";

        regexStr =
          // use charAt instead as we could not use es6 method endsWith
          regexStr.charAt(regexStr.length - 1) === "/"
            ? `${regexStr}${suffix}$`
            : `${regexStr}(/${suffix})?(#.*)?$`;
      }
    }

    inDynamic = !inDynamic;
    lastIndex = index;
  }

  function escapeStrRegex(str) {
    // borrowed from https://github.com/sindresorhus/escape-string-regexp/blob/master/index.js
    return str.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  }
}
