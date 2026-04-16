const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
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
    "sql", "swift", "ts", "yaml", "yml", "c", "cpp", "cs", "css", "go", "html", "java", "js",
    "json", "md", "php", "py", "rb", "sh", "bash", "zsh", "shell", "rs"
]);

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const dropContent = document.getElementById("dropContent");
const fileList = document.getElementById("fileList");

const streaming = document.getElementById("streaming");
const statusLine = document.getElementById("statusLine");

const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const uploadingMeta = document.getElementById("uploadingMeta");
const progressPct = document.getElementById("progressPct");
const progressBytes = document.getElementById("progressBytes");

const shareLink = document.getElementById("shareLink");
const copyButton = document.getElementById("copyButton");
const resetButton = document.getElementById("resetButton");

const previewButton = document.getElementById("previewButton");
const preview = document.getElementById("preview");
const previewGrid = document.getElementById("previewGrid");
const closePreviewButton = document.getElementById("closePreviewButton");

const deleteFilesButton = document.getElementById("deleteFilesButton");

const globalDropOverlay = document.getElementById("globalDropOverlay");
const toast = document.getElementById("toast");

let selectedFiles = [];
let uploadTimer = null;
let uploadInFlight = false;
let dragDepth = 0;

let toastTimer = null;
let _customSelectGlobalsWired = false;

let currentUploadId = null;
let uploadAbortController = null;
let uploadCanceled = false;

function raf2(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
}

function showToast(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
}

function pressFx(btn) {
    if (!btn) return;
    btn.classList.remove("pressed");
    void btn.offsetWidth;
    btn.classList.add("pressed");
}

function isVisible(el) {
    return el && !el.classList.contains("is-hidden");
}

function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
}

function totalBytes() {
    return selectedFiles.reduce((sum, f) => sum + (f?.size || 0), 0);
}

function setProgress(pct, sentBytes, total) {
    progressBar.style.width = `${pct}%`;
    progressPct.textContent = `${pct}%`;
    progressBytes.textContent = `${formatBytes(sentBytes)} / ${formatBytes(total)}`;
    progressWrap?.setAttribute("aria-valuenow", String(pct));
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 MB";
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
}

function formatFileSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

