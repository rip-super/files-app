const API_URL = "https://files.sahildash.dev";

const ICONS = {
    image: "/icons/image.svg",
    video: "/icons/video.svg",
    pdf: "/icons/pdf.svg",
    audio: "/icons/audio.svg",
    archive: "/icons/archive.svg",
    text: "/icons/text.svg",
    other: "/icons/file.svg",
};

const CODE_ICONS = {
    js: "/icons/code/javascript.svg",
    ts: "/icons/code/typescript.svg",
    py: "/icons/code/py.svg",
    go: "/icons/code/go.svg",
    rs: "/icons/code/rust.svg",
    java: "/icons/code/java.svg",
    c: "/icons/code/c.svg",
    cpp: "/icons/code/cpp.svg",
    html: "/icons/code/html.svg",
    css: "/icons/code/css.svg",
    json: "/icons/code/json.svg",
    md: "/icons/code/md.svg",
    yml: "/icons/code/yaml.svg",
    yaml: "/icons/code/yaml.svg",
    sh: "/icons/code/shell.svg",
    bash: "/icons/code/shell.svg",
    zsh: "/icons/code/shell.svg",
    php: "/icons/code/php.svg",
    rb: "/icons/code/rb.svg",
    swift: "/icons/code/swift.svg",
    cs: "/icons/code/csharp.svg",
    sql: "/icons/code/sql.svg",
    default: "/icons/file.svg",
};

const CODE_EXTS = new Set([
    "bash",
    "c",
    "cpp",
    "cs",
    "css",
    "go",
    "html",
    "java",
    "js",
    "json",
    "md",
    "php",
    "py",
    "rb",
    "rs",
    "sh",
    "shell",
    "sql",
    "swift",
    "ts",
    "yaml",
    "yml",
]);

const $ = (id) => document.getElementById(id);

const els = {
    fileCount: $("fileCount"),
    list: $("downloadFileList"),
    empty: $("downloadEmpty"),
    downloadAll: $("downloadAllBtn"),

    pageLink: $("pageLink"),
    copyLink: $("copyPageLinkBtn"),

    share: $("shareBtn"),
    qr: $("qrBtn"),
    delete: $("deleteBtn"),
    home: $("homeBtn"),

    toast: $("toast"),
    status: $("downloadStatus"),
};

els.dlProgress = $("dlProgress");
els.dlProgressTitle = $("dlProgressTitle");
els.dlProgressPct = $("dlProgressPct");
els.dlProgressBytes = $("dlProgressBytes");
els.dlProgressSpeed = $("dlProgressSpeed");
els.dlProgressWrap = $("dlProgressWrap");
els.dlProgressBar = $("dlProgressBar");
els.expiryText = $("expiryText");

let toastTimer = null;

let shareId = null;
let keyB64 = null;

let manifest = null;
let selectedIndex = -1;

let keyBytes = null;
let dataHeader = null;
let dataPullState = null;

let manifestCache = null;

let dataReader = null;
let dataBuf = new Uint8Array(0);
let nextChunkIndex = 0;
let chunkCache = new Map();
let dataDone = false;
let startDataStreamPromise = null;
let readMutex = Promise.resolve();

let expiryTimer = null;
let meta = null;

function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

function raf2(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
}

function showToast(msg) {
    if (!els.toast) return;

    els.toast.textContent = msg;
    els.toast.classList.add("show");

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1600);
}

function setStatus(msg) {
    if (!els.status) return;
    els.status.textContent = msg;
    els.status.classList.add("show");
}

function clearStatus() {
    if (!els.status) return;
    els.status.classList.remove("show");
    els.status.textContent = "";
}

