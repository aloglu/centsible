#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
docker compose config --quiet
current_image="$(docker compose images -q centsible)"
rollback_tag="centsible:rollback-$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -n "$current_image" ]]; then
    docker image tag "$current_image" "$rollback_tag"
    # Fail before updating if the running app cannot create a recovery snapshot.
    docker compose exec -T centsible node server/scripts/snapshot.js
    echo "Previous image saved as $rollback_tag"
fi
# Build before replacing the running container. A failed build leaves it running.
docker compose build --pull
if ! docker compose up -d --wait --wait-timeout 180; then
    echo 'The new container did not become healthy. Check: docker compose logs --tail=100 centsible' >&2
    if [[ -n "$current_image" ]]; then
        echo "Previous image: $rollback_tag. See README.md for snapshot restore and rollback." >&2
    fi
    exit 1
fi
echo 'Centsible is running. Check System Activity for scraping, delivery, and backup health.'