function escapeHtml(str) {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function show(el) {
    if (!el) return;
    el.classList.remove("is-hidden");
}

function hide(el) {
    if (!el) return;
    el.classList.add("is-hidden");
}

function expand(el) {
    if (!el) return;

    if (el._collapseEnd) {
        el.removeEventListener("transitionend", el._collapseEnd);
        el._collapseEnd = null;
    }

    el.classList.remove("is-gone");

    void el.offsetHeight;

    requestAnimationFrame(() => {
        el.classList.remove("is-collapsed");
    });
}

function collapse(el) {
    if (!el) return;

    if (el._collapseEnd) {
        el.removeEventListener("transitionend", el._collapseEnd);
        el._collapseEnd = null;
    }

    el.classList.add("is-collapsed");

    const onEnd = (e) => {
        if (e.target !== el) return;
        if (e.propertyName !== "max-height") return;

        if (el.classList.contains("is-collapsed")) {
            el.classList.add("is-gone");
        }

        el.removeEventListener("transitionend", onEnd);
        el._collapseEnd = null;
    };

    el._collapseEnd = onEnd;
    el.addEventListener("transitionend", onEnd);
}

function popInChildren(container, selector, stagger = 22) {
    if (!container) return;
    const items = Array.from(container.querySelectorAll(selector));
    items.forEach((el, i) => {
        el.classList.remove("pop-in");
        void el.offsetWidth;
        el.style.animationDelay = `${i * stagger}ms`;
        el.classList.add("pop-in");
    });
}

function classifyFile(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();

    if (file.type && file.type.startsWith("image/")) return { kind: "image", ext };
    if (file.type && file.type.startsWith("video/")) return { kind: "video", ext };
    if (file.type === "application/pdf" || ext === "pdf") return { kind: "pdf", ext };
    if (file.type && file.type.startsWith("audio/")) return { kind: "audio", ext };

    if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return { kind: "archive", ext };
    if (["txt", "log", "rtf"].includes(ext)) return { kind: "text", ext };
    if (CODE_EXTS.has(ext)) return { kind: "code", ext };

    return { kind: "other", ext };
}

function resolveIcon(file) {
    const { kind, ext } = classifyFile(file);
    if (kind === "code") return CODE_ICONS[ext] || CODE_ICONS.default;
    return ICONS[kind] || ICONS.other;
}

function resetToStartState() {
    hide(streaming);
    preview.classList.add("is-collapsed", "is-gone");
    hide(fileList);
    show(dropContent);

    shareLink.value = "";

    setProgress(0, 0, 0);
    progressBar.style.width = "0%";
    progressWrap.style.display = "";
    progressWrap.classList.remove("spaced");
    uploadingMeta.style.display = "";

    deleteFilesButton.disabled = true;

    globalDropOverlay.classList.remove("active");
    globalDropOverlay.setAttribute("aria-hidden", "true");
    dragDepth = 0;
}

function buildPreviewGrid() {
    previewGrid.innerHTML = "";
    selectedFiles.forEach((file) => {
        const iconSrc = resolveIcon(file);
        const card = document.createElement("div");
        card.className = "preview-card";
        card.innerHTML = `
      <div class="preview-icon"><img src="${iconSrc}" alt=""></div>
      <div class="preview-meta">
        <div class="preview-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
        <div class="preview-sub">${formatFileSize(file.size)}</div>
      </div>
    `;
        previewGrid.appendChild(card);
    });
}

async function cancelUpload() {
    if (uploadTimer) clearInterval(uploadTimer);
    uploadTimer = null;

    uploadCanceled = true;

    if (uploadAbortController) {
        uploadAbortController.abort();
        uploadAbortController = null;
    }

    if (currentUploadId) {
        fetch(`${API_URL}/uploads/${currentUploadId}/cancel`, {
            method: "POST"
        }).catch(() => { });
    }

    uploadInFlight = false;
    currentUploadId = null;

    uploadCanceled = true;
    uploadAbortController?.abort();
    warnOnUnload = false;

    fileInput.value = "";
    selectedFiles = [];
    resetToStartState();
}

function showStreamingShell() {
    hide(dropContent);
    hide(fileList);
    show(streaming);

    statusLine.classList.remove("done", "pop-in");
    statusLine.innerHTML = `
    <div class="status-left">
      <div class="spinner" aria-hidden="true"></div>
      <div class="status-text">
        <div class="status-title">Share link is ready</div>
        <div class="status-sub">No need to wait! People can start downloading before this upload finishes!</div>
      </div>
    </div>
    <button class="cancel-button" id="cancelButton" type="button">Cancel</button>
  `;

    document.getElementById("cancelButton")?.addEventListener("click", cancelUpload);

    progressWrap.style.display = "";
    progressWrap.classList.add("spaced");
    uploadingMeta.style.display = "";

    deleteFilesButton.disabled = true;

    collapse(preview);
    buildPreviewGrid();

    popInChildren(previewGrid, ".preview-card", 18);
}

function displayFiles() {
    if (selectedFiles.length === 0) {
        show(dropContent);
        hide(fileList);
        hide(streaming);
        return;
    }

    hide(dropContent);
    show(fileList);
    fileList.innerHTML = "";

    selectedFiles.forEach((file, index) => {
        const fileItem = document.createElement("div");
        fileItem.className = "file-item";
        fileItem.innerHTML = `
      <svg class="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
        <polyline points="13 2 13 9 20 9"></polyline>
      </svg>
      <div class="file-info">
        <p class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</p>
        <p class="file-size">${formatFileSize(file.size)}</p>
      </div>
      <button class="remove-button" type="button" aria-label="Remove file" data-remove="${index}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;
        fileList.appendChild(fileItem);

        fileItem.classList.add("pop-in");
        fileItem.style.animationDelay = `${index * 20}ms`;
    });

    fileList.querySelectorAll("[data-remove]").forEach((btn) => {
        btn.addEventListener("click", () => {
            if (uploadInFlight) return;
            const i = Number(btn.getAttribute("data-remove"));
            selectedFiles = selectedFiles.filter((_, idx) => idx !== i);
            if (selectedFiles.length === 0) fileInput.value = "";
            displayFiles();
        });
    });
}

function infoModal({ title, message, okText }) {
    const modal = document.getElementById("confirmModal");
    const titleEl = document.getElementById("confirmTitle");
    const bodyEl = modal?.querySelector(".modal__body");
    const okBtn = document.getElementById("confirmOkBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");

    if (!modal || !titleEl || !bodyEl || !okBtn || !cancelBtn) {
        alert(message);
        return Promise.resolve(true);
    }

    titleEl.textContent = title;
    bodyEl.textContent = message;

    okBtn.textContent = okText;
    okBtn.classList.remove("is-danger");
    cancelBtn.style.display = "none";

    document.body.classList.add("modal-open");
    modal.classList.add("is-open");
    okBtn.focus();

    return new Promise((resolve) => {
        const cleanup = () => {
            okBtn.removeEventListener("click", onOk);
            modal.removeEventListener("click", onBackdrop);
            document.removeEventListener("keydown", onKey);

            cancelBtn.style.display = "";
            okBtn.textContent = "Delete";
            okBtn.classList.add("is-danger");

            resolve(true);
        };

        const close = () => {
            modal.classList.remove("is-open");
            document.body.classList.remove("modal-open");

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

        const onOk = close;

        const onBackdrop = (e) => {
            if (e.target?.dataset?.close) close();
        };

        const onKey = (e) => {
            if (e.key === "Escape" || e.key === "Enter") close();
        };

        okBtn.addEventListener("click", onOk);
        modal.addEventListener("click", onBackdrop);
        document.addEventListener("keydown", onKey);
    });
}

function handleFiles(files) {
    if (!files || files.length === 0) return;

    const total = files.reduce((sum, f) => sum + (f?.size || 0), 0);
    if (total > MAX_TOTAL_BYTES) {
        fileInput.value = "";
        resetToStartState();
        infoModal({
            title: "Too large",
            message: "Max total upload size is 10 GB. Please remove some files and try again.",
            okText: "Got it"
        });
        return;
    }

    selectedFiles = files;
    displayFiles();
    showStreamingShell();
    startUpload();
}

function buildManifest(key) {
    const chunkSize = 1 * 1024 * 1024;
    let currentChunk = 0;

    const files = selectedFiles.map(file => {
        const chunkCount = Math.ceil(file.size / chunkSize);

        const entry = {
            name: file.name,
            size: file.size,
            type: file.type || "application/octet-stream",
            startChunk: currentChunk,
            chunkCount
        };

        currentChunk += chunkCount;
        return entry;
    });

    const manifest = {
        chunkSize,
        totalBytes: totalBytes(),
        totalChunks: currentChunk,
        files
    };

    const compressed = window.zstd.compress(new TextEncoder().encode(JSON.stringify(manifest)));

    const nonce = sodium.randombytes_buf(12);
    const cipher = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
        compressed,
        null,
        null,
        nonce,
        key
    );

    const encrypted = new Uint8Array(nonce.length + cipher.length);
    encrypted.set(nonce, 0)
    encrypted.set(cipher, nonce.length);

    return encrypted;
}

async function buildChunk(fileSlice, key) {
    const bytes = new Uint8Array(await fileSlice.arrayBuffer());
    const compressed = window.zstd.compress(bytes);

    const nonce = sodium.randombytes_buf(12);
    const cipher = sodium.crypto_aead_chacha20poly1305_ietf_encrypt(
        compressed,
        null,
        null,
        nonce,
        key
    );

    const encrypted = new Uint8Array(nonce.length + cipher.length);
    encrypted.set(nonce, 0);
    encrypted.set(cipher, nonce.length);
    return encrypted;
}

function frameChunk(chunkIndex, payloadU8) {
    const header = new ArrayBuffer(8);
    const dv = new DataView(header);
    dv.setUint32(0, chunkIndex >>> 0, false);
    dv.setUint32(4, payloadU8.byteLength >>> 0, false);

    const out = new Uint8Array(8 + payloadU8.byteLength);
    out.set(new Uint8Array(header), 0);
    out.set(payloadU8, 8);
    return out;
}

async function startUpload() {
    if (uploadInFlight) return;
    uploadInFlight = true;

    let id;
    try {
        const res = await fetch(`${API_URL}/uploads`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ totalBytes: totalBytes() }),
        });
        if (!res.ok) throw new Error(await res.text());
        id = (await res.json()).id;
    } catch (err) {
        console.error(err);
        uploadInFlight = false;
        return;
    }

    currentUploadId = id;
    uploadCanceled = false;
    uploadAbortController = new AbortController();

    const key = sodium.crypto_aead_chacha20poly1305_ietf_keygen();
    const keyb64 = sodium.to_base64(key, sodium.base64_variants.URLSAFE_NO_PADDING);
    shareLink.value = `${API_URL}/${id}#${keyb64}`;

    const r = await fetch(`${API_URL}/uploads/${id}/manifest`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buildManifest(key),
        signal: uploadAbortController.signal,
    });
    if (!r.ok) {
        console.error("manifest failed", r.status, await r.text().catch(() => ""));
        uploadInFlight = false;
        return;
    }

    const chunkSize = 1024 * 1024;
    const TARGET_BATCH_BYTES = 8 * 1024 * 1024;
    const MAX_BATCH_BYTES = TARGET_BATCH_BYTES - (128 * 1024);
    const FRAME_OVERHEAD = 8;
    const MAX_IN_FLIGHT = 1;

    const total = totalBytes();

    let chunkIndex = 0;
    let fileIndex = 0;
    let fileOffset = 0;

    let uploadedPlain = 0;
    let inFlightPlain = 0;
    let preparedPlain = 0;

    const PREP_WEIGHT = 0.15;

    const MB = 1024 * 1024;
    let shownBytes = 0;
    let targetBytes = 0;
    let lastRealBytes = 0;
    let lastRealTs = performance.now();

    let tickTimer = null;
    let tickEveryMs = 50;

    function weightedPct(preparedBytes, uploadedBytes) {
        const prepPart = total ? Math.min(1, preparedBytes / total) : 0;
        const uploadPart = total ? Math.min(1, uploadedBytes / total) : 0;

        const pct =
            (prepPart * (PREP_WEIGHT * 100)) +
            (uploadPart * ((1 - PREP_WEIGHT) * 100));

        return Math.min(99, Math.floor(pct));
    }

    function weightedBytes(preparedBytes, uploadedBytes) {
        const prepPart = total ? Math.min(1, preparedBytes / total) : 0;
        const uploadPart = total ? Math.min(1, uploadedBytes / total) : 0;

        const w =
            (prepPart * (PREP_WEIGHT * total)) +
            (uploadPart * ((1 - PREP_WEIGHT) * total));

        return Math.min(total, Math.floor(w));
    }

    function bumpPrepared(delta) {
        preparedPlain += delta;

        const uploadedSoFar = uploadedPlain + inFlightPlain;
        const pct = weightedPct(preparedPlain, uploadedSoFar);
        const bytes = weightedBytes(preparedPlain, uploadedSoFar);

        targetBytes = Math.max(targetBytes, bytes);
        shownBytes = Math.max(shownBytes, bytes);

        setProgress(pct, bytes, total);
    }

    function ensureTickerRunning() {
        if (tickTimer) return;

        tickTimer = setInterval(() => {
            if (shownBytes >= targetBytes) {
                clearInterval(tickTimer);
                tickTimer = null;
                return;
            }

            shownBytes = Math.min(targetBytes, shownBytes + MB);

            const pct = weightedPct(preparedPlain, uploadedPlain + inFlightPlain);
            setProgress(pct, shownBytes, total);
        }, tickEveryMs);
    }


    function buffersToBlob(buffers) {
        return new Blob(buffers, { type: "application/octet-stream" });
    }

    function uploadBatchXHR(url, blob, { signal, headers, onProgress } = {}) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", url, true);

            if (headers) {
                for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
            }

            xhr.upload.onprogress = (e) => {
                const totalBytes = e.lengthComputable ? e.total : blob.size;
                onProgress?.(e.loaded, totalBytes);
            };

            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) return resolve();
                reject(new Error(`upload failed: ${xhr.status} ${xhr.responseText || ""}`));
            };

            xhr.onerror = () => reject(new Error("network error"));
            xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));

            if (signal) {
                if (signal.aborted) {
                    xhr.abort();
                    return reject(new DOMException("Aborted", "AbortError"));
                }
                signal.addEventListener("abort", () => xhr.abort(), { once: true });
            }

            xhr.send(blob);
        });
    }

    async function postWithRetry(url, {
        headers,
        makeBlob,
        signal,
        tries = 5,
        baseDelayMs = 400,
        maxDelayMs = 8000,
        onRetry,
        onProgress,
    } = {}) {
        let lastErr;

        for (let attempt = 0; attempt < tries; attempt++) {
            if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

            try {
                const blob = makeBlob();
                await uploadBatchXHR(url, blob, { signal, headers, onProgress });
                return;
            } catch (err) {
                lastErr = err;

                if (err?.name === "AbortError") throw err;
                if (attempt === tries - 1) break;

                const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
                const jitter = exp * 0.2 * Math.random();
                const delay = Math.floor(exp + jitter);

                onRetry?.({ attempt: attempt + 1, delay, err });

                await new Promise((resolve, reject) => {
                    const t = setTimeout(resolve, delay);
                    if (signal) {
                        signal.addEventListener("abort", () => {
                            clearTimeout(t);
                            reject(new DOMException("Aborted", "AbortError"));
                        }, { once: true });
                    }
                });
            }
        }

        throw lastErr;
    }

    async function buildBatch(maxBytes) {
        const buffers = [];
        let plainBytesInBatch = 0;
        let encodedBytesInBatch = 0;

        while (fileIndex < selectedFiles.length) {
            if (uploadCanceled) throw new Error("upload canceled");

            const file = selectedFiles[fileIndex];
            const end = Math.min(fileOffset + chunkSize, file.size);
            const slice = file.slice(fileOffset, end);
            const plainDelta = end - fileOffset;

            const encrypted = await buildChunk(slice, key);
            const framedSize = FRAME_OVERHEAD + encrypted.byteLength;

            if (buffers.length > 0 && (encodedBytesInBatch + framedSize) > maxBytes) break;

            buffers.push(frameChunk(chunkIndex, encrypted));

            bumpPrepared(plainDelta);
            plainBytesInBatch += plainDelta;
            encodedBytesInBatch += framedSize;

            fileOffset = end;
            chunkIndex++;

            if (fileOffset >= file.size) {
                fileIndex++;
                fileOffset = 0;
            }
        }

        return { buffers, plainBytesInBatch, encodedBytesInBatch };
    }

    async function uploadBatch(buffers, plainBytesInBatch) {
        inFlightPlain = 0;

        await postWithRetry(`${API_URL}/uploads/${id}/data`, {
            headers: { "Content-Type": "application/octet-stream" },
            makeBlob: () => buffersToBlob(buffers),
            signal: uploadAbortController.signal,
            tries: 5,
            onRetry: ({ attempt, delay }) => {
                console.warn(`Retry ${attempt} in ${delay}ms`);
                inFlightPlain = 0;
            },
            onProgress: (loaded, totalBytes) => {
                const ratio = totalBytes ? (loaded / totalBytes) : 0;
                inFlightPlain = Math.floor(plainBytesInBatch * ratio);

                const uploadedSoFar = Math.min(total, uploadedPlain + inFlightPlain);

                const realBytes = weightedBytes(preparedPlain, uploadedSoFar);
                targetBytes = Math.max(targetBytes, realBytes);

                const now = performance.now();
                const deltaBytes = Math.max(0, realBytes - lastRealBytes);
                const dt = Math.max(1, now - lastRealTs);

                const steps = Math.max(1, Math.round(deltaBytes / MB));
                tickEveryMs = Math.max(16, Math.floor(dt / steps));

                if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
                ensureTickerRunning();

                lastRealBytes = realBytes;
                lastRealTs = now;

                const pct = weightedPct(preparedPlain, uploadedSoFar);
                setProgress(pct, shownBytes, total);
            }
        });

        uploadedPlain += plainBytesInBatch;
        inFlightPlain = 0;

        const uploadedSoFar = Math.min(total, uploadedPlain);
        targetBytes = weightedBytes(preparedPlain, uploadedSoFar);
        shownBytes = Math.max(shownBytes, targetBytes);

        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }

        const pct = weightedPct(preparedPlain, uploadedSoFar);
        setProgress(pct, shownBytes, total);
    }

    warnOnUnload = true;

    try {
        const inFlight = new Set();

        while (fileIndex < selectedFiles.length || inFlight.size > 0) {
            if (uploadCanceled) throw new Error("upload canceled");

            while (fileIndex < selectedFiles.length && inFlight.size < MAX_IN_FLIGHT) {
                const { buffers, plainBytesInBatch } = await buildBatch(MAX_BATCH_BYTES);
                if (buffers.length === 0) break;

                const p = uploadBatch(buffers, plainBytesInBatch).finally(() => inFlight.delete(p));
                inFlight.add(p);
            }

            if (inFlight.size > 0) {
                await Promise.race(inFlight);
            }
        }

        if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
        setProgress(100, total, total);
        finishUpload();
    } catch (err) {
        console.error(err);
    } finally {
        warnOnUnload = false;
        uploadInFlight = false;
    }
}

