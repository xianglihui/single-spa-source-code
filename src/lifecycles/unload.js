import {
  NOT_MOUNTED,
  UNLOADING,
  NOT_LOADED,
  LOAD_ERROR,
  SKIP_BECAUSE_BROKEN,
  toName,
} from "../applications/app.helpers.js";
import { handleAppError } from "../applications/app-errors.js";
import { reasonableTime } from "../applications/timeouts.js";

const appsToUnload = {};

export function toUnloadPromise(app) {
  return Promise.resolve().then(() => {
    // 在销毁映射表中没找到应用名字，说明没有要销毁的
    const unloadInfo = appsToUnload[toName(app)];
    // 没有加载的应用，无需销毁
    if (!unloadInfo) {
      /* No one has called unloadApplication for this app,
       */
      return app;
    }

    if (app.status === NOT_LOADED) {
      /* This app is already unloaded. We just need to clean up
       * anything that still thinks we need to unload the app.
       */
      finishUnloadingApp(app, unloadInfo);
      return app;
    }

    if (app.status === UNLOADING) {
      /* Both unloadApplication and reroute want to unload this app.
       * It only needs to be done once, though.
       */
      return unloadInfo.promise.then(() => app);
    }

    if (app.status !== NOT_MOUNTED && app.status !== LOAD_ERROR) {
      /* The app cannot be unloaded until it is unmounted.
       */
      return app;
    }

    const unloadPromise =
      app.status === LOAD_ERROR
        ? Promise.resolve()
        : reasonableTime(app, "unload");

    app.status = UNLOADING;

    return unloadPromise
      .then(() => {
        finishUnloadingApp(app, unloadInfo);
        return app;
      })
      .catch((err) => {
        errorUnloadingApp(app, unloadInfo, err);
        return app;
      });
  });
}
// 销毁应用
function finishUnloadingApp(app, unloadInfo) {
  delete appsToUnload[toName(app)];
  // 销毁生命周期
  // Unloaded apps don't have lifecycles
  delete app.bootstrap;
  delete app.mount;
  delete app.unmount;
  delete app.unload;
  // 更新状态
  app.status = NOT_LOADED;

  /* resolve the promise of whoever called unloadApplication.
   * This should be done after all other cleanup/bookkeeping
   */
  // 销毁完了，让程序继续往下执行
  unloadInfo.resolve();
}
// 销毁应用出错
function errorUnloadingApp(app, unloadInfo, err) {
  delete appsToUnload[toName(app)];

  // Unloaded apps don't have lifecycles
  // 销毁生命周期
  delete app.bootstrap;
  delete app.mount;
  delete app.unmount;
  delete app.unload;
  // 更新状态
  handleAppError(err, app, SKIP_BECAUSE_BROKEN);
   // 销毁出错，让程序继续往下走
  unloadInfo.reject(err);
}
// 把待销毁app保存到 appsToUnload 映射表中
export function addAppToUnload(app, promiseGetter, resolve, reject) {
  appsToUnload[toName(app)] = { app, resolve, reject };
  // 调用 app1.promise => promiseGetter
  Object.defineProperty(appsToUnload[toName(app)], "promise", {
    get: promiseGetter,
  });
}
// 待销毁app的销毁信息
export function getAppUnloadInfo(appName) {
  return appsToUnload[appName];
}
