'use strict';

const path = require('path');

const CORE_CURSOR_ROLES = Object.freeze([
    'arrow',
    'help',
    'appstarting',
    'wait',
    'crosshair',
    'text',
    'handwriting',
    'unavailable',
    'vertical',
    'horizontal',
    'diagonal1',
    'diagonal2',
    'move',
    'alternate',
    'link'
]);

const OPTIONAL_CURSOR_ROLES = Object.freeze(['pin', 'person']);
const ALL_CURSOR_ROLES = Object.freeze([...CORE_CURSOR_ROLES, ...OPTIONAL_CURSOR_ROLES]);
const CURSOR_ROLE_SET = new Set(ALL_CURSOR_ROLES);

const WINDOWS_CURSOR_FIELDS = Object.freeze({
    arrow: 'Arrow',
    help: 'Help',
    appstarting: 'AppStarting',
    wait: 'Wait',
    crosshair: 'Crosshair',
    text: 'IBeam',
    handwriting: 'NWPen',
    unavailable: 'No',
    vertical: 'SizeNS',
    horizontal: 'SizeWE',
    diagonal1: 'SizeNWSE',
    diagonal2: 'SizeNESW',
    move: 'SizeAll',
    alternate: 'UpArrow',
    link: 'Hand',
    pin: 'Pin',
    person: 'Person'
});

const CENTER_HOTSPOT_ROLES = new Set([
    'wait',
    'crosshair',
    'text',
    'unavailable',
    'vertical',
    'horizontal',
    'diagonal1',
    'diagonal2',
    'move'
]);

const DEFAULT_HOTSPOTS = Object.freeze({
    arrow: [3, 2],
    help: [3, 2],
    appstarting: [3, 2],
    handwriting: [5, 58],
    alternate: [3, 2],
    link: [20, 5],
    pin: [32, 60],
    person: [32, 32]
});

const DEFAULT_CURSOR_SIZES = Object.freeze([32, 48, 64]);
const MAX_ZIP_ENTRIES = 512;
const MAX_ZIP_BYTES = 128 * 1024 * 1024;

function assertBuffer(value, fieldName) {
    if (!Buffer.isBuffer(value)) {
        throw new TypeError(`${fieldName} 必须是 Buffer。`);
    }
}

function assertUInt16(value, fieldName) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
        throw new RangeError(`${fieldName} 必须是 0-65535 的整数。`);
    }
}

function sanitizeThemeName(value) {
    const name = String(value || 'VCP Cursor Theme')
        .replace(/[\x00-\x1f<>:"/\\|?*]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64);
    return name || 'VCP Cursor Theme';
}

function sanitizePackageStem(value) {
    const stem = sanitizeThemeName(value)
        .replace(/[^\p{L}\p{N}._-]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);
    return stem || 'vcp-cursor-theme';
}

function normalizeZipPath(value) {
    const normalized = String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
    const segments = normalized.split('/');
    if (
        !normalized ||
        normalized.includes('\0') ||
        segments.some(segment => !segment || segment === '.' || segment === '..')
    ) {
        throw new Error(`ZIP 条目路径无效: ${value}`);
    }
    return normalized;
}

function parseViewBox(value) {
    const parts = Array.isArray(value)
        ? value.map(Number)
        : String(value || '').trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isFinite(part))) {
        throw new Error('viewBox 必须包含四个有限数字。');
    }
    const [minX, minY, width, height] = parts;
    if (width <= 0 || height <= 0) {
        throw new Error('viewBox 的宽高必须大于 0。');
    }
    return { minX, minY, width, height };
}

