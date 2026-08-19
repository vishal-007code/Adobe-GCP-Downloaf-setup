FROM mcr.microsoft.com/playwright:v1.61.0-noble

# Install Google Cloud CLI for GCS access
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    apt-transport-https \
    ca-certificates \
  && curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | \
     gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
     > /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update && apt-get install -y google-cloud-cli \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the LOCKFILE too, and use `npm ci` rather than `npm install`.
#
# Previously only package.json was copied and `npm install` was used, so the lock
# was ignored and the caret range "@playwright/test": "^1.60.0" floated to whatever
# npm had published that day. It resolved to 1.62.1 against a base image carrying
# 1.61.0 browsers, and every task died at launch with:
#
#   browserType.launch: Executable doesn't exist at /ms-playwright/chromium_...
#   Looks like Playwright was just updated to 1.62.1. Please update docker image as well.
#
# `npm ci` installs exactly what the lockfile pins and fails loudly if the lock and
# manifest disagree, so the image can never silently drift again.
COPY package.json package-lock.json ./
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci

# The base image ships browsers built for ITS OWN Playwright version, which need not
# match the version just locked. Install the chromium build belonging to the installed
# version so the two can never disagree — this is what makes the mismatch impossible
# rather than merely unlikely. playwright.cloud.config.ts uses the bundled chromium
# (no `channel`), so chromium alone is enough.
RUN npx playwright install chromium

COPY . .

ENTRYPOINT ["bash", "scripts/run-cloud-batch.sh"]
