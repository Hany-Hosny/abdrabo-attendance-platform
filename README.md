# Abdrabo Attendance Platform

Self-hosted attendance platform for Mr. Ahmed Abdrabo, Integrated Science teacher. V1 focuses on the student login flow, attendance check-in through the backend API, and the student dashboard.

## Run With Docker

1. Copy the environment file:

```bash
cp .env.example .env
```

2. Start the stack:

```bash
docker compose up --build
```

3. Open the website:

```text
http://localhost:3000
```

The API health endpoint is:

```text
http://localhost:4000/api/health
```

## Demo Data

- Student code: `STU1001`
- Student: Ahmed Mohamed
- Group: Saturday 6 PM Group
- Demo exam result: Unit One Exam `42/50`

On first startup, the backend creates the database tables and seed data. It also creates an open attendance session around the startup time for local testing.

## Local Development Without Docker

You need Node.js and a local PostgreSQL database.

```bash
npm install
cp .env.example .env
npm run migrate --workspace backend
npm run dev
```

For non-Docker local development, provide `DATABASE_URL` through `backend/.env` or the shell environment.

## Project Structure

- `frontend`: React + Vite bilingual UI.
- `backend`: Node.js + Express + PostgreSQL.
- `backend/src/db/migrate.js`: migrations and seed data.
- `docker-compose.yml`: PostgreSQL + backend + frontend.

## V1 Notes

- Attendance is never recorded directly from the frontend; all check-ins go through `/api/student/login`.
- Backend validation checks the student code, active state, session time window, GPS location, and duplicate attendance records.
- `device_id` is stored in `localStorage` and sent with attendance requests.
- IP address is only used as supporting suspicious/rate-limiting context, not as the primary protection mechanism.
- UI text is bilingual through a local translations object. Arabic uses RTL and English uses LTR.