function parseHotspot(value, role, viewBoxValue) {
    const viewBox = parseViewBox(viewBoxValue);
    let coordinates;

    if (value === undefined || value === null || String(value).trim() === '') {
        if (CENTER_HOTSPOT_ROLES.has(role)) {
            coordinates = [
                viewBox.minX + viewBox.width / 2,
                viewBox.minY + viewBox.height / 2
            ];
        } else {
            coordinates = DEFAULT_HOTSPOTS[role] || [viewBox.minX, viewBox.minY];
        }
    } else {
        coordinates = Array.isArray(value)
            ? value.map(Number)
            : String(value).trim().split(/[\s,]+/).map(Number);
    }

    if (coordinates.length !== 2 || coordinates.some(item => !Number.isFinite(item))) {
        throw new Error(`角色 ${role} 的热点必须是两个有限数字。`);
    }

    const [x, y] = coordinates;
    if (
        x < viewBox.minX ||
        y < viewBox.minY ||
        x > viewBox.minX + viewBox.width ||
        y > viewBox.minY + viewBox.height
    ) {
        throw new Error(`角色 ${role} 的热点不在 viewBox 范围内。`);
    }

    return { x, y, viewBox };
}

function scaleHotspot(hotspot, outputWidth, outputHeight = outputWidth) {
    const { x, y, viewBox } = hotspot;
    const scaledX = Math.round((x - viewBox.minX) / viewBox.width * (outputWidth - 1));
    const scaledY = Math.round((y - viewBox.minY) / viewBox.height * (outputHeight - 1));
    return {
        x: Math.max(0, Math.min(outputWidth - 1, scaledX)),
        y: Math.max(0, Math.min(outputHeight - 1, scaledY))
    };
}

function validateCursorRoles(roles) {
    if (!Array.isArray(roles)) throw new Error('光标角色声明必须是数组。');

    const counts = new Map();
    const errors = [];
    for (const rawRole of roles) {
        const role = String(rawRole || '').trim().toLowerCase();
        if (!CURSOR_ROLE_SET.has(role)) {
            errors.push(`未知角色: ${role || '(空)'}`);
            continue;
        }
        counts.set(role, (counts.get(role) || 0) + 1);
    }

    for (const role of CORE_CURSOR_ROLES) {
        const count = counts.get(role) || 0;
        if (count === 0) errors.push(`缺少核心角色: ${role}`);
        if (count > 1) errors.push(`核心角色重复 ${count} 次: ${role}`);
    }
    for (const role of OPTIONAL_CURSOR_ROLES) {
        const count = counts.get(role) || 0;
        if (count > 1) errors.push(`扩展角色重复 ${count} 次: ${role}`);
    }

    if (errors.length > 0) {
        const error = new Error(`光标角色结构校验失败:\n- ${errors.join('\n- ')}`);
        error.validationErrors = errors;
        throw error;
    }

    return {
        roles: ALL_CURSOR_ROLES.filter(role => counts.has(role)),
        missingOptionalRoles: OPTIONAL_CURSOR_ROLES.filter(role => !counts.has(role))
    };
}

function encodeCur(images) {
    if (!Array.isArray(images) || images.length === 0) {
        throw new Error('CUR 至少需要一张 PNG 图像。');
    }
    if (images.length > 0xffff) throw new Error('CUR 图像数量超过 65535。');

    const normalized = images.map((image, index) => {
        assertBuffer(image.png, `images[${index}].png`);
        const width = Number(image.width);
        const height = Number(image.height);
        if (
            !Number.isInteger(width) ||
            !Number.isInteger(height) ||
            width < 1 ||
            height < 1 ||
            width > 256 ||
            height > 256
        ) {
            throw new Error(`CUR 图像 ${index + 1} 的宽高必须为 1-256 整数。`);
        }
        assertUInt16(image.hotspotX, `images[${index}].hotspotX`);
        assertUInt16(image.hotspotY, `images[${index}].hotspotY`);
        if (image.hotspotX >= width || image.hotspotY >= height) {
            throw new Error(`CUR 图像 ${index + 1} 的热点超出图像范围。`);
        }
        if (
            image.png.length < 8 ||
            image.png.readUInt32BE(0) !== 0x89504e47 ||
            image.png.readUInt32BE(4) !== 0x0d0a1a0a
        ) {
            throw new Error(`CUR 图像 ${index + 1} 不是有效的 PNG 数据。`);
        }
        return { ...image, width, height };
    });

    const headerSize = 6;
    const directoryEntrySize = 16;
    let dataOffset = headerSize + normalized.length * directoryEntrySize;
    const header = Buffer.alloc(dataOffset);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(2, 2);
    header.writeUInt16LE(normalized.length, 4);

    normalized.forEach((image, index) => {
        const offset = headerSize + index * directoryEntrySize;
        header.writeUInt8(image.width === 256 ? 0 : image.width, offset);
        header.writeUInt8(image.height === 256 ? 0 : image.height, offset + 1);
        header.writeUInt8(0, offset + 2);
        header.writeUInt8(0, offset + 3);
        header.writeUInt16LE(image.hotspotX, offset + 4);
        header.writeUInt16LE(image.hotspotY, offset + 6);
        header.writeUInt32LE(image.png.length, offset + 8);
        header.writeUInt32LE(dataOffset, offset + 12);
        dataOffset += image.png.length;
    });

    return Buffer.concat([header, ...normalized.map(image => image.png)], dataOffset);
}

