import { onMessage, sendMessage } from 'webext-bridge'
import type { Tabs, Bookmarks } from 'webextension-polyfill'
import BookmarkService from '../utils/services'
import { Setting } from '../utils/setting'
import { OperType, BookmarkInfo, SyncDataInfo, RootBookmarksType, BrowserType } from '../utils/models'

// only on dev mode
if (import.meta.hot) {
  // @ts-expect-error for background HMR
  import('/@vite/client')
  // load latest content script
  import('./contentScriptHMR')
}

browser.runtime.onInstalled.addListener((): void => {
  // eslint-disable-next-line no-console
  console.log('Extension installed')
})

let previousTabId = 0

// communication example: send previous tab title from background page
// see shim.d.ts for type declaration
browser.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!previousTabId) {
    previousTabId = tabId
    return
  }

  let tab: Tabs.Tab

  try {
    tab = await browser.tabs.get(previousTabId)
    previousTabId = tabId
  }
  catch {
    return
  }

  // eslint-disable-next-line no-console
  console.log('previous tab', tab)
  sendMessage('tab-prev', { title: tab.title }, { context: 'content-script', tabId })
})

onMessage('get-current-tab', async () => {
  try {
    const tab = await browser.tabs.get(previousTabId)
    return {
      title: tab?.title,
    }
  }
  catch {
    return {
      title: undefined,
    }
  }
})

// 书签事件监听
let curOperType = OperType.NONE;
let curBrowserType = BrowserType.CHROME;
browser.runtime.onMessage.addListener(async (msg, sender) => {
    if (msg.name === 'upload') {
        curOperType = OperType.SYNC
        await uploadBookmarks();
        curOperType = OperType.NONE
        browser.browserAction.setBadgeText({ text: "" });
        refreshLocalCount();
    }
    if (msg.name === 'download') {
        curOperType = OperType.SYNC
        await downloadBookmarks();
        curOperType = OperType.NONE
        browser.browserAction.setBadgeText({ text: "" });
        refreshLocalCount();
    }
    if (msg.name === 'removeAll') {
        curOperType = OperType.REMOVE
        await clearBookmarkTree();
        curOperType = OperType.NONE
        browser.browserAction.setBadgeText({ text: "" });
        refreshLocalCount();
    }
    if (msg.name === 'setting') {
        await browser.runtime.openOptionsPage();
    }
    return true;
});
browser.bookmarks.onCreated.addListener((id, info) => {
    if (curOperType === OperType.NONE) {
        // console.log("onCreated", id, info)
        browser.browserAction.setBadgeText({ text: "!" });
        browser.browserAction.setBadgeBackgroundColor({ color: "#F00" });
        refreshLocalCount();
    }
});
browser.bookmarks.onChanged.addListener((id, info) => {
    if (curOperType === OperType.NONE) {
        // console.log("onChanged", id, info)
        browser.browserAction.setBadgeText({ text: "!" });
        browser.browserAction.setBadgeBackgroundColor({ color: "#F00" });
    }
})
browser.bookmarks.onMoved.addListener((id, info) => {
    if (curOperType === OperType.NONE) {
        // console.log("onMoved", id, info)
        browser.browserAction.setBadgeText({ text: "!" });
        browser.browserAction.setBadgeBackgroundColor({ color: "#F00" });
    }
})
browser.bookmarks.onRemoved.addListener((id, info) => {
    if (curOperType === OperType.NONE) {
        // console.log("onRemoved", id, info)
        browser.browserAction.setBadgeText({ text: "!" });
        browser.browserAction.setBadgeBackgroundColor({ color: "#F00" });
        refreshLocalCount();
    }
})

