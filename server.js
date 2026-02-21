const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const path = require("path");
const checkDiskSpace = require("check-disk-space").default;
const { once, EventEmitter } = require("events");

const canceledUploads = new Set();
const uploadLocks = new Map();
const uploadSignals = new Map();

function signalFor(id) {
    let e = uploadSignals.get(id);
    if (!e) {
        e = new EventEmitter();
        e.setMaxListeners(0);
        uploadSignals.set(id, e);
    }
    return e;
}

const app = express();
const port = 8080;

app.set("trust proxy", 1);

app.use("/", express.static(path.join(__dirname, "frontend")));
app.use(express.json());

app.use("/:id", async (req, res, next) => {
    const id = req.params.id;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return next();
    }

    const metaPath = path.join(__dirname, "uploads", id, "metadata.json");
    let meta = null;

    try {
        meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
    } catch {
        meta = null;
    }

    const now = Date.now();
    const max = Number(meta?.maxDownloads);
    const total = Number(meta?.totalDownloads || 0);

    const valid = meta && !meta.canceled && (!meta.expiresAt || meta.expiresAt > now) && !(Number.isFinite(max) && max > 0 && total >= max);

    if (!valid) {
        return res.status(404).sendFile(path.join(__dirname, "frontend", "404.html"));
    }

    return express.static(path.join(__dirname, "frontend", "download"), {
        index: "index.html",
    })(req, res, next);
});