function finishUpload() {
    warnOnUnload = false;

    if (uploadTimer) clearInterval(uploadTimer);
    uploadTimer = null;
    uploadInFlight = false;

    statusLine.classList.add("done");
    statusLine.innerHTML = `
    <div class="status-left">
      <div class="success-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      <div class="status-text">
        <div class="done-title">Upload complete</div>
        <div class="done-sub">Your link is ready to share!</div>
      </div>
    </div>
  `;

    statusLine.classList.remove("pop-in");
    void statusLine.offsetWidth;
    statusLine.classList.add("pop-in");

    setProgress(100, totalBytes(), totalBytes());

    progressBar.style.width = "0%";
    progressWrap.style.display = "none";
    uploadingMeta.style.display = "none";

    deleteFilesButton.disabled = false;
}

function resetAll() {
    if (uploadTimer) clearInterval(uploadTimer);
    uploadTimer = null;
    uploadInFlight = false;

    selectedFiles = [];
    fileInput.value = "";

    resetToStartState();
}

function initCustomSelects(root = document) {
    const selects = Array.from(root.querySelectorAll("select.js-custom-select"));
    if (selects.length === 0) return;

    if (!_customSelectGlobalsWired) {
        _customSelectGlobalsWired = true;

        document.addEventListener("click", (e) => {
            document.querySelectorAll("select.js-custom-select").forEach((sel) => {
                const wrap = sel._csWrap;
                if (!wrap) return;
                if (!wrap.contains(e.target)) closeCustomSelect(sel);
            });
        });

        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            document.querySelectorAll("select.js-custom-select").forEach((sel) => closeCustomSelect(sel));
        });
    }

    selects.forEach((selectEl) => enhanceSelect(selectEl));
}