function escapeHtml(str) {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function formatFileSize(bytes) {
    if (!bytes) return "0 Bytes";

    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const value = Math.round((bytes / Math.pow(k, i)) * 100) / 100;

    return `${value} ${sizes[i]}`;
}

function formatBytesShort(bytes) {
    if (!bytes || bytes <= 0) return "0 MB";
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

function showDlProgress(title, doneBytes, totalBytes, speedBps) {
    if (!els.dlProgress) return;

    els.dlProgress.classList.remove("is-hidden");
    if (els.dlProgressTitle) els.dlProgressTitle.textContent = title || "Downloading...";

    const pct = totalBytes > 0 ? Math.min(100, Math.floor((doneBytes / totalBytes) * 100)) : 0;
    if (els.dlProgressPct) els.dlProgressPct.textContent = `${pct}%`;
    if (els.dlProgressBar) els.dlProgressBar.style.width = `${pct}%`;
    els.dlProgressWrap?.setAttribute("aria-valuenow", String(pct));

    if (els.dlProgressBytes) {
        els.dlProgressBytes.textContent = `${formatBytesShort(doneBytes)} / ${formatBytesShort(totalBytes)}`;
    }

    if (els.dlProgressSpeed) {
        const mbps = speedBps > 0 ? (speedBps / (1024 * 1024)) : 0;
        els.dlProgressSpeed.textContent = `${mbps.toFixed(mbps < 10 ? 1 : 0)} MB/s`;
    }
}

function hideDlProgress() {
    els.dlProgress?.classList.add("is-hidden");
    if (els.dlProgressBar) els.dlProgressBar.style.width = "0%";
    els.dlProgressWrap?.setAttribute("aria-valuenow", "0");
    if (els.dlProgressPct) els.dlProgressPct.textContent = "0%";
    if (els.dlProgressBytes) els.dlProgressBytes.textContent = "0 MB / 0 MB";
    if (els.dlProgressSpeed) els.dlProgressSpeed.textContent = "0 MB/s";
}

function classifyByNameAndType(filename, mime = "") {
    const ext = (filename.split(".").pop() || "").toLowerCase();

    if (mime.startsWith("image/")) return { kind: "image", ext };
    if (mime.startsWith("video/")) return { kind: "video", ext };
    if (mime === "application/pdf" || ext === "pdf") return { kind: "pdf", ext };
    if (mime.startsWith("audio/")) return { kind: "audio", ext };

    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return { kind: "archive", ext };
    if (["txt", "log", "rtf"].includes(ext)) return { kind: "text", ext };
    if (CODE_EXTS.has(ext)) return { kind: "code", ext };

    return { kind: "other", ext };
}

function resolveIconForItem(item) {
    const { kind, ext } = classifyByNameAndType(item.filename, item.mimeType || "");
    if (kind === "code") return CODE_ICONS[ext] || CODE_ICONS.default;
    return ICONS[kind] || ICONS.other;
}

function parseShareFromUrl() {
    const { pathname, hash } = window.location;
    const parts = pathname.split("/").filter(Boolean);

    if (parts.length !== 1) {
        shareId = null;
        keyB64 = null;
        return;
    }

    const id = parts[0];

    const keyRaw = hash.startsWith("#") ? hash.slice(1) : "";
    const key = keyRaw ? decodeURIComponent(keyRaw).trim() : "";

    if (!id || !key) {
        shareId = null;
        keyB64 = null;
        return;
    }

    shareId = id;
    keyB64 = key;
}

function setMotionIn() {
    const hdr = $("hdrMotion");
    const card = $("cardMotion");
    const about = $("aboutMotion");

    if (prefersReducedMotion()) {
        [hdr, card, about].forEach((x) => x?.classList.remove("is-hidden"));
        return;
    }

    raf2(() => {
        hdr?.classList.remove("is-hidden");
        setTimeout(() => card?.classList.remove("is-hidden"), 90);
        setTimeout(() => about?.classList.remove("is-hidden"), 150);
    });
}

function updateCount(n) {
    if (!els.fileCount) return;
    els.fileCount.textContent = `${n} File${n === 1 ? "" : "s"}`;
}

function clearSelection() {
    selectedIndex = -1;
    els.list?.querySelectorAll(".dl-item").forEach((row) => row.classList.remove("is-selected"));
}

function selectIndex(idx, { silent = false } = {}) {
    selectedIndex = idx;

    els.list?.querySelectorAll(".dl-item").forEach((row) => {
        row.classList.toggle("is-selected", Number(row.dataset.index) === idx);
    });

    if (!silent) clearStatus();
}

function popInRows() {
    if (prefersReducedMotion() || !els.list) return;

    const rows = Array.from(els.list.querySelectorAll(".dl-item"));
    rows.forEach((row, i) => {
        row.classList.remove("pop-in");
        void row.offsetWidth;
        row.style.animationDelay = `${i * 22}ms`;
        row.classList.add("pop-in");
    });
}

function renderList() {
    if (!els.list || !els.empty || !els.downloadAll) return;

    els.list.innerHTML = "";

    const files = manifest?.files || [];
    updateCount(files.length);

    if (files.length === 0) {
        els.empty.classList.remove("is-hidden");
        els.downloadAll.disabled = true;
        return;
    }

    els.empty.classList.add("is-hidden");
    els.downloadAll.disabled = false;

    files.forEach((item, idx) => {
        const iconSrc = resolveIconForItem(item);

        const row = document.createElement("div");
        row.className = "dl-item";
        row.setAttribute("role", "listitem");
        row.dataset.index = String(idx);

        row.innerHTML = `
            <div class="dl-file-ico"><img src="${iconSrc}" alt=""></div>

            <div class="dl-meta">
                <div class="dl-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</div>

                <div class="dl-rightslot">
                    <div class="dl-size">${formatFileSize(item.size || 0)}</div>

                    <button class="dl-download-one" type="button" data-dl="${idx}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                            <polyline points="7 10 12 15 17 10"></polyline>
                            <line x1="12" y1="15" x2="12" y2="3"></line>
                        </svg>
                        Download
                    </button>
                </div>
            </div>
        `;

        row.addEventListener("click", (e) => {
            if (e.target?.closest?.("button")) return;
            if (selectedIndex === idx) return clearSelection();
            selectIndex(idx);
        });

        els.list.appendChild(row);
    });

    els.list.querySelectorAll("[data-dl]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await downloadOne(Number(btn.getAttribute("data-dl")));
        });
    });

    popInRows();
}

function triggerBrowserDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");

    a.href = url;
    a.download = filename;

    document.body.appendChild(a);
    a.click();
    a.remove();

    URL.revokeObjectURL(url);
}

async function loadManifest() {
    try {
        if (!shareId || !keyB64) {
            throw new Error("Missing share ID or key");
        }

        const key = sodium.from_base64(keyB64, sodium.base64_variants.URLSAFE_NO_PADDING);

        if (key.length !== 32) {
            throw new Error("Invalid key length");
        }

        const res = await fetch(`${API_URL}/downloads/${shareId}/manifest`);
        if (!res.ok) throw new Error("Failed to fetch manifest");

        const encrypted = new Uint8Array(await res.arrayBuffer());

        const nonce = encrypted.slice(0, 12);
        const cipher = encrypted.slice(12);

        const compressed = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
            null,
            cipher,
            null,
            nonce,
            key
        );

        manifest = JSON.parse(new TextDecoder().decode(window.zstd.decompress(compressed)));
        manifest.files = (manifest.files || []).map(f => ({
            filename: f.name,
            size: f.size,
            mimeType: f.type,
            startChunk: f.startChunk,
            chunkCount: f.chunkCount
        }));

        console.log("Manifest Loaded:", manifest);
        return manifest;

    } catch (err) {
        console.error(err);
        setStatus(`Failed to load manifest`);
        throw err;
    }
}

async function* chunksForFile({
    apiUrl,
    shareId,
    file,
    signal,
    chunksPerReq = 256,
}) {
    const u32be = (buf, off) =>
        ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;

    async function* fetchFramesStreamed({ apiUrl, id, start, end, signal }) {
        const url = `${apiUrl}/downloads/${id}/data?start=${start}&end=${end}`;
        const res = await fetch(url, { signal });

        if (!res.ok) {
            const msg = await res.text().catch(() => "");
            throw new Error(`download failed: ${res.status} ${msg}`);
        }
        if (!res.body) throw new Error("No response body stream");

        const reader = res.body.getReader();
        const chunks = [];
        let totalLen = 0;

        const pullBytes = (n) => {
            if (totalLen < n) return null;
            const out = new Uint8Array(n);
            let offset = 0;

            while (offset < n) {
                const head = chunks[0];
                const take = Math.min(head.length, n - offset);
                out.set(head.subarray(0, take), offset);
                offset += take;
                if (take === head.length) chunks.shift();
                else chunks[0] = head.subarray(take);
            }

            totalLen -= n;
            return out;
        };

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                chunks.push(value);
                totalLen += value.length;

                while (true) {
                    if (totalLen < 8) break;

                    const header = pullBytes(8);
                    const chunkIndex = u32be(header, 0);
                    const len = u32be(header, 4);

                    if (len <= 0) throw new Error(`Invalid payloadLen ${len}`);

                    if (totalLen < len) {
                        chunks.unshift(header);
                        totalLen += 8;
                        break;
                    }

                    const payload = pullBytes(len);
                    yield { chunkIndex, payload };
                }

                if (totalLen > 64 * 1024 * 1024) throw new Error("Framing buffer too large");
            }

            if (totalLen !== 0) throw new Error("Response ended with incomplete frame");
        } finally {
            try { reader.releaseLock(); } catch { }
        }
    }

    const startChunk = Number(file.startChunk);
    const chunkCount = Number(file.chunkCount);
    if (!Number.isInteger(startChunk) || !Number.isInteger(chunkCount) || chunkCount <= 0) {
        throw new Error("Invalid manifest chunk range");
    }
    const endChunk = startChunk + chunkCount - 1;

    for (let s = startChunk; s <= endChunk; s += chunksPerReq) {
        const e = Math.min(endChunk, s + chunksPerReq - 1);
        for await (const frame of fetchFramesStreamed({ apiUrl, id: shareId, start: s, end: e, signal })) {
            yield frame;
        }
    }
}

