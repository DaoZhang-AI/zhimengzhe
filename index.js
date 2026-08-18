/**
 * 🦋 织梦者
 *
 * 道长自研插件的总入口。面板分成两类:
 *   「⚡ 酒馆优化」原美梦工具箱那一套(开屏减负 / 插件减负 / 推荐设置 / 卡顿优化)
 *   「🧩 我的插件」以后小手机、预设之类从这里一键下载和更新
 * 每个模块独立开关,关掉的模块不渲染界面。
 *
 * 为什么要自己再请求一次 /api/settings/get:
 * 扩展是在 getSettings() 的响应处理里才被加载的(public/script.js:7965),
 * 开屏那一次的原始响应扩展根本看不到,只能自己再要一次。体检是点一下才跑,不常跑。
 *
 * 归档动作需要配套的服务端插件(plugins/zhimengzhe),
 * 因为酒馆自带的 /api/presets/save 会 sanitize 掉路径分隔符,浏览器侧写不进子目录。
 * 探不到服务端插件时,体检照常出账单,只是不显示归档按钮。
 */

import { extension_settings, installExtension } from '../../../extensions.js';
import { chat, messageFormatting, addOneMessage, saveChatConditional, updateMessageBlock, name2, getRequestHeaders, saveSettings, saveSettingsDebounced, reloadCurrentChat, getCurrentChatId, printCharacters } from '../../../../script.js';
import { eventSource, event_types } from '../../../events.js';
import { oai_settings, promptManager } from '../../../openai.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { power_user } from '../../../power-user.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { debounce, delay } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';
import { hljs } from '../../../../lib.js';

/** 跟 manifest.json 的 version 手动保持一致。酒馆加载扩展脚本的 URL 不带版本号
 *  (extensions.js:819),浏览器和 CDN 都可能喂旧副本,靠这行在控制台辨认在跑哪一版。 */
const VERSION = '0.28.3';

/** 2026-08-17 连目录带内部 id 一起从「美梦工具箱」改成「织梦者」。
 *
 *  为什么是这个时候改:酒馆装扩展时**文件夹名是从仓库地址直接推出来的**
 *  (src/endpoints/extensions.js:122),所以仓库叫什么、别人装完的目录就叫什么。
 *  而这一刻还没有任何第三方用户,装了这个插件的只有道长自己两台。
 *  **等发出去、社区里一堆人装上,这个名字就再也改不动了。窗口只有现在。**
 *
 *  下面这几个名字必须和仓库名、文件夹名、服务端插件目录名保持一致,改一个就得全改:
 *  MODULE_NAME(设置里的键)、PLUGIN_ID(服务端插件路由)、PANEL_PROTECTED 里那一项。 */
const MODULE_NAME = 'zhimengzhe';
const PLUGIN_ID = 'zhimengzhe';
/** 旧名,只为把道长自己两台机器上的开关搬过来。
 *  等她两台都确认没问题,这个常量和 getSettings 里那段迁移可以一起删掉。 */
const LEGACY_MODULE_NAME = 'meimeng_toolkit';
const PLUGIN_BASE = `/api/plugins/${PLUGIN_ID}`;

const defaultSettings = {
    /** 每个模块一个开关,关掉的模块不渲染界面 */
    modules: {
        startupCheckup: true,
        cssDebounce: true,
        presetToggleDebounce: true,
        disableHighlight: true,
        collapseCode: false,
        swipeGuard: true,
        regexBatch: true,
        smallPageOption: true,
        panelToggles: true,
        saveStatus: true,
        saveQueue: true,
        logSaveCallers: true,
        startupPrefetch: true,
        /** 在生成的关键路径上,默认关,要她自己开 */
        generationRelay: false,
    },
    /** 滑动多少像素才算数,酒馆原生只有 20,太容易误触 */
    swipeThreshold: 60,
    /** 状态小球被拖到哪儿了 */
    statusBallPos: null,
    /** 推荐设置只在头一回装上时问一次,问过就记下来 */
    recommendAsked: false,
};

/** 服务端 config.yaml 里那几个藏得深的开关,浏览器看不到,只能问插件 */
let serverFlags = null;

/** 服务端插件在不在。init 时探一次。 */
let serverPluginAvailable = false;

/** 最近一次体检的结果,归档界面要用 */
let lastBill = null;

/** 正在搬运,用来挡重复点击 */
let moveInFlight = false;

const encoder = new TextEncoder();

/**
 * 字符串的 UTF-8 字节数。
 * 不能用 .length,预设里几乎全是中文,一个字 3 字节,用 length 会把账算少一大半。
 * @param {string} str
 * @returns {number}
 */
function utf8Bytes(str) {
    return typeof str === 'string' ? encoder.encode(str).length : 0;
}

/**
 * @param {number} bytes
 * @returns {string} human readable
 */
function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * @param {string} text
 * @returns {string} HTML 转义后的文本,预设名是用户可控的,必须转义
 */
function escapeHtml(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function getSettings() {
    // 改名遗留:老键里有东西、新键还没有,就整个搬过来,别让她两台机器重设一遍开关
    if (!extension_settings[MODULE_NAME] && extension_settings[LEGACY_MODULE_NAME]) {
        extension_settings[MODULE_NAME] = extension_settings[LEGACY_MODULE_NAME];
        delete extension_settings[LEGACY_MODULE_NAME];
        console.log('[织梦者] 把旧名下的设置搬过来了');
        saveSettingsDebounced();
    }

    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }

    // 补齐后来新增的模块开关,老用户升级时不至于缺键
    const settings = extension_settings[MODULE_NAME];
    settings.modules = Object.assign({}, defaultSettings.modules, settings.modules);
    return settings;
}

/**
 * 探一下服务端插件在不在。
 * @returns {Promise<boolean>}
 */
async function probeServerPlugin() {
    try {
        const response = await fetch(`${PLUGIN_BASE}/ping`, { method: 'GET' });
        if (!response.ok) return false;
        const data = await response.json();
        return data?.ok === true;
    } catch {
        return false;
    }
}

/**
 * 就地体检:让服务端插件在文件旁边把账算好,只把几 KB 的数字发回来。
 *
 * 这是首选路子。浏览器侧体检要把整份 /api/settings/get 再下一遍,
 * 本机走内存无所谓,云端那就是十几 MB 真的过一遍隧道(实测要等好几分钟),
 * 等于工具自己成了它要治的那个病。
 *
 * @returns {Promise<{bill: object, archived: Array}>}
 */
async function runCheckupViaServer() {
    const response = await fetch(`${PLUGIN_BASE}/bill`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw new Error(`服务端体检返回 ${response.status}`);
    }

    const data = await response.json();

    // 服务端给的是文件名(带 .json),界面上要显示预设名(不带)
    const presets = (data.presets || []).map(f => ({
        name: f.name.replace(/\.json$/i, ''),
        fileName: f.name,
        bytes: f.size,
    }));

    const bill = {
        source: 'server',
        totalBytes: data.totalBytes,
        settingsBytes: data.settingsBytes,
        presetsBytes: data.presetsBytes,
        presets,
        extensionBreakdown: data.extensionBreakdown || [],
        others: data.others || [],
        activePreset: oai_settings?.preset_settings_openai ?? '',
    };

    const archived = (data.archived || []).map(f => ({ name: f.name, size: f.size }));
    return { bill, archived };
}

/**
 * 浏览器侧体检:自己请求一份 /api/settings/get,把账单拆开。
 * 只在没装服务端插件时走这条,因为它要把整份响应下下来。
 * @returns {Promise<object>} 账单
 */
async function runCheckup() {
    // 给它一个上限,不然响应大又慢的时候按钮会一直转,让人以为死了
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);

    let response;

    try {
        response = await fetch('/api/settings/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
            signal: controller.signal,
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('等了 3 分钟还没下完,已放弃。装上服务端插件就不用下这一份了。');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }

    if (!response.ok) {
        throw new Error(`/api/settings/get 返回 ${response.status}`);
    }

    // 先拿原文量总数,这个才是开屏真正走的字节数
    const rawText = await response.text();
    const totalBytes = utf8Bytes(rawText);
    const data = JSON.parse(rawText);

    // 预设:名字和内容同序一一对应
    const presetNames = Array.isArray(data.openai_setting_names) ? data.openai_setting_names : [];
    const presetContents = Array.isArray(data.openai_settings) ? data.openai_settings : [];
    const presets = presetNames.map((name, i) => ({
        name,
        fileName: `${name}.json`,
        bytes: utf8Bytes(presetContents[i]),
    })).sort((a, b) => b.bytes - a.bytes);

    const presetsBytes = presets.reduce((sum, p) => sum + p.bytes, 0);

    // settings.json 本体,并按 extension_settings.<扩展名> 拆开
    const settingsBytes = utf8Bytes(data.settings);
    const extensionBreakdown = [];

    try {
        const parsedSettings = JSON.parse(data.settings);
        const extSettings = parsedSettings?.extension_settings;

        if (extSettings && typeof extSettings === 'object') {
            for (const [key, value] of Object.entries(extSettings)) {
                extensionBreakdown.push({ name: key, bytes: utf8Bytes(JSON.stringify(value)) });
            }
            extensionBreakdown.sort((a, b) => b.bytes - a.bytes);
        }
    } catch {
        // settings 解析不了就不拆,总数照样准
    }

    // 其余各类,都是整块塞进同一个响应的
    const others = [
        { name: '主题 themes', bytes: utf8Bytes(JSON.stringify(data.themes)) },
        { name: '快速回复 quickReplyPresets', bytes: utf8Bytes(JSON.stringify(data.quickReplyPresets)) },
        { name: 'NovelAI 预设', bytes: utf8Bytes(JSON.stringify(data.novelai_settings)) },
        { name: 'TextGen 预设', bytes: utf8Bytes(JSON.stringify(data.textgenerationwebui_presets)) },
        { name: 'Kobold 预设', bytes: utf8Bytes(JSON.stringify(data.koboldai_settings)) },
        { name: '指令模板 instruct', bytes: utf8Bytes(JSON.stringify(data.instruct)) },
        { name: '上下文模板 context', bytes: utf8Bytes(JSON.stringify(data.context)) },
        { name: '系统提示 sysprompt', bytes: utf8Bytes(JSON.stringify(data.sysprompt)) },
        { name: '推理模板 reasoning', bytes: utf8Bytes(JSON.stringify(data.reasoning)) },
        { name: 'MovingUI 预设', bytes: utf8Bytes(JSON.stringify(data.movingUIPresets)) },
    ].filter(x => x.bytes > 2).sort((a, b) => b.bytes - a.bytes);

    return {
        source: 'browser',
        totalBytes,
        settingsBytes,
        presetsBytes,
        presets,
        extensionBreakdown,
        others,
        activePreset: oai_settings?.preset_settings_openai ?? '',
    };
}

/**
 * 问服务端插件要归档目录里的东西。
 * @returns {Promise<Array<{name: string, size: number}>>}
 */
async function fetchArchived() {
    if (!serverPluginAvailable) return [];

    try {
        const response = await fetch(`${PLUGIN_BASE}/list`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });

        if (!response.ok) return [];

        const data = await response.json();
        return Array.isArray(data.archived) ? data.archived : [];
    } catch {
        return [];
    }
}

/**
 * 把账单画成报告。
 * @param {object} bill
 * @param {Array<{name: string, size: number}>} archived
 */
function renderReport(bill, archived) {
    const $out = $('#mmtk_report');
    const topPresets = bill.presets.slice(0, 8);
    const topExtensions = bill.extensionBreakdown.slice(0, 8);

    const row = (name, bytes, total) => {
        const percent = total ? (bytes / total * 100).toFixed(1) : '0.0';
        return `<div class="mmtk_row">
            <span class="mmtk_row_name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="mmtk_row_size">${formatBytes(bytes)}</span>
            <span class="mmtk_row_pct">${percent}%</span>
        </div>`;
    };

    let html = `<div class="mmtk_total">
        开屏一次吞下 <b>${formatBytes(bill.totalBytes)}</b>
        <div class="mmtk_hint">这是 /api/settings/get 一个请求的实际体积。每次刷新页面都要重来一遍。</div>
        <div class="mmtk_hint">${bill.source === 'server'
        ? '由服务端插件就地测量,没有额外下载。'
        : '由浏览器下载整份设置后测量,所以刚才等了那么久。装上服务端插件就不用下这一份了。'}</div>
    </div>`;

    html += `<div class="mmtk_section"><b>大头在哪</b>
        ${row(`OpenAI 预设 共 ${bill.presets.length} 个`, bill.presetsBytes, bill.totalBytes)}
        ${row('settings.json', bill.settingsBytes, bill.totalBytes)}
        ${bill.others.map(o => row(o.name, o.bytes, bill.totalBytes)).join('')}
    </div>`;

    if (topPresets.length) {
        html += `<div class="mmtk_section"><b>最占地方的预设</b>
            ${topPresets.map(p => row(p.name, p.bytes, bill.totalBytes)).join('')}
            ${bill.presets.length > topPresets.length ? `<div class="mmtk_hint">另有 ${bill.presets.length - topPresets.length} 个较小的没列出来</div>` : ''}
        </div>`;
    }

    if (topExtensions.length) {
        html += `<div class="mmtk_section"><b>settings.json 里各扩展占了多少</b>
            ${topExtensions.map(e => row(e.name, e.bytes, bill.settingsBytes)).join('')}
            <div class="mmtk_hint">百分比是相对 settings.json 而不是总量。这部分归档动不了,只能靠扩展自己瘦身。</div>
        </div>`;
    }

    // 归档区
    if (!serverPluginAvailable) {
        html += `<div class="mmtk_section mmtk_note">
            <b>想一键归档?</b>
            <div class="mmtk_hint">把不常切的预设挪进 <code>OpenAI Settings\\_归档\\</code> 子目录,它们就彻底不进开屏响应了,文件还在,随时能挪回来。
            这个动作浏览器侧做不了,需要配套的服务端插件(plugins/zhimengzhe),并在 config.yaml 里把 <code>enableServerPlugins</code> 设为 true 后重启服务。
            没装也不影响上面的体检。</div>
        </div>`;
    } else {
        const selectable = bill.presets.filter(p => p.name !== bill.activePreset);

        html += `<div class="mmtk_section">
            <b>归档(勾上要收起来的预设)</b>
            <div class="mmtk_hint">归档只是把文件挪进子目录,不删除。当前正在用的预设不给勾。</div>
            <div class="mmtk_list">`;

        if (bill.activePreset) {
            const active = bill.presets.find(p => p.name === bill.activePreset);
            html += `<label class="mmtk_item mmtk_disabled">
                <input type="checkbox" disabled>
                <span class="mmtk_row_name">${escapeHtml(bill.activePreset)}</span>
                <span class="mmtk_row_size">${active ? formatBytes(active.bytes) : ''}</span>
                <span class="mmtk_tag">当前使用中</span>
            </label>`;
        }

        html += selectable.map(p => `<label class="mmtk_item">
                <input type="checkbox" class="mmtk_pick" data-file="${escapeHtml(p.fileName)}" data-bytes="${p.bytes}">
                <span class="mmtk_row_name">${escapeHtml(p.name)}</span>
                <span class="mmtk_row_size">${formatBytes(p.bytes)}</span>
            </label>`).join('');

        html += `</div>
            <div id="mmtk_savings" class="mmtk_savings">还没勾选</div>
            <div class="mmtk_buttons">
                <div id="mmtk_archive" class="menu_button" disabled>归档选中的</div>
            </div>
        </div>`;

        if (archived.length) {
            html += `<div class="mmtk_section">
                <b>已归档 ${archived.length} 个(不占开屏)</b>
                <div class="mmtk_list">
                    ${archived.map(a => `<label class="mmtk_item">
                        <input type="checkbox" class="mmtk_restore_pick" data-file="${escapeHtml(a.name)}">
                        <span class="mmtk_row_name">${escapeHtml(a.name)}</span>
                        <span class="mmtk_row_size">${formatBytes(a.size)}</span>
                    </label>`).join('')}
                </div>
                <div class="mmtk_buttons">
                    <div id="mmtk_restore" class="menu_button">还原选中的</div>
                </div>
            </div>`;
        }
    }

    $out.html(html);
}