app.post("/uploads", (req, res) => {
    const uuid = crypto.randomUUID();
    const dir = `./uploads/${uuid}`;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/data.enc`, "");
    fs.writeFileSync(`${dir}/indexes.bin`, "");

    const totalBytes = Number(req.body?.totalBytes);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
        console.log(`[UPLOAD CREATE] Invalid totalBytes from client:`, req.body?.totalBytes);
        return res.status(400).json({ error: "Invalid totalBytes" });
    }

    const MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;
    if (totalBytes > MAX_TOTAL_BYTES) {
        console.log(`[UPLOAD CREATE] Upload too large: ${totalBytes} bytes`);
        return res.status(413).json({ error: "Upload too large" });
    }

    const meta = {
        createdAt: Date.now(),
        expiryKey: "24h",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        bytesWritten: 0,
        totalBytes,
        completed: false,
        maxDownloads: 1,
        totalDownloads: 0,
        activeDownloads: 0,
        lastDownloadAt: null,
    };

    fs.writeFileSync(`${dir}/metadata.json`, JSON.stringify(meta), "utf-8");

    console.log(`[UPLOAD CREATE] New upload created: ${uuid}, expected ${totalBytes} bytes`);
    res.status(201).json({ id: uuid });
});

app.post("/uploads/:id/manifest", express.raw({ type: "application/octet-stream", limit: "5mb" }), (req, res) => {
    const { id } = req.params;
    const dir = `./uploads/${id}`;
    const file = `./uploads/${id}/manifest.enc`;

    if (canceledUploads.has(id)) {
        return res.status(410).json({ error: "Upload canceled" });
    }

    if (!fs.existsSync(dir)) {
        console.log(`[UPLOAD MANIFEST] Invalid upload id: ${id}`);
        return res.status(400).json({ error: "Invalid upload id" });
    }
    if (fs.existsSync(file)) {
        console.log(`[UPLOAD MANIFEST] Manifest already written for ${id}`);
        return res.status(409).json({ error: "Manifest already written" });
    }
    if (!req.body || req.body.length === 0) {
        console.log(`[UPLOAD MANIFEST] Empty manifest for ${id}`);
        return res.status(400).json({ error: "Empty manifest" });
    }

    fs.writeFileSync(file, req.body);
    console.log(`[UPLOAD MANIFEST] Manifest written for ${id}, size ${req.body.length} bytes`);
    res.status(204).end();
});

app.post("/uploads/:id/data", async (req, res) => {
    async function withUploadLock(id, fn) {
        const prev = uploadLocks.get(id) || Promise.resolve();

        let release;
        const gate = new Promise(r => (release = r));

        uploadLocks.set(id, prev.then(() => gate));

        await prev;

        try {
            return await fn();
        } finally {
            release();
            if (uploadLocks.get(id) === gate) uploadLocks.delete(id);
        }
    }

    function makeBufReader() {
        let bufs = [];
        let len = 0;

        return {
            push(b) { if (b?.length) { bufs.push(b); len += b.length; } },
            size() { return len; },

            peek(n) {
                if (len < n) return null;
                if (bufs[0].length >= n) return bufs[0].subarray(0, n);
                const out = Buffer.allocUnsafe(n);
                let off = 0;
                for (const buf of bufs) {
                    const take = Math.min(buf.length, n - off);
                    buf.copy(out, off, 0, take);
                    off += take;
                    if (off === n) break;
                }
                return out;
            },

            read(n) {
                if (len < n) return null;
                const out = Buffer.allocUnsafe(n);
                let off = 0;

                while (off < n) {
                    const b = bufs[0];
                    const take = Math.min(b.length, n - off);
                    b.copy(out, off, 0, take);

                    if (take === b.length) bufs.shift();
                    else bufs[0] = b.subarray(take);

                    off += take;
                    len -= take;
                }
                return out;
            }
        };
    }

    const { id } = req.params;

    return withUploadLock(id, async () => {
        if (canceledUploads.has(id)) {
            console.log(`[UPLOAD DATA] ${id} rejected (canceled)`);
            return res.status(410).json({ error: "Upload canceled" });
        }

        if (req.destroyed || !res.writable) {
            console.log(`[UPLOAD DATA] ${id} request gone before lock acquired`);
            return;
        }

        const uploadDir = path.join(__dirname, "uploads", id);
        if (!fs.existsSync(uploadDir)) {
            console.log(`[UPLOAD DATA] ${id} invalid upload id`);
            return res.status(400).json({ error: "Invalid upload id" });
        }

        const dataPath = path.join(uploadDir, "data.enc");
        const indexPath = path.join(uploadDir, "indexes.bin");

        const dataStream = fs.createWriteStream(dataPath, { flags: "a" });
        const indexStream = fs.createWriteStream(indexPath, { flags: "a" });

        function cleanup(err) {
            dataStream.destroy();
            indexStream.destroy();
            if (err) console.error(`[UPLOAD DATA] ${id} error:`, err.message || err);
        }

        req.on("aborted", () => {
            console.log(`[UPLOAD DATA] ${id} aborted`);
            cleanup(new Error("request aborted"));
        });

        req.on("error", (err) => {
            console.error(`[UPLOAD DATA] ${id} request error:`, err.message);
            cleanup(err);
        });

        let offset = 0;
        try {
            if (fs.existsSync(dataPath)) offset = fs.statSync(dataPath).size;
        } catch { }

        async function writeTo(stream, buf) {
            if (!stream.write(buf)) {
                await once(stream, "drain");
            }
        }

        const r = makeBufReader();
        let frames = 0;

        try {
            for await (const chunk of req) {
                r.push(chunk);

                while (r.size() >= 8) {
                    const hdr = r.peek(8);
                    const chunkIndex = hdr.readUInt32BE(0);
                    const payloadLen = hdr.readUInt32BE(4);

                    if (payloadLen <= 0) throw new Error(`Invalid payloadLen ${payloadLen}`);
                    if (r.size() < 8 + payloadLen) break;

                    r.read(8);
                    const payload = r.read(payloadLen);

                    await writeTo(dataStream, payload);

                    const rec = Buffer.alloc(16);
                    rec.writeUInt32BE(chunkIndex, 0);
                    rec.writeBigUInt64BE(BigInt(offset), 4);
                    rec.writeUInt32BE(payloadLen, 12);
                    await writeTo(indexStream, rec);

                    signalFor(id).emit("index");

                    offset += payloadLen;
                    frames++;
                }

                if (r.size() > 16 * 1024 * 1024) throw new Error("Framing buffer too large");
            }

            if (r.size() !== 0) throw new Error("Upload ended with incomplete frame");

            dataStream.end();
            indexStream.end();
            await Promise.all([once(dataStream, "finish"), once(indexStream, "finish")]);

            res.status(204).end();

        } catch (err) {
            console.error(`[UPLOAD DATA] ${id} failed:`, err.message || err);
            cleanup(err);
            if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
        }
    });
});

app.post("/uploads/:id/cancel", async (req, res) => {
    const { id } = req.params;
    const dir = path.join("./uploads", id);

    if (!fs.existsSync(dir)) {
        return res.status(404).json({ error: "Upload not found" });
    }

    console.log(`[UPLOAD CANCEL] Cancel requested for ${id}`);

    canceledUploads.add(id);

    const metaPath = path.join(dir, "metadata.json");
    try {
        const meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
        meta.canceled = true;
        meta.completed = false;
        await fs.promises.writeFile(metaPath, JSON.stringify(meta), "utf-8");
    } catch { }

    setTimeout(async () => {
        try {
            await fs.promises.rm(dir, { recursive: true, force: true });
            console.log(`[UPLOAD CANCEL] Deleted upload dir ${id}`);
        } catch (err) {
            console.error(`[UPLOAD CANCEL] Failed to delete ${id}:`, err);
        } finally {
            canceledUploads.delete(id);
        }
    }, 250);

    res.status(204).end();
});

app.patch("/uploads/:id/update", express.json(), async (req, res) => {
    const { id } = req.params;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: "Invalid id" });
    }

    const dir = path.join(__dirname, "uploads", id);
    const metaPath = path.join(dir, "metadata.json");

    if (!fs.existsSync(dir) || !fs.existsSync(metaPath)) {
        return res.status(404).json({ error: "Not found" });
    }

    function parseExpiryTime(v) {
        if (v == null || v === "") return { expiresAt: null, expiryKey: null };

        const allowed = {
            "15m": 15 * 60 * 1000,
            "1h": 60 * 60 * 1000,
            "24h": 24 * 60 * 60 * 1000,
            "7d": 7 * 24 * 60 * 60 * 1000,
        };

        const key = String(v).trim();
        const ms = allowed[key];
        if (!ms) throw new Error("Invalid expiryTime");

        return { expiresAt: Date.now() + ms, expiryKey: key };
    }

    function parseMaxDownloads(v) {
        if (v == null || v === "") return null;

        const allowed = new Set([1, 10, 25, 100]);

        const n = typeof v === "number" ? v : Number(String(v).trim());

        if (!allowed.has(n)) {
            throw new Error("Invalid maxDownloads");
        }

        return n;
    }

    let meta;
    try {
        meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
    } catch {
        return res.status(500).json({ error: "Failed to read metadata" });
    }

    const now = Date.now();
    const max = Number(meta?.maxDownloads);
    const total = Number(meta?.totalDownloads || 0);
    const isExpired = meta?.expiresAt && Number(meta.expiresAt) <= now;
    const isMaxed = Number.isFinite(max) && max > 0 && total >= max;
    const isCanceled = !!meta?.canceled;

    if (isCanceled || isExpired || isMaxed) {
        return res.status(409).json({ error: "Upload can't be updated (expired/canceled/consumed)" });
    }

    try {
        if ("expiryTime" in req.body) {
            const { expiresAt, expiryKey } = parseExpiryTime(req.body.expiryTime);
            meta.expiresAt = expiresAt;
            meta.expiryKey = expiryKey;
        }
        else if ("expiresAt" in req.body) {
            const v = req.body.expiresAt;
            if (v == null || v === "") meta.expiresAt = null;
            else {
                const n = Number(v);
                if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid expiresAt");
                meta.expiresAt = n;
            }
        }

        if ("maxDownloads" in req.body) {
            meta.maxDownloads = parseMaxDownloads(req.body.maxDownloads);
        }
    } catch (e) {
        return res.status(400).json({ error: String(e.message || e) });
    }

    try {
        await fs.promises.writeFile(metaPath, JSON.stringify(meta), "utf-8");
    } catch (e) {
        console.error(`[UPLOAD UPDATE] ${id} failed:`, e.message || e);
        return res.status(500).json({ error: "Failed to update metadata" });
    }

    return res.json({
        id,
        expiresAt: meta.expiresAt ?? null,
        maxDownloads: meta.maxDownloads ?? null,
        totalDownloads: Number(meta.totalDownloads || 0),
        activeDownloads: Number(meta.activeDownloads || 0),
        canceled: !!meta.canceled,
        updatedAt: meta.updatedAt,
    });
});

app.delete("/uploads/:id/delete", async (req, res) => {
    const { id } = req.params;
    const dir = path.join("./uploads", id);

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: "Invalid id" });
    }

    if (!fs.existsSync(dir)) {
        return res.status(404).json({ error: "Upload not found" });
    }

    try {
        await fs.promises.rm(dir, { recursive: true, force: true });
        console.log(`[UPLOAD DELETE] Deleted upload dir ${id}`);
    } catch (err) {
        console.error(`[UPLOAD DELETE] Failed to delete ${id}:`, err);
    }

    res.send(204).end();
});

app.get("/downloads/:id/meta", async (req, res) => {
    const { id } = req.params;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: "Invalid id" });
    }

    const dir = path.join(__dirname, "uploads", id);
    const metaPath = path.join(dir, "metadata.json");

    if (!fs.existsSync(metaPath)) {
        return res.status(404).json({ error: "Not found" });
    }

    let meta;
    try {
        meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
    } catch {
        return res.status(500).json({ error: "Failed to read metadata" });
    }

    const now = Date.now();

    const max = Number(meta?.maxDownloads);
    const total = Number(meta?.totalDownloads || 0);

    const valid =
        meta &&
        !meta.canceled &&
        (!meta.expiresAt || meta.expiresAt > now) &&
        !(Number.isFinite(max) && max > 0 && total >= max);

    if (!valid) {
        return res.status(404).json({ error: "Not found" });
    }

    return res.json({
        expiresAt: meta.expiresAt || null,
        expiryKey: meta.expiryKey || null,
        maxDownloads: Number.isFinite(max) ? max : null,
        totalDownloads: total,
    });
});

app.get("/downloads/:id/manifest", async (req, res) => {
    const { id } = req.params;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: "Invalid id" });
    }

    const dir = path.join(__dirname, "uploads", id);
    const metaPath = path.join(dir, "metadata.json");
    const manPath = path.join(dir, "manifest.enc");

    if (!fs.existsSync(dir)) return res.status(404).json({ error: "Not found" });

    let meta = null;
    try {
        meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
    } catch {
        return res.status(404).json({ error: "Not found" });
    }

    const max = Number(meta?.maxDownloads);
    const total = Number(meta?.totalDownloads || 0);
    if (Number.isFinite(max) && max > 0 && total >= max) {
        return res.status(404).json({ error: "Not found" });
    }

    const now = Date.now();
    const valid = meta && !meta.canceled && (!meta.expiresAt || meta.expiresAt > now);
    if (!valid) return res.status(404).json({ error: "Not found" });

    if (!fs.existsSync(manPath)) {
        return res.status(409).json({ error: "Manifest not written yet" });
    }

    const stat = await fs.promises.stat(manPath);
    if (stat.size <= 0) return res.status(409).json({ error: "Manifest not written yet" });

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(stat.size));

    const rs = fs.createReadStream(manPath);
    rs.on("error", (err) => {
        console.error(`[DOWNLOAD MANIFEST] stream error for ${id}:`, err);
        if (!res.headersSent) res.status(500).end();
        else res.destroy();
    });
    rs.pipe(res);
});

app.get("/downloads/:id/data", async (req, res) => {
    const { id } = req.params;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: "Invalid id" });
    }

    const start = Number(req.query.start);
    const end = Number(req.query.end);

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        return res.status(400).json({ error: "Use ?start=<int>&end=<int> (inclusive), with 0 <= start <= end" });
    }

    const dir = path.join(__dirname, "uploads", id);
    const metaPath = path.join(dir, "metadata.json");
    const dataPath = path.join(dir, "data.enc");
    const indexPath = path.join(dir, "indexes.bin");

    if (!fs.existsSync(dir) || !fs.existsSync(metaPath) || !fs.existsSync(dataPath) || !fs.existsSync(indexPath)) {
        return res.status(404).json({ error: "Not found" });
    }

    let meta;
    try {
        meta = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
    } catch {
        return res.status(404).json({ error: "Not found" });
    }

    const now = Date.now();
    const max = Number(meta?.maxDownloads);
    const total = Number(meta?.totalDownloads || 0);
    const valid =
        meta &&
        !meta.canceled &&
        (!meta.expiresAt || meta.expiresAt > now) &&
        !(Number.isFinite(max) && max > 0 && total >= max);

    if (!valid) return res.status(404).json({ error: "Not found" });

    let activeIncremented = false;
    try {
        meta.activeDownloads = Number(meta.activeDownloads || 0) + 1;
        await fs.promises.writeFile(metaPath, JSON.stringify(meta), "utf-8");
        activeIncremented = true;
    } catch (e) {
        console.error(`[DOWNLOAD DATA] ${id} failed to bump activeDownloads:`, e.message || e);
    }

    req.setTimeout(0);
    res.setTimeout(0);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Chunk-Start", String(start));
    res.setHeader("X-Chunk-End", String(end));
    res.flushHeaders?.();

    const header = Buffer.alloc(8);
    const fd = await fs.promises.open(dataPath, "r");

    let aborted = false;
    req.on("aborted", () => { aborted = true; });
    res.on("close", () => { aborted = true; });

    const map = new Map();
    let indexReadOffset = 0;
    const sig = signalFor(id);

    async function takeRecords() {
        let st;
        try {
            st = await fs.promises.stat(indexPath);
        } catch {
            return;
        }
        const size = st.size;
        if (size <= indexReadOffset) return;

        const toRead = size - indexReadOffset;
        const buf = Buffer.allocUnsafe(toRead);
        const fh = await fs.promises.open(indexPath, "r");
        try {
            const { bytesRead } = await fh.read(buf, 0, toRead, indexReadOffset);
            indexReadOffset += bytesRead;

            const full = bytesRead - (bytesRead % 16);
            for (let p = 0; p < full; p += 16) {
                const ci = buf.readUInt32BE(p);
                const off = Number(buf.readBigUInt64BE(p + 4));
                const len = buf.readUInt32BE(p + 12);
                if (len <= 0) continue;

                if (!map.has(ci)) map.set(ci, { off, len });
            }

            const rem = bytesRead % 16;
            if (rem !== 0) indexReadOffset -= rem;
        } finally {
            await fh.close().catch(() => { });
        }
    }

    async function waitForChunk(ci, { timeoutMs = 60_000 } = {}) {
        const deadline = Date.now() + timeoutMs;

        while (!aborted) {
            if (Date.now() > deadline) {
                throw new Error(`Timed out waiting for chunk ${ci}`);
            }

            await takeRecords();
            if (map.has(ci)) return;

            try {
                const m = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
                const now = Date.now();
                const max = Number(m?.maxDownloads);
                const total = Number(m?.totalDownloads || 0);
                const ok =
                    m &&
                    !m.canceled &&
                    (!m.expiresAt || m.expiresAt > now) &&
                    !(Number.isFinite(max) && max > 0 && total >= max);
                if (!ok) throw new Error("Upload no longer available");
            } catch (e) {
                throw new Error("Upload no longer available");
            }

            await Promise.race([
                new Promise((resolve) => sig.once("index", resolve)),
                new Promise((resolve) => setTimeout(resolve, 250)),
            ]);
        }

        throw new Error("Client disconnected");
    }

    try {
        await takeRecords();

        for (let ci = start; ci <= end; ci++) {
            if (aborted) break;

            if (!map.has(ci)) {
                await waitForChunk(ci, { timeoutMs: 5 * 60_000 });
                if (aborted) break;
            }

            const { off, len } = map.get(ci);

            header.writeUInt32BE(ci, 0);
            header.writeUInt32BE(len, 4);
            if (!res.write(header)) await once(res, "drain");

            await new Promise((resolve, reject) => {
                const rs = fs.createReadStream(null, {
                    fd: fd.fd,
                    autoClose: false,
                    start: off,
                    end: off + len - 1,
                    highWaterMark: 256 * 1024,
                });
                rs.on("error", reject);
                rs.on("end", resolve);
                rs.pipe(res, { end: false });
            });
        }

        if (!aborted) res.end();
    } catch (err) {
        console.error(`[DOWNLOAD DATA] ${id} failed:`, err.message || err);
        if (!res.headersSent) res.status(500).json({ error: String(err.message || err) });
        else res.destroy();
    } finally {
        try { await fd.close(); } catch { }

        try {
            if (activeIncremented) {
                const m2 = JSON.parse(await fs.promises.readFile(metaPath, "utf-8"));
                m2.activeDownloads = Math.max(0, Number(m2.activeDownloads || 0) - 1);
                await fs.promises.writeFile(metaPath, JSON.stringify(m2), "utf-8");
            }
        } catch (e) {
            console.error(`[DOWNLOAD DATA] ${id} failed to decrement activeDownloads:`, e.message || e);
        }
    }
});

app.post("/downloads/:id/finish", async (req, res) => {
    const { id } = req.params;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        return res.status(400).json({ error: "Invalid id" });
    }

    const dir = path.join(__dirname, "uploads", id);
    const metaPath = path.join(dir, "metadata.json");
    if (!fs.existsSync(metaPath)) return res.status(404).json({ error: "Not found" });

    try {
        const raw = await fs.promises.readFile(metaPath, "utf-8");
        const meta = JSON.parse(raw);

        const now = Date.now();
        const max = Number(meta?.maxDownloads);
        const total = Number(meta?.totalDownloads || 0);
        const valid =
            meta &&
            !meta.canceled &&
            (!meta.expiresAt || meta.expiresAt > now) &&
            !(Number.isFinite(max) && max > 0 && total >= max);

        if (!valid) return res.status(404).json({ error: "Not found" });

        meta.totalDownloads = Number(meta.totalDownloads || 0) + 1;
        meta.lastDownloadAt = Date.now();

        await fs.promises.writeFile(metaPath, JSON.stringify(meta), "utf-8");

        console.log(`[DOWNLOAD FINISH] Download completed for ${id}`);
        return res.status(204).end();
    } catch (err) {
        console.error(`[DOWNLOAD FINISH] ${id} error:`, err.message || err);
        return res.status(500).json({ error: "Failed to update metadata" });
    }
});

app.use((_, res) => {
    res.status(404).sendFile(path.join(__dirname, "frontend", "404.html"));
});

app.listen(port, () => {
    try {
        fs.mkdirSync("./uploads");
    } catch { }

    console.log(`App listening at http://localhost:${port}`);
});