async function updateUploadMeta({ expiryTime, maxDownloads }) {
    if (!currentUploadId) return;

    const body = {};
    if (expiryTime != null) body.expiryTime = expiryTime;
    if (maxDownloads != null) body.maxDownloads = maxDownloads;

    try {
        const r = await fetch(`${API_URL}/uploads/${currentUploadId}/update`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });

        if (!r.ok) {
            const msg = await r.text().catch(() => "");
            throw new Error(msg || `Update failed (${r.status})`);
        }
    } catch (e) {
        console.error(e);
        showToast("Update failed");
    }
}

function enhanceSelect(selectEl) {
    if (selectEl._csEnhanced) return;
    selectEl._csEnhanced = true;

    const wrap = document.createElement("div");
    wrap.className = "cs";
    selectEl.parentNode.insertBefore(wrap, selectEl);
    wrap.appendChild(selectEl);

    selectEl.classList.add("cs-native");
    selectEl.tabIndex = -1;
    selectEl._csWrap = wrap;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cs-btn";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");

    const label = document.createElement("span");
    label.className = "cs-label";

    const caret = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    caret.setAttribute("class", "cs-caret");
    caret.setAttribute("viewBox", "0 0 24 24");
    caret.setAttribute("fill", "none");
    caret.setAttribute("stroke", "currentColor");
    caret.setAttribute("stroke-width", "2");
    caret.setAttribute("stroke-linecap", "round");
    caret.setAttribute("stroke-linejoin", "round");
    caret.innerHTML = `<polyline points="6 9 12 15 18 9"></polyline>`;

    btn.appendChild(label);
    btn.appendChild(caret);
    wrap.appendChild(btn);

    const list = document.createElement("div");
    list.className = "cs-list";
    list.setAttribute("role", "listbox");
    const listId = `cs_${selectEl.id || Math.random().toString(16).slice(2)}`;
    list.id = listId;
    btn.setAttribute("aria-controls", listId);
    wrap.appendChild(list);

    function rebuildOptions() {
        list.innerHTML = "";
        const opts = Array.from(selectEl.options);

        opts.forEach((opt, idx) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "cs-opt";
            item.setAttribute("role", "option");
            item.dataset.value = opt.value;
            item.dataset.index = String(idx);
            item.setAttribute("aria-selected", opt.selected ? "true" : "false");

            const text = document.createElement("span");
            text.textContent = opt.textContent || opt.label || opt.value;

            const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            check.setAttribute("class", "cs-check");
            check.setAttribute("viewBox", "0 0 24 24");
            check.setAttribute("fill", "none");
            check.setAttribute("stroke", "currentColor");
            check.setAttribute("stroke-width", "2.2");
            check.setAttribute("stroke-linecap", "round");
            check.setAttribute("stroke-linejoin", "round");
            check.innerHTML = `<polyline points="20 6 9 17 4 12"></polyline>`;
            check.style.visibility = opt.selected ? "visible" : "hidden";

            item.appendChild(text);
            item.appendChild(check);

            item.addEventListener("click", () => {
                if (opt.value === "__custom__") {
                    closeCustomSelect(selectEl);
                    openCustomPicker(selectEl);
                    return;
                }

                selectEl.value = opt.value;
                selectEl.dispatchEvent(new Event("change", { bubbles: true }));
                syncFromNative();
                closeCustomSelect(selectEl);
                btn.focus();
            });

            list.appendChild(item);
        });
    }

    function syncFromNative() {
        const selected = selectEl.selectedOptions?.[0] || selectEl.options[selectEl.selectedIndex];
        label.textContent = selected ? (selected.textContent || selected.label || selected.value) : "Select...";

        Array.from(list.querySelectorAll(".cs-opt")).forEach((el) => {
            const v = el.dataset.value;
            const isSel = v === selectEl.value;
            el.setAttribute("aria-selected", isSel ? "true" : "false");
            const svg = el.querySelector(".cs-check");
            if (svg) svg.style.visibility = isSel ? "visible" : "hidden";
        });
    }

    function focusOption(selectEl, index) {
        const items = Array.from(selectEl._csList.querySelectorAll(".cs-opt"));
        const clamped = Math.max(0, Math.min(index, items.length - 1));
        items[clamped]?.focus();
    }

    function moveActive(selectEl, delta) {
        const items = Array.from(selectEl._csList.querySelectorAll(".cs-opt"));
        if (items.length === 0) return;

        const activeIndex = items.findIndex((x) => x === document.activeElement);
        const selectedIndex = Math.max(0, selectEl.selectedIndex);
        const base = activeIndex >= 0 ? activeIndex : selectedIndex;
        focusOption(selectEl, base + delta);
    }

    selectEl._csRebuild = () => {
        rebuildOptions();
        syncFromNative();
    };

    btn.addEventListener("click", () => {
        wrap.classList.contains("open") ? closeCustomSelect(selectEl) : openCustomSelect(selectEl, true);
    });

    btn.addEventListener("keydown", (e) => {
        const key = e.key;
        const isOpen = wrap.classList.contains("open");

        if (key === "Enter" || key === " ") {
            e.preventDefault();
            isOpen ? closeCustomSelect(selectEl) : openCustomSelect(selectEl, true);
            return;
        }

        if (key === "ArrowDown" || key === "ArrowUp") {
            e.preventDefault();
            openCustomSelect(selectEl, true);
            moveActive(selectEl, key === "ArrowDown" ? 1 : -1);
            return;
        }
    });

    list.addEventListener("keydown", (e) => {
        const key = e.key;
        if (key === "ArrowDown" || key === "ArrowUp") {
            e.preventDefault();
            moveActive(selectEl, key === "ArrowDown" ? 1 : -1);
            return;
        }
        if (key === "Home") {
            e.preventDefault();
            focusOption(selectEl, 0);
            return;
        }
        if (key === "End") {
            e.preventDefault();
            const count = list.querySelectorAll(".cs-opt").length;
            focusOption(selectEl, Math.max(0, count - 1));
            return;
        }
        if (key === "Escape") {
            e.preventDefault();
            closeCustomSelect(selectEl);
            btn.focus();
        }
    });

    selectEl.addEventListener("change", syncFromNative);

    selectEl.addEventListener("change", () => {
        if (selectEl.id === "expiryTime") {
            updateUploadMeta({ expiryTime: selectEl.value });
        } else if (selectEl.id === "expiryDownloads") {
            updateUploadMeta({ maxDownloads: Number(selectEl.value) });
        }
    });

    rebuildOptions();
    syncFromNative();

    selectEl._csBtn = btn;
    selectEl._csList = list;
}

