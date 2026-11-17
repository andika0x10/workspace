# Workspace

just a private TODO List app

## Deployment

Untuk linked Git repository di Cloudflare Workers Builds:

- Gunakan deploy command `npm run deploy` (sudah menjalankan build; build command terpisah boleh dikosongkan).
- Simpan `APP_USERNAME`, `APP_PASSWORD`, dan `AUTH_SECRET` di Worker **Settings > Variables and Secrets** sebagai secrets. `AUTH_SECRET` harus minimal 32 karakter. Deploy berikutnya memakai secrets yang sudah ada.
- Alternatifnya, sediakan ketiga secrets di environment build. Skrip akan mengunggahnya bersama versi Worker. Environment build mengalahkan nilai dari `.dev.vars` lokal.

`.dev.vars` hanya fallback untuk deploy lokal dan tetap tidak boleh masuk Git. File ini tidak wajib tersedia di CI. Autentikasi mengikuti API token dari environment (`CLOUDFLARE_API_TOKEN`) atau login lokal `cf`; akun mengikuti `CLOUDFLARE_ACCOUNT_ID` atau `accountId` di `cloudflare.config.ts`, tanpa email maupun profil login yang dikunci di skrip.

Validasi deployment tanpa mengunggah: `npm run deploy:configured -- --dry-run`. Jalankan regresi skrip deploy: `npm run test:deploy`.

Referensi: [Cloudflare CLI di CI](https://developers.cloudflare.com/cf/ci/) dan [konfigurasi Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