async function downloadOne(idx) {
    const beforeUnloadHandler = (evt) => { evt.preventDefault(); evt.returnValue = ""; };
    let writer = null;

    let spinnerTimer = null;
    let spinnerPhase = 0;

    try {
        clearStatus();

        if (!manifest?.files?.[idx]) throw new Error("Missing manifest/file entry");
        if (!shareId || !keyB64) throw new Error("Missing share id/key");

        const key = sodium.from_base64(keyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
        if (key.length !== 32) throw new Error("Invalid key length");

        const file = manifest.files[idx];
        const filename = file.filename || `file-${idx}`;
        const totalBytes = Number(file.size || 0);

        const fileStream = streamSaver.createWriteStream(filename, { size: totalBytes });
        writer = fileStream.getWriter();

        window.addEventListener("beforeunload", beforeUnloadHandler);

        const decryptDecompress = (payloadU8, key) => {
            const nonce = payloadU8.slice(0, 12);
            const cipher = payloadU8.slice(12);
            const compressed = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, cipher, null, nonce, key);
            return window.zstd.decompress(compressed);
        };

        showDlProgress(`Fetching encrypted data`, 0, totalBytes, 0);
        spinnerTimer = setInterval(() => {
            spinnerPhase = (spinnerPhase + 1) % 4;
            const dots = ".".repeat(spinnerPhase);
            showDlProgress(`Fetching encrypted data${dots}`, 0, totalBytes, 0);
        }, 350);

        const aborter = new AbortController();

        const t0 = performance.now();
        let doneBytes = 0;
        let savingMode = false;

        for await (const { payload } of chunksForFile({
            apiUrl: API_URL,
            shareId,
            file,
            signal: aborter.signal,
            chunksPerReq: 256,
            prefetch: 1,
        })) {
            const plain = decryptDecompress(payload, key);

            if (!savingMode) {
                savingMode = true;
                if (spinnerTimer) {
                    clearInterval(spinnerTimer);
                    spinnerTimer = null;
                }
            }

            doneBytes += plain.byteLength;

            const elapsed = (performance.now() - t0) / 1000;
            const speed = elapsed > 0 ? (doneBytes / elapsed) : 0;

            showDlProgress(
                `Saving ${filename}`,
                Math.min(doneBytes, totalBytes),
                totalBytes,
                speed
            );

            await writer.write(plain);
        }

        await writer.close();
        writer = null;

        try { await fetch(`${API_URL}/downloads/${shareId}/finish`, { method: "POST" }); } catch { }
        hideDlProgress();
        showToast("Download complete!");
    } catch (err) {
        console.error(err);
        hideDlProgress();
        setStatus(String(err?.message || "Download failed"));
        try { await writer?.abort(); } catch { }
    } finally {
        if (spinnerTimer) clearInterval(spinnerTimer);
        window.removeEventListener("beforeunload", beforeUnloadHandler);
    }
}