function makeRiffChunk(id, data) {
    if (!/^[\x20-\x7e]{4}$/.test(id)) throw new Error(`RIFF chunk id 无效: ${id}`);
    assertBuffer(data, `RIFF ${id} data`);
    const padding = data.length % 2;
    const chunk = Buffer.alloc(8 + data.length + padding);
    chunk.write(id, 0, 4, 'ascii');
    chunk.writeUInt32LE(data.length, 4);
    data.copy(chunk, 8);
    return chunk;
}

function encodeAni(frames, options = {}) {
    if (!Array.isArray(frames) || frames.length < 2) {
        throw new Error('ANI 至少需要两个 CUR 帧。');
    }
    if (frames.length > 0xffff) throw new Error('ANI 帧数超过 65535。');
    frames.forEach((frame, index) => assertBuffer(frame, `frames[${index}]`));

    const jiffies = Number(options.jiffies);
    if (!Number.isInteger(jiffies) || jiffies < 1 || jiffies > 0xffffffff) {
        throw new Error('ANI jiffies 必须是正整数。');
    }

    const anih = Buffer.alloc(36);
    anih.writeUInt32LE(36, 0);
    anih.writeUInt32LE(frames.length, 4);
    anih.writeUInt32LE(frames.length, 8);
    anih.writeUInt32LE(0, 12);
    anih.writeUInt32LE(0, 16);
    anih.writeUInt32LE(0, 20);
    anih.writeUInt32LE(0, 24);
    anih.writeUInt32LE(jiffies, 28);
    anih.writeUInt32LE(1, 32);

    const rate = Buffer.alloc(frames.length * 4);
    for (let index = 0; index < frames.length; index++) {
        rate.writeUInt32LE(jiffies, index * 4);
    }

    const infoChunks = [];
    if (options.name) {
        infoChunks.push(makeRiffChunk('INAM', Buffer.from(`${String(options.name)}\0`, 'utf8')));
    }
    if (options.author) {
        infoChunks.push(makeRiffChunk('IART', Buffer.from(`${String(options.author)}\0`, 'utf8')));
    }

    const parts = [
        makeRiffChunk('anih', anih),
        makeRiffChunk('rate', rate)
    ];
    if (infoChunks.length > 0) {
        parts.push(makeRiffChunk('LIST', Buffer.concat([Buffer.from('INFO'), ...infoChunks])));
    }
    parts.push(makeRiffChunk(
        'LIST',
        Buffer.concat([
            Buffer.from('fram'),
            ...frames.map(frame => makeRiffChunk('icon', frame))
        ])
    ));

    const body = Buffer.concat([Buffer.from('ACON'), ...parts]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 4, 'ascii');
    riff.writeUInt32LE(body.length, 4);
    return Buffer.concat([riff, body]);
}

