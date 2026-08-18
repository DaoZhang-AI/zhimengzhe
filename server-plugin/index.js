/**
 * 🦋 织梦者 · 服务端插件
 *
 * 只干一件事:把 OpenAI 预设文件在
 *   data/<user>/OpenAI Settings/
 * 和
 *   data/<user>/OpenAI Settings/_归档/
 * 之间搬来搬去。
 *
 * 为什么必须放在服务端:酒馆自带的 /api/presets/save 会对文件名做 sanitize,
 * 路径分隔符被吃掉,整个 presets 路由也没有 move 接口,所以浏览器扩展没有
 * 合法手段把预设挪进子目录。而 src/endpoints/settings.js 里的
 * readPresetsFromDirectory 不递归,预设一旦进了子目录就彻底不进开屏响应,
 * 这一刀是开屏体积下降的全部收益来源。
 *
 * 挂载点:/api/plugins/zhimengzhe
 * 本插件在 requireLoginMiddleware 和 CSRF 之后加载(见 src/server-main.js),
 * 所以天然受登录保护,客户端调用必须带 x-csrf-token。
 *
 * 无外部依赖,只用 node 内置模块。
 */

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ID = 'zhimengzhe';
const PLUGIN_VERSION = '0.1.0';

/** 归档子目录名。readdirSync 不递归,所以放进来的预设就不进开屏响应了。 */
const ARCHIVE_DIR_NAME = '_归档';

const info = {
    id: PLUGIN_ID,
    name: '织梦者',
    description: '酒馆开屏体检的服务端搭档,负责预设归档与还原。',
};

/**
 * 校验并规范化一个预设文件名。
 * 只接受"纯文件名 + .json",任何带路径的东西一律拒掉。
 * @param {unknown} name 客户端传来的名字
 * @returns {string|null} 合法则返回文件名,否则 null
 */
function safeFileName(name) {
    if (typeof name !== 'string') {
        return null;
    }

    const trimmed = name.trim();

    if (!trimmed || trimmed === '.' || trimmed === '..') {
        return null;
    }

    // 任何路径成分、空字节都不许出现
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
        return null;
    }

    // basename 变了说明里面藏了路径
    if (path.basename(trimmed) !== trimmed) {
        return null;
    }

    if (path.extname(trimmed).toLowerCase() !== '.json') {
        return null;
    }

    return trimmed;
}

/**
 * 把文件名解析成绝对路径,并确认它确实是 baseDir 的直接子文件。
 * safeFileName 已经挡过一轮,这里是第二道,防的是符号链接和平台差异。
 * @param {string} baseDir 基准目录
 * @param {string} fileName 已过 safeFileName 的文件名
 * @returns {string|null} 合法则返回绝对路径,否则 null
 */
function resolveDirectChild(baseDir, fileName) {
    const base = path.resolve(baseDir);
    const full = path.resolve(base, fileName);

    if (path.dirname(full) !== base) {
        return null;
    }

    return full;
}

/**
 * 取当前用户的预设目录和归档目录。
 * @param {import('express').Request} request
 * @returns {{presetDir: string, archiveDir: string}|null}
 */
function getDirectories(request) {
    const presetDir = request?.user?.directories?.openAI_Settings;

    if (typeof presetDir !== 'string' || !presetDir) {
        return null;
    }

    if (!fs.existsSync(presetDir)) {
        return null;
    }

    return {
        presetDir: path.resolve(presetDir),
        archiveDir: path.join(path.resolve(presetDir), ARCHIVE_DIR_NAME),
    };
}

/**
 * 列出一个目录下的 .json 预设(不递归)。
 * 只 stat 不读内容,所以很便宜。
 * @param {string} dir 目录
 * @returns {Array<{name: string, size: number, mtime: number}>}
 */
function listPresets(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }

    const result = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) {
            continue;
        }

        // 和 readPresetsFromDirectory 一样,只认扩展名恰为 .json 的
        if (path.extname(entry.name).toLowerCase() !== '.json') {
            continue;
        }

        try {
            const stat = fs.statSync(path.join(dir, entry.name));
            result.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs });
        } catch {
            // 读不到就跳过,不让一个坏文件毁掉整张列表
        }
    }

    return result.sort((a, b) => b.size - a.size);
}

/**
 * 搬运一批预设。重名不覆盖,逐个报结果,允许部分成功。
 * @param {string} fromDir 源目录
 * @param {string} toDir 目标目录
 * @param {unknown} names 客户端传来的名字数组
 * @returns {{moved: string[], failed: Array<{name: unknown, reason: string}>}}
 */