async function uploadBookmarks() {
    try {
        let setting = await Setting.build()
        if (setting.githubToken == '') {
            throw new Error("Gist Token Not Found");
        }
        if (setting.gistID == '') {
            throw new Error("Gist ID Not Found");
        }
        if (setting.gistFileName == '') {
            throw new Error("Gist File Not Found");
        }
        let bookmarks = await getBookmarks();
        let syncdata = new SyncDataInfo();
        syncdata.version = browser.runtime.getManifest().version;
        syncdata.createDate = Date.now();
        syncdata.bookmarks = formatBookmarks(bookmarks);
        syncdata.browser = navigator.userAgent;
        await BookmarkService.update(JSON.stringify({
            files: {
                [setting.gistFileName]: {
                    content: JSON.stringify(syncdata)
                }
            },
            description: setting.gistFileName
        }));
        const count = getBookmarkCount(syncdata.bookmarks);
        await browser.storage.local.set({ remoteCount: count });
        if (setting.enableNotify) {
            await browser.notifications.create({
                type: "basic",
                iconUrl: iconLogo,
                title: browser.i18n.getMessage('uploadBookmarks'),
                message: browser.i18n.getMessage('success')
            });
        }

    }
    catch (error) {
        await browser.notifications.create({
            type: "basic",
            iconUrl: iconLogo,
            title: browser.i18n.getMessage('uploadBookmarks'),
            message: `${browser.i18n.getMessage('error')}：${error.message}`
        });
    }
}
async function downloadBookmarks() {
    try {
        let gist = await BookmarkService.get();
        let setting = await Setting.build()
        if (gist) {
            let syncdata: SyncDataInfo = JSON.parse(gist);
            if (syncdata.bookmarks == undefined || syncdata.bookmarks.length == 0) {
                if (setting.enableNotify) {
                    await browser.notifications.create({
                        type: "basic",
                        iconUrl: iconLogo,
                        title: browser.i18n.getMessage('downloadBookmarks'),
                        message: `${browser.i18n.getMessage('error')}：Gist File ${setting.gistFileName} is NULL`
                    });
                }
                return;
            }
            await clearBookmarkTree();
            await createBookmarkTree(syncdata.bookmarks);
            const count = getBookmarkCount(syncdata.bookmarks);
            await browser.storage.local.set({ remoteCount: count });
            if (setting.enableNotify) {
                await browser.notifications.create({
                    type: "basic",
                    iconUrl: iconLogo,
                    title: browser.i18n.getMessage('downloadBookmarks'),
                    message: browser.i18n.getMessage('success')
                });
            }
        }
        else {
            await browser.notifications.create({
                type: "basic",
                iconUrl: iconLogo,
                title: browser.i18n.getMessage('downloadBookmarks'),
                message: `${browser.i18n.getMessage('error')}：Gist File ${setting.gistFileName} Not Found`
            });
        }
    }
    catch (error) {
        await browser.notifications.create({
            type: "basic",
            iconUrl: iconLogo,
            title: browser.i18n.getMessage('downloadBookmarks'),
            message: `${browser.i18n.getMessage('error')}：${error.message}`
        });
    }
}

async function getBookmarks() {
    let bookmarkTree: BookmarkInfo[] = await browser.bookmarks.getTree();
    if (bookmarkTree && bookmarkTree[0].id === "root________") {
        curBrowserType = BrowserType.FIREFOX;
    }
    else {
        curBrowserType = BrowserType.CHROME;
    }
    return bookmarkTree;
}

async function clearBookmarkTree() {
    try {
        let setting = await Setting.build()
        if (setting.githubToken == '') {
            throw new Error("Gist Token Not Found");
        }
        if (setting.gistID == '') {
            throw new Error("Gist ID Not Found");
        }
        if (setting.gistFileName == '') {
            throw new Error("Gist File Not Found");
        }
        let bookmarks = await getBookmarks();
        let tempNodes: BookmarkInfo[] = [];
        bookmarks[0].children?.forEach(c => {
            c.children?.forEach(d => {
                tempNodes.push(d)
            })
        });
        if (tempNodes.length > 0) {
            for (let node of tempNodes) {
                if (node.id) {
                    await browser.bookmarks.removeTree(node.id)
                }
            }
        }
        if (curOperType === OperType.REMOVE && setting.enableNotify) {
            await browser.notifications.create({
                type: "basic",
                iconUrl: iconLogo,
                title: browser.i18n.getMessage('removeAllBookmarks'),
                message: browser.i18n.getMessage('success')
            });
        }
    }
    catch (error) {
        await browser.notifications.create({
            type: "basic",
            iconUrl: iconLogo,
            title: browser.i18n.getMessage('removeAllBookmarks'),
            message: `${browser.i18n.getMessage('error')}：${error.message}`
        });
    }
}