/** 勾选变化时实时算能省多少 */
function updateSavings() {
    if (!lastBill) return;

    const $picked = $('#mmtk_report .mmtk_pick:checked');
    const savedBytes = $picked.toArray().reduce((sum, el) => sum + Number($(el).data('bytes') || 0), 0);

    $('#mmtk_archive').attr('disabled', $picked.length ? null : 'disabled');

    if (!$picked.length) {
        $('#mmtk_savings').text('还没勾选');
        return;
    }

    const after = Math.max(0, lastBill.totalBytes - savedBytes);
    const ratio = after > 0 ? (lastBill.totalBytes / after).toFixed(1) : '∞';

    $('#mmtk_savings').html(
        `选中 <b>${$picked.length}</b> 个,共 ${formatBytes(savedBytes)}。
         归档后开屏 ${formatBytes(lastBill.totalBytes)} → <b>${formatBytes(after)}</b>(约 ${ratio} 倍)`,
    );
}

/**
 * 重新问服务端要一份账,把面板上的列表重画。
 *
 * 搬完必须重画:不然列表还是搬之前的样子,已经归档的预设仍显示在"可归档"那栏,
 * 再点一次就会撞上"源文件不存在"。这不是用户操作错,是界面没跟上。
 */
async function refreshLists() {
    if (!serverPluginAvailable) return;

    try {
        const { bill, archived } = await runCheckupViaServer();
        lastBill = bill;
        renderReport(bill, archived);
    } catch (error) {
        console.error('[织梦者] 重画列表失败', error);
    }
}

/**
 * 搬运结果统一处理:弹窗告诉结果,成功了就逼着刷新,别让人拿着旧列表继续用。
 * @param {object} result 服务端返回的 {moved, failed}
 * @param {string} action 动作名
 */
async function reportMoveResult(result, action) {
    const moved = Array.isArray(result?.moved) ? result.moved : [];
    const failed = Array.isArray(result?.failed) ? result.failed : [];

    let html = '';

    if (moved.length) {
        html += `<div class="mmtk_ok">${action}成功 ${moved.length} 个</div>
            <div class="mmtk_popup_list">${moved.map(n => escapeHtml(n)).join('<br>')}</div>`;
    }

    if (failed.length) {
        html += `<div class="mmtk_bad">${failed.length} 个没成</div>
            <div class="mmtk_popup_list">` +
            failed.map(f => `${escapeHtml(String(f.name))}<br><span class="mmtk_hint">${escapeHtml(String(f.reason))}</span>`).join('<br>') +
            '</div>';
    }

    if (!moved.length) {
        await callGenericPopup(`<div class="mmtk_popup">${html}</div>`, POPUP_TYPE.TEXT, '', { okButton: '知道了' });
        await refreshLists();
        return;
    }

    // 预设列表是开屏那一次拿的,不刷新的话内存里还是旧的,
    // 酒馆下次保存 settings 会拿旧列表盖回去。所以这里必须让人做个选择。
    html += `<hr>
        <div class="mmtk_bad"><b>必须刷新页面才生效。</b></div>
        <div>现在页面内存里还是旧的预设列表,不刷新就接着用,酒馆下次保存设置会把旧列表写回去。</div>`;

    const choice = await callGenericPopup(`<div class="mmtk_popup">${html}</div>`, POPUP_TYPE.CONFIRM, '', {
        okButton: '立即刷新页面',
        cancelButton: '稍后自己刷',
    });

    if (choice === POPUP_RESULT.AFFIRMATIVE) {
        location.reload();
        return;
    }

    // 选了稍后,那至少把面板上的列表更新到真实文件状态,别让人对着旧列表接着点
    await refreshLists();
    toastr.warning('记得刷新页面,否则改动可能被旧设置覆盖', '还没生效');
}

/**
 * @param {string} endpoint archive 或 restore
 * @param {string[]} names 文件名数组
 * @param {string} action 中文动作名
 */