function openCustomSelect(selectEl, focusSelected = false) {
    document.querySelectorAll(".cs.open").forEach((el) => el.classList.remove("open"));

    const wrap = selectEl._csWrap;
    if (!wrap) return;

    wrap.classList.add("open");
    selectEl._csBtn?.setAttribute("aria-expanded", "true");

    const list = selectEl._csList;
    if (list) {
        list.tabIndex = -1;
        list.focus();

        if (focusSelected) {
            const opts = Array.from(list.querySelectorAll(".cs-opt"));
            const idx = Math.max(0, selectEl.selectedIndex);
            opts[idx]?.focus();
        }
    }
}

function closeCustomSelect(selectEl) {
    const wrap = selectEl._csWrap;
    if (!wrap) return;
    wrap.classList.remove("open");
    selectEl._csBtn?.setAttribute("aria-expanded", "false");
}

function formatExpiryLabel(value, type) {
    if (type === "downloads") {
        const n = Number(value);
        if (!Number.isFinite(n)) return String(value);
        return `after ${n} download${n === 1 ? "" : "s"}`;
    }

    const m = String(value).match(/^(\d+)(m|h|d)$/);
    if (!m) return String(value);

    const n = Number(m[1]);
    const unit = m[2];
    if (unit === "m") return `after ${n} minute${n === 1 ? "" : "s"}`;
    if (unit === "h") return `after ${n} hour${n === 1 ? "" : "s"}`;
    if (unit === "d") return `after ${n} day${n === 1 ? "" : "s"}`;
    return String(value);
}