async function downloadAll() {
    function fileReadableStreamFromIterator(makeIterator, signal) {
        return new ReadableStream({
            async start(controller) {
                try {
                    for await (const chunk of makeIterator()) {
                        if (signal?.aborted) throw new Error("Download canceled");
                        controller.enqueue(chunk);
                    }
                    controller.close();
                } catch (e) {
                    controller.error(e);
                }
            }
        });
    }

    function makeNameDeduper() {
        const used = new Set();

        return function uniqueName(original) {
            let name = String(original || "").trim();

            if (!name) name = "file";

            name = name.replaceAll("\\", "/").replace(/^\/+/, "");

            if (!used.has(name)) {
                used.add(name);
                return name;
            }

            const m = name.match(/^(.*?)(\.[^./]+)?$/);
            const stem = m?.[1] ?? name;
            const ext = m?.[2] ?? "";

            let n = 2;
            while (used.has(`${stem} (${n})${ext}`)) n++;

            const out = `${stem} (${n})${ext}`;
            used.add(out);
            return out;
        };
    }

    const beforeUnloadHandler = (evt) => { evt.preventDefault(); evt.returnValue = ""; };
    const aborter = new AbortController();
    let zipWriter = null;

    if (manifest.files.length === 1) {
        downloadOne(0);
        return;
    }

    try {
        clearStatus();
        if (!manifest?.files?.length) throw new Error("No files in manifest");
        if (!shareId || !keyB64) throw new Error("Missing share id/key");
        if (typeof window.ZIP !== "function") throw new Error("ZIP not loaded.");

        const key = sodium.from_base64(keyB64, sodium.base64_variants.URLSAFE_NO_PADDING);
        if (key.length !== 32) throw new Error("Invalid key length");

        let totalPlainBytes = Number(manifest.totalBytes || 0);
        if (!Number.isFinite(totalPlainBytes) || totalPlainBytes < 0) {
            totalPlainBytes = manifest.files.reduce((acc, f) => acc + Number(f.size || 0), 0);
        }

        const zipName = `files_${shareId}.zip`;
        const zipFileStream = streamSaver.createWriteStream(zipName, { size: undefined });
        zipWriter = zipFileStream.getWriter();

        window.addEventListener("beforeunload", beforeUnloadHandler);

        const t0 = performance.now();
        let donePlainBytes = 0;

        const onPlainBytes = (n) => {
            donePlainBytes += n;
            const elapsed = (performance.now() - t0) / 1000;
            const speed = elapsed > 0 ? (donePlainBytes / elapsed) : 0;
            showDlProgress(`Downloading ${zipName}`, Math.min(donePlainBytes, totalPlainBytes), totalPlainBytes, speed);
        };

        showDlProgress(`Downloading ${zipName}`, 0, totalPlainBytes, 0);

        const queue = manifest.files.slice();
        const dedupeName = makeNameDeduper();

        const readableZipStream = window.ZIP({
            async pull(zip) {
                if (aborter.signal.aborted) { zip.close(); return; }

                const f = queue.shift();
                if (!f) { zip.close(); return; }

                const rawName = f.filename || `file-${f.startChunk ?? ""}`;
                const safeName = dedupeName(rawName);

                zip.enqueue({
                    name: safeName,
                    stream: () => fileReadableStreamFromIterator(
                        async function* () {
                            const decryptDecompress = (payloadU8, key) => {
                                const nonce = payloadU8.slice(0, 12);
                                const cipher = payloadU8.slice(12);
                                const compressed = sodium.crypto_aead_chacha20poly1305_ietf_decrypt(null, cipher, null, nonce, key);
                                return window.zstd.decompress(compressed);
                            };

                            for await (const { payload } of chunksForFile({
                                apiUrl: API_URL,
                                shareId,
                                file: f,
                                signal: aborter.signal,
                                chunksPerReq: 256,
                                prefetch: 1,
                            })) {
                                const plain = decryptDecompress(payload, key);
                                onPlainBytes?.(plain.byteLength);
                                yield plain;
                            }
                        },
                        aborter.signal
                    )
                });
            }
        });

        const reader = readableZipStream.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            await zipWriter.write(value);
        }

        await zipWriter.close();
        zipWriter = null;

        try { await fetch(`${API_URL}/downloads/${shareId}/finish`, { method: "POST" }); } catch { }

        hideDlProgress();
        showToast("Download complete!");
    } catch (err) {
        console.error(err);
        hideDlProgress();
        setStatus(String(err?.message || "Download failed"));
        aborter.abort();
        try { await zipWriter?.abort(); } catch { }
    } finally {
        window.removeEventListener("beforeunload", beforeUnloadHandler);
    }
}

