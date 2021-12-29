import CustomEvent from "custom-event";
import { isStarted } from "../start.js";
import { toLoadPromise } from "../lifecycles/load.js";
import { toBootstrapPromise } from "../lifecycles/bootstrap.js";
import { toMountPromise } from "../lifecycles/mount.js";
import { toUnmountPromise } from "../lifecycles/unmount.js";
import {
  getAppStatus,
  getAppChanges,
  getMountedApps,
} from "../applications/apps.js";
import {
  callCapturedEventListeners,
  navigateToUrl,
} from "./navigation-events.js";
import { toUnloadPromise } from "../lifecycles/unload.js";
import {
  toName,
  shouldBeActive,
  NOT_MOUNTED,
  MOUNTED,
  NOT_LOADED,
  SKIP_BECAUSE_BROKEN,
} from "../applications/app.helpers.js";
import { assign } from "../utils/assign.js";
import { isInBrowser } from "../utils/runtime-environment.js";

let appChangeUnderway = false,// app切换完成（旧app卸载完成，新app挂载完成）
  peopleWaitingOnAppChange = [],
  currentUrl = isInBrowser && window.location.href;
// 不带任何参数，进行重新路由
export function triggerAppChange() {
  // Call reroute with no arguments, intentionally
  return reroute();
}
// reroute 更改app.status和执行生命周期函数
/**
 * 每次切换路由前，将应用分为4大类，
 * 首次加载时执行loadApp
 * 后续的路由切换执行performAppChange
 * 为四大类的应用分别执行相应的操作，比如更改app.status，执行生命周期函数
 * 所以，从这里也可以看出来，single-spa就是一个维护应用的状态机
 * @param {*} pendingPromises 
 * @param {*} eventArguments 
 */