function movePresets(fromDir, toDir, names) {
    const moved = [];
    const failed = [];

    if (!Array.isArray(names) || names.length === 0) {
        return { moved, failed };
    }

    for (const rawName of names) {
        const fileName = safeFileName(rawName);

        if (!fileName) {
            failed.push({ name: rawName, reason: '文件名不合法,只接受不带路径的 .json' });
            continue;
        }

        const source = resolveDirectChild(fromDir, fileName);
        const target = resolveDirectChild(toDir, fileName);

        if (!source || !target) {
            failed.push({ name: fileName, reason: '路径校验未通过' });
            continue;
        }

        if (!fs.existsSync(source)) {
            failed.push({ name: fileName, reason: '源文件不存在' });
            continue;
        }

        // 重名一律不覆盖。宁可这一个失败,也不静默盖掉用户的东西。
        if (fs.existsSync(target)) {
            failed.push({ name: fileName, reason: '目标位置已有同名文件,未覆盖' });
            continue;
        }

        try {
            fs.mkdirSync(toDir, { recursive: true });
            fs.renameSync(source, target);
            moved.push(fileName);
        } catch (error) {
            failed.push({ name: fileName, reason: String(error?.message || error) });
        }
    }

    return { moved, failed };
}

/**
 * 就地量一个目录:每个 .json 文件多大,以及塞进 JSON 响应后实际会占多少字节。
 *
 * 为什么要分两个数:预设原文是被整个塞进一个 JSON 字符串发给浏览器的,
 * 里面每个引号会变成 \" 、每个换行变成 \n,所以上线字节比文件本身大几个百分点。
 * 这里逐个算准,不用估的。
 *
 * @param {string} dir 目录
 * @returns {{files: Array<{name: string, size: number, onWire: number}>, size: number, onWire: number}}
 */
function measureDirectory(dir) {
    const files = [];
    let size = 0;
    let onWire = 0;

    // 用户目录里偶尔会有拿不到的项,给个非字符串进来不该让整张账单崩掉
    if (typeof dir !== 'string' || !dir || !fs.existsSync(dir)) {
        return { files, size, onWire };
    }

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') {
            continue;
        }

        try {
            const raw = fs.readFileSync(path.join(dir, entry.name), 'utf8');
            const rawBytes = Buffer.byteLength(raw, 'utf8');
            const wireBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');

            files.push({ name: entry.name, size: rawBytes, onWire: wireBytes });
            size += rawBytes;
            onWire += wireBytes;
        } catch {
            // 单个文件读不了不该毁掉整张账单
        }
    }

    files.sort((a, b) => b.size - a.size);
    return { files, size, onWire };
}

/**
 * 量一个用户目录下所有 .json 的总字节(用于 themes / quickreplies 这些零碎)。
 * @param {string} dir
 * @returns {number}
 */
function measureDirectorySize(dir) {
    return measureDirectory(dir).size;
}

/**
 * 读 config.yaml 里几个对速度影响很大、但藏得很深的开关。
 *
 * 为什么值得单独读:2026-08-16 实测道长云端 `requestCompression.enabled: false`,
 * 于是每次保存设置都原样上传 3.9MB,走隧道要十几分钟,还会堆成五个并发。
 * 开了之后 3.9MB → 935KB,同一次保存从 700 秒降到 10 秒。
 * 这是酒馆自带的功能,只是默认关着又没人知道。浏览器改不了也看不到,只能服务端报。
 *
 * 不用 yaml 库(插件坚持零依赖),只做最朴素的段内查找。
 * @returns {{requestCompression: boolean|null}}
 */
function readServerConfigFlags() {
    const result = { requestCompression: null };

    try {
        const configPath = path.join(__dirname, '..', '..', 'config.yaml');
        if (!fs.existsSync(configPath)) return result;

        const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/);
        const start = lines.findIndex(line => /^\s*requestCompression\s*:/.test(line));
        if (start < 0) return result;

        const baseIndent = lines[start].search(/\S/);

        for (let i = start + 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            // 缩进回到同级或更外层,说明这一段结束了
            if (line.search(/\S/) <= baseIndent) break;

            const m = line.match(/^\s*enabled\s*:\s*(true|false)\s*$/);
            if (m) {
                result.requestCompression = m[1] === 'true';
                break;
            }
        }
    } catch {
        // 读不到就当不知道,不要影响整张账单
    }

    return result;
}

