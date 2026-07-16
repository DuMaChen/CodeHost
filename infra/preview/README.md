# Fixture Preview Image

Build and push this image to create a digest-pinned `PLATFORM_PREVIEW_IMAGE`
for the course fallback path. It exposes `/health` and serves a small static
preview. Dynamic BuildKit output can replace it only after the rootless BuildKit
gate is verified.