function upsertCustomOption(selectEl, value, label) {
    let opt = Array.from(selectEl.options).find((o) => o.dataset && o.dataset.customApplied === "true");

    if (!opt) {
        opt = document.createElement("option");
        opt.dataset.customApplied = "true";

        const customIndex = Array.from(selectEl.options).findIndex((o) => o.value === "__custom__");
        if (customIndex >= 0) selectEl.insertBefore(opt, selectEl.options[customIndex]);
        else selectEl.appendChild(opt);
    }

    opt.value = value;
    opt.textContent = label;
    opt.selected = true;
}

async function flattenDroppedFiles(e) {
    showToast("Thank you for using files.sahildash.dev!");

    const dt = e?.dataTransfer;
    if (!dt) return [];

    const items = Array.from(dt.items || []);

    const hasDirectoryEntry = items.some((it) => {
        if (it.kind !== "file" || typeof it.webkitGetAsEntry !== "function") return false;
        const entry = it.webkitGetAsEntry();
        return entry && entry.isDirectory;
    });

    async function walk(entry) {
        if (!entry) return [];

        if (entry.isFile) {
            const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
            return [file];
        }

        if (entry.isDirectory) {
            const reader = entry.createReader();
            const all = [];
            while (true) {
                const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                if (!batch || batch.length === 0) break;
                for (const child of batch) all.push(...(await walk(child)));
            }
            return all;
        }

        return [];
    }

    let files = [];

    if (hasDirectoryEntry) {
        for (const item of items) {
            if (item.kind !== "file") continue;
            const entry = item.webkitGetAsEntry?.();
            if (!entry) continue;
            files.push(...(await walk(entry)));
        }
    } else {
        files = Array.from(dt.files || []);
    }

    const seen = new Set();
    const out = [];
    for (const f of files) {
        if (!f) continue;
        const key = `${f.name}\u0000${f.size}\u0000${f.lastModified}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
    }

    return out;
}

let warnOnUnload = false;

function onBeforeUnload(e) {
    if (!warnOnUnload) return;
    e.preventDefault();
    e.returnValue = "";
    return "";
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

function wireEvents() {
    const onMessage = (event) => {
        if (!["https://stash.sahildash.dev", "http://localhost:6003"].includes(event.origin)) return;

        if (event.data?.type === "stash:ping") {
            try {
                event.source?.postMessage(
                    { type: "stash:ready" },
                    event.origin
                );
            } catch (err) {
                console.error("Failed to reply ready:", err);
            }
            return;
        }

        if (event.data?.type === "stash:files") {
            const files = (event.data.files || []).map((f) =>
                new File(
                    [f.buffer],
                    f.name,
                    { type: f.type || "application/octet-stream" }
                )
            );

            if (files.length) handleFiles(files);
        }
    };

    window.addEventListener("message", onMessage);

    window.addEventListener("DOMContentLoaded", () => {
        const hdr = document.getElementById("hdrMotion");
        const card = document.getElementById("cardMotion");
        const about = document.getElementById("aboutMotion");

        raf2(() => {
            hdr && hdr.classList.remove("is-hidden");
            setTimeout(() => card && card.classList.remove("is-hidden"), 70);
            setTimeout(() => about && about.classList.remove("is-hidden"), 120);
        });

        resetToStartState();
        initCustomSelects();
    });

    window.addEventListener("beforeunload", onBeforeUnload);

    window.addEventListener("dragenter", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        if (!uploadInFlight && !isVisible(streaming)) {
            globalDropOverlay.classList.add("active");
            globalDropOverlay.setAttribute("aria-hidden", "false");
        }
    });

    window.addEventListener("dragover", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
    });

    window.addEventListener("dragleave", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            globalDropOverlay.classList.remove("active");
            globalDropOverlay.setAttribute("aria-hidden", "true");
        }
    });

    window.addEventListener("drop", async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        globalDropOverlay.classList.remove("active");
        globalDropOverlay.setAttribute("aria-hidden", "true");
        if (uploadInFlight) return;

        handleFiles(await flattenDroppedFiles(e));
    });

    dropZone.addEventListener("dragover", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dropZone.classList.add("dragging");
    });

    dropZone.addEventListener("dragleave", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dropZone.classList.remove("dragging");
    });


    dropZone.addEventListener("drop", async (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dropZone.classList.remove("dragging");
        if (uploadInFlight) return;

        handleFiles(await flattenDroppedFiles(e));
    });

    fileInput.addEventListener("change", (e) => {
        handleFiles(Array.from(e.target.files || []));
    });

    previewButton.addEventListener("click", () => {
        const isCollapsed = preview.classList.contains("is-collapsed");
        if (isCollapsed) {
            expand(preview);
            popInChildren(previewGrid, ".preview-card", 18);
        } else {
            collapse(preview);
        }
    });

    closePreviewButton.addEventListener("click", () => {
        collapse(preview);
    });

    copyButton.addEventListener("click", async () => {
        pressFx(copyButton);

        const text = shareLink.value || "";
        if (!text) {
            showToast("No link yet");
            return;
        }

        try {
            await navigator.clipboard.writeText(text);
            copyButton.textContent = "Copied!";
            showToast("Link copied");
            setTimeout(() => (copyButton.textContent = "Copy"), 1200);
        } catch {
            shareLink.focus();
            shareLink.select();
            document.execCommand("copy");
            showToast("Link copied");
        }
    });

    resetButton.addEventListener("click", resetAll);

    deleteFilesButton.addEventListener("click", async () => {
        const ok = await confirmModal({
            title: "Delete upload?",
            message: "This will permanently delete the upload and can't be undone."
        });
        if (!ok) return;

        showToast("Deleting Upload!");
        try {
            await fetch(`${API_URL}/uploads/${currentUploadId}/delete`, { method: "DELETE" });
        } catch (err) {
            console.error(err);
            showToast("Delete failed. Please try again.");
            return;
        }
        window.location.reload();
    });
}

wireEvents();