/* ==========================================================================
 * 生成中继:浏览器关了也把这一条生成跑完
 *
 * 现在的链路是 浏览器 → 酒馆服务端 → 模型,酒馆把模型吐的字流式转发回浏览器。
 * 浏览器一关,这条流断了,这一条就白生成了。**前端再怎么优化都救不回来**,
 * 因为发起请求的就是浏览器自己。
 *
 * 改成 浏览器 → 本插件 → 酒馆服务端 → 模型:插件在服务器上接住整个生成,
 * 边转发边把字存在内存里。浏览器断了,插件**照样把上游读完**,存着等它回来取。
 *
 * 一个绕不开的分歧:服务端分不清"用户按了停止"和"浏览器关了",两者都是客户端断开。
 * 所以约定:用户主动停止时,客户端要显式调 /relay/cancel 说一声。
 * 没说就当意外断开,继续生成并存下来。**代价是万一那一声没送到,会多烧一点 token。**
 * ========================================================================== */
const http = require('node:http');

/** jobId -> {chunks, done, error, aborted, at} */
const relayJobs = new Map();
const RELAY_TTL_MS = 15 * 60 * 1000;
const RELAY_TARGET = '/api/backends/chat-completions/generate';

/** 从 config.yaml 读端口,转发要用 */
function readServerPort() {
    try {
        const configPath = path.join(__dirname, '..', '..', 'config.yaml');
        const text = fs.readFileSync(configPath, 'utf8');
        const m = text.match(/^\s*port\s*:\s*(\d+)\s*$/m);
        if (m) return Number(m[1]);
    } catch {
        // 读不到就用酒馆默认端口
    }
    return 8000;
}

function sweepRelayJobs() {
    const now = Date.now();
    for (const [id, job] of relayJobs) {
        if (now - job.at > RELAY_TTL_MS) relayJobs.delete(id);
    }
}

/**
 * 起一次中继。
 * @param {string} jobId
 * @param {object} payload 原样转发给酒馆的请求体
 * @param {object} headers 需要带上的鉴权头(cookie 与 csrf)
 * @param {import('express').Response} clientResponse 客户端那条连接,可能中途断掉
 */
function startRelay(jobId, payload, headers, clientResponse) {
    const job = { chunks: [], done: false, error: null, aborted: false, at: Date.now(), upstream: null };
    relayJobs.set(jobId, job);

    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    const upstream = http.request({
        host: '127.0.0.1',
        port: readServerPort(),
        path: RELAY_TARGET,
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'content-length': body.length,
            // 原样带上鉴权:插件路由在登录与 CSRF 之后,这些头是可信的
            ...(headers.cookie ? { cookie: headers.cookie } : {}),
            ...(headers['x-csrf-token'] ? { 'x-csrf-token': headers['x-csrf-token'] } : {}),
        },
    }, (upstreamResponse) => {
        // 头原样透传,客户端才知道这是不是流
        if (!clientResponse.headersSent) {
            const passthrough = {};
            for (const key of ['content-type', 'cache-control']) {
                if (upstreamResponse.headers[key]) passthrough[key] = upstreamResponse.headers[key];
            }
            clientResponse.writeHead(upstreamResponse.statusCode || 200, passthrough);
        }

        upstreamResponse.on('data', (chunk) => {
            // 无论客户端还在不在,都先存下来
            job.chunks.push(chunk);
            job.at = Date.now();
            if (!clientResponse.writableEnded) {
                try {
                    clientResponse.write(chunk);
                } catch {
                    // 客户端已经走了,继续读上游就好
                }
            }
        });

        upstreamResponse.on('end', () => {
            job.done = true;
            job.at = Date.now();
            if (!clientResponse.writableEnded) clientResponse.end();
        });
    });

    upstream.on('error', (error) => {
        job.error = String(error?.message || error);
        job.done = true;
        job.at = Date.now();
        if (!clientResponse.headersSent) {
            clientResponse.status(502).json({ error: job.error });
        } else if (!clientResponse.writableEnded) {
            clientResponse.end();
        }
    });

    job.upstream = upstream;
    upstream.write(body);
    upstream.end();

    // 客户端断了不动上游:这正是本模块存在的意义。
    // 只有客户端明确调 /relay/cancel 才会真的掐掉。
    clientResponse.on('close', () => {
        if (!job.done) {
            console.log(`[${PLUGIN_ID}] 客户端断开,继续把这一条生成跑完 (job ${jobId})`);
        }
    });
}

/**
 * 注册路由。
 * @param {import('express').Router} router
 */