async function movePresets(endpoint, names, action) {
    if (!names.length) return;

    // 搬运期间挡住重复点击,连点两下会拿着同一份旧列表再发一次请求
    if (moveInFlight) {
        toastr.info('上一次还没搬完,等一下');
        return;
    }

    moveInFlight = true;

    try {
        const response = await fetch(`${PLUGIN_BASE}/${endpoint}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ names }),
        });

        if (!response.ok) {
            throw new Error(`服务端返回 ${response.status}`);
        }

        await reportMoveResult(await response.json(), action);
    } catch (error) {
        toastr.error(String(error?.message || error), `${action}失败`);
    } finally {
        moveInFlight = false;
    }
}

async function onCheckupClick() {
    const $button = $('#mmtk_checkup');
    const started = Date.now();

    // 走浏览器那条路时可能要下十几 MB,秒数要走给人看,别让人对着不动的字干等
    const ticker = setInterval(() => {
        const seconds = Math.round((Date.now() - started) / 1000);
        $button.text(serverPluginAvailable ? `体检中 ${seconds}s` : `下载设置中 ${seconds}s`);
    }, 1000);

    $button.attr('disabled', 'disabled').text('体检中...');

    if (!serverPluginAvailable) {
        $('#mmtk_report').html('<div class="mmtk_hint">没装服务端插件,只能把整份设置下下来在浏览器里量。' +
            '设置越大等得越久,云端尤其慢,期间页面不会卡住,也不会动任何文件。</div>');
    }

    try {
        let archived = [];

        if (serverPluginAvailable) {
            const result = await runCheckupViaServer();
            lastBill = result.bill;
            archived = result.archived;
        } else {
            lastBill = await runCheckup();
            archived = await fetchArchived();
        }

        renderReport(lastBill, archived);
    } catch (error) {
        console.error('[织梦者] 体检失败', error);
        toastr.error(String(error?.message || error), '体检失败');
        $('#mmtk_report').html(`<div class="mmtk_bad">体检失败:${escapeHtml(String(error?.message || error))}</div>`);
    } finally {
        clearInterval(ticker);
        $button.removeAttr('disabled').text('开始体检');
    }
}

/* ==========================================================================
 * 模块二 自定义 CSS 输入框防抖
 *
 * 病根:public/scripts/power-user.js:3345 的 input 处理器,每敲一个字就调
 * applyCustomCSS(),而它做的是 style.innerHTML = 整份 CSS。
 * 换掉一个 style 标签的内容会让浏览器重新解析整份 CSS 并对全文档重算样式,
 * 自定义 CSS 越长越明显。顺带它还每次把内容写回 textarea,纯属多余。
 * 修法:接管这个处理器,存盘照旧,只把"应用样式"那一下防抖。
 * ========================================================================== */
function applyCssDebounceModule() {
    const applyNow = () => {
        const styleId = 'custom-style';
        let style = document.getElementById(styleId);

        if (!style) {
            style = document.createElement('style');
            style.setAttribute('type', 'text/css');
            style.setAttribute('id', styleId);
            document.head.appendChild(style);
        }

        style.innerHTML = power_user.custom_css;
    };

    // 用酒馆自己的档位而不是拍一个数:constants.js 里 relaxed 的注释就是
    // "给会触发较重任务的场合",而实测应用一次 CSS 要 643ms,是重任务。
    const applyDebounced = debounce(applyNow, debounce_timeout.relaxed);

    // 注意:这会连带摘掉别的扩展绑在同一个输入框上的 input 处理器。
    // 目前没有已知扩展这么做,但界面上要写明。
    $('#customCSS').off('input').on('input', function () {
        power_user.custom_css = String($(this).val());
        saveSettingsDebounced();
        applyDebounced();
    });
}

/* ==========================================================================
 * 模块三 预设条目开关不卡
 *
 * 病根:public/scripts/PromptManager.js:450,handleToggle 里直接调 this.render(),
 * 而 render 的默认参数 afterTryGenerate = true,意味着每点一次条目开关会:
 *   ① 跑一遍 tryGenerate() 把整个提示词上下文空转组装一次
 *   ② 重画整张条目列表
 *   ③ 重新绑定拖拽
 * 条目越多越惨,道长的预设 225 条,每点一下全走一遍。
 * 而 419 行就摆着现成的 renderDebounced,别的地方都在用,唯独这条路没用。
 * 修法:接管 handleToggle,数据照改照存,图标立刻翻给人看,重画走防抖。
 * ========================================================================== */
function applyPresetToggleModule() {
    if (!promptManager || typeof promptManager.renderDebounced !== 'function') {
        console.warn('[织梦者] 拿不到 promptManager,预设开关模块跳过');
        return false;
    }

    promptManager.handleToggle = (event) => {
        const prefix = promptManager.configuration?.prefix ?? '';
        const row = event.target.closest('.' + prefix + 'prompt_manager_prompt');

        if (!row) return;

        const promptID = row.dataset.pmIdentifier;
        const entry = promptManager.getPromptOrderEntry(promptManager.activeCharacter, promptID);

        if (!entry) return;

        const counts = promptManager.tokenHandler.getCounts();
        counts[promptID] = null;
        entry.enabled = !entry.enabled;

        // 重画被防抖推迟了,视觉状态得立刻翻,否则点下去像没反应。
        // 两处都要翻:图标,以及整行的灰化类。
        // 行上那个类见 PromptManager.js:1668:启用时为空,禁用时是
        // `${prefix}prompt_manager_prompt_disabled`。
        // 只翻图标不翻行的话,开关看着是开了但整行还是灰的,要等重画才变色,
        // 分不清到底开没开(2026-08-16 道长报的)。
        $(event.target)
            .toggleClass('fa-toggle-on', entry.enabled)
            .toggleClass('fa-toggle-off', !entry.enabled);

        row.classList.toggle(`${prefix}prompt_manager_prompt_disabled`, !entry.enabled);

        promptManager.renderDebounced();
        promptManager.saveServiceSettings();
    };

    // 监听器是重画列表时逐个 addEventListener 绑上去的,
    // 得让它重画一次,新的 handleToggle 才会真正挂到每一行上。
    // 传 false 跳过 tryGenerate,这一次重画本身很便宜。
    promptManager.render(false);
    return true;
}

/* ==========================================================================
 * 模块四 代码块
 *
 * 病根:public/script.js:2423 addCopyToCodeBlocks() 对每条消息里的每个代码块
 * 逐个跑 hljs.highlightElement(),消息越多越长越吃 CPU。
 * 修法:把 hljs.highlightElement 换成空函数。它是模块级共享对象,改了全局生效。
 * 折叠是另一件事,纯 CSS,挂在 body 上随时可开关。
 * ========================================================================== */
let originalHighlightElement = null;

function applyHighlightModule(enabled) {
    if (!hljs || typeof hljs.highlightElement !== 'function') return;

    if (enabled) {
        if (!originalHighlightElement) {
            originalHighlightElement = hljs.highlightElement;
        }
        hljs.highlightElement = () => { };
    } else if (originalHighlightElement) {
        hljs.highlightElement = originalHighlightElement;
    }
}

function applyCollapseCodeModule(enabled) {
    document.body.classList.toggle('mmtk-collapse-code', Boolean(enabled));
}

/* ==========================================================================
 * 模块五 左右滑动防误触
 *
 * 病根:酒馆用 swiped-events 库做左右滑动切 swipe,
 * 而 public/lib/swiped-events.js:49 的默认阈值只有 20 像素,
 * 手指随便蹭一下就够了,滑动看消息很容易误触重新生成。
 * 修法两道:
 *   ① 用库自己的 data-swipe-threshold 把阈值抬上去(挂在 body 上,全局生效)
 *   ② 捕获阶段加一道方向锁,横向位移不明显压过纵向就不算横滑
 * 第二道是库本身没有的,滑着看消息时手指多少会斜,只靠阈值挡不住。
 * ========================================================================== */
function swipeGuard(event) {
    const detail = event.detail || {};
    const dx = Math.abs((detail.xEnd ?? 0) - (detail.xStart ?? 0));
    const dy = Math.abs((detail.yEnd ?? 0) - (detail.yStart ?? 0));
    const threshold = getSettings().swipeThreshold;

    // 距离不够,或者纵向分量太大(在上下滚而不是左右滑)
    if (dx < threshold || dx < dy * 1.5) {
        event.stopImmediatePropagation();
    }
}

function applySwipeGuardModule(enabled) {
    document.removeEventListener('swiped-left', swipeGuard, true);
    document.removeEventListener('swiped-right', swipeGuard, true);

    if (!enabled) {
        document.body.removeAttribute('data-swipe-threshold');
        return;
    }

    document.body.setAttribute('data-swipe-threshold', String(getSettings().swipeThreshold));
    document.addEventListener('swiped-left', swipeGuard, true);
    document.addEventListener('swiped-right', swipeGuard, true);
}

/* ==========================================================================
 * 模块六 正则开关不再每次重载聊天
 *
 * 病根:public/scripts/extensions/regex/index.js:645 的 save() 调 saveRegexScript(),
 * 而它的尾巴(553-562 行)是 saveSettingsDebounced() + loadRegexScripts() +
 * **await reloadCurrentChat()**。也就是说每点一次正则开关,整个聊天重载一遍。
 * 楼层越高越慢,而且道长 2026-06-26 记过"正则重复加载增加聊天记录损坏几率",
 * 少重载一次就少一次风险。
 *
 * 只接管 GLOBAL 一类:SCOPED 和 PRESET 在存盘时还有额外记账
 * (saveScriptsByType + allowScopedScripts / allowPresetScripts,都是模块私有),
 * 复刻不了也不该复刻,原样交给酒馆自己处理。
 *
 * 手法:捕获阶段拦住 input 事件(酒馆的处理器是直接绑在复选框上的,
 * 冒泡阶段的委托来不及),自己改数据存盘,把重载攒到停手之后做一次。
 * ========================================================================== */
const reloadChatDebounced = debounce(async () => {
    if (getCurrentChatId()) {
        await reloadCurrentChat();
    }
}, debounce_timeout.relaxed);

function regexToggleGuard(event) {
    const el = event.target;

    if (!el || !el.classList || !el.classList.contains('disable_regex')) return;
    if (!el.closest('#saved_regex_scripts')) return;

    const row = el.closest('.regex-script-label') || el.parentElement?.closest('[id]');
    const script = row && extension_settings.regex?.find(s => s.id === row.id);

    // 找不到对应的脚本就别逞能,交回给酒馆原来的处理器
    if (!script) return;

    event.stopImmediatePropagation();

    script.disabled = Boolean(el.checked);
    saveSettingsDebounced();
    reloadChatDebounced();
}

function applyRegexBatchModule(enabled) {
    document.removeEventListener('input', regexToggleGuard, true);

    if (enabled) {
        document.addEventListener('input', regexToggleGuard, true);
    }
}

/* ==========================================================================
 * 给角色卡「每页数量」下拉补一个 5
 *
 * 由来(2026-08-15 道长):她要的就是酒馆自己那个「10 / 页」下拉里能直接选 5。
 * 酒馆的选项写死在 script.js:1017 的 sizeChangerOptions = [10,25,50,100,...],
 * 是核心里的局部常量,改不了;但下拉是渲染出来的 DOM,渲染完往里插一个 option 就行。
 *
 * 注意 renderPaginationDropdown(utils.js:67)只在"当前值不在列表里"时才补进去,
 * 所以光靠它,5 得先被设成当前值才会出现,鸡生蛋。这里是直接把选项摆上去。
 * 下拉的 change 由分页插件自己接,我们只加选项不碰事件。
 * ========================================================================== */
const EXTRA_PAGE_SIZE = 5;
const PAGE_SIZE_SELECT = '#rm_print_characters_pagination select.J-paginationjs-size-select';

function injectSmallPageOption() {
    const select = document.querySelector(PAGE_SIZE_SELECT);
    if (!select) return;
    if (select.querySelector(`option[value="${EXTRA_PAGE_SIZE}"]`)) return;

    const first = select.options[0];
    if (!first) return;

    const option = document.createElement('option');
    option.value = String(EXTRA_PAGE_SIZE);
    // 照抄酒馆自己那条的写法只改数字,免得语言对不上(中文界面是「10 / 页」)
    option.textContent = first.textContent.replace(/^\s*\d+/, String(EXTRA_PAGE_SIZE));
    select.insertBefore(option, first);
}

let pageSizeObserver = null;

function applySmallPageOptionModule(enabled) {
    if (pageSizeObserver) {
        pageSizeObserver.disconnect();
        pageSizeObserver = null;
    }

    if (!enabled) return;

    const container = document.getElementById('rm_print_characters_pagination');
    if (!container) return;

    // 角色列表每次重画都会把分页控件整个重建,所以要盯着它,不能只插一次。
    // 插入本身会触发一次 mutation,但上面有存在性检查,不会自己咬自己。
    pageSizeObserver = new MutationObserver(() => injectSmallPageOption());
    pageSizeObserver.observe(container, { childList: true, subtree: true });
    injectSmallPageOption();
}

/* ==========================================================================
 * 生成中继:浏览器关了也把这一条跑完
 *
 * 前端救不了这件事,因为发起请求的就是浏览器自己,它一关连接就断。
 * 所以走服务端插件:浏览器 → 插件 → 酒馆 → 模型,插件边转发边在服务器上存。
 * 浏览器断了,插件照样把上游读完,存着等它回来取。
 *
 * 服务端分不清"用户按停止"和"浏览器关了",所以这边**必须在用户主动停止时
 * 显式说一声**(/relay/cancel)。没说的一律当意外断开,继续生成。
 * ========================================================================== */
const GENERATE_URL = '/api/backends/chat-completions/generate';
const RELAY_JOB_KEY = 'mmtk_relay_job';

/** 这一轮生成的 jobId,切走再切回来要靠它去取 */
let activeJobId = null;
let recoverInFlight = false;

function newJobId() {
    // crypto.randomUUID 在 https 与 localhost 下都有;真没有就退回时间加随机
    try {
        return crypto.randomUUID();
    } catch {
        return `job-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    }
}

function rememberJob(jobId) {
    activeJobId = jobId;
    try {
        localStorage.setItem(RELAY_JOB_KEY, JSON.stringify({ jobId, at: Date.now() }));
    } catch {
        // 存不下就只是没法灾后恢复,不影响正常生成
    }
}

function forgetJob() {
    activeJobId = null;

    try {
        localStorage.removeItem(RELAY_JOB_KEY);
    } catch {
        // 忽略
    }
}

async function callRelay(action, jobId) {
    try {
        await (originalFetch || window.fetch).call(window, `${PLUGIN_BASE}/relay/${action}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ jobId }),
        });
    } catch {
        // 尽力而为
    }
}

/**
 * 把攒下的原始流里的正文抠出来。
 * 各家模型的 SSE 格式不一样,这里只做通用抽取,抽不出来就把原文给她自己看。
 * @param {string} raw
 * @returns {string}
 */
function extractTextFromStream(raw) {
    const pieces = [];

    for (const line of String(raw || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
            const json = JSON.parse(payload);
            const choice = json?.choices?.[0];
            const text = choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? json?.text;
            if (typeof text === 'string') pieces.push(text);
        } catch {
            // 不是 JSON 就跳过这一行
        }
    }

    return pieces.join('');
}

/**
 * 去服务器取一次这个 job 的状态。
 * @returns {Promise<object|null>}
 */
async function fetchJobStatus(jobId) {
    try {
        const response = await (originalFetch || window.fetch).call(window, `${PLUGIN_BASE}/relay/status`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ jobId }),
        });
        return response.ok ? await response.json() : null;
    } catch {
        return null;
    }
}

/**
 * 把服务器上跑完的内容拿回来给她看。
 *
 * 真实场景不是"关掉浏览器"(2026-08-16 道长纠正的):她在手机和 iPad 上
 * 从浏览器切去 QQ,系统把页面冻结、长连接掐掉,**切回来时页面并没有重载**,
 * 只是从冻结里醒过来。所以不能只在页面加载时取,必须在**页面重新可见**时也取。
 * (顺带:"让浏览器永远挂后台"在 iOS/Android 上做不到,那是系统级限制,
 *  网页无权拒绝冻结。服务端中继本来就是唯一可靠的解法。)
 *
 * @param {string} jobId
 * @param {boolean} wait 还没跑完时要不要等
 */
async function harvestJob(jobId, wait) {
    if (recoverInFlight) return;
    recoverInFlight = true;

    try {
        let data = await fetchJobStatus(jobId);

        // 还在生成就等一会儿,别一回来就说"没有内容"
        for (let i = 0; wait && data?.found && !data.done && i < 60; i++) {
            await delay(2000);
            data = await fetchJobStatus(jobId);
        }

        if (!data?.found || data.aborted) {
            forgetJob();
            return;
        }

        const text = extractTextFromStream(data.raw);

        if (!text.trim()) {
            if (data.done) forgetJob();
            return;
        }

        await callRelay('drop', jobId);
        forgetJob();
        await insertRecoveredMessage(text);
    } finally {
        recoverInFlight = false;
    }
}

/**
 * 把救回来的正文放回聊天记录里。
 *
 * 一开始我只弹个框让她自己复制,被她一句否掉:"酒馆没有回复窗口的话我都无法复制。"
 * 给一段没法放回去的文字等于没救,那份谨慎选错了地方。
 *
 * 两种情况分开处理,避免出现两条重复的回复:
 *   ①最后一条已经是这次被打断的 AI 回复(空的,或者是救回文本的前缀)→ 就地补全它
 *   ②否则 → 追加一条新的
 * @param {string} text
 */
async function insertRecoveredMessage(text) {
    try {
        const last = chat[chat.length - 1];
        const isInterrupted = last && !last.is_user && !last.is_system &&
            (!last.mes?.trim() || text.startsWith(last.mes.trim()));

        if (isInterrupted) {
            last.mes = text;
            updateMessageBlock(chat.length - 1, last);
        } else {
            chat.push({
                name: name2,
                is_user: false,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: text,
                extra: {},
            });
            addOneMessage(chat[chat.length - 1]);
        }

        // 必须等它落盘:不等的话看着有、退出再进就没了(2026-08-16 道长实测)
        await saveChatConditional();
        toastr.success(isInterrupted ? '断掉的那条已经补完' : '服务器跑完的那条已经放回聊天记录');
    } catch (error) {
        console.error('[织梦者] 放回聊天记录失败', error);
        // 放不回去至少别把内容弄丢,退回给她自己拿
        callGenericPopup(
            `<div class="mmtk_popup"><b>内容救回来了,但没能自动放回聊天记录</b>
            <div class="mmtk_hint">下面是原文,自己复制。</div>
            <hr><div class="mmtk_popup_list" style="max-height:50vh">${escapeHtml(text)}</div></div>`,
            POPUP_TYPE.TEXT, '', { okButton: '知道了', wide: true, large: true, allowVerticalScrolling: true });
    }
}

/** 页面重新可见时,看看有没有在冻结期间被掐断的生成 */
function watchVisibilityForRelay() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!activeJobId || !getSettings().modules.generationRelay) return;
        harvestJob(activeJobId, true);
    });
}

/** 开页面时看看上次有没有断在半路的生成 */
async function recoverUnfinishedGeneration() {
    if (!serverPluginAvailable || !getSettings().modules.generationRelay) return;

    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(RELAY_JOB_KEY) || 'null');
    } catch {
        saved = null;
    }

    if (!saved?.jobId) return;

    activeJobId = saved.jobId;
    await harvestJob(saved.jobId, false);
}

/**
 * 把一次生成请求改道到中继。
 * @returns {Promise<Response>}
 */
function relayGeneration(input, init) {
    const jobId = newJobId();
    rememberJob(jobId);

    const relayInit = {
        ...init,
        headers: { ...(init?.headers || {}), 'x-mmtk-job': jobId },
    };

    return (originalFetch || window.fetch).call(window, `${PLUGIN_BASE}/relay`, relayInit).then(
        (response) => {
            if (!response.ok) {
                // 中继起不来就退回原路,绝不能因为我这层让她生成不了
                console.warn('[织梦者] 中继不可用,退回直连');
                forgetJob();
                return (originalFetch || window.fetch).call(window, input, init);
            }

            // 正常收完就没必要在服务器上留着了
            response.clone().text().then(() => {
                callRelay('drop', jobId);
                forgetJob();
            }).catch(() => { });

            return response;
        },
        (error) => {
            // AbortError 基本就是用户按了停止:必须说一声,否则服务端会当意外断开继续烧 token
            if (error?.name === 'AbortError') {
                callRelay('cancel', jobId);
                forgetJob();
            }
            throw error;
        },
    );
}

/* ==========================================================================
 * 开局请求抢跑
 *
 * 病根:public/script.js 的 firstLoadInit 是一长串 await,一个接一个排队。
 * 结尾这三个互相之间**毫无依赖**,却排着队一个一个来:
 *     await getUserAvatars(...)   /api/avatars/get
 *     await getCharacters()       /api/characters/all
 *     await getBackgrounds()      /api/backgrounds/all
 * 在高延迟窄带宽的链路上,这是白等三趟往返。
 *
 * 我们能插手的原因:**扩展是在 initExtensions() 里加载的,那一行排在这三个之前**。
 * 所以我们醒来时它们还没发出去,可以抢先并发发掉,等酒馆排队排到,数据已经在手上。
 *
 * 这是真的变快(三趟串行变一趟并发),不是"提前解遮罩"那种让人以为变快。
 * 后者我没做:它只是把等待藏起来,总时间一点没少,不拿它冒充性能。
 * ========================================================================== */
const PREFETCH_TARGETS = [
    { url: '/api/characters/all', build: () => ({ method: 'POST', headers: getRequestHeaders(), body: '{}' }) },
    { url: '/api/backgrounds/all', build: () => ({ method: 'POST', headers: getRequestHeaders(), body: '{}' }) },
    { url: '/api/avatars/get', build: () => ({ method: 'POST', headers: getRequestHeaders({ omitContentType: true }) }) },
];

/** url -> Promise<Response>,被酒馆认领一次就删掉 */
const prefetched = new Map();

function startPrefetch() {
    const rawFetch = originalFetch || window.fetch;

    for (const target of PREFETCH_TARGETS) {
        try {
            const promise = rawFetch.call(window, target.url, target.build());
            // 先接住,别让没人 await 的失败变成 unhandledrejection
            promise.catch(() => { });
            prefetched.set(target.url, promise);
        } catch {
            // 发不出去就算了,酒馆照常自己发
        }
    }

    // 六十秒还没人来认领就丢掉,别一直占着内存
    setTimeout(() => prefetched.clear(), 60000);
}

/**
 * 酒馆自己发这三个请求时,把抢跑拿到的响应给它。
 * @returns {Promise<Response>|null} 有货就返回,没有返回 null 让它照常走
 */
function takePrefetched(url) {
    for (const key of prefetched.keys()) {
        if (!url.includes(key)) continue;

        const promise = prefetched.get(key);
        prefetched.delete(key);   // 只认领一次,之后一律走真请求

        // Response 的 body 只能读一次,必须给克隆;抢跑失败就退回真请求
        return promise.then(
            response => response.clone(),
            () => (originalFetch || window.fetch).call(window, url, { method: 'POST', headers: getRequestHeaders(), body: '{}' }),
        );
    }

    return null;
}

/* ==========================================================================
 * 保存状态条
 *
 * 由来(2026-08-16 道长):"勾回来需要等很长时间,最好是咱们替酒馆挂个状态栏,
 * 不然我都等不及,大家更等不及。"
 *
 * 病根:酒馆保存设置**全程静默**。本机快,没人察觉;云端要把整份 settings.json
 * (她这份 4.0MB)经隧道传上去,一次将近一分钟,期间界面毫无动静,
 * 人只会以为点坏了,然后去点第二下第三下,越点越糟。
 *
 * 做法:包一层 fetch,只观察不改动,把这几个又大又慢的端点显示出来。
 * 顺带这也是路线图里「保存失败本地兜底」的地基:要兜底,先得知道它失败了。
 * ========================================================================== */
const WATCHED_REQUESTS = [
    { match: '/api/settings/save', label: '保存设置' },
    { match: '/api/chats/save', label: '保存聊天' },
    { match: '/api/settings/get', label: '读取设置' },
    { match: '/api/presets/save', label: '保存预设' },
    { match: '/api/characters/edit', label: '保存角色卡' },
];

/** 最近完成的几条,给小球详情看,不再用弹窗打扰 */
const recentDone = [];
const RECENT_KEEP = 6;

/** 有过失败没被看过:小球会一直红着,直到点开详情 */
let hasUnseenFailure = false;

/** 进行中的请求:id -> {label, bytes, start} */
const inFlight = new Map();
let flightSeq = 0;
let statusTimer = null;
let originalFetch = null;

function requestUrlOf(input) {
    try {
        if (typeof input === 'string') return input;
        if (input instanceof Request) return input.url;
        if (input instanceof URL) return input.href;
    } catch {
        // 拿不到就当不认识,照常放行
    }
    return '';
}

function bodySizeOf(init) {
    const body = init?.body;
    if (typeof body === 'string') return utf8Bytes(body);
    if (body instanceof Blob) return body.size;
    return 0;
}

/** 小球在哪、详情开着没,拖动位置要记住 */
let ballDetailOpen = false;

function ensureStatusBall() {
    let ball = document.getElementById('mmtk_ball');
    if (ball) return ball;

    ball = document.createElement('div');
    ball.id = 'mmtk_ball';
    // 平时就是只蝴蝶,有东西在传的时候才转起来
    ball.innerHTML = '<span class="mmtk_ball_icon">🦋</span><span class="mmtk_ball_count"></span>';

    const pos = getSettings().statusBallPos;
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        // 记住上次拖到哪。夹一下防止窗口变小后跑到屏幕外面拿不回来
        ball.style.left = `${Math.min(Math.max(pos.left, 0), window.innerWidth - 44)}px`;
        ball.style.top = `${Math.min(Math.max(pos.top, 0), window.innerHeight - 44)}px`;
        ball.style.right = 'auto';
    }

    makeBallDraggable(ball);
    document.body.appendChild(ball);
    return ball;
}

/**
 * 让小球能拖。
 * 拖和点要分开:移动超过 4 像素才算拖,否则算点击,不然一点就容易被判成拖动。
 * 用 pointer 事件,鼠标和触屏一套代码。
 */
function makeBallDraggable(ball) {
    let dragging = false;
    let moved = false;
    let offsetX = 0;
    let offsetY = 0;

    ball.addEventListener('pointerdown', (event) => {
        dragging = true;
        moved = false;
        const rect = ball.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        ball.setPointerCapture(event.pointerId);
        event.preventDefault();
    });

    ball.addEventListener('pointermove', (event) => {
        if (!dragging) return;

        const left = event.clientX - offsetX;
        const top = event.clientY - offsetY;

        if (Math.abs(left - ball.offsetLeft) > 4 || Math.abs(top - ball.offsetTop) > 4) {
            moved = true;
        }

        ball.style.left = `${Math.min(Math.max(left, 0), window.innerWidth - ball.offsetWidth)}px`;
        ball.style.top = `${Math.min(Math.max(top, 0), window.innerHeight - ball.offsetHeight)}px`;
        ball.style.right = 'auto';
        positionBallDetail();
    });

    const endDrag = (event) => {
        if (!dragging) return;
        dragging = false;

        try {
            ball.releasePointerCapture(event.pointerId);
        } catch {
            // 指针已经没了就算了
        }

        if (moved) {
            getSettings().statusBallPos = { left: ball.offsetLeft, top: ball.offsetTop };
            saveSettingsDebounced();
            return;
        }

        // 没挪动就是点击:展开或收起详情
        ballDetailOpen = !ballDetailOpen;
        renderStatusBar();
    };

    ball.addEventListener('pointerup', endDrag);
    ball.addEventListener('pointercancel', endDrag);
}

function positionBallDetail() {
    const ball = document.getElementById('mmtk_ball');
    const detail = document.getElementById('mmtk_ball_detail');
    if (!ball || !detail) return;

    const rect = ball.getBoundingClientRect();
    detail.style.top = `${rect.bottom + 6}px`;
    // 靠右摆,但别越出左边界
    detail.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - detail.offsetWidth - 8))}px`;
}

function renderStatusBar() {
    const busy = inFlight.size;

    // 小球常驻,不再来一次消失一次:平时是只安静的蝴蝶,存东西时才转。
    // 常驻还有个好处,用户随时能把它拖到顺手的位置,不用等它冒出来才抓。
    const ball = ensureStatusBall();

    if (!busy && statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
    }
    ball.classList.toggle('mmtk_busy', Boolean(busy));
    ball.classList.toggle('mmtk_failed', hasUnseenFailure);
    ball.querySelector('.mmtk_ball_count').textContent = busy > 1 ? String(busy) : '';
    ball.title = hasUnseenFailure
        ? '有保存失败了,点一下看详情'
        : (busy ? `正在保存 ${busy} 项,点一下看详情` : '一切正常,点一下看详情,可拖动');

    let detail = document.getElementById('mmtk_ball_detail');

    if (!ballDetailOpen) {
        detail?.remove();
        return;
    }

    if (!detail) {
        detail = document.createElement('div');
        detail.id = 'mmtk_ball_detail';
        document.body.appendChild(detail);
    }

    // 打开详情就算看过了,红色可以撤掉
    if (hasUnseenFailure) {
        hasUnseenFailure = false;
        ball.classList.remove('mmtk_failed');
    }

    const rows = [...inFlight.values()].map(item => {
        const seconds = Math.round((Date.now() - item.start) / 1000);
        const size = item.bytes ? ` · ${formatBytes(item.bytes)}` : '';
        const slow = seconds >= 5 ? ' mmtk_slow' : '';
        return `<div class="mmtk_status_item${slow}">${escapeHtml(item.label)}${size} · 已用 ${seconds}s</div>`;
    });

    const history = recentDone.map(item => {
        const size = item.bytes ? ` · ${formatBytes(item.bytes)}` : '';
        const mark = item.ok ? '✓' : '✕';
        return `<div class="mmtk_status_item mmtk_done${item.ok ? '' : ' mmtk_bad'}">${mark} ${escapeHtml(item.label)}${size} · ${item.seconds}s</div>`;
    });

    detail.innerHTML =
        (rows.length
            ? `<div class="mmtk_detail_title">正在进行</div>${rows.join('')}`
            : '<div class="mmtk_detail_title">当前没有正在传的东西</div>') +
        (history.length ? `<div class="mmtk_detail_title">最近完成</div>${history.join('')}` : '') +
        '<div class="mmtk_hint">传完之前别重复点。小球可以拖到顺手的地方。</div>';

    positionBallDetail();
}

/**
 * 结束一条,并在慢请求上留个结果提示。
 * @param {number} id
 * @param {boolean} ok
 */
function finishRequest(id, ok) {
    const item = inFlight.get(id);
    inFlight.delete(id);
    renderStatusBar();

    if (!item) return;

    const seconds = Math.round((Date.now() - item.start) / 1000);

    recentDone.unshift({ label: item.label, seconds, ok, bytes: item.bytes });
    if (recentDone.length > RECENT_KEEP) recentDone.length = RECENT_KEEP;

    if (!ok) {
        // 失败不能只记在小球里就算了,那是真会丢东西的事。
        // 但也不用常驻弹窗糊在屏幕上:小球转红并一直红着,直到人点开详情看过。
        hasUnseenFailure = true;
        renderStatusBar();
        toastr.error(`${item.label}失败了,这份没存上。看右上角的蝴蝶。`, '', { timeOut: 8000 });
        return;
    }

    renderStatusBar();
    return;

}

/**
 * 把"谁在发这次保存"打到控制台。
 * 2026-08-16:她什么都没干,几秒内却连发三次保存设置,防抖本该合成一次,
 * 说明有东西绕过防抖直接调 saveSettings(),或者有循环在反复触发。
 * 排队合并挡住了症状,病根要靠这个抓。
 */
function logSaveCaller() {
    const frames = (new Error().stack || '')
        .split('\n')
        .slice(1)
        .filter(line => !line.includes('zhimengzhe'))   // 去掉我们自己的帧
        .slice(0, 5)
        .map(line => line.trim().replace(/^at\s+/, ''))
        .filter(Boolean);

    console.log('[织梦者] 谁在保存设置 ← ' + (frames.join('  ←  ') || '(拿不到调用栈)'));
}

/* ==========================================================================
 * 设置保存排队合并
 *
 * 由来(2026-08-16 实测):她什么都没干,状态小球上却挂着**五个并发的保存设置**,
 * 每个 3.16MB,最久的跑了 721 秒还没完。酒馆对保存**没有任何并发防护**,
 * 前一个没传完照样发下一个,五个一起抢同一条窄上行,互相拖到谁都传不完。
 *
 * 做法:同一时刻只放一个设置保存上路。期间来的合并成一个(只留最新那份),
 * 等在途那个结束再发。**设置保存是整份快照、后写覆盖前写,所以合并是安全的**,
 * 不会丢改动:最新那份本来就包含之前所有改动。
 * ========================================================================== */
let settingsSaveInFlight = false;
let queuedSettingsSave = null;

function runQueuedSettingsSave() {
    if (settingsSaveInFlight || !queuedSettingsSave) return;

    const job = queuedSettingsSave;
    queuedSettingsSave = null;
    settingsSaveInFlight = true;

    const id = ++flightSeq;
    inFlight.set(id, { label: '保存设置', bytes: bodySizeOf(job.init), start: Date.now() });
    if (!statusTimer) statusTimer = setInterval(renderStatusBar, 1000);
    renderStatusBar();

    originalFetch.call(window, job.input, job.init).then(
        (response) => {
            finishRequest(id, response.ok);
            settingsSaveInFlight = false;
            // 合并进来的都拿同一个响应:整份快照,后写覆盖前写,内容一致
            job.resolvers.forEach(r => r.resolve(response.clone()));
            runQueuedSettingsSave();
        },
        (error) => {
            finishRequest(id, false);
            settingsSaveInFlight = false;
            job.resolvers.forEach(r => r.reject(error));
            runQueuedSettingsSave();
        },
    );
}

/**
 * 把一次设置保存排进队列,返回一个像 fetch 一样的 Promise。
 * @returns {Promise<Response>}
 */
function enqueueSettingsSave(input, init) {
    return new Promise((resolve, reject) => {
        if (queuedSettingsSave) {
            // 已经有人在排队了:换成更新的那份,大家一起等这一次
            queuedSettingsSave.input = input;
            queuedSettingsSave.init = init;
            queuedSettingsSave.resolvers.push({ resolve, reject });
        } else {
            queuedSettingsSave = { input, init, resolvers: [{ resolve, reject }] };
        }

        runQueuedSettingsSave();
    });
}

function applySaveStatusModule(enabled) {
    if (!enabled) {
        if (originalFetch) {
            window.fetch = originalFetch;
            originalFetch = null;
        }
        inFlight.clear();
        ballDetailOpen = false;
        document.getElementById('mmtk_ball')?.remove();
        document.getElementById('mmtk_ball_detail')?.remove();
        if (statusTimer) {
            clearInterval(statusTimer);
            statusTimer = null;
        }
        return;
    }

    if (originalFetch) return;

    // 先把蝴蝶挂出来,不用等第一次保存才出现
    renderStatusBar();

    originalFetch = window.fetch;

    window.fetch = function (input, init) {
        const url = requestUrlOf(input);

        // 开局那三个:抢跑已经拿到了就直接给它,别再发一遍
        if (prefetched.size && getSettings().modules.startupPrefetch) {
            const taken = takePrefetched(url);
            if (taken) return taken;
        }

        // 生成请求改道中继,让浏览器关掉也能把这一条跑完
        if (url.includes(GENERATE_URL) && serverPluginAvailable && getSettings().modules.generationRelay) {
            return relayGeneration(input, init);
        }

        const watched = getSettings().modules.saveStatus
            ? WATCHED_REQUESTS.find(w => url.includes(w.match))
            : null;

        // 不认识的请求原样放行,一个字节都不碰
        if (!watched) {
            return originalFetch.apply(this, arguments);
        }

        if (watched.match === '/api/settings/save' && getSettings().modules.logSaveCallers) {
            logSaveCaller();
        }

        // 设置保存单独走排队合并:酒馆会并发发好几个,把窄上行活活堵死
        if (watched.match === '/api/settings/save' && getSettings().modules.saveQueue) {
            return enqueueSettingsSave(input, init);
        }

        const id = ++flightSeq;
        inFlight.set(id, { label: watched.label, bytes: bodySizeOf(init), start: Date.now() });

        if (!statusTimer) {
            statusTimer = setInterval(renderStatusBar, 1000);
        }
        renderStatusBar();

        return originalFetch.apply(this, arguments).then(
            (response) => {
                finishRequest(id, response.ok);
                return response;
            },
            (error) => {
                finishRequest(id, false);
                throw error;
            },
        );
    };
}

/* ==========================================================================
 * 扩展体积与开关
 *
 * 由来(2026-08-15 道长):"你不要因为某一项禁用的效果很小就不做,
 * 要么我们做优化干什么?一点一点积累起来不就大了。"
 *
 * 酒馆自己的扩展面板能开关,但**不告诉你每个多大**,所以没人知道该关谁。
 * 这里把体积摆出来,按大小排,让人自己挑。
 * 禁用是真省:public/scripts/extensions.js:626 附近,被禁用的扩展
 * js/css 根本不会被 fetch,只读一个 manifest.json。
 *
 * 开关只改内存里的 disabledExtensions,最后统一 saveSettings() 一次再刷新。
 * 不逐项调酒馆的 enableExtension/disableExtension:它们每次都会传整份 settings.json,
 * 道长云上 3.8MB,改 N 项传 N 次,慢到不可用(实测点一下要等近一分钟)。
 * ========================================================================== */
let extensionRows = [];

async function loadExtensionSizes() {
    const response = await fetch(`${PLUGIN_BASE}/extensions`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (!response.ok) {
        throw new Error(`服务端返回 ${response.status}`);
    }

    const data = await response.json();
    extensionRows = Array.isArray(data.extensions) ? data.extensions : [];
}

function renderExtensionList() {
    const disabled = extension_settings.disabledExtensions || [];
    const liveBytes = extensionRows
        .filter(row => !disabled.includes(row.name))
        .reduce((sum, row) => sum + row.bytes, 0);

    const rows = extensionRows.filter(row => row.bytes > 0).map(row => {
        const isOff = disabled.includes(row.name);
        const isSelf = row.name.endsWith(PLUGIN_ID);

        return `<label class="mmtk_item">
            <input type="checkbox" class="mmtk_ext_toggle" data-name="${escapeHtml(row.name)}" ${isOff ? '' : 'checked'}>
            <span class="mmtk_row_name" title="${escapeHtml(row.name)}">${escapeHtml(row.displayName)}</span>
            <span class="mmtk_row_size">${formatBytes(row.bytes)}</span>
            ${isSelf ? '<span class="mmtk_tag">本工具箱</span>' : ''}
        </label>`;
    }).join('');

    $('#mmtk_ext_out').html(`
        <div class="mmtk_total">当前启用的扩展合计 <b>${formatBytes(liveBytes)}</b>
            <div class="mmtk_hint">这是浏览器每次开页面要下载的扩展代码量。勾掉的不会被下载,只读一个几百字节的 manifest。</div>
        </div>
        <div class="mmtk_list">${rows}</div>
        <div id="mmtk_ext_delta" class="mmtk_savings">改动后会显示差额</div>
        <div class="mmtk_buttons"><div id="mmtk_ext_apply" class="menu_button" disabled>应用并刷新页面</div></div>
        <div class="mmtk_hint">开关扩展必须刷新页面才生效,这是酒馆自己的规矩,不是本工具箱的限制。</div>`);
}

/** 勾选变化时算差额,并决定应用按钮能不能点 */
function updateExtensionDelta() {
    const disabled = extension_settings.disabledExtensions || [];
    let after = 0;
    let changed = 0;

    for (const row of extensionRows) {
        const $box = $(`#mmtk_ext_out .mmtk_ext_toggle[data-name="${row.name.replace(/"/g, '\\"')}"]`);
        if (!$box.length) continue;

        const wantOn = Boolean($box.prop('checked'));
        const isOn = !disabled.includes(row.name);

        if (wantOn) after += row.bytes;
        if (wantOn !== isOn) changed++;
    }

    const before = extensionRows
        .filter(row => !disabled.includes(row.name))
        .reduce((sum, row) => sum + row.bytes, 0);

    $('#mmtk_ext_apply').attr('disabled', changed ? null : 'disabled');

    if (!changed) {
        $('#mmtk_ext_delta').text('还没有改动');
        return;
    }

    const diff = before - after;
    $('#mmtk_ext_delta').html(diff >= 0
        ? `改了 ${changed} 项,开页面要下的扩展代码 ${formatBytes(before)} → <b>${formatBytes(after)}</b>,省 ${formatBytes(diff)}`
        : `改了 ${changed} 项,开页面要下的扩展代码 ${formatBytes(before)} → <b>${formatBytes(after)}</b>,多 ${formatBytes(-diff)}`);
}

async function applyExtensionToggles() {
    const disabled = extension_settings.disabledExtensions || [];
    const todo = [];

    for (const row of extensionRows) {
        const $box = $(`#mmtk_ext_out .mmtk_ext_toggle[data-name="${row.name.replace(/"/g, '\\"')}"]`);
        if (!$box.length) continue;

        const wantOn = Boolean($box.prop('checked'));
        const isOn = !disabled.includes(row.name);
        if (wantOn !== isOn) todo.push({ name: row.name, enable: wantOn });
    }

    if (!todo.length) return;

    const off = todo.filter(x => !x.enable).length;
    const on = todo.filter(x => x.enable).length;

    const choice = await callGenericPopup(
        `<div class="mmtk_popup"><b>要关掉 ${off} 个、打开 ${on} 个扩展</b>
        <div class="mmtk_hint">改完会刷新页面。关掉的扩展只是不再加载,文件和它的设置都还在,随时能再打开。</div></div>`,
        POPUP_TYPE.CONFIRM, '', { okButton: '改并刷新', cancelButton: '算了' });

    if (choice !== POPUP_RESULT.AFFIRMATIVE) return;

    try {
        // 同样只改内存,最后统一存一次:每调一次酒馆的 enable/disable 都会传整份
        // settings.json,云上 3.8MB,改 N 项就传 N 次,慢到不可用。
        const next = new Set(extension_settings.disabledExtensions || []);
        for (const item of todo) {
            if (item.enable) next.delete(item.name);
            else next.add(item.name);
        }
        extension_settings.disabledExtensions = [...next];
        await saveSettings();
        location.reload();
    } catch (error) {
        console.error('[织梦者] 开关扩展失败', error);
        toastr.error(String(error?.message || error), '开关扩展失败');
    }
}

async function onExtensionScanClick() {
    const $button = $('#mmtk_ext_scan');
    $button.attr('disabled', 'disabled').text('读取中...');

    try {
        await loadExtensionSizes();
        renderExtensionList();
        updateExtensionDelta();
    } catch (error) {
        console.error('[织梦者] 读取扩展体积失败', error);
        $('#mmtk_ext_out').html(`<div class="mmtk_bad">读取失败:${escapeHtml(String(error?.message || error))}</div>`);
    } finally {
        $button.removeAttr('disabled').text('列出插件体积');
    }
}

/* ==========================================================================
 * 在每块扩展设置面板的标题上加一个禁用按钮
 *
 * 由来(2026-08-16 道长):"我现在就想知道那些扩展中我有什么可以关闭的,
 * 像这些官方的能在旁边加个禁用标志吗,点一下禁用,再点一下恢复?"
 *
 * 难点:面板是各扩展自己往抽屉里塞的,DOM 上没有标明归属,得反推。
 * 三招叠加认领,认不出来的**不加按钮**,宁可少给绝不给错:
 *   ① 标题里的 data-i18n 等于 manifest 的 display_name
 *   ② 用酒馆汉化表把 display_name 翻成中文,和标题可见文字比对
 *   ③ 下面这张别名表,收那些用自定义 i18n 键的内置扩展
 * ========================================================================== */
/**
 * 禁止关闭的名单(2026-08-16 道长定:"我的用户有新手")。
 * 这些关掉会让人当场失能,而且新手不知道怎么救回来:
 *   regex             整套预设都建在正则上,关了全废
 *   ST-Prompt-Template / preset-manager-momo  预设相关,她的卡的硬依赖
 *   JS-Slash-Runner   酒馆助手,她预设的硬依赖(我加的,她可否决)
 *   assets            装扩展的那块面板,关了就再也装不了扩展
 *   zhimengzhe        织梦者本体,关了这些按钮就一起没了
 * 这些面板照样显示一个锁,但点不动,鼠标悬停说明原因。
 */
const PANEL_PROTECTED = new Set([
    'regex',
    'assets',
    'ST-Prompt-Template',
    'preset-manager-momo',
    'JS-Slash-Runner',
    'zhimengzhe',
    'quick-reply',
    'QR',
]);

const PANEL_KEY_ALIASES = {
    memory: ['ext_sum_title'],
    regex: ['ext_regex_title'],
    translate: ['ext_translate_title'],
    assets: ['Download Extensions & Assets'],
    tts: ['Select TTS Provider'],
    // 汉化表里没有 Quick Replies 这条,只能写死
    'quick-reply': ['快速回复'],
};

/**
 * 把一个名字归一化到可比对的形态。
 * 面板标题上常挂着版本号徽标(如「回声工具箱 v5.2.4」)和大段空白,
 * manifest 里又常是「回声工具箱 (Echo Toolbox)」「Prompt Template/提示词模板」这种双语写法,
 * 死抠一字不差永远对不上。
 */
function normalizeName(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .replace(/v?\d+(\.\d+)+/g, '')      // 版本号
        .replace(/[（(][^）)]*[）)]/g, '')          // 括号里的副名
        .trim()
        .toLowerCase();
}

/** 收集一个标题元素上所有可用于认领的线索 */
function collectHeaderKeys(header) {
    const keys = new Set();

    for (const el of [header, ...header.querySelectorAll('[data-i18n]')]) {
        const raw = el.getAttribute?.('data-i18n');
        if (!raw) continue;
        // 可能是 "[title]Xxx" 这种带属性前缀的写法,取正文那部分
        for (const part of raw.split(';')) {
            keys.add(normalizeName(part.replace(/^\[[^\]]*\]/, '')));
        }
    }

    const text = normalizeName(header.textContent);
    if (text) keys.add(text);

    return keys;
}

/** 把一个扩展能被认出来的所有名字算出来 */
function candidateNamesFor(row) {
    const shortName = row.name.replace(/^third-party\//, '');
    const names = new Set([row.displayName, shortName]);

    for (const alias of PANEL_KEY_ALIASES[shortName] || []) {
        names.add(alias);
    }

    // 汉化表里若有对应中文,把中文也算上(面板上显示的是中文)
    try {
        const translated = window.SillyTavern?.getContext?.()?.translate?.(row.displayName);
        if (translated) names.add(translated);
    } catch {
        // 拿不到翻译就算了,还有另外两招
    }

    return [...names].filter(Boolean).map(normalizeName).filter(Boolean);
}

function injectPanelToggles() {
    if (!extensionRows.length) return;

    const disabled = extension_settings.disabledExtensions || [];
    let scanned = 0;
    let matched = 0;
    const unmatched = [];

    for (const header of document.querySelectorAll('#extensions_settings .inline-drawer-header, #extensions_settings2 .inline-drawer-header')) {
        if (header.querySelector('.mmtk_panel_toggle')) continue;
        // 织梦者自己的分类标题不是扩展,跳过,否则每次扫描都往"认不出"里刷两条
        if (header.classList.contains('mmtk_cat_header')) continue;
        scanned++;

        const keys = collectHeaderKeys(header);
        const keyList = [...keys].filter(Boolean);
        let row = extensionRows.find(r => candidateNamesFor(r).some(n => keys.has(n)));

        // 精确对不上时退一步:一方包含另一方也算,但两边都得够长,免得"qr"之类误伤
        if (!row) {
            row = extensionRows.find(r => candidateNamesFor(r).some(n =>
                n.length >= 4 && keyList.some(k => k.length >= 4 && (k.includes(n) || n.includes(k)))));
        }

        // 认不出归属就不加按钮,别给错
        if (!row) {
            unmatched.push((header.textContent || '').trim().slice(0, 24));
            continue;
        }

        const shortName = row.name.replace(/^third-party\//, '');
        const isOff = disabled.includes(row.name);
        const isLocked = PANEL_PROTECTED.has(shortName);
        const button = document.createElement('div');

        if (isLocked) {
            button.className = 'mmtk_panel_toggle mmtk_locked fa-solid fa-lock';
            button.title = `${row.displayName}:这个不能关,关了酒馆或预设会当场出问题`;
        } else {
            button.className = `mmtk_panel_toggle fa-solid ${isOff ? 'fa-toggle-off mmtk_off' : 'fa-toggle-on'}`;
            button.title = `${isOff ? '已禁用,点一下恢复' : '点一下禁用'}(${row.displayName},${formatBytes(row.bytes)})`;
            button.dataset.ext = row.name;

            button.addEventListener('click', async (event) => {
                // 别让点击顺带把这块面板折叠起来
                event.preventDefault();
                event.stopPropagation();
                console.debug('[织梦者] 点了', row.name);
                await togglePanelExtension(row.name);
            }, true);
        }

        // 插在小箭头之前,别挤到最右边去,那里容易被别的东西盖住
        const chevron = header.querySelector('.inline-drawer-icon');
        if (chevron) {
            header.insertBefore(button, chevron);
        } else {
            header.appendChild(button);
        }
        matched++;
    }

    if (scanned) {
        console.log(`[织梦者] 面板扫描:看了 ${scanned} 块,认出 ${matched} 块` +
            (unmatched.length ? `,认不出的:${unmatched.join(' / ')}` : ''));
    }
}

/**
 * 切换一个扩展的启用状态。
 *
 * **只改内存,不落盘。** 原先直接调酒馆的 enableExtension/disableExtension,
 * 它们内部会 await saveSettings(),而那是把整个 settings.json 传上去。
 * 道长云上那份 3.8MB,走隧道一次要等将近一分钟,连关五个就是五次上传。
 * 现在改成:点击即时翻图标,最后由她点一次「保存并刷新」,**只传一次**。
 * 反正改完必须刷新页面,扩展自己的 disable 钩子不跑也无所谓。
 */
function togglePanelExtension(name) {
    if (!Array.isArray(extension_settings.disabledExtensions)) {
        extension_settings.disabledExtensions = [];
    }

    const list = extension_settings.disabledExtensions;
    const wasOff = list.includes(name);

    extension_settings.disabledExtensions = wasOff
        ? list.filter(x => x !== name)
        : [...list, name];

    const nowOff = !wasOff;
    const row = extensionRows.find(r => r.name === name);
    const $button = $(`.mmtk_panel_toggle[data-ext="${name.replace(/"/g, '\\"')}"]`);

    $button
        .toggleClass('fa-toggle-off mmtk_off', nowOff)
        .toggleClass('fa-toggle-on', !nowOff)
        .attr('title', `${nowOff ? '已禁用,点一下恢复' : '点一下禁用'}(${row?.displayName ?? name})`);

    showReloadBar();
}

/** 算出内存里的禁用名单和刚进页面时相比改了几项 */
let initialDisabled = null;

function countPendingChanges() {
    const now = new Set(extension_settings.disabledExtensions || []);
    const before = initialDisabled || new Set();
    let n = 0;
    for (const x of now) if (!before.has(x)) n++;
    for (const x of before) if (!now.has(x)) n++;
    return n;
}

/** 底部常驻一条"改了几项,点这里保存并刷新"的条,别用一闪而过的提示 */
function showReloadBar() {
    const pending = countPendingChanges();
    let bar = document.getElementById('mmtk_reload_bar');

    if (!pending) {
        bar?.remove();
        return;
    }

    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'mmtk_reload_bar';
        bar.innerHTML = '<span id="mmtk_reload_text"></span>';

        const button = document.createElement('div');
        button.className = 'menu_button';
        button.id = 'mmtk_reload_btn';
        button.textContent = '保存并刷新';
        button.addEventListener('click', async () => {
            button.textContent = '保存中...';
            button.setAttribute('disabled', 'disabled');
            try {
                // 整份 settings.json 只在这里传一次
                await saveSettings();
                location.reload();
            } catch (error) {
                console.error('[织梦者] 保存失败', error);
                toastr.error(String(error?.message || error), '保存失败');
                button.textContent = '保存并刷新';
                button.removeAttribute('disabled');
            }
        });

        bar.appendChild(button);
        document.body.appendChild(bar);
    }

    $('#mmtk_reload_text').html(
        `已改 <b>${pending}</b> 项扩展开关,<b>还没保存</b>。云端设置文件大,保存要等一会儿,只传这一次。`);
}

let panelToggleObserver = null;

async function applyPanelToggleModule(enabled) {
    if (panelToggleObserver) {
        panelToggleObserver.disconnect();
        panelToggleObserver = null;
    }

    if (!enabled) {
        document.querySelectorAll('.mmtk_panel_toggle').forEach(el => el.remove());
        return;
    }

    // 需要扩展清单(名字与体积),那份只有服务端插件给得出
    if (!extensionRows.length) {
        if (!serverPluginAvailable) return;
        try {
            await loadExtensionSizes();
        } catch (error) {
            console.warn('[织梦者] 拿不到扩展清单,面板禁用按钮跳过', error);
            return;
        }
    }

    if (!initialDisabled) {
        // 快照进页面时的禁用名单,用来算改了几项
        initialDisabled = new Set(extension_settings.disabledExtensions || []);
    }

    injectPanelToggles();

    // 扩展面板是各扩展陆续塞进来的,后来的也要补上按钮
    const container = document.getElementById('extensions_settings');
    if (container) {
        panelToggleObserver = new MutationObserver(() => injectPanelToggles());
        panelToggleObserver.observe(container, { childList: true, subtree: true });
    }
}

/* ==========================================================================
 * 推荐设置
 *
 * 由来(2026-08-14 道长):角色卡列表原生就有分页,每页数量还能自己调,
 * 但她用了这么久都不知道有这个选项。**酒馆自带的旋钮藏得太深,用户根本找不到。**
 * 所以工具箱不只做优化,还要把这些旋钮翻出来摆在明处,一键调好。
 * 这些全是酒馆原生设置,我们只是替用户去改,不打任何补丁。
 * ========================================================================== */
const RECOMMENDED = [
    {
        key: 'perPage',
        name: '角色卡每页显示数量',
        recommended: 10,
        // 酒馆自己的下拉最小只给到 10,但 renderPaginationDropdown(utils.js:71)
        // 会把不在列表里的值自动插进去并排序,所以设成 5 是干净的,不用打补丁。
        options: [5, 10, 25, 50],
        why: '卡越多越明显。每页少一点,列表画得快、翻页也不卡。翻页按钮就在角色列表上方。',
        read: () => Number(accountStorage.getItem('Characters_PerPage')) || 50,
        write: async (value) => {
            accountStorage.setItem('Characters_PerPage', String(value));
            await printCharacters(true);
        },
    },
    {
        key: 'truncation',
        name: '聊天首屏加载条数',
        recommended: 30,
        options: [10, 20, 30, 50],
        why: '打开聊天时先只画这么多条,更早的用「显示更早的消息」按需加载。楼层越高省得越多。',
        read: () => Number(power_user.chat_truncation) || 100,
        write: async (value) => {
            power_user.chat_truncation = value;
            $('#chat_truncation').val(value);
            $('#chat_truncation_counter').val(value);
            saveSettingsDebounced();
        },
    },
];

/**
 * 画成一排可选的数值,当前值高亮,不是"推荐 vs 不推荐"。
 * 之前写成了按推荐值过滤,结果她当前 20,却给她「设为 50」「设为 30」两个更大的,逻辑是反的。
 * @returns {string} HTML
 */
/** 问一下服务端那几个藏得深的开关 */
async function loadServerFlags() {
    if (!serverPluginAvailable) return;

    try {
        const response = await fetch(`${PLUGIN_BASE}/config`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (response.ok) {
            serverFlags = await response.json();
        }
    } catch {
        // 拿不到就不显示这条建议,不影响别的
    }
}

/**
 * 服务端开关的建议。这些浏览器改不了,只能告诉人去哪改。
 * 目前只有一条:请求压缩。实测她云端没开时,一次保存设置要传 3.9MB、
 * 走隧道十几分钟还堆成五个并发;开了之后 935KB、10 秒。
 * 这是酒馆自带的功能,只是默认关着又藏在 config.yaml 里,没人知道。
 */
function serverAdviceHtml() {
    if (!serverFlags || serverFlags.requestCompression !== false) return '';

    return `<div class="mmtk_section mmtk_note">
        <b>建议开启请求压缩</b>
        <div class="mmtk_hint">你的服务器没开请求压缩,所以每次保存设置都在原样上传整份文件。
        本地感觉不到,<b>放在服务器上、尤其走隧道或代理时差别极大</b>(实测同一次保存 700 秒 → 10 秒)。
        这是酒馆自带的功能,不是本工具箱的东西。</div>
        <div class="mmtk_hint">改法:编辑酒馆目录下的 <code>config.yaml</code>,找到
        <code>requestCompression:</code> 那一段,把它下面的 <code>enabled: false</code> 改成
        <code>enabled: true</code>,然后<b>重启酒馆服务</b>。改错了就改回 false 再重启。</div>
    </div>`;
}

function recommendHtml() {
    return serverAdviceHtml() + RECOMMENDED.map(item => {
        const current = item.read();
        const buttons = (item.options || [item.recommended]).map(value => {
            const isCurrent = value === current;
            return `<div class="menu_button mmtk_pick_value${isCurrent ? ' mmtk_current' : ''}"
                data-key="${item.key}" data-value="${value}">${value}${isCurrent ? ' ✓' : ''}</div>`;
        }).join('');

        return `<div class="mmtk_section">
            <div><b>${escapeHtml(item.name)}</b><span class="mmtk_row_size"> 现在是 ${current}</span></div>
            <div class="mmtk_buttons">${buttons}</div>
            <div class="mmtk_hint">${escapeHtml(item.why)}</div>
        </div>`;
    }).join('');
}

/**
 * 把选值的点击接到一个容器上。面板和弹窗共用同一套。
 * @param {JQuery} $root
 */
function bindRecommend($root) {
    $root.on('click', '.mmtk_pick_value', async function () {
        const key = String($(this).data('key'));
        const value = Number($(this).data('value'));
        await applyRecommended(key, value);
        $root.html(recommendHtml());
    });
}

function renderRecommended() {
    $('#mmtk_recommend').html(recommendHtml());
}

async function applyRecommended(key, value) {
    const item = RECOMMENDED.find(x => x.key === key);
    if (!item) return;

    try {
        await item.write(value);
        toastr.success(`${item.name} 已设为 ${value}`);
        renderRecommended();
    } catch (error) {
        console.error('[织梦者] 应用推荐设置失败', error);
        toastr.error(String(error?.message || error), '设置失败');
    }
}

/**
 * 头一回装上时问一句要不要照着调。
 * 只问一次,不管答什么都记下来,别每次开页面都弹。
 */
let recommendOffered = false;

async function offerRecommendedOnce() {
    // 两条路都可能叫到这里(APP_READY 和兜底定时器),挡住重复
    if (recommendOffered) return;
    recommendOffered = true;

    const settings = getSettings();
    if (settings.recommendAsked) return;

    // 装上就弹,让用户自己挑,不再按"够不够推荐值"过滤。
    // 之前那版只在"当前值大于推荐值"时才弹,结果她两项都已经够小,一次都没弹出来过。
    const container = document.createElement('div');
    container.classList.add('mmtk_popup');
    container.innerHTML = `<b>先花十秒挑两个设置?</b>
        <div class="mmtk_hint">这两个都是<b>酒馆自带的</b>设置,只是藏得深,很多人不知道有。
        数字越小,列表和聊天开得越快。点一下立刻生效,随时能改回来,不影响任何数据。</div>
        <hr>
        <div id="mmtk_popup_recommend">${recommendHtml()}</div>`;

    bindRecommend($(container).find('#mmtk_popup_recommend'));

    await callGenericPopup(container, POPUP_TYPE.TEXT, '', { okButton: '好了', wide: true });

    // 标记设在这里,不设在前面:必须是人真的看见过,才算问过
    settings.recommendAsked = true;
    saveSettingsDebounced();

    renderRecommended();
}

/**
 * 基准测试:把被优化掉的那些操作真跑一遍计时。
 *
 * 存在的理由:性能不该让人靠"感觉"验收,机器快的人根本感觉不出来。
 * 这里量的是**每次操作省掉的那一下**到底值多少毫秒,数字自己说话。
 *
 * @returns {Promise<Array<{name: string, detail: string, ms: number, per: string}>>}
 */
async function runBenchmark() {
    const results = [];

    /** 跑若干遍取中位数,避免单次抖动 */
    const timeIt = async (fn, runs = 5) => {
        const samples = [];
        for (let i = 0; i < runs; i++) {
            const t0 = performance.now();
            await fn();
            samples.push(performance.now() - t0);
        }
        samples.sort((a, b) => a - b);
        return samples[Math.floor(samples.length / 2)];
    };

    // 一、自定义 CSS:量一次"应用整份 CSS"要多久。原本每敲一个字就来一次。
    const css = power_user.custom_css || '';
    if (css.length > 0) {
        const style = document.getElementById('custom-style');
        if (style) {
            const ms = await timeIt(() => {
                style.innerHTML = css;
                // 强制浏览器把样式算完,否则计时只量到赋值没量到重算
                void document.body.offsetHeight;
            });
            results.push({
                name: '自定义 CSS 应用一次',
                detail: `你的自定义 CSS ${formatBytes(utf8Bytes(css))}`,
                ms,
                per: '原本每敲一个字来一次,现在停手才来一次',
            });
        }
    } else {
        results.push({
            name: '自定义 CSS 应用一次',
            detail: '你现在没有自定义 CSS,所以量不出东西。CSS 越长这一项省得越多',
            ms: 0,
            per: '',
        });
    }

    // 二、预设条目列表:量一次重画要多久。原本每点一次开关就来一次,外加一遍上下文空转。
    if (promptManager && typeof promptManager.renderPromptManagerListItems === 'function') {
        const count = promptManager.getPromptsForCharacter?.(promptManager.activeCharacter)?.length
            ?? promptManager.serviceSettings?.prompts?.length
            ?? 0;

        try {
            const ms = await timeIt(async () => {
                await promptManager.renderPromptManagerListItems();
                void document.body.offsetHeight;
            }, 3);

            results.push({
                name: '预设条目列表重画一次',
                detail: `当前预设 ${count} 条条目`,
                ms,
                per: '原本每点一次条目开关来一次,还要外加一遍提示词上下文空转',
            });
        } catch (error) {
            console.warn('[织梦者] 预设列表基准跑不了', error);
        }
    }

    // 三、消息渲染:量一次 messageFormatting 要多久。
    // 它里面是 宏替换 → 跑一遍所有正则 → markdown 转 HTML → DOMPurify 消毒,
    // 其中"跑一遍所有正则"是按条数线性增长的,正则越多越贵。
    // 先量再决定要不要做渲染缓存:不慢就不做,别为了一个没人该开的开关冒风险。
    if (typeof messageFormatting === 'function' && Array.isArray(chat) && chat.length) {
        const target = [...chat].reverse().find(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.length > 50);

        if (target) {
            const index = chat.indexOf(target);
            const regexCount = (extension_settings.regex || []).filter(r => !r.disabled).length;

            try {
                const ms = await timeIt(() => {
                    messageFormatting(target.mes, target.name, false, Boolean(target.is_user), index);
                }, 7);

                results.push({
                    name: '渲染一条消息',
                    detail: `拿你最后一条正文量的,${formatBytes(utf8Bytes(target.mes))};当前启用的全局正则 ${regexCount} 条`,
                    ms,
                    per: '每条消息每次重画都要走一遍,楼层越多、正则越多越贵',
                });
            } catch (error) {
                console.warn('[织梦者] 渲染基准跑不了', error);
            }
        }
    }

    return results;
}

async function onBenchmarkClick() {
    const $button = $('#mmtk_benchmark');
    $button.attr('disabled', 'disabled').text('测量中...');

    try {
        const results = await runBenchmark();

        const html = results.map(r => `<div class="mmtk_section">
            <b>${escapeHtml(r.name)}</b>
            <div class="mmtk_total" style="margin:6px 0">${r.ms.toFixed(1)} ms</div>
            <div class="mmtk_hint">${escapeHtml(r.detail)}</div>
            ${r.per ? `<div class="mmtk_hint">${escapeHtml(r.per)}</div>` : ''}
        </div>`).join('');

        $('#mmtk_bench_out').html(html + `<div class="mmtk_hint">
            这些是<b>每一次操作</b>的耗时,不是总耗时。数字乘以你连续操作的次数,才是实际省下的。
            机器越慢、预设条目越多、自定义 CSS 越长,这些数字越大。</div>`);
    } catch (error) {
        console.error('[织梦者] 基准测试失败', error);
        $('#mmtk_bench_out').html(`<div class="mmtk_bad">测量失败:${escapeHtml(String(error?.message || error))}</div>`);
    } finally {
        $button.removeAttr('disabled').text('测一下省了多少');
    }
}

/** 按当前开关状态把各模块挂上去。只在启动时调一次。 */
function applyModules() {
    const { modules } = getSettings();

    if (modules.cssDebounce) applyCssDebounceModule();
    if (modules.presetToggleDebounce) applyPresetToggleModule();

    applyHighlightModule(modules.disableHighlight);
    applyCollapseCodeModule(modules.collapseCode);
    applySwipeGuardModule(modules.swipeGuard);
    applyRegexBatchModule(modules.regexBatch);
    applySmallPageOptionModule(modules.smallPageOption);
    applyPanelToggleModule(modules.panelToggles);
    // 抢跑要靠 fetch 包装去认领,所以两者任一开着都得装
    applySaveStatusModule(modules.saveStatus || modules.startupPrefetch || modules.generationRelay);
}

/* ==========================================================================
 * 我的插件:一键装、一键更新
 *
 * 由来(2026-08-17 道长):"织梦者其实就是一个快速替代 user 点击那个输入插件地址
 * 和安装插件的"。她社区的人进不了大社区拿不到东西,所以入口得由她自己配齐。
 *
 * 不自己写 git 逻辑:安装直接用酒馆导出的 installExtension(extensions.js:1698),
 * 连"这是第三方代码"的安全警告、成功提示、install 钩子都是酒馆自己的那一套。
 * **那个警告不要绕过**,它是对她社区新手的保护。更新走 /api/extensions/update。
 *
 * ⚠️ 坑:/api/extensions/version 对"不是 git 仓库"的目录返回的是 200 加一串空字符串,
 * 而且 isUpToDate 给的是 true(src/endpoints/extensions.js:417)。所以判断能不能更新
 * 必须看 currentCommitHash 有没有值,**不能看 isUpToDate**,否则手动放进去的文件夹
 * 会显示成"已是最新",点更新又必然失败。
 * ========================================================================== */

/** 道长自己的插件清单。加新插件就在这里加一行,别处不用动。
 *  url 留空 = 还没发布,界面显示"还没发布"而不是给一个点了必定失败的按钮。 */
const MY_PLUGINS = [
    {
        folder: 'zhimengzhe',
        name: '🦋 织梦者',
        url: 'https://github.com/DaoZhang-AI/zhimengzhe',
        desc: '你现在正在用的这个。',
    },
    {
        folder: 'zhimeng-os',
        name: '📱 织梦OS',
        url: '',
        desc: '模拟手机,能和角色在线上聊天,以后直播也挂在里面。还在做。',
    },
];

/** 装到哪:true = public/scripts/extensions/third-party,跟她现有的扩展放一起。
 *  false 会装进当前用户自己的数据目录,换个账号就看不见了。 */
const INSTALL_GLOBAL = true;

/**
 * 问酒馆现在装了哪些扩展。
 *
 * ⚠️ 键一律转成小写,因为**文件夹名是跟着用户粘贴的那个地址的大小写走的**
 * (src/endpoints/extensions.js:122 直接取地址最后一段)。GitHub 地址大小写不敏感,
 * 同一个仓库粘成 .../ZMengOS 和 .../zmengos 都打得开,但装出来的文件夹名不一样。
 * 死抠大小写的话,清单里那一项会永远显示"还没装"。
 *
 * @returns {Promise<Map<string, {folder: string, type: string}>>} 小写文件夹名 → 真实名字和类型
 */
async function fetchInstalledFolders() {
    const map = new Map();

    try {
        const response = await fetch('/api/extensions/discover');
        if (!response.ok) return map;

        const list = await response.json();
        for (const item of Array.isArray(list) ? list : []) {
            if (!String(item?.name || '').startsWith('third-party/')) continue;
            // 真实名字要留着:查版本和更新都要拿它去服务端拼路径,不能用小写那份
            const folder = String(item.name).slice('third-party/'.length);
            map.set(folder.toLowerCase(), { folder, type: item.type });
        }
    } catch (error) {
        console.warn('[织梦者] 拿不到已装扩展清单', error);
    }

    return map;
}

/**
 * 问某个已装扩展的 git 情况。
 * @returns {Promise<{hash: string, branch: string, upToDate: boolean, remote: string}|null>}
 */
async function fetchGitInfo(folder, isGlobal) {
    try {
        const response = await fetch('/api/extensions/version', {
            method: 'POST',
            headers: getRequestHeaders(),
            // 端点自己会 sanitize,给光文件夹名就行,不要带 third-party/ 前缀
            body: JSON.stringify({ extensionName: folder, global: isGlobal }),
        });

        if (!response.ok) return null;

        const data = await response.json();
        return {
            hash: String(data?.currentCommitHash || ''),
            branch: String(data?.currentBranchName || ''),
            upToDate: Boolean(data?.isUpToDate),
            remote: String(data?.remoteUrl || ''),
        };
    } catch (error) {
        console.warn('[织梦者] 拿不到 git 情况', folder, error);
        return null;
    }
}

/** 一行一个插件,状态由真数据决定,不写死 */
async function renderMyPlugins() {
    const $out = $('#mmtk_store_out');
    $out.html('<div class="mmtk_hint">正在看...</div>');

    const installed = await fetchInstalledFolders();
    const blocks = [];

    for (const item of MY_PLUGINS) {
        const hit = installed.get(item.folder.toLowerCase());
        const isInstalled = Boolean(hit);
        let status = '';
        let action = '';

        if (!isInstalled) {
            status = item.url
                ? '<span class="mmtk_hint">还没装</span>'
                : '<span class="mmtk_hint mmtk_bad">还没发布</span>';
            action = item.url
                ? `<div class="menu_button mmtk_install" data-url="${escapeHtml(item.url)}">安装</div>`
                : '';
        } else {
            const git = await fetchGitInfo(hit.folder, hit.type === 'global');

            // 这里必须看 hash,不能看 upToDate,理由见本段开头的注释
            if (!git || !git.hash) {
                status = '<span class="mmtk_hint mmtk_bad">已装,但是手动放进去的,没有 git,更新不了</span>';
            } else if (git.upToDate) {
                status = `<span class="mmtk_hint">已装 · ${escapeHtml(git.branch || '?')} · ${escapeHtml(git.hash.slice(0, 7))} · 已是最新</span>`;
                action = `<div class="menu_button mmtk_update" data-folder="${escapeHtml(hit.folder)}" data-global="${hit.type === 'global'}">还是更新一下</div>`;
            } else {
                status = `<span class="mmtk_hint">已装 · ${escapeHtml(git.branch || '?')} · ${escapeHtml(git.hash.slice(0, 7))} · <b>有新版</b></span>`;
                action = `<div class="menu_button mmtk_update" data-folder="${escapeHtml(hit.folder)}" data-global="${hit.type === 'global'}">更新</div>`;
            }
        }

        blocks.push(`
            <div class="mmtk_store_row">
                <div><b>${escapeHtml(item.name)}</b></div>
                <div class="mmtk_hint">${escapeHtml(item.desc)}</div>
                <div>${status}</div>
                ${action ? `<div class="mmtk_buttons">${action}</div>` : ''}
            </div>`);
    }

    $out.html(blocks.join(''));
}

async function onInstallClick() {
    const url = $(this).data('url');
    if (!url) return;

    // 装的整套流程用酒馆自己的:安全警告、提示、install 钩子都在里面
    const ok = await installExtension(String(url), INSTALL_GLOBAL);
    if (!ok) return;

    await callGenericPopup(
        '<div class="mmtk_popup">装好了。<br><b>要刷新一次页面</b>,新装的插件代码是开页面时才加载的。</div>',
        POPUP_TYPE.TEXT, '', { okButton: '知道了' });

    await renderMyPlugins();
}

async function onUpdateClick() {
    const folder = String($(this).data('folder') || '');
    const isGlobal = String($(this).data('global')) === 'true';
    if (!folder) return;

    const $button = $(this);
    $button.text('更新中...');

    try {
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ extensionName: folder, global: isGlobal }),
        });

        const text = await response.text();

        if (!response.ok) {
            // 把酒馆的原话给她,别自己编。手动装的、有本地改动的都会在这儿失败
            await callGenericPopup(
                `<div class="mmtk_popup"><div class="mmtk_bad">更新失败。</div>
                <div class="mmtk_hint">酒馆的原话:</div>
                <div class="mmtk_popup_list">${escapeHtml(text || response.statusText)}</div></div>`,
                POPUP_TYPE.TEXT, '', { okButton: '知道了', wide: true });
            return;
        }

        await callGenericPopup(
            '<div class="mmtk_popup">更新完了。<br><b>要刷新一次页面</b>才会跑新代码。</div>',
            POPUP_TYPE.TEXT, '', { okButton: '知道了' });
    } catch (error) {
        console.error('[织梦者] 更新失败', error);
    } finally {
        await renderMyPlugins();
    }
}