setInterval(async () => {
    try {
        const uploadsPath = path.resolve("./uploads");
        const dirs = await fs.promises.readdir(uploadsPath);
        const uploads = [];

        for (const dir of dirs) {
            const metaPath = path.join(uploadsPath, dir, "metadata.json");
            try {
                const metaRaw = await fs.promises.readFile(metaPath, "utf-8");
                const meta = JSON.parse(metaRaw);
                uploads.push({
                    id: dir,
                    path: path.join(uploadsPath, dir),
                    createdAt: meta.createdAt,
                    expiresAt: meta.expiresAt,
                    maxDownloads: meta.maxDownloads,
                    totalDownloads: meta.totalDownloads,
                    activeDownloads: meta.activeDownloads,
                    downloadLeaseUntil: meta.downloadLeaseUntil,
                });
            } catch { }
        }

        const now = Date.now();
        for (const u of uploads) {
            const max = Number(u.maxDownloads);
            const total = Number(u.totalDownloads || 0);
            const active = Number(u.activeDownloads || 0);

            const leaseUntil = Number(u.downloadLeaseUntil || 0);
            const leased = leaseUntil > now;

            const hitMax = Number.isFinite(max) && max > 0 && total >= max;
            const expired = u.expiresAt != null && u.expiresAt <= now;

            if ((expired || hitMax) && active <= 0 && !leased) {
                console.log(`[CLEANUP] Deleting upload ${u.id} (${expired ? "expired" : "max downloads"})`);
                await fs.promises.rm(u.path, { recursive: true, force: true });
            }
        }

        const disk = await checkDiskSpace(uploadsPath);
        const used = disk.size - disk.free;
        const percent = (used / disk.size) * 100;

        if (percent >= 90) {
            console.log(`[CLEANUP] Disk usage at ${percent.toFixed(2)}%, deleting oldest uploads...`);

            const remainingDirs = await fs.promises.readdir(uploadsPath);
            const remainingUploads = [];

            for (const dir of remainingDirs) {
                const metaPath = path.join(uploadsPath, dir, "metadata.json");
                try {
                    const metaRaw = await fs.promises.readFile(metaPath, "utf-8");
                    const meta = JSON.parse(metaRaw);
                    remainingUploads.push({
                        id: dir,
                        path: path.join(uploadsPath, dir),
                        createdAt: meta.createdAt,
                    });
                } catch { }
            }

            remainingUploads.sort((a, b) => a.createdAt - b.createdAt);

            for (const u of remainingUploads) {
                console.log(`[CLEANUP] Deleting upload ${u.id} to free space`);
                await fs.promises.rm(u.path, { recursive: true, force: true });

                const newDisk = await checkDiskSpace(uploadsPath);
                const newUsed = newDisk.size - newDisk.free;
                const newPercent = (newUsed / newDisk.size) * 100;
                if (newPercent < 90) break;
            }
        }
    } catch (err) {
        console.error("[CLEANUP] Error:", err);
    }
}, 30_000);