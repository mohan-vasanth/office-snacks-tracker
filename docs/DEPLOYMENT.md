# Deployment and database operations

1. Provision Supabase PostgreSQL and run `database/schema.sql` in its SQL Editor.
2. For an existing MySQL installation, use `database/migrate_mysql_to_supabase.py` after creating empty target tables. Verify imported table counts before switching traffic.
3. Build the backend with Maven and frontend with Node/npm as described in README.
4. Set Supabase JDBC URL, database user/password, both account credentials, `APP_EMPLOYEE_ID`, `PORT`, and `SPRING_PROFILES_ACTIVE=prod` as host secrets/environment variables. Use the Direct connection or Session pooler and TLS. Do not put database credentials or service keys in the frontend.
5. Serve frontend static files behind HTTPS. Reverse proxy `/api` to the Spring Boot service. Restrict backend access and keep database credentials server-side.
6. Rotate credentials at deployment. Employee credential maps to one configured profile ID; use separate identity integration before enabling individualized employee login.

## Backup

Use Supabase backups/PITR or scheduled `pg_dump` backups. Encrypt backup files, apply retention, and test restores into a separate database. Do not store backups in the public web directory. Preserve `employees`, `snacks`, and `snack_records` together so foreign keys remain intact.

## Progressive Web App (PWA)

- The frontend ships a manifest, icons and a service worker (`frontend/public/`). `npm run build` stamps `dist/sw.js` with a content-derived version and precache list; no extra deploy step is needed.
- **HTTPS is required** (localhost is exempt) for installation and the service worker.
- Serve `sw.js` and `index.html` with `Cache-Control: no-cache` so updates are detected promptly; hashed files under `assets/` can be cached long-term.
- The worker only caches same-origin static files. Supabase requests are never intercepted or cached. Data changes are online-only; the app shows an offline banner and does not queue writes.
- Regenerate icons with `npm run icons`; run `npm run build && npm run test:pwa` to verify.
