# Decision Models private launch gallery

This is a small, dependency-free Node 22 app for the unreleased launch-video review. Keep the gallery behind its secret URL prefix, share that URL only with reviewers, and do not publish or repost its videos.

## Build the encrypted bundle

Place finished MP4s in the job's finals/ directory and matching preview posters in posters/. The gallery notes and variant-to-file map live in gallery.json. Plain MP4s and poster JPEGs are git-ignored; only their encrypted blobs are included in the repository.

Run:

    node pack.js

pack.js reads GALLERY_KEY when provided. Otherwise it reads ~/.config/dm-gallery/bundle.key, creating a random 32-byte key there with owner-only permissions if needed. The key is never included in this repository. Back it up through the existing secret-handling process; losing it makes the encrypted bundle unreadable.

The packer encrypts each MP4, poster, and gallery.json with AES-256-GCM. Each .bin file stores 12-byte IV | 16-byte authentication tag | ciphertext. MP4s are not compressed. The encrypted manifest maps logical names to encrypted blob names, plaintext sizes and types, and SHA-256 hashes. Unchanged plaintext assets retain their existing encrypted blob. Missing formats are skipped because only files present in finals/ and posters/ are packed.

The Inter Tight, Inter, IBM Plex Mono font files, Decision Models logo, app code, and Dockerfile are public static assets. No video is stored in plaintext in the repository.

## Run locally

The app requires a key and a secret prefix:

    GALLERY_PATH=/g/replace-with-a-long-random-path/ node server.js

When the key is in the default config file, the server reads it without printing it. Or pass GALLERY_KEY through the process environment. Use a long random path in deployment, for example one generated from 12 random bytes encoded as hex. PORT defaults to 8080.

On startup, the server authenticates the encrypted manifest and every blob, verifies each plaintext size and hash, then unpacks into /tmp/gallery/. It serves the static page and assets only below GALLERY_PATH; /healthz is the only unprefixed route. It supports byte ranges for MP4 playback, including iOS Safari and Telegram's in-app browser. Unknown paths return 404 without a directory listing.

## Re-pack after new finals

    node pack.js
    git add enc
    git commit -m "Refresh encrypted gallery bundle"
    git push

The key must be available to the deployment as GALLERY_KEY or at ~/.config/dm-gallery/bundle.key. Never add the key, plaintext MP4s, or .env files to git. The gallery is a private preview; do not publish it or its videos.