/* ==========================================================================
 * 一键入口
 *
 * 由来(2026-08-15 道长):面板埋在扩展抽屉里二十几个扩展中间,
 * **她自己都找不到,她社区的人更不可能找到**。找不到的工具等于没有。
 * 所以在输入框左边那个魔杖菜单里加一项,一点就开。
 *
 * 只保留一份 DOM:开弹窗时把面板整个搬进去,关掉再搬回 #mmtk_home。
 * 搬运用 appendChild,事件监听器跟着节点走,不会掉。
 * ========================================================================== */
async function openToolboxPopup() {
    const panel = document.getElementById('mmtk_settings');
    const home = document.getElementById('mmtk_home');

    if (!panel || !home) return;

    // 面板平时是折叠的抽屉,进了弹窗就直接摊开,别让人再点一次。
    // 认 id 不认 class:面板里现在有嵌套抽屉,querySelector 拿到的会是里层那个。
    const content = panel.querySelector('#mmtk_root_content');
    const wasVisible = content ? $(content).is(':visible') : true;
    if (content) $(content).show();

    const wrapper = document.createElement('div');
    wrapper.appendChild(panel);

    try {
        await callGenericPopup(wrapper, POPUP_TYPE.TEXT, '', {
            okButton: '关闭',
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        });
    } finally {
        // 不管怎么关掉的,面板都必须回家,否则下次就真找不着了
        home.appendChild(panel);
        if (content && !wasVisible) $(content).hide();
    }
}