let crcTable = null;

function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        crcTable[index] = value >>> 0;
    }
    return crcTable;
}

function crc32(buffer) {
    assertBuffer(buffer, 'crc32 buffer');
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(dateValue = new Date()) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const dosTime =
        (date.getHours() << 11) |
        (date.getMinutes() << 5) |
        Math.floor(date.getSeconds() / 2);
    const dosDate =
        ((year - 1980) << 9) |
        ((date.getMonth() + 1) << 5) |
        date.getDate();
    return { dosTime, dosDate };
}

function encodeZip(entries, options = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('ZIP 至少需要一个条目。');
    }
    if (entries.length > MAX_ZIP_ENTRIES) {
        throw new Error(`ZIP 条目数超过 ${MAX_ZIP_ENTRIES}。`);
    }

    const now = options.date || new Date();
    const localParts = [];
    const centralParts = [];
    const seenPaths = new Set();
    let localOffset = 0;
    let totalDataBytes = 0;

    for (const [index, entry] of entries.entries()) {
        const entryPath = normalizeZipPath(entry.path);
        if (seenPaths.has(entryPath)) throw new Error(`ZIP 条目路径重复: ${entryPath}`);
        seenPaths.add(entryPath);

        const data = Buffer.isBuffer(entry.data)
            ? entry.data
            : Buffer.from(String(entry.data ?? ''), entry.encoding || 'utf8');
        totalDataBytes += data.length;
        if (totalDataBytes > MAX_ZIP_BYTES) {
            throw new Error(`ZIP 数据总量超过 ${MAX_ZIP_BYTES / 1024 / 1024}MB。`);
        }

        const fileName = Buffer.from(entryPath, 'utf8');
        if (fileName.length > 0xffff) throw new Error(`ZIP 条目名称过长: ${entryPath}`);
        const checksum = crc32(data);
        const { dosTime, dosDate } = getDosDateTime(entry.date || now);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0800, 6);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt16LE(dosTime, 10);
        localHeader.writeUInt16LE(dosDate, 12);
        localHeader.writeUInt32LE(checksum, 14);
        localHeader.writeUInt32LE(data.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(fileName.length, 26);
        localHeader.writeUInt16LE(0, 28);
        localParts.push(localHeader, fileName, data);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(0, 10);
        centralHeader.writeUInt16LE(dosTime, 12);
        centralHeader.writeUInt16LE(dosDate, 14);
        centralHeader.writeUInt32LE(checksum, 16);
        centralHeader.writeUInt32LE(data.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(fileName.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(localOffset, 42);
        centralParts.push(centralHeader, fileName);

        localOffset += localHeader.length + fileName.length + data.length;
        if (localOffset > 0xffffffff) throw new Error(`ZIP 在第 ${index + 1} 个条目处超过 ZIP32 限制。`);
    }

    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(localOffset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDirectory, end]);
}

function windowsPathJoin(...segments) {
    return segments
        .map(segment => String(segment).replace(/[\\/]+/g, '\\').replace(/^\\+|\\+$/g, ''))
        .filter(Boolean)
        .join('\\');
}

function buildThemeManifest(theme) {
    const packageStem = sanitizePackageStem(theme.name);
    const roleFiles = {};
    const roleMetadata = {};

    for (const role of theme.roles) {
        const extension = role.animated ? 'ani' : 'cur';
        roleFiles[role.role] = `${role.role}.${extension}`;
        roleMetadata[role.role] = {
            file: roleFiles[role.role],
            animated: Boolean(role.animated),
            durationMs: role.animated ? role.durationMs : null,
            fps: role.animated ? role.fps : null,
            frameCount: role.animated ? role.frameCount : 1,
            viewBox: role.viewBox,
            hotspot: role.hotspot,
            scaledHotspots: role.scaledHotspots
        };
    }

    for (const optionalRole of OPTIONAL_CURSOR_ROLES) {
        if (!roleFiles[optionalRole]) roleFiles[optionalRole] = roleFiles.arrow;
    }

    return {
        schemaVersion: 1,
        name: sanitizeThemeName(theme.name),
        packageStem,
        author: String(theme.author || 'VCPToolBox AI').slice(0, 100),
        generatedAt: new Date(theme.generatedAt || Date.now()).toISOString(),
        sizes: theme.sizes || DEFAULT_CURSOR_SIZES,
        roleFiles,
        roles: roleMetadata
    };
}

