# Office Snacks Tracker

A snack-consumption tracker for a small office. It records employee, snack, quantity and timestamp only; it has no billing, pricing, or payment features.

## Architecture

- `frontend/`: React single-page application, responsive admin shell and pages for dashboard, taking snacks, employees, snacks, history and reports.
- `backend/`: Java 17 / Spring Boot REST API, layered controller-service-repository architecture, JPA entities and PostgreSQL persistence.
- `database/schema.sql`: PostgreSQL tables, indexes, and constraints for Supabase or another PostgreSQL database.
- `docs/API.md`, `postman/`: API guide and importable Postman collection.

All report and dashboard values are queried from stored records. The API stores timestamps in UTC; the UI renders them in `Asia/Kolkata`.

## Local setup

1. Install Java 17+, Node.js 20+, npm and Python 3. A project-local Apache Maven launcher is available as `mvnw.cmd` in the project root and does not require a global Maven install.
2. Create a Supabase project. In its SQL Editor, run `database/schema.sql` to create the tables.
3. Copy the host, port, database, username, and password from Supabase's **Connect** dialog into the environment variables shown in `backend/.env.example`. Use Direct or Session pooler connection details, with `sslmode=require`. For a long-running Spring service, avoid Transaction pooler mode.
4. Configure those variables and `APP_ADMIN_PASSWORD` / `APP_EMPLOYEE_PASSWORD` in the shell that starts Spring Boot. Spring does not automatically load `.env.example`; never commit actual credentials.
5. Start API from the project root with `.\mvnw.cmd spring-boot:run` (default API port 8080). The first run downloads Maven dependencies into the ignored `.tools/m2` folder.
6. Start UI: `cd frontend; npm install; npm run dev` (default port 5173).

### Copy existing MySQL data

The migration tool copies `employees`, `snacks`, and `snack_records`, preserving IDs and timestamps. It refuses to write if any target table already contains rows, and leaves the MySQL database unchanged.

1. Create a Supabase project and run `database/schema.sql` in its SQL Editor. Leave the tables empty; do not seed them first.
2. Install the migration tool's dependencies: `python -m pip install -r database/migration/requirements.txt`.
3. Use `database/migration/.env.example` as a variable checklist. In PowerShell, set `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`, and `SUPABASE_DATABASE_URL` from your actual connection details. Keep these secrets local and pause snack edits while the migration snapshot is taken.
4. From the project root run `python database/migrate_mysql_to_supabase.py`. Confirm the printed row counts match MySQL before switching the API's `SPRING_DATASOURCE_*` variables.
5. Keep your MySQL backup until the Supabase app has been verified.

For local development, Vite proxies `/api` to `http://localhost:8080`. Configure a reverse proxy for production so the UI and API share an origin.

## Authentication

The API uses Spring Security HTTP Basic with BCrypt hashed credentials, intended behind HTTPS. Supply `APP_ADMIN_USERNAME`, `APP_ADMIN_PASSWORD`, `APP_EMPLOYEE_USERNAME`, and `APP_EMPLOYEE_PASSWORD` at runtime. Admin role can manage employees/snacks and view reports; employee role can create records and view permitted history. The employee account maps to `APP_EMPLOYEE_ID`. Change all sample credentials before use. This simple shared-account model is suitable for a small internal deployment; individual employee sign-in requires adding per-employee identity management.

## Build and deploy

- Frontend: `cd frontend; npm install; npm run build`; serve `dist/` from Nginx or another static server.
- Backend: `cd backend; mvn clean package`; deploy `target/office-snacks-tracker-1.0.0.jar` with Java 17+ and environment variables.
- Use Supabase PostgreSQL with TLS and a reverse proxy. Set `SPRING_PROFILES_ACTIVE=prod`; production profile requires environment-based DB credentials and disables schema mutation.
- Use Supabase's database backup/PITR options or `pg_dump` for independent backups; encrypt and store them securely, and periodically test restores.

See [API documentation](docs/API.md) and [deployment notes](docs/DEPLOYMENT.md).

## Tests

Backend unit tests are in `backend/src/test`. Run `cd backend; mvn test`. Frontend checks can be added with Vitest; current UI is verified through build and manual responsive review once Node is installed.