async function init(router) {
    // 扩展靠这个探活:探到了才显示归档按钮,探不到就只出体检报告。
    router.get('/ping', (_request, response) => {
        response.json({ ok: true, id: PLUGIN_ID, version: PLUGIN_VERSION });
    });

    // 生成中继:客户端把生成请求发到这里,由服务器接住
    router.post('/relay', (request, response) => {
        sweepRelayJobs();

        const jobId = String(request.headers['x-mmtk-job'] || '').trim();

        if (!/^[a-z0-9-]{8,64}$/i.test(jobId)) {
            return response.status(400).json({ error: 'jobId 不合法' });
        }

        if (relayJobs.has(jobId)) {
            return response.status(409).json({ error: 'jobId 重复' });
        }

        startRelay(jobId, request.body ?? {}, request.headers, response);
    });

    // 浏览器回来取存下的东西
    router.post('/relay/status', (request, response) => {
        sweepRelayJobs();

        const job = relayJobs.get(String(request.body?.jobId || ''));

        if (!job) {
            return response.json({ found: false });
        }

        response.json({
            found: true,
            done: job.done,
            error: job.error,
            aborted: job.aborted,
            // 原样把攒下的流给回去,解析交给客户端,服务端不猜格式
            raw: Buffer.concat(job.chunks).toString('utf8'),
        });
    });

    // 用户主动按了停止才会走这里。没走这里的断开一律当意外,继续生成。
    router.post('/relay/cancel', (request, response) => {
        const job = relayJobs.get(String(request.body?.jobId || ''));

        if (!job) {
            return response.json({ ok: false });
        }

        job.aborted = true;
        job.done = true;

        try {
            job.upstream?.destroy();
        } catch {
            // 已经结束了就无所谓
        }

        response.json({ ok: true });
    });

    // 取完就扔,别让内存里攒着聊天内容
    router.post('/relay/drop', (request, response) => {
        relayJobs.delete(String(request.body?.jobId || ''));
        response.json({ ok: true });
    });

    // 极轻的一条:只报服务端那几个藏得深的开关,不读任何预设
    router.post('/config', (_request, response) => {
        response.json(readServerConfigFlags());
    });

    router.post('/list', (request, response) => {
        const dirs = getDirectories(request);

        if (!dirs) {
            return response.status(500).json({ error: '找不到当前用户的 OpenAI Settings 目录' });
        }

        response.json({
            archiveDirName: ARCHIVE_DIR_NAME,
            active: listPresets(dirs.presetDir),
            archived: listPresets(dirs.archiveDir),
        });
    });

    /**
     * 就地体检。
     *
     * 存在的理由:浏览器侧体检要把整份 /api/settings/get 再下一遍,
     * 本机走内存无所谓,云端那就是十几 MB 真的过一遍隧道,
     * 等于工具自己成了它要治的那个病。所以账在文件旁边算,只把数字发回去。
     */
    router.post('/bill', (request, response) => {
        const dirs = getDirectories(request);

        if (!dirs) {
            return response.status(500).json({ error: '找不到当前用户的 OpenAI Settings 目录' });
        }

        const userDirs = request.user.directories;
        const presets = measureDirectory(dirs.presetDir);
        const archived = measureDirectory(dirs.archiveDir);

        // settings.json 本体,并按 extension_settings.<扩展名> 拆开
        let settingsBytes = 0;
        let settingsOnWire = 0;
        const extensionBreakdown = [];

        try {
            const settingsPath = path.join(userDirs.root, 'settings.json');
            const rawSettings = fs.readFileSync(settingsPath, 'utf8');
            settingsBytes = Buffer.byteLength(rawSettings, 'utf8');
            settingsOnWire = Buffer.byteLength(JSON.stringify(rawSettings), 'utf8');

            const extSettings = JSON.parse(rawSettings)?.extension_settings;

            if (extSettings && typeof extSettings === 'object') {
                for (const [key, value] of Object.entries(extSettings)) {
                    extensionBreakdown.push({
                        name: key,
                        bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'),
                    });
                }
                extensionBreakdown.sort((a, b) => b.bytes - a.bytes);
            }
        } catch {
            // settings.json 读不了或解析不了就不拆,别让整张账单挂掉
        }

        // 其余各类,开屏时也是整块塞进同一个响应的
        const others = [
            { name: '主题 themes', bytes: measureDirectorySize(userDirs.themes) },
            { name: '快速回复 quickReplyPresets', bytes: measureDirectorySize(userDirs.quickreplies) },
            { name: 'NovelAI 预设', bytes: measureDirectorySize(userDirs.novelAI_Settings) },
            { name: 'TextGen 预设', bytes: measureDirectorySize(userDirs.textGen_Settings) },
            { name: 'Kobold 预设', bytes: measureDirectorySize(userDirs.koboldAI_Settings) },
            { name: '指令模板 instruct', bytes: measureDirectorySize(userDirs.instruct) },
            { name: '上下文模板 context', bytes: measureDirectorySize(userDirs.context) },
            { name: '系统提示 sysprompt', bytes: measureDirectorySize(userDirs.sysprompt) },
            { name: '推理模板 reasoning', bytes: measureDirectorySize(userDirs.reasoning) },
            { name: 'MovingUI 预设', bytes: measureDirectorySize(userDirs.movingUI) },
        ].filter(x => x.bytes > 0);

        const othersBytes = others.reduce((sum, x) => sum + x.bytes, 0);

        response.json({
            // 服务端才知道的开关,浏览器看不到,但对速度影响极大
            serverConfig: readServerConfigFlags(),
            // 上线总量:预设 + settings.json + 零碎,都按塞进 JSON 之后的字节算
            totalBytes: presets.onWire + settingsOnWire + othersBytes,
            presetsBytes: presets.size,
            settingsBytes,
            presets: presets.files,
            archived: archived.files,
            extensionBreakdown,
            others: others.sort((a, b) => b.bytes - a.bytes),
        });
    });

    /**
     * 扩展体积清单。
     *
     * 浏览器 stat 不了文件,只能服务端给。量的是**浏览器真正会下载的那部分**:
     * manifest 里 js / css 指到的文件。禁用的扩展这两个文件根本不会被 fetch
     * (public/scripts/extensions.js:626 附近),所以关掉一个就等于省掉它这份体积。
     *
     * 扩展分三类:system 与 global 在 public/scripts/extensions/(后者在 third-party/ 下),
     * local 在每用户的 data/<user>/extensions/。三类都要扫,只扫前者会漏掉一半。
     */
    router.post('/extensions', (request, response) => {
        const rows = [];

        /** 读一个扩展目录,把 manifest 里 js/css 的字节数加起来 */
        const measureExtension = (dir, name) => {
            const manifestPath = path.join(dir, 'manifest.json');

            if (!fs.existsSync(manifestPath)) return;

            let manifest;
            try {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            } catch {
                return;
            }

            let bytes = 0;

            for (const key of ['js', 'css']) {
                if (typeof manifest[key] !== 'string') continue;
                // 字段可能带 ?v=x.y.z 这种破缓存的查询串,取文件名时要去掉
                const fileName = manifest[key].split('?')[0];
                const filePath = path.join(dir, fileName);
                try {
                    if (fs.existsSync(filePath)) bytes += fs.statSync(filePath).size;
                } catch {
                    // 单个文件读不到不该毁掉整张清单
                }
            }

            rows.push({
                name,
                displayName: typeof manifest.display_name === 'string' ? manifest.display_name : name,
                bytes,
            });
        };

        const scanDirectory = (base, prefix, recurseThirdParty) => {
            if (typeof base !== 'string' || !base || !fs.existsSync(base)) return;

            for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;

                const dir = path.join(base, entry.name);

                if (recurseThirdParty && entry.name === 'third-party') {
                    scanDirectory(dir, 'third-party/', false);
                    continue;
                }

                measureExtension(dir, prefix + entry.name);
            }
        };

        // 内置与全局第三方
        const publicExtensions = path.join(__dirname, '..', '..', 'public', 'scripts', 'extensions');
        scanDirectory(publicExtensions, '', true);
        // 每用户的本地扩展,URL 上也挂在 third-party/ 下
        scanDirectory(request?.user?.directories?.extensions, 'third-party/', false);

        rows.sort((a, b) => b.bytes - a.bytes);
        response.json({ extensions: rows });
    });

    router.post('/archive', (request, response) => {
        const dirs = getDirectories(request);

        if (!dirs) {
            return response.status(500).json({ error: '找不到当前用户的 OpenAI Settings 目录' });
        }

        const result = movePresets(dirs.presetDir, dirs.archiveDir, request.body?.names);
        response.json(result);
    });

    router.post('/restore', (request, response) => {
        const dirs = getDirectories(request);

        if (!dirs) {
            return response.status(500).json({ error: '找不到当前用户的 OpenAI Settings 目录' });
        }

        const result = movePresets(dirs.archiveDir, dirs.presetDir, request.body?.names);
        response.json(result);
    });

    console.log(`[${PLUGIN_ID}] 织梦者服务端插件已加载 v${PLUGIN_VERSION}`);
}

module.exports = { info, init };