function buildInstallInf(manifest) {
    const themeName = manifest.name;
    const installDir = sanitizePackageStem(themeName);
    const cursorFiles = [...new Set(Object.values(manifest.roleFiles))];
    const copyEntries = cursorFiles.join('\r\n');
    const addRegEntries = Object.entries(WINDOWS_CURSOR_FIELDS).map(([role, field]) => {
        const file = manifest.roleFiles[role] || manifest.roleFiles.arrow;
        return `HKCU,"Control Panel\\Cursors","${field}",0x00020000,"%10%\\Cursors\\${installDir}\\${file}"`;
    });
    const schemeValues = Object.keys(WINDOWS_CURSOR_FIELDS).map(role => {
        const file = manifest.roleFiles[role] || manifest.roleFiles.arrow;
        return `%10%\\Cursors\\${installDir}\\${file}`;
    }).join(',');

    return [
        '; Generated by VCPToolBox MediaRenderer',
        '[Version]',
        'Signature="$Windows NT$"',
        '',
        '[DefaultInstall]',
        'CopyFiles=CursorTheme.Files',
        'AddReg=CursorTheme.Registry',
        '',
        '[DestinationDirs]',
        `CursorTheme.Files=10,"Cursors\\${installDir}"`,
        '',
        '[CursorTheme.Files]',
        copyEntries,
        '',
        '[CursorTheme.Registry]',
        ...addRegEntries,
        'HKCU,"Control Panel\\Cursors","Scheme Source",0x00010001,1',
        `HKCU,"Control Panel\\Cursors\\Schemes","${themeName}",0x00000000,"${schemeValues}"`,
        '',
        '[SourceDisksNames]',
        '1="VCP Cursor Theme",,,""',
        '',
        '[SourceDisksFiles]',
        ...cursorFiles.map(file => `${file}=1,cursors`),
        ''
    ].join('\r\n');
}

function buildInstallCmd(manifest) {
    const installDir = sanitizePackageStem(manifest.name);
    const lines = [
        '@echo off',
        'setlocal',
        `set "THEME_NAME=${manifest.name.replace(/"/g, '')}"`,
        `set "TARGET=%SystemRoot%\\Cursors\\${installDir}"`,
        'if not exist "%TARGET%" mkdir "%TARGET%"',
        'copy /Y "%~dp0cursors\\*" "%TARGET%\\" >nul',
        'if errorlevel 1 (',
        '  echo Installation failed. Please run this script as Administrator.',
        '  exit /b 1',
        ')'
    ];
    for (const [role, field] of Object.entries(WINDOWS_CURSOR_FIELDS)) {
        const file = manifest.roleFiles[role] || manifest.roleFiles.arrow;
        lines.push(`reg add "HKCU\\Control Panel\\Cursors" /v "${field}" /t REG_EXPAND_SZ /d "%%SystemRoot%%\\Cursors\\${installDir}\\${file}" /f >nul`);
    }
    lines.push(
        'reg add "HKCU\\Control Panel\\Cursors" /v "Scheme Source" /t REG_DWORD /d 1 /f >nul',
        'rundll32.exe user32.dll,UpdatePerUserSystemParameters',
        'echo Cursor theme installed. Sign out and back in if some applications keep old cursors.',
        'endlocal'
    );
    return lines.join('\r\n');
}

