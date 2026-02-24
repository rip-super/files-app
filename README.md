<img width="375" height="375" alt="Screenshot 2026-02-21 004511" src="https://github.com/user-attachments/assets/a2e34d20-dcb4-423e-b339-9e9f314111e8" />
<img width="375" height="375" alt="Screenshot 2026-02-21 004541" src="https://github.com/user-attachments/assets/ba402dcb-9249-43d3-9d52-9c289f45934e" />
<img width="375" height="375" alt="Screenshot 2026-02-21 004557" src="https://github.com/user-attachments/assets/20ed71f0-6904-4a28-9fdb-10756ce4c09e" />
<img width="375" height="375" alt="Screenshot 2026-02-21 004609" src="https://github.com/user-attachments/assets/f4e81985-5382-43b3-8cf4-9a45b07a0346" />

# Files App

A simple, end-to-end encrypted file sharing service.

Files are encrypted in the browser before they ever leave your device. The server only stores encrypted blobs and cannot read the contents. Uploads are streamed in chunks for fast transfers and low memory usage, and downloads support random access without decrypting everything first.

Try it live! - https://files.sahildash.dev

## Features

- End-to-end encryption (ChaCha20-Poly1305 in the browser)
- Per-chunk encryption (no global stream dependency)
- Streaming uploads (ReadableStream + single request body)
- Large file support (chunked at 1MB)
- Blind server storage (single `data.enc` file + binary index)
- Expiring uploads and max download limits
- Automatic cleanup (expired uploads, disk pressure handling)
- No server-side access to encryption keys

## How It Works

### Upload

1. Client generates a random 32-byte key in the browser.
2. A manifest is created (file names, sizes, chunk layout), compressed, and encrypted.
3. Each file is split into 1MB chunks.
4. Each chunk is:
   - Compressed
   - Encrypted with a random nonce
   - Streamed to the server
5. The server:
   - Blindly appends encrypted bytes to `data.enc`
   - Writes a small binary index entry (`chunkIndex`, `offset`, `length`)

The server never sees plaintext.

### Download

1. The encrypted manifest is fetched.
2. It is decrypted locally using the key in the URL hash.
3. Required chunks are requested from the server.
4. Chunks are decrypted and decompressed in the browser.
5. Files are reconstructed client-side.

The encryption key is never sent to the server. It lives only in the URL fragment (`#key`), which is not sent through HTTP requests.

## Installation

1. Install NodeJS
2. Clone the repository

```
git clone https://github.com/rip-super/files-app.git
cd files-app
```

3. Install dependencies

```
npm install
```

4. Start the server

```
node server.js
```

The app will run at: `http://localhost:8080`

## Project Structure

```
/frontend        -> Static frontend (upload + download UI)
/uploads         -> Stored uploads (encrypted only)
server.js        -> Express server
```

Each upload directory contains:

```
data.enc         -> All encrypted chunks appended sequentially
indexes.bin      -> Binary index (chunk index + offset + length)
manifest.enc     -> Encrypted manifest
metadata.json    -> Upload metadata (expiry, limits, etc.)
```

## Notes

- Default expiration is 24 hours.
- Default max downloads is 1.
- Rate limiting is enabled on upload routes.
- Old or expired uploads are automatically cleaned up.
- Disk usage is monitored and oldest uploads are deleted if usage exceeds 90%.

---

### If you like this project, feel free to give it a star!
