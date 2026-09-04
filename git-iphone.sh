#!/bin/bash
set -e

echo "==> Building Frontend..."
cd frontend
npm run build

echo "==> Syncing with Capacitor iOS..."
npx cap sync ios

echo "==> Committing changes..."
cd ..
git add frontend/
git commit -m "Auto: build & sync frontend app" || echo "No new changes to commit"

echo "==> All done! Ready for Codex to push and Xcode to run."