async function createBookmarkTree(bookmarkList: BookmarkInfo[] | undefined) {
    if (bookmarkList == null) {
        return;
    }
    for (let i = 0; i < bookmarkList.length; i++) {
        let node = bookmarkList[i];
        if (node.title == RootBookmarksType.MenuFolder
            || node.title == RootBookmarksType.MobileFolder
            || node.title == RootBookmarksType.ToolbarFolder
            || node.title == RootBookmarksType.UnfiledFolder) {
            if (curBrowserType == BrowserType.FIREFOX) {
                switch (node.title) {
                    case RootBookmarksType.MenuFolder:
                        node.children?.forEach(c => c.parentId = "menu________");
                        break;
                    case RootBookmarksType.MobileFolder:
                        node.children?.forEach(c => c.parentId = "mobile______");
                        break;
                    case RootBookmarksType.ToolbarFolder:
                        node.children?.forEach(c => c.parentId = "toolbar_____");
                        break;
                    case RootBookmarksType.UnfiledFolder:
                        node.children?.forEach(c => c.parentId = "unfiled_____");
                        break;
                    default:
                        node.children?.forEach(c => c.parentId = "unfiled_____");
                        break;
                }
            } else {
                switch (node.title) {
                    case RootBookmarksType.MobileFolder:
                        node.children?.forEach(c => c.parentId = "3");
                        break;
                    case RootBookmarksType.ToolbarFolder:
                        node.children?.forEach(c => c.parentId = "1");
                        break;
                    case RootBookmarksType.UnfiledFolder:
                    case RootBookmarksType.MenuFolder:
                        node.children?.forEach(c => c.parentId = "2");
                        break;
                    default:
                        node.children?.forEach(c => c.parentId = "2");
                        break;
                }
            }
            await createBookmarkTree(node.children);
            continue;
        }

        let res: Bookmarks.BookmarkTreeNode = { id: '', title: '' };
        try {
            /* 处理firefox中创建 chrome://chrome-urls/ 格式的书签会报错的问题 */
            res = await browser.bookmarks.create({
                parentId: node.parentId,
                title: node.title,
                url: node.url
            });
        } catch (err) {
            console.error(res, err);
        }
        if (res.id && node.children && node.children.length > 0) {
            node.children.forEach(c => c.parentId = res.id);
            await createBookmarkTree(node.children);
        }
    }
}

function getBookmarkCount(bookmarkList: BookmarkInfo[] | undefined) {
    let count = 0;
    if (bookmarkList) {
        bookmarkList.forEach(c => {
            if (c.url) {
                count = count + 1;
            }
            else {
                count = count + getBookmarkCount(c.children);
            }
        });
    }
    return count;
}

async function refreshLocalCount() {
    let bookmarkList = await getBookmarks();
    const count = getBookmarkCount(bookmarkList);
    await browser.storage.local.set({ localCount: count });
}


function formatBookmarks(bookmarks: BookmarkInfo[]): BookmarkInfo[] | undefined {
    if (bookmarks[0].children) {
        for (let a of bookmarks[0].children) {
            switch (a.id) {
                case "1":
                case "toolbar_____":
                    a.title = RootBookmarksType.ToolbarFolder;
                    break;
                case "menu________":
                    a.title = RootBookmarksType.MenuFolder;
                    break;
                case "2":
                case "unfiled_____":
                    a.title = RootBookmarksType.UnfiledFolder;
                    break;
                case "3":
                case "mobile______":
                    a.title = RootBookmarksType.MobileFolder;
                    break;
            }
        }
    }

    let a = format(bookmarks[0]);
    return a.children;
}

function format(b: BookmarkInfo): BookmarkInfo {
    b.dateAdded = undefined;
    b.dateGroupModified = undefined;
    b.id = undefined;
    b.index = undefined;
    b.parentId = undefined;
    b.type = undefined;
    b.unmodifiable = undefined;
    if (b.children && b.children.length > 0) {
        b.children?.map(c => format(c))
    }
    return b;
}
///暂时不启用自动备份
async function backupToLocalStorage(bookmarks: BookmarkInfo[]) {
    try {
        let syncdata = new SyncDataInfo();
        syncdata.version = browser.runtime.getManifest().version;
        syncdata.createDate = Date.now();
        syncdata.bookmarks = formatBookmarks(bookmarks);
        syncdata.browser = navigator.userAgent;
        const keyname = 'BookmarkHub_backup_' + Date.now().toString();
        await browser.storage.local.set({ [keyname]: JSON.stringify(syncdata) });
    }
    catch (error) {
        console.error(error)
    }
}