function confirmModal({ title, message }) {
    const modal = document.getElementById("confirmModal");
    const titleEl = document.getElementById("confirmTitle");
    const bodyEl = modal?.querySelector(".modal__body");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");

    if (!modal || !titleEl || !bodyEl || !okBtn || !cancelBtn) {
        return Promise.resolve(window.confirm(message));
    }

    titleEl.textContent = title;
    bodyEl.textContent = message;

    document.body.classList.add("modal-open");
    modal.classList.add("is-open");
    okBtn.focus();

    return new Promise((resolve) => {
        const prefersReduce = prefersReducedMotion?.() ?? false;

        const cleanup = (value) => {
            okBtn.removeEventListener("click", onOk);
            cancelBtn.removeEventListener("click", onCancel);
            modal.removeEventListener("click", onBackdrop);
            document.removeEventListener("keydown", onKey);
            resolve(value);
        };

        const animateClose = (value) => {
            modal.classList.remove("is-open");
            document.body.classList.remove("modal-open");

            if (prefersReduce) return cleanup(value);

            const onEnd = (e) => {
                if (e.target !== modal) return;
                modal.removeEventListener("transitionend", onEnd);
                cleanup(value);
            };

            modal.addEventListener("transitionend", onEnd);

            setTimeout(() => {
                modal.removeEventListener("transitionend", onEnd);
                cleanup(value);
            }, 450);
        };

        const onOk = () => animateClose(true);
        const onCancel = () => animateClose(false);

        const onBackdrop = (e) => {
            if (e.target?.dataset?.close) onCancel();
        };

        const onKey = (e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter") onOk();
        };

        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        modal.addEventListener("click", onBackdrop);
        document.addEventListener("keydown", onKey);
    });
}

function qrModal({ url }) {
    const modal = document.getElementById("qrModal");
    const closeBtn = document.getElementById("qrCloseBtn");
    const canvas = document.getElementById("qrCanvas");

    if (window.QRCode?.toCanvas) {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);

        window.QRCode.toCanvas(canvas, url, {
            width: 256,
            margin: 2,
            errorCorrectionLevel: "M",
        }).catch((e) => console.error("QR render failed", e));
    } else {
        console.warn("QRCode library not loaded");
    }

    document.body.classList.add("modal-open");
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    closeBtn.focus();

    return new Promise((resolve) => {
        const prefersReduce = prefersReducedMotion?.() ?? false;

        const cleanup = () => {
            closeBtn.removeEventListener("click", onClose);
            modal.removeEventListener("click", onBackdrop);
            document.removeEventListener("keydown", onKey);
            resolve();
        };

        const animateClose = () => {
            modal.classList.remove("is-open");
            document.body.classList.remove("modal-open");
            modal.setAttribute("aria-hidden", "true");

            if (prefersReduce) return cleanup();

            const onEnd = (e) => {
                if (e.target !== modal) return;
                modal.removeEventListener("transitionend", onEnd);
                cleanup();
            };

            modal.addEventListener("transitionend", onEnd);
            setTimeout(() => {
                modal.removeEventListener("transitionend", onEnd);
                cleanup();
            }, 450);
        };

        const onClose = () => animateClose();
        const onBackdrop = (e) => { if (e.target?.dataset?.close) onClose(); };
        const onKey = (e) => { if (e.key === "Escape") onClose(); };

        closeBtn.addEventListener("click", onClose);
        modal.addEventListener("click", onBackdrop);
        document.addEventListener("keydown", onKey);
    });
}

async function loadMeta() {
    const r = await fetch(`${API_URL}/downloads/${shareId}/meta`);
    if (!r.ok) throw new Error("Failed to fetch meta");
    return r.json();
}

function formatTimeLeft(ms) {
    if (ms <= 0) return "expired";

    const totalMin = Math.ceil(ms / 60000);
    const d = Math.floor(totalMin / (60 * 24));
    const h = Math.floor((totalMin % (60 * 24)) / 60);
    const m = totalMin % 60;

    if (d > 0) return `${d} day${d === 1 ? "" : "s"}${h ? ` ${h}h` : ""}`;
    if (h > 0) return `${h} hour${h === 1 ? "" : "s"}${m ? ` ${m}m` : ""}`;
    return `${m} minute${m === 1 ? "" : "s"}`;
}

function expiryLabelFromKey(key) {
    switch (key) {
        case "15m": return "15 minutes";
        case "1h": return "1 hour";
        case "24h": return "1 day";
        case "7d": return "7 days";
        default: return null;
    }
}