// 主函数-核心
export function reroute(pendingPromises = [], eventArguments) {
  // 应用正在切换，这个状态会在执行performAppChanges之前置为true，执行结束之后再置为false
  // 如果在中间用户重新切换路由了，即走这个if分支，暂时看起来就在数组中存储了一些信息，没看到有什么用
  // 字面意思理解就是用户等待app切换

  // 1. start方法调用过了，app切换完成，则直接返回
  if (appChangeUnderway) {
    return new Promise((resolve, reject) => {
      peopleWaitingOnAppChange.push({
        resolve,
        reject,
        eventArguments,
      });
    });
  }
// 将应用分为4大类
  const {
    // 需要被移除的
    appsToUnload,
    // 需要被卸载的
    appsToUnmount,
    // 需要被加载的
    appsToLoad,
    // 需要被挂载的
    appsToMount,
  } = getAppChanges();
  let appsThatChanged,
    navigationIsCanceled = false,// 是否取消导航
    oldUrl = currentUrl,
    newUrl = (currentUrl = window.location.href);
  // 是否已经执行 start 方法
  if (isStarted()) {
    // 已执行
    appChangeUnderway = true;
    // 所有需要被改变的的应用
    appsThatChanged = appsToUnload.concat(
      appsToLoad,
      appsToUnmount,
      appsToMount
    );
    // 执行改变
    return performAppChanges();
  } else {
    // 未执行
    appsThatChanged = appsToLoad;
    // 加载Apps
    return loadApps();
  }

  function cancelNavigation() {
    navigationIsCanceled = true;
  }
// 整体返回一个立即resolved的promise，通过微任务来加载apps(加载应用)
  function loadApps() {
    return Promise.resolve().then(() => {
      // 加载每个子应用，并做一系列的状态变更和验证（比如结果为promise、子应用要导出生命周期函数）
      const loadPromises = appsToLoad.map(toLoadPromise);// 1. Promise => Promise.resolve().then()  promise还没有执行

      return (
        // 保证所有加载子应用的微任务执行完成
        Promise.all(loadPromises)// 并发调用返回的 Promise.resolve().then(), 调用loadApp, 返回 Promise.then(val) val => { bootstrap: async () => {}, mount: async () => {}, ... } 
          .then(callAllEventListeners)// 调用函数
          // there are no mounted apps, before start() is called, so we always return []
          .then(() => [])// 在调用start()之前，没有mounted 应用，因此我们始终返回[]
          .catch((err) => {
            callAllEventListeners();
            throw err;
          })
      );
    });
  }
 // 执行app切换，挂载
  function performAppChanges() {
    return Promise.resolve().then(() => {
      // https://github.com/single-spa/single-spa/issues/545
       // 自定义事件，在应用状态发生改变之前可触发，给用户提供搞事情的机会
      window.dispatchEvent(
        new CustomEvent(
          appsThatChanged.length === 0
            ? "single-spa:before-no-app-change"
            : "single-spa:before-app-change",
          getCustomEventDetail(true)// 取消导航函数合并到属性上
        )
      );

      window.dispatchEvent(
        new CustomEvent(
          "single-spa:before-routing-event",
          getCustomEventDetail(true, { cancelNavigation })
        )
      );
      // 导航取消，触发自定义事件，恢复之前的状态，跳转到oldUrl
      if (navigationIsCanceled) {
        window.dispatchEvent(
          new CustomEvent(
            "single-spa:before-mount-routing-event",
            getCustomEventDetail(true)
          )
        );
        finishUpAndReturn();
        navigateToUrl(oldUrl);
        return;
      }
      // 移除应用 => 更改应用状态，执行unload生命周期函数，执行一些清理动作
      // 其实一般情况下这里没有真的移除应用
      // 先卸载
      const unloadPromises = appsToUnload.map(toUnloadPromise);// promise，调用执行销毁函数
      // 卸载应用，更改状态，执行unmount生命周期函数
      // unMount后，再unLoad一下
      const unmountUnloadPromises = appsToUnmount
        .map(toUnmountPromise)
        // 卸载完然后移除，通过注册微任务的方式实现
        .map((unmountPromise) => unmountPromise.then(toUnloadPromise));
      // 所有需要卸载的应用
      const allUnmountPromises = unmountUnloadPromises.concat(unloadPromises);
      // 并发卸载
      const unmountAllPromise = Promise.all(allUnmountPromises);
      // 卸载全部完成后触发一个事件
      // 卸载完成后，触发自定义事件，用户想在mounted前干点啥，可以干
      unmountAllPromise.then(() => {
        window.dispatchEvent(
          new CustomEvent(
            "single-spa:before-mount-routing-event",
            getCustomEventDetail(true)
          )
        );
      });

      /* We load and bootstrap apps while other apps are unmounting, but we
       * wait to mount the app until all apps are finishing unmounting
       * 这个原因其实是因为这些操作都是通过注册不同的微任务实现的，而JS是单线程执行，
       * 所以自然后续的只能等待前面的执行完了才能执行
       * 这里一般情况下其实不会执行，只有手动执行了unloadApplication方法才会二次加载
       * 在卸载完成后，加载和启动 appsToLoad 中的应用
       */
      const loadThenMountPromises = appsToLoad.map((app) => {
        return toLoadPromise(app).then((app) =>
          tryToBootstrapAndMount(app, unmountAllPromise)
        );
      });

      /* These are the apps that are already bootstrapped and just need
       * to be mounted. They each wait for all unmounting apps to finish up
       * before they mount.
       * 初始化和挂载app，其实做的事情很简单，就是改变app.status，执行生命周期函数
       * 当然这里的初始化和挂载其实是前后脚一起完成的(只要中间用户没有切换路由)
       * 从appsToMount中过滤出appsToLoad中不包含的应用，启动并挂载它们
       */
      const mountPromises = appsToMount
        .filter((appToMount) => appsToLoad.indexOf(appToMount) < 0)
        .map((appToMount) => {
          return tryToBootstrapAndMount(appToMount, unmountAllPromise);
        });
        // 捕获卸载应用过程出错
      return unmountAllPromise
        .catch((err) => {
          callAllEventListeners();
          throw err;
        })
        .then(() => {
          /* Now that the apps that needed to be unmounted are unmounted, their DOM navigation
           * events (like hashchange or popstate) should have been cleaned up. So it's safe
           * to let the remaining captured event listeners to handle about the DOM event.
           */
          // 现在已经卸载了需要卸载的应用程序以及它们的导航事件（如hashchange、popstate)应该已经清除了。因此让其余捕获的时间监听器处理有关DOM事件是安全的。
          callAllEventListeners();

          return Promise.all(loadThenMountPromises.concat(mountPromises))
            .catch((err) => {
              pendingPromises.forEach((promise) => promise.reject(err));
              throw err;
            })
            .then(finishUpAndReturn);
        });
    });
  }
// 完成了卸载和挂载
  function finishUpAndReturn() {
    const returnValue = getMountedApps();// 获取状态为 MOUNTED 的app
    pendingPromises.forEach((promise) => promise.resolve(returnValue));

    try {
      const appChangeEventName =
        appsThatChanged.length === 0
          ? "single-spa:no-app-change"
          : "single-spa:app-change";
      window.dispatchEvent(
        new CustomEvent(appChangeEventName, getCustomEventDetail())
      );
      window.dispatchEvent(
        new CustomEvent("single-spa:routing-event", getCustomEventDetail())
      );
    } catch (err) {
      /* We use a setTimeout because if someone else's event handler throws an error, single-spa
       * needs to carry on. If a listener to the event throws an error, it's their own fault, not
       * single-spa's.
       */
      // 为啥要用setTimeout呢？因为如果其他人的事件处理抛出错误，则single-spa需要处理。单如果是时间监听器抛出的错误，是他们自己的错，single-spa不需要处理。
      setTimeout(() => {
        throw err;
      });
    }

    /* Setting this allows for subsequent calls to reroute() to actually perform
     * a reroute instead of just getting queued behind the current reroute call.
     * We want to do this after the mounting/unmounting is done but before we
     * resolve the promise for the `reroute` function.
     */
    // 设置该项，允许后续调用 reroute 进行重新路由，而不是再路由调用后排队。
    // 我们希望在加载mounting、卸载unmounting后，但是在resolve reroute 这个promise函数之前执行这个操作
    appChangeUnderway = false;

    if (peopleWaitingOnAppChange.length > 0) {
      /* While we were rerouting, someone else triggered another reroute that got queued.
       * So we need reroute again.
       */
      // 当我们 reroute 时，其他人触发了另一个排队的 reroute，因此我们需要再次 reroute.
      const nextPendingPromises = peopleWaitingOnAppChange;
      peopleWaitingOnAppChange = [];
      reroute(nextPendingPromises);
    }

    return returnValue;
  }

  /* We need to call all event listeners that have been delayed because they were
   * waiting on single-spa. This includes haschange and popstate events for both
   * the current run of performAppChanges(), but also all of the queued event listeners.
   * We want to call the listeners in the same order as if they had not been delayed by
   * single-spa, which means queued ones first and then the most recent one.
   */
  // 调用所有事件监听方法，这些方法因为等待single-spa，被延迟调用。
  // 这些监听方法，包括hashchange，popstate事件，当前运行的performAppChanges()，还有排队的事件监听器。
  // 我们会依次按照顺序去调用，先排队，先调用。
  function callAllEventListeners() {
    pendingPromises.forEach((pendingPromise) => {
      callCapturedEventListeners(pendingPromise.eventArguments);
    });

    callCapturedEventListeners(eventArguments);
  }
 // 获取自定义事件的detail
  function getCustomEventDetail(isBeforeChanges = false, extraProperties) {
    const newAppStatuses = {};// 各个app的新状态 { 'app1': MOUNTED, ... }
    const appsByNewStatus = {
      // for apps that were mounted
      [MOUNTED]: [],// mounted的app列表
      // for apps that were unmounted
      [NOT_MOUNTED]: [],
      // apps that were forcibly unloaded
      [NOT_LOADED]: [],
      // apps that attempted to do something but are broken now
      [SKIP_BECAUSE_BROKEN]: [],// 尝试执行某些操作，但是已经损坏的应用程序
    };

    if (isBeforeChanges) {
      appsToLoad.concat(appsToMount).forEach((app, index) => {// 待加载、待挂载 => 挂载完成 
        addApp(app, MOUNTED);
      });
      appsToUnload.forEach((app) => {// 待销毁 =>待加载
        addApp(app, NOT_LOADED);
      });
      appsToUnmount.forEach((app) => {// 待卸载 => 待挂载
        addApp(app, NOT_MOUNTED);
      });
    } else {
      appsThatChanged.forEach((app) => {
        addApp(app);
      });
    }

    const result = {
      detail: {
        newAppStatuses,
        appsByNewStatus,
        totalAppChanges: appsThatChanged.length,
        originalEvent: eventArguments?.[0],
        oldUrl,
        newUrl,
        navigationIsCanceled,
      },
    };
    // 对象合并
    if (extraProperties) {
      assign(result.detail, extraProperties);
    }

    return result;
    // 给app赋值当前状态
    function addApp(app, status) {
      const appName = toName(app);
      status = status || getAppStatus(appName);
      newAppStatuses[appName] = status;
      const statusArr = (appsByNewStatus[status] =
        appsByNewStatus[status] || []);
      statusArr.push(appName);
    }
  }
}

/**
 * Let's imagine that some kind of delay occurred during application loading.
 * The user without waiting for the application to load switched to another route,
 * this means that we shouldn't bootstrap and mount that application, thus we check
 * twice if that application should be active before bootstrapping and mounting.
 * https://github.com/single-spa/single-spa/issues/524
 */
// 假设在应用程序加载期间发生了某种类型的延迟，用户无需等待应用加载完成，就直接切换到另一条线路。
// 这意味着我们不应该启动并挂载该应用程序。
// 因此，我们进行第二次检查，看看该应用是否在启动和挂载之前是被加载了的
function tryToBootstrapAndMount(app, unmountAllPromise) {
  if (shouldBeActive(app)) {
    return toBootstrapPromise(app).then((app) =>
      unmountAllPromise.then(() =>
        shouldBeActive(app) ? toMountPromise(app) : app
      )
    );
  } else {
    return unmountAllPromise.then(() => app);
  }
}