function addWandMenuButton() {
    const container = document.getElementById('extensionsMenu');

    if (!container || document.getElementById('mmtk_wand_button')) return;

    const button = document.createElement('div');
    button.id = 'mmtk_wand_button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');

    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-gauge-high', 'extensionsMenuExtensionButton');

    const text = document.createElement('span');
    text.textContent = '🦋 织梦者';

    button.appendChild(icon);
    button.appendChild(text);
    button.addEventListener('click', () => openToolboxPopup());
    container.appendChild(button);
}

function renderPanel() {
    const settings = getSettings();

    const html = `
    <div id="mmtk_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>🦋 织梦者</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div id="mmtk_root_content" class="inline-drawer-content">

                <!-- 分类一:原美梦工具箱那一套。嵌套抽屉是安全的,酒馆的折叠用的是
                     closest('.inline-drawer') 加直接子选择器(script.js:12131),
                     点里层不会连带把外层折起来。 -->
                <div class="inline-drawer mmtk_cat">
                    <div class="inline-drawer-toggle inline-drawer-header mmtk_cat_header">
                        <b>⚡ 酒馆优化</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input id="mmtk_module_checkup" type="checkbox" ${settings.modules.startupCheckup ? 'checked' : ''}>
                        <span>开屏减负</span>
                    </label>
                    <div id="mmtk_checkup_block">
                        <div class="mmtk_hint">量一次酒馆开屏到底吞了多少东西,谁占的,归档能省多少。只读,不会动任何文件。</div>
                        <div class="mmtk_buttons">
                            <div id="mmtk_checkup" class="menu_button">开始体检</div>
                        </div>
                        <div id="mmtk_report"></div>
                    </div>

                    <hr>
                    <b>插件减负</b>
                    <div class="mmtk_hint">酒馆自己的扩展面板能开关,但不告诉你每个多大,所以没人知道该关谁。
                        这里按体积排出来,勾掉的扩展<b>代码根本不会被下载</b>,文件和设置都还在,随时能再打开。</div>
                    <div class="mmtk_buttons">
                        <div id="mmtk_ext_scan" class="menu_button">列出插件体积</div>
                    </div>
                    <div id="mmtk_ext_out"></div>

                    <hr>
                    <b>推荐设置</b>
                    <div class="mmtk_hint">下面这些<b>全是酒馆自带的设置</b>,工具箱只是替你把它们翻出来、点一下就改好,
                        没打任何补丁。改了随时能自己改回去,不影响任何数据。</div>
                    <div id="mmtk_recommend"></div>

                    <hr>
                    <b>卡顿优化</b>
                    <div class="mmtk_hint">每项独立开关,哪项出问题单独关掉就行,不影响别的。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_css" type="checkbox" ${settings.modules.cssDebounce ? 'checked' : ''}>
                        <span>自定义 CSS 输入框防抖</span>
                    </label>
                    <div class="mmtk_hint">原本每敲一个字就把整份 CSS 重新解析一遍并对全文档重算样式,改成停手 0.4 秒才应用。存盘不受影响。
                        <b>会接管这个输入框的输入事件</b>,如果你装了别的扩展也在动这个框,关掉本项。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_preset" type="checkbox" ${settings.modules.presetToggleDebounce ? 'checked' : ''}>
                        <span>预设条目开关不卡</span>
                    </label>
                    <div class="mmtk_hint">原本每点一次条目开关,会先把整个提示词上下文空转组装一遍,再重画整张列表,再重绑拖拽。
                        改成图标立刻翻、重画走防抖。条目越多越明显。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_hljs" type="checkbox" ${settings.modules.disableHighlight ? 'checked' : ''}>
                        <span>关闭代码高亮</span>
                    </label>
                    <div class="mmtk_hint">代码块不再逐个跑语法着色。代码照常显示照常复制,只是没有颜色。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_collapse" type="checkbox" ${settings.modules.collapseCode ? 'checked' : ''}>
                        <span>折叠长代码块</span>
                    </label>
                    <div class="mmtk_hint">代码块超过一屏就收起来,里面可以自己滚。这一项会改变你看到的样子,所以默认关。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_swipe" type="checkbox" ${settings.modules.swipeGuard ? 'checked' : ''}>
                        <span>左右滑动防误触</span>
                    </label>
                    <div class="mmtk_hint">酒馆原生只要划过 20 像素就算一次左右滑,手指蹭一下就可能触发重新生成。
                        本项把门槛抬高,并且加一道方向锁:横向划得不够明显就不算。</div>
                    <label class="mmtk_numrow">
                        <span>滑动门槛</span>
                        <input id="mmtk_swipe_threshold" class="text_pole" type="number" min="20" max="400" step="10" value="${settings.swipeThreshold}">
                        <span>像素(酒馆原生 20)</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="mmtk_module_regex" type="checkbox" ${settings.modules.regexBatch ? 'checked' : ''}>
                        <span>正则开关不再每次重载聊天</span>
                    </label>
                    <div class="mmtk_hint">原本每点一次正则开关,整个聊天要重载一遍,楼层越高越慢。
                        改成停手 1 秒后只重载一次。<b>只接管「全局正则」</b>,角色局部正则和预设正则原样交给酒馆,
                        因为那两类存盘时还有额外记账,不该由外人代劳。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_panel" type="checkbox" ${settings.modules.panelToggles ? 'checked' : ''}>
                        <span>扩展设置面板上直接加禁用按钮</span>
                    </label>
                    <div class="mmtk_hint">在「扩展」抽屉里每块设置面板的标题右边加一个开关,点一下禁用,再点一下恢复。
                        禁用的扩展代码不会被下载。认不出归属的面板不会加按钮,宁可少给也不给错。需要服务端插件。
                        <br><b class="mmtk_bad">注意:扩展一被禁用,它这块面板就不再出现,按钮也跟着没了。
                        要把它开回来,用上面的「插件减负」列表</b>(那份是服务端扫的,禁用的也在里面)。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_status" type="checkbox" ${settings.modules.saveStatus ? 'checked' : ''}>
                        <span>保存状态条</span>
                    </label>
                    <div class="mmtk_hint">酒馆保存设置是全程静默的,本机快看不出来,云端一次要传几 MB、等好几十秒,
                        界面上却毫无动静,人只会以为点坏了然后一直点。本项在底部显示正在传什么、多大、传了多久,
                        <b>并且保存失败时会明确告诉你</b>(酒馆自己在这里也是静默的)。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_queue" type="checkbox" ${settings.modules.saveQueue ? 'checked' : ''}>
                        <span>设置保存排队合并</span>
                    </label>
                    <div class="mmtk_hint">酒馆保存设置<b>没有任何并发防护</b>,前一个没传完照样发下一个。
                        实测云端出现过五个并发、每个 3MB、跑了十几分钟没完,互相抢带宽谁也传不完。
                        本项让同一时刻只有一个在路上,期间来的合并成一个。设置是整份快照、后写覆盖前写,合并不会丢改动。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_logsave" type="checkbox" ${settings.modules.logSaveCallers ? 'checked' : ''}>
                        <span>记录谁触发了保存(排查用)</span>
                    </label>
                    <div class="mmtk_hint">每次保存设置时,把调用它的那几层函数打到浏览器控制台。
                        用来抓"没人操作却疯狂保存"这类问题。查完可以关掉。</div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_prefetch" type="checkbox" ${settings.modules.startupPrefetch ? 'checked' : ''}>
                        <span>开局请求抢跑</span>
                    </label>
                    <div class="mmtk_hint">酒馆启动时,角色卡列表、背景、头像这三个请求<b>互不依赖却排着队一个一个来</b>。
                        本项在扩展加载那一刻就并发把它们发掉,酒馆排到时数据已经在手上,三趟往返变一趟。
                        网越慢、延迟越高,省得越多。<b>这是真的变快,不是把等待藏起来。</b></div>

                    <label class="checkbox_label">
                        <input id="mmtk_module_relay" type="checkbox" ${settings.modules.generationRelay ? 'checked' : ''}>
                        <span>切走也不丢这一条生成</span>
                    </label>
                    <div class="mmtk_hint">生成请求改由服务器接住。<b>手机和平板上从浏览器切去别的 App 时,
                        系统会冻结页面、掐掉连接,这一条就白生成了</b>,这是系统级限制,网页无权拒绝
                        (所谓"让浏览器挂后台"在 iOS 上做不到)。开了本项,服务器会照样把这一条跑到结束存下来,
                        <b>你切回来时自动补进聊天记录</b>(断在半路的那条就地补完,没有那条就新加一条)。
                        <br><b class="mmtk_bad">默认关,因为它在生成的关键路径上。</b>
                        出问题的表现是生成不了或卡住,关掉它再刷新即可恢复原样。需要服务端插件。
                        <br>另外:<b>你按「停止」时会通知服务器一起停</b>;但如果那一声没送到(比如直接断网),
                        服务器会当成意外断开继续跑完,<b>会多烧一点 token</b>。</div>

                    <div class="mmtk_hint mmtk_bad">关掉某一项后,建议刷新页面让它彻底还原。</div>

                    <div class="mmtk_buttons">
                        <div id="mmtk_benchmark" class="menu_button">测一下省了多少</div>
                    </div>
                    <div class="mmtk_hint">把被优化掉的那些操作真跑一遍计时,告诉你每次操作值多少毫秒。
                        机器快的人感觉不出差别,但数字是数字。</div>
                    <div id="mmtk_bench_out"></div>
                    </div>
                </div>

                <!-- 分类二:道长自己的插件,一键装和一键更新。清单是 MY_PLUGINS。 -->
                <div id="mmtk_store_drawer" class="inline-drawer mmtk_cat">
                    <div class="inline-drawer-toggle inline-drawer-header mmtk_cat_header">
                        <b>🧩 我的插件</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">
                        <div class="mmtk_hint">道长做的东西都在这里一键装、一键更新,不用自己找地址、自己解压。
                            装的是<b>酒馆自己那套安装流程</b>,该弹的第三方代码提醒照样弹。
                            <b>装完或更新完都要刷新一次页面</b>,插件代码是开页面时才加载的。</div>
                        <div class="mmtk_buttons">
                            <div id="mmtk_store_refresh" class="menu_button">看看状态</div>
                        </div>
                        <div id="mmtk_store_out"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>`;

    // 放在扩展设置最上面,不要 append 到二十几个扩展后面去。
    // #mmtk_home 是面板的家:魔杖菜单打开时会把面板整个搬进弹窗,关掉再搬回来。
    const home = $('<div id="mmtk_home"></div>');
    $('#extensions_settings').prepend(home);
    home.html(html);

    addWandMenuButton();

    // 我的插件:第一次展开才去问状态,别在面板渲染时就白发两个请求
    $('#mmtk_store_drawer').one('inline-drawer-toggle', () => renderMyPlugins());
    $('#mmtk_store_refresh').on('click', () => renderMyPlugins());
    // 委托挂在 #mmtk_store_out 上而不是 #mmtk_home:魔杖菜单会把整个面板搬进弹窗,
    // 那时面板已经不在 #mmtk_home 里面了,挂在家上的委托会失灵。
    $('#mmtk_store_out').on('click', '.mmtk_install', onInstallClick);
    $('#mmtk_store_out').on('click', '.mmtk_update', onUpdateClick);

    $('#mmtk_module_checkup').on('input', function () {
        const enabled = Boolean($(this).prop('checked'));
        getSettings().modules.startupCheckup = enabled;
        saveSettingsDebounced();
        $('#mmtk_checkup_block').toggle(enabled);
    });

    $('#mmtk_checkup').on('click', onCheckupClick);
    $('#mmtk_benchmark').on('click', onBenchmarkClick);
    $('#mmtk_ext_scan').on('click', onExtensionScanClick);
    $('#mmtk_ext_out').on('change', '.mmtk_ext_toggle', updateExtensionDelta);
    $('#mmtk_ext_out').on('click', '#mmtk_ext_apply', function () {
        if ($(this).attr('disabled')) return;
        applyExtensionToggles();
    });

    renderRecommended();
    $('#mmtk_recommend').on('click', '.mmtk_apply', function () {
        applyRecommended(String($(this).data('key')), Number($(this).data('value')));
    });

    // 报告是动态渲染的,事件委托到容器上
    $('#mmtk_report').on('change', '.mmtk_pick', updateSavings);

    $('#mmtk_report').on('click', '#mmtk_archive', function () {
        if ($(this).attr('disabled')) return;
        const names = $('#mmtk_report .mmtk_pick:checked').toArray().map(el => String($(el).data('file')));
        movePresets('archive', names, '归档');
    });

    $('#mmtk_report').on('click', '#mmtk_restore', function () {
        const names = $('#mmtk_report .mmtk_restore_pick:checked').toArray().map(el => String($(el).data('file')));
        if (!names.length) {
            toastr.info('先勾选要还原的预设');
            return;
        }
        movePresets('restore', names, '还原');
    });

    $('#mmtk_checkup_block').toggle(settings.modules.startupCheckup);

    /**
     * 把一个模块开关接上。
     * @param {string} id 复选框 id
     * @param {string} key modules 里的键
     * @param {(enabled: boolean) => void} [applyLive] 能当场生效的就传,不传就提示刷新
     */
    const bindModule = (id, key, applyLive) => {
        $(id).on('input', function () {
            const enabled = Boolean($(this).prop('checked'));
            getSettings().modules[key] = enabled;
            saveSettingsDebounced();

            if (applyLive) {
                applyLive(enabled);
                return;
            }

            // 这两项是接管了别人的处理器,关掉要刷新才能把原来的还回去
            if (enabled) {
                if (key === 'cssDebounce') applyCssDebounceModule();
                if (key === 'presetToggleDebounce') applyPresetToggleModule();
                toastr.success('已开启');
            } else {
                toastr.info('刷新页面后彻底还原', '已关闭');
            }
        });
    };

    bindModule('#mmtk_module_css', 'cssDebounce');
    bindModule('#mmtk_module_preset', 'presetToggleDebounce');
    bindModule('#mmtk_module_hljs', 'disableHighlight', applyHighlightModule);
    bindModule('#mmtk_module_collapse', 'collapseCode', applyCollapseCodeModule);
    bindModule('#mmtk_module_swipe', 'swipeGuard', applySwipeGuardModule);
    bindModule('#mmtk_module_regex', 'regexBatch', applyRegexBatchModule);
    bindModule('#mmtk_module_panel', 'panelToggles', applyPanelToggleModule);
    bindModule('#mmtk_module_status', 'saveStatus', applySaveStatusModule);
    bindModule('#mmtk_module_queue', 'saveQueue');
    bindModule('#mmtk_module_logsave', 'logSaveCallers');
    bindModule('#mmtk_module_prefetch', 'startupPrefetch');
    bindModule('#mmtk_module_relay', 'generationRelay');
    $('#mmtk_swipe_threshold').on('input', function () {
        const value = Number($(this).val());
        getSettings().swipeThreshold = value;
        saveSettingsDebounced();

        if (getSettings().modules.swipeGuard) {
            document.body.setAttribute('data-swipe-threshold', String(value));
        }
    });
}