function updateExpiryText(meta) {
    if (!els.expiryText) return;

    if (!meta) {
        els.expiryText.textContent = "";
        return;
    }

    const now = Date.now();
    if (meta.expiresAt && Number(meta.expiresAt) <= now) {
        els.expiryText.textContent = "Expired";
        return;
    }

    let timePart = null;
    if (meta.expiresAt) {
        const label = expiryLabelFromKey(meta.expiryKey);
        timePart = label ? `Expires in ${label}` : "Expires soon";
    }

    let dlPart = null;
    if (meta.maxDownloads) {
        const max = Number(meta.maxDownloads);
        dlPart = `after ${max} download${max === 1 ? "" : "s"}`;
    }

    if (timePart && dlPart) els.expiryText.textContent = `${timePart} or ${dlPart}`;
    else if (timePart) els.expiryText.textContent = timePart;
    else if (dlPart) els.expiryText.textContent = `Expires ${dlPart}`;
    else els.expiryText.textContent = "";
}

async function checkIfExpired() {
    const res = await fetch(`${API_URL}/downloads/${shareId}/meta`);

    if (res.status === 404) {
        showToast("This upload has expired");
        setTimeout(() => {
            window.location.reload();
        }, 1000);
        return true;
    }

    if (!res.ok) {
        console.warn("Failed to check expiry");
    }

    return false;
}

function wireUi() {
    if (els.pageLink) els.pageLink.value = window.location.href;

    let copyBtnTimer = null;

    els.copyLink?.addEventListener("click", async () => {
        const btn = els.copyLink;
        const original = btn.textContent.trim();
        const text = els.pageLink?.value || "";
        if (!text) return;

        clearStatus();

        try {
            await navigator.clipboard.writeText(text);
        } catch {
            els.pageLink?.focus();
            els.pageLink?.select();
            document.execCommand("copy");
        }

        btn.textContent = "Copied!";
        if (copyBtnTimer) clearTimeout(copyBtnTimer);
        copyBtnTimer = setTimeout(() => {
            btn.textContent = original || "Copy";
        }, 1200);
    });

    els.home?.addEventListener("click", () => {
        window.location.href = "/";
    });

    els.downloadAll?.addEventListener("click", downloadAll);

    els.share?.addEventListener("click", async () => {
        clearStatus();

        const url = window.location.href;

        const shareData = {
            title: "You've got files from files.sahildash.dev!",
            text: "Download files securely:",
            url,
        };

        if (!navigator.share) {
            try {
                await navigator.clipboard.writeText(url);
                showToast("Link copied (sharing not supported)");
            } catch {
                showToast("Sharing not supported");
            }
            return;
        }

        if (navigator.canShare && !navigator.canShare(shareData)) {
            showToast("Cannot share this content");
            return;
        }

        try {
            await navigator.share(shareData);
        } catch (err) {
            if (err?.name !== "AbortError") {
                console.error(err);
                showToast("Share failed");
            }
        }
    });

    els.qr?.addEventListener("click", async () => {
        clearStatus();
        const url = window.location.href;

        await qrModal({ url });
    });

    els.delete?.addEventListener("click", async () => {
        const ok = await confirmModal({
            title: "Delete upload?",
            message: "This will permanently delete the upload and can't be undone."
        });
        if (!ok) return;

        showToast("Deleting Upload!");
        try {
            await fetch(`${API_URL}/uploads/${shareId}/delete`, { method: "DELETE" });
        } catch (err) {
            console.error(err);
            setStatus?.("Delete failed. Please try again.");
            return;
        }
        window.location.reload();
    });
}

async function boot() {
    streamSaver.mitm = `${location.origin}/mitm.html`;

    setMotionIn();
    parseShareFromUrl();
    wireUi();

    if (!shareId || !keyB64) {
        manifest = { files: [] };
        renderList();
        els.empty?.classList.remove("is-hidden");
        setStatus("Invalid URL. Expected format: /<id>#<key>");
        return;
    }

    try {
        meta = await loadMeta();
        updateExpiryText(meta);

        setInterval(async () => {
            const expired = await checkIfExpired();
            if (expired) return;
        }, 10_000);

        await loadManifest();
        renderList();
        clearSelection();
        clearStatus();
    } catch (err) {
        console.error(err);
        manifest = { files: [] };
        renderList();
        els.empty?.classList.remove("is-hidden");
        setStatus("Failed to load files");
    }
}

window.addEventListener("DOMContentLoaded", boot);