function buildUninstallCmd(manifest) {
    const installDir = sanitizePackageStem(manifest.name);
    return [
        '@echo off',
        'setlocal',
        'echo Switch to another cursor scheme before removing this theme.',
        `rmdir /S /Q "%SystemRoot%\\Cursors\\${installDir}"`,
        `reg delete "HKCU\\Control Panel\\Cursors\\Schemes" /v "${manifest.name.replace(/"/g, '')}" /f >nul 2>nul`,
        'rundll32.exe user32.dll,UpdatePerUserSystemParameters',
        'echo Cursor theme files removed.',
        'endlocal'
    ].join('\r\n');
}

function buildReadme(manifest) {
    return [
        manifest.name,
        '='.repeat(Math.max(3, manifest.name.length)),
        '',
        `Author: ${manifest.author}`,
        `Generated: ${manifest.generatedAt}`,
        `Sizes: ${manifest.sizes.join(', ')} px`,
        '',
        'Installation:',
        '1. Extract the ZIP completely.',
        '2. Right-click install.inf and choose Install, or run install.cmd as Administrator.',
        '3. Open Windows Settings > Bluetooth & devices > Mouse > Additional mouse settings.',
        '4. Select the theme on the Pointers tab if Windows did not activate it automatically.',
        '',
        'Uninstallation:',
        '1. Switch to another cursor scheme.',
        '2. Run uninstall.cmd as Administrator.',
        '',
        'Security:',
        '- CUR and ANI files contain PNG images only.',
        '- The included scripts only copy cursor files and update the current user cursor registry keys.',
        '- source.html is included for editing and is not executed during installation.',
        ''
    ].join('\r\n');
}

function buildThemeZip(theme) {
    if (!theme || !Array.isArray(theme.roles)) throw new Error('主题必须包含 roles 数组。');
    const manifest = buildThemeManifest(theme);
    const root = manifest.packageStem;
    const entries = [];

    for (const role of theme.roles) {
        if (!CURSOR_ROLE_SET.has(role.role)) throw new Error(`未知输出角色: ${role.role}`);
        assertBuffer(role.buffer, `角色 ${role.role} buffer`);
        const expectedFile = manifest.roleFiles[role.role];
        entries.push({
            path: path.posix.join(root, 'cursors', expectedFile),
            data: role.buffer
        });
    }

    if (theme.previewPng) {
        assertBuffer(theme.previewPng, 'previewPng');
        entries.push({ path: path.posix.join(root, 'preview.png'), data: theme.previewPng });
    }
    if (theme.sourceHtml) {
        entries.push({ path: path.posix.join(root, 'source.html'), data: theme.sourceHtml });
    }

    entries.push(
        {
            path: path.posix.join(root, 'theme.json'),
            data: JSON.stringify(manifest, null, 2)
        },
        {
            path: path.posix.join(root, 'install.inf'),
            data: buildInstallInf(manifest)
        },
        {
            path: path.posix.join(root, 'install.cmd'),
            data: buildInstallCmd(manifest)
        },
        {
            path: path.posix.join(root, 'uninstall.cmd'),
            data: buildUninstallCmd(manifest)
        },
        {
            path: path.posix.join(root, 'README.txt'),
            data: buildReadme(manifest)
        }
    );

    return {
        buffer: encodeZip(entries, { date: new Date(manifest.generatedAt) }),
        manifest,
        entries: entries.map(entry => entry.path)
    };
}

module.exports = {
    CORE_CURSOR_ROLES,
    OPTIONAL_CURSOR_ROLES,
    ALL_CURSOR_ROLES,
    WINDOWS_CURSOR_FIELDS,
    DEFAULT_CURSOR_SIZES,
    sanitizeThemeName,
    sanitizePackageStem,
    parseViewBox,
    parseHotspot,
    scaleHotspot,
    validateCursorRoles,
    encodeCur,
    encodeAni,
    crc32,
    encodeZip,
    buildThemeManifest,
    buildInstallInf,
    buildInstallCmd,
    buildUninstallCmd,
    buildReadme,
    buildThemeZip,
    windowsPathJoin
};