// 抢跑要趁早,写在模块顶层而不是 jQuery ready 里:
// 此刻酒馆还卡在 initExtensions,离它发那三个请求还有一段,越早发省得越多。
// csrf token 在 firstLoadInit 一开头就拿到了,这时候用是安全的。
try {
    if (getSettings().modules.startupPrefetch) {
        startPrefetch();
    }
} catch (error) {
    console.warn('[织梦者] 抢跑没发出去,不影响酒馆自己发', error);
}

jQuery(async () => {
    getSettings();
    renderPanel();
    applyModules();

    // promptManager 要等酒馆自己 setup 完才存在,这时候可能还没轮到。
    // 启动完再补一次,补不上就是真的没有(比如根本没在用 Chat Completion)。
    if (getSettings().modules.presetToggleDebounce) {
        eventSource.once(event_types.APP_READY, () => applyPresetToggleModule());
    }

    // 头一回装上时问一句要不要照推荐值调。
    // 注册必须写在任何 await 之前:APP_READY 要是在空档里发过了,once 就永远等不到。
    // 再加一道兜底定时器,万一 APP_READY 已经发过,5 秒后照样问。两条路由 recommendOffered 挡重复。
    eventSource.once(event_types.APP_READY, () => offerRecommendedOnce());
    setTimeout(() => offerRecommendedOnce(), 5000);

    serverPluginAvailable = await probeServerPlugin();
    await loadServerFlags();
    renderRecommended();
    watchVisibilityForRelay();

    // 恢复必须等聊天真正加载完:启动早期 chat 数组随后会被酒馆整个换掉,
    // 那时候插进去只是显示了一下,退出再进就没了(2026-08-16 道长实测抓到的)。
    eventSource.once(event_types.CHAT_CHANGED, () => recoverUnfinishedGeneration());

    // 面板禁用按钮要等探到服务端插件之后才有扩展清单可用,
    // 而 applyModules() 跑在探活之前,所以这里补一次。
    if (getSettings().modules.panelToggles) {
        await applyPanelToggleModule(true);
    }
    console.log(`[织梦者] v${VERSION} 已加载。服务端插件:${serverPluginAvailable ? '在线' : '未检测到'}`);
});
